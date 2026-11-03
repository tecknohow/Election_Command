import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router';
import type { Race } from '../../../shared/src/types';
import { PARTY_COLOR } from '../lib/colors';
import { usePrefs } from '../lib/prefs';
import { useWatchlist } from '../lib/watchlist';
import { useElection } from '../store/election';
import { useRaceHover } from './chamber/useRaceHover';

/** Star toggle for the personal watchlist. */
export function WatchStar({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
  const on = useWatchlist((s) => s.ids.includes(id));
  const toggle = useWatchlist((s) => s.toggle);
  return (
    <button
      className={`watch-star ${on ? 'on' : ''} ${size}`}
      aria-pressed={on}
      title={on ? 'Remove from My races' : 'Add to My races'}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        toggle(id);
      }}
    >
      {on ? '★' : '☆'}
    </button>
  );
}

const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const shortName = (r: Race) => (r.office === 'H' ? `${r.state}-${AT_LARGE.has(r.state) ? 'AL' : r.district}` : `${r.state} ${r.office === 'S' ? 'Sen' : 'Gov'}`);

function Tile({ r, onHover }: { r: Race; onHover: ReturnType<typeof useRaceHover>['onHover'] }) {
  const leader = r.candidates[0];
  const counted = r.totalVotes > 0;
  const party = r.winner ?? (counted ? r.leader : null);
  return (
    <div
      className={`dock-tile status-${r.status}`}
      data-race-id={r.id}
      style={{ ['--tile' as string]: party ? PARTY_COLOR[party] : '#3a4458' }}
      onMouseMove={(e) => onHover(r.id, e)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="dt-top">
        <b>{shortName(r)}</b>
        <WatchStar id={r.id} size="sm" />
      </div>
      <div className="dt-mid">
        {r.winner ? (
          <>✔ {r.winnerName?.split(' ').pop()} {r.flip ? <em>GAIN</em> : null}</>
        ) : counted && leader ? (
          <>
            {leader.lastName} +{(r.margin ?? 0).toFixed(1)}
          </>
        ) : (
          <span className="muted">{r.status === 'closed' ? 'Polls closed' : 'Not yet'}</span>
        )}
      </div>
      <div className="dt-bot">{r.expectedLater ? 'decision later' : counted ? `${Math.round(r.eevp ?? 0)}% in` : r.status === 'called' ? 'called' : ''}</div>
    </div>
  );
}

/** "My races": a strip docked to the bottom of every view, shown when the watchlist has races. */
export function WatchlistDock() {
  const ids = useWatchlist((s) => s.ids);
  const races = useElection((s) => s.races);
  const show = usePrefs((s) => s.showDock);
  const { onHover, card } = useRaceHover();
  const list = useMemo(() => ids.map((id) => races[id]).filter(Boolean), [ids, races]);
  const navigate = useNavigate();
  // A tile removed via its star unmounts under the pointer, so its mouseleave never fires;
  // close any open hover card whenever the list changes.
  useEffect(() => onHover(null), [ids, onHover]);
  if (!show) return null;
  return (
    <div className={`watch-dock ${list.length ? '' : 'empty'}`}>
      <button className="dock-label" onClick={() => navigate('/mine')} title="Open the My Races dashboard (2)">
        ★ My races
      </button>
      <div className="dock-tiles">
        {list.map((r) => (
          <Tile key={r.id} r={r} onHover={onHover} />
        ))}
        {!list.length ? <span className="dock-hint muted">Star (☆) any race to pin it here, or open My Races to pick from the most competitive.</span> : null}
      </div>
      <button className="dock-open" onClick={() => navigate('/mine')}>
        Open dashboard →
      </button>
      {card}
    </div>
  );
}
