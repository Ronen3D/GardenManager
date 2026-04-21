/**
 * Shared date utility functions.
 */

/** Hebrew day names indexed by JS getDay() (0 = Sunday). */
export const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;

/** Hebrew weekday name from a Date object (e.g. "ראשון"). */
export function hebrewDayName(d: Date): string {
  return HEBREW_DAYS[d.getDay()];
}

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

/** Slot description with BiDi isolates for safe RTL embedding in violation messages. */
export function describeSlotBidi(slotLabel: string | undefined, timeBlock: { start: Date; end: Date }): string {
  const time = bidiTimeRange(timeBlock);
  return slotLabel ? `${slotLabel} ${time}` : time;
}

/**
 * Task description for pair-based violation messages: strips the leading
 * `D{n}` day-index prefix and the trailing ` משמרת N` shift suffix from
 * task.name, then appends the bidi-safe time range — which already
 * disambiguates shifts of the same template.
 */
export function describeTaskBidi(task: { name: string; timeBlock: { start: Date; end: Date } }): string {
  const clean = task.name.replace(/^D\d+\s+/, '').replace(/\s+משמרת\s+\d+$/, '');
  return `${clean} ${bidiTimeRange(task.timeBlock)}`;
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
