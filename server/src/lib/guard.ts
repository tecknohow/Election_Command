import { config } from '../config.js';

/**
 * Guards against an upstream file that degrades (a partial response, or a provider stripping data
 * after the election, as NYT did with House county parts) overwriting good saved data.
 */

/** A refreshed list that suddenly has under half the entries it had is a broken file, not news. */
export function shrankTooMuch(prev: number, next: number): boolean {
  return prev >= 10 && next < prev * 0.5;
}

/**
 * Past the election-night window (HOT_END) results only grow or get corrected, so a count that
 * drops to nothing is a provider problem. During the night upstream is trusted as-is: test data
 * gets zeroed before polls close, and that must win.
 */
export function archivePhase(now = Date.now()): boolean {
  return now > Date.parse(config.hotEnd);
}
