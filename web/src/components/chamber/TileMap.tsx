import type { Party, Race } from '../../../../shared/src/types';
import { probToLevel } from '../../../../shared/src/ratings';
import { NEUTRAL, RAMP, inkFor, levelColor } from '../../lib/colors';
import { currentParty, probD } from '../../lib/odds';
import type { HoverFn } from './useRaceHover';

/** Equal-area 50-state tile grid (col, row). */
const TILES: Record<string, [number, number]> = {
  AK: [0, 0], ME: [11, 0],
  VT: [10, 1], NH: [11, 1],
  WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
  OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
  CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
  AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5],
  OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
  HI: [0, 7], TX: [4, 7], FL: [9, 7],
};

/**
 * Tile map: called = solid, leading = hatched, uncalled = shaded by win probability.
 * States without a race show the sitting governor's party, muted.
 */
export function TileMap({ races, notUp, onHover, title }: { races: Record<string, Race>; notUp: Record<string, Party>; onHover: HoverFn; title: string }) {
  const S = 10;
  const G = 0.9;
  return (
    <section className="panel tiles-panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="muted small">solid = called · hatched = leading · faded = odds · dim = not up</span>
      </div>
      <div className="tiles-body">
        <svg viewBox={`0 0 ${12 * S} ${8 * S}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={title}>
          <defs>
            {(['D', 'R', 'I'] as Party[]).map((p) => (
              <pattern key={p} id={`tile-hatch-${p}`} patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(45)">
                <rect width="1.6" height="1.6" fill={RAMP[p].lean} />
                <line x1="0" y1="0" x2="0" y2="1.6" stroke={RAMP[p].solid} strokeWidth="0.7" />
              </pattern>
            ))}
          </defs>
          {Object.entries(TILES).map(([st, [c, r]]) => {
            const race = races[st];
            const cur = race ? currentParty(race) : null;
            let fill: string;
            let sub = '';
            if (!race) {
              fill = notUp[st] ? RAMP[notUp[st]].tilt : NEUTRAL.noRace;
              sub = 'not up';
            } else if (race.winner) {
              fill = RAMP[race.winner].solid;
              sub = (race.winnerName ?? '').split(' ').pop() ?? '';
            } else if (cur) {
              fill = `url(#tile-hatch-${cur})`;
              sub = `${cur}+${(race.margin ?? 0).toFixed(0)}`;
            } else {
              const pd = probD(race);
              fill = levelColor(pd >= 0.5 ? 'D' : 'R', probToLevel(Math.max(pd, 1 - pd)));
              sub = `${pd >= 0.5 ? 'D' : 'R'} ${Math.round(Math.max(pd, 1 - pd) * 100)}`;
            }
            const ink = race ? inkFor(cur && !race.winner ? RAMP[cur].lean : fill.startsWith('#') ? fill : '#333') : '#6b7487';
            return (
              <g
                key={st}
                data-race-id={race?.id}
                transform={`translate(${c * S + (S * (1 - G)) / 2},${r * S + (S * (1 - G)) / 2})`}
                className={`tile ${race ? 'has-race' : ''} ${race?.flip ? 'flip' : ''}`}
                onMouseMove={(e) => race && onHover(race.id, e)}
                onMouseLeave={() => onHover(null)}
              >
                <rect width={S * G} height={S * G} rx={0.8} fill={fill} />
                {race?.flip ? (
                  <>
                    <rect x={0.45} y={0.45} width={S * G - 0.9} height={S * G - 0.9} rx={0.5} className="tile-flip" />
                    <circle cx={S * G - 1.35} cy={1.35} r={0.75} className="tile-flip-dot" />
                    <title>Flipped</title>
                  </>
                ) : null}
                <text x={(S * G) / 2} y={S * G * 0.45} textAnchor="middle" className="tile-st" fill={ink}>
                  {st}
                </text>
                <text x={(S * G) / 2} y={S * G * 0.78} textAnchor="middle" className="tile-sub" fill={ink}>
                  {sub}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
