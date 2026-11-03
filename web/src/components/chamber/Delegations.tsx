import { useMemo } from 'react';
import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { stateName } from '../../lib/format';
import { currentParty } from '../../lib/odds';

/** State House delegations: before the election vs. now (won + leading), biggest changes first. */
export function Delegations({ races }: { races: Race[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { st: string; seats: number; bD: number; bR: number; nD: number; nR: number; nI: number; known: number }>();
    for (const r of races) {
      const row = m.get(r.state) ?? { st: r.state, seats: 0, bD: 0, bR: 0, nD: 0, nR: 0, nI: 0, known: 0 };
      row.seats++;
      if (r.priorParty === 'D') row.bD++;
      if (r.priorParty === 'R') row.bR++;
      const cur = currentParty(r);
      if (cur) {
        row.known++;
        if (cur === 'D') row.nD++;
        else if (cur === 'R') row.nR++;
        else row.nI++;
      }
      m.set(r.state, row);
    }
    return [...m.values()]
      .map((x) => {
        // Change measured only over seats that already have a result/leader.
        const decided = races.filter((r) => r.state === x.st && currentParty(r));
        const dDelta = decided.filter((r) => currentParty(r) === 'D' && r.priorParty !== 'D').length - decided.filter((r) => r.priorParty === 'D' && currentParty(r) !== 'D').length;
        return { ...x, dDelta };
      })
      .sort((a, b) => Math.abs(b.dDelta) - Math.abs(a.dDelta) || b.seats - a.seats);
  }, [races]);

  return (
    <section className="panel deleg-panel">
      <div className="panel-head">
        <h2>State delegations</h2>
        <span className="muted small">before → now (won + leading)</span>
      </div>
      <div className="table-scroll">
        <table className="race-table deleg-table">
          <thead>
            <tr>
              <th>State</th>
              <th className="num">Seats</th>
              <th>Before</th>
              <th>Now</th>
              <th className="num">Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.st}>
                <td>{stateName(r.st)}</td>
                <td className="num">{r.seats}</td>
                <td>
                  <span style={{ color: PARTY_COLOR.D }}>{r.bD}</span>–<span style={{ color: PARTY_COLOR.R }}>{r.bR}</span>
                </td>
                <td>
                  {r.known ? (
                    <>
                      <span style={{ color: PARTY_COLOR.D }}>{r.nD}</span>–<span style={{ color: PARTY_COLOR.R }}>{r.nR}</span>
                      {r.known < r.seats ? <span className="muted"> ({r.seats - r.known} ?)</span> : null}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  {r.dDelta ? <b style={{ color: r.dDelta > 0 ? PARTY_COLOR.D : PARTY_COLOR.R }}>{r.dDelta > 0 ? `D+${r.dDelta}` : `R+${-r.dDelta}`}</b> : <span className="muted">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
