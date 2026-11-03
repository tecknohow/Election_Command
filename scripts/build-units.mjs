#!/usr/bin/env node
/**
 * Map shapes for reporting units that us-atlas (2017 county boundaries) doesn't have:
 *  - Connecticut's 9 planning regions (FIPS 09110-09190), which replaced its 8 counties as the
 *    state's county-equivalents in 2022 and are what AP/NYT now report by.
 *  - Alaska's 40 state house districts, which AP/NYT use instead of boroughs.
 *
 * Sources: US Census Bureau cartographic boundary files (land-clipped, public domain)
 *   https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip
 *   https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_02_sldl_500k.zip
 * Projected exactly like us-atlas counties-albers-10m (d3.geoAlbersUsa().scale(1300).translate([487.5, 305]))
 * so they register with the existing county and district layers.
 *
 * Keys: CT regions use their FIPS ("09110"); AK districts use "02HD001".."02HD040", matching the
 * key the server gives those NYT reporting units.
 *
 * Usage: node scripts/build-units.mjs
 * Output: web/public/geo/extra-units.json
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
const cache = path.join(root, '.cache', 'units');
const outFile = path.join(root, 'web', 'public', 'geo', 'extra-units.json');
mkdirSync(cache, { recursive: true });

async function shp(name, url) {
  const zip = path.join(cache, `${name}.zip`);
  if (!existsSync(zip)) {
    process.stdout.write(`  downloading ${url}\n`);
    const res = await fetch(url, { headers: { 'User-Agent': 'ElectionCommand/0.1 (unit build script)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const dir = path.join(cache, name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  }
  const file = path.join(
    dir,
    readdirSync(dir).find((f) => f.endsWith('.shp')),
  );
  return shapefile.open(file, file.replace(/\.shp$/, '.dbf'));
}

const features = [];
const counties = await shp('cb_2024_us_county_5m', 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_county_5m.zip');
for (;;) {
  const { done, value } = await counties.read();
  if (done) break;
  const p = value.properties;
  if (p.STATEFP !== '09') continue;
  features.push({ type: 'Feature', id: p.GEOID, properties: { st: 'CT', name: p.NAME }, geometry: value.geometry });
}
const sldl = await shp('cb_2024_02_sldl_500k', 'https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_02_sldl_500k.zip');
for (;;) {
  const { done, value } = await sldl.read();
  if (done) break;
  const p = value.properties;
  const n = Number(p.SLDLST);
  if (!Number.isFinite(n) || n <= 0) continue; // ZZZ = water
  features.push({ type: 'Feature', id: `02HD${String(n).padStart(3, '0')}`, properties: { st: 'AK', name: `State House District ${n}` }, geometry: value.geometry });
}
console.log(`CT regions: ${features.filter((f) => f.properties.st === 'CT').length}, AK districts: ${features.filter((f) => f.properties.st === 'AK').length}`);

let topo = topology({ units: { type: 'FeatureCollection', features } }, 1e6);
topo = presimplify(topo, sphericalTriangleArea);
topo = simplify(topo, quantile(topo, 0.08));
const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const pathGen = geoPath(projection).digits(1);
const units = [];
for (const f of feature(topo, topo.objects.units).features) {
  const d = pathGen(f);
  if (!d) {
    console.warn(`  ! ${f.id} produced no path`);
    continue;
  }
  units.push({ fips: f.id, st: f.properties.st, name: f.properties.name, d });
}
units.sort((a, b) => a.fips.localeCompare(b.fips));
const json = JSON.stringify({ source: 'US Census Bureau cartographic boundary files 2024 (CT county-equivalents, AK state house districts)', units });
writeFileSync(outFile, json);
console.log(`wrote ${outFile} (${(json.length / 1024).toFixed(0)} KB, ${units.length} units)`);
