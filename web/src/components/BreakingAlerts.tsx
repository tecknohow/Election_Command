import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { create } from 'zustand';
import type { Office, Party, Race } from '../../../shared/src/types';
import { PARTY_COLOR, PARTY_NAME } from '../lib/colors';
import { raceName } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { chime } from '../lib/sound';
import { isWatched } from '../lib/watchlist';
import { useElection } from '../store/election';
import { isKeyRace } from './KeyRaces';

export interface BreakingAlert {
  id: string;
  kind: 'call' | 'flip' | 'control';
  party: Party | null;
  label: string;
  headline: string;
  sub: string;
  raceId?: string;
  sim: boolean;
}

export const useAlerts = create<{ queue: BreakingAlert[]; push: (a: BreakingAlert) => void; dismiss: () => void }>((set) => ({
  queue: [],
  push: (a) => set((s) => (s.queue.some((x) => x.id === a.id) ? s : { queue: [...s.queue, a].slice(-12) })),
  dismiss: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

const OFFICE_NAME: Record<Office, string> = { S: 'Senate', H: 'House', G: 'Governor' };
const CHAMBER_GOAL: Record<Office, string> = { S: 'control of the Senate', H: 'control of the House', G: 'a majority of governorships' };

/** Is a newly called race worth interrupting the wall for? */
function worthy(r: Race): boolean {
  if (isWatched(r.id)) return true;
  if (r.flip) return true;
  if (r.office === 'H') return false;
  return usePrefs.getState().alertScope === 'all' || isKeyRace(r);
}

function callAlert(r: Race, sim: boolean): BreakingAlert {
  const w = r.candidates.find((c) => c.winner);
  const party = r.winner!;
  const place = r.office === 'H' ? raceName(r) : `${raceName(r)} ${OFFICE_NAME[r.office]}`;
  const sub = [
    r.flip ? `${PARTY_NAME[party].toUpperCase()} GAIN${r.priorParty ? ` from ${r.priorParty}` : ''}` : `${party} hold`,
    r.eevp != null && r.totalVotes ? `${Math.round(r.eevp)}% of expected vote in` : null,
    w && r.totalVotes ? `${w.pct.toFixed(1)}%` : r.totalVotes ? null : 'called at poll close',
    r.calledBy ? `call: ${r.calledBy}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: `call-${r.id}-${sim ? 'sim' : 'live'}`,
    kind: r.flip ? 'flip' : 'call',
    party,
    label: r.flip ? 'BREAKING · SEAT FLIPS' : 'BREAKING · PROJECTION',
    headline: `${w?.name ?? r.winnerName} (${party}) wins ${place}`,
    sub,
    raceId: r.id,
    sim,
  };
}

/**
 * Watches live updates (never the initial snapshot or reconnect snapshots) for newly called
 * key races and for a chamber being clinched, and queues breaking alerts.
 */
export function useAlertDetection() {
  useEffect(
    () =>
      useElection.subscribe((s, prev) => {
        if (!prev.loaded || s.snapshotSeq !== prev.snapshotSeq) return;
        const sim = s.mode === 'simulation';
        const { push } = useAlerts.getState();
        if (s.races !== prev.races) {
          for (const r of Object.values(s.races)) {
            const before = prev.races[r.id];
            if (r.winner && before && !before.winner && worthy(r)) push(callAlert(r, sim));
          }
        }
        if (s.chambers && prev.chambers && s.chambers !== prev.chambers) {
          for (const o of ['S', 'H', 'G'] as Office[]) {
            const w = s.chambers[o]?.controlWinner;
            if (w && !prev.chambers[o]?.controlWinner) {
              push({
                id: `control-${o}-${w}-${sim ? 'sim' : 'live'}`,
                kind: 'control',
                party: w,
                label: 'BREAKING · CONTROL DECIDED',
                headline: `${w === 'D' ? 'Democrats' : 'Republicans'} win ${CHAMBER_GOAL[o]}`,
                sub: `${s.chambers[o].label} · projected from race calls`,
                sim,
              });
            }
          }
        }
      }),
    [],
  );
}

/** Full-width banner for the head of the alert queue; plays the chime when an alert appears. */
export function BreakingBanner() {
  const queue = useAlerts((s) => s.queue);
  const dismiss = useAlerts((s) => s.dismiss);
  const showBanner = usePrefs((s) => s.alertsBanner);
  const sound = usePrefs((s) => s.alertsSound);
  const navigate = useNavigate();
  const current = queue[0];
  const [shownId, setShownId] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    if (current.id !== shownId) {
      setShownId(current.id);
      if (sound) chime(current.kind);
    }
    // Without the banner, alerts only chime; drain the queue quickly.
    // Control calls linger; a backlog (many calls at once) speeds up so the wall stays current.
    const t = setTimeout(dismiss, !showBanner ? 1500 : current.kind === 'control' ? 30_000 : queue.length > 3 ? 6_000 : 15_000);
    return () => clearTimeout(t);
  }, [current, shownId, sound, showBanner, dismiss, queue.length]);

  if (!current || !showBanner) return null;
  const color = current.party ? PARTY_COLOR[current.party] : '#f5b941';
  return (
    <div
      className={`breaking-banner kind-${current.kind}`}
      style={{ ['--alert' as string]: color }}
      role="alert"
      onClick={() => {
        if (current.raceId) navigate(`/race/${current.raceId}`);
        dismiss();
      }}
    >
      <div className="breaking-label">
        {current.label}
        {current.sim ? <span className="sim-tag">SIM</span> : null}
      </div>
      <div className="breaking-main">
        <div className="breaking-headline">{current.headline}</div>
        <div className="breaking-sub">{current.sub}</div>
      </div>
      {queue.length > 1 ? <div className="breaking-more">+{queue.length - 1} more</div> : null}
      <button
        className="breaking-close"
        title="Dismiss"
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
      >
        ✕
      </button>
    </div>
  );
}
