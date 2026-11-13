import type { RaceCounties } from '../../../shared/src/types.js';

/**
 * County-level (sub-state) results per race. Kept out of the main snapshot (it would add
 * several MB); the race drill-down page fetches one race at a time from /api/races/:id/counties.
 * Saved to its own file (see persist.ts) so a restart keeps it even if the upstream has since
 * dropped it (NYT stripped county parts from its national House file a few days after the election).
 */
class CountyStore {
  private byRace = new Map<string, RaceCounties>();
  /** Changed since the last save. */
  dirty = false;

  set(rc: RaceCounties) {
    this.byRace.set(rc.raceId, rc);
    this.dirty = true;
  }

  get(raceId: string): RaceCounties | undefined {
    return this.byRace.get(raceId);
  }

  get size() {
    return this.byRace.size;
  }

  toPersisted(): RaceCounties[] {
    return [...this.byRace.values()];
  }

  loadPersisted(list: RaceCounties[] | undefined) {
    for (const rc of list ?? []) if (rc?.raceId && Array.isArray(rc.units)) this.byRace.set(rc.raceId, rc);
  }
}

export const countyStore = new CountyStore();
