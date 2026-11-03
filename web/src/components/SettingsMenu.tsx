import { useEffect, useRef, useState } from 'react';
import { KIOSK_VIEWS, useKioskState, usePrefs } from '../lib/prefs';
import { chime, unlockAudio, useAudioState } from '../lib/sound';
import { useWatchlist } from '../lib/watchlist';
import { adminLogin, adminLogout, useAdmin } from '../store/election';
import { AboutPanel } from './AboutPanel';
import { KIOSK_IDLE_MS } from './Kiosk';

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <button type="button" role="switch" aria-checked={on} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
        <i />
      </button>
    </label>
  );
}

function AdminSection({ onOpenSources }: { onOpenSources: () => void }) {
  const { admin, adminEnabled } = useAdmin();
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!adminEnabled) return null;
  return (
    <section className="settings-section">
      <h4>Admin</h4>
      {admin ? (
        <div className="settings-row">
          <span className="ok-text">Signed in</span>
          <button onClick={onOpenSources}>Data sources & simulator…</button>
          <button className="link-btn" onClick={() => void adminLogout()}>
            Sign out
          </button>
        </div>
      ) : (
        <form
          className="admin-signin"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              await adminLogin(token);
              setToken('');
            } catch (x) {
              setErr((x as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="password" autoComplete="current-password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="submit" disabled={busy || !token}>
            Sign in
          </button>
          {err ? <span className="err small">{err}</span> : null}
        </form>
      )}
    </section>
  );
}

/** Gear menu: breaking alerts, sound, kiosk (per window), My races, admin sign-in. */
export function SettingsMenu({ onOpenSources }: { onOpenSources: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prefs = usePrefs();
  const kiosk = useKioskState();
  const blocked = useAudioState((s) => s.blocked);
  const watchCount = useWatchlist((s) => s.ids.length);
  const clearWatch = useWatchlist((s) => s.clear);
  const [confirmClear, setConfirmClear] = useState(false);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings" ref={ref}>
      <button className={`icon-btn gear ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Settings" aria-expanded={open}>
        ⚙
      </button>
      {open ? (
        <div className="settings-pop" role="dialog" aria-label="Settings">
          <section className="settings-section">
            <h4>Breaking alerts</h4>
            <Toggle on={prefs.alertsBanner} onChange={(v) => prefs.set({ alertsBanner: v })} label="Alert banner" hint="Key-race calls, flips, your races, chamber control" />
            <Toggle
              on={prefs.alertsSound}
              onChange={(v) => {
                if (v) unlockAudio();
                prefs.set({ alertsSound: v });
              }}
              label="Alert sound"
              hint={prefs.alertsSound && blocked ? 'Click anywhere on the page once to allow audio' : 'Chime with each alert'}
            />
            <div className="settings-row">
              <label className="small">
                Alert on&nbsp;
                <select value={prefs.alertScope} onChange={(e) => prefs.set({ alertScope: e.target.value as 'key' | 'all' })}>
                  <option value="key">Key races, flips, my races, control</option>
                  <option value="all">Every Senate &amp; Governor call too</option>
                </select>
              </label>
              <button
                className="small"
                onClick={() => {
                  unlockAudio();
                  setTimeout(() => chime('flip'), 50);
                }}
              >
                Test sound
              </button>
            </div>
          </section>

          <section className="settings-section">
            <h4>Kiosk mode · this window</h4>
            <Toggle
              on={kiosk.enabled}
              onChange={kiosk.setEnabled}
              label="Rotate views when idle"
              hint={`Starts after ${KIOSK_IDLE_MS / 1000}s without mouse/keyboard; any interaction pauses it`}
            />
            <div className="settings-row">
              <label className="small">
                Every&nbsp;
                <select value={prefs.kioskInterval} onChange={(e) => prefs.set({ kioskInterval: Number(e.target.value) })}>
                  {[20, 30, 45, 60, 90, 120, 300].map((s) => (
                    <option key={s} value={s}>
                      {s < 60 ? `${s} s` : `${s / 60} min`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="kiosk-views">
              {KIOSK_VIEWS.map((v) => (
                <label key={v.path} className="check">
                  <input
                    type="checkbox"
                    checked={prefs.kioskViews.includes(v.path)}
                    onChange={(e) => {
                      const next = e.target.checked ? KIOSK_VIEWS.map((x) => x.path).filter((p) => p === v.path || prefs.kioskViews.includes(p)) : prefs.kioskViews.filter((p) => p !== v.path);
                      prefs.set({ kioskViews: next });
                    }}
                  />
                  {v.label}
                </label>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <h4>My races</h4>
            <Toggle on={prefs.showDock} onChange={(v) => prefs.set({ showDock: v })} label="Show My races bar" hint={`${watchCount} starred · stored only in this browser`} />
            {watchCount ? (
              confirmClear ? (
                <div className="settings-row">
                  <span className="small">Remove all {watchCount}?</span>
                  <button
                    className="danger"
                    onClick={() => {
                      clearWatch();
                      setConfirmClear(false);
                    }}
                  >
                    Clear
                  </button>
                  <button onClick={() => setConfirmClear(false)}>Cancel</button>
                </div>
              ) : (
                <button className="link-btn" onClick={() => setConfirmClear(true)}>
                  Clear My races
                </button>
              )
            ) : (
              <p className="muted small">Star (☆) a race on any race card, table or detail page.</p>
            )}
          </section>

          <AdminSection
            onOpenSources={() => {
              setOpen(false);
              onOpenSources();
            }}
          />

          <section className="settings-section">
            <h4>About</h4>
            <button
              className="link-btn"
              onClick={() => {
                setOpen(false);
                setAbout(true);
              }}
            >
              Data sources, attributions &amp; disclaimer
            </button>
            <p className="muted small">Unofficial results from third-party feeds. Not affiliated with any news organization or market.</p>
          </section>
        </div>
      ) : null}
      {about ? <AboutPanel onClose={() => setAbout(false)} /> : null}
    </div>
  );
}
