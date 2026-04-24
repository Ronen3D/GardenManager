/**
 * Structural section keys for the schedule board.
 *
 * Tasks generated from the same template share a key iff their template
 * produces the same daily time footprint — i.e. the same shift lengths and
 * start times. Two structurally identical templates therefore render as a
 * single section (side-by-side columns within one table). One-time and
 * post-generation injected tasks never share a key with anyone else.
 *
 * Pure functions, no dependencies on store/engine state. Consumed by
 * task generation (app.ts, engine/inject.ts) and by config-store when it
 * builds color/display-order maps.
 */

/** Structural key for a recurring-template task. */
export function computeTemplateSectionKey(tpl: {
  durationHours: number;
  shiftsPerDay: number;
  startHour: number;
}): string {
  return `tpl:${tpl.durationHours}|${tpl.shiftsPerDay}|${tpl.startHour}`;
}

/** Unique key for a one-time task — never merges with templates or with other OTs. */
export function oneTimeSectionKey(otId: string): string {
  return `ot:${otId}`;
}

/** Unique key for a post-generation injected task — never merges. */
export function injectSectionKey(taskId: string): string {
  return `inject:${taskId}`;
}
