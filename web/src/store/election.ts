import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { BallotMeasure, BopHistoryPoint, ChamberSummary, NewsItem, Office, PollClosing, Race, SimStatus, Snapshot, SourceStatus, StreamEvent } from '../../../shared/src/types';

// Note: watchdog is intentionally module-level and never cleared (one per window).

interface ElectionState {
  connected: boolean;
  loaded: boolean;
  /** Incremented on every full snapshot (alert detection ignores snapshot replacements). */
  snapshotSeq: number;
  lastEventAt: number;
  version: number;
  mode: Snapshot['mode'];
  races: Record<string, Race>;
  measures: Record<string, BallotMeasure>;
  chambers: Record<Office, ChamberSummary> | null;
  news: NewsItem[];
  sources: SourceStatus[];
  pollClosings: PollClosing[];
  bopHistory: BopHistoryPoint[];
  sim: SimStatus | null;
  /** News ids that arrived after initial load (for "new" highlighting). */
  freshNews: Record<string, number>;
  /** Races updated recently (for flash animations). */
  flashed: Record<string, number>;
  apply: (ev: StreamEvent) => void;
  setConnected: (c: boolean) => void;
}

export const useElection = create<ElectionState>((set) => ({
  connected: false,
  loaded: false,
  snapshotSeq: 0,
  lastEventAt: 0,
  version: 0,
  mode: 'live',
  races: {},
  measures: {},
  chambers: null,
  news: [],
  sources: [],
  pollClosings: [],
  bopHistory: [],
  sim: null,
  freshNews: {},
  flashed: {},
  setConnected: (connected) => set({ connected }),
  apply: (ev) =>
    set((s) => {
      const now = Date.now();
      switch (ev.type) {
        case 'snapshot': {
          const d = ev.data;
          return {
            loaded: true,
            snapshotSeq: s.snapshotSeq + 1,
            lastEventAt: now,
            version: d.version,
            mode: d.mode,
            races: d.races,
            measures: d.measures ?? {},
            chambers: d.chambers,
            news: d.news,
            sources: d.sources,
            pollClosings: d.pollClosings,
            bopHistory: d.bopHistory,
            sim: d.sim,
          };
        }
        case 'races': {
          // Patches carry only changed fields (full objects for races new to this client).
          const races = { ...s.races };
          const flashed = { ...s.flashed };
          for (const p of ev.data) {
            const prev = races[p.id];
            if (prev && (('totalVotes' in p && p.totalVotes !== prev.totalVotes) || ('winner' in p && p.winner !== prev.winner))) flashed[p.id] = now;
            races[p.id] = stripNulls(prev ? { ...prev, ...p } : p) as Race;
          }
          return { races, flashed, version: ev.version, lastEventAt: now };
        }
        case 'measures': {
          const measures = { ...s.measures };
          const flashed = { ...s.flashed };
          for (const p of ev.data) {
            const prev = measures[p.id];
            if (prev && (('totalVotes' in p && p.totalVotes !== prev.totalVotes) || ('result' in p && p.result !== prev.result))) flashed[p.id] = now;
            measures[p.id] = (prev ? { ...prev, ...p } : p) as BallotMeasure;
          }
          return { measures, flashed, version: ev.version, lastEventAt: now };
        }
        case 'chambers':
          return { chambers: ev.data, version: ev.version, lastEventAt: now };
        case 'news': {
          const ids = new Set(s.news.map((n) => n.id));
          const add = ev.data.filter((n) => !ids.has(n.id));
          const news = [...add, ...s.news].sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, 500);
          const freshNews = { ...s.freshNews };
          for (const n of add) freshNews[n.id] = now;
          return { news, freshNews, version: ev.version, lastEventAt: now };
        }
        case 'sources':
          return { sources: ev.data, lastEventAt: now };
        case 'meta': {
          const bopHistory = ev.data.bopPoint ? [...s.bopHistory, ev.data.bopPoint] : s.bopHistory;
          return { mode: ev.data.mode, sim: ev.data.sim, pollClosings: ev.data.pollClosings, bopHistory, lastEventAt: now };
        }
        default:
          return {};
      }
    }),
}));

/** Optional fields removed on the server arrive as null in patches. */
function stripNulls<T extends object>(o: T): T {
  for (const k of ['market'] as const) if ((o as Record<string, unknown>)[k] === null) delete (o as Record<string, unknown>)[k];
  return o;
}

// ------------------------------------------------------------------ stream connection

let source: EventSource | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let backoff = 2_000;

const VIEW_KEY = 'ec-view-sim';
export function wantsSimView(): boolean {
  try {
    return sessionStorage.getItem(VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

function open() {
  const { apply, setConnected } = useElection.getState();
  source?.close();
  const es = new EventSource(wantsSimView() ? '/api/stream?view=sim' : '/api/stream');
  source = es;
  const handler = (e: MessageEvent) => {
    try {
      apply(JSON.parse(e.data) as StreamEvent);
    } catch (err) {
      console.error('bad event', err);
    }
  };
  for (const t of ['snapshot', 'races', 'measures', 'chambers', 'news', 'sources', 'meta']) es.addEventListener(t, handler);
  es.onopen = () => {
    backoff = 2_000;
    setConnected(true);
  };
  es.onerror = () => {
    setConnected(false);
    // EventSource gives up permanently on HTTP errors (502 from a proxy during a restart,
    // 429 connection cap): reopen ourselves with backoff.
    if (es.readyState === EventSource.CLOSED) scheduleReopen();
  };
}

function scheduleReopen() {
  if (reopenTimer) return;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    open();
  }, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

/**
 * One SSE connection per window. The server sends a full snapshot on every (re)connect, so
 * state can never drift. A watchdog reconnects if nothing (not even the 15 s source-health
 * tick) has arrived for 45 s, which catches silently stalled proxies.
 */
export function connectStream() {
  if (source) return;
  open();
  watchdog = setInterval(() => {
    const { lastEventAt, connected } = useElection.getState();
    if (connected && lastEventAt && Date.now() - lastEventAt > 45_000) {
      useElection.getState().setConnected(false);
      open();
    }
  }, 10_000);
  void refreshAdmin();
  // Leaving the page for another URL can park it in the back/forward cache with its stream still
  // open. Browsers allow ~6 connections per host over HTTP/1.1, so six full page loads (bookmarks,
  // typed URLs) would exhaust them and hang the next page. Close on pagehide; reopen (with a fresh
  // snapshot) if the page is restored from the cache.
  window.addEventListener('pagehide', () => {
    source?.close();
    if (reopenTimer) clearTimeout(reopenTimer);
    reopenTimer = null;
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      useElection.getState().setConnected(false);
      open();
    }
  });
}

/** Admin: switch this window between the live feed and the private simulation. */
export function setSimView(on: boolean) {
  try {
    if (on) sessionStorage.setItem(VIEW_KEY, '1');
    else sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* ignore */
  }
  open();
}

// ------------------------------------------------------------------ admin

interface AdminState {
  admin: boolean;
  adminEnabled: boolean;
  checked: boolean;
}
export const useAdmin = create<AdminState>(() => ({ admin: false, adminEnabled: false, checked: false }));

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    // The custom header + JSON content type are required by the server's same-origin guard.
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-EC-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? res.statusText);
  return json as T;
}

let adminSeq = 0;
export async function refreshAdmin() {
  // Ignore stale responses: a check started before a sign-in must not undo it.
  const seq = ++adminSeq;
  try {
    const me = await api<{ admin: boolean; adminEnabled: boolean }>('/api/admin/me');
    if (seq !== adminSeq) return;
    useAdmin.setState({ admin: me.admin, adminEnabled: me.adminEnabled, checked: true });
    if (!me.admin && wantsSimView()) setSimView(false);
  } catch {
    useAdmin.setState({ checked: true });
  }
}

export async function adminLogin(token: string) {
  await api('/api/admin/login', { token });
  await refreshAdmin();
  open(); // reconnect so the server knows this window is an admin
}

export async function adminLogout() {
  await api('/api/admin/logout', {});
  try {
    sessionStorage.removeItem(VIEW_KEY);
  } catch {
    /* ignore */
  }
  useAdmin.setState({ admin: false });
  open();
}

/** Admin: freeze or resume simulated time. */
export async function simPause(paused: boolean) {
  return api('/api/admin/sim/pause', { paused });
}

export async function simAction(action: 'start' | 'stop' | 'speed', speed?: number) {
  const r = await api(`/api/admin/sim/${action}`, speed ? { speed } : {});
  if (action === 'start' && !wantsSimView()) setSimView(true);
  if (action === 'stop' && wantsSimView()) setSimView(false);
  return r;
}

/** Re-render periodically for clocks / relative times. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
