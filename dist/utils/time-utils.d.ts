/**
 * Time Utilities - date-fns based helpers for the scheduling engine.
 *
 * Handles midnight-crossing tasks, continuous timelines, and availability checks.
 */
import { TimeBlock, AvailabilityWindow } from '../models/types';
/**
 * Create a TimeBlock, automatically adjusting end to next day if it appears
 * to precede start (midnight-crossing scenario).
 */
export declare function createTimeBlock(start: Date, end: Date): TimeBlock;
/**
 * Create a TimeBlock from hour offsets on a given base date.
 * Example: createTimeBlockFromHours(baseDate, 21, 5) → 21:00 today to 05:00 tomorrow
 */
export declare function createTimeBlockFromHours(baseDate: Date, startHour: number, endHour: number, durationHours?: number): TimeBlock;
/**
 * Duration of a TimeBlock in minutes.
 */
export declare function blockDurationMinutes(block: TimeBlock): number;
/**
 * Duration of a TimeBlock in hours (decimal).
 */
export declare function blockDurationHours(block: TimeBlock): number;
/**
 * Check if two TimeBlocks overlap (strictly — sharing an endpoint doesn't count).
 */
export declare function blocksOverlap(a: TimeBlock, b: TimeBlock): boolean;
/**
 * Check whether a participant's availability fully covers a task's time block.
 * The participant MUST be available for the ENTIRE duration.
 */
export declare function isFullyCovered(taskBlock: TimeBlock, availability: AvailabilityWindow[]): boolean;
/**
 * Compute the gap in minutes between two non-overlapping TimeBlocks.
 * Returns 0 if they overlap or are adjacent.
 */
export declare function gapMinutes(earlier: TimeBlock, later: TimeBlock): number;
/**
 * Compute gap in hours (decimal).
 */
export declare function gapHours(earlier: TimeBlock, later: TimeBlock): number;
/**
 * Sort TimeBlocks by start time ascending.
 */
export declare function sortBlocksByStart(blocks: TimeBlock[]): TimeBlock[];
/**
 * Merge overlapping/adjacent TimeBlocks into continuous ranges.
 */
export declare function mergeBlocks(blocks: TimeBlock[]): TimeBlock[];
/**
 * Format a TimeBlock for display.
 */
export declare function formatBlock(block: TimeBlock): string;
/**
 * Get the earliest and latest bounds of an array of TimeBlocks.
 */
export declare function getTimelineBounds(blocks: TimeBlock[]): {
    start: Date;
    end: Date;
} | null;
/**
 * Check if a date falls within a TimeBlock.
 */
export declare function isDateInBlock(date: Date, block: TimeBlock): boolean;
/**
 * Generate N-hour shift blocks starting from a base time.
 * E.g., 3 shifts of 8h starting at 06:00.
 */
export declare function generateShiftBlocks(baseStart: Date, shiftDurationHours: number, shiftCount: number): TimeBlock[];
//# sourceMappingURL=time-utils.d.ts.map