import { EventEmitter } from 'node:events';
import { diffFields } from '../../../shared/src/types.js';
import type {
  MeasurePatch,
  RacePatch,
  BallotMeasure,
  BopHistoryPoint,
  Candidate,
  ChamberSummary,
  MarketData,
  NewsItem,
  Office,
  Party,
  PartyCounts,
  PollClosing,
  Race,
  SimStatus,
  Snapshot,
  StreamEvent,
} from '../../../shared/src/types.js';
import { OFFICE_LABEL, STATE_BY_POSTAL } from '../../../shared/src/states.js';
import { config, staleAfterFor } from '../config.js';
import { archivePhase, shrankTooMuch } from '../lib/guard.js';
import { allPollerStatus } from '../lib/poller.js';
import { logger } from '../lib/log.js';
import {
  GOV_BEFORE,
  GOV_NOT_UP_STATES,
  GOV_PRIOR,
  HOUSE_BEFORE,
  SENATE_BEFORE,
  SENATE_NOT_UP,
  SENATE_PRIOR,
  countParties,
} from '../seed/seats.js';
import type { Enrichment, ProviderBatch, RaceInput } from './types.js';

const log = logger('store');
/** States whose counts routinely take days (mail ballots / late-arriving ballots). */
const SLOW_COUNT = new Set(['CA', 'WA', 'OR', 'NV', 'AZ', 'AK', 'UT']);
const OFFICES: Office[] = ['S', 'G', 'H'];
const MAX_NEWS = 500;
const PARTY_NAME: Record<Party, string> = { D: 'Democrat', R: 'Republican', I: 'Independent' };

type ProviderId = ProviderBatch['provider'];

/**
 * The single source of truth. Providers push normalized batches in; the store merges them,
 * derives per-race state + chamber summaries, generates alert events, and emits StreamEvents
 * which the SSE hub fans out to every connected browser window.
 */
/** First occurrence of each id wins (repairs state saved before batch de-duplication). */
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((x) => !seen.has(x.id) && (seen.add(x.id), true));
}

export class ElectionStore extends EventEmitter {
  version = 0;
  /** provider -> office -> { fetchedAt, races } */
  private batches = new Map<ProviderId, Map<Office, { fetchedAt: number; races: Map<string, RaceInput> }>>();
  private enrichment = new Map<string, Enrichment>();
  private markets = new Map<string, MarketData>();
  private chamberMarkets: Partial<Record<Office, MarketData>> = {};
  private pollClosingMap = new Map<string, string>();
  private houseBefore: PartyCounts = { ...HOUSE_BEFORE };

  races = new Map<string, Race>();
  /** Mirror of the MeasureStore output (kept here so snapshots need no circular import). */
  measures = new Map<string, BallotMeasure>();
  chambers = {} as Record<Office, ChamberSummary>;
  news: NewsItem[] = [];
  bopHistory: BopHistoryPoint[] = [];
  private simHistory: BopHistoryPoint[] = [];

  /** Alert de-duplication (persisted so restarts don't re-announce). */
  announcedCalls = new Set<string>();
  announcedClosings = new Set<string>();
  private simAnnouncedCalls = new Set<string>();
  private simAnnouncedClosings = new Set<string>();
  private lastLeader = new Map<string, { party: Party; at: number }>();

  mode: Snapshot['mode'] = 'live';
  sim: SimStatus = { enabled: false, allowed: config.sim.allowed, running: false, speed: config.sim.speed, simTime: null };
  /** Clock used for poll-closing status; swapped for the simulator's clock in sim mode. */
  clock: () => number = () => Date.now();

  private recomputeTimer: NodeJS.Timeout | null = null;
  /** Results locked: every race certified, or past RESULTS_LOCK_AT. Results feeds stop. */
  private frozen = false;
  private frozenNote = '';
  private lastBopPointAt = 0;

  // ---------------------------------------------------------------- inputs

  ingest(batch: ProviderBatch) {
    let byOffice = this.batches.get(batch.provider);
    if (!byOffice) this.batches.set(batch.provider, (byOffice = new Map()));
    for (const office of batch.offices) {
      const next = new Map(batch.races.filter((r) => r.office === office).map((r) => [r.id, r]));
      const prev = byOffice.get(office);
      if (prev && batch.provider !== 'sim') {
        // A file that suddenly lists under half the races is broken or stripped: keep what we have.
        if (shrankTooMuch(prev.races.size, next.size)) {
          log.warn(`${batch.provider} ${office}: file now lists ${next.size} races (was ${prev.races.size}); keeping the saved results`);
          continue;
        }
        // After election night, a race that drops out of the file, or whose count vanishes, keeps
        // its last result.
        if (archivePhase())
          for (const [id, old] of prev.races) {
            const cur = next.get(id);
            if (!cur || (old.totalVotes > 0 && !cur.totalVotes)) next.set(id, old);
          }
      }
      byOffice.set(office, { fetchedAt: batch.fetchedAt, races: next });
    }
    for (const r of batch.races) {
      if (r.pollClose && !this.pollClosingMap.has(r.state)) this.pollClosingMap.set(r.state, r.pollClose);
    }
    this.scheduleRecompute();
  }

  /** Mark a provider's office data as refreshed without changes (304 Not Modified). */
  touch(provider: ProviderId, offices: Office[], fetchedAt = Date.now()) {
    const byOffice = this.batches.get(provider);
    if (!byOffice) return;
    for (const o of offices) {
      const b = byOffice.get(o);
      if (b) b.fetchedAt = fetchedAt;
    }
  }

  clearProvider(provider: ProviderId) {
    this.batches.delete(provider);
    this.scheduleRecompute();
  }

  setPollClosings(list: PollClosing[]) {
    // A closing time before election-day noon ET is a date slip (NYT lists Alaska's 05:00Z close
    // on Nov 3 instead of Nov 4): polls close on election evening, so move it a day later.
    const earliest = Date.parse(`${config.electionDate}T16:00:00Z`);
    for (const p of list) {
      const t = Date.parse(p.time);
      this.pollClosingMap.set(p.state, Number.isFinite(t) && t < earliest ? new Date(t + 86_400_000).toISOString() : p.time);
    }
    this.scheduleRecompute();
  }

  pollClosingFor(state: string): string | null {
    return this.pollClosingMap.get(state) ?? null;
  }

  publishMeasures(list: BallotMeasure[], full: boolean) {
    if (full) {
      this.measures = new Map(list.map((m) => [m.id, m]));
      this.broadcast({ type: 'snapshot', data: this.snapshot() });
      return;
    }
    const patches: MeasurePatch[] = [];
    for (const m of list) {
      const p = diffFields(this.measures.get(m.id), m);
      if (p) patches.push(p);
      this.measures.set(m.id, m);
    }
    if (patches.length) this.broadcast({ type: 'measures', version: ++this.version, data: patches });
  }

  /**
   * Share the live store's slow-moving context (forecasts, markets, poll closings, House
   * baseline) with a simulation store. Same object references, so it is cheap to call per tick.
   */
  adoptContext(from: ElectionStore) {
    this.enrichment = from.enrichment;
    this.markets = from.markets;
    this.chamberMarkets = from.chamberMarkets;
    this.pollClosingMap = from.pollClosingMap;
    this.houseBefore = from.houseBefore;
  }

  setHouseBefore(c: PartyCounts) {
    const sum = c.D + c.R + c.I;
    if (sum > 400 && sum <= 435) this.houseBefore = c;
  }

  setEnrichment(map: Map<string, Enrichment>) {
    this.enrichment = map;
    this.scheduleRecompute();
  }

  setMarkets(map: Map<string, MarketData>, chambers: Partial<Record<Office, MarketData>>) {
    // Markets drop out of discovery once they close or resolve; keep their last prices (marked
    // closed) so race cards and the Polymarket map don't go blank after the night.
    for (const [id, m] of this.markets) if (!map.has(id)) map.set(id, m.closed ? m : { ...m, closed: true });
    this.markets = map;
    for (const [o, m] of Object.entries(this.chamberMarkets) as [Office, MarketData][]) if (!chambers[o] && m) chambers[o] = m.closed ? m : { ...m, closed: true };
    this.chamberMarkets = chambers;
    this.scheduleRecompute();
  }

  addNews(items: NewsItem[]) {
    const seen = new Set(this.news.map((n) => n.id));
    // De-duplicate within the batch too: the same story often arrives from its publisher's feed
    // and from Google News in one poll, with the same headline-derived id.
    const fresh = items.filter((n) => !seen.has(n.id) && (seen.add(n.id), true));
    if (!fresh.length) return;
    this.news = [...fresh, ...this.news]
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .slice(0, MAX_NEWS);
    this.broadcast({ type: 'news', version: ++this.version, data: fresh });
  }

  // ---------------------------------------------------------------- sim mode

  setSimMode(running: boolean, patch: Partial<SimStatus> = {}) {
    const wasRunning = this.sim.running;
    this.sim = { ...this.sim, ...patch, running, enabled: running || patch.enabled === true };
    this.mode = running ? 'simulation' : 'live';
    if (!running && wasRunning) {
      // Purge every trace of simulated data so live numbers are never contaminated.
      this.batches.delete('sim');
      this.news = this.news.filter((n) => !n.sim);
      this.simHistory = [];
      this.simAnnouncedCalls.clear();
      this.simAnnouncedClosings.clear();
      this.lastLeader.clear();
      this.clock = () => Date.now();
      this.recompute(true);
      return;
    }
    this.broadcastMeta();
  }

  resetSimState() {
    this.batches.delete('sim');
    this.news = this.news.filter((n) => !n.sim);
    this.simHistory = [];
    this.simAnnouncedCalls.clear();
    this.simAnnouncedClosings.clear();
    this.lastLeader.clear();
  }

  // ---------------------------------------------------------------- merge

  private batch(provider: ProviderId, office: Office) {
    return this.batches.get(provider)?.get(office);
  }

  /**
   * Choose the input for each race:
   *  - simulation overrides everything while running,
   *  - else NYT (AP-sourced, richest metadata) while fresh,
   *  - else CNN if it is fresher (NYT down / stale),
   *  - calls are unioned: if either provider projects a winner, we show it.
   */
  private mergeInputs(): Map<string, RaceInput> {
    const out = new Map<string, RaceInput>();
    const now = Date.now();
    for (const office of OFFICES) {
      const nyt = this.batch('nyt', office);
      const cnn = this.batch('cnn', office);
      const sim = this.mode === 'simulation' ? this.batch('sim', office) : undefined;
      const ids = new Set<string>([...(nyt?.races.keys() ?? []), ...(cnn?.races.keys() ?? [])]);
      // Results locked: polling has stopped, so NYT's saved results never go stale (and never lose to CNN's).
      const nytFresh = nyt && (this.frozen || now - nyt.fetchedAt < staleAfterFor(office === 'H' ? config.intervals.nytHouse : config.intervals.nyt, now));
      const useCnnVotes = !!cnn && (!nytFresh || !nyt) && (!nyt || cnn.fetchedAt > nyt.fetchedAt);

      for (const id of ids) {
        const n = nyt?.races.get(id);
        const c = cnn?.races.get(id);
        const s = sim?.races.get(id);
        const base = n ?? c!;
        let merged: RaceInput = { ...base, candidates: base.candidates.map((x) => ({ ...x })) };

        if (s) {
          merged = { ...merged, ...pickResults(s), candidates: s.candidates.map((x) => ({ ...x })) };
        } else if (c && n && useCnnVotes) {
          merged = applyVotes(merged, c);
        }

        if (!s && c && n && !merged.called && c.called) {
          // Secondary call (CNN Decision Desk) while NYT/AP hasn't called yet.
          const cw = c.candidates.find((x) => x.winner);
          if (cw) {
            const target = matchCandidate(merged.candidates, cw);
            if (target) {
              target.winner = true;
              merged.called = true;
              merged.calledBy = 'CNN';
              merged.calledAt = merged.calledAt ?? c.calledAt;
            }
          }
          merged.gainedBy = merged.gainedBy ?? c.gainedBy;
        }
        if (!merged.pollClose && c?.pollClose) merged.pollClose = c.pollClose;
        out.set(id, merged);
      }
    }
    return out;
  }

  /** Live (non-simulated) merged inputs — the simulator's starting point. */
  liveInputs(): RaceInput[] {
    const prevMode = this.mode;
    this.mode = 'live';
    try {
      return [...this.mergeInputs().values()];
    } finally {
      this.mode = prevMode;
    }
  }

  // ---------------------------------------------------------------- derive

  scheduleRecompute() {
    if (this.recomputeTimer) return;
    this.recomputeTimer = setTimeout(() => {
      this.recomputeTimer = null;
      try {
        this.recompute();
      } catch (err) {
        log.error('recompute failed', err);
      }
    }, 200);
  }

  recompute(forceFull = false) {
    const inputs = this.mergeInputs();
    const now = this.clock();
    const changed: RacePatch[] = [];
    const next = new Map<string, Race>();

    for (const [id, inp] of inputs) {
      const race = this.buildRace(inp, now);
      next.set(id, race);
      const prev = this.races.get(id);
      // Send only the fields that changed (full object for new races) to keep the stream small.
      const patch = diffFields(prev, race);
      if (patch) changed.push(patch);
      this.detectEvents(prev, race);
    }
    // Races that disappeared (e.g. sim cleared) are re-sent via a full snapshot.
    const removed = [...this.races.keys()].some((k) => !next.has(k));
    this.races = next;
    this.checkPollClosings(now);

    const chambers = this.buildChambers();
    const chambersChanged = JSON.stringify(chambers) !== JSON.stringify(this.chambers);
    this.chambers = chambers;
    const bopPoint = this.maybeRecordBop();

    if (removed || forceFull) {
      this.broadcast({ type: 'snapshot', data: this.snapshot() });
      return;
    }
    if (changed.length) this.broadcast({ type: 'races', version: ++this.version, data: changed });
    if (chambersChanged) this.broadcast({ type: 'chambers', version: ++this.version, data: chambers });
    if (bopPoint) this.broadcastMeta(bopPoint);
  }

  private buildRace(inp: RaceInput, now: number): Race {
    const enr = this.enrichment.get(inp.id) ?? {};
    const candidates = [...inp.candidates].sort((a, b) => b.votes - a.votes || 0);
    const total = inp.totalVotes || candidates.reduce((s, c) => s + c.votes, 0);
    for (const c of candidates) c.pct = total > 0 ? +((c.votes / total) * 100).toFixed(2) : 0;

    const winnerC = candidates.find((c) => c.winner) ?? null;
    const leaderC = total > 0 ? candidates[0] : null;
    const second = total > 0 ? candidates[1] : null;
    const pollClose = inp.pollClose ?? this.pollClosingMap.get(inp.state) ?? null;

    const incumbentC = candidates.find((c) => c.incumbent) ?? null;
    let priorParty: Party | null = enr.priorParty ?? null;
    if (!priorParty && inp.office === 'S') priorParty = SENATE_PRIOR[inp.state] ?? null;
    if (!priorParty && inp.office === 'G') priorParty = GOV_PRIOR[inp.state] ?? null;
    if (!priorParty && incumbentC) priorParty = incumbentC.party;
    if (!priorParty && inp.gainedBy && winnerC) {
      // Provider reported a pickup but we don't know the prior party (House in phase 1).
      priorParty = null;
    }

    let status: Race['status'];
    if (inp.runoff) status = 'runoff';
    else if (inp.called && winnerC) status = 'called';
    else if (total > 0) status = 'counting';
    else if (pollClose && now >= Date.parse(pollClose)) status = 'closed';
    else status = 'upcoming';

    // "Decision expected later": explain why an uncalled race may stay uncalled tonight.
    const rcv = inp.rcv ?? (inp.state === 'AK' || (inp.state === 'ME' && inp.office !== 'G'));
    const eevp = inp.eevp ?? 0;
    const topPct = total > 0 ? (candidates[0].votes / total) * 100 : 0;
    const gap = total > 0 && candidates[1] ? ((candidates[0].votes - candidates[1].votes) / total) * 100 : 100;
    let expectedLater: string | null = null;
    if (status === 'counting') {
      if (rcv && topPct < 50 && eevp >= 40) expectedLater = 'No one above 50%: ranked-choice tabulation needed, decision expected later';
      else if (inp.state === 'GA' && topPct < 50 && eevp >= 80) expectedLater = 'Below 50%: likely headed to a runoff';
      else if (eevp >= 95 && gap < 1) expectedLater = 'Too close to call';
      else if (SLOW_COUNT.has(inp.state) && pollClose && now - Date.parse(pollClose) > 4 * 3600_000 && eevp < 85)
        expectedLater = 'Count continues; full results may take days';
    }

    const winner = status === 'called' && winnerC ? winnerC.party : null;
    const flip = !!winner && (priorParty ? winner !== priorParty : !!inp.gainedBy);
    const market = this.markets.get(inp.id);

    // Expected winner: the call, NYT's model, the Polymarket favorite, the forecast, the leader.
    let projected: Race['projected'] = null;
    const rating = enr.flipr ?? enr.cook ?? inp.rating;
    const favorite = market?.byParty ? (Object.entries(market.byParty) as [Party, number][]).sort((a, b) => b[1] - a[1])[0] : undefined;
    if (winner) projected = { party: winner, source: 'call' };
    else if (inp.model && leaderC && total > 0) {
      const median = inp.model.quantiles[2];
      const p = median >= 0 ? leaderC.party : (second?.party ?? leaderC.party);
      projected = { party: p, source: 'nyt' };
    } else if (favorite && favorite[1] > 0) projected = { party: favorite[0], source: 'polymarket' };
    else if (rating?.party) projected = { party: rating.party, source: 'forecast' };
    else if (leaderC) projected = { party: leaderC.party, source: 'leader' };

    return {
      id: inp.id,
      office: inp.office,
      state: inp.state,
      district: inp.district,
      special: inp.special || !!enr.special,
      title: !inp.special && enr.special ? `${inp.title} (special)` : inp.title,
      candidates,
      totalVotes: total,
      expectedVotes: inp.expectedVotes,
      eevp: inp.eevp,
      precinctsReporting: inp.precinctsReporting,
      precinctsTotal: inp.precinctsTotal,
      status,
      pollClose,
      winner,
      winnerName: winner ? winnerC!.name : null,
      calledBy: winner ? inp.calledBy : null,
      calledAt: winner ? inp.calledAt : null,
      priorParty,
      incumbentName: incumbentC?.name ?? enr.incumbentName ?? null,
      incumbentRunning: !!incumbentC,
      leader: leaderC ? leaderC.party : null,
      leaderName: leaderC ? leaderC.name : null,
      margin: leaderC && second ? +(leaderC.pct - second.pct).toFixed(2) : leaderC ? 100 : null,
      flip,
      uncontested: inp.uncontested,
      certified: !!inp.certified,
      // Alaska uses RCV for all general elections; Maine for federal races.
      rcv,
      expectedLater,
      runoffRule: inp.state === 'GA' && inp.office !== 'H' ? 'Majority required, otherwise a runoff on Dec 1' : inp.state === 'GA' ? 'Majority required, otherwise a runoff' : null,
      forecast: {
        ...(enr.flipr ? { flipr: enr.flipr } : {}),
        ...(enr.cook ? { cook: enr.cook } : {}),
        ...(inp.rating ? { nyt: inp.rating } : {}),
      },
      ...(market ? { market } : {}),
      projected,
      source: inp.source,
      url: inp.url,
      updatedAt: inp.updatedAt,
    };
  }

  private buildChambers(): Record<Office, ChamberSummary> {
    const zero = (): PartyCounts => ({ D: 0, R: 0, I: 0 });
    const make = (office: Office, total: number, toControl: { D: number; R: number }, notUp: PartyCounts, before: PartyCounts, note?: string): ChamberSummary => {
      const s: ChamberSummary = {
        office,
        label: office === 'G' ? 'Governors' : OFFICE_LABEL[office],
        total,
        toControl,
        notUp,
        before,
        won: zero(),
        leading: zero(),
        expected: { ...notUp },
        racesTotal: 0,
        racesCalled: 0,
        racesPending: 0,
        flips: { toD: 0, toR: 0, toI: 0 },
        controlWinner: null,
        ...(this.chamberMarkets[office] ? { market: this.chamberMarkets[office] } : {}),
        ...(note ? { note } : {}),
      };
      for (const r of this.races.values()) {
        if (r.office !== office) continue;
        s.racesTotal++;
        if (r.projected) s.expected[r.projected.party]++;
        if (r.winner) {
          s.racesCalled++;
          s.won[r.winner]++;
          if (r.flip) s.flips[r.winner === 'D' ? 'toD' : r.winner === 'R' ? 'toR' : 'toI']++;
        } else if (r.leader && r.totalVotes > 0) {
          s.leading[r.leader]++;
        } else {
          s.racesPending++;
        }
      }
      // Control clinched? (independents counted with Democrats for Senate caucus math)
      const dSeats = notUp.D + s.won.D + (office === 'S' ? notUp.I + s.won.I : 0);
      const rSeats = notUp.R + s.won.R;
      if (office !== 'G') {
        if (dSeats >= toControl.D) s.controlWinner = 'D';
        else if (rSeats >= toControl.R) s.controlWinner = 'R';
      } else {
        if (dSeats >= 26) s.controlWinner = 'D';
        else if (rSeats >= 26) s.controlWinner = 'R';
      }
      return s;
    };

    const govNotUp = countParties(GOV_NOT_UP_STATES);
    return {
      S: make('S', 100, { D: 51, R: 50 }, SENATE_NOT_UP, SENATE_BEFORE, 'Independents King (ME) and Sanders (VT) caucus with Democrats. VP Vance (R) breaks 50-50 ties.'),
      H: make('H', 435, { D: 218, R: 218 }, { D: 0, R: 0, I: 0 }, this.houseBefore),
      G: make('G', 50, { D: 26, R: 26 }, govNotUp, GOV_BEFORE),
    };
  }

  // ---------------------------------------------------------------- alerts

  private detectEvents(prev: Race | undefined, race: Race) {
    const sim = this.mode === 'simulation';
    const announced = sim ? this.simAnnouncedCalls : this.announcedCalls;
    const items: NewsItem[] = [];
    const place = raceLabel(race);
    const nowIso = sim && this.sim.simTime ? this.sim.simTime : new Date().toISOString();

    if (race.winner && !announced.has(race.id)) {
      announced.add(race.id);
      const w = race.candidates.find((c) => c.winner)!;
      const flipTxt = race.flip ? ` — ${PARTY_NAME[race.winner].toUpperCase()} GAIN${race.priorParty ? ` from ${race.priorParty}` : ''}` : race.priorParty ? ` — ${race.winner} hold` : '';
      items.push({
        id: `${sim ? 'sim-' : ''}call-${race.id}`,
        kind: race.flip ? 'flip' : 'call',
        source: race.calledBy ?? 'Desk',
        title: `PROJECTED: ${w.name} (${w.party}) wins ${place}${flipTxt}`,
        summary: race.totalVotes ? `${w.pct.toFixed(1)}% with ${race.eevp ?? '?'}% of expected vote counted.` : undefined,
        published: nowIso,
        raceId: race.id,
        party: race.winner,
        link: race.url ?? undefined,
        ...(sim ? { sim: true } : {}),
      });
    }

    // Lead changes in statewide races once a meaningful share of the vote is in.
    if (race.office !== 'H' && race.status === 'counting' && race.leader && (race.eevp ?? 0) >= 10) {
      const last = this.lastLeader.get(race.id);
      const now = Date.now();
      if (last && last.party !== race.leader && now - last.at > (sim ? 5_000 : 300_000)) {
        items.push({
          id: `${sim ? 'sim-' : ''}lead-${race.id}-${now}`,
          kind: 'lead',
          source: 'Results',
          title: `LEAD CHANGE: ${race.leaderName} (${race.leader}) moves ahead in ${place}`,
          summary: `Leads by ${race.margin?.toFixed(1)} pts with ${race.eevp}% of expected vote counted.`,
          published: nowIso,
          raceId: race.id,
          party: race.leader,
          ...(sim ? { sim: true } : {}),
        });
      }
      if (!last || last.party !== race.leader) this.lastLeader.set(race.id, { party: race.leader, at: now });
    }
    void prev;
    if (items.length) this.addNews(items);
  }

  private checkPollClosings(now: number) {
    const sim = this.mode === 'simulation';
    const announced = sim ? this.simAnnouncedClosings : this.announcedClosings;
    const byTime = new Map<string, string[]>();
    for (const [state, t] of this.pollClosingMap) {
      if (Date.parse(t) <= now && !announced.has(t)) {
        if (!byTime.has(t)) byTime.set(t, []);
        byTime.get(t)!.push(state);
      }
    }
    const items: NewsItem[] = [];
    for (const [t, states] of byTime) {
      announced.add(t);
      // Don't announce historical closings on first boot (> 2h ago) in live mode.
      if (!sim && now - Date.parse(t) > 2 * 3600_000) continue;
      const etTime = new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
      const names = states.sort().map((s) => STATE_BY_POSTAL[s]?.name ?? s);
      items.push({
        id: `${sim ? 'sim-' : ''}polls-${t}`,
        kind: 'polls',
        source: 'Poll closings',
        title: `POLLS CLOSED (${etTime} ET): ${names.join(', ')}`,
        published: sim && this.sim.simTime ? this.sim.simTime : new Date().toISOString(),
        ...(sim ? { sim: true } : {}),
      });
    }
    if (items.length) this.addNews(items);
  }

  private maybeRecordBop(): BopHistoryPoint | null {
    const sim = this.mode === 'simulation';
    const minGap = sim ? 2_000 : 60_000;
    const now = Date.now();
    if (now - this.lastBopPointAt < minGap) return null;
    const point: BopHistoryPoint = {
      t: sim && this.sim.simTime ? this.sim.simTime : new Date().toISOString(),
      S: projected(this.chambers.S),
      H: projected(this.chambers.H),
      G: projected(this.chambers.G),
      called: { S: secured(this.chambers.S), H: secured(this.chambers.H), G: secured(this.chambers.G) },
    };
    const hist = sim ? this.simHistory : this.bopHistory;
    const last = hist[hist.length - 1];
    if (last && JSON.stringify([last.S, last.H, last.G, last.called]) === JSON.stringify([point.S, point.H, point.G, point.called])) return null;
    // Only start recording once something is actually counting.
    const anyActivity = OFFICES.some((o) => this.chambers[o].racesCalled + sumCounts(this.chambers[o].leading) > 0);
    if (!anyActivity) return null;
    this.lastBopPointAt = now;
    hist.push(point);
    if (hist.length > 2000) hist.splice(0, hist.length - 2000);
    return point;
  }

  // ---------------------------------------------------------------- output

  pollClosings(): PollClosing[] {
    return [...this.pollClosingMap.entries()]
      .map(([state, time]) => ({ state, time }))
      .sort((a, b) => a.time.localeCompare(b.time) || a.state.localeCompare(b.state));
  }

  snapshot(): Snapshot {
    return {
      version: this.version,
      generatedAt: new Date().toISOString(),
      mode: this.mode,
      races: Object.fromEntries(this.races),
      measures: Object.fromEntries(this.measures),
      chambers: this.chambers,
      news: this.news,
      sources: allPollerStatus(),
      pollClosings: this.pollClosings(),
      bopHistory: this.mode === 'simulation' ? this.simHistory : this.bopHistory,
      sim: this.sim,
    };
  }

  broadcastMeta(bopPoint?: BopHistoryPoint) {
    this.broadcast({
      type: 'meta',
      version: ++this.version,
      data: { mode: this.mode, sim: this.sim, pollClosings: this.pollClosings(), ...(bopPoint ? { bopPoint } : {}) },
    });
  }

  broadcastSources() {
    this.broadcast({ type: 'sources', version: ++this.version, data: allPollerStatus() });
  }

  private broadcast(ev: StreamEvent) {
    this.emit('event', ev);
  }

  // ---------------------------------------------------------------- persistence

  /**
   * Results lock. Every count keeps updating until the state certifies it: the results feeds
   * (NYT, CNN, Polymarket) stop only when NYT marks every race certified, or at RESULTS_LOCK_AT
   * (noon ET, Jan 3, 2027: the new Congress is sworn in and results can no longer change).
   * Certification comes from the NYT race files themselves, so it is checked on every poll.
   */
  resultsGate(): { frozen: boolean; note: string | null } {
    if (this.frozen) return { frozen: true, note: this.frozenNote };
    const live = [...this.races.values()];
    const lockAt = config.resultsLockAt;
    const lock = (why: string) => {
      this.frozen = true;
      this.frozenNote = `stopped: ${why}; serving the saved results`;
      log.info(`results locked (${why}); results feeds stopped`);
      return { frozen: true, note: this.frozenNote };
    };
    if (lockAt != null && Date.now() >= lockAt) return lock(`past ${new Date(lockAt).toISOString().slice(0, 10)}, when the newly elected took office`);
    if (!live.length) return { frozen: false, note: null };
    const certified = live.filter((r) => r.certified).length;
    if (certified === live.length) return lock('every race certified');
    // Shown on the results feeds once election night is over: certification progress.
    return { frozen: false, note: archivePhase() ? `${certified}/${live.length} races certified; polling until all are${lockAt != null ? ` or ${new Date(lockAt).toISOString().slice(0, 10)}` : ''}` : null };
  }

  toPersisted() {
    const batches: Record<string, Record<string, { fetchedAt: number; races: RaceInput[] }>> = {};
    for (const [p, byOffice] of this.batches) {
      if (p === 'sim') continue;
      batches[p] = {};
      for (const [o, b] of byOffice) batches[p][o] = { fetchedAt: b.fetchedAt, races: [...b.races.values()] };
    }
    return {
      savedAt: new Date().toISOString(),
      batches,
      enrichment: Object.fromEntries(this.enrichment),
      markets: Object.fromEntries(this.markets),
      chamberMarkets: this.chamberMarkets,
      pollClosings: Object.fromEntries(this.pollClosingMap),
      houseBefore: this.houseBefore,
      news: this.news.filter((n) => !n.sim),
      bopHistory: this.bopHistory,
      announcedCalls: [...this.announcedCalls],
      announcedClosings: [...this.announcedClosings],
    };
  }

  loadPersisted(p: ReturnType<ElectionStore['toPersisted']>) {
    for (const [prov, byOffice] of Object.entries(p.batches ?? {})) {
      const m = new Map<Office, { fetchedAt: number; races: Map<string, RaceInput> }>();
      for (const [o, b] of Object.entries(byOffice)) m.set(o as Office, { fetchedAt: b.fetchedAt, races: new Map(b.races.map((r) => [r.id, r])) });
      this.batches.set(prov as ProviderId, m);
    }
    this.enrichment = new Map(Object.entries(p.enrichment ?? {}));
    this.markets = new Map(Object.entries(p.markets ?? {}));
    this.chamberMarkets = p.chamberMarkets ?? {};
    this.pollClosingMap = new Map(Object.entries(p.pollClosings ?? {}));
    if (p.houseBefore) this.houseBefore = p.houseBefore;
    this.news = uniqueById(p.news ?? []);
    this.bopHistory = p.bopHistory ?? [];
    this.announcedCalls = new Set(p.announcedCalls ?? []);
    this.announcedClosings = new Set(p.announcedClosings ?? []);
    this.recompute(true);
  }
}

// ------------------------------------------------------------------ helpers

function pickResults(r: RaceInput): Partial<RaceInput> {
  const { totalVotes, expectedVotes, eevp, precinctsReporting, precinctsTotal, called, runoff, calledBy, calledAt, gainedBy, updatedAt, source } = r;
  return { totalVotes, expectedVotes, eevp, precinctsReporting, precinctsTotal, called, runoff, calledBy, calledAt, gainedBy, updatedAt, source };
}

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
}

export function matchCandidate(list: Candidate[], c: Pick<Candidate, 'lastName' | 'party' | 'name'>): Candidate | undefined {
  const ln = norm(c.lastName);
  return (
    list.find((x) => norm(x.lastName) === ln && x.party === c.party) ??
    list.find((x) => norm(x.lastName) === ln) ??
    list.find((x) => norm(x.name).includes(ln) && ln.length > 3)
  );
}

/** Overlay a secondary provider's vote counts onto the primary provider's candidate list. */
function applyVotes(base: RaceInput, src: RaceInput): RaceInput {
  const out: RaceInput = { ...base, ...pickResults(src), candidates: base.candidates.map((c) => ({ ...c, votes: 0, winner: false })) };
  for (const sc of src.candidates) {
    const t = matchCandidate(out.candidates, sc);
    if (t) {
      t.votes = sc.votes;
      t.winner = sc.winner;
    }
  }
  return out;
}

/** Seats actually secured: not up this cycle plus races called. */
function secured(c: ChamberSummary): { D: number; R: number; I: number } {
  return { D: c.notUp.D + c.won.D, R: c.notUp.R + c.won.R, I: c.notUp.I + c.won.I };
}

function projected(c: ChamberSummary): { D: number; R: number; I: number } {
  return { ...c.expected };
}

function sumCounts(c: PartyCounts) {
  return c.D + c.R + c.I;
}

export function raceLabel(r: Pick<Race, 'state' | 'office' | 'district' | 'special'>): string {
  const st = STATE_BY_POSTAL[r.state]?.name ?? r.state;
  if (r.office === 'H') return `${st} ${r.district === 1 && ['AK', 'DE', 'ND', 'SD', 'VT', 'WY'].includes(r.state) ? 'At-Large' : `District ${r.district}`}`;
  return `${st} ${r.office === 'S' ? 'Senate' : 'Governor'}${r.special ? ' (special)' : ''}`;
}

export const store = new ElectionStore();
