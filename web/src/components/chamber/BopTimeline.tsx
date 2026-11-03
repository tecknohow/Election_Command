import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChamberSummary, Office } from '../../../../shared/src/types';
import { PARTY_COLOR } from '../../lib/colors';
import { fmtEt } from '../../lib/format';
import { useElection } from '../../store/election';

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/**
 * Seats secured over the night (called races + seats not up), one line per party, with the
 * control threshold. Hover for a crosshair readout. Points recorded before called counts were
 * stored are skipped rather than mixed in.
 */
export function BopTimeline({ office, chamber }: { office: Office; chamber: ChamberSummary }) {
  const history = useElection((s) => s.bopHistory);
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const isSenate = office === 'S';
  const threshold = office === 'G' ? 26 : chamber.toControl.D;

  const pts = useMemo(
    () =>
      history.flatMap((p) => {
        const v = p.called?.[office];
        return v ? [{ t: Date.parse(p.t), D: v.D + (isSenate ? v.I : 0), R: v.R }] : [];
      }),
    [history, office, isSenate],
  );

  const pad = { l: 34, r: 44, t: 10, b: 22 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = Math.max(10, h - pad.t - pad.b);
  const t0 = pts[0]?.t ?? 0;
  const t1 = pts.length > 1 ? pts[pts.length - 1].t : t0 + 1;
  const vals = pts.flatMap((p) => [p.D, p.R]).concat(threshold);
  const y0 = Math.max(0, Math.floor((Math.min(...vals) - 4) / 5) * 5);
  const y1 = Math.min(chamber.total, Math.ceil((Math.max(...vals) + 4) / 5) * 5);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * iw;
  const y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * ih;
  const line = (k: 'D' | 'R') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join('');
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round(y0 + ((y1 - y0) * i) / 4));
  const timeTicks = pts.length > 1 ? Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * i) / 3) : [];
  const last = pts[pts.length - 1];
  const hp = hoverIdx != null ? pts[hoverIdx] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (pts.length < 2) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - pad.l) / iw) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    setHoverIdx(best);
  };

  return (
    <section className="panel timeline-panel">
      <div className="panel-head">
        <h2>Seats over the night</h2>
        <span className="muted small">called + not up · {threshold} for {office === 'G' ? 'majority' : 'control'}</span>
      </div>
      <div className="timeline-body" ref={ref}>
        {pts.length < 2 ? (
          <div className="empty">The timeline starts when the first votes are counted.</div>
        ) : (
          <svg width={w} height={h} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)} role="img" aria-label="Seats secured over time">
            {ticks.map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={pad.l + iw} y1={y(v)} y2={y(v)} className="grid-line" />
                <text x={pad.l - 6} y={y(v)} dy="0.35em" textAnchor="end" className="axis-label">
                  {v}
                </text>
              </g>
            ))}
            {timeTicks.map((t) => (
              <text key={t} x={x(t)} y={h - 6} textAnchor="middle" className="axis-label">
                {fmtEt(t)}
              </text>
            ))}
            <line x1={pad.l} x2={pad.l + iw} y1={y(threshold)} y2={y(threshold)} className="threshold-line" />
            <text x={pad.l + iw + 4} y={y(threshold)} dy="0.35em" className="axis-label strong">
              {threshold}
            </text>
            <path d={line('D')} fill="none" stroke={PARTY_COLOR.D} strokeWidth={2} />
            <path d={line('R')} fill="none" stroke={PARTY_COLOR.R} strokeWidth={2} />
            {last ? (
              <>
                <text x={x(last.t) + 6} y={y(last.D)} dy="0.35em" className="end-label" fill={PARTY_COLOR.D}>
                  D {last.D}
                </text>
                <text x={x(last.t) + 6} y={y(last.R)} dy="0.35em" className="end-label" fill={PARTY_COLOR.R}>
                  R {last.R}
                </text>
              </>
            ) : null}
            {hp ? (
              <g>
                <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
                <circle cx={x(hp.t)} cy={y(hp.D)} r={4} fill={PARTY_COLOR.D} stroke="#0b0e14" strokeWidth={2} />
                <circle cx={x(hp.t)} cy={y(hp.R)} r={4} fill={PARTY_COLOR.R} stroke="#0b0e14" strokeWidth={2} />
              </g>
            ) : null}
          </svg>
        )}
        {hp ? (
          <div className="chart-tip" style={{ left: Math.min(w - 130, Math.max(0, x(hp.t) + 10)), top: 6 }}>
            <div className="muted">{fmtEt(hp.t)} ET</div>
            <div style={{ color: PARTY_COLOR.D }}>Dem{isSenate ? '+Ind' : ''} {hp.D}</div>
            <div style={{ color: PARTY_COLOR.R }}>GOP {hp.R}</div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
