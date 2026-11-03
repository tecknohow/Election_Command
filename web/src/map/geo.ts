import { geoPath } from 'd3-geo';
import type { Feature, Geometry } from 'geojson';
import { feature, mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import statesTopo from 'us-atlas/states-albers-10m.json';
import { STATE_BY_FIPS } from '../../../shared/src/states';

/**
 * us-atlas "albers" topology is pre-projected (AlbersUSA, 975x610) with Alaska and Hawaii
 * already inset in the lower-left corner, so no projection is needed at runtime.
 */
const topo = statesTopo as unknown as Topology<{ states: GeometryCollection; nation: GeometryCollection }>;
const path = geoPath();

export interface StateShape {
  postal: string;
  name: string;
  d: string;
  centroid: [number, number];
  area: number;
  /** [[x0, y0], [x1, y1]] in map coordinates. */
  bounds: [[number, number], [number, number]];
}

export const STATE_SHAPES: StateShape[] = (
  feature(topo, topo.objects.states) as unknown as { features: Feature<Geometry, { name: string }>[] }
).features
  .map((f) => {
    const info = STATE_BY_FIPS[String(f.id).padStart(2, '0')];
    if (!info) return null;
    return {
      postal: info.postal,
      name: info.name,
      d: path(f) ?? '',
      centroid: path.centroid(f) as [number, number],
      area: path.area(f),
      bounds: path.bounds(f) as [[number, number], [number, number]],
    };
  })
  .filter((s): s is StateShape => !!s);

export const STATE_BY_POSTAL_SHAPE: Record<string, StateShape> = Object.fromEntries(STATE_SHAPES.map((s) => [s.postal, s]));

export const STATE_BORDERS = path(mesh(topo, topo.objects.states, (a, b) => a !== b)) ?? '';
export const NATION_OUTLINE = path(mesh(topo, topo.objects.nation)) ?? '';

/** Small northeastern states get labelled callout boxes to the right of the map. */
export const CALLOUTS = ['VT', 'NH', 'MA', 'RI', 'CT', 'NJ', 'DE', 'MD', 'DC'];

/** Manual nudges for label positions where the centroid is awkward. */
export const LABEL_OFFSET: Record<string, [number, number]> = {
  FL: [12, 4],
  LA: [-8, 2],
  MI: [10, 18],
  KY: [6, 2],
  WV: [-2, 4],
  VA: [8, 2],
  ID: [0, 12],
  CA: [-6, 0],
  HI: [8, 8],
  AK: [0, 0],
  NY: [4, 2],
  MN: [-4, 0],
};

export const VIEWBOX = { x: -5, y: -5, w: 1045, h: 625 };

// ------------------------------------------------------------------ House districts

export interface DistrictShape {
  /** Race id, e.g. "TX-H-12". */
  id: string;
  st: string;
  cd: number;
  d: string;
  c: [number, number];
}

let districtsPromise: Promise<DistrictShape[]> | null = null;

/**
 * 120th-Congress district geometry (Census TIGER/Line 2026, built by scripts/build-districts.mjs),
 * pre-projected to the same AlbersUSA frame as the state map. Lazy-loaded (~380 KB gzipped)
 * only when the House map opens.
 */
export function loadDistricts(): Promise<DistrictShape[]> {
  if (!districtsPromise) {
    districtsPromise = fetch('/geo/house-districts-120.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { districts: { id: string; st: string; cd: number; d: string; c: [number, number] }[] }) =>
        j.districts.map((x) => ({ ...x, id: `${x.st}-H-${x.cd}` })),
      )
      .catch((err) => {
        districtsPromise = null;
        throw err;
      });
  }
  return districtsPromise;
}
