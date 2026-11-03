/**
 * Wikipedia "Predictions" tables for the 2026 Senate and gubernatorial elections.
 *
 * Provides, per race:
 *  - FLIPR forecast   -> the "Silver" (Silver Bulletin) column. FLIPR is Nate Silver's model;
 *                        its race-level probabilities are paywalled, but its published rating
 *                        categories are tracked on Wikipedia and refreshed daily by editors.
 *  - Cook rating      -> the "Cook" column (fallback forecast).
 *  - Prior party      -> the incumbent's {{Party shading/...}} cell.
 *
 * MediaWiki API: no hard rate limit for polite clients (descriptive User-Agent, serial
 * requests). We refresh every 30-60 minutes — ratings don't move on election night.
 */
import type { Office, Party } from '../../../shared/src/types.js';
import { parseWikiRating } from '../../../shared/src/ratings.js';
import { STATE_BY_NAME, raceId } from '../../../shared/src/states.js';
import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { Poller } from '../lib/poller.js';
import { store } from '../store/store.js';
import type { Enrichment } from '../store/types.js';

const log = logger('wikipedia');
const year = config.electionDate.slice(0, 4);
const PAGES: { office: Office; page: string }[] = [
  { office: 'S', page: `${year}_United_States_Senate_elections` },
  { office: 'G', page: `${year}_United_States_gubernatorial_elections` },
];

const partyFromShading = (s: string): Party | undefined => {
  const m = s.match(/Party shading\/([^}|]+)/i);
  if (!m) return undefined;
  const p = m[1].toLowerCase();
  // Minnesota's DFL and North Dakota's Dem-NPL are Democratic affiliates.
  if (/democ|farmer|labor|^dfl$|nonpartisan league|npl/.test(p.trim())) return 'D';
  if (/republ/.test(p)) return 'R';
  return 'I';
};

/** Extract the display text of the first [[link|text]] or [[text]]. */
const linkText = (s: string) => {
  const m = s.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
  return m ? (m[2] ?? m[1]).trim() : s.trim();
};

export function parsePredictions(office: Office, wikitext: string): Map<string, Enrichment> {
  const out = new Map<string, Enrichment>();
  const start = wikitext.indexOf('== Predictions');
  if (start < 0) throw new Error('Predictions section not found');
  const end = wikitext.indexOf('\n|}', start);
  const table = wikitext.slice(start, end > 0 ? end : undefined);
  const rows = table.split(/\n\|-/);

  // Header: rating columns are the header cells after "Last election" up to the first state row.
  const headerCells: string[] = [];
  for (const row of rows.slice(0, 3)) {
    for (const line of row.split('\n')) {
      if (line.startsWith('!') && !line.includes('election in') && !/gubernatorial election\|/.test(line)) headerCells.push(line.slice(1));
    }
  }
  const lastIdx = headerCells.findIndex((h) => /Last<br/i.test(h) || /Last election/i.test(h));
  const ratingCols = headerCells
    .slice(lastIdx + 1)
    .filter((h) => !/Result/.test(h))
    .map((h) => linkText(h.replace(/''/g, '')));
  const cookIdx = ratingCols.findIndex((c) => /^Cook/i.test(c));
  const silverIdx = ratingCols.findIndex((c) => /^Silver/i.test(c));
  if (cookIdx < 0 && silverIdx < 0) throw new Error(`no Cook/Silver columns found in ${ratingCols.join(',')}`);

  for (const row of rows) {
    const head = row.match(/\n!\s*(\[\[[^\n]+)/);
    if (!head) continue;
    const special = /\(special\)|special election/i.test(head[1]);
    const name = linkText(head[1]).replace(/\s*\(special\)/i, '');
    const st = STATE_BY_NAME[name.toLowerCase()];
    if (!st) continue;
    const ratings = [...row.matchAll(/\{\{USRaceRating\|([^}]*)\}\}/g)].map((m) => m[1].split('|'));
    const sortname = row.match(/\{\{sortname\|([^|}]+)\|([^|}]+)/);
    const e: Enrichment = {
      ...(special ? { special: true } : {}),
      priorParty: partyFromShading(row),
      incumbentName: sortname ? `${sortname[1]} ${sortname[2]}`.trim() : undefined,
    };
    if (silverIdx >= 0 && ratings[silverIdx]) e.flipr = parseWikiRating('FLIPR', ratings[silverIdx]);
    if (cookIdx >= 0 && ratings[cookIdx]) e.cook = parseWikiRating('Cook', ratings[cookIdx]);
    out.set(raceId(st.postal, office), e);
  }
  return out;
}

const ushr = /\{\{ushr\|([A-Z]{2})\|([A-Z0-9]+)/i;
const districtNum = (raw: string) => (/^(AL|AT-LARGE)$/i.test(raw) ? 1 : Number(raw) || 1);

/**
 * House: "2026 United States House of Representatives election ratings" lists every
 * competitive district with Cook, Silver (FLIPR) etc.; rating columns are the header cells that
 * carry an as-of date.
 */
export function parseHouseRatings(wikitext: string): Map<string, Enrichment> {
  const out = new Map<string, Enrichment>();
  const first = wikitext.search(/\n!\{\{ushr/i);
  if (first < 0) throw new Error('no district rows in House ratings');
  const headerZone = wikitext.slice(wikitext.lastIndexOf('{|', first), first);
  const ratingCols = headerZone
    .split('\n')
    .filter((l) => l.startsWith('!') && /\{\{small\|/i.test(l))
    .map((l) => linkText(l.slice(1).replace(/''/g, '')));
  const cookIdx = ratingCols.findIndex((c) => /^Cook/i.test(c));
  const silverIdx = ratingCols.findIndex((c) => /^Silver/i.test(c));
  for (const row of wikitext.slice(first).split(/\n\|-/)) {
    const m = row.match(ushr);
    if (!m || !STATE_BY_POSTAL_SET.has(m[1].toUpperCase())) continue;
    const ratings = [...row.matchAll(/\{\{USRaceRating\|([^}]*)\}\}/g)].map((x) => x[1].split('|'));
    const sortname = row.match(/\{\{sortname\|([^|}]+)\|([^|}]+)/);
    const e: Enrichment = { priorParty: partyFromShading(row), incumbentName: sortname ? `${sortname[1]} ${sortname[2]}`.trim() : undefined };
    if (silverIdx >= 0 && ratings[silverIdx]) e.flipr = parseWikiRating('FLIPR', ratings[silverIdx]);
    if (cookIdx >= 0 && ratings[cookIdx]) e.cook = parseWikiRating('Cook', ratings[cookIdx]);
    out.set(raceId(m[1].toUpperCase(), 'H', districtNum(m[2])), e);
  }
  return out;
}

/** House: per-state district tables on the main elections page give the incumbent's party for all 435. */
export function parseHouseIncumbents(wikitext: string): Map<string, Enrichment> {
  const out = new Map<string, Enrichment>();
  for (const row of wikitext.split(/\n\|-/)) {
    const m = row.match(/\n?!\s*\{\{ushr\|([A-Z]{2})\|([A-Z0-9]+)/i);
    if (!m || !STATE_BY_POSTAL_SET.has(m[1].toUpperCase())) continue;
    const partyCell = row.match(/\|\s*style="[^"]*"\s*\|\s*(Republican|Democratic(?:[–-]Farmer[–-]Labor)?|DFL|Independent|Libertarian)\b/i);
    let party: Party | undefined;
    if (partyCell) party = /^(democ|dfl)/i.test(partyCell[1]) ? 'D' : /^republ/i.test(partyCell[1]) ? 'R' : 'I';
    const member = row.match(/\{\{sortname\|([^|}]+)\|([^|}]+)/) ?? row.match(/\n\|\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
    const id = raceId(m[1].toUpperCase(), 'H', districtNum(m[2]));
    if (out.has(id)) continue;
    out.set(id, { priorParty: party, incumbentName: member ? (member[2] ? `${member[1]} ${member[2]}` : member[1]).trim() : undefined });
  }
  return out;
}

const STATE_BY_POSTAL_SET = new Set(Object.values(STATE_BY_NAME).map((s) => s.postal));

async function wikitext(page: string): Promise<string> {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const res = await fetchJson<{ parse?: { wikitext: string }; error?: { info: string } }>(url);
  if (res.data?.error) throw new Error(res.data.error.info);
  return res.data!.parse!.wikitext;
}

export function startWikipedia() {
  const p = new Poller({
    id: 'wikipedia',
    name: 'Wikipedia forecasts',
    role: 'FLIPR (Silver Bulletin) + Cook ratings, prior seat control',
    hotIntervalS: config.intervals.wikipedia.hot,
    coldIntervalS: config.intervals.wikipedia.cold,
    enabled: config.sources.wikipedia,
    initialDelayMs: 1_000,
    run: async () => {
      const all = new Map<string, Enrichment>();
      const counts: string[] = [];
      for (const { office, page } of PAGES) {
        const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2&redirects=1`;
        const res = await fetchJson<{ parse?: { wikitext: string }; error?: { info: string } }>(url);
        if (res.data?.error) throw new Error(res.data.error.info);
        const parsed = parsePredictions(office, res.data!.parse!.wikitext);
        parsed.forEach((v, k) => all.set(k, v));
        const fl = [...parsed.values()].filter((e) => e.flipr).length;
        counts.push(`${office}: ${parsed.size} rows, ${fl} FLIPR`);
      }
      // House: incumbents for all districts, then ratings for competitive seats layered on top.
      try {
        const inc = parseHouseIncumbents(await wikitext(`${year}_United_States_House_of_Representatives_elections`));
        const rat = parseHouseRatings(await wikitext(`${year}_United_States_House_of_Representatives_election_ratings`));
        for (const [k, v] of inc) all.set(k, v);
        for (const [k, v] of rat) all.set(k, { ...all.get(k), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) });
        counts.push(`H: ${inc.size} incumbents, ${[...rat.values()].filter((e) => e.flipr).length} FLIPR`);
      } catch (err) {
        log.warn('House tables failed to parse', err);
        counts.push('H: failed');
      }
      log.info(`parsed ratings (${counts.join('; ')})`);
      store.setEnrichment(all);
      return counts.join(' · ');
    },
  });
  p.start();
  return [p];
}
