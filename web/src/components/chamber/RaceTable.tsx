import { useMemo, useState } from 'react';
import type { Race } from '../../../../shared/src/types';
import { LEVEL_STRENGTH } from '../../../../shared/src/ratings';
import { PARTY_COLOR, forecastFor } from '../../lib/colors';
import { fmtEt, fmtNum } from '../../lib/format';
import { fmtLean, leanParty, pres2024For, prevFor, prevText, swing } from '../../lib/history';
import { isPotentialFlip, isTossup, isUpset, probD } from '../../lib/odds';
import { useElection } from '../../store/election';
import { headToHead } from '../KeyRaces';
import type { HoverFn } from './useRaceHover';
import { WatchStar } from '../Watch';

type Filter = 'all' | 'competitive' | 'counting' | 'called' | 'flips' | 'upsets';
type SortKey = 'race' | 'margin' | 'eevp' | 'odds' | 'status' | 'last' | 'pres' | 'shift';

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

/**
 * Tonight vs the seat's history: the previous race for the seat when it's a like-for-like D-vs-R
 * comparison on the same lines, otherwise the 2024 presidential margin within today's lines.
 */
export function shiftFor(r: Race): { value: number | null; basis: string } {
  const prev = prevFor(r);
  if (prev?.margin != null && !prev.linesChanged) return { value: swing(r, prev.margin), basis: `vs ${prev.label} race (${prevText(prev)})` };
  const pres = pres2024For(r);
  return { value: swing(r, pres), basis: `vs 2024 president (${fmtLean(pres)})` };
}
const leanColor = (m: number | null | undefined) => {
  const p = leanParty(m);
  return p ? PARTY_COLOR[p] : undefined;
};

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
      last: (a, b) => (prevFor(a)?.margin ?? 999) - (prevFor(b)?.margin ?? 999),
      pres: (a, b) => (pres2024For(a) ?? 999) - (pres2024For(b) ?? 999),
      shift: (a, b) => (shiftFor(a).value ?? 999) - (shiftFor(b).value ?? 999),
    };
    return list.sort((a, b) => cmp[sort.key](a, b) * sort.dir || cmp.race(a, b));
  }, [races, filter, sort]);

  const th = (key: SortKey, label: string, cls = '', title?: string) => (
    <th title={title} className={`${cls} sortable ${sort.key === key ? 'sorted' : ''}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}>
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
              <th className="rt-opt" title="Forecast rating: FLIPR, or Cook where FLIPR doesn't rate the race">
                Rating
              </th>
              {th('odds', 'Odds', 'num rt-opt', 'Polymarket favorite and price')}
              {th('last', 'Last', 'num', 'Party holding the seat going in, and the previous result for this seat')}
              {th('shift', 'Shift', 'num')}
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
              const prev = prevFor(r);
              const pres = pres2024For(r);
              const sh = shiftFor(r);
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
                  <td className="num">
                    {r.leader && counted ? (
                      <span style={{ color: PARTY_COLOR[r.leader] }}>
                        {r.leader}+{(r.margin ?? 0).toFixed(1)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{counted ? `${Math.round(r.eevp ?? 0)}%` : '—'}</td>
                  <td className="rt-opt">
                    {f && f.source !== 'Not rated competitive' ? (
                      <span style={{ color: f.party ? PARTY_COLOR[f.party] : undefined }}>{f.label}</span>
                    ) : (
                      <span className="muted">{f?.label ?? '—'}</span>
                    )}
                  </td>
                  <td className="num rt-opt">
                    {r.market ? (
                      <span style={{ color: pd >= 0.5 ? PARTY_COLOR.D : PARTY_COLOR.R }}>{pd >= 0.5 ? `D ${Math.round(pd * 100)}` : `R ${Math.round((1 - pd) * 100)}`}%</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td
                    className="num rt-hist"
                    title={
                      prev
                        ? `${r.office === 'H' ? '2024 House' : prev.label}${prev.linesChanged ? ' (old lines)' : ''}: ${prevText(prev)}${prev.winner ? `, ${prev.winner.name}` : ''} · 2024 president ${fmtLean(pres)}`
                        : undefined
                    }
                  >
                    {r.priorParty ? (
                      <span className="prior-chip" style={{ background: PARTY_COLOR[r.priorParty] }} title={`${r.priorParty} held the seat going in`}>
                        {r.priorParty}
                      </span>
                    ) : null}{' '}
                    <span style={{ color: leanColor(prev?.margin) }}>{prev?.margin != null ? fmtLean(prev.margin) : <span className="muted">{prevText(prev, true)}</span>}</span>
                    {prev && r.office !== 'H' ? <small> '{String(prev.year).slice(2)}</small> : prev?.linesChanged ? <small title="old lines">°</small> : null}
                  </td>

                  <td className="num" title={sh.value != null ? `Tonight's margin ${sh.basis}` : undefined}>
                    {sh.value != null ? <b style={{ color: leanColor(sh.value) }}>{fmtLean(sh.value)}</b> : <span className="muted">—</span>}
                  </td>
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
        {rows.length} of {races.length} races · * incumbent · Rating = FLIPR (else Cook) · Odds = Polymarket · Last = party holding the seat and its previous result
        {races[0]?.office === 'H' ? ' (2024; ° = old lines)' : ''} · Shift = tonight vs last race, or vs 2024 president where lines changed ·{' '}
        {fmtNum(races.reduce((s, r) => s + r.totalVotes, 0))} votes counted
      </div>
    </section>
  );
}
