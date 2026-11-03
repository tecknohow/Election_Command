import { useMemo } from 'react';
import type { ChamberSummary, Race } from '../../../../shared/src/types';
import { probToLevel } from '../../../../shared/src/ratings';
import { PARTY_COLOR, RAMP, levelColor } from '../../lib/colors';
import { currentParty, probD } from '../../lib/odds';
import type { HoverFn } from './useRaceHover';

const ROWS = 12;

/** Seat coordinates for an N-seat hemicycle (rows weighted by arc length), ordered left -> right. */
function layout(n: number) {
  const r0 = 0.38;
  const radii = Array.from({ length: ROWS }, (_, i) => r0 + ((1 - r0) * i) / (ROWS - 1));
  const total = radii.reduce((s, r) => s + r, 0);
  const counts = radii.map((r) => Math.floor((n * r) / total));
  let left = n - counts.reduce((s, c) => s + c, 0);
  for (let i = ROWS - 1; left > 0; i = (i - 1 + ROWS) % ROWS, left--) counts[i]++;
  const seats: { x: number; y: number; a: number }[] = [];
  radii.forEach((r, i) => {
    const c = counts[i];
    for (let j = 0; j < c; j++) {
      const a = Math.PI - (Math.PI * (j + 0.5)) / c;
      seats.push({ x: Math.cos(a) * r, y: -Math.sin(a) * r, a });
    }
  });
  return seats.sort((p, q) => q.a - p.a);
}

/**
 * 435-seat House hemicycle. Seats are ordered from the safest Democratic seat (left) to the
 * safest Republican seat (right): called seats solid, leading seats lighter, uncalled seats
 * faded by their pre-results lean. The vertical line marks the 218th seat.
 */
export function Hemicycle({ chamber, races, onHover }: { chamber: ChamberSummary; races: Race[]; onHover: HoverFn }) {
  const seats = useMemo(() => layout(races.length), [races.length]);
  const ordered = useMemo(() => {
    const score = (r: Race) => {
      if (r.winner) return (r.winner === 'R' ? -1 : 1) * (1000 + (r.margin ?? 0));
      const cur = currentParty(r);
      if (cur) return (cur === 'R' ? -1 : 1) * (500 + (r.margin ?? 0));
      return (probD(r) - 0.5) * 100;
    };
    return [...races].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  }, [races]);

  const dWon = chamber.won.D;
  const rWon = chamber.won.R;
  const dLead = chamber.leading.D;
  const rLead = chamber.leading.R;
  const dot = 0.024;

  return (
    <section className="panel hemi-panel">
      <div className="panel-head">
        <h2>The House floor</h2>
        <span className="muted small">safest D (left) → safest R (right) · 218 for majority</span>
      </div>
      <div className="hemi-body">
        <svg viewBox="-1.05 -1.05 2.1 1.18" preserveAspectRatio="xMidYMid meet" role="img" aria-label="House seats">
          {seats.map((s, i) => {
            const r = ordered[i];
            if (!r) return null;
            const cur = currentParty(r);
            const pd = probD(r);
            const fill = r.winner ? RAMP[r.winner].solid : cur ? RAMP[cur].likely : levelColor(pd >= 0.5 ? 'D' : 'R', probToLevel(Math.max(pd, 1 - pd)));
            return (
              <circle
                key={r.id}
                data-race-id={r.id}
                cx={s.x}
                cy={s.y}
                r={dot}
                fill={fill}
                opacity={r.winner ? 1 : cur ? 0.95 : 0.4}
                className="hemi-seat"
                onMouseMove={(e) => onHover(r.id, e)}
                onMouseLeave={() => onHover(null)}
              />
            );
          })}
          <line x1={0} y1={-1.03} x2={0} y2={-0.33} className="hemi-mid" />
          <text x={-0.12} y={-0.12} textAnchor="end" className="hemi-num" fill={PARTY_COLOR.D}>
            {dWon + dLead}
          </text>
          <text x={0.12} y={-0.12} textAnchor="start" className="hemi-num" fill={PARTY_COLOR.R}>
            {rWon + rLead}
          </text>
          <text x={0} y={0.07} textAnchor="middle" className="hemi-sub">
            won {dWon} · lead {dLead} | won {rWon} · lead {rLead}
          </text>
        </svg>
      </div>
    </section>
  );
}
