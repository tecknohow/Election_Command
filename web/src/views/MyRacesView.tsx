import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { NewsItem, Race } from '../../../shared/src/types';
import { competitiveness, isKeyRace } from '../components/KeyRaces';
import { RaceCard } from '../components/RaceCard';
import { WatchStar } from '../components/Watch';
import { PARTY_COLOR } from '../lib/colors';
import { fmtEt, relTime, safeHref, stateName } from '../lib/format';
import { currentParty, isPotentialFlip, probD } from '../lib/odds';
import { useWatchlist } from '../lib/watchlist';
import { useElection, useNow } from '../store/election';

type SortKey = 'status' | 'closeness' | 'closing' | 'added';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'status', label: 'Counting first' },
  { id: 'closeness', label: 'Closest first' },
  { id: 'closing', label: 'Poll closing' },
  { id: 'added', label: 'Order added' },
];
const STATUS_ORDER: Record<Race['status'], number> = { counting: 0, closed: 1, runoff: 2, upcoming: 3, called: 4 };
const OFFICE_LABEL = { S: 'Senate', G: 'Governor', H: 'House' } as const;
const AT_LARGE = new Set(['AK', 'DE', 'ND', 'SD', 'VT', 'WY']);
const code = (r: Race) => (r.office === 'H' ? `${r.state}-${AT_LARGE.has(r.state) ? 'AL' : r.district}` : `${r.state} ${OFFICE_LABEL[r.office]}`);

/** Closeness: live margin once counting, otherwise distance of the odds from 50/50. */
const closeness = (r: Race) => (r.totalVotes > 0 && !r.winner ? (r.margin ?? 100) / 100 : r.winner ? 2 : Math.abs(probD(r) - 0.5));

function RaceSearch({ races }: { races: Race[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);
  const results = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return races
      .filter((r) => {
        const hay = `${stateName(r.state)} ${r.state} ${OFFICE_LABEL[r.office]} ${code(r)} ${r.office === 'H' ? `${r.state}${r.district} district ${r.district}` : ''} ${r.candidates.map((c) => c.name).join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .sort((a, b) => competitiveness(a) - competitiveness(b))
      .slice(0, 8);
  }, [q, races]);
  return (
    <div className="mr-search" ref={ref}>
      <input
        placeholder="Add a race: state, district (TX-28) or candidate…"
        value={q}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {!open ? null : results.length ? (
        <ul className="mr-search-results">
          {results.map((r) => (
            <li key={r.id}>
              <WatchStar id={r.id} />
              <b>{code(r)}</b>
              <span className="muted">{r.candidates.slice(0, 2).map((c) => `${c.lastName} (${c.party})`).join(' v ')}</span>
            </li>
          ))}
        </ul>
      ) : q ? (
        <ul className="mr-search-results">
          <li className="muted">No matching races</li>
        </ul>
      ) : null}
    </div>
  );
}

/** Alerts for starred races plus headlines that mention their leading candidates. */
function MyFeed({ list }: { list: Race[] }) {
  const now = useNow(15_000);
  const news = useElection((s) => s.news);
  const items = useMemo(() => {
    const ids = new Set(list.map((r) => r.id));
    const names = list.flatMap((r) => r.candidates.slice(0, 2).map((c) => c.lastName)).filter((n) => n.length >= 4 && !/write-ins/i.test(n));
    const re = names.length ? new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
    return news.filter((n: NewsItem) => (n.raceId ? ids.has(n.raceId) : n.kind === 'news' && !!re && re.test(n.title))).slice(0, 80);
  }, [news, list]);
  return (
    <section className="panel mr-feed">
      <div className="panel-head">
        <h2>
          <span className="live-dot" /> My races feed
        </h2>
        <span className="muted small">calls, leads &amp; headlines</span>
      </div>
      <ul className="news-list">
        {items.map((n) => (
          <li key={n.id} className={`news-item kind-${n.kind}`} style={n.party ? { borderLeftColor: PARTY_COLOR[n.party] } : undefined}>
            <div className="news-meta">
              <span className={`kind kind-${n.kind}`} style={n.party && n.kind !== 'news' ? { background: PARTY_COLOR[n.party] } : undefined}>
                {n.kind.toUpperCase()}
              </span>
              {n.sim ? <span className="sim-tag">SIM</span> : null}
              <span className="news-source">{n.source}</span>
              <span className="news-time">
                {fmtEt(n.published)}
                {n.sim ? '' : ` · ${relTime(n.published, now)}`}
              </span>
            </div>
            {safeHref(n.link) ? (
              <a className="news-title" href={safeHref(n.link)} target="_blank" rel="noreferrer noopener">
                {n.title}
              </a>
            ) : (
              <div className="news-title">{n.title}</div>
            )}
          </li>
        ))}
        {!items.length ? <li className="empty">Nothing yet for your races</li> : null}
      </ul>
    </section>
  );
}

/** My Races: every starred race as a live card, with a summary, search-to-add and a filtered feed. */
export function MyRacesView() {
  const ids = useWatchlist((s) => s.ids);
  const races = useElection((s) => s.races);
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>('status');
  const all = useMemo(() => Object.values(races), [races]);
  const list = useMemo(() => ids.map((id) => races[id]).filter(Boolean), [ids, races]);

  const sorted = useMemo(() => {
    const byAdded = new Map(ids.map((id, i) => [id, i]));
    const cmp: Record<SortKey, (a: Race, b: Race) => number> = {
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || closeness(a) - closeness(b),
      closeness: (a, b) => closeness(a) - closeness(b),
      closing: (a, b) => (a.pollClose ?? '').localeCompare(b.pollClose ?? '') || closeness(a) - closeness(b),
      added: (a, b) => (byAdded.get(a.id) ?? 0) - (byAdded.get(b.id) ?? 0),
    };
    return [...list].sort(cmp[sort]);
  }, [list, sort, ids]);

  const summary = useMemo(() => {
    const s = { called: 0, counting: 0, later: 0, flips: 0, D: 0, R: 0, I: 0, leadD: 0, leadR: 0 };
    for (const r of list) {
      if (r.winner) {
        s.called++;
        s[r.winner]++;
      } else if (r.status === 'counting') {
        s.counting++;
        if (r.leader === 'D') s.leadD++;
        if (r.leader === 'R') s.leadR++;
      }
      if (r.expectedLater) s.later++;
      if (isPotentialFlip(r)) s.flips++;
    }
    return s;
  }, [list]);

  const suggestions = useMemo(
    () =>
      all
        .filter((r) => r.office !== 'H' && isKeyRace(r) && !ids.includes(r.id))
        .concat(all.filter((r) => r.office === 'H' && competitiveness(r) < 0.35 && !ids.includes(r.id)))
        .sort((a, b) => competitiveness(a) - competitiveness(b))
        .slice(0, 18),
    [all, ids],
  );

  return (
    <div className="my-races">
      <div className="mr-head">
        <div className="tiles mr-tiles">
          <div className="tile">
            <b>{list.length}</b>
            <span>★ My races</span>
          </div>
          <div className="tile">
            <b>{summary.counting}</b>
            <span>Counting</span>
          </div>
          <div className="tile">
            <b>
              {summary.called}
              <small>/{list.length}</small>
            </b>
            <span>Called</span>
          </div>
          <div className="tile">
            <b>
              <span style={{ color: PARTY_COLOR.D }}>{summary.D}</span>–<span style={{ color: PARTY_COLOR.R }}>{summary.R}</span>
            </b>
            <span>Won D–R</span>
          </div>
          <div className="tile">
            <b>
              <span style={{ color: PARTY_COLOR.D }}>{summary.leadD}</span>–<span style={{ color: PARTY_COLOR.R }}>{summary.leadR}</span>
            </b>
            <span>Leading D–R</span>
          </div>
          <div className="tile">
            <b style={{ color: summary.flips ? 'var(--accent)' : undefined }}>{summary.flips}</b>
            <span>Flipping</span>
          </div>
          <div className="tile">
            <b>{summary.later}</b>
            <span>Decision later</span>
          </div>
        </div>
        <div className="mr-controls">
          <RaceSearch races={all} />
          <div className="seg-control">
            {SORTS.map((s) => (
              <button key={s.id} className={sort === s.id ? 'on' : ''} onClick={() => setSort(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
          {list.length ? <span className="mr-tip muted small">Each card’s “County results &amp; details →” opens the county drill-down · manage the bottom bar in ⚙ Settings</span> : null}
        </div>
      </div>

      <section className="mr-cards">
        {sorted.map((r) => (
          <div key={r.id} className={`mr-card status-${r.status} ${currentParty(r) ? `lean-${currentParty(r)}` : ''}`}>
            <RaceCard race={r} showStar dense onOpen={() => navigate(`/race/${r.id}`)} />
          </div>
        ))}
        {!list.length ? (
          <div className="mr-empty panel">
            <h2>No starred races yet</h2>
            <p className="muted">
              Star (☆) races here, or anywhere in the app: race cards, tables and detail pages. Starred races stay pinned in the bar at the bottom of every view and always trigger breaking
              alerts. They're saved only in this browser.
            </p>
            <h3>Suggested: the most competitive races</h3>
            <ul className="mr-suggest">
              {suggestions.map((r) => (
                <li key={r.id}>
                  <WatchStar id={r.id} />
                  <b>{code(r)}</b>
                  <span className="muted">{r.candidates.slice(0, 2).map((c) => `${c.lastName} (${c.party})`).join(' v ')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : suggestions.length ? (
          <div className="mr-more panel">
            <h3>Add more · most competitive races not on your list</h3>
            <ul className="mr-suggest">
              {suggestions.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <WatchStar id={r.id} />
                  <b>{code(r)}</b>
                  <span className="muted">{r.candidates.slice(0, 2).map((c) => `${c.lastName} (${c.party})`).join(' v ')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="mr-side">
        <MyFeed list={list} />
      </div>

    </div>
  );
}
