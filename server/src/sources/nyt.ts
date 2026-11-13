/**
 * New York Times election results feed (AP-sourced). PRIMARY results provider.
 *
 *   https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-{senate|governor|house}.json
 *
 * - Public, unauthenticated, CORS-open JSON served from Google Cloud Storage behind Fastly.
 * - `Cache-Control: max-age=5` and strong ETags: we poll with If-None-Match so unchanged
 *   files cost a 304 at the CDN edge. One server polls on behalf of all browser windows.
 * - Rich metadata: candidates, incumbency, headshots, NYT ratings, expected vote (EEVP),
 *   AP race calls, poll-closing times and chamber control.
 */
import type { Candidate, CountyUnit, Office, Party, RaceCounties } from '../../../shared/src/types.js';
import { parseNytRating } from '../../../shared/src/ratings.js';
import { OFFICE_LABEL, STATES, raceId } from '../../../shared/src/states.js';
import { config, NYT_BASE } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { Poller } from '../lib/poller.js';
import { store } from '../store/store.js';
import type { RaceInput } from '../store/types.js';
import { safeUrl } from '../lib/safe.js';
import { countyStore } from '../store/counties.js';
import { countyLabel, townCounty } from '../geo/places.js';

interface NytCandMeta {
  nyt_id: string;
  first_name: string | null;
  last_name: string;
  incumbent: boolean;
  img_url: string | null;
  order: number;
  party: { nyt_id: string; name: string } | null;
}
interface NytRU {
  nyt_id?: string;
  name?: string;
  fips_state?: string | null;
  fips_county?: string | null;
  fips_suffix?: string | null;
  state_postal: string;
  level: string;
  eevp: number | null;
  total_votes: number;
  total_expected_vote: number | null;
  precincts_reporting: number | null;
  precincts_total: number | null;
  provider_updated_at: string | null;
  candidates: { nyt_id: string; votes: { total: number }; leader: boolean }[];
  historical_comparison_race_data?: Record<string, { margin?: number }>;
  nyt_model_estimates?: { margin_quantile?: number[] } | null;
}
interface NytRace {
  nyt_id: string;
  office_id: string;
  race_type_id: string;
  seat_number: string | null;
  uncontested: boolean;
  tabulation_method?: string | null;
  race_call_status: string | null;
  rating: string | null;
  updated_at: string | null;
  candidate_metadata: Record<string, NytCandMeta>;
  outcome: { won: string[]; advanced_to_runoff: string[]; called_by: string[] | null; winner_accepted_at: (string | null)[] | null; gained: string | null };
  top_reporting_unit: NytRU;
  reporting_units?: NytRU[];
  url: string | null;
}
interface NytFile {
  races: NytRace[];
  pollClosingTimes?: { poll_closing_time: string; reporting_unit: { state_postal: string } }[];
  partyControlData?: { results: { offices: Record<string, { current_control?: Record<string, number> }> }[] };
}

export function nytParty(id: string | null | undefined): Party {
  if (id === 'DEM') return 'D';
  if (id === 'GOP') return 'R';
  return 'I';
}

export function normalizeNytRace(r: NytRace): RaceInput | null {
  const ru = r.top_reporting_unit;
  const state = ru?.state_postal;
  if (!state || state === 'US') return null; // US-level = national House popular vote aggregate
  const office = r.office_id as Office;
  if (!['S', 'G', 'H'].includes(office)) return null;
  const district = office === 'H' ? Number(r.seat_number ?? 0) || 1 : null;
  const won = new Set(r.outcome?.won ?? []);
  const votesById = new Map(ru.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0]));

  const candidates: Candidate[] = Object.values(r.candidate_metadata).map((m) => ({
    id: m.nyt_id,
    name: [m.first_name, m.last_name].filter(Boolean).join(' '),
    lastName: m.last_name,
    party: nytParty(m.party?.nyt_id),
    partyName: m.party?.name ?? 'Other',
    incumbent: !!m.incumbent,
    votes: votesById.get(m.nyt_id) ?? 0,
    pct: 0,
    winner: won.has(m.nyt_id),
    img: m.img_url,
  }));
  candidates.sort((a, b) => b.votes - a.votes || 0);

  const special = r.race_type_id === 'W' || r.race_type_id?.startsWith('S');
  const calledBy = (r.outcome?.called_by ?? []).map((s) => s.toUpperCase()).join('/') || (won.size ? 'AP' : null);
  const calledAt = (r.outcome?.winner_accepted_at ?? []).find((x): x is string => !!x) ?? null;
  return {
    id: raceId(state, office, district),
    office,
    state,
    district,
    special,
    title: OFFICE_LABEL[office] + (special ? ' (special)' : ''),
    candidates,
    totalVotes: ru.total_votes ?? 0,
    expectedVotes: ru.total_expected_vote ?? null,
    eevp: ru.eevp ?? null,
    precinctsReporting: ru.precincts_reporting ?? null,
    precinctsTotal: ru.precincts_total ?? null,
    called: won.size > 0,
    runoff: (r.outcome?.advanced_to_runoff ?? []).length > 0 && won.size === 0,
    calledBy,
    calledAt,
    gainedBy: r.outcome?.gained ? nytParty(r.outcome.gained) : null,
    pollClose: null,
    uncontested: !!r.uncontested,
    rating: parseNytRating(r.rating),
    model: ru.nyt_model_estimates?.margin_quantile?.length === 5 ? { quantiles: ru.nyt_model_estimates.margin_quantile } : null,
    baselineMargin: comparison(ru.historical_comparison_race_data).margin,
    ...(r.tabulation_method ? { rcv: r.tabulation_method !== 'single-round' } : {}),
    url: safeUrl(r.url),
    updatedAt: ru.provider_updated_at ?? r.updated_at,
    source: 'NYT/AP',
  };
}

/**
 * The comparison NYT attaches to a reporting unit: the 2024 presidential race when present (keys like
 * "NC-G-P-2024-11-05"), else the seat's own 2024 House race ("MO-G-H-5-2024-11-05"), which NYT uses
 * for districts whose lines didn't change.
 */
function comparison(data: Record<string, { margin?: number }> | undefined): { margin: number | null; kind: 'pres2024' | 'house2024' | null } {
  const entries = Object.entries(data ?? {});
  const pres = entries.find(([k]) => /-P-2024-/.test(k));
  if (pres) return { margin: pres[1].margin ?? null, kind: 'pres2024' };
  const house = entries.find(([k]) => /-H-\d+-2024-/.test(k));
  if (house) return { margin: house[1].margin ?? null, kind: 'house2024' };
  return { margin: entries[0]?.[1].margin ?? null, kind: null };
}

/** Sub-state reporting units (counties, AK state-house districts, county parts of House districts). */
function countyUnits(r: NytRace): CountyUnit[] {
  const units = (r.reporting_units ?? []).filter((u) => u.level !== 'state' && u.level !== 'national');
  const hasCounties = units.some((u) => u.level === 'county');
  if (!hasCounties && units.some((u) => u.level === 'township' && u.fips_county)) return townsToCounties(units);
  return (
    units
      // House files add city / "rest of county" / ward units (Chicago, Detroit, Kansas City,
      // Hartford wards...) that are *subsets* of counties also listed; counting both would double
      // the vote. They carry a county code. Units without one (e.g. "Overseas absentee") are
      // separate pieces and stay.
      .filter((u) => u.level === 'county' || u.level === 'state_house_district' || !(hasCounties && u.fips_county))
      .map((u) => ({
        id: u.nyt_id ?? `${u.state_postal}-${u.name}`,
        // Shape key: county FIPS, or "02HD001"-style for Alaska's state house districts.
        fips:
          u.level === 'county' && u.fips_state && u.fips_county
            ? `${u.fips_state}${u.fips_county}`
            : u.level === 'state_house_district' && u.fips_state && u.fips_suffix
              ? `${u.fips_state}HD${u.fips_suffix}`
              : null,
        name: u.name ?? '?',
        level: u.level,
        eevp: u.eevp ?? null,
        totalVotes: u.total_votes ?? 0,
        expectedVotes: u.total_expected_vote ?? null,
        votes: Object.fromEntries(u.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0])),
        baselineMargin: comparison(u.historical_comparison_race_data).margin,
      }))
  );
}

/**
 * New England House districts in NYT's per-district files come by town only (the national file had
 * county units). Sum the towns into counties (Connecticut: planning regions) so the drill-down map
 * can draw them. Ward / "other" units with a county code are subsets of towns and are dropped;
 * units without one ("Overseas absentee") stay as they are.
 */
function townsToCounties(units: NytRU[]): CountyUnit[] {
  const out = new Map<string, CountyUnit & { w: number; wSum: number; eSum: number; eW: number }>();
  const rest: CountyUnit[] = [];
  for (const u of units) {
    if (u.level !== 'township' || !u.fips_state || !u.fips_county) {
      if (!u.fips_county) rest.push({ id: u.nyt_id ?? `${u.state_postal}-${u.name}`, fips: null, name: u.name ?? '?', level: u.level, eevp: u.eevp ?? null, totalVotes: u.total_votes ?? 0, expectedVotes: u.total_expected_vote ?? null, votes: Object.fromEntries(u.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0])), baselineMargin: comparison(u.historical_comparison_race_data).margin });
      continue;
    }
    const fips = townCounty(u.state_postal, u.fips_state, u.fips_county, u.name ?? '');
    let c = out.get(fips);
    if (!c) {
      c = { id: `${u.state_postal}-county-${fips}`, fips, name: countyLabel(u.state_postal, fips) ?? fips, level: 'county', eevp: null, totalVotes: 0, expectedVotes: 0, votes: {}, baselineMargin: null, w: 0, wSum: 0, eSum: 0, eW: 0 };
      out.set(fips, c);
    }
    const votes = u.total_votes ?? 0;
    const expected = u.total_expected_vote ?? null;
    c.totalVotes += votes;
    c.expectedVotes = c.expectedVotes == null || expected == null ? null : c.expectedVotes + expected;
    for (const cand of u.candidates) c.votes[cand.nyt_id] = (c.votes[cand.nyt_id] ?? 0) + (cand.votes?.total ?? 0);
    // Baseline margin and EEVP: weighted by each town's size (expected vote, else votes counted).
    const weight = expected ?? votes;
    const base = comparison(u.historical_comparison_race_data).margin;
    if (base != null && weight > 0) {
      c.w += weight;
      c.wSum += base * weight;
    }
    if (u.eevp != null && weight > 0) {
      c.eW += weight;
      c.eSum += u.eevp * weight;
    }
  }
  return [
    ...[...out.values()].map(({ w, wSum, eSum, eW, ...c }) => ({ ...c, baselineMargin: w ? +(wSum / w).toFixed(2) : null, eevp: eW ? +(eSum / eW).toFixed(1) : null })),
    ...rest,
  ];
}

/** Store county units for every race in a file/feed that carries them. */
function ingestCounties(races: NytRace[]) {
  const now = new Date().toISOString();
  for (const raw of races) {
    const units = countyUnits(raw);
    if (!units.length) continue;
    const r = normalizeNytRace(raw);
    if (!r) continue;
    // Prefer the general-election contest when a seat has several race types.
    const existing = countyStore.get(r.id);
    if (existing && raw.race_type_id !== 'G' && existing.source === 'NYT/AP (G)') continue;
    const kind = (raw.reporting_units ?? []).map((u) => comparison(u.historical_comparison_race_data).kind).find(Boolean);
    const rc: RaceCounties = { raceId: r.id, updatedAt: now, source: raw.race_type_id === 'G' ? 'NYT/AP (G)' : 'NYT/AP', units };
    if (kind === 'house2024') rc.baseline = 'house2024';
    countyStore.set(rc);
  }
}

/** The county feeds' URLs are listed in the results files' page config; keep the newest seen. */
const countyFeeds: Record<'sen' | 'gov', string> = {
  sen: 'https://static01.nyt.com/elections-assets/pages/data/feeds/67880e0c-9bb4-497c-ac46-cac705cf6270/sen-county-data/2026-11-03.json',
  gov: 'https://static01.nyt.com/elections-assets/pages/data/feeds/11093529-3f1d-454e-aa6e-e63660cac1e7/gov-county-data/2026-11-03.json',
};
function discoverCountyFeeds(file: NytFile) {
  const text = JSON.stringify((file as unknown as { pageConfig?: unknown }).pageConfig ?? {});
  for (const m of text.matchAll(/https:\/\/static01\.nyt\.com\/elections-assets\/pages\/data\/feeds\/[0-9a-f-]+\/(sen|gov)-county-data\/[0-9-]+\.json/g)) {
    countyFeeds[m[1] as 'sen' | 'gov'] = m[0];
  }
}

async function pullCountyFeed(kind: 'sen' | 'gov'): Promise<boolean> {
  const res = await fetchJson<{ data?: NytRace[] }>(countyFeeds[kind], { conditional: true, timeoutMs: 30_000 });
  if (!res.changed) return false;
  ingestCounties(res.data?.data ?? []);
  return true;
}

function normalizeFile(file: NytFile): RaceInput[] {
  const byId = new Map<string, { r: RaceInput; general: boolean }>();
  for (const raw of file.races ?? []) {
    const r = normalizeNytRace(raw);
    if (!r) continue;
    const general = raw.race_type_id === 'G';
    const prev = byId.get(r.id);
    // Prefer the general-election contest if a state has multiple race types for a seat.
    if (!prev || (general && !prev.general)) byId.set(r.id, { r, general });
  }
  if (file.pollClosingTimes?.length) {
    store.setPollClosings(file.pollClosingTimes.map((p) => ({ state: p.reporting_unit.state_postal, time: p.poll_closing_time })));
  }
  const house = file.partyControlData?.results?.[0]?.offices?.H?.current_control;
  if (house) store.setHouseBefore({ D: house.DEM ?? 0, R: house.GOP ?? 0, I: house.OTH ?? 0 });
  return [...byId.values()].map((x) => x.r);
}

async function pull(slug: string, office: Office): Promise<boolean> {
  const res = await fetchJson<NytFile>(`${NYT_BASE}/results-${slug}.json`, { conditional: true, timeoutMs: 30_000 });
  if (!res.changed) {
    store.touch('nyt', [office]);
    return false;
  }
  const races = normalizeFile(res.data!);
  store.ingest({ provider: 'nyt', offices: [office], fetchedAt: Date.now(), races });
  discoverCountyFeeds(res.data!);
  // The House file carried each district's county parts through election night; NYT later strips
  // them (Nov 9, 2026), leaving them only in the per-district files (see pullDistrict).
  if (office === 'H') {
    const races = res.data!.races ?? [];
    houseFileHasCounties = races.some((r) => (r.reporting_units ?? []).some((u) => u.level === 'county'));
    ingestCounties(races);
  }
  return true;
}

// ------------------------------------------------- per-district House files (county parts)
let houseFileHasCounties = true;
const districtFetched = new Map<string, number>();
/** How often to re-check a district's file: often while it's still counting, rarely once done. */
const DISTRICT_RECHECK_COUNTING_MS = 10 * 60_000;
const DISTRICT_RECHECK_DONE_MS = 6 * 60 * 60_000;

/** "results-missouri-us-house-5.json", "results-alaska-us-house-at-large.json". */
function districtUrl(state: string, district: number, atLarge: boolean): string | null {
  const name = STATES.find((s) => s.postal === state)?.name;
  if (!name) return null;
  return `${NYT_BASE}/results-${name.toLowerCase().replace(/\s+/g, '-')}-us-house-${atLarge ? 'at-large' : district}.json`;
}

/**
 * Once the national House file no longer carries county parts, fetch one district's own file per
 * run: districts never fetched first, then ones still counting (every 10 min), then the rest
 * (every 6 h). ETags make unchanged files a 304.
 */
async function pullDistrict(): Promise<string | false> {
  if (houseFileHasCounties) return false;
  const house = [...store.races.values()].filter((r) => r.office === 'H');
  const perState = new Map<string, number>();
  for (const r of house) perState.set(r.state, (perState.get(r.state) ?? 0) + 1);
  const now = Date.now();
  const due = (r: (typeof house)[number]) => {
    const last = districtFetched.get(r.id);
    if (last == null) return -Infinity;
    const counting = r.status !== 'called' || (r.eevp ?? 100) < 99;
    return last + (counting ? DISTRICT_RECHECK_COUNTING_MS : DISTRICT_RECHECK_DONE_MS);
  };
  const next = house.filter((r) => due(r) <= now).sort((a, b) => due(a) - due(b))[0];
  if (!next) return false;
  const url = districtUrl(next.state, next.district ?? 1, perState.get(next.state) === 1);
  districtFetched.set(next.id, now);
  if (!url) return false;
  const res = await fetchJson<NytFile>(url, { conditional: true, timeoutMs: 30_000 });
  if (!res.changed) return false;
  ingestCounties((res.data?.races ?? []).filter((r) => r.office_id === 'H'));
  return `${next.id} · ${[...districtFetched.keys()].length}/${house.length} districts checked`;
}

export function startNyt() {
  const statewide = new Poller({
    id: 'nyt',
    name: 'NYT / AP results',
    role: 'Primary results: Senate + Governor (votes, EEVP, AP calls, ratings)',
    hotIntervalS: config.intervals.nyt.hot,
    coldIntervalS: config.intervals.nyt.cold,
    enabled: config.sources.nyt,
    run: async () => {
      const [s, g] = await Promise.all([pull('senate', 'S'), pull('governor', 'G')]);
      return s || g ? 'updated' : false;
    },
  });
  const house = new Poller({
    id: 'nyt-house',
    name: 'NYT / AP House results',
    role: 'Primary results: 435 House races (~350 KB gzipped)',
    hotIntervalS: config.intervals.nytHouse.hot,
    coldIntervalS: config.intervals.nytHouse.cold,
    enabled: config.sources.nyt,
    initialDelayMs: 2_000,
    run: async () => ((await pull('house', 'H')) ? 'updated' : false),
  });
  const counties = new Poller({
    id: 'nyt-counties',
    name: 'NYT / AP county results',
    role: 'County-level Senate + Governor results for race drill-downs (~170 KB gzipped each)',
    hotIntervalS: config.intervals.nytCounties.hot,
    coldIntervalS: config.intervals.nytCounties.cold,
    enabled: config.sources.nyt,
    initialDelayMs: 6_000,
    run: async () => {
      const [s, g] = await Promise.all([pullCountyFeed('sen'), pullCountyFeed('gov')]);
      return s || g ? `${countyStore.size} races with county data` : false;
    },
  });
  const districts = new Poller({
    id: 'nyt-house-districts',
    name: 'NYT / AP House district files',
    role: "County parts of House districts, one district file at a time, once NYT's national House file stops carrying them",
    hotIntervalS: 4,
    coldIntervalS: 4,
    enabled: config.sources.nyt,
    initialDelayMs: 20_000,
    run: pullDistrict,
  });
  statewide.start();
  house.start();
  counties.start();
  districts.start();
  return [statewide, house, counties, districts];
}
