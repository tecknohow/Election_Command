import { useMemo, useState } from 'react';
import type { Race } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { stateName } from '../../lib/format';
import { probD } from '../../lib/odds';
import type { HoverFn } from './useRaceHover';

type Mode = 'margin' | 'odds';

/** Democratic margin (D% - R%) from the top D and R candidates, or null before votes. */
function dMargin(r: Race): number | null {
  if (!r.totalVotes) return null;
  const d = r.candidates.find((c) => c.party === 'D')?.pct ?? 0;
  const rep = r.candidates.find((c) => c.party === 'R')?.pct ?? 0;
  return d - rep;
}

/**
 * Ticket splitting in states with both a Senate and a Governor race: a dumbbell per state
 * comparing the Democratic margin (or pre-results win odds) in the two contests.
 */
export function SplitTicket({ races, onHover }: { races: Record<string, Race>; onHover: HoverFn }) {
  const pairs = useMemo(() => {
    const states = [...new Set(Object.values(races).filter((r) => r.office === 'G').map((r) => r.state))].filter((st) => races[`${st}-S`]);
    return states.map((st) => ({ st, s: races[`${st}-S`], g: races[`${st}-G`] }));
  }, [races]);
  const anyVotes = pairs.some((p) => dMargin(p.s) != null && dMargin(p.g) != null);
  const [modeSel, setMode] = useState<Mode | null>(null);
  const mode: Mode = modeSel ?? (anyVotes ? 'margin' : 'odds');

  const rows = pairs
    .map((p) => {
      const sv = mode === 'margin' ? dMargin(p.s) : probD(p.s) * 100 - 50;
      const gv = mode === 'margin' ? dMargin(p.g) : probD(p.g) * 100 - 50;
      return { ...p, sv, gv, gap: sv != null && gv != null ? Math.abs(sv - gv) : -1 };
    })
    .sort((a, b) => b.gap - a.gap);
  const span = mode === 'margin' ? 30 : 50;
  const pos = (v: number) => 50 + (Math.max(-span, Math.min(span, v)) / span) * 50;

  return (
    <section className="panel split-panel">
      <div className="panel-head">
        <h2>Ticket splitting</h2>
        <div className="chips">
          <button className={`chip ${mode === 'margin' ? 'on' : ''}`} onClick={() => setMode('margin')}>
            Vote margin
          </button>
          <button className={`chip ${mode === 'odds' ? 'on' : ''}`} onClick={() => setMode('odds')}>
            Win odds
          </button>
        </div>
      </div>
      <div className="split-axis small muted">
        <span>{mode === 'margin' ? `R+${span}` : 'R 100%'}</span>
        <span>● Senate ◆ Governor</span>
        <span>{mode === 'margin' ? `D+${span}` : 'D 100%'}</span>
      </div>
      <ul className="split-list">
        {rows.map((r) => (
          <li key={r.st}>
            <span className="sp-state">{stateName(r.st)}</span>
            <span className="sp-track">
              <i className="sp-mid" />
              {r.sv != null && r.gv != null ? <i className="sp-link" style={{ left: `${Math.min(pos(r.sv), pos(r.gv))}%`, width: `${Math.abs(pos(r.sv) - pos(r.gv))}%` }} /> : null}
              {r.sv != null ? (
                <i
                  className="sp-dot"
                  style={{ left: `${pos(r.sv)}%`, background: r.sv >= 0 ? PARTY_COLOR.D : PARTY_COLOR.R }}
                  onMouseMove={(e) => onHover(r.s.id, e)}
                  onMouseLeave={() => onHover(null)}
                />
              ) : null}
              {r.gv != null ? (
                <i
                  className="sp-diamond"
                  style={{ left: `${pos(r.gv)}%`, background: r.gv >= 0 ? PARTY_COLOR.D : PARTY_COLOR.R }}
                  onMouseMove={(e) => onHover(r.g.id, e)}
                  onMouseLeave={() => onHover(null)}
                />
              ) : null}
            </span>
            <span className="sp-gap">{r.gap >= 0 ? `${r.gap.toFixed(mode === 'margin' ? 1 : 0)} pt` : '—'}</span>
          </li>
        ))}
        {!rows.length ? <li className="empty">No states with both races</li> : null}
      </ul>
    </section>
  );
}
