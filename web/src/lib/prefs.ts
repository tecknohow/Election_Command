import { create } from 'zustand';

/** Kiosk-rotatable views, in default rotation order. */
export const KIOSK_VIEWS: { path: string; label: string }[] = [
  { path: '/', label: 'Overview' },
  { path: '/mine', label: 'My Races' },
  { path: '/senate', label: 'Senate desk' },
  { path: '/house', label: 'House desk' },
  { path: '/governors', label: 'Governors desk' },
  { path: '/map/senate', label: 'Senate map' },
  { path: '/map/governor', label: 'Governor map' },
  { path: '/map/house', label: 'House map' },
  { path: '/ballot', label: 'Ballot measures' },
  { path: '/swing', label: 'Swing' },
];

export interface Prefs {
  /** Breaking-alert banner (default on). */
  alertsBanner: boolean;
  /** Alert chime (default off; browsers also require one click before audio can play). */
  alertsSound: boolean;
  /** 'key' = key-race calls, flips, watchlist and chamber control; 'all' = every Senate/Governor call too. */
  alertScope: 'key' | 'all';
  kioskInterval: number;
  kioskViews: string[];
  /** Show the "My races" strip at the bottom of every view. */
  showDock: boolean;
}

const KEY = 'ec-prefs-v1';
const DEFAULTS: Prefs = {
  alertsBanner: true,
  alertsSound: false,
  alertScope: 'key',
  kioskInterval: 45,
  kioskViews: KIOSK_VIEWS.map((v) => v.path),
  showDock: true,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

/** Per-browser preferences (localStorage), synced across this browser's windows. */
export const usePrefs = create<Prefs & { set: (p: Partial<Prefs>) => void }>((set, get) => ({
  ...load(),
  set: (p) => {
    set(p);
    try {
      const { set: _s, ...rest } = get();
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable */
    }
  },
}));

// ------------------------------------------------------------------ kiosk (per window)

const KIOSK_KEY = 'ec-kiosk';

/**
 * Kiosk on/off is per WINDOW (sessionStorage), so one monitor can rotate while others stay put.
 * Default off; `?kiosk=1` / `?kiosk=0` in the URL sets it for that window (handy for bookmarks).
 */
function initialKiosk(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get('kiosk');
    if (q === '0' || q === '1') {
      sessionStorage.setItem(KIOSK_KEY, q);
      return q === '1';
    }
    const s = sessionStorage.getItem(KIOSK_KEY);
    if (s === '0' || s === '1') return s === '1';
  } catch {
    /* ignore */
  }
  return false;
}

export const useKioskState = create<{ enabled: boolean; setEnabled: (on: boolean) => void }>((set) => ({
  enabled: initialKiosk(),
  setEnabled: (on) => {
    try {
      sessionStorage.setItem(KIOSK_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ enabled: on });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) usePrefs.setState(load());
  });
}
