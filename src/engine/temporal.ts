/**
 * Temporal Engine — "Point of No Return" logic for Live Mode.
 *
 * Manages the temporal anchor that divides the schedule into:
 *  - Frozen Past: assignments whose tasks have ended or started before the anchor.
 *  - Modifiable Future: assignments whose tasks start strictly after the anchor.
 *
 * The past is immutable "Ground Truth" — no optimizer, rescue plan, or manual
 * action may alter it.
 */

import { type Assignment, AssignmentStatus, type Schedule, type Task, type TimeBlock } from '../models/types';

// ─── Core Temporal Predicates ────────────────────────────────────────────────

/**
 * Returns true if the task starts strictly at or after the anchor.
 * Only truly future tasks are eligible for modification.
 */
export function isFutureTask(task: Task, anchor: Date): boolean {
  return task.timeBlock.start.getTime() >= anchor.getTime();
}

/**
 * Returns true if the task has already ended (fully in the past).
 */
export function isPastTask(task: Task, anchor: Date): boolean {
  return task.timeBlock.end.getTime() <= anchor.getTime();
}

/**
 * Returns true if the task is currently in progress at the anchor time
 * (started before anchor but hasn't ended yet).
 */
export function isInProgressTask(task: Task, anchor: Date): boolean {
  return task.timeBlock.start.getTime() < anchor.getTime() && task.timeBlock.end.getTime() > anchor.getTime();
}

/**
 * Determine whether an assignment is modifiable given the temporal anchor.
 *
 * An assignment is modifiable when:
 *  1. Its task starts strictly at or after the anchor (fully in the future), AND
 *  2. Its status is not Frozen (time-frozen).
 *
 * Note: In-progress tasks (started but not ended) are treated as frozen
 * because they've already begun execution.
 */
export function isModifiableAssignment(assignment: Assignment, taskMap: Map<string, Task>, anchor: Date): boolean {
  const task = taskMap.get(assignment.taskId);
  if (!task) return false;

  // Task must be fully in the future
  if (!isFutureTask(task, anchor)) return false;

  // Status must allow modification
  if (assignment.status === AssignmentStatus.Frozen) {
    return false;
  }

  return true;
}

// ─── Freeze / Unfreeze Operations ────────────────────────────────────────────

/**
 * Freeze all assignments whose tasks are past or in-progress relative
 * to the temporal anchor. Sets their status to `Frozen`.
 *
 * Also unfreezes any previously-frozen assignments that are now in the
 * future (in case the anchor was moved backward).
 *
 * Mutates the schedule's assignments in place.
 *
 * @returns The number of assignments that changed status.
 */
export function freezeAssignments(schedule: Schedule, anchor: Date): number {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  let changed = 0;

  for (const assignment of schedule.assignments) {
    const task = taskMap.get(assignment.taskId);
    if (!task) continue;

    if (isFutureTask(task, anchor)) {
      // Task is in the future — unfreeze if it was previously frozen
      // (but don't touch Manual/Conflict statuses)
      if (assignment.status === AssignmentStatus.Frozen) {
        assignment.status = assignment.preFreezeStatus || AssignmentStatus.Scheduled;
        delete assignment.preFreezeStatus;
        assignment.updatedAt = new Date();
        changed++;
      }
    } else {
      // Task is past or in-progress — freeze it
      if (assignment.status !== AssignmentStatus.Frozen) {
        assignment.preFreezeStatus = assignment.status;
        assignment.status = AssignmentStatus.Frozen;
        assignment.updatedAt = new Date();
        changed++;
      }
    }
  }

  return changed;
}

/**
 * Remove all Frozen statuses from the schedule (when live mode is disabled).
 * Restores frozen assignments to Scheduled status.
 *
 * @returns The number of assignments unfrozen.
 */
export function unfreezeAll(schedule: Schedule): number {
  let changed = 0;
  for (const assignment of schedule.assignments) {
    if (assignment.status === AssignmentStatus.Frozen) {
      assignment.status = assignment.preFreezeStatus || AssignmentStatus.Scheduled;
      delete assignment.preFreezeStatus;
      assignment.updatedAt = new Date();
      changed++;
    }
  }
  return changed;
}

// ─── Time Window Helpers ─────────────────────────────────────────────────────

/**
 * Get the remaining modifiable time window from the anchor to the end
 * of the scheduling period.
 */
export function getFutureWindow(
  scheduleDate: Date,
  scheduleDays: number,
  anchor: Date,
  dayStartHour: number,
): TimeBlock {
  const scheduleEnd = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + scheduleDays,
    dayStartHour,
    0,
  );

  return {
    start: anchor,
    end: scheduleEnd,
  };
}

/**
 * Compute the day index (1-based) that the anchor falls on.
 * Returns 0 if the anchor is before the schedule start,
 * or scheduleDays+1 if it's after the schedule end.
 */
export function getAnchorDayIndex(
  scheduleDate: Date,
  scheduleDays: number,
  anchor: Date,
  dayStartHour: number,
): number {
  for (let d = 1; d <= scheduleDays; d++) {
    const dayStart = new Date(
      scheduleDate.getFullYear(),
      scheduleDate.getMonth(),
      scheduleDate.getDate() + d - 1,
      dayStartHour,
      0,
    );
    const dayEnd = new Date(
      scheduleDate.getFullYear(),
      scheduleDate.getMonth(),
      scheduleDate.getDate() + d,
      dayStartHour,
      0,
    );

    if (anchor.getTime() >= dayStart.getTime() && anchor.getTime() < dayEnd.getTime()) {
      return d;
    }
  }

  // Anchor is before day 1 or after the last day
  const firstDayStart = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate(),
    dayStartHour,
    0,
  );
  if (anchor.getTime() < firstDayStart.getTime()) return 0;
  return scheduleDays + 1;
}

/**
 * Check whether a given day index is fully frozen (entirely before the anchor).
 */
export function isDayFrozen(dayIndex: number, scheduleDate: Date, anchor: Date, dayStartHour: number): boolean {
  // The end of this day = start of next day
  const dayEnd = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex,
    dayStartHour,
    0,
  );
  return anchor.getTime() >= dayEnd.getTime();
}

/**
 * Check whether a given day index is partially frozen
 * (anchor falls within this day's window).
 */
export function isDayPartiallyFrozen(
  dayIndex: number,
  scheduleDate: Date,
  anchor: Date,
  dayStartHour: number,
): boolean {
  const dayStart = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex - 1,
    dayStartHour,
    0,
  );
  const dayEnd = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex,
    dayStartHour,
    0,
  );
  return anchor.getTime() > dayStart.getTime() && anchor.getTime() < dayEnd.getTime();
}

// ─── Injection Gates (calendar-day semantics) ────────────────────────────────
//
// BALTAM-style post-generation injection composes a task's absolute start as
//   calendarMidnight(dayIndex) + startHour*h + startMinute*m
// where `calendarMidnight(dayIndex) = periodStart.date + (dayIndex - 1)` at
// local midnight — i.e. the calendar day, NOT the operational day.
//
// This means modifiability for injection is tied to calendar midnight, not to
// `isDayFrozen` (which uses operational-day boundaries). The two diverge when
// `dayStartHour > 0`: an operational day whose anchor is past its calendar
// midnight but before `dayStartHour` the next morning is still "partially
// frozen" operationally — but every calendar hour [0..23] on its calendar
// day is already past, so no `startHour` can produce a future start.
//
// The helpers below are the correct contract surface for day-index-based
// mutation entry points. For existing-assignment status checks, use
// `isModifiableAssignment` / `isFutureTask` instead.

/**
 * Returns true iff a task composed as
 * `calendarMidnight(dayIndex) + startHour*h + startMinute*m` for some
 * `startHour ∈ [0, 23]` and `startMinute ∈ [0, 59]` can land at or after the
 * anchor.
 *
 * Equivalent to `anchor < calendarMidnight(dayIndex + 1)`.
 */
export function isDayModifiable(dayIndex: number, scheduleDate: Date, anchor: Date): boolean {
  if (dayIndex < 1) return false;
  const nextCalMidnight = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex,
  );
  return anchor.getTime() < nextCalMidnight.getTime();
}

/**
 * For a modifiable `dayIndex`, returns `{ hourMin, minuteMin }` — the
 * minimum `(startHour, startMinute)` pair such that
 * `calendarMidnight(dayIndex) + startHour*h + startMinute*m >= anchor`.
 * Returns `null` when the calendar day is fully past (see `isDayModifiable`).
 *
 * `minuteMin` applies only when `startHour === hourMin`; for larger hours
 * any minute 0..59 is legal.
 *
 * Rounds up to whole-minute precision so a user picking exactly
 * `(hourMin, minuteMin)` still produces a start `>=` anchor even when the
 * anchor has sub-minute components.
 */
export function getInjectStartFloor(
  dayIndex: number,
  scheduleDate: Date,
  anchor: Date,
): { hourMin: number; minuteMin: number } | null {
  if (!isDayModifiable(dayIndex, scheduleDate, anchor)) return null;
  const calMidnight = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex - 1,
  );
  const deltaMs = anchor.getTime() - calMidnight.getTime();
  if (deltaMs <= 0) return { hourMin: 0, minuteMin: 0 };
  const deltaMin = Math.ceil(deltaMs / 60000);
  // Defensive: isDayModifiable already excludes deltaMin >= 24*60, but if
  // ceil pushed us exactly to that boundary treat it as fully past.
  if (deltaMin >= 24 * 60) return null;
  return {
    hourMin: Math.floor(deltaMin / 60),
    minuteMin: deltaMin % 60,
  };
}

/**
 * Final engine-side gate for post-generation task injection.
 *
 * Rejects any TimeBlock whose start is strictly before the anchor, matching
 * the "equal-to-anchor counts as future" semantics of `isFutureTask`.
 *
 * Used by `injectAndStaff` before any mutation of the engine or schedule.
 */
export function assertInjectableTimeBlock(
  block: TimeBlock,
  anchor: Date,
): { ok: true } | { ok: false; reason: 'past-time' } {
  if (block.start.getTime() < anchor.getTime()) {
    return { ok: false, reason: 'past-time' };
  }
  return { ok: true };
}
