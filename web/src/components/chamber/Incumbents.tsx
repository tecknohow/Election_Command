import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { raceName } from '../../lib/format';
import type { HoverFn } from './useRaceHover';

/** How incumbents are faring, plus the open-seat count. */
export function Incumbents({ races, onHover }: { races: Race[]; onHover: HoverFn }) {
  const running = races.filter((r) => r.incumbentRunning);
  const status = (r: Race) => {
    const inc = r.candidates.find((c) => c.incumbent);
    if (!inc) return 'unknown';
    if (r.winner) return inc.winner ? 'reelected' : 'defeated';
    if (!r.totalVotes) return 'pending';
    return r.candidates[0]?.id === inc.id ? 'leading' : 'trailing';
  };
  const order = { defeated: 0, trailing: 1, leading: 2, reelected: 3, pending: 4, unknown: 5 } as const;
  const list = [...running].sort((a, b) => order[status(a)] - order[status(b)] || (a.margin ?? 99) - (b.margin ?? 99));
  const n = (s: string) => running.filter((r) => status(r) === s).length;

  return (
    <section className="panel incumbents-panel">
      <div className="panel-head">
        <h2>Incumbents</h2>
        <span className="muted small">
          {running.length} running · {races.length - running.length} open seats
        </span>
      </div>
      <div className="inc-tally">
        <span>
          <b>{n('reelected')}</b> re-elected
        </span>
        <span>
          <b>{n('leading')}</b> leading
        </span>
        <span className={n('trailing') ? 'warn' : ''}>
          <b>{n('trailing')}</b> trailing
        </span>
        <span className={n('defeated') ? 'bad' : ''}>
          <b>{n('defeated')}</b> defeated
        </span>
      </div>
      <ul className="calls-list">
        {list.map((r) => {
          const inc = r.candidates.find((c) => c.incumbent)!;
          const s = status(r);
          return (
            <li key={r.id} data-race-id={r.id} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
              <i className="party-chip" style={{ background: PARTY_COLOR[inc.party] }} />
              <span className="cl-race">{raceName(r)}</span>
              <span className="cl-name">{inc.name}</span>
              <span className={`badge inc-${s}`}>{s.toUpperCase()}</span>
              <span className="cl-time muted">{r.totalVotes ? `${inc.pct.toFixed(1)}%` : ''}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
