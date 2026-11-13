import { memo, useMemo } from 'react';
import type { Office, Party, Race } from '../../../shared/src/types';
import { NEUTRAL, RAMP, inkFor, raceFill, type FillMode } from '../lib/colors';
import { CALLOUTS, LABEL_OFFSET, NATION_OUTLINE, STATE_BORDERS, STATE_SHAPES, VIEWBOX } from './geo';

export interface MapPointerEvent {
  state: string;
  clientX: number;
  clientY: number;
}

interface Props {
  office: Office;
  mode: FillMode;
  races: Record<string, Race>;
  /** Prior party for states without a race (governors not up), shown in control mode. */
  noRaceParty?: Record<string, Party>;
  hovered: string | null;
  pinned: string | null;
  flashed: Record<string, number>;
  /** Custom map ratings (raceId -> code) when mode === 'custom'. */
  custom?: Record<string, string>;
  onHover: (e: MapPointerEvent | null) => void;
  onClick: (e: MapPointerEvent) => void;
  /** Right-click (used to erase in custom mode). */
  onContext?: (e: MapPointerEvent) => void;
}

const HATCH_PARTIES: Party[] = ['D', 'R', 'I'];

function USMapImpl({ office, mode, races, noRaceParty, hovered, pinned, flashed, custom, onHover, onClick, onContext }: Props) {
  const fills = useMemo(() => {
    const m: Record<string, { fill: string; hatch?: Party | null; race?: Race; flip?: boolean }> = {};
    for (const s of STATE_SHAPES) {
      const race = races[`${s.postal}-${office}`];
      if (!race && mode === 'control' && noRaceParty?.[s.postal]) {
        m[s.postal] = { fill: RAMP[noRaceParty[s.postal]].tilt };
        continue;
      }
      const f = raceFill(race, mode, custom);
      m[s.postal] = { fill: f.fill, hatch: f.hatch, race, flip: !!race?.flip && mode !== 'custom' };
    }
    return m;
  }, [races, office, mode, noRaceParty, custom]);

  const now = Date.now();
  const ev = (state: string, e: React.MouseEvent): MapPointerEvent => ({ state, clientX: e.clientX, clientY: e.clientY });

  const calloutX = 985;
  const calloutY0 = 150;
  const calloutStep = 27;

  return (
    <svg className="us-map" viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        {HATCH_PARTIES.map((p) => (
          <pattern key={p} id={`map-hatch-${p}`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={RAMP[p].lean} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={RAMP[p].solid} strokeWidth="2.4" />
          </pattern>
        ))}
        <filter id="map-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g className="states">
        {STATE_SHAPES.map((s) => {
          const f = fills[s.postal];
          const isActive = hovered === s.postal || pinned === s.postal;
          const flash = flashed[`${s.postal}-${office}`] && now - flashed[`${s.postal}-${office}`] < 2500;
          return (
            <path
              key={s.postal}
              data-state={s.postal}
              d={s.d}
              className={`state ${f.race ? 'has-race' : 'no-race'} ${isActive ? 'active' : ''} ${flash ? 'flash' : ''}`}
              fill={f.hatch ? `url(#map-hatch-${f.hatch})` : f.fill}
              onMouseMove={(e) => onHover(ev(s.postal, e))}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                onClick(ev(s.postal, e));
              }}
              onContextMenu={(e) => {
                if (!onContext) return;
                e.preventDefault();
                onContext(ev(s.postal, e));
              }}
            />
          );
        })}
      </g>
      <path d={STATE_BORDERS} className="state-borders" />
      <path d={NATION_OUTLINE} className="nation-outline" />

      {/* Flipped seats: a dashed outline just inside the state (clipped to it) plus a dot at the label. */}
      <g className="flip-outlines">
        {STATE_SHAPES.filter((s) => fills[s.postal].flip).map((s) => (
          <g key={`flip-${s.postal}`}>
            <clipPath id={`flip-clip-${s.postal}`}>
              <path d={s.d} />
            </clipPath>
            <path d={s.d} className="flip-outline" clipPath={`url(#flip-clip-${s.postal})`} />
          </g>
        ))}
      </g>

      {/* Highlight outline for hovered/pinned state drawn on top */}
      {STATE_SHAPES.filter((s) => s.postal === hovered || s.postal === pinned).map((s) => (
        <path key={`hl-${s.postal}`} d={s.d} className={`state-highlight ${s.postal === pinned ? 'pinned' : ''}`} />
      ))}

      <g className="labels">
        {STATE_SHAPES.filter((s) => !CALLOUTS.includes(s.postal)).map((s) => {
          const f = fills[s.postal];
          const [dx, dy] = LABEL_OFFSET[s.postal] ?? [0, 0];
          const ink = f.race ? inkFor(f.hatch ? RAMP[f.hatch].lean : f.fill) : '#5d6679';
          return (
            <g key={s.postal} transform={`translate(${s.centroid[0] + dx},${s.centroid[1] + dy})`}>
              <text className="state-label" fill={ink} textAnchor="middle" dy="0.35em">
                {s.postal}
              </text>
              {f.flip ? <circle className="flip-dot" cx={0} cy={12} r={4} fill="#fff" /> : null}
            </g>
          );
        })}
      </g>

      <g className="callouts">
        {CALLOUTS.map((postal, i) => {
          const s = STATE_SHAPES.find((x) => x.postal === postal);
          if (!s) return null;
          const f = fills[postal];
          const y = calloutY0 + i * calloutStep;
          const isActive = hovered === postal || pinned === postal;
          const fill = f.hatch ? `url(#map-hatch-${f.hatch})` : f.fill;
          return (
            <g
              key={postal}
              className={`callout ${f.race ? 'has-race' : 'no-race'} ${isActive ? 'active' : ''}`}
              onMouseMove={(e) => onHover(ev(postal, e))}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                onClick(ev(postal, e));
              }}
              onContextMenu={(e) => {
                if (!onContext) return;
                e.preventDefault();
                onContext(ev(postal, e));
              }}
            >
              <line x1={s.centroid[0]} y1={s.centroid[1]} x2={calloutX - 2} y2={y + 10} className="callout-line" />
              <rect x={calloutX} y={y} width={44} height={20} rx={3} fill={fill} className="callout-box" />
              {f.flip ? <rect x={calloutX + 1.5} y={y + 1.5} width={41} height={17} rx={2} className="flip-outline callout-flip" /> : null}
              <text x={calloutX + 22} y={y + 10} dy="0.35em" textAnchor="middle" className="state-label" fill={f.race ? inkFor(f.hatch ? RAMP[f.hatch].lean : f.fill) : '#5d6679'}>
                {postal}
              </text>
              {f.flip ? <circle className="flip-dot" cx={calloutX + 51} cy={y + 10} r={4} fill="#fff" /> : null}
            </g>
          );
        })}
      </g>
      <text x={20} y={600} className="map-caption" fill={NEUTRAL.tossup}>
        Alaska and Hawaii not to scale
      </text>
    </svg>
  );
}

export const USMap = memo(USMapImpl);
