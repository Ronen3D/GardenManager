"use strict";
/**
 * Time Utilities - date-fns based helpers for the scheduling engine.
 *
 * Handles midnight-crossing tasks, continuous timelines, and availability checks.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTimeBlock = createTimeBlock;
exports.createTimeBlockFromHours = createTimeBlockFromHours;
exports.blockDurationMinutes = blockDurationMinutes;
exports.blockDurationHours = blockDurationHours;
exports.blocksOverlap = blocksOverlap;
exports.isFullyCovered = isFullyCovered;
exports.gapMinutes = gapMinutes;
exports.gapHours = gapHours;
exports.sortBlocksByStart = sortBlocksByStart;
exports.mergeBlocks = mergeBlocks;
exports.formatBlock = formatBlock;
exports.getTimelineBounds = getTimelineBounds;
exports.isDateInBlock = isDateInBlock;
exports.generateShiftBlocks = generateShiftBlocks;
const date_fns_1 = require("date-fns");
/**
 * Create a TimeBlock, automatically adjusting end to next day if it appears
 * to precede start (midnight-crossing scenario).
 */
function createTimeBlock(start, end) {
    if ((0, date_fns_1.isBefore)(end, start) || (0, date_fns_1.isEqual)(end, start)) {
        // Midnight crossing: push end to next day
        return { start, end: (0, date_fns_1.addDays)(end, 1) };
    }
    return { start, end };
}
/**
 * Create a TimeBlock from hour offsets on a given base date.
 * Example: createTimeBlockFromHours(baseDate, 21, 5) → 21:00 today to 05:00 tomorrow
 */
function createTimeBlockFromHours(baseDate, startHour, endHour, durationHours) {
    const dayStart = (0, date_fns_1.startOfDay)(baseDate);
    const start = (0, date_fns_1.addHours)(dayStart, startHour);
    let end = (0, date_fns_1.addHours)(dayStart, endHour);
    if (endHour <= startHour) {
        end = (0, date_fns_1.addDays)(end, 1);
    }
    // If explicit duration provided, use it
    if (durationHours !== undefined) {
        end = (0, date_fns_1.addHours)(start, durationHours);
    }
    return { start, end };
}
/**
 * Duration of a TimeBlock in minutes.
 */
function blockDurationMinutes(block) {
    return (0, date_fns_1.differenceInMinutes)(block.end, block.start);
}
/**
 * Duration of a TimeBlock in hours (decimal).
 */
function blockDurationHours(block) {
    return (0, date_fns_1.differenceInMinutes)(block.end, block.start) / 60;
}
/**
 * Check if two TimeBlocks overlap (strictly — sharing an endpoint doesn't count).
 */
function blocksOverlap(a, b) {
    return (0, date_fns_1.isBefore)(a.start, b.end) && (0, date_fns_1.isBefore)(b.start, a.end);
}
/**
 * Check whether a participant's availability fully covers a task's time block.
 * The participant MUST be available for the ENTIRE duration.
 */
function isFullyCovered(taskBlock, availability) {
    for (const window of availability) {
        const coversStart = (0, date_fns_1.isBefore)(window.start, taskBlock.start) || (0, date_fns_1.isEqual)(window.start, taskBlock.start);
        const coversEnd = (0, date_fns_1.isAfter)(window.end, taskBlock.end) || (0, date_fns_1.isEqual)(window.end, taskBlock.end);
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
function gapMinutes(earlier, later) {
    if (!(0, date_fns_1.isBefore)(earlier.end, later.start))
        return 0;
    return (0, date_fns_1.differenceInMinutes)(later.start, earlier.end);
}
/**
 * Compute gap in hours (decimal).
 */
function gapHours(earlier, later) {
    return gapMinutes(earlier, later) / 60;
}
/**
 * Sort TimeBlocks by start time ascending.
 */
function sortBlocksByStart(blocks) {
    return [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
}
/**
 * Merge overlapping/adjacent TimeBlocks into continuous ranges.
 */
function mergeBlocks(blocks) {
    if (blocks.length === 0)
        return [];
    const sorted = sortBlocksByStart(blocks);
    const merged = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const last = merged[merged.length - 1];
        if ((0, date_fns_1.isBefore)(current.start, last.end) || (0, date_fns_1.isEqual)(current.start, last.end)) {
            // Extend
            last.end = (0, date_fns_1.max)([last.end, current.end]);
        }
        else {
            merged.push({ ...current });
        }
    }
    return merged;
}
/**
 * Format a TimeBlock for display.
 */
function formatBlock(block) {
    return `${(0, date_fns_1.format)(block.start, 'yyyy-MM-dd HH:mm')} → ${(0, date_fns_1.format)(block.end, 'yyyy-MM-dd HH:mm')}`;
}
/**
 * Get the earliest and latest bounds of an array of TimeBlocks.
 */
function getTimelineBounds(blocks) {
    if (blocks.length === 0)
        return null;
    return {
        start: (0, date_fns_1.min)(blocks.map((b) => b.start)),
        end: (0, date_fns_1.max)(blocks.map((b) => b.end)),
    };
}
/**
 * Check if a date falls within a TimeBlock.
 */
function isDateInBlock(date, block) {
    return (0, date_fns_1.isWithinInterval)(date, { start: block.start, end: block.end });
}
/**
 * Generate N-hour shift blocks starting from a base time.
 * E.g., 3 shifts of 8h starting at 06:00.
 */
function generateShiftBlocks(baseStart, shiftDurationHours, shiftCount) {
    const shifts = [];
    let cursor = baseStart;
    for (let i = 0; i < shiftCount; i++) {
        const end = (0, date_fns_1.addHours)(cursor, shiftDurationHours);
        shifts.push({ start: cursor, end });
        cursor = end;
    }
    return shifts;
}
//# sourceMappingURL=time-utils.js.map