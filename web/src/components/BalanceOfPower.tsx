import type { ChamberSummary, Party } from '../../../shared/src/types';
import { PARTY_COLOR, RAMP } from '../lib/colors';
import { fmtProb } from '../lib/format';

/** Wording for non-live tallies (custom map, Polymarket / FLIPR / current-holder views). */
export interface BopView {
  /** Under each side's number, e.g. "favored", "your map". */
  sideNote: string;
  /** Middle text when no side has a majority, e.g. "4 toss-ups". */
  middle: string;
  /** Badge suffix when a side reaches the threshold, e.g. "FAVORED", "CONTROL". */
  badge: string;
  /** Legend / segment labels for [won, leading, pending]; an empty string hides that entry. */
  legend: [string, string, string];
  /** Show the Polymarket chamber odds line. */
  showMarket?: boolean;
}

interface Seg {
  key: string;
  n: number;
  color: string;
  hatch?: Party;
  label: string;
}

/**
 * Seat bar: Democrats (+ caucusing independents) fill from the left, Republicans from the
 * right, uncalled seats in the middle, with a marker at the control threshold.
 * Solid = won, hatched = currently leading, darker = not up this cycle.
 */
export function BalanceOfPower({ c, compact = false, custom = false, view }: { c: ChamberSummary; compact?: boolean; custom?: boolean; view?: BopView }) {
  const v: BopView | undefined =
    view ?? (custom ? { sideNote: 'your map', middle: `${c.racesCalled}/${c.racesTotal} races assigned`, badge: c.office === 'G' ? 'MAJORITY' : 'CONTROL', legend: ['Assigned', '', 'Unassigned'] } : undefined);
  const L = v?.legend ?? ['Won', 'Leading', 'Uncalled'];
  const isSenate = c.office === 'S';
  const dWon = c.won.D;
  const dLead = c.leading.D;
  const iWon = c.won.I;
  const iLead = c.leading.I;
  const rWon = c.won.R;
  const rLead = c.leading.R;
  const pending = Math.max(0, c.total - (c.notUp.D + c.notUp.I + c.notUp.R + dWon + dLead + iWon + iLead + rWon + rLead));

  const dSide: Seg[] = [
    { key: 'dnu', n: c.notUp.D, color: RAMP.D.lean, label: 'D not up' },
    { key: 'dw', n: dWon, color: PARTY_COLOR.D, label: `D ${L[0].toLowerCase()}` },
    { key: 'dl', n: dLead, color: RAMP.D.likely, hatch: 'D', label: `D ${L[1].toLowerCase()}` },
    { key: 'inu', n: c.notUp.I, color: RAMP.I.lean, label: 'Ind. not up' },
    { key: 'iw', n: iWon, color: PARTY_COLOR.I, label: `Ind. ${L[0].toLowerCase()}` },
    { key: 'il', n: iLead, color: RAMP.I.likely, hatch: 'I', label: `Ind. ${L[1].toLowerCase()}` },
  ];
  const rSide: Seg[] = [
    { key: 'rl', n: rLead, color: RAMP.R.likely, hatch: 'R', label: `R ${L[1].toLowerCase()}` },
    { key: 'rw', n: rWon, color: PARTY_COLOR.R, label: `R ${L[0].toLowerCase()}` },
    { key: 'rnu', n: c.notUp.R, color: RAMP.R.lean, label: 'R not up' },
  ];
  const segs: Seg[] = [...dSide, { key: 'p', n: pending, color: '#2a3243', label: v ? L[2] : 'Uncalled / no results' }, ...rSide];

  const dTotal = c.notUp.D + dWon + dLead + (isSenate ? c.notUp.I + iWon + iLead : 0);
  const rTotal = c.notUp.R + rWon + rLead;
  const dCalled = c.notUp.D + dWon + (isSenate ? c.notUp.I + iWon : 0);
  const rCalled = c.notUp.R + rWon;
  // Live view: the big number is seats actually secured (called + not up); "expected" adds the
  // races each side currently leads. Projection views (market, forecast, current, custom) keep
  // their own tally as the big number.
  const dBig = v ? dTotal : dCalled;
  const rBig = v ? rTotal : rCalled;
  // Expected = seats not up + the projected winner of every race up (call, NYT model, Polymarket).
  const exp = c.expected ?? { D: dTotal, R: rTotal, I: 0 };
  const dExp = c.expected ? exp.D + (isSenate ? exp.I : 0) : dTotal;
  const rExp = exp.R;
  const expTip = 'expected: called races plus the projected winner of each uncalled race (NYT model, else Polymarket odds)';
  const thresholdPct = (c.toControl.D / c.total) * 100;
  const pm = c.market?.byParty;
  const dGain = c.flips.toD;
  const rGain = c.flips.toR;
  const ctrlNote =
    c.office === 'S' ? 'D need 51 · R need 50 (VP)' : c.office === 'H' ? '218 for majority' : 'Governorships (26 = majority)';

  return (
    <div className={`bop ${compact ? 'compact' : ''}`}>
      <div className="bop-head">
        <span className="bop-title">{c.label}</span>
        <span className="bop-ctrl">{ctrlNote}</span>
      </div>
      <div className="bop-nums">
        <div className="bop-side d">
          <span className="bop-big" style={{ color: PARTY_COLOR.D }} title={v ? undefined : `${dCalled} secured · ${dExp} ${expTip}`}>
            {dBig}
          </span>
          <span className="bop-small">
            DEM{isSenate ? '+IND' : ''} · {v ? v.sideNote : `${dExp} expected`}
          </span>
        </div>
        <div className="bop-mid">
          {c.controlWinner ? (
            <span className="bop-winner" style={{ background: PARTY_COLOR[c.controlWinner] }}>
              {c.controlWinner === 'D' ? 'DEM' : 'GOP'} {v ? v.badge : c.office === 'G' ? 'MAJORITY' : 'CONTROL'}
            </span>
          ) : (
            <span className="bop-pending">{v ? v.middle : `${c.racesCalled}/${c.racesTotal} races called`}</span>
          )}
        </div>
        <div className="bop-side r">
          <span className="bop-big" style={{ color: PARTY_COLOR.R }} title={v ? undefined : `${rCalled} secured · ${rExp} ${expTip}`}>
            {rBig}
          </span>
          <span className="bop-small">GOP · {v ? v.sideNote : `${rExp} expected`}</span>
        </div>
      </div>
      <div className="bop-bar" role="img" aria-label={v ? `${c.label}: Democrats ${dTotal}, Republicans ${rTotal}, ${pending} uncalled` : `${c.label}: Democrats ${dCalled} secured (${dExp} expected), Republicans ${rCalled} secured (${rExp} expected), ${pending} uncalled`}>
        {segs
          .filter((s) => s.n > 0)
          .map((s) => (
            <div
              key={s.key}
              className={`bop-seg ${s.hatch ? `hatch-${s.hatch}` : ''}`}
              style={{ flexGrow: s.n, background: s.hatch ? undefined : s.color, ['--seg' as string]: s.color }}
              title={`${s.label}: ${s.n}`}
            />
          ))}
        <div className="bop-threshold" style={{ left: `${thresholdPct}%` }} />
      </div>
      {!compact ? (
        <div className="bop-foot">
          <span>
            Flips: <b style={{ color: PARTY_COLOR.D }}>D +{dGain}</b> · <b style={{ color: PARTY_COLOR.R }}>R +{rGain}</b>
            {c.flips.toI ? <> · <b style={{ color: PARTY_COLOR.I }}>I +{c.flips.toI}</b></> : null}
          </span>
          {pm && (pm.D != null || pm.R != null) && (!v || v.showMarket) ? (
            <span>
              Polymarket: <b style={{ color: PARTY_COLOR.D }}>D {fmtProb(pm.D)}</b> · <b style={{ color: PARTY_COLOR.R }}>R {fmtProb(pm.R)}</b>
            </span>
          ) : null}
          <span className="muted">
            Before: D {c.before.D + (isSenate ? c.before.I : 0)} – R {c.before.R}
          </span>
        </div>
      ) : null}
      <div className="bop-legend">
        {L[0] ? <span><i className="sw" style={{ background: PARTY_COLOR.D }} />{L[0]}</span> : null}
        {L[1] ? <span><i className="sw hatch-D" style={{ ['--seg' as string]: RAMP.D.likely }} />{L[1]}</span> : null}
        {c.notUp.D + c.notUp.R > 0 ? <span><i className="sw" style={{ background: RAMP.D.lean }} />Not up</span> : null}
        {L[2] ? <span><i className="sw" style={{ background: '#2a3243' }} />{L[2]}</span> : null}
      </div>
    </div>
  );
}
