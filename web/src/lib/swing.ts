import type { Race } from '../../../shared/src/types';
import { dMargin, HISTORY, pres2024For, prevFor } from './history';

/**
 * Swing arithmetic for the Swing dashboard. All margins are D minus R in points; a positive
 * swing is a move toward Democrats.
 *
 * Two kinds of comparison:
 *  - Raw totals (tonight's national House vote vs 2022/2024). Easy to read but biased while
 *    the count is partial: whichever states have counted most dominate the total.
 *  - Like-for-like: each district (or state) compared with its own baseline, then averaged,
 *    weighted by votes counted. Partial counts don't bias it, so it's the honest early read.
 */

export interface Totals {
  D: number;
  R: number;
  other: number;
  total: number;
  expected: number;
  margin: number | null;
  counted: number;
}

function totals(races: Race[]): Totals {
  let D = 0;
  let R = 0;
  let other = 0;
  let expected = 0;
  for (const r of races) {
    expected += r.expectedVotes ?? 0;
    for (const c of r.candidates) {
      if (c.party === 'D') D += c.votes;
      else if (c.party === 'R') R += c.votes;
      else other += c.votes;
    }
  }
  const total = D + R + other;
  return { D, R, other, total, expected, margin: total ? ((D - R) / total) * 100 : null, counted: expected ? Math.min(100, (total / expected) * 100) : 0 };
}

export function houseVote(races: Race[]): Totals {
  return totals(races.filter((r) => r.office === 'H'));
}

/** Tonight's House vote by state. */
export function houseVoteByState(races: Race[]): Record<string, Totals> {
  const by: Record<string, Race[]> = {};
  for (const r of races) if (r.office === 'H') (by[r.state] ??= []).push(r);
  return Object.fromEntries(Object.entries(by).map(([st, list]) => [st, totals(list)]));
}

export interface LikeForLike {
  swing: number | null;
  n: number;
  votes: number;
}

/** Vote-weighted mean of (tonight - baseline) across races with enough counted. */
export function likeForLike(races: Race[], baseline: (r: Race) => number | null, minEevp = 50): LikeForLike {
  let w = 0;
  let s = 0;
  let n = 0;
  for (const r of races) {
    if ((r.eevp ?? 0) < minEevp) continue;
    const now = dMargin(r);
    const base = baseline(r);
    if (now == null || base == null) continue;
    w += r.totalVotes;
    s += (now - base) * r.totalVotes;
    n++;
  }
  return { swing: w ? s / w : null, n, votes: w };
}

export type Baseline = 'pres24' | 'house24' | 'house22';
export const BASELINE_LABEL: Record<Baseline, string> = { pres24: '2024 president', house24: '2024 House vote', house22: '2022 House vote' };

/** The national figure each baseline compares against. */
export function nationalBaseline(b: Baseline): number {
  if (b === 'pres24') return HISTORY.pres2024.national.margin;
  return HISTORY.houseVote[b === 'house24' ? '2024' : '2022'].national.margin;
}

/** A state's baseline under each comparison. */
export function stateBaseline(st: string, b: Baseline): number | null {
  if (b === 'pres24') return HISTORY.pres2024.byState[st] ?? null;
  return HISTORY.houseVote[b === 'house24' ? '2024' : '2022'].byState[st]?.margin ?? null;
}

/** State House-vote swing vs a baseline, once enough of the state has counted. */
export function stateSwings(races: Race[], b: Baseline, minCounted = 30): Record<string, { swing: number; now: number; base: number; counted: number }> {
  const out: Record<string, { swing: number; now: number; base: number; counted: number }> = {};
  for (const [st, t] of Object.entries(houseVoteByState(races))) {
    const base = stateBaseline(st, b);
    if (t.margin == null || base == null || t.counted < minCounted) continue;
    out[st] = { swing: t.margin - base, now: t.margin, base, counted: t.counted };
  }
  return out;
}

export type Office = 'H' | 'S' | 'G';
export const OFFICE_LABEL: Record<Office, string> = { H: 'House', S: 'Senate', G: 'Governor' };

/**
 * Like-for-like baselines for any race: the 2024 presidential margin inside today's boundaries,
 * or the seat's previous result (House: 2024 on unchanged lines; Senate: the seat's last race;
 * Governor: the last governor's race), only when that was a D-vs-R contest.
 */
export type RaceBaseline = 'pres24' | 'last';
export const raceBaseline: Record<RaceBaseline, (r: Race) => number | null> = {
  pres24: (r) => pres2024For(r),
  last: (r) => {
    const p = prevFor(r);
    return p && !p.linesChanged && p.kind === 'DR' ? p.margin : null;
  },
};
/** House names for the same two baselines (used by the tiles and movers). */
export const districtBaseline: Record<'pres24' | 'house24', (r: Race) => number | null> = { pres24: raceBaseline.pres24, house24: raceBaseline.last };

/** Senate or governor shift by state (one race per state), once enough of it is counted. */
export function raceSwingsByState(
  races: Race[],
  office: 'S' | 'G',
  b: RaceBaseline,
  minEevp = 30,
): Record<string, { swing: number; now: number; base: number; counted: number; race: Race }> {
  const out: Record<string, { swing: number; now: number; base: number; counted: number; race: Race }> = {};
  for (const r of races) {
    if (r.office !== office || (r.eevp ?? 0) < minEevp) continue;
    const now = dMargin(r);
    const base = raceBaseline[b](r);
    if (now == null || base == null) continue;
    const prev = out[r.state];
    if (prev && prev.race.totalVotes >= r.totalVotes) continue;
    out[r.state] = { swing: now - base, now, base, counted: r.eevp ?? 0, race: r };
  }
  return out;
}

/**
 * Projected seat change for a party: seats it has won or currently leads that another party held
 * going in, minus its own seats won or led by someone else. Races with no votes yet count for
 * nobody, so (unlike "seats now minus seats before") this doesn't read as a loss for both parties
 * early in the night.
 */
export function netSeatChange(races: Race[], office: Office, party: 'D' | 'R', calledOnly = false): { change: number; decided: number } | null {
  let change = 0;
  let decided = 0;
  for (const r of races) {
    if (r.office !== office || !r.priorParty) continue;
    const now = r.winner ?? (!calledOnly && r.totalVotes > 0 ? r.leader : null);
    if (!now) continue;
    decided++;
    if (now === party && r.priorParty !== party) change++;
    else if (r.priorParty === party && now !== party) change--;
  }
  return decided ? { change, decided } : null;
}

/** Swing against the president's party in House vote: positive = toward the out-party. */
export function swingAgainstPresident(midtermMargin: number, prevMargin: number, presParty: 'D' | 'R'): number {
  const delta = midtermMargin - prevMargin; // + = toward D
  return presParty === 'R' ? delta : -delta;
}
