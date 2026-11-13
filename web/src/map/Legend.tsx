import type { Office } from '../../../shared/src/types';
import { NEUTRAL, PARTY_COLOR, RAMP, type FillMode } from '../lib/colors';

const Sw = ({ c, hatch }: { c: string; hatch?: 'D' | 'R' | 'I' }) => (
  <i className={`sw ${hatch ? `hatch-${hatch}` : ''}`} style={hatch ? { ['--seg' as string]: RAMP[hatch].likely } : { background: c }} />
);

function Ramp({ labels }: { labels: string[] }) {
  const levels = ['solid', 'likely', 'lean', 'tilt'] as const;
  return (
    <div className="legend-ramp">
      <div className="ramp-row">
        {levels.map((l) => (
          <Sw key={`d${l}`} c={RAMP.D[l]} />
        ))}
        <Sw c={NEUTRAL.tossup} />
        {[...levels].reverse().map((l) => (
          <Sw key={`r${l}`} c={RAMP.R[l]} />
        ))}
      </div>
      <div className="ramp-labels">
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  );
}

export function Legend({ mode, office }: { mode: FillMode; office: Office }) {
  return (
    <div className="legend">
      {mode === 'leader' ? (
        <>
          <div className="legend-title">Vote count</div>
          <div className="legend-items">
            <span><Sw c={PARTY_COLOR.D} />D called</span>
            <span><Sw c={PARTY_COLOR.R} />R called</span>
            <span><Sw c={PARTY_COLOR.I} />Ind. called</span>
            <span><Sw c="" hatch="D" />D leading</span>
            <span><Sw c="" hatch="R" />R leading</span>
            <span><Sw c={NEUTRAL.closed} />Polls closed</span>
            <span><Sw c={NEUTRAL.upcoming} />Polls open</span>
            <span><i className="flip-legend"><i className="flip-dot-legend" /></i>Seat flipped</span>
          </div>
        </>
      ) : mode === 'market' ? (
        <>
          <div className="legend-title">Polymarket implied win probability</div>
          <Ramp labels={['≥90%', '75%', '60%', '53%', 'Toss-up', '53%', '60%', '75%', '≥90%']} />
        </>
      ) : mode === 'forecast' ? (
        <>
          <div className="legend-title">
            FLIPR (Silver Bulletin) rating · Cook if unavailable{office === 'H' ? ' · seats not rated competitive shown as Safe for the incumbent party' : ''}
          </div>
          <Ramp labels={['Solid', 'Likely', 'Lean', 'Tilt', 'Toss-up', 'Tilt', 'Lean', 'Likely', 'Solid']} />
        </>
      ) : (
        <>
          <div className="legend-title">Party holding the seat before the election</div>
          <div className="legend-items">
            <span><Sw c={RAMP.D.likely} />Democrat</span>
            <span><Sw c={RAMP.R.likely} />Republican</span>
            <span><Sw c={RAMP.I.likely} />Independent</span>
            {office === 'G' ? (
              <>
                <span><Sw c={RAMP.D.tilt} />D (not up)</span>
                <span><Sw c={RAMP.R.tilt} />R (not up)</span>
              </>
            ) : null}
          </div>
        </>
      )}
      {office !== 'H' ? (
        <div className="legend-items muted">
          {mode !== 'leader' && mode !== 'custom' ? <span><i className="flip-legend"><i className="flip-dot-legend" /></i>Seat flipped (called)</span> : null}
          <span><Sw c={NEUTRAL.noRace} />No {office === 'S' ? 'Senate' : 'governor'} race</span>
        </div>
      ) : null}
    </div>
  );
}
