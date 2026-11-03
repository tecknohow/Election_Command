/**
 * Polymarket prediction-market odds.
 *
 *  Discovery (every 30-60 min):  Gamma API  https://gamma-api.polymarket.com
 *     /public-search?q=...   -> find "{State} Senate|Governor Election Winner" events
 *     /events?tag_slug=house-elections (paged) -> every "{ST}-{NN} House Election Winner"
 *                                event (434 of 435 districts as of Nov 2; R-vs-R / D-vs-D
 *                                seats are "... Winner (Individual)" and found by search)
 *     /events?slug=a&slug=b  -> full event + markets (clobTokenIds, outcomePrices)
 *  Prices (every 30 s):          CLOB API   https://clob.polymarket.com
 *     POST /midpoints [{token_id}]  -> live mid price for every "Yes" token, batched
 *
 * Documented limits are generous (Gamma ~4000 req/10s, /events 500/10s; CLOB price
 * endpoints ~1500/10s). Prices for ~1,070 tokens take ~11 batched requests per 30 s;
 * discovery is ~15 requests per 30 min.
 * Gamma responses are CDN-cached (max-age=300) so CLOB is used for fresh prices; if CLOB
 * fails we fall back to Gamma's outcomePrices.
 */
import type { MarketData, MarketOutcome, Office, Party } from '../../../shared/src/types.js';
import { STATES, raceId } from '../../../shared/src/states.js';
import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { Poller } from '../lib/poller.js';
import { store } from '../store/store.js';

const log = logger('polymarket');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

interface GammaMarket {
  question: string;
  groupItemTitle?: string;
  outcomes?: string;
  outcomePrices?: string | null;
  clobTokenIds?: string;
  active?: boolean;
  closed?: boolean;
}
interface GammaEvent {
  slug: string;
  title: string;
  volume?: number;
  markets: GammaMarket[];
}

interface TrackedOutcome extends MarketOutcome {
  tokenId: string;
}
interface TrackedEvent {
  key: string; // raceId or `chamber-S` / `chamber-H`
  slug: string;
  volume: number | null;
  outcomes: TrackedOutcome[];
}

let tracked: TrackedEvent[] = [];

function partyOf(m: GammaMarket): Party | null {
  const t = `${m.groupItemTitle ?? ''}`;
  const tag = t.match(/\((D|R|I)\)\s*$/);
  if (tag) return tag[1] as Party;
  const q = `${t} ${m.question}`.toLowerCase();
  if (/democrat/.test(q)) return 'D';
  if (/republican/.test(q)) return 'R';
  if (/independent/.test(q)) return 'I';
  return null;
}

function toTracked(key: string, e: GammaEvent): TrackedEvent | null {
  const outcomes: TrackedOutcome[] = [];
  for (const m of e.markets ?? []) {
    if (!m.clobTokenIds || !m.outcomePrices) continue;
    if (m.active === false) continue;
    let token: string, price: number;
    try {
      token = JSON.parse(m.clobTokenIds)[0];
      price = Number(JSON.parse(m.outcomePrices)[0]);
    } catch {
      continue;
    }
    // Skip placeholder outcomes ("Person A") that were never activated.
    if (/^Person [A-Z]$/.test(m.groupItemTitle ?? '')) continue;
    outcomes.push({
      label: (m.groupItemTitle || m.question).replace(/\s*\((D|R|I)\)\s*$/, ''),
      party: partyOf(m),
      prob: Number.isFinite(price) ? price : 0,
      tokenId: token,
    });
  }
  if (!outcomes.length) return null;
  return { key, slug: e.slug, volume: e.volume ?? null, outcomes };
}

async function search(q: string): Promise<GammaEvent[]> {
  const url = `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=100&events_status=active`;
  const res = await fetchJson<{ events?: GammaEvent[] }>(url);
  return res.data?.events ?? [];
}

async function eventsBySlug(slugs: string[]): Promise<GammaEvent[]> {
  const out: GammaEvent[] = [];
  for (let i = 0; i < slugs.length; i += 20) {
    const qs = slugs.slice(i, i + 20).map((s) => `slug=${encodeURIComponent(s)}`).join('&');
    const res = await fetchJson<GammaEvent[]>(`${GAMMA}/events?${qs}`);
    out.push(...(res.data ?? []));
  }
  return out;
}

const OFFICE_WORD: Record<'S' | 'G', string> = { S: 'Senate', G: 'Governor' };

const HOUSE_TITLE = /^([A-Z]{2})-(\d{1,2}|AL) House Election Winner(\s*\(Individual\))?$/;

/** Every House district market, via the house-elections tag (paged), plus targeted search for gaps. */
async function discoverHouse(found: Map<string, GammaEvent>) {
  const individual = new Map<string, GammaEvent>();
  const take = (e: GammaEvent) => {
    const m = e.title.trim().match(HOUSE_TITLE);
    if (!m || !STATES.some((s) => s.postal === m[1])) return;
    const id = raceId(m[1], 'H', m[2] === 'AL' ? 1 : Number(m[2]));
    // Prefer the party-based market; "(Individual)" markets cover same-party contests.
    if (m[3]) individual.set(id, e);
    else found.set(id, e);
  };
  for (let offset = 0; offset < 3000; offset += 100) {
    const res = await fetchJson<GammaEvent[]>(`${GAMMA}/events?tag_slug=house-elections&active=true&closed=false&limit=100&offset=${offset}`);
    const page = res.data ?? [];
    page.forEach(take);
    if (page.length < 100) break;
  }
  for (const [id, e] of individual) if (!found.has(id)) found.set(id, e);
  // Targeted lookups for districts the tag listing missed (bounded to stay polite).
  const missing = [...store.races.values()].filter((r) => r.office === 'H' && !found.has(r.id)).slice(0, 25);
  for (const r of missing) {
    const label = `${r.state}-${['AK', 'DE', 'ND', 'SD', 'VT', 'WY'].includes(r.state) ? 'AL' : String(r.district).padStart(2, '0')}`;
    for (const e of await search(`${label} House Election Winner`)) take(e);
    const ind = individual.get(r.id);
    if (!found.has(r.id) && ind) found.set(r.id, ind);
  }
}

/** Find the event for every state race; titles look like "Texas Senate Election Winner". */
async function discover(): Promise<string> {
  const found = new Map<string, GammaEvent>();
  const year = config.electionDate.slice(0, 4);
  for (const office of ['S', 'G'] as const) {
    const word = OFFICE_WORD[office];
    const events = [...(await search(`${word.toLowerCase()} election winner`)), ...(await search(`${word.toLowerCase()} winner ${year}`))];
    for (const e of events) {
      const m = e.title.trim().match(new RegExp(`^(.+?) ${word} Election Winner$`, 'i'));
      if (!m) continue;
      const st = STATES.find((s) => s.name.toLowerCase() === m[1].trim().toLowerCase());
      if (st) found.set(raceId(st.postal, office), e);
    }
  }
  // Targeted lookups for races the broad search missed.
  const races = [...store.races.values()].filter((r) => r.office !== 'H');
  for (const r of races) {
    if (found.has(r.id)) continue;
    const st = STATES.find((s) => s.postal === r.state)!;
    const word = OFFICE_WORD[r.office as 'S' | 'G'];
    const events = await search(`${st.name} ${word} Election Winner`);
    const e = events.find((x) => x.title.trim().toLowerCase() === `${st.name} ${word} Election Winner`.toLowerCase());
    if (e) found.set(r.id, e);
  }
  await discoverHouse(found);
  const houseKeys = new Set([...found.keys()].filter((k) => k.includes('-H-')));

  const chamberSlugs: Record<string, string> = {
    'chamber-S': `which-party-will-win-the-senate-in-${year}`,
    'chamber-H': `which-party-will-win-the-house-in-${year}`,
  };
  // Re-fetch full events by slug where search results can be abbreviated (House tag pages
  // already include full markets).
  const slugs = [...[...found.entries()].filter(([k, e]) => !houseKeys.has(k) || !e.markets?.length).map(([, e]) => e.slug), ...Object.values(chamberSlugs)];
  const full = new Map((await eventsBySlug(slugs)).map((e) => [e.slug, e]));
  const next: TrackedEvent[] = [];
  for (const [key, e] of found) {
    const t = toTracked(key, full.get(e.slug) ?? e);
    if (t) next.push(t);
  }
  for (const [key, slug] of Object.entries(chamberSlugs)) {
    const e = full.get(slug);
    const t = e && toTracked(key, e);
    if (t) next.push(t);
  }
  tracked = next;
  publish();
  const n = next.filter((t) => !t.key.startsWith('chamber')).length;
  const h = next.filter((t) => t.key.includes('-H-')).length;
  log.info(`tracking ${n} race markets (${n - h} Senate/Gov, ${h} House) + ${next.length - n} chamber markets`);
  return `${n - h} Senate/Gov + ${h} House markets, ${next.length - n} chamber`;
}

async function refreshPrices(): Promise<string | boolean> {
  if (!tracked.length) return 'waiting for discovery';
  const tokens = tracked.flatMap((t) => t.outcomes.map((o) => o.tokenId));
  const prices: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i += 100) {
    const res = await fetchJson<Record<string, string>>(`${CLOB}/midpoints`, {
      method: 'POST',
      body: tokens.slice(i, i + 100).map((token_id) => ({ token_id })),
    });
    Object.assign(prices, res.data ?? {});
  }
  let updated = 0;
  for (const t of tracked) {
    for (const o of t.outcomes) {
      const p = Number(prices[o.tokenId]);
      if (Number.isFinite(p)) {
        o.prob = p;
        updated++;
      }
    }
  }
  publish();
  return `${updated}/${tokens.length} prices live`;
}

function publish() {
  const now = new Date().toISOString();
  const races = new Map<string, MarketData>();
  const chambers: Partial<Record<Office, MarketData>> = {};
  for (const t of tracked) {
    // Some markets list bare candidate names; infer party from the race's candidate list.
    const race = store.races.get(t.key);
    if (race) {
      for (const o of t.outcomes) {
        if (o.party) continue;
        const last = o.label.trim().split(/\s+/).pop()?.toLowerCase();
        const c = last && race.candidates.find((x) => x.lastName.toLowerCase().split(/\s+/).pop() === last);
        if (c) o.party = c.party;
      }
      // Party-level outcomes ("Republican Party") -> show the party's candidate when unambiguous.
      for (const o of t.outcomes) {
        if (!o.party || !/\bparty\b/i.test(o.label)) continue;
        const cands = race.candidates.filter((c) => c.party === o.party && c.name !== 'Total Write-ins');
        if (cands.length === 1) o.label = cands[0].name;
      }
    }
    const byParty: Partial<Record<Party, number>> = {};
    for (const o of t.outcomes) if (o.party) byParty[o.party] = (byParty[o.party] ?? 0) + o.prob;
    const total = Object.values(byParty).reduce((s, v) => s + (v ?? 0), 0);
    if (total > 0) for (const k of Object.keys(byParty) as Party[]) byParty[k] = +(byParty[k]! / total).toFixed(4);
    const md: MarketData = {
      source: 'Polymarket',
      slug: t.slug,
      url: `https://polymarket.com/event/${t.slug}`,
      outcomes: t.outcomes.map(({ label, party, prob }) => ({ label, party, prob })).sort((a, b) => b.prob - a.prob),
      byParty,
      volume: t.volume,
      updatedAt: now,
    };
    if (t.key === 'chamber-S') chambers.S = md;
    else if (t.key === 'chamber-H') chambers.H = md;
    else races.set(t.key, md);
  }
  store.setMarkets(races, chambers);
}

export function startPolymarket() {
  const disc = new Poller({
    id: 'polymarket-discovery',
    name: 'Polymarket discovery',
    role: 'Locates each race\'s market (Gamma API)',
    hotIntervalS: config.intervals.polymarketDiscovery.hot,
    coldIntervalS: config.intervals.polymarketDiscovery.cold,
    enabled: config.sources.polymarket,
    // Wait for race definitions from NYT/CNN so targeted lookups know which races exist.
    initialDelayMs: 8_000,
    run: async () => {
      const r = await discover();
      void prices.trigger(); // fetch live prices immediately after (re)discovery
      return r;
    },
  });
  const prices = new Poller({
    id: 'polymarket',
    name: 'Polymarket prices',
    role: 'Live win probabilities (CLOB midpoints)',
    hotIntervalS: config.intervals.polymarketPrices.hot,
    coldIntervalS: config.intervals.polymarketPrices.cold,
    enabled: config.sources.polymarket,
    initialDelayMs: 12_000,
    run: refreshPrices,
  });
  disc.start();
  prices.start();
  return [disc, prices];
}
