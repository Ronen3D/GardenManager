/**
 * Validator - Standalone validation module for real-time constraint checking.
 *
 * Used after every manual override to verify schedule integrity.
 */

import {
  Task,
  Assignment,
  Participant,
  TaskType,
  Certification,
  ValidationResult,
  ConstraintViolation,
  ViolationSeverity,
  SwapRequest,
} from '../models/types';
import { validateHardConstraints } from '../constraints/hard-constraints';
import { collectSoftWarnings } from '../constraints/soft-constraints';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { isHighLoadAtBoundary } from '../web/utils/load-weighting';
import { checkSeniorHardBlock } from '../constraints/senior-policy';

export interface FullValidationResult extends ValidationResult {
  /** Soft constraint warnings (non-fatal) */
  warnings: ConstraintViolation[];
  /** Summary for UI display */
  summary: string;
}

/**
 * Run a full validation (hard + soft) on a schedule.
 */
export function fullValidate(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
): FullValidationResult {
  const hard = validateHardConstraints(tasks, participants, assignments);
  const warnings = collectSoftWarnings(tasks, participants, assignments);

  const hardCount = hard.violations.length;
  const warnCount = warnings.length;

  let summary: string;
  if (hardCount === 0 && warnCount === 0) {
    summary = 'Schedule is valid with no issues.';
  } else if (hardCount === 0) {
    summary = `Schedule is valid but has ${warnCount} warning(s).`;
  } else {
    summary = `INVALID SCHEDULE: ${hardCount} hard constraint violation(s), ${warnCount} warning(s).`;
  }

  return {
    valid: hard.valid,
    violations: hard.violations,
    warnings,
    summary,
  };
}

/**
 * Preview a swap without committing it — returns what violations would occur.
 */
export function previewSwap(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  swap: SwapRequest,
): FullValidationResult {
  // Create a temporary copy with the swap applied
  const tempAssignments = assignments.map((a) => {
    if (a.id === swap.assignmentId) {
      return { ...a, participantId: swap.newParticipantId };
    }
    return { ...a };
  });

  return fullValidate(tasks, participants, tempAssignments);
}

/**
 * Identify which participants could validly fill a specific slot.
 * Useful for UI dropdown population.
 */
export function getEligibleParticipantsForSlot(
  task: Task,
  slotId: string,
  participants: Participant[],
  currentAssignments: Assignment[],
  tasks: Task[],
): Participant[] {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  return participants.filter((p) => {
    // Level check
    if (!slot.acceptableLevels.includes(p.level)) return false;

    // Certification check
    for (const cert of slot.requiredCertifications) {
      if (!p.certifications.includes(cert)) return false;
    }

    // Availability check
    if (!isFullyCovered(task.timeBlock, p.availability)) return false;

    // Same-group check for Adanit
    if (task.sameGroupRequired) {
      const existingAssignments = currentAssignments.filter(
        (a) => a.taskId === task.id && a.slotId !== slotId,
      );
      if (existingAssignments.length > 0) {
        const existingParticipant = participants.find(
          (pp) => pp.id === existingAssignments[0].participantId,
        );
        if (existingParticipant && existingParticipant.group !== p.group) return false;
      }
    }

    // Double-booking check: physical presence is exclusive for ALL tasks (including light)
    const participantAssignments = currentAssignments.filter(
      (a) => a.participantId === p.id && a.taskId !== task.id,
    );
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (otherTask && blocksOverlap(task.timeBlock, otherTask.timeBlock)) return false;
    }

    // Not already assigned to this task
    if (currentAssignments.some((a) => a.taskId === task.id && a.participantId === p.id)) {
      return false;
    }

    // HC-11: Choresh exclusion from Mamtera
    if (p.certifications.includes(Certification.Horesh) && task.type === TaskType.Mamtera) return false;

    // HC-13: Senior hard blocks
    if (slot && checkSeniorHardBlock(p, task, slot)) return false;

    // HC-12: No consecutive high-load tasks
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask) continue;
      if (otherTask.timeBlock.end.getTime() === task.timeBlock.start.getTime()) {
        if (isHighLoadAtBoundary(otherTask, 'end') && isHighLoadAtBoundary(task, 'start')) return false;
      }
      if (task.timeBlock.end.getTime() === otherTask.timeBlock.start.getTime()) {
        if (isHighLoadAtBoundary(task, 'end') && isHighLoadAtBoundary(otherTask, 'start')) return false;
      }
    }

    return true;
  });
}
