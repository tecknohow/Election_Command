import { useMemo } from 'react';
import type { Candidate, Office, Party, Race } from '../../../shared/src/types';
import { LEVEL_STRENGTH } from '../../../shared/src/ratings';
import { PARTY_COLOR, RAMP } from '../lib/colors';
import { fmtProb, statusText } from '../lib/format';
import { sides } from '../lib/history';
import { useElection } from '../store/election';

/** How competitive a race looks pre-results (0 = coin flip, 1 = safe). */
export function competitiveness(r: Race): number {
  const bp = r.market?.byParty;
  if (bp && Object.keys(bp).length) {
    const top = Math.max(...Object.values(bp).map((v) => v ?? 0));
    return Math.min(1, Math.abs(top - 0.5) * 2);
  }
  const rating = r.forecast.flipr ?? r.forecast.cook ?? r.forecast.nyt;
  if (rating) return LEVEL_STRENGTH[rating.level] / 4;
  return 1;
}

/** Races always treated as key, whatever their ratings or odds say. */
export const ALWAYS_KEY = new Set(['GA-S', 'FL-S', 'NC-S', 'MS-S', 'NH-G']);

export function isKeyRace(r: Race): boolean {
  if (ALWAYS_KEY.has(r.id)) return true;
  const ratings = [r.forecast.flipr, r.forecast.cook, r.forecast.nyt].filter(Boolean);
  const close = ratings.some((x) => LEVEL_STRENGTH[x!.level] <= LEVEL_STRENGTH.lean);
  return close || competitiveness(r) < 0.7 || (r.status === 'counting' && (r.margin ?? 100) < 4);
}

/** The two candidates to show head-to-head. */
export function headToHead(r: Race): [Candidate, Candidate | undefined] {
  if (r.totalVotes > 0) return [r.candidates[0], r.candidates[1]];
  const { d, r: rep } = sides(r);
  const others = r.candidates.filter((c) => c !== d && c !== rep);
  const pair = [d, rep, ...others].filter(Boolean) as Candidate[];
  return [pair[0], pair[1]];
}

function MarketPill({ r }: { r: Race }) {
  const bp = r.market?.byParty;
  if (!bp || !Object.keys(bp).length) return <span className="pill muted">—</span>;
  const [p, v] = (Object.entries(bp) as [Party, number][]).sort((a, b) => b[1] - a[1])[0];
  return (
    <span className="pill" style={{ color: PARTY_COLOR[p] }} title="Polymarket implied probability">
      {p} {fmtProb(v)}
    </span>
  );
}

export function RaceRow({ r, onHover, flash }: { r: Race; onHover: (id: string | null, e?: React.MouseEvent) => void; flash: boolean }) {
  const [a, b] = headToHead(r);
  const counted = r.totalVotes > 0;
  const left = a && b && a.party === 'R' && b.party === 'D' ? b : a;
  const right = left === a ? b : a;
  const lp = counted ? left.pct : 0;
  const rp = counted && right ? right.pct : 0;
  const rating = r.forecast.flipr ?? r.forecast.cook ?? r.forecast.nyt;
  // Before votes arrive, the bar shows the Polymarket split (faded) instead of an empty track.
  const bp = r.market?.byParty;
  const preL = !counted && bp ? (bp[left.party] ?? 0) * 100 : 0;
  const preR = !counted && bp && right ? (bp[right.party] ?? 0) * 100 : 0;

  return (
    <div
      data-race-id={r.id}
      className={`race-row status-${r.status} ${flash ? 'flash' : ''}`}
      onMouseMove={(e) => onHover(r.id, e)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="rr-state">
        {r.state}
        {r.office === 'H' ? `-${r.district}` : ''}
        {r.special ? <sup>S</sup> : null}
      </div>
      <div className="rr-cand left">
        <span className="rr-name">
          {left.winner ? '✔ ' : ''}
          {left.lastName}
        </span>
        <span className="rr-pct" style={{ color: PARTY_COLOR[left.party] }}>
          {counted ? `${lp.toFixed(1)}` : left.party}
        </span>
      </div>
      <div className="rr-bar">
        <div className="rr-fill left" style={{ width: `${lp}%`, background: left.winner ? PARTY_COLOR[left.party] : RAMP[left.party].likely }} />
        {right ? <div className="rr-fill right" style={{ width: `${rp}%`, background: right.winner ? PARTY_COLOR[right.party] : RAMP[right.party].likely }} /> : null}
        {!counted && bp ? (
          <>
            <div className="rr-fill left pre" style={{ width: `${preL}%`, background: RAMP[left.party].lean }} />
            {right ? <div className="rr-fill right pre" style={{ width: `${preR}%`, background: RAMP[right.party].lean }} /> : null}
          </>
        ) : null}
        <div className="rr-mid" />
        {r.eevp != null && counted ? <div className="rr-eevp" style={{ width: `${Math.min(100, r.eevp)}%` }} /> : null}
      </div>
      <div className="rr-cand right">
        {right ? (
          <>
            <span className="rr-pct" style={{ color: PARTY_COLOR[right.party] }}>
              {counted ? `${rp.toFixed(1)}` : right.party}
            </span>
            <span className="rr-name">
              {right.lastName}
              {right.winner ? ' ✔' : ''}
            </span>
          </>
        ) : null}
      </div>
      <div className="rr-status">
        {r.flip && r.winner ? (
          <span className="badge flip" style={{ background: PARTY_COLOR[r.winner] }}>
            {r.winner} GAIN
          </span>
        ) : (
          <span className={`badge status-${r.status}`}>{statusText(r)}</span>
        )}
      </div>
      <div className="rr-rating" title={rating ? `${rating.source}: ${rating.label}` : ''}>
        {rating ? <span style={{ color: rating.party ? PARTY_COLOR[rating.party] : undefined }}>{rating.label}</span> : '—'}
      </div>
      <div className="rr-market">
        <MarketPill r={r} />
      </div>
    </div>
  );
}

export function KeyRaces({ office, title, onHover }: { office: Office; title: string; onHover: (id: string | null, e?: React.MouseEvent) => void }) {
  const races = useElection((s) => s.races);
  const flashed = useElection((s) => s.flashed);
  const list = useMemo(
    () =>
      Object.values(races)
        .filter((r) => r.office === office && isKeyRace(r))
        // Stable ordering by pre-election competitiveness so rows don't jump around on a wall display.
        .sort((a, b) => competitiveness(a) - competitiveness(b) || a.state.localeCompare(b.state)),
    [races, office],
  );
  const now = Date.now();
  return (
    <section className="panel key-races">
      <div className="panel-head">
        <h2>{title}</h2>
        <span className="muted small">
          {list.length} races · sorted by closeness · FLIPR / Polymarket
        </span>
      </div>
      <div className="race-rows">
        {list.map((r) => (
          <RaceRow key={r.id} r={r} onHover={onHover} flash={!!flashed[r.id] && now - flashed[r.id] < 2500} />
        ))}
        {!list.length ? <div className="empty">Loading races…</div> : null}
      </div>
    </section>
  );
}
