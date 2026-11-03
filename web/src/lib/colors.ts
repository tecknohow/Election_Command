import type { Party, Race, RatingLevel } from '../../../shared/src/types';
import { LEVEL_STRENGTH, marginToLevel, probToLevel } from '../../../shared/src/ratings';

/**
 * Party palette, validated for the dark surface (#0b0e14) with the dataviz palette validator:
 * lightness band, chroma floor, CVD separation (worst ΔE 19.3) and 3:1 contrast all pass.
 * Ramps step from near-surface (weak) to the full party color (strong) so that on a dark
 * map the strongest ratings are also the most luminous.
 */
export const PARTY_COLOR: Record<Party, string> = { D: '#4d8ef7', R: '#f0545a', I: '#9c74d9' };

export const RAMP: Record<Party, Record<Exclude<RatingLevel, 'tossup'>, string>> = {
  D: { tilt: '#2c3d5e', lean: '#34558f', likely: '#3f6fc4', solid: '#4d8ef7' },
  R: { tilt: '#5a2e36', lean: '#87393f', likely: '#bb464d', solid: '#f0545a' },
  I: { tilt: '#43375e', lean: '#5e4a8a', likely: '#7d5fb4', solid: '#9c74d9' },
};

export const NEUTRAL = {
  tossup: '#7a7e8c',
  noRace: '#10141c',
  upcoming: '#2a3346',
  closed: '#36405a',
  noData: '#252d3d',
};

/** Ballot-measure outcome colors (validated pair; never shown without a YES/NO label). */
export const MEASURE_COLOR = { yes: '#26a08c', no: '#c97a26' };

export const PARTY_NAME: Record<Party, string> = { D: 'Democrat', R: 'Republican', I: 'Independent' };

export function levelColor(party: Party | null, level: RatingLevel): string {
  if (!party || level === 'tossup') return NEUTRAL.tossup;
  return RAMP[party][level];
}

export type FillMode = 'leader' | 'market' | 'forecast' | 'control' | 'custom';

export const FILL_MODES: { id: FillMode; label: string; short: string }[] = [
  { id: 'leader', label: 'Results: vote leader and called races', short: 'Results' },
  { id: 'market', label: 'Polymarket odds', short: 'Polymarket' },
  { id: 'forecast', label: 'FLIPR forecast (Cook fallback)', short: 'FLIPR' },
  { id: 'control', label: 'Current: party holding the seat before this election', short: 'Current' },
  { id: 'custom', label: 'Build your own map: click to paint', short: 'My map' },
];

// ------------------------------------------------------------------ custom ("build your own") map

/** One-letter codes keep shareable URLs short. */
export interface CustomRating {
  code: string;
  label: string;
  short: string;
  party: Party | null;
  level: RatingLevel;
  fill: string;
}

export const CUSTOM_RATINGS: CustomRating[] = [
  { code: 'a', label: 'Safe D', short: 'Safe', party: 'D', level: 'solid', fill: RAMP.D.solid },
  { code: 'b', label: 'Likely D', short: 'Likely', party: 'D', level: 'likely', fill: RAMP.D.likely },
  { code: 'c', label: 'Lean D', short: 'Lean', party: 'D', level: 'lean', fill: RAMP.D.lean },
  { code: 'd', label: 'Tilt D', short: 'Tilt', party: 'D', level: 'tilt', fill: RAMP.D.tilt },
  { code: 't', label: 'Toss-up', short: 'Toss-up', party: null, level: 'tossup', fill: NEUTRAL.tossup },
  { code: 'e', label: 'Tilt R', short: 'Tilt', party: 'R', level: 'tilt', fill: RAMP.R.tilt },
  { code: 'f', label: 'Lean R', short: 'Lean', party: 'R', level: 'lean', fill: RAMP.R.lean },
  { code: 'g', label: 'Likely R', short: 'Likely', party: 'R', level: 'likely', fill: RAMP.R.likely },
  { code: 'h', label: 'Safe R', short: 'Safe', party: 'R', level: 'solid', fill: RAMP.R.solid },
  { code: 'i', label: 'Independent', short: 'Ind.', party: 'I', level: 'solid', fill: RAMP.I.solid },
];
export const CUSTOM_BY_CODE: Record<string, CustomRating> = Object.fromEntries(CUSTOM_RATINGS.map((r) => [r.code, r]));

/** Rating code for a party + level (used when seeding a custom map from a data layer). */
export function codeFor(party: Party | null, level: RatingLevel): string {
  if (!party || level === 'tossup') return 't';
  if (party === 'I') return 'i';
  return CUSTOM_RATINGS.find((r) => r.party === party && r.level === level)?.code ?? 't';
}

// ------------------------------------------------------------------ fills

export interface FillResult {
  fill: string;
  /** Use a hatch overlay (leading, not yet called). */
  hatch?: Party | null;
  /** Short annotation shown in the legend/hover. */
  note?: string;
}

/** Best available forecast rating; House seats not on the competitive list are implicitly safe. */
export function forecastFor(race: Race): { party: Party | null; level: RatingLevel; label: string; source: string } | null {
  const r = race.forecast.flipr ?? race.forecast.cook ?? race.forecast.nyt;
  if (r) return { party: r.party, level: r.level, label: r.label, source: r.source };
  if (race.office === 'H' && race.priorParty) return { party: race.priorParty, level: 'solid', label: `Safe ${race.priorParty}`, source: 'Not rated competitive' };
  return null;
}

export function raceFill(race: Race | undefined, mode: FillMode, custom?: Record<string, string>): FillResult {
  if (!race) return { fill: NEUTRAL.noRace };
  switch (mode) {
    case 'leader': {
      if (race.winner) return { fill: RAMP[race.winner].solid, note: 'Called' };
      if (race.leader && race.totalVotes > 0) {
        const lvl = marginToLevel(race.margin ?? 0);
        const capped = LEVEL_STRENGTH[lvl] > LEVEL_STRENGTH.lean ? 'lean' : lvl === 'tossup' ? 'tilt' : lvl;
        return { fill: RAMP[race.leader][capped], hatch: race.leader, note: 'Leading' };
      }
      if (race.status === 'closed') return { fill: NEUTRAL.closed, note: 'Polls closed' };
      return { fill: NEUTRAL.upcoming, note: 'Polls open' };
    }
    case 'market': {
      const bp = race.market?.byParty;
      if (!bp || !Object.keys(bp).length) return { fill: NEUTRAL.noData, note: 'No market' };
      const [party, p] = (Object.entries(bp) as [Party, number][]).sort((a, b) => b[1] - a[1])[0];
      return { fill: levelColor(party, probToLevel(p)) };
    }
    case 'forecast': {
      const f = forecastFor(race);
      if (!f) return { fill: NEUTRAL.noData, note: 'No forecast' };
      return { fill: levelColor(f.party, f.level) };
    }
    case 'control': {
      if (!race.priorParty) return { fill: NEUTRAL.noData, note: 'Unknown' };
      return { fill: RAMP[race.priorParty].likely };
    }
    case 'custom': {
      const code = custom?.[race.id];
      return code && CUSTOM_BY_CODE[code] ? { fill: CUSTOM_BY_CODE[code].fill } : { fill: NEUTRAL.upcoming, note: 'Unassigned' };
    }
  }
}

/** Pick readable label ink for a given fill. */
export function inkFor(fill: string): string {
  const h = fill.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? '#0b0e14' : '#f3f5f9';
}
