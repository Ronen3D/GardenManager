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
import { operationalDateKey } from '../utils/date-utils';

// ─── Day windowing ───────────────────────────────────────────────────────────

/**
 * Compute the [start, end) operational-day window for a given day index.
 *
 * Anchored to the frozen `schedule.periodStart` + `dayStartHour` — NOT to
 * `min(task.start)`. This keeps UI, export, and engine day-grouping in lock-step:
 * whatever the user sees in the schedule grid is exactly what PDF/Excel print.
 */
export function getDayWindow(
  schedule: Schedule,
  dayIndex: number,
  dayStartHour: number = 5,
): { start: Date; end: Date } {
  const base = schedule.periodStart;
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex - 1, dayStartHour, 0, 0, 0);
  return { start, end: addDays(start, 1) };
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
