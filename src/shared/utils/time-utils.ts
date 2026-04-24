/**
 * Time Utilities - date-fns based helpers for the scheduling engine.
 *
 * Handles midnight-crossing tasks, continuous timelines, and availability checks.
 */

import {
  addDays,
  addHours,
  max as dateMax,
  min as dateMin,
  differenceInMinutes,
  format,
  isBefore,
  isEqual,
  isWithinInterval,
  startOfDay,
} from 'date-fns';

import type { AvailabilityWindow, DateUnavailability, TimeBlock } from '../../models/types';

/**
 * Create a TimeBlock, automatically adjusting end to next day if it appears
 * to precede start (midnight-crossing scenario).
 */
export function createTimeBlock(start: Date, end: Date): TimeBlock {
  if (isBefore(end, start) || isEqual(end, start)) {
    // Midnight crossing: push end to next day
    return { start, end: addDays(end, 1) };
  }
  return { start, end };
}

/**
 * Create a TimeBlock from hour offsets on a given base date.
 * Example: createTimeBlockFromHours(baseDate, 21, 5) → 21:00 today to 05:00 tomorrow
 */
export function createTimeBlockFromHours(
  baseDate: Date,
  startHour: number,
  endHour: number,
  durationHours?: number,
): TimeBlock {
  const dayStart = startOfDay(baseDate);
  const start = addHours(dayStart, startHour);
  let end = addHours(dayStart, endHour);

  if (endHour <= startHour) {
    end = addDays(end, 1);
  }
  // If explicit duration provided, use it
  if (durationHours !== undefined) {
    end = addHours(start, durationHours);
  }

  return { start, end };
}

/**
 * Duration of a TimeBlock in minutes.
 */
export function blockDurationMinutes(block: TimeBlock): number {
  return differenceInMinutes(block.end, block.start);
}

/**
 * Duration of a TimeBlock in hours (decimal).
 */
export function blockDurationHours(block: TimeBlock): number {
  return differenceInMinutes(block.end, block.start) / 60;
}

/**
 * Check if two TimeBlocks overlap (strictly — sharing an endpoint doesn't count).
 *
 * Uses raw .getTime() comparisons instead of date-fns for speed in tight
 * loops (eligibility checks, swap feasibility).  Semantics are identical:
 * isBefore(x, y) ≡ x.getTime() < y.getTime().
 */
export function blocksOverlap(a: TimeBlock, b: TimeBlock): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/**
 * Check whether a participant's availability fully covers a task's time block.
 * The participant MUST be available for the ENTIRE duration.
 *
 * Uses raw .getTime() comparisons for speed in tight loops.
 * isBefore(x,y)||isEqual(x,y) ≡ x.getTime() <= y.getTime()
 * isAfter(x,y)||isEqual(x,y)  ≡ x.getTime() >= y.getTime()
 */
export function isFullyCovered(taskBlock: TimeBlock, availability: AvailabilityWindow[]): boolean {
  const tStart = taskBlock.start.getTime();
  const tEnd = taskBlock.end.getTime();
  for (const window of availability) {
    if (window.start.getTime() <= tStart && window.end.getTime() >= tEnd) {
      return true;
    }
  }
  return false;
}

/**
 * Schedule context needed to evaluate recurring `dateUnavailability` rules.
 *
 * Rules are addressed by schedule-relative day index (1..scheduleDays), the
 * same concept the user sees in the UI. They are instantiated against the
 * operational days inside the scheduling window — never against calendar
 * weekdays. This keeps "day N is blocked" interpretation consistent across
 * UI, validation, and export, regardless of the calendar date day 1 happens
 * to fall on.
 */
export interface ScheduleContext {
  /** Calendar date of operational Day 1 (the hour component is ignored). */
  baseDate: Date;
  /** Number of operational days in the scheduling window. */
  scheduleDays: number;
  /** Operational day boundary hour (e.g. 5 means a day rolls at 05:00). */
  dayStartHour: number;
}

/**
 * Map a wall-clock hour on schedule day `dayIndex` into an absolute timestamp
 * inside that op-day's window.
 *
 *   - If `hour >= dayStartHour`, the hour falls on the op-day's base calendar
 *     date (the morning/day portion of the op-day).
 *   - If `hour < dayStartHour`, the hour belongs to the op-day's post-midnight
 *     tail, i.e. base calendar date + 1.
 *
 * Example (dayStartHour = 5, op-day 1 base = Sunday):
 *   hourInOpDay(baseDate, 5, 1, 10) → calendar Sunday 10:00  (daytime)
 *   hourInOpDay(baseDate, 5, 1, 3)  → calendar Monday   03:00 (tail of op-day 1)
 *   hourInOpDay(baseDate, 5, 1, 5)  → calendar Sunday 05:00  (op-day start)
 */
export function hourInOpDay(baseDate: Date, dayStartHour: number, dayIndex: number, hour: number): number {
  const calOffset = hour >= dayStartHour ? dayIndex - 1 : dayIndex;
  return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + calOffset, hour, 0).getTime();
}

/**
 * Check whether a task's time block is blocked by any recurring
 * `dateUnavailability` rule.
 *
 * Rules reference schedule days by index (`dayIndex`, optionally extended with
 * `endDayIndex`). For each rule, the blackout is composed in op-day space:
 *
 *   - `allDay`: blackout spans `[opDayStart(dayIndex), opDayStart(endDayIndex+1))`,
 *     i.e. from the operational-day start of the first day through the
 *     operational-day start immediately after the last day in the range.
 *   - partial hours: `[hourInOpDay(dayIndex, startHour), hourInOpDay(endDayIndex, endHour))`.
 *     When the result is non-positive (end <= start on the same single day),
 *     the end hour wraps by one calendar day — this handles the "22:00 → 04:00
 *     same op-day" pattern.
 *
 * Rules whose range lies entirely outside 1..scheduleDays contribute nothing.
 * Rules that partially overlap the window are clamped (no wrap around day N).
 */
export function isBlockedByDateUnavailability(
  taskBlock: TimeBlock,
  rules: DateUnavailability[],
  ctx: ScheduleContext,
): boolean {
  if (!rules || rules.length === 0) return false;
  if (ctx.scheduleDays <= 0) return false;

  const taskStartMs = taskBlock.start.getTime();
  const taskEndMs = taskBlock.end.getTime();
  const baseY = ctx.baseDate.getFullYear();
  const baseM = ctx.baseDate.getMonth();
  const baseD = ctx.baseDate.getDate();
  const dsh = ctx.dayStartHour;

  // Schedule-window coarse bounds — if the task falls entirely outside the
  // window, no rule can apply.
  const winStartMs = new Date(baseY, baseM, baseD, dsh, 0).getTime();
  const winEndMs = new Date(baseY, baseM, baseD + ctx.scheduleDays, dsh, 0).getTime();
  if (taskEndMs <= winStartMs || taskStartMs >= winEndMs) return false;

  for (const rule of rules) {
    // Defensive guard: malformed rules (e.g. missing dayIndex from stale
    // persisted data) must be skipped rather than producing NaN blackouts.
    if (!Number.isInteger(rule.dayIndex)) continue;
    const startIdx = Math.max(1, rule.dayIndex);
    const endIdx = Math.min(ctx.scheduleDays, rule.endDayIndex ?? rule.dayIndex);
    if (endIdx < 1 || startIdx > ctx.scheduleDays || endIdx < startIdx) continue;

    let blockStartMs: number;
    let blockEndMs: number;
    if (rule.allDay) {
      blockStartMs = new Date(baseY, baseM, baseD + startIdx - 1, dsh, 0).getTime();
      blockEndMs = new Date(baseY, baseM, baseD + endIdx, dsh, 0).getTime();
    } else {
      blockStartMs = hourInOpDay(ctx.baseDate, dsh, startIdx, rule.startHour);
      blockEndMs = hourInOpDay(ctx.baseDate, dsh, endIdx, rule.endHour);
      if (blockEndMs <= blockStartMs) {
        blockEndMs = new Date(blockEndMs + 24 * 3600 * 1000).getTime();
      }
    }

    if (taskStartMs < blockEndMs && blockStartMs < taskEndMs) return true;
  }

  return false;
}

/**
 * Compute the gap in minutes between two non-overlapping TimeBlocks.
 * Returns 0 if they overlap or are adjacent.
 */
export function gapMinutes(earlier: TimeBlock, later: TimeBlock): number {
  if (!isBefore(earlier.end, later.start)) return 0;
  return differenceInMinutes(later.start, earlier.end);
}

/**
 * Compute gap in hours (decimal).
 */
export function gapHours(earlier: TimeBlock, later: TimeBlock): number {
  return gapMinutes(earlier, later) / 60;
}

/**
 * Sort TimeBlocks by start time ascending.
 */
export function sortBlocksByStart(blocks: TimeBlock[]): TimeBlock[] {
  return [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Merge overlapping/adjacent TimeBlocks into continuous ranges.
 */
export function mergeBlocks(blocks: TimeBlock[]): TimeBlock[] {
  if (blocks.length === 0) return [];
  const sorted = sortBlocksByStart(blocks);
  const merged: TimeBlock[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (isBefore(current.start, last.end) || isEqual(current.start, last.end)) {
      // Extend
      last.end = dateMax([last.end, current.end]);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/**
 * Format a TimeBlock for display.
 */
export function formatBlock(block: TimeBlock): string {
  return `${format(block.start, 'yyyy-MM-dd HH:mm')} → ${format(block.end, 'yyyy-MM-dd HH:mm')}`;
}

/**
 * Get the earliest and latest bounds of an array of TimeBlocks.
 */
export function getTimelineBounds(blocks: TimeBlock[]): { start: Date; end: Date } | null {
  if (blocks.length === 0) return null;
  return {
    start: dateMin(blocks.map((b) => b.start)),
    end: dateMax(blocks.map((b) => b.end)),
  };
}

/**
 * Check if a date falls within a TimeBlock.
 */
export function isDateInBlock(date: Date, block: TimeBlock): boolean {
  return isWithinInterval(date, { start: block.start, end: block.end });
}

/**
 * Generate N-hour shift blocks starting from a base time.
 * E.g., 3 shifts of 8h starting at 06:00.
 */
export function generateShiftBlocks(baseStart: Date, shiftDurationHours: number, shiftCount: number): TimeBlock[] {
  if (shiftCount < 1 || shiftDurationHours <= 0) return [];
  const shifts: TimeBlock[] = [];
  let cursor = baseStart;
  for (let i = 0; i < shiftCount; i++) {
    const end = addHours(cursor, shiftDurationHours);
    shifts.push({ start: cursor, end });
    cursor = end;
  }
  return shifts;
}
