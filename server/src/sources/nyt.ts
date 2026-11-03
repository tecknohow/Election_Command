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
import type { Candidate, CountyUnit, Office, Party } from '../../../shared/src/types.js';
import { parseNytRating } from '../../../shared/src/ratings.js';
import { OFFICE_LABEL, raceId } from '../../../shared/src/states.js';
import { config, NYT_BASE } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { Poller } from '../lib/poller.js';
import { store } from '../store/store.js';
import type { RaceInput } from '../store/types.js';
import { safeUrl } from '../lib/safe.js';
import { countyStore } from '../store/counties.js';

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
    baselineMargin: Object.values(ru.historical_comparison_race_data ?? {})[0]?.margin ?? null,
    ...(r.tabulation_method ? { rcv: r.tabulation_method !== 'single-round' } : {}),
    url: safeUrl(r.url),
    updatedAt: ru.provider_updated_at ?? r.updated_at,
    source: 'NYT/AP',
  };
}

/** Sub-state reporting units (counties, AK state-house districts, county parts of House districts). */
function countyUnits(r: NytRace): CountyUnit[] {
  const units = (r.reporting_units ?? []).filter((u) => u.level !== 'state' && u.level !== 'national');
  const hasCounties = units.some((u) => u.level === 'county');
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
        baselineMargin: Object.values(u.historical_comparison_race_data ?? {})[0]?.margin ?? null,
      }))
  );
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
    countyStore.set({ raceId: r.id, updatedAt: now, source: raw.race_type_id === 'G' ? 'NYT/AP (G)' : 'NYT/AP', units });
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
  // The House file already carries each district's county parts.
  if (office === 'H') ingestCounties(res.data!.races ?? []);
  return true;
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
  statewide.start();
  house.start();
  counties.start();
  return [statewide, house, counties];
}
