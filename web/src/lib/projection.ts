import type { ChamberSummary, Party, PartyCounts, Race, RatingLevel } from '../../../shared/src/types';
import { probToLevel } from '../../../shared/src/ratings';
import type { BopView } from '../components/BalanceOfPower';
import { forecastFor } from './colors';

export type ProjectionMode = 'market' | 'forecast' | 'control';

const STRONG: RatingLevel[] = ['solid', 'likely'];

/** The party and strength a map view assigns to a race (null = toss-up / unknown). */
function assign(r: Race, mode: ProjectionMode): { party: Party; strong: boolean } | null {
  if (mode === 'control') return r.priorParty ? { party: r.priorParty, strong: true } : null;
  if (mode === 'market') {
    const bp = r.market?.byParty;
    if (bp && Object.keys(bp).length) {
      const [party, p] = (Object.entries(bp) as [Party, number][]).sort((a, b) => b[1] - a[1])[0];
      const level = probToLevel(p);
      return level === 'tossup' ? null : { party, strong: STRONG.includes(level) };
    }
    // No market for this race: fall back to the forecast, as the map's market fill does.
  }
  const f = forecastFor(r);
  if (!f || !f.party || f.level === 'tossup') return null;
  return { party: f.party, strong: STRONG.includes(f.level) };
}

/**
 * Seat tally for the Polymarket / FLIPR / Current map views, shaped as a ChamberSummary so the
 * balance-of-power tracker can show it: solid/likely seats render as "won", lean/tilt as
 * hatched "leaning", toss-ups as uncalled. Seats not up this cycle are included as usual.
 */
export function projectionSummary(base: ChamberSummary, races: Race[], mode: ProjectionMode): { summary: ChamberSummary; view: BopView } {
  const won: PartyCounts = { D: 0, R: 0, I: 0 };
  const leading: PartyCounts = { D: 0, R: 0, I: 0 };
  const flips = { toD: 0, toR: 0, toI: 0 };
  let assigned = 0;
  for (const r of races) {
    const a = assign(r, mode);
    if (!a) continue;
    assigned++;
    (a.strong ? won : leading)[a.party]++;
    if (mode !== 'control' && r.priorParty && r.priorParty !== a.party) flips[a.party === 'D' ? 'toD' : a.party === 'R' ? 'toR' : 'toI']++;
  }
  const isSenate = base.office === 'S';
  const dSeats = base.notUp.D + won.D + leading.D + (isSenate ? base.notUp.I + won.I + leading.I : 0);
  const rSeats = base.notUp.R + won.R + leading.R;
  const need = base.office === 'G' ? { D: 26, R: 26 } : base.toControl;
  const pending = base.racesTotal - assigned;
  const summary: ChamberSummary = {
    ...base,
    won,
    leading,
    racesCalled: assigned,
    racesPending: pending,
    flips,
    controlWinner: dSeats >= need.D ? 'D' : rSeats >= need.R ? 'R' : null,
  };
  const tossups = `${pending} toss-up${pending === 1 ? '' : 's'}`;
  const majority = base.office === 'G' ? 'MAJORITY' : 'CONTROL';
  const view: BopView =
    mode === 'market'
      ? { sideNote: 'favored on Polymarket', middle: tossups, badge: 'FAVORED', legend: ['≥75% odds', '53–75%', 'Toss-up'], showMarket: true }
      : mode === 'forecast'
        ? { sideNote: 'FLIPR / Cook', middle: tossups, badge: 'FAVORED', legend: ['Solid / likely', 'Lean / tilt', 'Toss-up'] }
        : { sideNote: 'held before election', middle: pending ? `${pending} unknown` : 'before this election', badge: majority, legend: ['Held', '', 'Unknown'] };
  summary.label = `${base.label} · ${mode === 'market' ? 'Polymarket' : mode === 'forecast' ? 'FLIPR forecast' : 'current holders'}`;
  return { summary, view };
}
