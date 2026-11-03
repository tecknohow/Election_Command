import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { create } from 'zustand';
import { useKioskState, usePrefs } from '../lib/prefs';
import { useAlerts } from './BreakingAlerts';

/** Rotation starts after this long without mouse / keyboard / touch input in this window. */
export const KIOSK_IDLE_MS = 60_000;

export const useKioskStatus = create<{ rotating: boolean; secondsToNext: number; idleIn: number }>(() => ({
  rotating: false,
  secondsToNext: 0,
  idleIn: 0,
}));

function viewIndex(paths: string[], pathname: string): number {
  return paths.findIndex((p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`)));
}

/**
 * Kiosk mode: when this window has been idle for a minute, step through the configured views
 * every N seconds. Any interaction pauses it; breaking alerts hold the current view until dismissed.
 */
export function useKiosk() {
  const enabled = useKioskState((s) => s.enabled);
  const interval = usePrefs((s) => s.kioskInterval);
  const views = usePrefs((s) => s.kioskViews);
  const navigate = useNavigate();
  const location = useLocation();
  const lastInput = useRef(Date.now());
  const lastRotate = useRef(Date.now());
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;

  useEffect(() => {
    const mark = () => {
      lastInput.current = Date.now();
    };
    const evs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, mark, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, mark));
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const idleFor = now - lastInput.current;
      const alertShowing = useAlerts.getState().queue.length > 0 && usePrefs.getState().alertsBanner;
      const order = views.length ? views : ['/'];
      const rotating = enabled && idleFor >= KIOSK_IDLE_MS && order.length > 1;
      if (!rotating || alertShowing) {
        lastRotate.current = Math.max(lastRotate.current, now - interval * 1000 + 5_000);
        useKioskStatus.setState({ rotating: false, secondsToNext: 0, idleIn: Math.max(0, Math.ceil((KIOSK_IDLE_MS - idleFor) / 1000)) });
        return;
      }
      const due = lastRotate.current + interval * 1000;
      if (now >= due) {
        const i = viewIndex(order, pathRef.current);
        navigate(order[(i + 1) % order.length]);
        lastRotate.current = now;
      }
      useKioskStatus.setState({ rotating: true, secondsToNext: Math.max(0, Math.ceil((lastRotate.current + interval * 1000 - now) / 1000)), idleIn: 0 });
    }, 1000);
    return () => clearInterval(t);
  }, [enabled, interval, views, navigate]);
}

/** Top-bar chip: shows the countdown while rotating; click toggles kiosk for this window. */
export function KioskChip() {
  const enabled = useKioskState((s) => s.enabled);
  const setEnabled = useKioskState((s) => s.setEnabled);
  const { rotating, secondsToNext, idleIn } = useKioskStatus();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!enabled) return null;
  return (
    <button
      className={`kiosk-chip ${rotating ? 'on' : ''}`}
      onClick={() => setEnabled(false)}
      title={rotating ? 'Kiosk rotating; click to turn off for this window' : `Kiosk starts after ${idleIn}s idle; click to turn off for this window`}
    >
      ⟳ {rotating ? `next ${secondsToNext}s` : 'kiosk'}
    </button>
  );
}
