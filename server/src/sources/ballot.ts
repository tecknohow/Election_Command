/**
 * State ballot measures (constitutional amendments, initiatives, referenda).
 *
 *  1. CNN       politics.api.cnn.io/results/national-races/2026-I{n}G.json   (n = 1..k)
 *               One file per "issue slot"; each holds one measure per state (62 measures in 27
 *               states as of Nov 2). Live votes + calls. Discovered by probing n until 404.
 *  2. NYT / AP  static01.nyt.com/.../2026-11-03/results-{state-slug}.json  (office_id "I")
 *               Per-state results files cover every statewide measure AP tabulates. Not yet
 *               published as of Nov 2. Missing states are re-probed every 10 min (hot) / 60 min.
 *  3. Wikipedia "2026 United States ballot measures": complete catalog of certified measures
 *               with origin (legislature vs citizens) and what a yes vote does; used to classify
 *               constitutional amendments and to list measures no results feed covers.
 */
import type { MeasureChoice } from '../../../shared/src/types.js';
import { STATE_BY_NAME, STATE_BY_POSTAL } from '../../../shared/src/states.js';
import { CNN_BASE, config, isHot, NYT_BASE } from '../config.js';
import { fetchJson, HttpError } from '../lib/http.js';
import { logger } from '../lib/log.js';
import { Poller } from '../lib/poller.js';
import { codeToken, measureStore, sideOf, similarity, type CatalogEntry, type MeasureInput } from '../store/measures.js';

const log = logger('ballot');
const year = config.electionDate.slice(0, 4);

// ------------------------------------------------------------------ CNN

interface CnnMeasure {
  ecKey: string;
  stateAbbreviation: string;
  raceTitle: string;
  raceShortTitle: string;
  status: string;
  percentReporting: number;
  totalVote: number;
  candidates: { fullName: string; voteNum: number; winner: boolean }[];
  raceEmbargo?: { assignedPollsClose?: number };
  voteTimestamp?: string;
  extractedAt?: string;
}

let cnnSlots = 0;
const cachedSlots = new Map<number, CnnMeasure[]>();
const keyFor = (state: string, code: string | null, fallback: string) => `${state}-${codeToken(code) ?? fallback}`;

function normalizeCnn(r: CnnMeasure): MeasureInput {
  const choices: MeasureChoice[] = r.candidates.map((c) => ({ label: c.fullName, side: sideOf(c.fullName), votes: c.voteNum ?? 0, pct: 0, winner: !!c.winner }));
  const called = choices.some((c) => c.winner) || r.status === 'W';
  return {
    key: keyFor(r.stateAbbreviation, r.raceTitle, r.ecKey.split('-')[1]),
    state: r.stateAbbreviation,
    code: r.raceTitle || null,
    title: (r.raceShortTitle || r.raceTitle).trim(),
    description: null,
    choices,
    totalVotes: r.totalVote ?? 0,
    eevp: r.percentReporting ?? null,
    called,
    calledBy: called ? 'CNN' : null,
    pollClose: r.raceEmbargo?.assignedPollsClose ? new Date(r.raceEmbargo.assignedPollsClose).toISOString() : null,
    url: null,
    updatedAt: r.voteTimestamp ?? r.extractedAt ?? null,
    source: 'CNN',
  };
}

async function pullCnn(): Promise<string | boolean> {
  const items: MeasureInput[] = [];
  let changed = false;
  let n = 1;
  // Fetch every known slot plus one more to detect newly added slots.
  for (; n <= Math.max(cnnSlots + 1, 1); n++) {
    try {
      const res = await fetchJson<CnnMeasure[]>(`${CNN_BASE}/${year}-I${n}G.json`, { conditional: true });
      if (res.changed) changed = true;
      cachedSlots.set(n, res.changed ? (res.data ?? []) : (cachedSlots.get(n) ?? []));
      if (n > cnnSlots) cnnSlots = n;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) break;
      throw err;
    }
  }
  if (!changed) {
    measureStore.touch('cnn');
    return false;
  }
  // CNN's 2026 slots also hold measures decided at earlier 2026 elections (e.g. May/August);
  // keep only those whose polls close on general-election night.
  const cutoff = Date.parse(`${config.electionDate}T12:00:00Z`);
  const onGeneral = (r: CnnMeasure) => !r.raceEmbargo?.assignedPollsClose || r.raceEmbargo.assignedPollsClose >= cutoff;
  for (const [slot, list] of cachedSlots) if (slot <= cnnSlots) items.push(...list.filter(onGeneral).map(normalizeCnn));
  measureStore.ingest('cnn', items);
  return `${items.length} measures in ${cnnSlots} slots`;
}

// ------------------------------------------------------------------ NYT state files

interface NytMeasureRace {
  nyt_id: string;
  office_id: string;
  /** "Proposition", "Constitutional Amendment", ... or "Local Measure". */
  office?: string | null;
  /** "state" for statewide measures; "county"/"city" for local ones in the same file. */
  coverage?: string | null;
  seat: string | null;
  seat_number: string | null;
  long_description: string | null;
  ballot_measure_text: string | null;
  candidate_metadata: Record<string, { nyt_id: string; last_name: string; party?: { name?: string } }>;
  outcome: { won: string[]; called_by: string[] | null };
  top_reporting_unit: { state_postal: string; eevp: number | null; total_votes: number; provider_updated_at: string | null; candidates: { nyt_id: string; votes: { total: number } }[] };
  url: string | null;
}

const nytFound = new Map<string, MeasureInput[]>(); // state -> measures
const nytProbedAt = new Map<string, number>();
const nytMissing = new Set<string>();

function normalizeNyt(r: NytMeasureRace): MeasureInput | null {
  const ru = r.top_reporting_unit;
  if (!ru?.state_postal) return null;
  const text = r.ballot_measure_text ?? r.seat ?? 'Ballot measure';
  const [codePart, ...rest] = text.split(':');
  const code = rest.length ? codePart.trim() : null;
  const title = rest.length ? rest.join(':').trim() : text.trim();
  const won = new Set(r.outcome?.won ?? []);
  const votes = new Map(ru.candidates.map((c) => [c.nyt_id, c.votes?.total ?? 0]));
  const choices: MeasureChoice[] = Object.values(r.candidate_metadata).map((c) => {
    const label = c.party?.name ?? c.last_name;
    return { label, side: sideOf(label), votes: votes.get(c.nyt_id) ?? 0, pct: 0, winner: won.has(c.nyt_id) };
  });
  return {
    key: keyFor(ru.state_postal, code, r.seat_number ?? r.nyt_id),
    state: ru.state_postal,
    code,
    title,
    description: r.long_description,
    choices,
    totalVotes: ru.total_votes ?? 0,
    eevp: ru.eevp ?? null,
    called: won.size > 0,
    calledBy: won.size ? (r.outcome.called_by ?? ['ap']).join('/').toUpperCase() : null,
    pollClose: null,
    url: r.url,
    updatedAt: ru.provider_updated_at,
    source: 'NYT/AP',
  };
}

async function pullNytStates(): Promise<string | boolean> {
  const states = measureStore.catalogStates();
  const probeEvery = isHot() ? 10 * 60_000 : 60 * 60_000;
  let changed = false;
  let attempts = 0;
  let netErrors = 0;
  for (const st of states) {
    const name = STATE_BY_POSTAL[st]?.name;
    if (!name) continue;
    const known = nytFound.has(st);
    if (!known && Date.now() - (nytProbedAt.get(st) ?? 0) < probeEvery) continue;
    nytProbedAt.set(st, Date.now());
    attempts++;
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    try {
      const res = await fetchJson<{ races: NytMeasureRace[] }>(`${NYT_BASE}/results-${slug}.json`, { conditional: true, timeoutMs: 30_000 });
      nytMissing.delete(st);
      if (!res.changed) continue;
      // The state files also carry local measures (city/county); the dashboard is statewide only.
      const statewide = (r: NytMeasureRace) => r.office_id === 'I' && (r.coverage ?? 'state') === 'state' && !/local/i.test(r.office ?? '');
      const list = (res.data?.races ?? []).filter(statewide).map(normalizeNyt).filter((m): m is MeasureInput => !!m);
      nytFound.set(st, list);
      changed = true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
        nytMissing.add(st);
        continue;
      }
      // Transient network error for one state: retry it on the next cycle instead of failing all.
      netErrors++;
      nytProbedAt.delete(st);
    }
  }
  if (attempts > 0 && netErrors === attempts) throw new Error(`all ${attempts} NYT state requests failed`);
  if (changed) measureStore.ingest('nyt', [...nytFound.values()].flat());
  else if (nytFound.size) measureStore.touch('nyt');
  return nytFound.size ? `${nytFound.size} state files live (${[...nytFound.values()].flat().length} measures)` : `waiting for NYT state files (${nytMissing.size} probed, not yet published)`;
}

// ------------------------------------------------------------------ Wikipedia catalog

const stripWiki = (s: string) =>
  s
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/\{\{nbsp\}\}/gi, ' ')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** An official designation: "Amendment 1", "Question 3", "State Question 832", "Amendment J". */
const DESIGNATION =
  '(?:State |Public |Legislative |Referred |Ballot )?(?:Constitutional Amendment|Amendment|Proposition|Question|Measure|Issue|Initiative|Referendum|Proposal)\\s+(?:No\\.\\s*)?(?:[A-Z]{0,3}-?\\d+[A-Z]?|[A-Z])(?![\\w-])';
/** Bill/initiative numbers used as names: "HJR 4" (Idaho), "CI-132", "I-194", "LR-131" (Montana). */
const SHORT_CODE = '(?:[HS]J?R|[HS]CR|LB|LR) ?\\d+|[A-Z]{1,3}-\\d+[A-Z]?';
/** "Amendment 2, Prohibit Diminishing ..." -> ["Amendment 2", "Prohibit Diminishing ..."]. */
const LEADING_CODE = new RegExp(`^(${DESIGNATION}|${SHORT_CODE})[,:]?\\s+(.+)$`);

function splitCode(name: string): { code: string | null; rest: string } {
  const m = name.match(LEADING_CODE);
  return m ? { code: m[1], rest: m[2] } : { code: null, rest: name };
}

/** Only links to ballotpedia.org over https are kept; anything else is dropped. */
function ballotpediaUrl(raw: string): string | null {
  try {
    const u = new URL(raw.replace(/^http:/, 'https:'));
    if (u.protocol !== 'https:' || !/^(www\.)?ballotpedia\.org$/.test(u.hostname) || u.pathname.length < 2) return null;
    u.hostname = 'ballotpedia.org';
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Ballotpedia page name from its URL slug: ".../Nevada_Question_7,_Require_Voter_Identification_Initiative_(2026)". */
function ballotpediaName(url: string, stateName: string): { code: string | null; name: string } | null {
  let slug: string;
  try {
    slug = decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    return null;
  }
  const m = slug.replace(/_/g, ' ').match(/^(.+?)\s*\((?:November )?\d{4}\)$/);
  if (!m) return null; // not a single-measure page (e.g. a state's list of measures)
  if (!m[1].startsWith(`${stateName} `)) return null;
  const { code, rest } = splitCode(m[1].slice(stateName.length + 1));
  return rest.length > 3 ? { code, name: rest } : null;
}

type Row = CatalogEntry & { wiki: { code: string | null; rest: string } };

const REF_URL = /url\s*=\s*(https?:\/\/(?:www\.)?ballotpedia\.org\/[^\s|}<]+)/i;

export function parseCatalog(wikitext: string): CatalogEntry[] {
  const start = wikitext.indexOf('==By state==');
  const end = wikitext.indexOf('==By topic==');
  const body = wikitext.slice(start, end > 0 ? end : undefined);
  // Rows can cite a reference defined elsewhere on the page: <ref name=":3" />.
  const namedRefs = new Map<string, string>();
  for (const m of wikitext.matchAll(/<ref\s+name\s*=\s*"?([^">\/]+?)"?\s*>([\s\S]*?)<\/ref>/g)) {
    const url = m[2].match(REF_URL)?.[1];
    if (url) namedRefs.set(m[1].trim(), url);
  }
  const parts = body.split(/\n===\s*([^=]+?)\s*===/);
  const out: CatalogEntry[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const st = STATE_BY_NAME[parts[i].trim().toLowerCase()];
    if (!st) continue;
    for (const row of parts[i + 1].split('\n|-').slice(1)) {
      const cells = row
        .split(/\n\|/)
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length < 5) continue;
      const [origin, status, name, desc, date] = cells;
      const d = stripWiki(date);
      if (!/Nov\w*\s*3\b/.test(d) && !/November 3/.test(d)) continue;
      const statusTxt = stripWiki(status.split('|').pop() ?? '');
      if (/withdrawn|removed|struck/i.test(statusTxt)) continue;

      const stripState = (s: string) => s.replace(new RegExp(`^${st.name}\\s+`), '');
      const wikiName = splitCode(stripState(stripWiki(name)));
      wikiName.rest = stripState(wikiName.rest);
      const refName = [...`${name}\n${desc}`.matchAll(/<ref\s+name\s*=\s*"?([^">\/]+?)"?\s*\/>/g)].map((m) => namedRefs.get(m[1].trim())).find(Boolean);
      const rawUrl = `${name}\n${desc}`.match(REF_URL)?.[1] ?? refName;
      let bpUrl = rawUrl ? ballotpediaUrl(rawUrl) : null;
      let bp = bpUrl ? ballotpediaName(bpUrl, st.name) : null;
      // Citations copied from a neighboring row (another state, or another measure with a different
      // number or subject) are slips on the wiki page: fall back to the row's own name.
      if (bpUrl && !bp && !bpUrl.includes(`/${encodeURIComponent(st.name.replace(/ /g, '_'))}_`)) bpUrl = null;
      if (bp && ((bp.code && wikiName.code && codeToken(bp.code) !== codeToken(wikiName.code)) || similarity(bp.name, `${wikiName.rest} ${stripWiki(desc)}`) < 0.2)) {
        bp = null;
        bpUrl = null;
      }
      const article = name.match(/\[\[([^|\]#]+)/)?.[1]?.trim() ?? null;
      // The page also lists some local measures (e.g. Buffalo charter amendments); keep statewide only.
      if (/\b(city|county|town|village|borough|parish) of\b|charter revision/i.test(stripWiki(origin)) || /\b(county|city)\b.*ballot measures/i.test(article ?? '')) continue;
      out.push({
        state: st.postal,
        name: bp?.name ?? wikiName.rest,
        description: stripWiki(desc),
        origin: /citizen/i.test(origin) ? 'Citizens' : /legislat|general assembly|congress/i.test(origin) ? 'Legislature' : stripWiki(origin) || null,
        code: bp?.code ?? wikiName.code,
        ballotpediaUrl: bpUrl,
        article,
        wiki: wikiName,
      } as Row);
    }
  }
  // Two rows citing the same Ballotpedia page: keep it on the row whose own name matches best.
  const byUrl = new Map<string, Row[]>();
  for (const e of out as Row[]) if (e.ballotpediaUrl) byUrl.set(e.ballotpediaUrl, [...(byUrl.get(e.ballotpediaUrl) ?? []), e]);
  for (const rows of byUrl.values()) {
    if (rows.length < 2) continue;
    const score = (e: Row) => similarity(e.name, e.wiki.rest);
    const keep = rows.reduce((a, b) => (score(b) > score(a) ? b : a));
    for (const e of rows) if (e !== keep) Object.assign(e, { name: e.wiki.rest, code: e.wiki.code ?? e.code, ballotpediaUrl: null });
  }
  return (out as Row[]).map(({ wiki: _w, ...e }) => e);
}

/**
 * Many rows link to an article whose title carries the official number even when the row doesn't
 * ("2026 Alabama lieutenant governor vacancy amendment" redirects to "November 2026 Alabama
 * Amendment 1"). Look those up in batches; results are cached for the life of the process.
 */
/** article -> resolved page title (null if the page doesn't exist) and the number found in it. */
const articleInfo = new Map<string, { title: string | null; code: string | null }>();
const wikiUrl = (title: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2C/g, ',').replace(/%3A/g, ':')}`;

function codeFromArticle(title: string, extract: string, stateName: string): string | null {
  const inTitle = title.includes(stateName) ? title.match(new RegExp(DESIGNATION)) : null;
  if (inTitle) return inTitle[0];
  // Lead sentence of the form "... Alabama Amendment 1 is ..." / "Nevada Question 7, the ...".
  const lead = extract.match(new RegExp(`${stateName} (${DESIGNATION})`));
  return lead?.[1] ?? null;
}

export async function resolveArticleCodes(entries: CatalogEntry[]): Promise<number> {
  // Needed for a missing number, or for a Wikipedia link when there's no Ballotpedia page.
  const want = entries.filter((e) => e.article && (!e.code || !e.ballotpediaUrl));
  const todo = [...new Set(want.map((e) => e.article!).filter((a) => !articleInfo.has(a)))];
  for (let i = 0; i < todo.length; i += 20) {
    const batch = todo.slice(i, i + 20);
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=extracts&exintro=1&explaintext=1&exsentences=2&exlimit=20&titles=${encodeURIComponent(batch.join('|'))}`;
    const res = await fetchJson<{
      query?: { normalized?: { from: string; to: string }[]; redirects?: { from: string; to: string }[]; pages?: { title: string; extract?: string; missing?: boolean }[] };
    }>(url);
    const q = res.data?.query;
    const norm = new Map((q?.normalized ?? []).map((r) => [r.from, r.to]));
    const redir = new Map((q?.redirects ?? []).map((r) => [r.from, r.to]));
    const pages = new Map((q?.pages ?? []).filter((p) => !p.missing).map((p) => [p.title, p.extract ?? '']));
    for (const a of batch) {
      const n = norm.get(a) ?? a;
      const title = redir.get(n) ?? n;
      const entry = want.find((e) => e.article === a)!;
      const stateName = STATE_BY_POSTAL[entry.state]?.name ?? '';
      articleInfo.set(a, pages.has(title) ? { title, code: codeFromArticle(title, pages.get(title)!, stateName) } : { title: null, code: null });
    }
  }
  let filled = 0;
  for (const e of want) {
    const info = articleInfo.get(e.article!);
    if (!e.code && info?.code) {
      e.code = info.code;
      filled++;
    }
    if (info?.title) e.wikipediaUrl = wikiUrl(info.title);
  }
  return filled;
}

async function pullCatalog(): Promise<string> {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${year}_United_States_ballot_measures&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const res = await fetchJson<{ parse?: { wikitext: string } }>(url);
  const entries = parseCatalog(res.data?.parse?.wikitext ?? '');
  if (!entries.length) throw new Error('no November measures parsed from catalog');
  try {
    await resolveArticleCodes(entries);
  } catch (err) {
    log.warn('could not look up linked Wikipedia articles', err);
  }
  measureStore.setCatalog(entries);
  const amend = entries.filter((e) => /amendment|constitution/i.test(`${e.code ?? ''} ${e.name} ${e.description}`)).length;
  const numbered = entries.filter((e) => e.code).length;
  const bp = entries.filter((e) => e.ballotpediaUrl).length;
  log.info(`catalog: ${entries.length} November measures (${amend} constitutional amendments, ${numbered} numbered, ${bp} with Ballotpedia pages)`);
  return `${entries.length} measures on Nov 3 ballots (${amend} amendments, ${numbered} numbered)`;
}

export function startBallot() {
  const cnn = new Poller({
    id: 'cnn-measures',
    name: 'CNN ballot measures',
    role: 'Live results for notable statewide measures',
    hotIntervalS: config.intervals.cnn.hot,
    coldIntervalS: config.intervals.cnn.cold,
    enabled: config.sources.cnn,
    initialDelayMs: 5_000,
    run: pullCnn,
  });
  const catalog = new Poller({
    id: 'wikipedia-measures',
    name: 'Ballot measure catalog',
    role: 'Every certified measure: type, origin, description (Wikipedia)',
    hotIntervalS: 3600,
    coldIntervalS: 3600,
    enabled: config.sources.wikipedia,
    initialDelayMs: 2_500,
    run: pullCatalog,
  });
  const nyt = new Poller({
    id: 'nyt-measures',
    name: 'NYT / AP state files',
    role: 'All statewide measures once NYT publishes per-state files',
    hotIntervalS: config.intervals.nytMeasures.hot,
    coldIntervalS: config.intervals.nytMeasures.cold,
    enabled: config.sources.nyt,
    initialDelayMs: 20_000,
    run: pullNytStates,
  });
  cnn.start();
  catalog.start();
  nyt.start();
  return [cnn, catalog, nyt];
}
