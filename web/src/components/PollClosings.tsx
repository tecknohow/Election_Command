import { useMemo } from 'react';
import { countdown, fmtEt } from '../lib/format';
import { useElection, useNow } from '../store/election';

/** Timeline of poll-closing waves; highlights states with Senate/Governor races. */
export function PollClosings() {
  const realNow = useNow(1000);
  const closings = useElection((s) => s.pollClosings);
  const races = useElection((s) => s.races);
  const mode = useElection((s) => s.mode);
  const sim = useElection((s) => s.sim);
  const now = mode === 'simulation' && sim?.simTime ? Date.parse(sim.simTime) : realNow;

  const waves = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of closings) {
      if (!m.has(c.time)) m.set(c.time, []);
      m.get(c.time)!.push(c.state);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [closings]);

  const next = waves.find(([t]) => Date.parse(t) > now);

  return (
    <section className="panel closings">
      <div className="panel-head">
        <h2>Poll closings</h2>
        {next ? (
          <span className="countdown">
            Next: <b>{fmtEt(next[0])} ET</b> in <b>{countdown(Date.parse(next[0]) - now)}</b>
          </span>
        ) : (
          <span className="muted small">All polls closed</span>
        )}
      </div>
      <div className="wave-list">
        {waves.map(([t, states]) => {
          const past = Date.parse(t) <= now;
          const isNext = next?.[0] === t;
          return (
            <div key={t} className={`wave ${past ? 'past' : ''} ${isNext ? 'next' : ''}`}>
              <div className="wave-time">
                {past ? '✓ ' : ''}
                {fmtEt(t)}
              </div>
              <div className="wave-states">
                {states.sort().map((s) => {
                  const key = races[`${s}-S`] || races[`${s}-G`];
                  return (
                    <span key={s} className={`st-chip ${key ? 'key' : ''}`} title={key ? 'Senate and/or Governor race' : 'House races only'}>
                      {s}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
