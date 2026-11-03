import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { fmtNum } from '../../lib/format';

/** National House popular vote, summed across all 435 districts from the live counts. */
export function PopularVote({ races }: { races: Race[] }) {
  let d = 0;
  let r = 0;
  let o = 0;
  let total = 0;
  let expected = 0;
  let uncontested = 0;
  for (const race of races) {
    total += race.totalVotes;
    expected += race.expectedVotes ?? 0;
    if (race.uncontested) uncontested++;
    for (const c of race.candidates) {
      if (c.party === 'D') d += c.votes;
      else if (c.party === 'R') r += c.votes;
      else o += c.votes;
    }
  }
  const sum = d + r + o;
  const pct = (v: number) => (sum ? (v / sum) * 100 : 0);
  const margin = pct(d) - pct(r);
  const counted = expected ? Math.min(100, (total / expected) * 100) : 0;

  return (
    <section className="panel popvote-panel">
      <div className="panel-head">
        <h2>House popular vote</h2>
        <span className="muted small">sum of all districts</span>
      </div>
      <div className="pv-body">
        {sum ? (
          <>
            <div className="pv-nums">
              <div>
                <b style={{ color: PARTY_COLOR.D }}>{pct(d).toFixed(1)}%</b>
                <span>DEM · {fmtNum(d)}</span>
              </div>
              <div className="pv-margin">
                <b style={{ color: margin >= 0 ? PARTY_COLOR.D : PARTY_COLOR.R }}>
                  {margin >= 0 ? 'D' : 'R'}+{Math.abs(margin).toFixed(1)}
                </b>
                <span>margin</span>
              </div>
              <div className="r">
                <b style={{ color: PARTY_COLOR.R }}>{pct(r).toFixed(1)}%</b>
                <span>GOP · {fmtNum(r)}</span>
              </div>
            </div>
            <div className="pv-bar">
              <i style={{ width: `${pct(d)}%`, background: PARTY_COLOR.D }} />
              <i style={{ width: `${pct(o)}%`, background: PARTY_COLOR.I }} />
              <i style={{ width: `${pct(r)}%`, background: PARTY_COLOR.R }} />
              <span className="pv-mid" />
            </div>
          </>
        ) : (
          <div className="empty">Popular vote appears once votes are counted.</div>
        )}
        <div className="pv-progress">
          <div className="rc-progress-bar">
            <div style={{ width: `${counted}%` }} />
          </div>
          <span className="small muted">
            {counted.toFixed(0)}% of expected House vote counted · {fmtNum(total)} of ~{fmtNum(expected)} · other {pct(o).toFixed(1)}%{uncontested ? ` · ${uncontested} uncontested` : ''}
          </span>
        </div>
      </div>
    </section>
  );
}
