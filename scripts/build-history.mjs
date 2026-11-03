#!/usr/bin/env node
/**
 * Build the historical baselines the app compares tonight's results against.
 * Output: shared/src/history.json (committed; past results don't change).
 *
 * Sources:
 *  - CNN results API (the same feed the app reads live), past national files:
 *      politics.api.cnn.io/results/national-races/{2020,2022,2024}-SG.json   Senate
 *      .../{2022,2024}-GG.json   Governor      .../{2022,2024}-HG.json   House
 *      .../2024-PG.json          President by state
 *  - US Census TIGER/Line Congressional Districts, 119th (2024 lines) vs 120th (2026 lines):
 *      a district whose land area differs is flagged linesChanged, so its 2024 House result is
 *      labelled "old lines" (the 2024 presidential margin from NYT is already on the new lines).
 *  - Wikipedia "{year} United States House/Senate elections" infoboxes: midterm seat changes and
 *      national House vote shares, 1994-2022.
 *
 * Senate seats are matched by class, never by state alone. CNN race types: SG = regular election
 * (class 2 in 2020, 3 in 2022, 1 in 2024), SW = its runoff, SP = same-class short-term special,
 * S2G / S2W = the state's *other* seat (special) and its runoff. A 2026 race uses the most recent
 * earlier contest for the same seat: e.g. GA (class 2) -> Jan 2021 runoff, OK (class 2) -> 2022
 * special, NE (class 2) -> 2024 special, OH/FL (class 3 specials) -> 2022 regular.
 *
 * Margins are D minus R, in percentage points of all votes cast (positive = Democratic).
 * Usage: node scripts/build-history.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shapefile from 'shapefile';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'history');
const outFile = path.join(root, 'shared', 'src', 'history.json');
mkdirSync(cache, { recursive: true });
const UA = { 'User-Agent': 'ElectionCommand/0.1 (history build script)' };

async function cached(name, url, binary = false) {
  const file = path.join(cache, name);
  if (!existsSync(file)) {
    process.stdout.write(`  fetching ${url}\n`);
    let res;
    for (let attempt = 0; attempt < 5; attempt++) {
      // Be gentle with Wikipedia: space requests out and back off on 429.
      if (url.includes('wikipedia.org')) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      res = await fetch(url, { headers: UA });
      if (res.status !== 429) break;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    writeFileSync(file, binary ? Buffer.from(await res.arrayBuffer()) : await res.text());
  }
  return binary ? file : readFileSync(file, 'utf8');
}
const cnn = async (code) => JSON.parse(await cached(`cnn-${code}.json`, `https://politics.api.cnn.io/results/national-races/${code}.json`));
const round = (x, d = 2) => (x == null ? null : +x.toFixed(d));

/** D-R summary of one CNN contest. */
function summarize(r) {
  const cands = r.candidates ?? [];
  // CNN lists the main candidates only; totalVote includes everyone (minor candidates, write-ins).
  const total = Math.max(
    r.totalVote ?? 0,
    cands.reduce((s, c) => s + (c.voteNum ?? 0), 0),
  );
  const top = (p) => cands.filter((c) => c.majorParty === p).sort((a, b) => (b.voteNum ?? 0) - (a.voteNum ?? 0))[0];
  const d = top('DEM');
  const rr = top('REP');
  const winner = cands.find((c) => c.winner);
  const side = (c) => (c ? { name: c.fullName, pct: total ? round((c.voteNum / total) * 100, 1) : null } : null);
  let kind = 'DR';
  if (d && rr) kind = 'DR';
  else if (cands.length <= 1 || total === 0) kind = d ? 'D-unopposed' : rr ? 'R-unopposed' : 'other';
  else if (d && !rr) kind = cands.filter((c) => c.majorParty === 'DEM').length > 1 ? 'DD' : 'D-noR';
  else if (rr && !d) kind = cands.filter((c) => c.majorParty === 'REP').length > 1 ? 'RR' : 'R-noD';
  else kind = 'other';
  const margin = d && rr && total ? round(((d.voteNum - rr.voteNum) / total) * 100) : null;
  const wParty = winner?.majorParty === 'DEM' ? 'D' : winner?.majorParty === 'REP' ? 'R' : winner ? 'I' : null;
  return { margin, kind, d: side(d), r: side(rr), winner: winner ? { name: winner.fullName, party: wParty } : null, total };
}

// ------------------------------------------------------------ Senate, by seat class
const CLASS_OF_YEAR = { 2020: 2, 2022: 3, 2024: 1, 2026: 2 };
const senateFiles = { 2020: await cnn('2020-SG'), 2022: await cnn('2022-SG'), 2024: await cnn('2024-SG') };
const now26 = await cnn('2026-SG');

function contestClass(year, type, targetClass) {
  if (/^S(G|W|P)$/.test(type)) return CLASS_OF_YEAR[year];
  if (/^S2(G|W)$/.test(type)) return CLASS_OF_YEAR[year] === targetClass ? null : targetClass; // the state's other seat
  return null;
}
const LABEL = { SG: '', SW: 'runoff', SP: 'special', S2G: 'special', S2W: 'special runoff' };

const senate = {};
for (const r of now26) {
  const st = r.stateAbbreviation;
  const type26 = r.ecKey.split('-')[1];
  // 2026 regular elections are class 2; the 2026 specials (OH, FL) fill the state's class 3 seat.
  const target = type26 === 'SG' ? 2 : 3;
  const options = [];
  for (const [y, list] of Object.entries(senateFiles)) {
    for (const c of list.filter((x) => x.stateAbbreviation === st)) {
      const type = c.ecKey.split('-')[1];
      if (contestClass(Number(y), type, target) !== target) continue;
      // A same-class short special (SP) only covers the lame-duck weeks; the regular is the real contest.
      if (type === 'SP') continue;
      options.push({ year: Number(y), type, close: c.raceEmbargo?.assignedPollsClose ?? 0, c });
    }
  }
  options.sort((a, b) => b.close - a.close);
  const best = options[0];
  if (!best) {
    console.warn(`  ! no previous Senate contest found for ${st} class ${target}`);
    continue;
  }
  const s = summarize(best.c);
  const year = new Date(best.close).getUTCFullYear() > best.year && /W$/.test(best.type) ? new Date(best.close).getUTCFullYear() : best.year;
  senate[`${st}-S`] = { year, seatClass: target, label: [year, LABEL[best.type]].filter(Boolean).join(' '), ...s, cnnKey: best.c.ecKey };
}

// ------------------------------------------------------------ Governor: most recent contest
const gov = {};
const now26g = await cnn('2026-GG');
const govFiles = { 2024: await cnn('2024-GG'), 2022: await cnn('2022-GG') };
for (const r of now26g) {
  const st = r.stateAbbreviation;
  for (const y of [2024, 2022]) {
    const c = govFiles[y].find((x) => x.stateAbbreviation === st);
    if (c) {
      gov[`${st}-G`] = { year: y, label: String(y), ...summarize(c), cnnKey: c.ecKey };
      break;
    }
  }
  if (!gov[`${st}-G`]) console.warn(`  ! no previous governor contest for ${st}`);
}

// ------------------------------------------------------------ House 2024 by district + vote totals
const house = { 2022: await cnn('2022-HG'), 2024: await cnn('2024-HG') };
const houseVote = {};
for (const [y, list] of Object.entries(house)) {
  const nat = { D: 0, R: 0, total: 0 };
  const byState = {};
  for (const r of list.filter((x) => x.ecKey.split('-')[1] === 'HG')) {
    const s = (byState[r.stateAbbreviation] ??= { D: 0, R: 0, total: 0 });
    const listed = r.candidates.reduce((a, c) => a + (c.voteNum ?? 0), 0);
    for (const t of [nat, s]) {
      t.total += Math.max(r.totalVote ?? 0, listed);
      for (const c of r.candidates) {
        if (c.majorParty === 'DEM') t.D += c.voteNum ?? 0;
        if (c.majorParty === 'REP') t.R += c.voteNum ?? 0;
      }
    }
  }
  const m = (t) => ({ ...t, margin: round(((t.D - t.R) / t.total) * 100) });
  houseVote[y] = { national: m(nat), byState: Object.fromEntries(Object.entries(byState).map(([k, v]) => [k, m(v)])) };
}

// Lines changed between the 119th (2024) and 120th (2026) Congress, by land area.
const FIPS = {
  '01': 'AL',
  '02': 'AK',
  '04': 'AZ',
  '05': 'AR',
  '06': 'CA',
  '08': 'CO',
  '09': 'CT',
  10: 'DE',
  12: 'FL',
  13: 'GA',
  15: 'HI',
  16: 'ID',
  17: 'IL',
  18: 'IN',
  19: 'IA',
  20: 'KS',
  21: 'KY',
  22: 'LA',
  23: 'ME',
  24: 'MD',
  25: 'MA',
  26: 'MI',
  27: 'MN',
  28: 'MS',
  29: 'MO',
  30: 'MT',
  31: 'NE',
  32: 'NV',
  33: 'NH',
  34: 'NJ',
  35: 'NM',
  36: 'NY',
  37: 'NC',
  38: 'ND',
  39: 'OH',
  40: 'OK',
  41: 'OR',
  42: 'PA',
  44: 'RI',
  45: 'SC',
  46: 'SD',
  47: 'TN',
  48: 'TX',
  49: 'UT',
  50: 'VT',
  51: 'VA',
  53: 'WA',
  54: 'WV',
  55: 'WI',
  56: 'WY',
};
async function landAreas(year, congress, fips) {
  const zip = await cached(`tl_${year}_${fips}_cd${congress}.zip`, `https://www2.census.gov/geo/tiger/TIGER${year}/CD/tl_${year}_${fips}_cd${congress}.zip`, true);
  const dir = path.join(cache, `cd${congress}-${fips}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const dbf = readdirSync(dir).find((f) => f.endsWith('.dbf'));
  const src = await shapefile.openDbf(path.join(dir, dbf));
  const out = {};
  for (;;) {
    const { done, value } = await src.read();
    if (done) break;
    const key = Object.keys(value).find((k) => /^CD\d+FP$/.test(k));
    if (!/^\d+$/.test(String(value[key]))) continue;
    out[Number(value[key]) || 1] = Number(value.ALAND);
  }
  return out;
}
const linesChanged = new Set();
for (const [fips, st] of Object.entries(FIPS)) {
  const [a, b] = [await landAreas(2024, 119, fips), await landAreas(2026, 120, fips)];
  for (const cd of Object.keys(b)) if (!a[cd] || Math.abs(a[cd] - b[cd]) / b[cd] > 0.002) linesChanged.add(`${st}-H-${cd}`);
}
const changedStates = [...new Set([...linesChanged].map((k) => k.slice(0, 2)))].sort();
console.log(`districts with new lines since 2024: ${linesChanged.size} in ${changedStates.join(' ')}`);

const house2024 = {};
for (const r of house[2024].filter((x) => x.ecKey.split('-')[1] === 'HG')) {
  const parts = r.ecKey.split('-');
  const id = `${r.stateAbbreviation}-H-${Number(parts[3]) || 1}`;
  const s = summarize(r);
  house2024[id] = { margin: s.margin, kind: s.kind, d: s.d, r: s.r, winner: s.winner, linesChanged: linesChanged.has(id) };
}
// New districts with no 2024 counterpart (e.g. a state that gained a seat) still get a flag.
for (const id of linesChanged) house2024[id] ??= { margin: null, kind: 'new', d: null, r: null, winner: null, linesChanged: true };

// ------------------------------------------------------------ President 2024 by state
const pres = await cnn('2024-PG');
const presNat = { D: 0, R: 0, total: 0 };
const presByState = {};
for (const r of pres) {
  const s = summarize(r);
  presByState[r.stateAbbreviation] = s.margin;
  presNat.total += s.total;
  for (const c of r.candidates) {
    if (c.majorParty === 'DEM') presNat.D += c.voteNum ?? 0;
    if (c.majorParty === 'REP') presNat.R += c.voteNum ?? 0;
  }
}

// 2024 presidential margin for every 2026 race, from NYT's own comparison data on the 2026 lines
// (districts redrawn since 2024 get the presidential result *inside the new boundaries*).
const presByRace = {};
for (const slug of ['senate', 'governor', 'house']) {
  const file = JSON.parse(await cached(`nyt-2026-${slug}.json`, `https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-${slug}.json`));
  for (const r of file.races ?? []) {
    const ru = r.top_reporting_unit;
    if (!ru?.state_postal || ru.state_postal === 'US') continue;
    const id = r.office_id === 'H' ? `${ru.state_postal}-H-${Number(r.seat_number ?? 0) || 1}` : `${ru.state_postal}-${r.office_id}`;
    const cmp = Object.entries(ru.historical_comparison_race_data ?? {}).find(([k]) => /-P-2024-/.test(k));
    if (cmp) presByRace[id] = round(cmp[1].margin);
  }
}

// ------------------------------------------------------------ County baselines: the seat's last race
// For Senate and governor races, the drill-down compares each county with the same seat's previous
// contest (not the 2024 presidential race). CNN serves those contests' county results at
// .../county-races/{ecKey}.json. New England reports by town (CNN's 8-digit town codes); towns are
// rolled up to counties (CT: planning regions) via Census county subdivisions. Alaska reports by
// state house district; only contests held on today's district lines (2022+) are mapped.
const NE_STATES = { 23: 'ME', 33: 'NH', 50: 'VT', 25: 'MA', '09': 'CT', 44: 'RI' };
const townKey = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b(town|city|plantation|plt)\b\.?/g, '')
    .replace(/[^a-z]/g, '');
// CNN spellings that differ from the Census name.
const TOWN_ALIAS = { ferrisburg: 'ferrisburgh', manchester: 'manchesterbythesea', waterville: 'watervillevalley' };
const townToCounty = {};
async function townCrosswalk(stFips) {
  if (townToCounty[stFips]) return townToCounty[stFips];
  const zip = await cached(`cb_2024_${stFips}_cousub_500k.zip`, `https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_${stFips}_cousub_500k.zip`, true);
  const dir = path.join(cache, `cousub-${stFips}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const src = await shapefile.openDbf(path.join(dir, readdirSync(dir).find((f) => f.endsWith('.dbf'))));
  const map = new Map();
  for (;;) {
    const { done, value } = await src.read();
    if (done) break;
    const k = townKey(value.NAME);
    // A town name used in two counties is ambiguous: drop it rather than guess.
    map.set(k, map.has(k) && map.get(k) !== value.COUNTYFP ? null : value.COUNTYFP);
    // Maine groups unorganized areas as "Aroostook Cty Townships": key them by county name too.
    map.set(`county:${townKey(String(value.NAMELSADCO).replace(/ County$/, ''))}`, value.COUNTYFP);
  }
  townToCounty[stFips] = map;
  return map;
}

const countyHistory = {};
for (const [id, prev] of [...Object.entries(senate), ...Object.entries(gov)]) {
  if (prev.kind !== 'DR' || !prev.cnnKey) continue;
  const st = id.slice(0, 2);
  if (st === 'AK' && prev.year < 2022) continue; // old state house district lines
  const list = JSON.parse(await cached(`cnn-county-${prev.cnnKey}.json`, `https://politics.api.cnn.io/results/county-races/${prev.cnnKey}.json`));
  // The two main candidates: top DEM and top REP by total votes across the state.
  const byCand = new Map();
  for (const u of list) for (const c of u.candidates ?? []) byCand.set(c.candidateId, { party: c.majorParty, votes: (byCand.get(c.candidateId)?.votes ?? 0) + (c.voteNum ?? 0) });
  const top = (p) => [...byCand.entries()].filter(([, v]) => v.party === p).sort((a, b) => b[1].votes - a[1].votes)[0]?.[0];
  const dId = top('DEM');
  const rId = top('REP');
  const sums = new Map();
  let unmatched = 0;
  let unmatchedVotes = 0;
  for (const u of list) {
    const f = String(u.countyFipsCode);
    let key = null;
    if (f.length === 5 && st === 'AK') key = `02HD${String(Number(f.slice(2)) - 900).padStart(3, '0')}`;
    else if (f.length === 5) key = f;
    else if (f.length === 8 && st === 'IL') continue; // "Chicago" / "Cook Suburbs": a split of Cook County, which is also listed whole
    else if (f.length === 8) {
      const stFips = f.slice(1, 3);
      const cw = await townCrosswalk(stFips);
      const cty = String(u.countyName).match(/^(.+?) Cty Townships$/);
      const t = townKey(u.countyName);
      const cf = cty ? cw.get(`county:${townKey(cty[1])}`) : (cw.get(t) ?? cw.get(TOWN_ALIAS[t]));
      key = cf ? `${stFips}${cf}` : null;
    }
    if (!key) {
      unmatched++;
      unmatchedVotes += u.totalVote ?? 0;
      continue;
    }
    const s = sums.get(key) ?? { D: 0, R: 0, total: 0 };
    for (const c of u.candidates ?? []) {
      if (c.candidateId === dId) s.D += c.voteNum ?? 0;
      if (c.candidateId === rId) s.R += c.voteNum ?? 0;
    }
    s.total += Math.max(u.totalVote ?? 0, (u.candidates ?? []).reduce((a, c) => a + (c.voteNum ?? 0), 0));
    sums.set(key, s);
  }
  const units = Object.fromEntries([...sums].filter(([, s]) => s.total > 0).map(([k, s]) => [k, round(((s.D - s.R) / s.total) * 100, 1)]));
  countyHistory[id] = { label: prev.label, units };
  if (unmatched) {
    const all = list.reduce((a, u) => a + (u.totalVote ?? 0), 0);
    console.log(`  ${id}: ${unmatched} of ${list.length} reporting units not mapped (${((unmatchedVotes / all) * 100).toFixed(2)}% of votes)`);
  }
}
const countyFile = path.join(root, 'web', 'public', 'baselines', 'county-history.json');
mkdirSync(path.dirname(countyFile), { recursive: true });
writeFileSync(countyFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: 'CNN county results for each seat’s previous contest', races: countyHistory }));
console.log(`county baselines: ${Object.keys(countyHistory).length} races → ${countyFile} (${(JSON.stringify(countyHistory).length / 1024).toFixed(0)} KB)`);

// ------------------------------------------------------------ Midterm history (Wikipedia)
const PRES_PARTY = { 1994: 'D', 1998: 'D', 2002: 'R', 2006: 'R', 2010: 'D', 2014: 'D', 2018: 'R', 2022: 'D' };
async function infobox(title) {
  const json = JSON.parse(
    await cached(`wp-${title}.json`, `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=0&format=json&formatversion=2&redirects=1`),
  );
  const w = json.parse.wikitext;
  const field = (name) => {
    const m = w.match(new RegExp(`\\|\\s*${name}\\s*=\\s*([^\\n]*)`));
    return m ? m[1] : '';
  };
  const parties = {};
  for (const i of [1, 2, 3]) {
    const p = field(`party${i}`);
    const key = /Democratic/.test(p) ? 'D' : /Republican/.test(p) ? 'R' : null;
    if (!key) continue;
    const change = field(`seat_change${i}`);
    const n = Number((change.match(/\}\}\s*'*\s*(\d+)/) ?? change.match(/(\d+)/))?.[1] ?? NaN);
    const sign = /\{\{\s*decrease/i.test(change) ? -1 : /\{\{\s*(increase|steady)/i.test(change) ? 1 : 1;
    const pct = Number(field(`percentage${i}`).match(/([\d.]+)\s*%/)?.[1] ?? NaN);
    parties[key] = { seatChange: /steady/i.test(change) ? 0 : sign * n, pct };
  }
  return parties;
}
const midterms = [];
for (const y of Object.keys(PRES_PARTY).map(Number)) {
  const h = await infobox(`${y} United States House of Representatives elections`);
  const prev = await infobox(`${y - 2} United States House of Representatives elections`); // presidential year before
  const s = await infobox(`${y} United States Senate elections`);
  const p = PRES_PARTY[y];
  midterms.push({
    year: y,
    presParty: p,
    houseSeatChange: h[p]?.seatChange ?? null,
    senateSeatChange: s[p]?.seatChange ?? null,
    houseMargin: round((h.D?.pct ?? NaN) - (h.R?.pct ?? NaN), 1),
    prevHouseMargin: round((prev.D?.pct ?? NaN) - (prev.R?.pct ?? NaN), 1),
  });
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  sources: {
    results: 'CNN results API (politics.api.cnn.io), 2020-2024 national race files',
    lines: 'US Census Bureau TIGER/Line, congressional districts cd119 (2024) vs cd120 (2026)',
    midterms: 'Wikipedia election infoboxes, 1994-2022 (CC BY-SA 4.0)',
  },
  senate,
  governor: gov,
  house2024,
  houseVote,
  pres2024: { national: { ...presNat, margin: round(((presNat.D - presNat.R) / presNat.total) * 100) }, byState: presByState, byRace: presByRace },
  midterms,
  linesChangedStates: changedStates,
};
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(`wrote ${outFile} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`);
console.log(`senate ${Object.keys(senate).length}, governor ${Object.keys(gov).length}, house ${Object.keys(house2024).length}, midterms ${midterms.length}`);
