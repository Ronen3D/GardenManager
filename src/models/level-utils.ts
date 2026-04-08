/**
 * Utility functions for working with LevelEntry[] arrays.
 */

import type { Level, LevelEntry } from './types';

/** Extract flat list of allowed Level values from annotated entries. */
export function allowedLevels(entries: LevelEntry[]): Level[] {
  return entries.map((e) => e.level);
}

/** Check if a specific level is marked as low-priority in the given entries. */
export function isLowPriority(entries: LevelEntry[], level: Level): boolean {
  const entry = entries.find((e) => e.level === level);
  return entry?.lowPriority === true;
}

/** Check if a level is accepted at all (normal or low-priority). */
export function isAcceptedLevel(entries: LevelEntry[], level: Level): boolean {
  return entries.some((e) => e.level === level);
}

/** Check if any level in the entries is marked as low-priority. */
export function hasAnyLowPriority(entries: LevelEntry[]): boolean {
  return entries.some((e) => e.lowPriority === true);
}
