import type { BallotMeasure, MeasureChoice, MeasureType, NewsItem } from '../../../shared/src/types.js';
import { STATE_BY_POSTAL } from '../../../shared/src/states.js';
import { config, staleAfterFor } from '../config.js';
import { archivePhase, shrankTooMuch } from '../lib/guard.js';
import { logger } from '../lib/log.js';
import { store, type ElectionStore } from './store.js';

const log = logger('measures');

/** Normalized output of a ballot-measure results provider (CNN, NYT, simulator). */
export interface MeasureInput {
  key: string;
  state: string;
  code: string | null;
  title: string;
  description: string | null;
  choices: MeasureChoice[];
  totalVotes: number;
  eevp: number | null;
  called: boolean;
  calledBy: string | null;
  pollClose: string | null;
  url: string | null;
  updatedAt: string | null;
  source: string;
}

/** One row of the Wikipedia "2026 United States ballot measures" catalog. */
export interface CatalogEntry {
  state: string;
  /** Display name: Ballotpedia's page name when the row cites one, otherwise Wikipedia's. */
  name: string;
  description: string;
  origin: string | null;
  /** Official designation ("Amendment 1", "Question 3") from Ballotpedia, the row, or the linked article. */
  code?: string | null;
  ballotpediaUrl?: string | null;
  /** The measure's own Wikipedia article, when it has one. */
  wikipediaUrl?: string | null;
  /** Target of the row's [[wikilink]], used to look up the official number. */
  article?: string | null;
}

type Provider = 'nyt' | 'cnn' | 'sim';

const STOP = new Set(
  'the a an of to in for and or on by be is are with from as at that this would will shall state its it require requires allow allows establish establishes amend amendment constitution constitutional measure proposition question issue initiative act'.split(
    ' ',
  ),
);

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, '')),
  );

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** "Proposition 316" -> "316", "Amendment HJR6" -> "HJR6", "Initiative 001" -> "1", "Amendment J" -> "J". */
export function codeToken(code: string | null | undefined): string | null {
  if (!code) return null;
  const m = code.match(
    /(?:Constitutional Amendment|Amendment|Proposition|Prop\.?|Question|Measure|Issue|Initiative(?: Measure)?(?: No\.)?|Referendum|Proposal|Referred Question|Referred Measure|Legislative Referral)\s*(?:No\.\s*)?([A-Z]{0,4}\s?-?\d+[A-Z]?|[A-Z]{1,2})\b/i,
  );
  // Bare bill/initiative numbers: "HJR 4", "CI-132".
  const bare = m ? null : code.trim().match(/^([A-Z]{1,4})[\s-]?(\d+[A-Z]?)$/);
  if (bare) return `${bare[1]}${bare[2].replace(/^0+(\d)/, '$1')}`;
  if (!m) return null;
  return m[1].replace(/[\s-]/g, '').toUpperCase().replace(/^([A-Z]*)0+(\d)/, '$1$2');
}

const TOPICS: [string, RegExp][] = [
  ['Elections & voting', /\b(to vote|voter|voting|elections?\b|primar|ranked.choice|redistrict|electoral|recall)/i],
  ['Abortion', /\b(abortion|reproductive|pregnan)/i],
  ['Taxes', /\b(tax|taxes|levy|levies)\b/i],
  ['Criminal justice', /\b(bail|crime|criminal|sentenc|police|pardon|prison|felon|murder)/i],
  ['Immigration', /\b(immigra|illegal|deport|alien)/i],
  ['Education', /\b(school|education|student|teacher|college|universit)/i],
  ['Guns', /\b(firearm|gun|weapon|second amendment)/i],
  ['Government & courts', /\b(term limit|governor|legislat|judge|judicial|court|official language|lieutenant)/i],
  ['Labor & wages', /\b(wage|labor|union|worker|employ|paid leave)/i],
  ['Housing & land', /\b(housing|rent|property|land|eminent domain|homestead)/i],
  ['Health', /\b(health|medicaid|medical|hospital|insurance)/i],
  ['Drugs & alcohol', /\b(marijuana|cannabis|psilocybin|alcohol|liquor|gambling|sports betting|casino)/i],
  ['Environment & energy', /\b(environment|energy|climate|water|wildlife|hunting|fishing|conservation)/i],
  ['Civil rights', /\b(marriage|gender|transgender|equal rights|discriminat|sex)/i],
];

export function topicsFor(text: string): string[] {
  return TOPICS.filter(([, re]) => re.test(text)).map(([t]) => t);
}

/** Supermajority thresholds that apply to constitutional amendments. */
const THRESHOLD: Record<string, number> = { FL: 60, CO: 55, NH: 66.67, IL: 60 };

/** Fallback link: the measure's article, else its state's section of the national list. */
function wikipediaLink(state: string, cat: CatalogEntry | undefined): string {
  if (cat?.wikipediaUrl) return cat.wikipediaUrl;
  const name = (STATE_BY_POSTAL[state]?.name ?? state).replace(/ /g, '_');
  return `https://en.wikipedia.org/wiki/${config.electionDate.slice(0, 4)}_United_States_ballot_measures#${name}`;
}

function classify(code: string | null, cat: CatalogEntry | undefined, title: string): MeasureType {
  const hay = `${code ?? ''} ${cat?.code ?? ''} ${cat?.name ?? ''} ${cat?.description ?? ''} ${title}`;
  if (/amendment|constitution/i.test(hay)) return 'constitutional';
  if (cat) return 'statute';
  return 'unknown';
}

const isYes = (label: string) => /^(yes|for|approve|approved)$/i.test(label.trim());
const isNo = (label: string) => /^(no|against|reject|rejected)$/i.test(label.trim());
export const sideOf = (label: string): MeasureChoice['side'] => (isYes(label) ? 'yes' : isNo(label) ? 'no' : 'other');

/**
 * Ballot-measure state. Lives beside the race store (same SSE channel) because measures have
 * a different shape (yes/no, thresholds, catalog-only entries).
 */
export class MeasureStore {
  constructor(private store: ElectionStore) {}

  private inputs = new Map<Provider, { fetchedAt: number; items: Map<string, MeasureInput> }>();
  private catalog: CatalogEntry[] = [];
  measures = new Map<string, BallotMeasure>();
  announced = new Set<string>();
  private simAnnounced = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  ingest(provider: Provider, items: MeasureInput[]) {
    const next = new Map(items.map((i) => [i.key, i]));
    const prev = this.inputs.get(provider);
    if (prev && provider !== 'sim') {
      // A list that suddenly has under half the measures is a broken or partial response.
      if (shrankTooMuch(prev.items.size, next.size)) {
        log.warn(`${provider}: now lists ${next.size} measures (was ${prev.items.size}); keeping the saved results`);
        return;
      }
      // After election night, a measure whose file disappears or whose count vanishes keeps its last result.
      if (archivePhase())
        for (const [key, old] of prev.items) {
          const cur = next.get(key);
          if (!cur || (old.totalVotes > 0 && !cur.totalVotes)) next.set(key, old);
        }
    }
    this.inputs.set(provider, { fetchedAt: Date.now(), items: next });
    this.schedule();
  }

  touch(provider: Provider) {
    const b = this.inputs.get(provider);
    if (b) b.fetchedAt = Date.now();
  }

  clear(provider: Provider) {
    this.inputs.delete(provider);
    if (provider === 'sim') this.simAnnounced.clear();
    this.schedule();
  }

  setCatalog(entries: CatalogEntry[]) {
    this.catalog = entries;
    this.schedule();
  }

  getCatalog(): CatalogEntry[] {
    return this.catalog;
  }

  catalogStates(): string[] {
    return [...new Set([...this.catalog.map((c) => c.state), ...[...(this.inputs.get('cnn')?.items.values() ?? [])].map((i) => i.state)])];
  }

  /** Live (non-sim) merged inputs for the simulator. */
  liveInputs(): MeasureInput[] {
    return [...this.mergeInputs(false).values()];
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.recompute();
      } catch (err) {
        log.error('recompute failed', err);
      }
    }, 250);
  }

  /** NYT (AP, all statewide measures) preferred while fresh; CNN otherwise; sim overrides. */
  private mergeInputs(includeSim = true): Map<string, MeasureInput> {
    const nyt = this.inputs.get('nyt');
    const cnn = this.inputs.get('cnn');
    const sim = includeSim && this.store.mode === 'simulation' ? this.inputs.get('sim') : undefined;
    const out = new Map<string, MeasureInput>();
    const nytFresh = !!nyt && Date.now() - nyt.fetchedAt < staleAfterFor(config.intervals.nytMeasures);

    // Map CNN items onto NYT keys (number token first, then text similarity within the state).
    const cnnByKey = new Map(cnn?.items ?? []);
    const aliases = new Map<string, string>(); // cnnKey -> nytKey
    if (nyt) {
      for (const n of nyt.items.values()) {
        if (cnnByKey.has(n.key)) continue;
        let best: { k: string; s: number } | null = null;
        for (const c of cnnByKey.values()) {
          if (c.state !== n.state || nyt.items.has(c.key)) continue;
          const s = similarity(`${n.title} ${n.description ?? ''}`, c.title);
          if (s > 0.34 && (!best || s > best.s)) best = { k: c.key, s };
        }
        if (best) aliases.set(best.k, n.key);
      }
    }

    for (const n of nyt?.items.values() ?? []) out.set(n.key, { ...n });
    for (const c of cnnByKey.values()) {
      const key = aliases.get(c.key) ?? c.key;
      const base = out.get(key);
      if (!base) {
        out.set(key, { ...c, key });
        continue;
      }
      // Prefer CNN's concise question as the title; keep NYT's description.
      base.title = c.title || base.title;
      if (!nytFresh || (c.called && !base.called)) {
        Object.assign(base, { choices: c.choices, totalVotes: c.totalVotes, eevp: c.eevp, called: c.called, calledBy: c.calledBy, source: c.source });
      }
      base.pollClose = base.pollClose ?? c.pollClose;
    }
    if (sim) {
      for (const s of sim.items.values()) {
        const base = out.get(s.key);
        if (base) Object.assign(base, { choices: s.choices, totalVotes: s.totalVotes, eevp: s.eevp, called: s.called, calledBy: s.calledBy, source: s.source, updatedAt: s.updatedAt });
      }
    }
    return out;
  }

  /** Greedy best-match of catalog rows to live measures, per state. */
  private matchCatalog(inputs: MeasureInput[]): Map<string, CatalogEntry> {
    const matched = new Map<string, CatalogEntry>();
    const used = new Set<CatalogEntry>();
    const pairs: { key: string; cat: CatalogEntry; score: number }[] = [];
    for (const m of inputs) {
      const tok = codeToken(m.code);
      for (const c of this.catalog) {
        if (c.state !== m.state) continue;
        let score = similarity(`${m.title} ${m.description ?? ''}`, `${c.name} ${c.description}`);
        const ctok = codeToken(c.code) ?? codeToken(c.name);
        if (tok && ctok && tok === ctok) score += 1;
        if (score > 0.25) pairs.push({ key: m.key, cat: c, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const p of pairs) {
      if (matched.has(p.key) || used.has(p.cat)) continue;
      matched.set(p.key, p.cat);
      used.add(p.cat);
    }
    // Feeds and the catalog can word the same measure with no overlap ("K-12 Funding" vs "TABOR
    // Revenue Cap Increase for K-12 Education Measure"). If a state has exactly one unmatched
    // measure on each side, they are the same measure.
    for (const st of new Set(inputs.map((m) => m.state))) {
      const liveLeft = inputs.filter((m) => m.state === st && !matched.has(m.key));
      const catLeft = this.catalog.filter((c) => c.state === st && !used.has(c));
      if (liveLeft.length !== 1 || catLeft.length !== 1) continue;
      const [m, c] = [liveLeft[0], catLeft[0]];
      const tok = codeToken(m.code);
      const ctok = codeToken(c.code);
      if (tok && ctok && tok !== ctok) continue; // both numbered, and differently: not the same
      matched.set(m.key, c);
      used.add(c);
    }
    return matched;
  }

  recompute() {
    const sim = this.store.mode === 'simulation';
    const now = this.store.clock();
    const inputs = [...this.mergeInputs().values()];
    const catMatch = this.matchCatalog(inputs);
    const next = new Map<string, BallotMeasure>();
    const alerts: NewsItem[] = [];
    const announced = sim ? this.simAnnounced : this.announced;

    for (const m of inputs) {
      const cat = catMatch.get(m.key);
      const type = classify(m.code, cat, m.title);
      const total = m.totalVotes || m.choices.reduce((s, c) => s + c.votes, 0);
      const choices = m.choices
        .map((c) => ({ ...c, pct: total > 0 ? +((c.votes / total) * 100).toFixed(2) : 0 }))
        .sort((a, b) => (a.side === 'yes' ? -1 : b.side === 'yes' ? 1 : 0));
      const yes = choices.find((c) => c.side === 'yes');
      const winner = choices.find((c) => c.winner);
      const pollClose = m.pollClose ?? this.store.pollClosingFor(m.state);
      const result = m.called && winner ? (winner.side === 'yes' ? 'passed' : 'failed') : null;
      const status: BallotMeasure['status'] = result ? 'called' : total > 0 ? 'counting' : pollClose && now >= Date.parse(pollClose) ? 'closed' : 'upcoming';
      const description = m.description ?? cat?.description ?? null;
      // Ballotpedia's page name reads better than the feeds' short labels.
      const title = cat?.ballotpediaUrl ? cat.name : m.title;
      const measure: BallotMeasure = {
        id: m.key,
        state: m.state,
        code: m.code ?? cat?.code ?? null,
        title,
        description,
        type,
        origin: cat?.origin ?? null,
        topics: topicsFor(`${m.title} ${description ?? ''} ${cat?.name ?? ''}`),
        choices,
        totalVotes: total,
        eevp: m.eevp,
        status,
        result,
        yesPct: total > 0 && yes ? yes.pct : null,
        threshold: type === 'constitutional' ? (THRESHOLD[m.state] ?? 50) : 50,
        pollClose,
        live: true,
        source: m.source,
        calledBy: result ? m.calledBy : null,
        url: m.url,
        ballotpediaUrl: cat?.ballotpediaUrl ?? null,
        wikipediaUrl: cat?.ballotpediaUrl ? null : wikipediaLink(m.state, cat),
        updatedAt: m.updatedAt,
      };
      next.set(measure.id, measure);

      if (result && !announced.has(measure.id)) {
        announced.add(measure.id);
        const st = STATE_BY_POSTAL[m.state]?.name ?? m.state;
        alerts.push({
          id: `${sim ? 'sim-' : ''}measure-${measure.id}`,
          kind: 'measure',
          source: m.calledBy ?? 'Desk',
          title: `${result === 'passed' ? 'PASSED' : 'FAILED'}: ${st} ${measure.code ?? 'ballot measure'} — ${title}`,
          summary: measure.yesPct != null ? `Yes ${measure.yesPct.toFixed(1)}% with ${m.eevp ?? '?'}% of expected vote counted.` : undefined,
          published: sim && this.store.sim.simTime ? this.store.sim.simTime : new Date().toISOString(),
          ...(sim ? { sim: true } : {}),
        });
      }
    }

    // Catalog-only measures (no results feed yet) so the dashboard lists everything on the ballot.
    const usedCats = new Set(catMatch.values());
    let n = 0;
    for (const c of this.catalog) {
      if (usedCats.has(c)) continue;
      const pollClose = this.store.pollClosingFor(c.state);
      const id = `${c.state}-cat-${++n}`;
      const type = classify(null, c, c.name);
      next.set(id, {
        id,
        state: c.state,
        code: c.code ?? null,
        title: c.name,
        description: c.description || null,
        type,
        origin: c.origin,
        topics: topicsFor(`${c.name} ${c.description}`),
        choices: [],
        totalVotes: 0,
        eevp: null,
        status: pollClose && now >= Date.parse(pollClose) ? 'closed' : 'upcoming',
        result: null,
        yesPct: null,
        threshold: type === 'constitutional' ? (THRESHOLD[c.state] ?? 50) : 50,
        pollClose,
        live: false,
        source: c.ballotpediaUrl ? 'Ballotpedia / Wikipedia' : 'Wikipedia catalog',
        calledBy: null,
        url: null,
        ballotpediaUrl: c.ballotpediaUrl ?? null,
        wikipediaUrl: c.ballotpediaUrl ? null : wikipediaLink(c.state, c),
        updatedAt: null,
      });
    }

    const changed: BallotMeasure[] = [];
    for (const [id, m] of next) {
      const prev = this.measures.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(m)) changed.push(m);
    }
    const removed = [...this.measures.keys()].some((k) => !next.has(k));
    this.measures = next;
    if (removed) this.store.publishMeasures([...next.values()], true);
    else if (changed.length) this.store.publishMeasures(changed, false);
    if (alerts.length) this.store.addNews(alerts);
  }

  toPersisted() {
    const inputs: Record<string, { fetchedAt: number; items: MeasureInput[] }> = {};
    for (const [p, b] of this.inputs) if (p !== 'sim') inputs[p] = { fetchedAt: b.fetchedAt, items: [...b.items.values()] };
    return { inputs, catalog: this.catalog, announced: [...this.announced] };
  }

  loadPersisted(p: ReturnType<MeasureStore['toPersisted']> | undefined) {
    if (!p) return;
    for (const [prov, b] of Object.entries(p.inputs ?? {})) this.inputs.set(prov as Provider, { fetchedAt: b.fetchedAt, items: new Map(b.items.map((i) => [i.key, i])) });
    this.catalog = p.catalog ?? [];
    this.announced = new Set(p.announced ?? []);
    this.recompute();
  }
}

export const measureStore = new MeasureStore(store);
