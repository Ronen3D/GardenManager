/**
 * Shared date utility functions.
 */

/** Hebrew day names indexed by JS getDay() (0 = Sunday). */
export const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'] as const;

/** Hebrew weekday name from a Date object (e.g. "ראשון"). */
export function hebrewDayName(d: Date): string {
  return HEBREW_DAYS[d.getDay()];
}

/** Calendar-date key from a Date (YYYY-MM-DD in local time) */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
