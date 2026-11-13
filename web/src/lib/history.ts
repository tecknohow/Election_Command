import type { Candidate, Race } from '../../../shared/src/types';
import raw from '../../../shared/src/history.json';

/**
 * Previous results for each 2026 race and national baselines (built by scripts/build-history.mjs
 * from CNN's past results files, Census district lines and Wikipedia). Margins are D minus R in
 * percentage points (positive = Democratic).
 */
export interface PrevSide {
  name: string;
  pct: number | null;
}
export interface PrevResult {
  year: number;
  label: string;
  margin: number | null;
  /** DR = a D and an R ran; DD/RR = same-party top-two; *-unopposed; D-noR/R-noD = no major opponent. */
  kind: string;
  d: PrevSide | null;
  r: PrevSide | null;
  /** An independent stood in for this side's missing party (opposite the major-party candidate). */
  indep?: 'D' | 'R';
  winner: { name: string; party: string | null } | null;
  /** House only: the district's lines changed after 2024, so the 2024 House result is on old lines. */
  linesChanged?: boolean;
}
interface VoteTotals {
  D: number;
  R: number;
  total: number;
  margin: number;
}
export interface Midterm {
  year: number;
  presParty: 'D' | 'R';
  houseSeatChange: number | null;
  senateSeatChange: number | null;
  houseMargin: number | null;
  prevHouseMargin: number | null;
}
interface History {
  generated: string;
  senate: Record<string, PrevResult>;
  governor: Record<string, PrevResult>;
  house2024: Record<string, Omit<PrevResult, 'year' | 'label'>>;
  houseVote: Record<'2022' | '2024', { national: VoteTotals; byState: Record<string, VoteTotals> }>;
  pres2024: { national: VoteTotals; byState: Record<string, number | null>; byRace: Record<string, number | null> };
  midterms: Midterm[];
  linesChangedStates: string[];
}

export const HISTORY = raw as unknown as History;

/** The previous contest for the same seat: 2024 House, the seat's last Senate race, the last governor's race. */
export function prevFor(race: Pick<Race, 'id' | 'office'>): PrevResult | null {
  if (race.office === 'S') return HISTORY.senate[race.id] ?? null;
  if (race.office === 'G') return HISTORY.governor[race.id] ?? null;
  const h = HISTORY.house2024[race.id];
  return h ? { year: 2024, label: h.linesChanged ? '2024 (old lines)' : '2024', ...h } : null;
}

/** 2024 presidential margin within the race's 2026 boundaries (state, or district on its new lines). */
export function pres2024For(race: Pick<Race, 'id'>): number | null {
  return HISTORY.pres2024.byRace[race.id] ?? null;
}

/** "D+6.5" / "R+8.1" / "Even". */
export function fmtLean(m: number | null | undefined, digits = 1): string {
  if (m == null || !Number.isFinite(m)) return '—';
  const r = +m.toFixed(digits);
  if (r === 0) return 'Even';
  return `${r > 0 ? 'D' : 'R'}+${Math.abs(r).toFixed(digits)}`;
}
export const leanParty = (m: number | null | undefined): 'D' | 'R' | null => (m == null || m === 0 ? null : m > 0 ? 'D' : 'R');

/** Short text for a previous result that has no D-vs-R margin. */
export function prevText(p: PrevResult | null, short = false): string {
  if (!p) return '—';
  if (p.margin != null) return fmtLean(p.margin);
  switch (p.kind) {
    case 'DD':
      return 'D vs D';
    case 'RR':
      return 'R vs R';
    case 'D-unopposed':
      return short ? 'D unopp.' : 'D unopposed';
    case 'R-unopposed':
      return short ? 'R unopp.' : 'R unopposed';
    case 'D-noR':
      return short ? 'D, no R' : 'D, no GOP opponent';
    case 'R-noD':
      return short ? 'R, no D' : 'R, no Dem opponent';
    case 'new':
      return short ? 'new' : 'new district';
    default:
      return '—';
  }
}

const INDEPENDENT = /independ|non-?partisan|no party|unaffiliated|unenrolled|no (party )?preference/i;
/** An independent / nonpartisan candidate (not a minor party like Libertarian or Green). */
export function isIndependent(c: Candidate): boolean {
  return c.party !== 'D' && c.party !== 'R' && (c.party === 'I' || INDEPENDENT.test(c.partyName));
}

/**
 * Independents reported to caucus with a party, by race id and last name. Anyone not listed is
 * treated as the opposite party of the major-party candidate they're up against.
 */
const KNOWN_CAUCUS: Record<string, 'D' | 'R'> = {};

/**
 * The two candidates a race's margins and shifts compare, as the D side and the R side. Usually
 * the top Democrat and top Republican; but when an independent is one of the top two (AK's
 * at-large House seat, Nebraska's Senate race) or stands in for a missing party, they take the
 * side of the party they caucus with, else the side opposite the major-party candidate they face.
 * Otherwise a minor-party candidate in third place would set the margin.
 */
export function sides(race: Pick<Race, 'id' | 'candidates' | 'totalVotes'>): { d: Candidate | undefined; r: Candidate | undefined; standIn: 'd' | 'r' | null } {
  const d = race.candidates.find((c) => c.party === 'D');
  const r = race.candidates.find((c) => c.party === 'R');
  const ranked = [...race.candidates].sort((a, b) => b.votes - a.votes);
  const ind = ranked.find(isIndependent);
  if (ind) {
    const topTwo = race.totalVotes > 0 ? ranked.slice(0, 2) : [];
    // The major-party candidate the independent is compared with.
    const vs = !d ? r : !r ? d : topTwo.includes(ind) ? topTwo.find((c) => c !== ind && (c.party === 'D' || c.party === 'R')) : undefined;
    if (vs) {
      const side = KNOWN_CAUCUS[`${race.id}:${ind.lastName}`] ?? (vs.party === 'D' ? 'R' : 'D');
      if (side !== vs.party) return side === 'D' ? { d: ind, r: vs, standIn: 'd' } : { d: vs, r: ind, standIn: 'r' };
    }
  }
  return { d, r, standIn: null };
}

/** Tonight's D-minus-R margin (D side vs R side share of all votes; see sides()), or null without both / without votes. */
export function dMargin(race: Race): number | null {
  if (!race.totalVotes) return null;
  const { d, r } = sides(race);
  if (!d || !r) return null;
  const total = race.candidates.reduce((s, c) => s + c.votes, 0) || race.totalVotes;
  return ((d.votes - r.votes) / total) * 100;
}

/** Swing (tonight minus baseline), only once enough of the vote is in to mean something. */
export function swing(race: Race, baseline: number | null, minEevp = 20): number | null {
  const now = dMargin(race);
  if (now == null || baseline == null || (race.eevp ?? 0) < minEevp) return null;
  return now - baseline;
}
