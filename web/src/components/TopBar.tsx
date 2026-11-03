import { useState } from 'react';
import { NavLink } from 'react-router';
import { fmtEt, fmtEtClock } from '../lib/format';
import { useAdmin, useElection, useNow } from '../store/election';
import { usePrefs } from '../lib/prefs';
import { useAudioState } from '../lib/sound';
import { KioskChip } from './Kiosk';
import { SettingsMenu } from './SettingsMenu';
import { SourcesPanel } from './SourcesPanel';

type Group = 'Overview' | 'Desks' | 'Maps' | 'Measures';

/** Number keys follow the order the views appear in the nav. */
export const VIEWS: { path: string; label: string; key: string; group: Group; soon?: boolean }[] = [
  { path: '/', label: 'Overview', key: '1', group: 'Overview' },
  { path: '/mine', label: '★ My Races', key: '2', group: 'Overview' },
  { path: '/senate', label: 'Senate', key: '3', group: 'Desks' },
  { path: '/house', label: 'House', key: '4', group: 'Desks' },
  { path: '/governors', label: 'Governors', key: '5', group: 'Desks' },
  { path: '/map/senate', label: 'Senate', key: '6', group: 'Maps' },
  { path: '/map/governor', label: 'Governor', key: '7', group: 'Maps' },
  { path: '/map/house', label: 'House', key: '8', group: 'Maps' },
  { path: '/ballot', label: 'Ballot Measures', key: '9', group: 'Measures' },
];

export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

export function TopBar() {
  const now = useNow(1000);
  const connected = useElection((s) => s.connected);
  const mode = useElection((s) => s.mode);
  const sim = useElection((s) => s.sim);
  const sources = useElection((s) => s.sources);
  const [panel, setPanel] = useState(false);
  const admin = useAdmin((s) => s.admin);
  const soundOn = usePrefs((s) => s.alertsSound);
  const audioBlocked = useAudioState((s) => s.blocked);
  const enabled = sources.filter((s) => s.enabled);
  // Sources that haven't run their first poll yet count as pending, not failing.
  const okCount = enabled.filter((s) => s.ok || !s.lastAttempt).length;
  const health = !enabled.length ? 'unknown' : okCount === enabled.length ? 'ok' : okCount === 0 ? 'down' : 'degraded';

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <i style={{ background: '#4d8ef7' }} />
            <i style={{ background: '#f0545a' }} />
          </span>
          <span className="brand-name">ELECTION COMMAND</span>
          <span className="brand-date">Nov 3, 2026</span>
        </div>
        <nav className="views">
          {VIEWS.map((v, i) => {
            const newGroup = i === 0 || VIEWS[i - 1].group !== v.group;
            return (
              <span key={v.path} className="nav-item">
                {newGroup && i > 0 ? <span className="nav-sep" /> : null}
                {newGroup && (v.group === 'Desks' || v.group === 'Maps') ? <span className="nav-group-label">{v.group}</span> : null}
                <NavLink to={v.path} end={v.path === '/'} className={({ isActive }) => `view-tab ${isActive ? 'active' : ''} ${v.soon ? 'soon' : ''}`}>
                  <kbd>{v.key}</kbd>
                  {v.label}
                  {v.soon ? <span className="soon-tag">soon</span> : null}
                </NavLink>
              </span>
            );
          })}
        </nav>
        <div className="topbar-right">
          <span className={`mode-badge ${mode}`}>{mode === 'simulation' ? 'SIMULATION' : 'LIVE'}</span>
          <KioskChip />
          {soundOn && audioBlocked ? (
            <span className="sound-hint" title="Browsers block audio until you interact with the page">
              🔇 click to enable sound
            </span>
          ) : null}
          {admin ? (
            <button className={`health health-${health}`} onClick={() => setPanel(true)} title="Data sources & simulator">
              <i />
              Sources {okCount}/{enabled.length}
            </button>
          ) : (
            <span className={`health health-${health} static`} title={`${okCount} of ${enabled.length} data sources healthy`}>
              <i />
              Sources {okCount}/{enabled.length}
            </span>
          )}
          <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'Streaming updates' : 'Reconnecting…'}>
            {connected ? '● Connected' : '○ Reconnecting'}
          </span>
          <span className="clock">{fmtEtClock(new Date(now))} ET</span>
          <SettingsMenu onOpenSources={() => setPanel(true)} />
          <button className="icon-btn" onClick={toggleFullscreen} title="Fullscreen (F)">
            ⛶
          </button>
        </div>
      </header>
      {mode === 'simulation' && sim ? (
        <div className="sim-banner">
          SIMULATION MODE — synthetic results for testing only · simulated time <b>{fmtEt(sim.simTime)} ET</b> · {sim.speed}× speed
          {admin ? <button onClick={() => setPanel(true)}>Controls</button> : null}
        </div>
      ) : null}
      {panel && admin ? <SourcesPanel onClose={() => setPanel(false)} /> : null}
    </>
  );
}
