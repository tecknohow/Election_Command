/** Census place and county names (places.json, built by scripts/build-places.mjs) and lookups on them. */
import places from './places.json' with { type: 'json' };

export type PlaceIndex = Record<string, { counties: Record<string, string>; places: Record<string, string[]> }>;
export const PLACES = places as PlaceIndex;

/** Keep in sync with scripts/build-places.mjs. */
export const placeKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(city and borough|consolidated government|metropolitan government|unified government|urban county|metro government|city|town|village|borough|municipality|cdp|township|plantation)\b/g, ' ')
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^a-z]/g, '');

/**
 * The county a New England town belongs to, as a shape key: its own county code, except in
 * Connecticut, where NYT's town units still carry the old county codes but the map (and AP's
 * county-level reporting) uses the nine planning regions (09110-09190).
 */
export function townCounty(st: string, fipsState: string, fipsCounty: string, town: string): string {
  if (st === 'CT') {
    const regions = PLACES.CT?.places[placeKey(town)];
    if (regions?.length === 1) return regions[0];
  }
  return `${fipsState}${fipsCounty}`;
}

/** "Capitol", "Hampden": the county's Census name without its "County" / "Planning Region" suffix. */
export function countyLabel(st: string, fips: string): string | null {
  return PLACES[st]?.counties[fips]?.replace(/\s+(County|Planning Region|Parish|Borough|Census Area)$/, '') ?? null;
}
