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
 * Count the *distinct operational days that contain at least one task*
 * (a task-bearing-day cardinality), grouping tasks by `operationalDateKey`.
 *
 * ⚠️ This is NOT the number of op-days in the period and MUST NOT be used as
 * the bound of a `for (let d = 1; d <= N; d++)` day loop. Day loops feed `d`
 * to `getDayWindow`/`getTasksForDay`, which anchor on an *absolute* 1-based
 * index (`periodStart + (d-1) days + dayStartHour`). A cardinality equals the
 * max index only when task-bearing days are the contiguous prefix `1..N`; with
 * a leading-empty or gappy distribution (e.g. periodDays=7, tasks on op-days
 * 2..6) the loop both emits phantom empty pages for the early days AND
 * silently drops every task-bearing op-day whose index exceeds the count
 * (op-day 6 here). Export day loops must bound on `schedule.periodDays` — the
 * frozen op-day count, anchored identically to `getDayWindow`, which keeps
 * PDF/Excel in lock-step with the on-screen grid (CLAUDE.md "One day model").
 *
 * Retained only as a documented metric (e.g. for tests asserting the above
 * distinction); it has no production day-loop callers by design.
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
