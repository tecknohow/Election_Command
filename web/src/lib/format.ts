import type { Race } from '../../../shared/src/types';
import { STATE_BY_POSTAL } from '../../../shared/src/states';

const etTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const etClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const nf = new Intl.NumberFormat('en-US');

export const fmtEt = (iso: string | number | null | undefined) => (iso ? etTime.format(new Date(iso)) : '—');
export const fmtEtClock = (d: Date) => etClock.format(d);
export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));
export const fmtPct = (n: number | null | undefined, digits = 1) => (n == null ? '—' : `${n.toFixed(digits)}%`);
export const fmtProb = (p: number | null | undefined) => (p == null ? '—' : p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Only http(s) links are rendered as hrefs/srcs. */
export function safeHref(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);

export const stateName = (postal: string) => STATE_BY_POSTAL[postal]?.name ?? postal;

export function raceName(r: Pick<Race, 'state' | 'office' | 'district' | 'special'>): string {
  if (r.office === 'H') return AT_LARGE.has(r.state) ? `${stateName(r.state)} At-Large` : `${stateName(r.state)} District ${r.district}`;
  return `${stateName(r.state)}${r.special ? ' (special)' : ''}`;
}

export function statusText(r: Race): string {
  switch (r.status) {
    case 'called':
      return `Called${r.calledBy ? ` · ${r.calledBy}` : ''}`;
    case 'runoff':
      return 'Runoff';
    case 'counting':
      if (r.expectedLater) return 'Decision later';
      return r.eevp != null ? `${Math.round(r.eevp)}% in` : 'Counting';
    case 'closed':
      return 'Polls closed';
    default:
      return r.pollClose ? `Closes ${fmtEt(r.pollClose)}` : 'Polls open';
  }
}
