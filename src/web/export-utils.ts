/**
 * Shared helpers used by both the PDF exporter (pdf-export.ts) and the
 * Excel exporter (excel-export.ts).
 *
 * These helpers were originally private to pdf-export.ts but are now shared
 * so both formats operate on identical day windows, shift labels, and
 * category tinting.
 */

import { addDays } from 'date-fns';
import type { Schedule, Task } from '../models/types';
import { fmtTime, operationalDateKey } from '../utils/date-utils';

// ─── Day windowing ───────────────────────────────────────────────────────────

/** Compute the [start, end) operational-day window for a given day index. */
export function getDayWindow(
  schedule: Schedule,
  dayIndex: number,
  dayStartHour: number = 5,
): { start: Date; end: Date } {
  const allStarts = schedule.tasks.map((t) => new Date(t.timeBlock.start).getTime());
  const scheduleStart = new Date(Math.min(...allStarts));
  const dayAnchor = addDays(scheduleStart, dayIndex - 1);
  const dayStart = new Date(dayAnchor);
  if (dayStart.getHours() < dayStartHour) dayStart.setDate(dayStart.getDate() - 1);
  dayStart.setHours(dayStartHour, 0, 0, 0);
  return { start: dayStart, end: addDays(dayStart, 1) };
}

/** Filter schedule tasks whose start time falls inside the given operational day. */
export function getTasksForDay(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): Task[] {
  const { start, end } = getDayWindow(schedule, dayIndex, dayStartHour);
  return schedule.tasks.filter((t) => {
    const s = new Date(t.timeBlock.start).getTime();
    return s >= start.getTime() && s < end.getTime();
  });
}

/**
 * Compute how many operational days the schedule spans, grouping tasks by
 * `operationalDateKey(start)`. Must be used instead of a wall-clock span:
 * a night task that crosses midnight would otherwise inflate the count and
 * produce a phantom empty day.
 */
export function getNumDays(schedule: Schedule, dayStartHour: number = 5): number {
  if (schedule.tasks.length === 0) return 0;
  const keys = new Set<string>();
  for (const t of schedule.tasks) {
    keys.add(operationalDateKey(new Date(t.timeBlock.start), dayStartHour));
  }
  return keys.size;
}

// ─── Colour helpers ──────────────────────────────────────────────────────────

/** Hex colour string (`#RRGGBB`) → `[R, G, B]` tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

/** Mix a colour with white to produce a light tint suitable for cell backgrounds. */
export function tint(hex: string, f = 0.82): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [Math.round(r + (255 - r) * f), Math.round(g + (255 - g) * f), Math.round(b + (255 - b) * f)];
}

/** Convert an `[R, G, B]` tuple to an ARGB hex string (Excel-style, `FFRRGGBB`). */
export function rgbToArgb(rgb: [number, number, number]): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `FF${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

// ─── Shift labels ────────────────────────────────────────────────────────────

/** Named Hebrew shift labels by start-hour. */
export const SHIFT_NAMES: Record<number, string> = {
  5: 'בוקר',
  6: 'בוקר',
  7: 'בוקר',
  8: 'בוקר',
  12: 'צהריים',
  13: 'צהריים',
  14: 'צהריים',
  17: 'ערב',
  18: 'ערב',
  19: 'ערב',
  20: 'ערב',
  21: 'לילה',
  22: 'לילה',
  23: 'לילה',
};

/**
 * Format a task start time. When the category has ≤ 2 unique shifts, prefer
 * the named Hebrew label (בוקר/צהריים/ערב/לילה); otherwise fall back to HH:MM.
 */
export function fmtTimeLabel(d: Date, totalShifts: number): string {
  if (totalShifts <= 2) {
    const name = SHIFT_NAMES[d.getHours()];
    if (name) return name;
  }
  return fmtTime(d);
}

/** Return the named shift label for a given timestamp, or an empty string. */
export function shiftName(d: Date): string {
  return SHIFT_NAMES[d.getHours()] ?? '';
}
