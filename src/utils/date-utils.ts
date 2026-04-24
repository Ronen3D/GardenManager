/**
 * Shared date utility functions.
 */

/** Format a Date as HH:MM (24h). */
export function fmtTime(d: Date): string {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/**
 * Build a human-readable slot description using the slot label and shift time.
 * When `slotLabel` is absent, returns only the time range — callers already
 * show `taskName` in the surrounding context so repeating it would be redundant.
 */
export function describeSlot(slotLabel: string | undefined, timeBlock: { start: Date; end: Date }): string {
  const time = `${fmtTime(timeBlock.start)}–${fmtTime(timeBlock.end)}`;
  return slotLabel ? `${slotLabel} ${time}` : time;
}

/** Time range wrapped with LRI/PDI BiDi isolates for safe RTL embedding. */
export function bidiTimeRange(tb: { start: Date; end: Date }): string {
  return `\u2066${fmtTime(tb.start)}\u2013${fmtTime(tb.end)}\u2069`;
}

/**
 * Strip the engine-internal `D{N} ` day-index prefix and any trailing numeric
 * `משמרת {N}` suffix from a task name. Prefer reading `task.sourceName`
 * directly — this exists as a fallback for transport objects that only carry
 * the decorated `task.name` string.
 */
export function stripTaskNameAffixes(name: string): string {
  return name.replace(/^D\d+\s+/, '').replace(/\s+משמרת\s+\d+\s*$/, '');
}

/** True iff the task was generated with a numeric `משמרת N` shift suffix. */
function hasShiftSuffix(name: string): boolean {
  return /\sמשמרת\s+\d+\s*$/.test(name);
}

/**
 * Task description for pair-based violation messages: the clean template
 * name followed by the bidi-safe time range (which disambiguates shifts
 * of the same template).
 */
export function describeTaskBidi(task: {
  name: string;
  sourceName?: string;
  timeBlock: { start: Date; end: Date };
}): string {
  const clean = task.sourceName ?? stripTaskNameAffixes(task.name);
  return `${clean} ${bidiTimeRange(task.timeBlock)}`;
}

/**
 * Task-instance description for single-task violation messages. Day context
 * is provided by the panel's day section header, so only the template name
 * is shown. For multi-shift tasks the bidi-safe time range is appended to
 * disambiguate shifts.
 */
export function describeTaskInstance(task: {
  name: string;
  sourceName?: string;
  timeBlock: { start: Date; end: Date };
}): string {
  const clean = task.sourceName ?? stripTaskNameAffixes(task.name);
  return hasShiftSuffix(task.name) ? `${clean} ${bidiTimeRange(task.timeBlock)}` : clean;
}

/**
 * Calendar-date key from a Date (YYYY-MM-DD in local time).
 *
 * For scheduling/day-grouping logic, use {@link operationalDateKey} instead —
 * it respects the configurable day boundary. This function uses midnight as
 * the day boundary and should only be used for calendar-date formatting
 * (UI display, import/export filenames, etc.).
 */
export function calendarDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Date key for the "operational day" a timestamp belongs to.
 * If the hour is before dayStartHour, the timestamp is attributed
 * to the previous calendar day's operational period.
 *
 * Engine/scheduling code should ALWAYS use this function, never
 * calendarDateKey(), to ensure day grouping respects the configured
 * boundary. calendarDateKey() exists only for calendar-date formatting
 * (UI display, import/export filenames, etc.).
 */
export function operationalDateKey(d: Date, dayStartHour: number): string {
  if (d.getHours() < dayStartHour) {
    return calendarDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
  }
  return calendarDateKey(d);
}
