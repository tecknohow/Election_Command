#!/usr/bin/env node
/**
 * Place → county lookup used to put local races (mayor, city council, sheriff, local measures…) in
 * the right county. NYT/AP's state files name the jurisdiction only in text ("Los Angeles",
 * "Fresno District 1", "Fresno-S - …"), so the server matches that name against these lists.
 *
 * Sources (US Census Bureau, 2020 reference files, public domain):
 *   https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt
 *   https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt
 *
 * Output: server/src/geo/places.json
 *   { "CA": { "counties": { "06037": "Los Angeles County", … },
 *             "places":   { "losangeles": ["06037"], … } }, … }
 * Place keys are lower-case letters only, with the Census type suffix dropped ("Los Angeles city"
 * → "losangeles"). Incorporated places win over census-designated places with the same key.
 *
 * Usage: node scripts/build-places.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'places');
const outFile = path.join(root, 'server', 'src', 'geo', 'places.json');
mkdirSync(cache, { recursive: true });
mkdirSync(path.dirname(outFile), { recursive: true });

async function cached(name, url) {
  const file = path.join(cache, name);
  if (!existsSync(file)) {
    process.stdout.write(`  fetching ${url}\n`);
    const res = await fetch(url, { headers: { 'User-Agent': 'ElectionCommand/0.1 (places build script)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    writeFileSync(file, await res.text());
  }
  return readFileSync(file, 'utf8');
}

/** Same normalization the server applies to race names (keep in sync with stateRaces.ts). */
export const placeKey = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(city and borough|consolidated government|metropolitan government|unified government|urban county|metro government|city|town|village|borough|municipality|cdp|township|plantation)\b/g, ' ')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z]/g, '');

const out = {};
const SKIP = new Set(['AS', 'GU', 'MP', 'PR', 'UM', 'VI']); // territories: no races in the state files
const counties = await cached('national_county2020.txt', 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt');
for (const line of counties.split(/\r?\n/).slice(1)) {
  const [st, stFips, coFips, , name] = line.split('|');
  if (!st || !coFips || SKIP.has(st)) continue;
  (out[st] ??= { counties: {}, places: {} }).counties[`${stFips}${coFips}`] = name;
}
const places = await cached('national_place_by_county2020.txt', 'https://www2.census.gov/geo/docs/reference/codes2020/national_place_by_county2020.txt');
const incorporated = new Set(); // "ST|key" seen as an incorporated place
for (const pass of ['INCORPORATED PLACE', 'CENSUS DESIGNATED PLACE']) {
  for (const line of places.split(/\r?\n/).slice(1)) {
    const [st, stFips, coFips, , , , placeName, type] = line.split('|');
    if (!st || type !== pass || SKIP.has(st)) continue;
    const key = placeKey(placeName);
    if (!key) continue;
    const id = `${st}|${key}`;
    if (pass === 'CENSUS DESIGNATED PLACE' && incorporated.has(id)) continue;
    if (pass === 'INCORPORATED PLACE') incorporated.add(id);
    const list = ((out[st] ??= { counties: {}, places: {} }).places[key] ??= []);
    const fips = `${stFips}${coFips}`;
    if (!list.includes(fips)) list.push(fips);
  }
}
// Connecticut replaced its 8 counties with 9 planning regions (FIPS 09110-09190) in 2022, and AP
// reports by region; the 2020 reference files still list the old counties. Use the 2024 Census
// county-subdivision file (towns → region) instead.
{
  const { execFileSync } = await import('node:child_process');
  const shapefile = await import('shapefile');
  const zip = path.join(cache, 'cb_2024_09_cousub_500k.zip');
  if (!existsSync(zip)) {
    const res = await fetch('https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_09_cousub_500k.zip', { headers: { 'User-Agent': 'ElectionCommand/0.1 (places build script)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for CT county subdivisions`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const dir = path.join(cache, 'cousub-09');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const { readdirSync } = await import('node:fs');
  const src = await shapefile.openDbf(path.join(dir, readdirSync(dir).find((f) => f.endsWith('.dbf'))));
  const ct = { counties: {}, places: {} };
  for (;;) {
    const { done, value } = await src.read();
    if (done) break;
    const fips = `09${value.COUNTYFP}`;
    ct.counties[fips] = value.NAMELSADCO; // "Capitol Planning Region"
    const list = (ct.places[placeKey(value.NAME)] ??= []);
    if (!list.includes(fips)) list.push(fips);
  }
  out.CT = ct;
}

writeFileSync(outFile, JSON.stringify(out));
const n = Object.values(out).reduce((s, v) => s + Object.keys(v.places).length, 0);
console.log(`wrote ${outFile} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB, ${Object.keys(out).length} states, ${n} place names)`);
