import { geoPath } from 'd3-geo';
import type { Feature, Geometry } from 'geojson';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';

export interface CountyShape {
  fips: string;
  name: string;
  d: string;
}

let promise: Promise<Map<string, CountyShape>> | null = null;

/**
 * us-atlas counties (pre-projected AlbersUSA, same frame as the state map). Loaded lazily as
 * its own chunk (~260 KB gzipped) the first time a race drill-down opens.
 */
export function loadCounties(): Promise<Map<string, CountyShape>> {
  promise ??= import('us-atlas/counties-albers-10m.json')
    .then((m) => {
      const topo = (m.default ?? m) as unknown as Topology<{ counties: GeometryCollection }>;
      const path = geoPath();
      const out = new Map<string, CountyShape>();
      for (const f of (feature(topo, topo.objects.counties) as unknown as { features: Feature<Geometry, { name: string }>[] }).features) {
        const fips = String(f.id).padStart(5, '0');
        out.set(fips, { fips, name: f.properties?.name ?? fips, d: path(f) ?? '' });
      }
      return out;
    })
    .catch((err) => {
      promise = null;
      throw err;
    });
  return promise;
}

/** Bounding box of an SVG path string made of absolute coordinates (good enough for fitting). */
export function pathBounds(paths: string[]): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const d of paths) {
    const nums = d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums) continue;
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = +nums[i];
      const y = +nums[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0)) return null;
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05 + 2;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
