import { useMemo } from 'react';
import type { ChamberSummary, Race } from '../../../../shared/src/types';
import { probToLevel } from '../../../../shared/src/ratings';
import { PARTY_COLOR, RAMP, inkFor, levelColor } from '../../lib/colors';
import { fmtProb, stateName } from '../../lib/format';
import { currentParty, probD } from '../../lib/odds';
import type { HoverFn } from './useRaceHover';

/**
 * "Path to control": seats not up sit at each end, the races in between are ordered from the
 * most Democratic to the most Republican (live result first, then Polymarket/forecast odds).
 * The race that delivers the majority-making seat is the tipping point.
 */
export function SeatLadder({ chamber, races, onHover }: { chamber: ChamberSummary; races: Race[]; onHover: HoverFn }) {
  const isSenate = chamber.office === 'S';
  const dFixed = chamber.notUp.D + (isSenate ? chamber.notUp.I : 0);
  const rFixed = chamber.notUp.R;
  const need = chamber.office === 'G' ? 26 : chamber.toControl.D;

  const ordered = useMemo(() => {
    const score = (r: Race) => {
      if (r.winner) return r.winner === 'R' ? -10 : 10;
      const cur = currentParty(r);
      if (cur) return (cur === 'R' ? -5 : 5) + (cur === 'R' ? -1 : 1) * Math.min(4, (r.margin ?? 0) / 5);
      return (probD(r) - 0.5) * 8;
    };
    return [...races].sort((a, b) => score(b) - score(a) || a.state.localeCompare(b.state));
  }, [races]);

  const tipIdx = need - dFixed - 1;
  const tip = ordered[tipIdx];
  const favD = races.filter((r) => (currentParty(r) ?? (probD(r) >= 0.5 ? 'D' : 'R')) !== 'R').length;

  return (
    <section className="panel ladder-panel">
      <div className="panel-head">
        <h2>Path to {need}</h2>
        <span className="small">
          {tip ? (
            <>
              Tipping point: <b>{stateName(tip.state)}</b>{' '}
              <span className="muted">
                ({currentParty(tip) ? `${currentParty(tip)} ${tip.winner ? 'won' : 'leads'}` : `D ${fmtProb(probD(tip))}`})
              </span>{' '}
              · If favorites win: <b style={{ color: PARTY_COLOR.D }}>D {dFixed + favD}</b> – <b style={{ color: PARTY_COLOR.R }}>R {rFixed + races.length - favD}</b>
            </>
          ) : null}
        </span>
      </div>
      <div className="ladder">
        <div className="ladder-fixed d" style={{ background: RAMP.D.lean }} title="Seats not up this cycle (incl. independents caucusing with Democrats)">
          <b>{dFixed}</b>
          <span>not up</span>
        </div>
        <div className="ladder-races">
          {ordered.map((r, i) => {
            const cur = currentParty(r);
            const pd = probD(r);
            const fill = r.winner ? RAMP[r.winner].solid : cur ? RAMP[cur].lean : levelColor(pd >= 0.5 ? 'D' : 'R', probToLevel(Math.max(pd, 1 - pd)));
            const seat = dFixed + i + 1;
            return (
              <div
                key={r.id}
                data-race-id={r.id}
                className={`ladder-cell ${cur && !r.winner ? `hatch-${cur}` : ''} ${i === tipIdx ? 'tip' : ''} ${r.flip ? 'flip' : ''}`}
                style={{ background: cur && !r.winner ? undefined : fill, ['--seg' as string]: cur ? RAMP[cur].likely : fill }}
                onMouseMove={(e) => onHover(r.id, e)}
                onMouseLeave={() => onHover(null)}
              >
                <span className="lc-state" style={{ color: inkFor(fill) }}>
                  {r.state}
                </span>
                <span className="lc-sub" style={{ color: inkFor(fill) }}>
                  {r.flip ? 'FLIP' : r.winner ? '✔' : cur ? `${(r.margin ?? 0).toFixed(0)}` : Math.round(Math.max(pd, 1 - pd) * 100)}
                </span>
                {seat === need ? <span className="ladder-line" title={`Seat ${need}`} /> : null}
              </div>
            );
          })}
        </div>
        <div className="ladder-fixed r" style={{ background: RAMP.R.lean }} title="Seats not up this cycle">
          <b>{rFixed}</b>
          <span>not up</span>
        </div>
      </div>
      <div className="ladder-legend muted small">
        Ordered most-Democratic → most-Republican · number = win probability (%) before results, lead margin while counting · ✔ called · <i className="flip-legend"><i className="flip-dot-legend" /></i>FLIP = called for the other party · white bar = seat {need}
      </div>
    </section>
  );
}
