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
  differenceInHours,
  differenceInMinutes,
  format,
  isAfter,
  isBefore,
  isEqual,
  isWithinInterval,
  parseISO,
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
 * Schedule context needed to evaluate weekly `dateUnavailability` rules.
 *
 * Rules are indexed by `dayOfWeek` (JS weekday). They are instantiated against
 * the **operational days** that fall inside the scheduling window, not against
 * arbitrary calendar days a task's timeBlock happens to touch. This prevents
 * cross-midnight false violations where a Day-N task spilling past calendar
 * midnight into Day N+1 triggers a rule for Day N+1's calendar weekday even
 * when Day N+1 is outside the schedule or operationally still the same day.
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
 * Check whether a task's time block is blocked by any recurring dateUnavailability rule.
 *
 * Iterates the operational days inside the schedule window (Day 1..N). For each
 * op-day whose base calendar weekday matches a rule's `dayOfWeek`, the rule is
 * instantiated at that calendar date:
 *   - `allDay`: blackout spans the full operational day window
 *     `[baseDate(D) + dayStartHour, baseDate(D+1) + dayStartHour)`.
 *   - partial hours: wall-clock anchored to the op-day's base calendar date,
 *     with wrap-around when `endHour <= startHour`.
 *
 * Days outside the scheduling window never contribute a blackout — per user
 * semantics, weekly rules only apply to the operational days the user actually
 * scheduled.
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

  for (let dayIdx = 0; dayIdx < ctx.scheduleDays; dayIdx++) {
    const opDayBase = new Date(baseY, baseM, baseD + dayIdx);
    const opDayStartMs = new Date(baseY, baseM, baseD + dayIdx, ctx.dayStartHour, 0).getTime();
    const opDayEndMs = new Date(baseY, baseM, baseD + dayIdx + 1, ctx.dayStartHour, 0).getTime();
    // Quick skip: op-day window doesn't overlap the task at all
    if (opDayEndMs <= taskStartMs || opDayStartMs >= taskEndMs) continue;

    const dow = opDayBase.getDay();
    for (const rule of rules) {
      if (rule.dayOfWeek !== dow) continue;

      let blockStartMs: number;
      let blockEndMs: number;
      if (rule.allDay) {
        blockStartMs = opDayStartMs;
        blockEndMs = opDayEndMs;
      } else {
        blockStartMs = new Date(baseY, baseM, baseD + dayIdx, rule.startHour, 0).getTime();
        blockEndMs =
          rule.endHour <= rule.startHour
            ? new Date(baseY, baseM, baseD + dayIdx + 1, rule.endHour, 0).getTime()
            : new Date(baseY, baseM, baseD + dayIdx, rule.endHour, 0).getTime();
      }

      if (taskStartMs < blockEndMs && blockStartMs < taskEndMs) {
        return true;
      }
    }
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
