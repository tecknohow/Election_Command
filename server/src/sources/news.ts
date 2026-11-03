/**
 * Breaking-news aggregator over public RSS feeds. Each feed is fetched with a conditional
 * GET (ETag / Last-Modified) so unchanged feeds cost a 304. Items are de-duplicated by
 * link and normalized headline, then merged with the system-generated race-call alerts.
 *
 * Feeds can be overridden with NEWS_FEEDS="Name|url|filter;Name2|url2" (filter = 1 to apply
 * the election keyword filter, for general-news feeds).
 */
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import type { NewsItem } from '../../../shared/src/types.js';
import { config } from '../config.js';
import { fetchText } from '../lib/http.js';
import { Poller } from '../lib/poller.js';
import { safeUrl } from '../lib/safe.js';
import { store } from '../store/store.js';

interface Feed {
  name: string;
  url: string;
  /** Apply the election keyword filter (general news feeds). */
  filter: boolean;
}

const DEFAULT_FEEDS: Feed[] = [
  { name: 'NYT Politics', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml', filter: false },
  { name: 'NPR Politics', url: 'https://feeds.npr.org/1014/rss.xml', filter: false },
  { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml', filter: false },
  { name: 'The Hill', url: 'https://thehill.com/homenews/campaign/feed/', filter: false },
  { name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/politics', filter: false },
  { name: 'ABC News', url: 'https://abcnews.go.com/abcnews/politicsheadlines', filter: false },
  { name: 'NBC News', url: 'https://feeds.nbcnews.com/nbcnews/public/politics', filter: false },
  { name: 'Fox News', url: 'https://moxie.foxnews.com/google-publisher/politics.xml', filter: false },
  { name: 'Axios', url: 'https://www.axios.com/feeds/feed.rss', filter: true },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=(election+results+OR+projected+winner+OR+race+call)+when:1d&hl=en-US&gl=US&ceid=US:en',
    filter: true,
  },
];

const KEYWORDS = /\b(elect|vote|voter|ballot|senat|governor|gubernatorial|house|congress|poll|campaign|midterm|gop|democrat|republican|race|wins?|projected|concede|turnout|amendment|measure|runoff|recount)/i;

function feedsFromEnv(): Feed[] {
  const raw = process.env.NEWS_FEEDS;
  if (!raw) return DEFAULT_FEEDS;
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, url, filter] = s.split('|');
      return { name, url, filter: filter === '1' };
    });
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });

const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as object)) return String((v as Record<string, unknown>)['#text']);
  return '';
};
const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const arr = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function parseFeed(feed: Feed, xml: string): NewsItem[] {
  const doc = parser.parse(xml);
  const rssItems = arr(doc?.rss?.channel?.item);
  const atomItems = arr(doc?.feed?.entry);
  const out: NewsItem[] = [];
  const cutoff = Date.now() - 48 * 3600_000;

  for (const it of [...rssItems, ...atomItems] as Record<string, unknown>[]) {
    let title = stripHtml(text(it.title));
    if (!title) continue;
    let source = feed.name;
    // Google News appends " - Publisher" to titles.
    if (feed.name === 'Google News') {
      const m = title.match(/^(.*) - ([^-]+)$/);
      if (m) {
        title = m[1].trim();
        source = `${m[2].trim()} (via Google News)`;
      }
    }
    const linkRaw = it.link;
    const link = typeof linkRaw === 'string' ? linkRaw : text((linkRaw as Record<string, unknown>)?.['@href'] ?? linkRaw);
    const dateStr = text(it.pubDate ?? it.published ?? it.updated ?? it['dc:date']);
    const ts = Date.parse(dateStr);
    // Undated items are usually stale evergreen content — skip them.
    if (!Number.isFinite(ts) || ts < cutoff || ts > Date.now() + 3600_000) continue;
    const published = new Date(ts).toISOString();
    const summary = stripHtml(text(it.description ?? it.summary)).slice(0, 300);
    if (feed.filter && !KEYWORDS.test(`${title} ${summary}`)) continue;
    const id = createHash('sha1').update(normTitle(title)).digest('hex').slice(0, 16);
    out.push({ id: `n-${id}`, kind: 'news', source, title, summary: summary || undefined, link: safeUrl(link) ?? undefined, published });
  }
  return out;
}

export function startNews() {
  const feeds = feedsFromEnv();
  const failures = new Map<string, string>();
  const p = new Poller({
    id: 'news',
    name: 'News feeds',
    role: `${feeds.length} RSS feeds (conditional GET, de-duplicated)`,
    hotIntervalS: config.intervals.news.hot,
    coldIntervalS: config.intervals.news.cold,
    enabled: config.sources.news,
    initialDelayMs: 3_000,
    run: async () => {
      const results = await Promise.allSettled(
        feeds.map(async (f) => {
          const res = await fetchText(f.url, { conditional: true, accept: 'application/rss+xml, application/xml, text/xml, */*', timeoutMs: 15_000 });
          return res.changed ? parseFeed(f, res.data!) : [];
        }),
      );
      const items: NewsItem[] = [];
      let ok = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          ok++;
          failures.delete(feeds[i].name);
          items.push(...r.value);
        } else {
          failures.set(feeds[i].name, String(r.reason?.message ?? r.reason));
        }
      });
      if (ok === 0) throw new Error('all feeds failed');
      store.addNews(items);
      const failTxt = failures.size ? ` · failing: ${[...failures.keys()].join(', ')}` : '';
      return `${ok}/${feeds.length} feeds ok${failTxt}`;
    },
  });
  p.start();
  return [p];
}
