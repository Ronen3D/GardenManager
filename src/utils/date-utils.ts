/**
 * Shared date utility functions.
 */

import type { Task } from '../models/types';

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

/**
 * The OCCURRENCE start a task should be bucketed to a display/export op-day by.
 *
 * Splitting is slot-level: a second-half (`#b`, `splitPart === 2`) runs
 * `[occurrenceMidpoint, occurrenceEnd]`, so its own `timeBlock.start` is the
 * midpoint — which can fall in a different op-day than the rest of the
 * occurrence when the shift starts in the pre-`dayStartHour` tail. For
 * DAY-PAGE membership a split fragment belongs to its occurrence's op-day
 * (where the residual, `#a`, and the equivalent unsplit shift display), NOT
 * the midpoint's. The occurrence start is recovered exactly from the half:
 * `#b`.end === occurrence end and `splitOriginalMs` === the full
 * (pre-split) occurrence duration, so `end − splitOriginalMs` is the
 * occurrence start. Every other task — non-split, residual (no
 * `splitGroupId`), and `#a` (whose `timeBlock.start` already IS the
 * occurrence start) — returns `timeBlock.start` unchanged ⇒ zero behaviour
 * change off the split-`#b` path. WITHIN-day row placement still uses the
 * real `timeBlock.start` (the midpoint), so `#b` renders at its true time
 * row on the occurrence's page — exactly as a non-boundary split already does.
 */
export function taskOpDayStart(task: Task): Date {
  if (task.splitGroupId !== undefined && task.splitPart === 2 && task.splitOriginalMs !== undefined) {
    return new Date(task.timeBlock.end.getTime() - task.splitOriginalMs);
  }
  return task.timeBlock.start;
}

/**
 * The occurrence END for op-day membership. For ANY split fragment the
 * effective span is the whole occurrence `[occStart, occStart +
 * splitOriginalMs]`, so intersection-based day filters treat a fragment
 * exactly like the unsplit occurrence (and like the residual, which already
 * spans `[start, end]`). Non-split tasks return `timeBlock.end` unchanged.
 */
export function taskOpDayEnd(task: Task): Date {
  if (task.splitGroupId !== undefined && task.splitOriginalMs !== undefined) {
    return new Date(taskOpDayStart(task).getTime() + task.splitOriginalMs);
  }
  return task.timeBlock.end;
}
