#!/usr/bin/env node
/**
 * Build the House district geometry used by the House map.
 *
 * Source: US Census Bureau TIGER/Line 2026, Congressional Districts for the **120th Congress**
 *   https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_{SS}_cd120.zip
 * These are the districts on the November 3, 2026 ballot, including the 2025-26 mid-decade
 * redraws (TX, CA, MO, NC, OH, UT, ...). The Census 119th-Congress files would be wrong for those states.
 *
 * Pipeline: download (cached) -> read shapefile -> TopoJSON (shared arcs) -> spherical
 * simplification -> project with d3.geoAlbersUsa().scale(1300).translate([487.5, 305]),
 * the exact projection us-atlas uses for states-albers-10m, so districts register with the
 * state map -> SVG path strings.
 *
 * TIGER polygons extend into lakes/coastal water; the client clips each state's districts to
 * the state's land outline from us-atlas, so no shoreline clipping is needed here.
 *
 * Usage: node scripts/build-districts.mjs [--keep 0.035]
 * Output: web/public/geo/house-districts-120.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import * as shapefile from 'shapefile';
import { feature } from 'topojson-client';
import { topology } from 'topojson-server';
import { presimplify, quantile, simplify, sphericalTriangleArea } from 'topojson-simplify';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'tiger-cd120');
const outFile = path.join(root, 'web', 'public', 'geo', 'house-districts-120.json');
const keepArg = process.argv.indexOf('--keep');
const KEEP = keepArg > 0 ? Number(process.argv[keepArg + 1]) : 0.035;

const STATES = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '12': 'FL', '13': 'GA',
  '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD',
  '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ',
  '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC',
  '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY',
};

mkdirSync(cache, { recursive: true });
mkdirSync(path.dirname(outFile), { recursive: true });

async function download(fips) {
  const zip = path.join(cache, `tl_2026_${fips}_cd120.zip`);
  if (!existsSync(zip)) {
    const url = `https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_${fips}_cd120.zip`;
    process.stdout.write(`  downloading ${url}\n`);
    const res = await fetch(url, { headers: { 'User-Agent': 'ElectionCommand/0.1 (district build script)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const dir = path.join(cache, fips);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const shp = readdirSync(dir).find((f) => f.endsWith('.shp'));
  return path.join(dir, shp);
}

const features = [];
for (const [fips, st] of Object.entries(STATES)) {
  const shp = await download(fips);
  const src = await shapefile.open(shp, shp.replace(/\.shp$/, '.dbf'));
  let n = 0;
  for (;;) {
    const { done, value } = await src.read();
    if (done) break;
    const props = value.properties;
    const key = Object.keys(props).find((k) => /^CD\d+FP$/.test(k));
    const code = String(props[key]);
    if (!/^\d+$/.test(code)) continue; // 'ZZ' = water / undefined
    const district = Number(code) === 0 ? 1 : Number(code); // at-large '00' -> 1 (NYT convention)
    features.push({ type: 'Feature', id: `${st}-${district}`, properties: { st, cd: district }, geometry: value.geometry });
    n++;
  }
  process.stdout.write(`${st}: ${n} districts\n`);
}
console.log(`total districts: ${features.length}`);

let topo = topology({ districts: { type: 'FeatureCollection', features } }, 1e6);
topo = presimplify(topo, sphericalTriangleArea);
topo = simplify(topo, quantile(topo, KEEP)); // quantile(p) = weight that retains fraction p of points
const simplified = feature(topo, topo.objects.districts);

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const pathGen = geoPath(projection).digits(1);
const out = [];
for (const f of simplified.features) {
  const d = pathGen(f);
  if (!d) {
    console.warn(`  ! ${f.id} produced no path`);
    continue;
  }
  const [cx, cy] = pathGen.centroid(f).map((v) => +v.toFixed(1));
  out.push({ id: f.id, st: f.properties.st, cd: f.properties.cd, d, c: [cx, cy] });
}
out.sort((a, b) => a.st.localeCompare(b.st) || a.cd - b.cd);
const json = JSON.stringify({ source: 'US Census Bureau TIGER/Line 2026, 120th Congress (cd120)', keep: KEEP, districts: out });
writeFileSync(outFile, json);
console.log(`wrote ${outFile} (${(json.length / 1024).toFixed(0)} KB, ${out.length} districts)`);
