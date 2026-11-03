import { useMemo } from 'react';
import { PARTY_COLOR } from '../lib/colors';
import { fmtEt, raceName } from '../lib/format';
import { useElection } from '../store/election';

const OFFICE_SHORT = { S: 'Sen', G: 'Gov', H: 'House' } as const;

/** Most recent projections: every Senate/Governor call plus House flips. */
export function RecentCalls({ onHover }: { onHover: (id: string | null, e?: React.MouseEvent) => void }) {
  const races = useElection((s) => s.races);
  const list = useMemo(
    () =>
      Object.values(races)
        .filter((r) => r.winner && (r.office !== 'H' || r.flip))
        .sort((a, b) => (b.calledAt ?? '').localeCompare(a.calledAt ?? ''))
        .slice(0, 40),
    [races],
  );
  const flips = useMemo(() => Object.values(races).filter((r) => r.flip), [races]);

  return (
    <section className="panel recent-calls">
      <div className="panel-head">
        <h2>Projections</h2>
        <span className="muted small">
          {flips.length} seat{flips.length === 1 ? '' : 's'} flipped
        </span>
      </div>
      <ul className="calls-list">
        {list.map((r) => (
          <li key={r.id} data-race-id={r.id} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
            <i className="party-chip" style={{ background: PARTY_COLOR[r.winner!] }} />
            <span className="cl-race">
              {raceName(r)} <span className="muted">{OFFICE_SHORT[r.office]}</span>
            </span>
            <span className="cl-name">{r.winnerName}</span>
            {r.flip ? (
              <span className="badge flip" style={{ background: PARTY_COLOR[r.winner!] }}>
                GAIN
              </span>
            ) : (
              <span className="badge hold">HOLD</span>
            )}
            <span className="cl-time muted">{fmtEt(r.calledAt)}</span>
          </li>
        ))}
        {!list.length ? <li className="empty">No races called yet</li> : null}
      </ul>
    </section>
  );
}
