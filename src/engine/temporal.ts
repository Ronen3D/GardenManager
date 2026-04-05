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

import {
  Schedule,
  Assignment,
  Task,
  AssignmentStatus,
  TimeBlock,
} from '../models/types';

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
  return task.timeBlock.start.getTime() < anchor.getTime() &&
         task.timeBlock.end.getTime() > anchor.getTime();
}

/**
 * Determine whether an assignment is modifiable given the temporal anchor.
 *
 * An assignment is modifiable when:
 *  1. Its task starts strictly at or after the anchor (fully in the future), AND
 *  2. Its status is not Locked or Frozen (user-pinned or time-frozen).
 *
 * Note: In-progress tasks (started but not ended) are treated as frozen
 * because they've already begun execution.
 */
export function isModifiableAssignment(
  assignment: Assignment,
  taskMap: Map<string, Task>,
  anchor: Date,
): boolean {
  const task = taskMap.get(assignment.taskId);
  if (!task) return false;

  // Task must be fully in the future
  if (!isFutureTask(task, anchor)) return false;

  // Status must allow modification
  if (assignment.status === AssignmentStatus.Locked ||
      assignment.status === AssignmentStatus.Frozen) {
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
      // (but don't touch Locked/Manual/Conflict statuses)
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
    dayStartHour, 0,
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
      dayStartHour, 0,
    );
    const dayEnd = new Date(
      scheduleDate.getFullYear(),
      scheduleDate.getMonth(),
      scheduleDate.getDate() + d,
      dayStartHour, 0,
    );

    if (anchor.getTime() >= dayStart.getTime() &&
        anchor.getTime() < dayEnd.getTime()) {
      return d;
    }
  }

  // Anchor is before day 1 or after the last day
  const firstDayStart = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate(),
    dayStartHour, 0,
  );
  if (anchor.getTime() < firstDayStart.getTime()) return 0;
  return scheduleDays + 1;
}

/**
 * Check whether a given day index is fully frozen (entirely before the anchor).
 */
export function isDayFrozen(
  dayIndex: number,
  scheduleDate: Date,
  anchor: Date,
  dayStartHour: number,
): boolean {
  // The end of this day = start of next day
  const dayEnd = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex,
    dayStartHour, 0,
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
    dayStartHour, 0,
  );
  const dayEnd = new Date(
    scheduleDate.getFullYear(),
    scheduleDate.getMonth(),
    scheduleDate.getDate() + dayIndex,
    dayStartHour, 0,
  );
  return anchor.getTime() > dayStart.getTime() &&
         anchor.getTime() < dayEnd.getTime();
}
