import { useMemo, useState } from 'react';
import type { Race } from '../../../../shared/src/types';
import { LEVEL_STRENGTH } from '../../../../shared/src/ratings';
import { PARTY_COLOR, forecastFor } from '../../lib/colors';
import { fmtEt, fmtNum } from '../../lib/format';
import { isPotentialFlip, isTossup, isUpset, probD } from '../../lib/odds';
import { useElection } from '../../store/election';
import { headToHead } from '../KeyRaces';
import type { HoverFn } from './useRaceHover';
import { WatchStar } from '../Watch';

type Filter = 'all' | 'competitive' | 'counting' | 'called' | 'flips' | 'upsets';
type SortKey = 'race' | 'margin' | 'eevp' | 'odds' | 'status';

const STATUS_ORDER: Record<Race['status'], number> = { counting: 0, closed: 1, called: 2, runoff: 2, upcoming: 3 };
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);

/** Compact status for the table ("% in" has its own column). */
function shortStatus(r: Race): string {
  switch (r.status) {
    case 'called':
      return '✔ Called';
    case 'runoff':
      return 'Runoff';
    case 'counting':
      return r.expectedLater ? 'Later' : 'Counting';
    case 'closed':
      return 'Closed';
    default:
      return r.pollClose ? fmtEt(r.pollClose) : 'Open';
  }
}

export function isCompetitive(r: Race) {
  const f = forecastFor(r);
  return (f ? LEVEL_STRENGTH[f.level] <= LEVEL_STRENGTH.lean && f.source !== 'Not rated competitive' : false) || isTossup(r);
}

export function RaceTable({ races, onHover, defaultFilter = 'all' }: { races: Race[]; onHover: HoverFn; defaultFilter?: Filter }) {
  const flashed = useElection((s) => s.flashed);
  const [filter, setFilter] = useState<Filter>(defaultFilter);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'race', dir: 1 });

  const counts = useMemo(
    () => ({
      all: races.length,
      competitive: races.filter(isCompetitive).length,
      counting: races.filter((r) => r.status === 'counting').length,
      called: races.filter((r) => r.winner).length,
      flips: races.filter(isPotentialFlip).length,
      upsets: races.filter(isUpset).length,
    }),
    [races],
  );

  const rows = useMemo(() => {
    const list = races.filter((r) => {
      switch (filter) {
        case 'competitive':
          return isCompetitive(r);
        case 'counting':
          return r.status === 'counting';
        case 'called':
          return !!r.winner;
        case 'flips':
          return isPotentialFlip(r);
        case 'upsets':
          return isUpset(r);
        default:
          return true;
      }
    });
    const cmp: Record<SortKey, (a: Race, b: Race) => number> = {
      race: (a, b) => a.state.localeCompare(b.state) || (a.district ?? 0) - (b.district ?? 0),
      margin: (a, b) => (a.margin ?? 999) - (b.margin ?? 999),
      eevp: (a, b) => (b.eevp ?? -1) - (a.eevp ?? -1),
      odds: (a, b) => Math.abs(probD(a) - 0.5) - Math.abs(probD(b) - 0.5),
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    };
    return list.sort((a, b) => cmp[sort.key](a, b) * sort.dir || cmp.race(a, b));
  }, [races, filter, sort]);

  const th = (key: SortKey, label: string, cls = '') => (
    <th className={`${cls} sortable ${sort.key === key ? 'sorted' : ''}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const now = Date.now();

  return (
    <section className="panel race-table-panel">
      <div className="panel-head">
        <h2>All races</h2>
        <div className="chips">
          {(['all', 'competitive', 'counting', 'called', 'flips', 'upsets'] as Filter[]).map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'flips' ? 'Flipping' : f[0].toUpperCase() + f.slice(1)} <span className="muted">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="table-scroll">
        <table className="race-table">
          <thead>
            <tr>
              <th />
              {th('race', 'Race')}
              <th>Candidates</th>
              {th('margin', 'Margin', 'num')}
              {th('eevp', '% in', 'num')}
              <th>FLIPR / Cook</th>
              {th('odds', 'Polymarket', 'num')}
              <th>Prior</th>
              {th('status', 'Status')}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [a, b] = headToHead(r);
              const counted = r.totalVotes > 0;
              const f = forecastFor(r);
              const pd = probD(r);
              const flash = flashed[r.id] && now - flashed[r.id] < 2500;
              return (
                <tr key={r.id} data-race-id={r.id} className={`${flash ? 'flash' : ''} ${r.flip ? 'flipped' : ''}`} onMouseMove={(e) => onHover(r.id, e)} onMouseLeave={() => onHover(null)}>
                  <td className="rt-star">
                    <WatchStar id={r.id} size="sm" />
                  </td>
                  <td className="rt-race">
                    {r.state}
                    {r.office === 'H' ? `-${AT_LARGE.has(r.state) ? 'AL' : r.district}` : ''}
                    {r.special ? <sup>S</sup> : null}
                  </td>
                  <td className="rt-cands">
                    {[a, b].filter(Boolean).map((c) => (
                      <span key={c!.id} className={`rt-cand ${c!.winner ? 'won' : ''}`}>
                        <i style={{ background: PARTY_COLOR[c!.party] }} />
                        {c!.lastName}
                        {c!.incumbent ? <small>*</small> : null}
                        {counted ? <b>{c!.pct.toFixed(1)}</b> : null}
                        {c!.winner ? ' ✔' : ''}
                      </span>
                    ))}
                  </td>
                  <td className="num">{r.leader && counted ? <span style={{ color: PARTY_COLOR[r.leader] }}>{r.leader}+{(r.margin ?? 0).toFixed(1)}</span> : '—'}</td>
                  <td className="num">{counted ? `${Math.round(r.eevp ?? 0)}%` : '—'}</td>
                  <td>{f && f.source !== 'Not rated competitive' ? <span style={{ color: f.party ? PARTY_COLOR[f.party] : undefined }}>{f.label}</span> : <span className="muted">{f?.label ?? '—'}</span>}</td>
                  <td className="num">
                    {r.market ? <span style={{ color: pd >= 0.5 ? PARTY_COLOR.D : PARTY_COLOR.R }}>{pd >= 0.5 ? `D ${Math.round(pd * 100)}` : `R ${Math.round((1 - pd) * 100)}`}%</span> : <span className="muted">—</span>}
                  </td>
                  <td>{r.priorParty ? <span className="prior-chip" style={{ background: PARTY_COLOR[r.priorParty] }}>{r.priorParty}</span> : '—'}</td>
                  <td>
                    {r.flip && r.winner ? (
                      <span className="badge flip" style={{ background: PARTY_COLOR[r.winner] }}>
                        {r.winner} GAIN
                      </span>
                    ) : (
                      <span className={`badge status-${r.status}`}>{shortStatus(r)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length ? <div className="empty">No races match</div> : null}
      </div>
      <div className="table-foot muted small">
        {rows.length} of {races.length} races · * incumbent · {fmtNum(races.reduce((s, r) => s + r.totalVotes, 0))} votes counted
      </div>
    </section>
  );
}
