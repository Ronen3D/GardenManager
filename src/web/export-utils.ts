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
import { operationalDateKey, taskOpDayStart } from '../utils/date-utils';
import type { ColumnDefinition } from './layout-engine';
import { getTaskAssignments } from './layout-engine';

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
    // A split fragment is bucketed to its OCCURRENCE's op-day (so the
    // residual + `#a` + `#b` of one shift always export on the same page);
    // non-split tasks use their own start exactly as before.
    const s = taskOpDayStart(t).getTime();
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
    keys.add(operationalDateKey(taskOpDayStart(t), dayStartHour));
  }
  return keys.size;
}

// ─── Split-slot folding (shared by the PDF + Excel day grids) ────────────────

/**
 * Row start-times for a section's day table, folding split slots. A split slot
 * is shown as ONE row at the first half's start time, so the second half
 * (`splitPart === 2`) does NOT contribute its midpoint start time when its
 * part-1 sibling is present. Safety: if part-1 is absent (data anomaly), the
 * orphan part-2 keeps its own row so an assignment is never silently dropped.
 *
 * Every presentation surface folds the pair identically — the on-screen grid
 * via `renderAssignmentCard`'s empty-row skip, and the PDF + Excel day grids by
 * consuming THIS helper. Use it instead of `getUniqueStartTimes` wherever a day
 * table renders split-aware rows. With no split tasks present it is
 * byte-identical to `getUniqueStartTimes` (same set of starts, same sort).
 */
export function getFoldedStartTimes(tasks: Task[]): number[] {
  const times = new Set<number>();
  for (const t of tasks) {
    if (t.splitGroupId !== undefined && t.splitPart === 2) {
      const hasPart1 = tasks.some((x) => x.splitGroupId === t.splitGroupId && x.splitPart === 1);
      if (hasPart1) continue;
    }
    times.add(new Date(t.timeBlock.start).getTime());
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Names for one Excel column at one time row, folding split slots. Mirrors the
 * on-screen grid and the PDF's `columnNameEntries` (pdf-export.ts) — keep those
 * two split-fold branches in sync: a split first-half slot this column owns
 * renders as a single "firstHalf / secondHalf" string (the sibling second half
 * folds in and is never emitted on its own); part-2 tasks are skipped;
 * non-split slots are unchanged. `col.matchSlots` applies the column's slot
 * filter (sub-team / source / flat), identical to the non-split path this
 * replaces. Returns plain strings — Excel tints the whole cell with the section
 * colour, so (unlike the PDF) no per-name group colour is carried here.
 *
 * `emptyLabel` is the placeholder for an unfilled half / slot, threaded through
 * so the caller keeps one source of truth for the empty-slot string. With no
 * split tasks present this reduces to the plain per-slot name collection.
 */
export function foldedColumnNames(
  tasksAtTime: Task[],
  col: ColumnDefinition,
  schedule: Schedule,
  emptyLabel: string,
): string[] {
  const out: string[] = [];
  for (const tk of tasksAtTime) {
    if (tk.splitGroupId !== undefined && tk.splitPart === 2) continue; // folded into part-1
    if (tk.splitGroupId !== undefined && tk.splitPart === 1) {
      const matched = col.matchSlots(tk, getTaskAssignments(tk, schedule));
      if (matched.length === 0) continue; // this column does not own the split slot
      const sib = schedule.tasks.find((t) => t.splitGroupId === tk.splitGroupId && t.splitPart === 2);
      const nameB = (sib ? getTaskAssignments(sib, schedule).find((s) => s.participant) : undefined)?.participant?.name;
      for (const s of matched) {
        out.push(`${s.participant?.name ?? emptyLabel} / ${nameB ?? emptyLabel}`);
      }
      continue;
    }
    for (const s of col.matchSlots(tk, getTaskAssignments(tk, schedule))) {
      out.push(s.participant?.name ?? emptyLabel);
    }
  }
  return out;
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
