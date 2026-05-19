/**
 * HC-15: Sleep & Recovery
 *
 * Per-task recovery window. If a task's 1-based shift index is in the rule's
 * `triggerShifts` set, a recovery window starts at the task's end timestamp
 * and lasts `recoveryHours` whole hours. During that window the assigned
 * participant may not take any other task whose effective load > 0 at any
 * instant overlapping the window. Tasks whose effective load is 0 throughout
 * the overlapping portion are allowed.
 *
 * Centralised here so every placement path (optimizer, rescue, manual,
 * aggregate validator) shares a single source of truth.
 */

import type { Assignment, ConstraintViolation, LoadWindow, Task } from '../models/types';
import { ViolationSeverity } from '../models/types';
import { getLoadWeightAtTime } from '../shared/utils/load-weighting';
import { describeTaskBidi } from '../utils/date-utils';

function violation(code: string, message: string, taskId: string, participantId?: string): ConstraintViolation {
  return {
    severity: ViolationSeverity.Error,
    code,
    message,
    taskId,
    participantId,
  };
}

/**
 * Compute the recovery window produced by `task` for HC-15, or null if the
 * task has no rule, the rule has no triggering shifts selected, or this
 * instance's shift is not in that set. The window is half-open [start, end)
 * to match the load-weighting semantics used across the engine.
 *
 * Tasks generated without a `shiftIndex` (legacy / fixture data) default to
 * shift 1, so single-shift fixtures keep working without explicit setup.
 */
export function getRecoveryWindow(task: Task): { start: Date; end: Date } | null {
  const rule = task.sleepRecovery;
  if (!rule) return null;
  if (rule.recoveryHours <= 0) return null;
  if (!rule.triggerShifts || rule.triggerShifts.length === 0) return null;
  const shiftIndex = task.shiftIndex ?? 1;
  if (!rule.triggerShifts.includes(shiftIndex)) return null;
  const start = new Date(task.timeBlock.end.getTime());
  const end = new Date(start.getTime() + rule.recoveryHours * 3600000);
  return { start, end };
}

function dayStartOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function windowCrossesMidnight(w: LoadWindow): boolean {
  return w.endHour < w.startHour || (w.endHour === w.startHour && w.endMinute <= w.startMinute);
}

/**
 * Returns true if `candidate` has effective load > 0 at any instant that
 * overlaps [window.start, window.end).
 *
 * `getLoadWeightAtTime` is piecewise-constant with breakpoints at the
 * task's timeBlock edges and each loadWindow edge. Sampling at the left
 * edge of every sub-interval inside the overlap is therefore sufficient
 * to detect any > 0 segment (half-open intervals mean the left edge
 * carries that sub-interval's weight).
 */
export function hasLoadDuringOverlap(candidate: Task, window: { start: Date; end: Date }): boolean {
  const taskStart = candidate.timeBlock.start.getTime();
  const taskEnd = candidate.timeBlock.end.getTime();
  const winStart = window.start.getTime();
  const winEnd = window.end.getTime();

  const overlapStart = Math.max(taskStart, winStart);
  const overlapEnd = Math.min(taskEnd, winEnd);
  if (overlapEnd <= overlapStart) return false;

  const breakpoints: number[] = [overlapStart];
  const windows = candidate.loadWindows ?? [];

  if (windows.length > 0) {
    // Enumerate per-day window occurrences across the calendar days the task
    // touches (including the day before, to catch midnight-crossing windows
    // that started the previous calendar day and are still active).
    const firstDay = dayStartOf(new Date(taskStart - 86_400_000));
    const lastDay = dayStartOf(new Date(taskEnd));
    const cursor = new Date(firstDay);
    while (cursor.getTime() <= lastDay.getTime()) {
      for (const w of windows) {
        const crosses = windowCrossesMidnight(w);
        const wStart = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          cursor.getDate(),
          w.startHour,
          w.startMinute,
          0,
          0,
        ).getTime();
        const wEnd = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          cursor.getDate() + (crosses ? 1 : 0),
          w.endHour,
          w.endMinute,
          0,
          0,
        ).getTime();
        if (wStart > overlapStart && wStart < overlapEnd) breakpoints.push(wStart);
        if (wEnd > overlapStart && wEnd < overlapEnd) breakpoints.push(wEnd);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  for (const bp of breakpoints) {
    const weight = getLoadWeightAtTime(candidate, new Date(bp));
    if (weight > 0) return true;
  }
  return false;
}

/**
 * Fast per-placement HC-15 check used by `checkEligibility()`.
 *
 * Returns true when placing `candidate` would produce a violation. Covers
 * both directions:
 *  - an existing assignment triggers a recovery window and `candidate`
 *    has load > 0 inside the overlap, or
 *  - `candidate` itself carries a rule triggered by its own end time and
 *    its recovery window overlaps an existing assignment with load > 0.
 *
 * Symmetric coverage prevents order-of-placement bypass — whichever task
 * is placed first, the violation is still caught.
 */
export function checkSleepRecoveryForPlacement(
  candidate: Task,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
): boolean {
  // Direction 1: existing triggering task → candidate is the loaded task
  for (const a of participantAssignments) {
    const other = taskMap.get(a.taskId);
    if (!other || other.id === candidate.id) continue;
    // HC-15 (D18): work belonging to the SAME original occurrence never
    // recovery-flags itself. Two halves of one split slot (same
    // `splitGroupId`) — defense-in-depth, HC-16 keeps siblings apart — and
    // two halves of DIFFERENT slots of the same occurrence (same
    // `splitOccurrenceId`, a legitimate continuous run HC-16 allows) are both
    // exempt: together they are exactly the unsplit occurrence, whose
    // recovery window legitimately starts at the occurrence end. Inert when
    // no task is split.
    if (other.splitGroupId !== undefined && other.splitGroupId === candidate.splitGroupId) continue;
    if (other.splitOccurrenceId !== undefined && other.splitOccurrenceId === candidate.splitOccurrenceId) continue;
    const window = getRecoveryWindow(other);
    if (!window) continue;
    if (hasLoadDuringOverlap(candidate, window)) return true;
  }

  // Direction 2: candidate is the triggering task → existing assignment is the loaded task
  const ownWindow = getRecoveryWindow(candidate);
  if (ownWindow) {
    for (const a of participantAssignments) {
      const other = taskMap.get(a.taskId);
      if (!other || other.id === candidate.id) continue;
      // Same exemptions as Direction 1 / the aggregate `checkSleepRecovery`:
      // work of the SAME original occurrence never recovery-flags itself —
      // same split slot (`splitGroupId`) or different slots of the same
      // occurrence (`splitOccurrenceId`, a legitimate continuous run HC-16
      // allows). Without this, per-placement/SA HC-15 would be order-dependent
      // and over-strict vs the final validator. Inert when no task is split.
      if (other.splitGroupId !== undefined && other.splitGroupId === candidate.splitGroupId) continue;
      if (other.splitOccurrenceId !== undefined && other.splitOccurrenceId === candidate.splitOccurrenceId) continue;
      if (hasLoadDuringOverlap(other, ownWindow)) return true;
    }
  }

  return false;
}

/**
 * Aggregate HC-15 pass — produces violations for `validateHardConstraints`.
 * Mirrors the shape of `checkRestRules`: iterate the participant's assignments,
 * derive each task's recovery window (if any), and emit a violation for every
 * other assignment whose task has load > 0 in the overlap.
 */
export function checkSleepRecovery(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  participantName?: string,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const displayName = participantName || participantId;

  const own: Task[] = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const t = taskMap.get(a.taskId);
    if (t) own.push(t);
  }
  if (own.length < 2) return violations;

  const reported = new Set<string>();
  for (const trigger of own) {
    const window = getRecoveryWindow(trigger);
    if (!window) continue;
    const hours = trigger.sleepRecovery?.recoveryHours ?? 0;
    for (const other of own) {
      if (other.id === trigger.id) continue;
      // HC-15 (D18): work of the SAME original occurrence never
      // recovery-flags itself — same split slot (`splitGroupId`) or different
      // slots of the same occurrence (`splitOccurrenceId`, a legitimate
      // continuous run). Inert when no task is split.
      if (other.splitGroupId !== undefined && other.splitGroupId === trigger.splitGroupId) continue;
      if (other.splitOccurrenceId !== undefined && other.splitOccurrenceId === trigger.splitOccurrenceId) continue;
      if (!hasLoadDuringOverlap(other, window)) continue;
      const pairKey = trigger.id < other.id ? `${trigger.id}|${other.id}` : `${other.id}|${trigger.id}`;
      if (reported.has(pairKey)) continue;
      reported.add(pairKey);
      violations.push(
        violation(
          'SLEEP_RECOVERY_VIOLATION',
          `${displayName} ‏— "${describeTaskBidi(other)}" נופל בחלון ההתאוששות של ${hours} שעות אחרי "${describeTaskBidi(trigger)}"`,
          other.id,
          participantId,
        ),
      );
    }
  }

  return violations;
}
