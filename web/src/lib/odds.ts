import type { Party, Race } from '../../../shared/src/types';
import { forecastFor } from './colors';

const LEVEL_P: Record<string, number> = { solid: 0.97, likely: 0.85, lean: 0.7, tilt: 0.58, tossup: 0.5 };

/**
 * Probability that Democrats (incl. independents that caucus with them, for Senate math)
 * win the seat: Polymarket when available, else the forecast rating mapped to a probability.
 */
export function probD(r: Race): number {
  const bp = r.market?.byParty;
  if (bp && (bp.D != null || bp.R != null)) {
    const d = bp.D ?? 0;
    const rep = bp.R ?? 0;
    const i = bp.I ?? 0;
    // Senate independents (e.g. NE) are treated as non-R for control purposes.
    const dSide = r.office === 'S' ? d + i : d;
    const total = dSide + rep;
    return total > 0 ? dSide / total : 0.5;
  }
  const f = forecastFor(r);
  if (f) {
    const p = LEVEL_P[f.level] ?? 0.5;
    return f.party === 'R' ? 1 - p : f.party ? p : 0.5;
  }
  if (r.priorParty === 'D') return 0.85;
  if (r.priorParty === 'R') return 0.15;
  return 0.5;
}

/** Market (or forecast) favorite and its probability. */
export function favorite(r: Race): { party: Party; p: number } {
  const bp = r.market?.byParty;
  if (bp && Object.keys(bp).length) {
    const [party, p] = (Object.entries(bp) as [Party, number][]).sort((a, b) => b[1] - a[1])[0];
    return { party, p };
  }
  const pd = probD(r);
  return pd >= 0.5 ? { party: 'D', p: pd } : { party: 'R', p: 1 - pd };
}

/** Current party "result" for tallies: winner if called, leader if counting. */
export function currentParty(r: Race): Party | null {
  return r.winner ?? (r.totalVotes > 0 ? r.leader : null);
}

/** Leader is not the market/forecast favorite (with enough vote in to matter). */
export function isUpset(r: Race): boolean {
  const cur = currentParty(r);
  if (!cur) return false;
  const fav = favorite(r);
  if (fav.p < 0.65) return false;
  if (r.winner) return r.winner !== fav.party;
  return (r.eevp ?? 0) >= 15 && cur !== fav.party;
}

/** Leading or called for a party other than the one that held the seat. */
export function isPotentialFlip(r: Race): boolean {
  const cur = currentParty(r);
  return !!cur && !!r.priorParty && cur !== r.priorParty;
}

export const isTossup = (r: Race) => {
  const pd = probD(r);
  return pd >= 0.35 && pd <= 0.65;
};
