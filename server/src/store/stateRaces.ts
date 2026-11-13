import type { CountyRaceResult, CountySummary, StateCandidate, StateRace, StateRaceKind, StateSummary } from '../../../shared/src/types.js';
import { PLACES, placeKey } from '../geo/places.js';
import { nytParty } from '../sources/nyt.js';
import { countyStore } from './counties.js';
import { store } from './store.js';

/**
 * Every race in a state's NYT/AP results file that the main store doesn't cover: statewide offices
 * (lieutenant governor, attorney general, secretary of state, treasurer, …), state legislature,
 * regional boards, local offices and local measures. Fed by the same state-file poller as ballot
 * measures (sources/ballot.ts), so it adds no upstream requests.
 *
 * Local races arrive as one statewide total with the jurisdiction only in text ("Los Angeles",
 * "Fresno District 1", "Fresno-S - …"); they are placed in counties by matching that text against
 * Census place and county names (server/src/geo/places.json, scripts/build-places.mjs).
 */

/** Raw NYT race, the fields used here. */
export interface NytStateRace {
  nyt_id: string;
  office_id: string;
  office?: string | null;
  seat?: string | null;
  coverage?: string | null;
  long_description?: string | null;
  ballot_measure_text?: string | null;
  uncontested?: boolean;
  url?: string | null;
  updated_at?: string | null;
  candidate_metadata?: Record<string, { nyt_id: string; first_name?: string; last_name: string; incumbent?: boolean; party?: { nyt_id?: string; name?: string } | null }>;
  outcome?: { won?: string[]; called_by?: string[] | null; advanced_to_runoff?: string[] };
  top_reporting_unit?: { state_postal: string; eevp: number | null; total_votes: number; total_expected_vote?: number | null; provider_updated_at?: string | null; candidates: { nyt_id: string; votes: { total: number } }[] };
  reporting_units?: { level: string; fips_state?: string | null; fips_county?: string | null; eevp: number | null; total_votes: number; candidates: { nyt_id: string; votes: { total: number } }[] }[];
}

const countyKey = (name: string) => placeKey(name.replace(/\b(county|parish|census area|city and borough|borough|municipality)\b/gi, ' '));

const countyIndex = new Map<string, Map<string, string>>(); // state -> countyKey -> fips
function countyByName(st: string, name: string): string | null {
  let idx = countyIndex.get(st);
  if (!idx) {
    idx = new Map();
    for (const [fips, n] of Object.entries(PLACES[st]?.counties ?? {})) idx.set(countyKey(n), fips);
    countyIndex.set(st, idx);
  }
  return idx.get(countyKey(name)) ?? null;
}

/** Offices elected by a whole county (as opposed to a city or district within it). */
const COUNTY_OFFICE = /county|sheriff|district attorney|public defender|supervisor|assessor|clerk|coroner|recorder|prosecut|commissioners|parish/i;

/** "Fresno-S - …" → "Fresno"; "Director Oakland District 2" → "Oakland"; "Los Angeles" → "Los Angeles". */
function jurisdiction(seat: string, isMeasure: boolean): string {
  if (isMeasure) {
    // "Fresno-S - …", "Austin A - …", "Honolulu 12 - …"
    const m = seat.match(/^(.+?)-[A-Z0-9]{1,6}\b/) ?? seat.match(/^(.+?)\s+[A-Z0-9]{1,4}\s+-\s/);
    if (m) return m[1].trim();
  }
  return seat
    .replace(/^(director|member|trustee|commissioner|judge|seat|councilmember|council member)\s+/i, '')
    .replace(/\s+(district|dist|ward|seat|position|area|zone|division|department|dept|place|precinct|at[- ]large|subdistrict)\b.*$/i, '')
    .replace(/\s+(chairman|chairwoman|chair|president|mayor)$/i, '')
    .replace(/\s*[,(].*$/, '')
    .trim();
}

/** Exact place name, else the one place whose name starts with it ("Lexington" → "Lexington-Fayette"). */
function placeByName(st: string, name: string): string[] | null {
  const idx = PLACES[st]?.places;
  if (!idx) return null;
  const k = placeKey(name);
  if (!k) return null;
  if (idx[k]) return idx[k];
  if (k.length < 5) return null;
  const hits = Object.keys(idx).filter((x) => x.startsWith(k));
  return hits.length === 1 ? idx[hits[0]] : null;
}

function inferCounties(st: string, office: string, seat: string | null, isMeasure: boolean, text: string): string[] {
  // New York City's charter questions are listed without the city's name ("1 - Streamline …").
  if (st === 'NY' && /city charter/i.test(text)) return PLACES.NY?.places.newyork ?? [];
  if (!seat) return [];
  const name = jurisdiction(seat, isMeasure);
  if (!name) return [];
  const county = countyByName(st, name);
  const place = placeByName(st, name);
  // A county office looks for the county first ("Los Angeles" sheriff = LA County); everything
  // else for the city first ("Los Angeles" mayor = the city, which is in LA County anyway).
  if (COUNTY_OFFICE.test(office) && !/city/i.test(office)) return county ? [county] : (place ?? []);
  return place ?? (county ? [county] : []);
}

function kindOf(r: NytStateRace): StateRaceKind | null {
  if (['S', 'G', 'H'].includes(r.office_id)) return null; // main store
  if (r.office_id === 'I') return r.coverage === 'state' ? null : 'measure'; // statewide measures: MeasureStore
  if (r.office_id === 'SH' || r.office_id === 'SS') return 'legislature';
  if (r.coverage === 'state') return 'statewide';
  if (r.coverage === 'multi-county') return 'district';
  return 'local';
}

function titleOf(kind: StateRaceKind, office: string, seat: string | null, r: NytStateRace): string {
  if (kind === 'measure') {
    const numbered = seat?.match(/^(\d+)\s*-\s/); // NYC: "1 - Streamline …"
    if (numbered) return `${office} ${numbered[1]}`;
    const code = r.ballot_measure_text?.split(':')[0]?.trim(); // "Measure S"
    const place = seat ? jurisdiction(seat, true) : '';
    return [place, code].filter(Boolean).join(' ') || office;
  }
  return seat ? `${office} · ${seat}` : office;
}

interface StateEntry {
  races: StateRace[];
  /** raceId -> county FIPS -> result */
  units: Map<string, Map<string, CountyRaceResult>>;
  updatedAt: string;
}

class StateRaceStore {
  private byState = new Map<string, StateEntry>();

  ingest(st: string, raw: NytStateRace[]) {
    const races: StateRace[] = [];
    const units = new Map<string, Map<string, CountyRaceResult>>();
    for (const r of raw) {
      const kind = kindOf(r);
      const ru = r.top_reporting_unit;
      if (!kind || !ru) continue;
      const office = r.office ?? 'Office';
      const seat = r.seat ?? null;
      const won = new Set(r.outcome?.won ?? []);
      const votes = new Map(ru.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0]));
      const total = ru.total_votes ?? 0;
      const meta = Object.values(r.candidate_metadata ?? {});
      const nonpartisan = kind === 'measure' || meta.every((m) => !m.party?.nyt_id || ['NP', 'NON', 'YES', 'NO'].includes(m.party.nyt_id));
      const candidates: StateCandidate[] = meta
        .map((m) => {
          const v = votes.get(m.nyt_id) ?? 0;
          const pid = m.party?.nyt_id ?? null;
          return {
            id: m.nyt_id,
            name: [m.first_name, m.last_name].filter(Boolean).join(' '),
            party: nonpartisan || !pid ? null : nytParty(pid),
            partyName: m.party?.name ?? (nonpartisan ? 'Nonpartisan' : 'Other'),
            votes: v,
            pct: total > 0 ? +((v / total) * 100).toFixed(2) : 0,
            winner: won.has(m.nyt_id),
            incumbent: !!m.incumbent,
          };
        })
        .sort((a, b) => b.votes - a.votes);
      // County results, where NYT breaks the race down (statewide offices, some districts).
      const cu = new Map<string, CountyRaceResult>();
      for (const u of r.reporting_units ?? []) {
        if (u.level !== 'county' || !u.fips_state || !u.fips_county) continue;
        cu.set(`${u.fips_state}${u.fips_county}`, {
          raceId: r.nyt_id,
          totalVotes: u.total_votes ?? 0,
          eevp: u.eevp ?? null,
          votes: Object.fromEntries(u.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0])),
        });
      }
      if (cu.size) units.set(r.nyt_id, cu);
      let counties: string[] = [];
      let countySource: StateRace['countySource'] = 'unknown';
      if (kind === 'statewide') countySource = 'statewide';
      else if (cu.size) {
        counties = [...cu.keys()];
        countySource = 'results';
      } else if (kind === 'local' || kind === 'measure') {
        counties = inferCounties(st, office, seat, kind === 'measure', `${r.long_description ?? ''} ${r.ballot_measure_text ?? ''}`);
        if (counties.length) countySource = 'name';
      }
      const measureText = r.ballot_measure_text?.split(':').slice(1).join(':').trim();
      races.push({
        id: r.nyt_id,
        state: st,
        kind,
        office,
        seat,
        title: titleOf(kind, office, seat, r),
        description: kind === 'measure' ? r.long_description || measureText || seat?.split(' - ').slice(1).join(' - ') || null : null,
        candidates,
        totalVotes: total,
        expectedVotes: ru.total_expected_vote ?? null,
        eevp: ru.eevp ?? null,
        called: won.size > 0,
        calledBy: won.size ? (r.outcome?.called_by ?? ['ap']).join('/').toUpperCase() : null,
        runoff: (r.outcome?.advanced_to_runoff ?? []).length > 0 && won.size === 0,
        uncontested: !!r.uncontested,
        nonpartisan,
        counties,
        countySource,
        hasCountyResults: cu.size > 0,
        url: r.url ? `https://www.nytimes.com${r.url.startsWith('/') ? '' : '/'}${r.url.replace(/^https?:\/\/www\.nytimes\.com/, '')}` : null,
        updatedAt: ru.provider_updated_at ?? r.updated_at ?? null,
      });
    }
    this.byState.set(st, { races, units, updatedAt: new Date().toISOString() });
  }

  summary(st: string): StateSummary {
    const e = this.byState.get(st);
    const counties = Object.entries(PLACES[st]?.counties ?? {})
      .map(([fips, name]) => ({ fips, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { state: st, published: !!e, updatedAt: e?.updatedAt ?? null, counties, races: e?.races ?? [] };
  }

  /** County-by-county results of one statewide / districted race (for the state map). */
  raceCounties(st: string, raceId: string): Record<string, CountyRaceResult> | null {
    const u = this.byState.get(st)?.units.get(raceId);
    return u ? Object.fromEntries(u) : null;
  }

  county(st: string, fips: string): CountySummary | null {
    const name = PLACES[st]?.counties[fips];
    if (!name) return null;
    const e = this.byState.get(st);
    const stateRaces: CountySummary['stateRaces'] = [];
    const local: StateRace[] = [];
    for (const r of e?.races ?? []) {
      const result = e?.units.get(r.id)?.get(fips) ?? null;
      if (r.kind === 'local' || r.kind === 'measure') {
        if (r.counties.includes(fips)) local.push(r);
      } else if (r.kind === 'statewide' || result) stateRaces.push({ race: r, result });
    }
    // Senate, governor and House races from the main feed, where this county reports.
    const main: CountySummary['main'] = [];
    for (const race of store.races.values()) {
      if (race.state !== st) continue;
      const unit = countyStore.get(race.id)?.units.find((u) => u.fips === fips);
      if (unit) main.push({ raceId: race.id, result: { raceId: race.id, totalVotes: unit.totalVotes, eevp: unit.eevp, votes: unit.votes } });
    }
    return { state: st, fips, name, stateRaces, local, main };
  }
}

export const stateRaceStore = new StateRaceStore();
