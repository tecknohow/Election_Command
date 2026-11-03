import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { fmtEt, raceName } from '../../lib/format';
import { currentParty, isPotentialFlip } from '../../lib/odds';
import type { HoverFn } from './useRaceHover';

/** Seats changing hands: projected flips first, then seats where the challenger party leads. */
export function FlipsPanel({ races, onHover }: { races: Race[]; onHover: HoverFn }) {
  const list = races
    .filter(isPotentialFlip)
    .sort((a, b) => Number(!!b.winner) - Number(!!a.winner) || (b.calledAt ?? '').localeCompare(a.calledAt ?? '') || (a.margin ?? 0) - (b.margin ?? 0));
  const called = list.filter((r) => r.winner);
  const tally = (p: 'D' | 'R' | 'I', onlyCalled: boolean) => (onlyCalled ? called : list).filter((r) => currentParty(r) === p).length;

  return (
    <section className="panel flips-panel">
      <div className="panel-head">
        <h2>Seats changing hands</h2>
      </div>
      <div className="flip-tally">
        {(['D', 'R', 'I'] as const).map((p) =>
          p === 'I' && !tally('I', false) ? null : (
            <div key={p}>
              <b style={{ color: PARTY_COLOR[p] }}>
                {p} +{tally(p, true)}
              </b>
              <span>
                called · {tally(p, false) - tally(p, true)} more leading
              </span>
            </div>
          ),
        )}
      </div>
      <ul className="calls-list">
        {list.map((r) => {
          const p = currentParty(r)!;
          return (
            <li key={r.id} data-race-id={r.id} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
              <i className="party-chip" style={{ background: PARTY_COLOR[p] }} />
              <span className="cl-race">{raceName(r)}</span>
              <span className="cl-name">
                {r.priorParty} → {p} · {r.winnerName ?? r.leaderName}
              </span>
              {r.winner ? (
                <span className="badge flip" style={{ background: PARTY_COLOR[p] }}>
                  GAIN
                </span>
              ) : (
                <span className="badge status-counting">{p}+{(r.margin ?? 0).toFixed(1)}</span>
              )}
              <span className="cl-time muted">{r.winner ? fmtEt(r.calledAt) : `${Math.round(r.eevp ?? 0)}% in`}</span>
            </li>
          );
        })}
        {!list.length ? <li className="empty">No seats changing hands yet</li> : null}
      </ul>
    </section>
  );
}
