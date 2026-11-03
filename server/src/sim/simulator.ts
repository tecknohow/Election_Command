/**
 * Election-night SIMULATOR — for validating the UI before/without real results.
 *
 * Takes the real race definitions (candidates, poll-closing times, forecasts, markets,
 * 2024 baselines) and plays out a compressed election night: polls close on the real
 * schedule, vote counts climb along per-state reporting curves with early-vote skew,
 * and races are "called" once the outstanding vote can't plausibly overturn the margin.
 *
 * Simulated data lives only in the store's `sim` provider slot; the UI shows a SIMULATION
 * banner and every generated alert is flagged `sim: true`. Stopping the simulator purges it.
 */
import type { Candidate, Party, Race, RaceCounties } from '../../../shared/src/types.js';
import { config } from '../config.js';
import { logger } from '../lib/log.js';
import { EventEmitter } from 'node:events';
import { MeasureStore, measureStore, type MeasureInput } from '../store/measures.js';
import { ElectionStore, store } from '../store/store.js';
import type { RaceInput } from '../store/types.js';

const log = logger('sim');
const SIM_START = Date.parse('2026-11-03T22:50:00Z'); // 5:50pm ET, just before first closings
const TICK_MS = 2_500;
const HOUR = 3600_000;

interface Plan {
  input: RaceInput;
  closeAt: number;
  /** Reporting starts this long after polls close. */
  delay: number;
  /** Time constant of the reporting curve (sim ms). */
  tau: number;
  maxEevp: number;
  /** Final vote share per candidate id (sums to 1). */
  final: Map<string, number>;
  /** Early-count skew toward D (+) or R (-), in share points, decays as count completes. */
  skew: number;
  expected: number;
  called: boolean;
  calledAt: string | null;
  /** Expected final margin is so large AP-style desks call it at poll close. */
  callAtClose: boolean;
}

const gauss = () => {
  let u = 0,
    v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const SLOW_STATES = new Set(['CA', 'AZ', 'NV', 'AK', 'OR', 'WA', 'UT']);
const LEVEL_MARGIN: Record<string, number> = { solid: 22, likely: 11, lean: 5, tilt: 2, tossup: 0 };

/** Expected D-minus-R margin (pct points) for a race, from the best available signal. */
function expectedMargin(race: Race | undefined, inp: RaceInput, nationalSwing: number): number {
  const m = race?.market?.byParty;
  if (m && (m.D != null || m.R != null)) {
    const pd = m.D ?? 0;
    const pr = m.R ?? 0;
    const p = pd + pr > 0 ? pd / (pd + pr) : 0.5;
    // Rough probit: p=0.9 -> ~+8 pts
    const z = clamp((p - 0.5) * 6.2, -3, 3);
    const extra = Math.abs(z) > 2.2 ? Math.sign(z) * 8 : 0;
    return z * 3.6 + extra;
  }
  const r = race?.forecast.flipr ?? race?.forecast.cook ?? race?.forecast.nyt ?? inp.rating;
  if (r) {
    const base = LEVEL_MARGIN[r.level] ?? 0;
    return r.party === 'R' ? -base : r.party === 'D' ? base : 0;
  }
  if (inp.baselineMargin != null) return inp.baselineMargin + nationalSwing;
  if (race?.priorParty === 'R') return -15;
  if (race?.priorParty === 'D') return 15;
  return 0;
}

function finalShares(cands: Candidate[], margin: number, uncontested: boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (uncontested || cands.length === 1) {
    cands.forEach((c, i) => out.set(c.id, i === 0 ? 1 : 0));
    return out;
  }
  const byParty = (p: Party) => cands.find((c) => c.party === p);
  let a = byParty('D');
  let b = byParty('R');
  // Races where an independent is the main opposition (e.g. NE) or no D/R on the ballot.
  if (!a) a = cands.find((c) => c !== b && c.party === 'I');
  if (!b) b = cands.find((c) => c !== a && c.party === 'I');
  if (!a || !b) {
    cands.forEach((c, i) => out.set(c.id, i === 0 ? 0.6 : 0.4 / (cands.length - 1)));
    return out;
  }
  const minorPool = clamp(0.015 * (cands.length - 2) + Math.random() * 0.02, 0, 0.12);
  const major = 1 - minorPool;
  const aShare = clamp(major / 2 + margin / 200, 0.02, major - 0.02);
  out.set(a.id, aShare);
  out.set(b.id, major - aShare);
  const minors = cands.filter((c) => c !== a && c !== b);
  const weights = minors.map(() => Math.random() + 0.2);
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  minors.forEach((c, i) => out.set(c.id, (minorPool * weights[i]) / wsum));
  return out;
}

interface MeasurePlan {
  input: MeasureInput;
  closeAt: number;
  delay: number;
  tau: number;
  maxEevp: number;
  yesFinal: number;
  skew: number;
  expected: number;
  threshold: number;
  called: boolean;
}

/**
 * The simulation runs in its OWN ElectionStore + MeasureStore pair, seeded from the live data.
 * Only admin browsers that opt in are attached to it (see the SSE hub); everyone else keeps
 * receiving the untouched live store. Emits 'session' (new sim store) and 'ended'.
 */
export class Simulator extends EventEmitter {
  /** The isolated simulation stores (null when not running). */
  simStore: ElectionStore | null = null;
  simMeasures: MeasureStore | null = null;
  private timer: NodeJS.Timeout | null = null;
  private plans = new Map<string, Plan>();
  private measurePlans = new Map<string, MeasurePlan>();
  private realStart = 0;
  private simStart = SIM_START;
  speed = config.sim.speed;
  running = false;
  private ticks = 0;

  now(): number {
    return this.simStart + (Date.now() - this.realStart) * this.speed;
  }

  start(speed = this.speed) {
    const inputs = store.liveInputs();
    if (!inputs.length) throw new Error('No race definitions loaded yet — wait for NYT/CNN to load.');
    this.stopTimer();
    this.speed = clamp(speed, 1, 600);
    this.realStart = Date.now();
    this.simStart = SIM_START;
    this.plans.clear();
    const nationalSwing = 2 + gauss() * 3; // modest D-leaning environment w/ uncertainty
    const closings = new Map(store.pollClosings().map((p) => [p.state, Date.parse(p.time)]));

    for (const inp of inputs) {
      const race = store.races.get(inp.id);
      const closeAt = closings.get(inp.state) ?? (inp.pollClose ? Date.parse(inp.pollClose) : SIM_START + 2 * HOUR);
      const exp = expectedMargin(race, inp, nationalSwing);
      const actual = exp + gauss() * (Math.abs(exp) > 15 ? 5 : 3.5);
      const slow = SLOW_STATES.has(inp.state);
      this.plans.set(inp.id, {
        input: inp,
        closeAt,
        delay: (5 + Math.random() * 20) * 60_000,
        tau: (slow ? 3 + Math.random() * 3 : 0.8 + Math.random() * 1.6) * HOUR,
        maxEevp: slow ? 80 + Math.random() * 15 : 97 + Math.random() * 2.5,
        final: finalShares(inp.candidates, actual, inp.uncontested),
        skew: gauss() * 5,
        expected: inp.expectedVotes ?? (inp.office === 'H' ? 320_000 : 2_500_000),
        called: false,
        calledAt: null,
        callAtClose: Math.abs(actual) > 18 || inp.uncontested,
      });
    }
    // Ballot measures: yes share drawn around 52% (most referred amendments pass), state turnout
    // borrowed from the statewide race's expected vote.
    this.measurePlans.clear();
    for (const m of measureStore.liveInputs()) {
      const closeAt = closings.get(m.state) ?? SIM_START + 2 * HOUR;
      const statewide = inputs.find((i) => i.state === m.state && i.office !== 'H' && i.expectedVotes);
      const slow = SLOW_STATES.has(m.state);
      const threshold = store.measures.get(m.key)?.threshold ?? 50;
      this.measurePlans.set(m.key, {
        input: m,
        closeAt,
        delay: (5 + Math.random() * 25) * 60_000,
        tau: (slow ? 3 + Math.random() * 3 : 0.9 + Math.random() * 1.6) * HOUR,
        maxEevp: slow ? 80 + Math.random() * 15 : 97 + Math.random() * 2.5,
        yesFinal: clamp(52 + gauss() * 11, 22, 82),
        skew: gauss() * 3,
        expected: Math.round((statewide?.expectedVotes ?? 1_500_000) * (0.93 + Math.random() * 0.05)),
        threshold,
        called: false,
      });
    }

    // Fresh, isolated stores: base race definitions copied from live, results overridden by 'sim'.
    const sim = new ElectionStore();
    sim.adoptContext(store);
    sim.clock = () => this.now();
    sim.setSimMode(true, { speed: this.speed, simTime: new Date(this.now()).toISOString() });
    sim.ingest({ provider: 'nyt', offices: ['S', 'G', 'H'], fetchedAt: 0, races: inputs });
    const simMeasures = new MeasureStore(sim);
    simMeasures.setCatalog(measureStore.getCatalog());
    simMeasures.ingest('nyt', measureStore.liveInputs());
    // Compute everything synchronously so the first snapshot a viewer receives is complete.
    sim.recompute();
    simMeasures.recompute();
    this.simStore = sim;
    this.simMeasures = simMeasures;

    this.running = true;
    this.emit('session', sim);
    log.info(`started at ${this.speed}x with ${this.plans.size} races`);
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.stopTimer();
    if (!this.running) return;
    this.running = false;
    this.simStore?.removeAllListeners();
    this.simStore = null;
    this.simMeasures = null;
    this.emit('ended');
    log.info('stopped');
  }

  setSpeed(speed: number) {
    // Re-anchor so sim time stays continuous when the speed changes.
    const now = this.now();
    this.simStart = now;
    this.realStart = Date.now();
    this.speed = clamp(speed, 1, 600);
    if (this.simStore) {
      this.simStore.sim.speed = this.speed;
      this.simStore.broadcastMeta();
    }
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = this.now();
    const iso = new Date(now).toISOString();
    const races: RaceInput[] = [];
    for (const plan of this.plans.values()) races.push(this.step(plan, now, iso));
    const sim = this.simStore;
    if (!sim) return;
    sim.adoptContext(store); // pick up fresh market odds / forecasts from the live store
    sim.sim.simTime = iso;
    sim.ingest({ provider: 'sim', offices: ['S', 'G', 'H'], fetchedAt: Date.now(), races });
    this.simMeasures?.ingest('sim', [...this.measurePlans.values()].map((mp) => this.stepMeasure(mp, now, iso)));
    if (++this.ticks % 3 === 0) sim.broadcastMeta();
  }

  private step(p: Plan, now: number, iso: string): RaceInput {
    const inp = p.input;
    const t = now - p.closeAt - p.delay;
    const frac = t <= 0 ? 0 : (1 - Math.exp(-t / p.tau)) * (p.maxEevp / 100);
    const eevp = +(frac * 100).toFixed(1);
    const decay = 1 - Math.min(1, frac / 0.85);

    // Current shares = final shares + early skew that fades as the count completes, + jitter.
    const cands = inp.candidates.map((c) => ({ ...c, votes: 0, winner: false }));
    const shares = cands.map((c) => {
      let s = p.final.get(c.id) ?? 0;
      if (c.party === 'D') s += (p.skew / 100) * decay;
      if (c.party === 'R') s -= (p.skew / 100) * decay;
      return Math.max(0, s + (frac > 0 ? gauss() * 0.002 : 0));
    });
    const ssum = shares.reduce((a, b) => a + b, 0) || 1;
    const total = Math.round(p.expected * frac);
    cands.forEach((c, i) => (c.votes = Math.round((total * shares[i]) / ssum)));

    // Call logic: at poll close for blowouts, otherwise when the remaining vote can't flip it.
    if (!p.called && now >= p.closeAt) {
      const sorted = [...cands].sort((a, b) => b.votes - a.votes);
      const marginPts = total > 0 ? ((sorted[0].votes - (sorted[1]?.votes ?? 0)) / total) * 100 : 0;
      const remaining = 100 - eevp;
      const finalLeader = [...p.final.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (p.callAtClose && finalLeader) {
        p.called = true;
        cands.find((c) => c.id === finalLeader)!.winner = true;
      } else if (eevp >= 25 && marginPts > Math.max(1.2, remaining * 0.22) && sorted[0].id === finalLeader) {
        p.called = true;
      } else if (eevp >= p.maxEevp - 0.5 && marginPts > 0.5) {
        p.called = true;
      }
      if (p.called) p.calledAt = iso;
    }
    if (p.called) {
      const finalLeader = [...p.final.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const w = cands.find((c) => c.id === finalLeader);
      if (w) w.winner = true;
    }

    return {
      ...inp,
      candidates: cands,
      totalVotes: total,
      eevp: total > 0 ? eevp : 0,
      precinctsReporting: inp.precinctsTotal ? Math.round(inp.precinctsTotal * frac) : null,
      called: p.called,
      runoff: false,
      calledBy: p.called ? 'SIM' : null,
      calledAt: p.calledAt,
      gainedBy: null,
      updatedAt: iso,
      source: 'SIMULATION',
    };
  }

  private stepMeasure(p: MeasurePlan, now: number, iso: string): MeasureInput {
    const t = now - p.closeAt - p.delay;
    const frac = t <= 0 ? 0 : (1 - Math.exp(-t / p.tau)) * (p.maxEevp / 100);
    const eevp = +(frac * 100).toFixed(1);
    const yesNow = clamp(p.yesFinal + p.skew * (1 - Math.min(1, frac / 0.85)) + (frac > 0 ? gauss() * 0.15 : 0), 1, 99);
    const total = Math.round(p.expected * frac);
    const yesVotes = Math.round((total * yesNow) / 100);
    const margin = yesNow - p.threshold;
    if (!p.called && total > 0) {
      const remaining = 100 - eevp;
      if ((eevp >= 20 && Math.abs(margin) > Math.max(1.5, remaining * 0.2)) || (eevp >= p.maxEevp - 0.5 && Math.abs(margin) > 0.3)) p.called = true;
    }
    const passes = p.yesFinal >= p.threshold;
    const choices = p.input.choices.map((c) => ({
      ...c,
      votes: c.side === 'yes' ? yesVotes : c.side === 'no' ? total - yesVotes : 0,
      winner: p.called && ((c.side === 'yes' && passes) || (c.side === 'no' && !passes)),
    }));
    return { ...p.input, choices, totalVotes: total, eevp: total > 0 ? eevp : 0, called: p.called, calledBy: p.called ? 'SIM' : null, updatedAt: iso, source: 'SIMULATION' };
  }

  /**
   * Simulated county results for a race: each county reports a deterministic fraction around
   * the statewide progress, and its vote split is shifted from the statewide split by how
   * differently it voted in 2024 (so maps look like real election nights).
   */
  countiesFor(raceId: string, live: RaceCounties): RaceCounties | null {
    const race = this.simStore?.races.get(raceId);
    if (!race) return null;
    const hash = (s: string) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
      return ((h >>> 0) % 10_000) / 10_000;
    };
    const withBase = live.units.filter((u) => u.baselineMargin != null && u.expectedVotes);
    const expSum = withBase.reduce((s, u) => s + (u.expectedVotes ?? 0), 0);
    const stateBase = expSum ? withBase.reduce((s, u) => s + (u.baselineMargin ?? 0) * (u.expectedVotes ?? 0), 0) / expSum : 0;
    const dC = race.candidates.find((c) => c.party === 'D');
    const rC = race.candidates.find((c) => c.party === 'R');
    const units = live.units.map((u) => {
      const h = hash(raceId + u.id);
      const eevp = race.totalVotes ? clamp((race.eevp ?? 0) * (0.65 + 0.7 * h), 0, 99.5) : 0;
      const total = Math.round(((u.expectedVotes ?? 0) * eevp) / 100);
      const shift = u.baselineMargin != null ? (u.baselineMargin - stateBase) / 200 : 0;
      const raw = race.candidates.map((c) => {
        let s = c.pct / 100;
        if (c === dC) s += shift;
        if (c === rC) s -= shift;
        return Math.max(0.001, s);
      });
      const sum = raw.reduce((a, b) => a + b, 0);
      const votes = Object.fromEntries(race.candidates.map((c, i) => [c.id, Math.round((total * raw[i]) / sum)]));
      return { ...u, eevp: +eevp.toFixed(1), totalVotes: total, votes };
    });
    return { raceId, updatedAt: race.updatedAt, source: 'SIMULATION', units };
  }

  status() {
    return { running: this.running, speed: this.speed, simTime: this.running ? new Date(this.now()).toISOString() : null };
  }
}

export const simulator = new Simulator();
