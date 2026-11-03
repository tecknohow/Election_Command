import type { Candidate, Race } from '../../../shared/src/types';
import { PARTY_COLOR } from '../lib/colors';
import { useWatchlist } from '../lib/watchlist';
import { PrevResults } from './PrevResults';
import { WatchStar } from './Watch';
import { fmtEt, fmtNum, fmtPct, fmtProb, raceName, safeHref, stateName, statusText } from '../lib/format';

const OFFICE_TITLE = { S: 'U.S. Senate', G: 'Governor', H: 'U.S. House' } as const;

function Headshot({ c }: { c: Candidate }) {
  return (
    <div className="headshot" style={{ borderColor: PARTY_COLOR[c.party] }}>
      {safeHref(c.img) ? (
        <img src={safeHref(c.img)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      ) : null}
      <span>{c.lastName.slice(0, 1)}</span>
    </div>
  );
}

/**
 * The detail card shown on hover / pin in map views and on the dashboard. `dense` (My Races grid)
 * trims repetition: top 3 candidates, no separate poll-closing lines (the header badge has it), and
 * the source line moves into the card's tooltip.
 */
export function RaceCard({ race, onClose, onOpen, showStar, dense = false }: { race: Race; onClose?: () => void; onOpen?: () => void; showStar?: boolean; dense?: boolean }) {
  const watched = useWatchlist((s) => s.ids.includes(race.id));
  const counted = race.totalVotes > 0;
  // Dense: the top two, plus a third only if it's a real contender (10%+); the rest fold into one line.
  const shown = race.candidates.filter((c, i) => c.winner || (dense ? i < 2 || (i === 2 && counted && c.pct >= 10) : i < 4));
  const hidden = race.candidates.length - shown.length;
  const hiddenPct = race.candidates.filter((c) => !shown.includes(c)).reduce((s, c) => s + c.pct, 0);
  const priorTxt = race.priorParty ? `${race.priorParty} held` : 'Prior party unknown';
  const incTxt = race.incumbentRunning ? `Incumbent: ${race.incumbentName}` : `Open seat${race.incumbentName ? ` (${race.incumbentName} not running)` : ''}`;
  const forecast = race.forecast;
  const bp = race.market?.byParty;

  const sourceTxt = `Source: ${race.source}${race.updatedAt ? ` · updated ${fmtEt(race.updatedAt)} ET` : ''}`;

  return (
    <div className={`race-card ${dense ? 'dense' : ''}`} title={dense ? sourceTxt : undefined}>
      <div className="rc-head">
        <div>
          <div className="rc-title">
            {race.office === 'H' ? raceName(race) : stateName(race.state)}
            <span className="rc-office">
              {OFFICE_TITLE[race.office]}
              {race.special ? ' · Special' : ''}
            </span>
          </div>
          <div className="rc-sub">
            {incTxt} · {priorTxt}
          </div>
        </div>
        <div className="rc-head-right">
          <span className={`badge status-${race.status}`}>{statusText(race)}</span>
          {race.flip && race.winner ? <span className="badge flip" style={{ background: PARTY_COLOR[race.winner] }}>{race.winner} GAIN</span> : null}
          {onClose || showStar ? <WatchStar id={race.id} /> : watched ? <span className="watch-star on md" title="In My races">★</span> : null}
          {onClose ? (
            <button className="icon-btn" onClick={onClose} title="Unpin (Esc)">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {dense && !counted && race.status === 'upcoming' ? null : (
      <div className="rc-progress">
        <div className="rc-progress-bar">
          <div style={{ width: `${Math.min(100, race.eevp ?? 0)}%` }} />
        </div>
        <div className="rc-progress-txt">
          {counted ? (
            <>
              <b>{fmtPct(race.eevp, 0)}</b> of expected vote · {fmtNum(race.totalVotes)} votes
            </>
          ) : race.status === 'upcoming' ? (
            <>Polls close {fmtEt(race.pollClose)} ET</>
          ) : race.status === 'closed' ? (
            <>Polls closed · awaiting first results</>
          ) : (
            <>No votes reported</>
          )}
        </div>
      </div>
      )}

      {dense ? (
        // One line in dense cards; the full text is in the tooltip.
        race.expectedLater || (race.runoffRule && !race.winner) ? (
          <div className="rc-note dense" title={[race.expectedLater, race.runoffRule].filter(Boolean).join('. ')}>
            {race.expectedLater ?? race.runoffRule}.
          </div>
        ) : null
      ) : (
        <>
          {race.expectedLater ? <div className="rc-note">{race.expectedLater}.</div> : null}
          {race.rcv && !race.expectedLater ? <div className="rc-note">Ranked-choice race: first-choice votes shown. If no one passes 50%, the final result can take days.</div> : null}
          {race.runoffRule && !race.winner ? <div className="rc-note">{race.runoffRule}.</div> : null}
        </>
      )}

      <table className="rc-cands">
        <tbody>
          {shown.map((c) => (
            <tr key={c.id} className={c.winner ? 'winner' : ''}>
              <td className="rc-photo">
                <Headshot c={c} />
              </td>
              <td className="rc-name">
                <div>
                  {c.name}
                  {c.winner ? <span className="check" style={{ color: PARTY_COLOR[c.party] }}> ✔</span> : null}
                </div>
                <div className="rc-party">
                  <i style={{ background: PARTY_COLOR[c.party] }} />
                  {c.partyName}
                  {c.incumbent ? <span className="inc">INC</span> : null}
                </div>
              </td>
              <td className="rc-votes">{counted ? fmtNum(c.votes) : ''}</td>
              <td className="rc-pct">
                <div>{counted ? fmtPct(c.pct) : '—'}</div>
                <div className="rc-bar">
                  <div style={{ width: `${c.pct}%`, background: PARTY_COLOR[c.party] }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <div className="rc-more">
          +{hidden} other candidate{hidden > 1 ? 's' : ''}
          {dense && counted ? ` · ${hiddenPct.toFixed(1)}%` : ''}
        </div>
      ) : null}

      <div className="rc-hist-row">
        <PrevResults race={race} compact={dense} />
        {onOpen ? (
          <button className="rc-details" onClick={onOpen} title="County results & details">
            {dense ? 'County results →' : <>County results &amp; details →</>}
          </button>
        ) : null}
      </div>

      <div className="rc-foot">
        <div>
          <label>FLIPR</label>
          <span>{forecast.flipr?.label ?? '—'}</span>
        </div>
        <div>
          <label>Cook</label>
          <span>{forecast.cook?.label ?? forecast.nyt?.label ?? '—'}</span>
        </div>
        <div>
          <label>Polymarket</label>
          <span>
            {bp && Object.keys(bp).length
              ? (Object.entries(bp) as [keyof typeof PARTY_COLOR, number][])
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 2)
                  .map(([p, v]) => (
                    <b key={p} style={{ color: PARTY_COLOR[p] }}>
                      {p} {fmtProb(v)}{' '}
                    </b>
                  ))
              : '—'}
          </span>
        </div>
        {dense ? null : (
          <div>
            <label>Polls close</label>
            <span>{fmtEt(race.pollClose)} ET</span>
          </div>
        )}
      </div>
      {dense ? null : <div className="rc-source">{sourceTxt}</div>}
    </div>
  );
}
