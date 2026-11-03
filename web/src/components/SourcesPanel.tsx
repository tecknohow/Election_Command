import { useEffect, useState } from 'react';
import { relTime } from '../lib/format';
import { adminLogout, setSimView, simAction, simPause, useAdmin, useElection, useNow, wantsSimView } from '../store/election';

const SPEEDS = [10, 30, 60, 120, 300];

function SimulatorControls() {
  const sim = useElection((s) => s.sim);
  const mode = useElection((s) => s.mode);
  const [speed, setSpeed] = useState(sim?.speed || 60);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewing = wantsSimView();

  const run = async (a: 'start' | 'stop' | 'speed' | 'pause' | 'resume', s?: number) => {
    setBusy(true);
    setErr(null);
    try {
      if (a === 'pause' || a === 'resume') await simPause(a === 'pause');
      else await simAction(a, s);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!sim?.allowed) return <p className="muted small">Simulator disabled on this server (SIM_ALLOWED=false).</p>;
  return (
    <div className="sim-controls">
      <p className="muted small">
        Replays a compressed election night over the real candidates, poll closings, forecasts and odds. The simulation runs in a <b>separate, private copy</b> of the data:
        only admin windows that switch to it see simulated results. Everyone else keeps seeing live data.
      </p>
      <div className="row">
        <label>
          Speed&nbsp;
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
        {sim.running ? (
          <>
            <button className={sim.paused ? 'primary' : ''} disabled={busy} onClick={() => run(sim.paused ? 'resume' : 'pause')}>
              {sim.paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button disabled={busy} onClick={() => run('speed', speed)}>
              Apply speed
            </button>
            <button disabled={busy} onClick={() => run('start', speed)}>
              Restart
            </button>
            <button className="danger" disabled={busy} onClick={() => run('stop')}>
              Stop simulation
            </button>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={() => run('start', speed)}>
            Start simulation
          </button>
        )}
      </div>
      {sim.running ? (
        <div className="row">
          <span className="small">This window shows:</span>
          <button className={!viewing ? 'primary' : ''} onClick={() => setSimView(false)}>
            Live data
          </button>
          <button className={viewing ? 'primary' : ''} onClick={() => setSimView(true)}>
            Simulation
          </button>
          <span className="muted small">{mode === 'simulation' ? 'viewing simulation' : 'viewing live'}</span>
        </div>
      ) : null}
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}

export function SourcesPanel({ onClose }: { onClose: () => void }) {
  useNow(2000);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const sources = useElection((s) => s.sources);
  const { admin } = useAdmin();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Data sources</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted small">
          One server polls each upstream on behalf of every open window (conditional GETs, jittered, exponential backoff). Intervals tighten automatically during the election-night window.
        </p>
        <table className="sources-table">
          <thead>
            <tr>
              <th />
              <th>Source</th>
              <th>Role</th>
              <th>Last success</th>
              <th>Every</th>
              <th>Requests / 304s</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <i className={`dot ${!s.enabled ? 'off' : s.ok ? 'ok' : s.lastAttempt ? 'bad' : 'wait'}`} />
                </td>
                <td className="nowrap">{s.name}</td>
                <td className="muted">{s.role}</td>
                <td className="nowrap">{s.lastSuccess ? relTime(s.lastSuccess) : '—'}</td>
                <td className="nowrap">{Math.round(s.intervalMs / 1000)}s</td>
                <td className="nowrap">
                  {s.requests} / {s.notModified}
                </td>
                <td className={s.lastError ? 'err' : 'muted'}>{s.lastError ?? s.detail ?? (s.enabled ? 'waiting' : 'disabled')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {admin ? (
          <div className="admin-section">
            <div className="admin-head">
              <h3>Simulator</h3>
              <button className="link-btn" onClick={() => void adminLogout().then(onClose)}>
                Sign out
              </button>
            </div>
            <SimulatorControls />
          </div>
        ) : null}
      </div>
    </div>
  );
}
