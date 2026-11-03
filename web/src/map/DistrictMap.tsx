import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Party, Race } from '../../../shared/src/types';
import { NEUTRAL, RAMP, inkFor, raceFill, type FillMode } from '../lib/colors';
import { CALLOUTS, NATION_OUTLINE, STATE_BORDERS, STATE_BY_POSTAL_SHAPE, STATE_SHAPES, VIEWBOX, type DistrictShape } from './geo';

export interface DistrictPointer {
  /** Race id, e.g. "TX-H-12". */
  key: string;
  state: string;
  clientX: number;
  clientY: number;
}

interface Props {
  districts: DistrictShape[];
  mode: FillMode;
  races: Record<string, Race>;
  custom?: Record<string, string>;
  hovered: string | null;
  pinned: string | null;
  flashed: Record<string, number>;
  /** State currently zoomed into (postal), or null for the national view. */
  focus: string | null;
  onFocus: (state: string | null) => void;
  onHover: (e: DistrictPointer | null) => void;
  onClick: (e: DistrictPointer) => void;
  onContext?: (e: DistrictPointer) => void;
}

type Box = { x: number; y: number; w: number; h: number };
const HOME: Box = VIEWBOX;
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);

function fit(bounds: [[number, number], [number, number]]): Box {
  const [[x0, y0], [x1, y1]] = bounds;
  const w = x1 - x0;
  const h = y1 - y0;
  const pad = Math.max(w, h) * 0.08 + 4;
  return { x: x0 - pad, y: y0 - pad, w: w + pad * 2, h: h + pad * 2 };
}

/** The 435 district paths, clipped per state to the land outline. Memoized away from hover state. */
const DistrictLayer = memo(function DistrictLayer({
  districts,
  fills,
  focus,
  flashed,
  pointer,
}: {
  districts: DistrictShape[];
  fills: Record<string, { fill: string; hatch?: Party | null; flip?: boolean }>;
  focus: string | null;
  flashed: Record<string, number>;
  pointer: {
    move: (d: DistrictShape, e: React.MouseEvent) => void;
    leave: () => void;
    click: (d: DistrictShape, e: React.MouseEvent) => void;
    dbl: (d: DistrictShape) => void;
    ctx: (d: DistrictShape, e: React.MouseEvent) => void;
  };
}) {
  const byState = useMemo(() => {
    const m = new Map<string, DistrictShape[]>();
    for (const d of districts) {
      if (!m.has(d.st)) m.set(d.st, []);
      m.get(d.st)!.push(d);
    }
    return m;
  }, [districts]);
  const now = Date.now();
  return (
    <>
      {STATE_SHAPES.filter((s) => byState.has(s.postal)).map((s) => (
        <g key={s.postal} clipPath={`url(#dclip-${s.postal})`} className={`dstate ${focus && focus !== s.postal ? 'dimmed' : ''}`}>
          <path d={s.d} fill={NEUTRAL.noData} className="dstate-base" />
          {byState.get(s.postal)!.map((d) => {
            const f = fills[d.id] ?? { fill: NEUTRAL.noData };
            const flash = flashed[d.id] && now - flashed[d.id] < 2500;
            return (
              <path
                key={d.id}
                d={d.d}
                data-district={d.id}
                className={`district ${flash ? 'flash' : ''}`}
                fill={f.hatch ? `url(#dmap-hatch-${f.hatch})` : f.fill}
                onMouseMove={(e) => pointer.move(d, e)}
                onMouseLeave={pointer.leave}
                onClick={(e) => pointer.click(d, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  pointer.dbl(d);
                }}
                onContextMenu={(e) => pointer.ctx(d, e)}
              />
            );
          })}
        </g>
      ))}
    </>
  );
});

export function DistrictMap({ districts, mode, races, custom, hovered, pinned, flashed, focus, onFocus, onHover, onClick, onContext }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [vb, setVb] = useState<Box>(HOME);
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const anim = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; vb: Box; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const animateTo = useCallback((target: Box, ms = 480) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    const from = vbRef.current;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setVb({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);

  // Zoom to the focused state (or back to the nation) whenever focus changes.
  useEffect(() => {
    const shape = focus ? STATE_BY_POSTAL_SHAPE[focus] : null;
    animateTo(shape ? fit(shape.bounds) : HOME);
  }, [focus, animateTo]);

  const fills = useMemo(() => {
    const m: Record<string, { fill: string; hatch?: Party | null; flip?: boolean }> = {};
    for (const d of districts) {
      const race = races[d.id];
      const f = raceFill(race, mode, custom);
      m[d.id] = { fill: f.fill, hatch: f.hatch, flip: !!race?.flip && mode === 'leader' };
    }
    return m;
  }, [districts, races, mode, custom]);

  const toPointer = (d: DistrictShape, e: React.MouseEvent): DistrictPointer => ({ key: d.id, state: d.st, clientX: e.clientX, clientY: e.clientY });
  const pointer = useMemo(
    () => ({
      move: (d: DistrictShape, e: React.MouseEvent) => {
        if (drag.current?.moved) return;
        onHover(toPointer(d, e));
      },
      leave: () => onHover(null),
      click: (d: DistrictShape, e: React.MouseEvent) => {
        e.stopPropagation();
        if (suppressClick.current) return;
        onClick(toPointer(d, e));
      },
      dbl: (d: DistrictShape) => onFocus(d.st),
      ctx: (d: DistrictShape, e: React.MouseEvent) => {
        if (!onContext) return;
        e.preventDefault();
        onContext(toPointer(d, e));
      },
    }),
    [onHover, onClick, onFocus, onContext],
  );

  // ---- wheel zoom about the cursor + drag to pan
  const svgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM()!.inverse());
  };
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (anim.current) cancelAnimationFrame(anim.current);
      const p = svgPoint(e.clientX, e.clientY);
      const cur = vbRef.current;
      const factor = Math.exp(e.deltaY * 0.0015);
      const w = Math.min(HOME.w * 1.1, Math.max(12, cur.w * factor));
      const k = w / cur.w;
      setVb({ x: p.x - (p.x - cur.x) * k, y: p.y - (p.y - cur.y) * k, w, h: cur.h * k });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vb: vbRef.current, moved: false };
    suppressClick.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      onHover(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    }
    const svg = svgRef.current!;
    const scale = Math.max(d.vb.w / svg.clientWidth, d.vb.h / svg.clientHeight);
    setVb({ ...d.vb, x: d.vb.x - dx * scale, y: d.vb.y - dy * scale });
  };
  const onPointerUp = () => {
    if (drag.current?.moved) {
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 50);
    }
    drag.current = null;
  };

  const zoom = HOME.w / vb.w;
  const focusDistricts = focus ? districts.filter((d) => d.st === focus) : [];
  const active = [hovered, pinned].filter(Boolean) as string[];
  const activeShapes = districts.filter((d) => active.includes(d.id));
  const labelSize = Math.max(1.2, Math.min(11, 10 / zoom));

  return (
    <svg
      ref={svgRef}
      className="us-map district-map"
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={(e) => {
        // Double-click on empty ocean returns to the national view.
        if ((e.target as Element).tagName === 'svg') onFocus(null);
      }}
    >
      <defs>
        {(['D', 'R', 'I'] as Party[]).map((p) => (
          <pattern key={p} id={`dmap-hatch-${p}`} patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
            <rect width="3" height="3" fill={RAMP[p].lean} />
            <line x1="0" y1="0" x2="0" y2="3" stroke={RAMP[p].solid} strokeWidth="1.2" />
          </pattern>
        ))}
        {STATE_SHAPES.map((s) => (
          <clipPath key={s.postal} id={`dclip-${s.postal}`}>
            <path d={s.d} />
          </clipPath>
        ))}
        <filter id="dmap-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <DistrictLayer districts={districts} fills={fills} focus={focus} flashed={flashed} pointer={pointer} />
      <path d={STATE_BORDERS} className="state-borders thick" />
      <path d={NATION_OUTLINE} className="nation-outline" />

      {activeShapes.map((d) => (
        <path key={`hl-${d.id}`} d={d.d} clipPath={`url(#dclip-${d.st})`} className={`state-highlight ${d.id === pinned ? 'pinned' : ''}`} />
      ))}

      {/* Flip markers */}
      <g className="flip-markers">
        {districts
          .filter((d) => fills[d.id]?.flip && (!focus || d.st === focus))
          .map((d) => (
            <circle key={`f-${d.id}`} cx={d.c[0]} cy={d.c[1]} r={Math.max(0.6, 2.2 / Math.sqrt(zoom))} className="flip-dot" fill="#fff" />
          ))}
      </g>

      {/* Labels: state postal codes nationally; district numbers when zoomed into a state */}
      {focus ? (
        <g className="labels">
          {focusDistricts.map((d) => {
            const f = fills[d.id];
            return (
              <text key={`l-${d.id}`} x={d.c[0]} y={d.c[1]} dy="0.35em" textAnchor="middle" className="district-label" style={{ fontSize: labelSize }} fill={inkFor(f.hatch ? RAMP[f.hatch].lean : f.fill)}>
                {AT_LARGE.has(d.st) ? 'AL' : d.cd}
              </text>
            );
          })}
        </g>
      ) : zoom < 2.2 ? (
        <g className="labels">
          {STATE_SHAPES.filter((s) => !CALLOUTS.includes(s.postal) && s.area > 600).map((s) => (
            <text key={s.postal} x={s.centroid[0]} y={s.centroid[1]} dy="0.35em" textAnchor="middle" className="state-label haloed" style={{ fontSize: 10 / Math.max(1, zoom) }}>
              {s.postal}
            </text>
          ))}
        </g>
      ) : null}

      {!focus ? (
        <g className="callouts">
          {CALLOUTS.filter((p) => p !== 'DC').map((postal, i) => {
            const s = STATE_BY_POSTAL_SHAPE[postal];
            const y = 150 + i * 27;
            const n = districts.filter((d) => d.st === postal).length;
            return (
              <g key={postal} className="callout has-race" onClick={(e) => (e.stopPropagation(), onFocus(postal))}>
                <line x1={s.centroid[0]} y1={s.centroid[1]} x2={983} y2={y + 10} className="callout-line" />
                <rect x={985} y={y} width={44} height={20} rx={3} fill="#1f2738" className="callout-box" />
                <text x={1007} y={y + 10} dy="0.35em" textAnchor="middle" className="state-label" fill="#cbd3e3">
                  {postal}
                  <tspan fill="#7d879b" fontSize="8">
                    {' '}
                    {n}
                  </tspan>
                </text>
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}
