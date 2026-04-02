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
 * Build a human-readable slot description using the sub-task name and shift time.
 * Falls back to `taskName` when `slotLabel` is absent.
 */
export function describeSlot(
  taskName: string,
  slotLabel: string | undefined,
  timeBlock: { start: Date; end: Date },
): string {
  const time = `${fmtTime(timeBlock.start)}–${fmtTime(timeBlock.end)}`;
  return `${slotLabel || taskName} ${time}`;
}

/** Calendar-date key from a Date (YYYY-MM-DD in local time) */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
