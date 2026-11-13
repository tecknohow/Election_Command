import type { RaceCounties } from '../../../shared/src/types.js';
import { archivePhase } from '../lib/guard.js';

const votes = (rc: RaceCounties) => rc.units.reduce((s, u) => s + u.totalVotes, 0);

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
    // After election night, county results only grow or get corrected; a refresh with under half
    // the votes (or no units) is a stripped or partial file, so the saved results stay.
    const prev = this.byRace.get(rc.raceId);
    if (prev && archivePhase() && (!rc.units.length || votes(rc) < votes(prev) * 0.5)) return;
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
