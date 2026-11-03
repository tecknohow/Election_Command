import type { Race } from '../../../shared/src/types';
import { PARTY_COLOR } from '../lib/colors';
import { dMargin, fmtLean, leanParty, pres2024For, prevFor, prevText, swing } from '../lib/history';

const col = (m: number | null | undefined) => {
  const p = leanParty(m);
  return p ? PARTY_COLOR[p] : undefined;
};

/**
 * "How did this seat vote last time?" strip: the previous contest for the same seat, the 2024
 * presidential margin inside the current boundaries, and (once votes are in) how far tonight's
 * margin has moved from each.
 */
export function PrevResults({ race, compact = false }: { race: Race; compact?: boolean }) {
  const prev = prevFor(race);
  const pres = pres2024For(race);
  const now = dMargin(race);
  // A redrawn district's 2024 House result was on different lines: only compare against the new-lines presidential margin.
  const vsPrev = prev?.linesChanged ? null : swing(race, prev?.margin ?? null);
  const vsPres = swing(race, pres);
  const prevLabel = race.office === 'H' ? (prev?.linesChanged ? '2024 House · old lines' : '2024 House') : `Last race · ${prev?.label ?? '—'}`;
  const who = prev?.winner ? `${prev.winner.name}${prev.winner.party ? ` (${prev.winner.party})` : ''}` : '';
  const tip = [
    prev
      ? `${race.office === 'H' ? '2024 House' : `Previous race for this seat (${prev.label})`}: ${prevText(prev)}${who ? `, won by ${who}` : ''}${prev.d && prev.r ? ` — ${prev.d.name} ${prev.d.pct}%, ${prev.r.name} ${prev.r.pct}%` : ''}`
      : null,
    prev?.linesChanged ? 'This district was redrawn after 2024; the 2024 House result was on the old lines. The presidential margin is computed inside the new lines.' : null,
    pres != null ? `2024 presidential margin within these boundaries: ${fmtLean(pres)}` : race.office === 'H' ? 'No 2024 presidential estimate for the new lines yet.' : null,
    now != null && vsPrev != null ? `Tonight ${fmtLean(now)}: shift ${fmtLean(vsPrev)} vs the last race` : null,
    now != null && vsPres != null ? `Tonight ${fmtLean(now)}: shift ${fmtLean(vsPres)} vs 2024 president` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className={`prev-strip ${compact ? 'compact' : ''}`} title={tip}>
      <div>
        <label>{compact ? (race.office === 'H' ? (prev?.linesChanged ? "'24 House°" : "'24 House") : `Last · '${String(prev?.year ?? '').slice(2)}`) : prevLabel}</label>
        <span style={{ color: col(prev?.margin) }}>{prevText(prev, compact)}</span>
        {!compact && who ? <small>{who}</small> : null}
      </div>
      <div>
        <label>{compact ? "'24 Pres" : '2024 Pres'}</label>
        <span style={{ color: col(pres) }}>{fmtLean(pres)}</span>
        {!compact ? <small>{race.office === 'H' ? 'in this district' : 'statewide'}</small> : null}
      </div>
      {compact && now != null && (vsPrev ?? vsPres) != null ? (
        // One number in compact cards: vs the seat's last race when comparable, else vs 2024 president.
        <div>
          <label>{vsPrev != null ? 'Shift vs last' : "Shift vs '24"}</label>
          <b style={{ color: col(vsPrev ?? vsPres) }}>{fmtLean(vsPrev ?? vsPres)}</b>
        </div>
      ) : !compact && now != null && (vsPrev != null || vsPres != null) ? (
        <div>
          <label>Shift tonight</label>
          <span>
            {vsPrev != null ? (
              <b style={{ color: col(vsPrev) }} title={`Tonight ${fmtLean(now)} vs ${prevText(prev)} last time`}>
                {fmtLean(vsPrev)}
              </b>
            ) : null}
            {vsPrev != null && vsPres != null ? <i className="muted"> · </i> : null}
            {vsPres != null ? (
              <b style={{ color: col(vsPres) }} title={`Tonight ${fmtLean(now)} vs ${fmtLean(pres)} for president in 2024`}>
                {fmtLean(vsPres)}
              </b>
            ) : null}
          </span>
          {!compact ? <small>{[vsPrev != null ? 'vs last race' : null, vsPres != null ? "vs '24 pres" : null].filter(Boolean).join(' · ')}</small> : null}
        </div>
      ) : null}
    </div>
  );
}
