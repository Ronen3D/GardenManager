/**
 * Time Utilities - date-fns based helpers for the scheduling engine.
 *
 * Handles midnight-crossing tasks, continuous timelines, and availability checks.
 */

import {
  differenceInMinutes,
  differenceInHours,
  isWithinInterval,
  isBefore,
  isAfter,
  isEqual,
  addDays,
  addHours,
  startOfDay,
  max as dateMax,
  min as dateMin,
  format,
  parseISO,
} from 'date-fns';

import { TimeBlock, AvailabilityWindow } from '../../models/types';

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
 */
export function blocksOverlap(a: TimeBlock, b: TimeBlock): boolean {
  return isBefore(a.start, b.end) && isBefore(b.start, a.end);
}

/**
 * Check whether a participant's availability fully covers a task's time block.
 * The participant MUST be available for the ENTIRE duration.
 */
export function isFullyCovered(
  taskBlock: TimeBlock,
  availability: AvailabilityWindow[],
): boolean {
  for (const window of availability) {
    const coversStart =
      isBefore(window.start, taskBlock.start) || isEqual(window.start, taskBlock.start);
    const coversEnd =
      isAfter(window.end, taskBlock.end) || isEqual(window.end, taskBlock.end);
    if (coversStart && coversEnd) {
      return true;
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
export function generateShiftBlocks(
  baseStart: Date,
  shiftDurationHours: number,
  shiftCount: number,
): TimeBlock[] {
  const shifts: TimeBlock[] = [];
  let cursor = baseStart;
  for (let i = 0; i < shiftCount; i++) {
    const end = addHours(cursor, shiftDurationHours);
    shifts.push({ start: cursor, end });
    cursor = end;
  }
  return shifts;
}
