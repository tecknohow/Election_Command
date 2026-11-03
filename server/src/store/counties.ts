import type { RaceCounties } from '../../../shared/src/types.js';

/**
 * County-level (sub-state) results per race. Kept out of the main snapshot (it would add
 * several MB); the race drill-down page fetches one race at a time from /api/races/:id/counties.
 */
class CountyStore {
  private byRace = new Map<string, RaceCounties>();

  set(rc: RaceCounties) {
    this.byRace.set(rc.raceId, rc);
  }

  get(raceId: string): RaceCounties | undefined {
    return this.byRace.get(raceId);
  }

  get size() {
    return this.byRace.size;
  }
}

export const countyStore = new CountyStore();
