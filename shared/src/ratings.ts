import type { Party, Rating, RatingLevel } from './types.js';

const LEVEL_WORDS: Record<string, RatingLevel> = {
  solid: 'solid',
  safe: 'solid',
  likely: 'likely',
  'very likely': 'likely',
  lean: 'lean',
  leans: 'lean',
  tilt: 'tilt',
  tilts: 'tilt',
  tossup: 'tossup',
  'toss-up': 'tossup',
  'toss up': 'tossup',
};

const LEVEL_LABEL: Record<RatingLevel, string> = {
  solid: 'Solid',
  likely: 'Likely',
  lean: 'Lean',
  tilt: 'Tilt',
  tossup: 'Toss-up',
};

export function makeRating(source: Rating['source'], level: RatingLevel, party: Party | null): Rating {
  const label = level === 'tossup' || !party ? 'Toss-up' : `${LEVEL_LABEL[level]} ${party}`;
  return { source, level, party: level === 'tossup' ? null : party, label };
}

/** Parse "solid-rep", "lean-dem", "tossup" (NYT style). */
export function parseNytRating(raw: string | null | undefined): Rating | undefined {
  if (!raw) return undefined;
  const [lvl, side] = raw.toLowerCase().split('-');
  const level = LEVEL_WORDS[lvl];
  if (!level) return undefined;
  const party: Party | null = side === 'dem' ? 'D' : side === 'rep' ? 'R' : side === 'ind' ? 'I' : null;
  return makeRating('NYT', level, party);
}

/** Parse the args of a Wikipedia {{USRaceRating|Lean|D|flip}} template. */
export function parseWikiRating(source: Rating['source'], args: string[]): Rating | undefined {
  const level = LEVEL_WORDS[(args[0] ?? '').trim().toLowerCase()];
  if (!level) return undefined;
  const p = (args[1] ?? '').trim().toUpperCase();
  const party: Party | null = p === 'D' ? 'D' : p === 'R' ? 'R' : p === 'I' ? 'I' : null;
  return makeRating(source, level, party);
}

/** Numeric strength used for sorting / map shading: 0 = tossup, 4 = solid. */
export const LEVEL_STRENGTH: Record<RatingLevel, number> = {
  tossup: 0,
  tilt: 1,
  lean: 2,
  likely: 3,
  solid: 4,
};

/** Map an implied probability (0-1) for the favored side onto a rating-like level. */
export function probToLevel(p: number): RatingLevel {
  if (p >= 0.9) return 'solid';
  if (p >= 0.75) return 'likely';
  if (p >= 0.6) return 'lean';
  if (p > 0.53) return 'tilt';
  return 'tossup';
}

/** Map a vote margin (pct points) onto a shading level. */
export function marginToLevel(m: number): RatingLevel {
  if (m >= 15) return 'solid';
  if (m >= 7) return 'likely';
  if (m >= 3) return 'lean';
  if (m > 0.5) return 'tilt';
  return 'tossup';
}
