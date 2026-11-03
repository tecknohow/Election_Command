import type { Party, PartyCounts } from '../../../shared/src/types.js';

/**
 * Static fallback data for "who held the seat before the election".
 * The live source for this is Wikipedia's 2026 predictions tables (incumbent party shading);
 * these values are only used when Wikipedia can't be reached or a row fails to parse.
 * Verified against NYT race metadata (incumbent flags) on 2026-11-02.
 */

/** 2026 Senate races (33 Class II + FL & OH specials) -> party holding the seat. */
export const SENATE_PRIOR: Record<string, Party> = {
  AL: 'R', AK: 'R', AR: 'R', CO: 'D', DE: 'D', FL: 'R', GA: 'D', ID: 'R', IL: 'D', IA: 'R',
  KS: 'R', KY: 'R', LA: 'R', ME: 'R', MA: 'D', MI: 'D', MN: 'D', MS: 'R', MT: 'R', NE: 'R',
  NH: 'D', NJ: 'D', NM: 'D', NC: 'R', OH: 'R', OK: 'R', OR: 'D', RI: 'D', SC: 'R', SD: 'R',
  TN: 'R', TX: 'R', VA: 'D', WV: 'R', WY: 'R',
};

/** Senate seats NOT up in 2026. Independents (King, Sanders) caucus with Democrats. */
export const SENATE_NOT_UP: PartyCounts = { D: 32, R: 31, I: 2 };
export const SENATE_BEFORE: PartyCounts = { D: 45, R: 53, I: 2 };

/** 2026 governor races -> party holding the office. */
export const GOV_PRIOR: Record<string, Party> = {
  AL: 'R', AK: 'R', AZ: 'D', AR: 'R', CA: 'D', CO: 'D', CT: 'D', FL: 'R', GA: 'R', HI: 'D',
  ID: 'R', IL: 'D', IA: 'R', KS: 'D', ME: 'D', MD: 'D', MA: 'D', MI: 'D', MN: 'D', NE: 'R',
  NV: 'R', NH: 'R', NM: 'D', NY: 'D', OH: 'R', OK: 'R', OR: 'D', PA: 'D', RI: 'D', SC: 'R',
  SD: 'R', TN: 'R', TX: 'R', VT: 'R', WI: 'D', WY: 'R',
};

/** Governors not on the ballot in 2026 (incl. the 2025 VA/NJ winners). */
export const GOV_NOT_UP_STATES: Record<string, Party> = {
  DE: 'D', IN: 'R', KY: 'D', LA: 'R', MS: 'R', MO: 'R', MT: 'R', NJ: 'D', NC: 'D', ND: 'R',
  UT: 'R', VA: 'D', WA: 'D', WV: 'R',
};

export const GOV_BEFORE: PartyCounts = { D: 24, R: 26, I: 0 };

/** Fallback only; NYT's partyControlData.current_control for the House is preferred. */
export const HOUSE_BEFORE: PartyCounts = { D: 213, R: 220, I: 0 };

export function countParties(m: Record<string, Party>): PartyCounts {
  const c: PartyCounts = { D: 0, R: 0, I: 0 };
  for (const p of Object.values(m)) c[p]++;
  return c;
}
