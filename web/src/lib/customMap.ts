import { create } from 'zustand';
import type { ChamberSummary, Office, Party, Race } from '../../../shared/src/types';
import { marginToLevel, probToLevel } from '../../../shared/src/ratings';
import { CUSTOM_BY_CODE, codeFor, forecastFor } from './colors';

/**
 * "Build your own map" state: per office, raceId -> rating code. Saved in localStorage so it
 * survives reloads (a per-viewer convenience), and exportable as a share link (?my=...).
 */
type Maps = Record<Office, Record<string, string>>;

const KEY = 'ec-custom-maps-v1';

function load(): Maps {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { S: {}, G: {}, H: {}, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { S: {}, G: {}, H: {} };
}

function save(m: Maps) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}

interface CustomState {
  maps: Maps;
  brush: string;
  setBrush: (code: string) => void;
  paint: (office: Office, raceId: string, code: string | null) => void;
  replace: (office: Office, map: Record<string, string>) => void;
}

export const useCustomMaps = create<CustomState>((set) => ({
  maps: load(),
  brush: 'a',
  setBrush: (brush) => set({ brush }),
  paint: (office, raceId, code) =>
    set((s) => {
      const m = { ...s.maps[office] };
      if (code) m[raceId] = code;
      else delete m[raceId];
      const maps = { ...s.maps, [office]: m };
      save(maps);
      return { maps };
    }),
  replace: (office, map) =>
    set((s) => {
      const maps = { ...s.maps, [office]: map };
      save(maps);
      return { maps };
    }),
}));

// Keep custom maps in sync across windows/monitors (same browser profile).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) useCustomMaps.setState({ maps: load() });
  });
}

export type SeedSource = 'blank' | 'forecast' | 'market' | 'results' | 'control';

export const SEED_LABEL: Record<SeedSource, string> = {
  blank: 'Blank map',
  forecast: 'FLIPR / Cook forecast',
  market: 'Polymarket odds',
  results: 'Live results',
  control: 'Current holders',
};

export function seedMap(source: SeedSource, races: Race[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of races) {
    let code: string | null = null;
    if (source === 'forecast') {
      const f = forecastFor(r);
      if (f) code = codeFor(f.party, f.level);
    } else if (source === 'market') {
      const bp = r.market?.byParty;
      if (bp && Object.keys(bp).length) {
        const [p, v] = (Object.entries(bp) as [Party, number][]).sort((a, b) => b[1] - a[1])[0];
        code = codeFor(p, probToLevel(v));
      } else {
        const f = forecastFor(r); // fall back to the forecast where no market exists
        if (f) code = codeFor(f.party, f.level);
      }
    } else if (source === 'results') {
      if (r.winner) code = codeFor(r.winner, 'solid');
      else if (r.leader && r.totalVotes > 0) code = codeFor(r.leader, marginToLevel(r.margin ?? 0));
    } else if (source === 'control') {
      if (r.priorParty) code = codeFor(r.priorParty, 'solid');
    }
    if (code) out[r.id] = code;
  }
  return out;
}

/** Encode a map as one character per race (sorted ids), '-' for unassigned. */
export function encodeMap(map: Record<string, string>, raceIds: string[]): string {
  return [...raceIds].sort().map((id) => map[id] ?? '-').join('');
}

export function decodeMap(encoded: string, raceIds: string[]): Record<string, string> {
  const ids = [...raceIds].sort();
  const out: Record<string, string> = {};
  ids.forEach((id, i) => {
    const c = encoded[i];
    if (c && CUSTOM_BY_CODE[c]) out[id] = c;
  });
  return out;
}

/** Seat tally for a custom map, expressed as a ChamberSummary so BalanceOfPower can render it. */
export function customSummary(base: ChamberSummary, races: Race[], map: Record<string, string>): ChamberSummary {
  const won = { D: 0, R: 0, I: 0 };
  const flips = { toD: 0, toR: 0, toI: 0 };
  let assigned = 0;
  for (const r of races) {
    const rating = CUSTOM_BY_CODE[map[r.id]];
    if (!rating?.party) continue;
    assigned++;
    won[rating.party]++;
    if (r.priorParty && r.priorParty !== rating.party) flips[rating.party === 'D' ? 'toD' : rating.party === 'R' ? 'toR' : 'toI']++;
  }
  const dSeats = base.notUp.D + won.D + (base.office === 'S' ? base.notUp.I + won.I : 0);
  const rSeats = base.notUp.R + won.R;
  const need = base.office === 'G' ? { D: 26, R: 26 } : base.toControl;
  return {
    ...base,
    label: `${base.label} · your map`,
    won,
    leading: { D: 0, R: 0, I: 0 },
    racesCalled: assigned,
    racesPending: base.racesTotal - assigned,
    flips,
    controlWinner: dSeats >= need.D ? 'D' : rSeats >= need.R ? 'R' : null,
    market: undefined,
  };
}
