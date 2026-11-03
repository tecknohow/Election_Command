import { useMemo, useState } from 'react';
import { isIssue } from '../../../shared/src/issues';
import type { NewsItem, Office } from '../../../shared/src/types';
import { PARTY_COLOR } from '../lib/colors';
import { fmtEt, relTime, safeHref } from '../lib/format';
import { useElection, useNow } from '../store/election';

type Filter = 'all' | 'alerts' | 'news' | 'issues';

/** Headlines about election-day trouble: lawsuits, extended hours, machine failures, shortages, threats. */
const issueItem = (n: NewsItem) => n.kind === 'news' && isIssue(`${n.title} ${n.summary ?? ''}`);

const KIND_LABEL: Record<NewsItem['kind'], string> = {
  call: 'CALL',
  flip: 'FLIP',
  polls: 'POLLS',
  lead: 'LEAD',
  measure: 'MEASURE',
  news: 'NEWS',
  system: 'SYSTEM',
};

/** House calls are high-volume; show only House flips unless explicitly enabled. */
function isNoisy(n: NewsItem) {
  return n.kind === 'call' && !!n.raceId && n.raceId.includes('-H-');
}

const raceOffice = (id: string): Office | null => (id.includes('-H-') ? 'H' : id.endsWith('-S') ? 'S' : id.endsWith('-G') ? 'G' : null);
const OFFICE_RE: Record<Office, RegExp> = {
  S: /\bsenat/i,
  H: /\b(house|congress|congressional|rep\.)/i,
  G: /\b(governor|gubernatorial|gov\.)/i,
};

/** Live feed. With `office`, shows only that office's race alerts, poll closings and matching headlines. */
export function NewsFeed({ office, title = 'Live feed' }: { office?: Office; title?: string } = {}) {
  const now = useNow(15_000);
  const news = useElection((s) => s.news);
  const fresh = useElection((s) => s.freshNews);
  const [filter, setFilter] = useState<Filter>('all');
  const [houseCalls, setHouseCalls] = useState(office === 'H');

  const items = useMemo(() => {
    const officeOk = (n: NewsItem) => {
      if (!office) return true;
      if (n.raceId) return raceOffice(n.raceId) === office;
      if (n.kind === 'polls') return true;
      if (n.kind === 'news') return OFFICE_RE[office].test(`${n.title} ${n.summary ?? ''}`);
      return false;
    };
    return news
      .filter(officeOk)
      .filter((n) => (filter === 'all' ? true : filter === 'alerts' ? n.kind !== 'news' : filter === 'issues' ? issueItem(n) : n.kind === 'news'))
      .filter((n) => houseCalls || !isNoisy(n))
      .slice(0, 200);
  }, [news, filter, houseCalls, office]);
  const issueCount = useMemo(() => news.filter(issueItem).length, [news]);

  return (
    <section className="panel news-panel">
      <div className="panel-head">
        <h2>
          <span className="live-dot" /> {title}
        </h2>
        <div className="chips">
          {(['all', 'alerts', 'news', 'issues'] as Filter[]).map((f) => (
            <button
              key={f}
              className={`chip ${filter === f ? 'on' : ''} ${f === 'issues' ? 'chip-issues' : ''}`}
              onClick={() => setFilter(f)}
              title={f === 'issues' ? 'Lawsuits, polls kept open late, machine or poll-book failures, ballot shortages, long lines, threats' : undefined}
            >
              {f === 'all' ? 'All' : f === 'alerts' ? 'Race alerts' : f === 'news' ? 'Headlines' : '⚠ Voting issues'}
              {f === 'issues' && issueCount ? <span className="muted"> {issueCount}</span> : null}
            </button>
          ))}
          {!office || office === 'H' ? (
            <button className={`chip ${houseCalls ? 'on' : ''}`} onClick={() => setHouseCalls(!houseCalls)} title="Show every House race call">
              House calls
            </button>
          ) : null}
        </div>
      </div>
      <ul className="news-list">
        {items.map((n) => {
          const isFresh = fresh[n.id] && now - fresh[n.id] < 120_000;
          const age = now - Date.parse(n.published);
          const breaking = n.kind === 'news' && age < 15 * 60_000;
          const color = n.party ? PARTY_COLOR[n.party] : undefined;
          const issue = issueItem(n);
          return (
            <li key={n.id} className={`news-item kind-${n.kind} ${issue ? 'issue' : ''} ${isFresh ? 'fresh' : ''}`} style={color ? { borderLeftColor: color } : undefined}>
              <div className="news-meta">
                <span className={`kind kind-${issue ? 'issue' : n.kind}`} style={color && n.kind !== 'news' ? { background: color } : undefined}>
                  {issue ? 'ISSUE' : KIND_LABEL[n.kind]}
                </span>
                {breaking ? <span className="breaking">NEW</span> : null}
                {n.sim ? <span className="sim-tag">SIM</span> : null}
                <span className="news-source">{n.source}</span>
                <span className="news-time" title={new Date(n.published).toLocaleString()}>
                  {fmtEt(n.published)}{n.sim ? '' : ` · ${relTime(n.published, now)}`}
                </span>
              </div>
              {safeHref(n.link) ? (
                <a className="news-title" href={safeHref(n.link)} target="_blank" rel="noreferrer noopener">
                  {n.title}
                </a>
              ) : (
                <div className="news-title">{n.title}</div>
              )}
              {n.summary && n.kind !== 'news' ? <div className="news-summary">{n.summary}</div> : null}
            </li>
          );
        })}
        {!items.length ? <li className="empty">Waiting for news…</li> : null}
      </ul>
    </section>
  );
}
