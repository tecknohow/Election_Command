import { useMemo, useState } from 'react';
import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR, RAMP } from '../../lib/colors';
import { fmtProb, raceName } from '../../lib/format';
import { currentParty, favorite, isPotentialFlip, isTossup, isUpset, probD } from '../../lib/odds';
import { headToHead } from '../KeyRaces';
import type { HoverFn } from './useRaceHover';

type Tab = 'closest' | 'upsets' | 'tossups';

/** Closest counting races, upsets vs. the market/forecast favorite, and pre-results toss-ups. */
export function WatchList({ races, onHover, limit = 40 }: { races: Race[]; onHover: HoverFn; limit?: number }) {
  const counting = races.filter((r) => r.status === 'counting');
  const [tab, setTab] = useState<Tab | null>(null);
  const active: Tab = tab ?? (counting.length ? 'closest' : 'tossups');

  const lists = useMemo(
    () => ({
      closest: [...counting].sort((a, b) => (a.margin ?? 99) - (b.margin ?? 99)).slice(0, limit),
      upsets: races.filter(isUpset).sort((a, b) => favorite(b).p - favorite(a).p).slice(0, limit),
      tossups: races
        .filter((r) => isTossup(r) && !r.winner)
        .sort((a, b) => Math.abs(probD(a) - 0.5) - Math.abs(probD(b) - 0.5))
        .slice(0, limit),
    }),
    [races, counting, limit],
  );
  const list = lists[active];

  return (
    <section className="panel watch-panel">
      <div className="panel-head">
        <h2>Races to watch</h2>
        <div className="chips">
          {(['closest', 'upsets', 'tossups'] as Tab[]).map((t) => (
            <button key={t} className={`chip ${active === t ? 'on' : ''}`} onClick={() => setTab(t)}>
              {t === 'closest' ? 'Closest' : t === 'upsets' ? 'Upsets' : 'Toss-ups'} <span className="muted">{lists[t].length}</span>
            </button>
          ))}
        </div>
      </div>
      <ul className="watch-list">
        {list.map((r) => {
          const [a, b] = headToHead(r);
          const cur = currentParty(r);
          const fav = favorite(r);
          const counted = r.totalVotes > 0;
          return (
            <li key={r.id} data-race-id={r.id} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
              <span className="wl-race">{raceName(r)}</span>
              <span className="wl-cands">
                <span style={{ color: PARTY_COLOR[a.party] }}>{a.lastName}</span>
                {b ? (
                  <>
                    {' v '}
                    <span style={{ color: PARTY_COLOR[b.party] }}>{b.lastName}</span>
                  </>
                ) : null}
              </span>
              <span className="wl-metric">
                {counted && cur ? (
                  <>
                    <b style={{ color: PARTY_COLOR[cur] }}>
                      {cur}+{(r.margin ?? 0).toFixed(1)}
                    </b>
                    <span className="muted"> · {Math.round(r.eevp ?? 0)}% in</span>
                  </>
                ) : (
                  <span className="muted">no votes yet</span>
                )}
              </span>
              <span className="wl-fav" title="Pre-results favorite (Polymarket, else forecast)">
                fav <b style={{ color: PARTY_COLOR[fav.party] }}>{fav.party} {fmtProb(fav.p)}</b>
              </span>
              <span className="wl-bar">
                <i style={{ width: `${probD(r) * 100}%`, background: RAMP.D.likely }} />
                <i style={{ width: `${(1 - probD(r)) * 100}%`, background: RAMP.R.likely }} />
              </span>
              {r.winner ? <span className={`badge ${r.flip ? 'flip' : 'status-called'}`} style={r.flip ? { background: PARTY_COLOR[r.winner] } : undefined}>{r.flip ? `${r.winner} GAIN` : 'Called'}</span> : isPotentialFlip(r) ? <span className="badge status-counting">flip?</span> : <span />}
            </li>
          );
        })}
        {!list.length ? (
          <li className="empty">{active === 'closest' ? 'No races counting yet' : active === 'upsets' ? 'No upsets so far' : 'No toss-ups'}</li>
        ) : null}
      </ul>
    </section>
  );
}
