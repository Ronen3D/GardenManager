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
  SlotRequirement,
  ValidationResult,
  ConstraintViolation,
  ViolationSeverity,
  SwapRequest,
} from '../models/types';
import { validateHardConstraints, isLevelSatisfied } from '../constraints/hard-constraints';
import { collectSoftWarnings } from '../constraints/soft-constraints';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
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
  disabledHC?: Set<string>,
  disabledSW?: Set<string>,
): FullValidationResult {
  const hard = validateHardConstraints(tasks, participants, assignments, disabledHC);
  const warnings = collectSoftWarnings(tasks, participants, assignments, disabledSW);

  const hardCount = hard.violations.length;
  const warnCount = warnings.length;

  let summary: string;
  if (hardCount === 0 && warnCount === 0) {
    summary = 'השבצ"ק תקין ללא בעיות.';
  } else if (hardCount === 0) {
    summary = `השבצ"ק תקין אך יש ${warnCount} אזהרה/ות.`;
  } else {
    summary = `שבצ"ק לא תקין: ${hardCount} הפרת אילוץ קשיח, ${warnCount} אזהרה/ות.`;
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
 * R4: Shared eligibility check — single source of truth for whether a
 * participant can fill a specific slot. Used by both the optimizer
 * (greedy construction) and the validator (UI dropdown population).
 *
 * @param participant  The candidate participant
 * @param task         The target task
 * @param slot         The specific slot within the task
 * @param participantAssignments  Current assignments for this participant (excluding `task` itself)
 * @param taskMap      Map of all tasks by ID
 * @param opts         Optional flags / extra data for context-specific behaviour
 */
export function isEligible(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  opts?: {
    /** When true, check sameGroupRequired against existing assignments */
    checkSameGroup?: boolean;
    /** All assignments for the task (needed for same-group check) */
    taskAssignments?: Assignment[];
    /** Participant lookup (needed for same-group comparison) */
    participantMap?: Map<string, Participant>;
    /** Hard constraints that are disabled (skip those checks) */
    disabledHC?: Set<string>;
  },
): boolean {
  const disabled = opts?.disabledHC;

  // HC-13: Senior hard blocks (L4 non-natural/non-Hamama, L3 Mamtera)
  if (!disabled?.has('HC-13') && checkSeniorHardBlock(participant, task, slot)) return false;

  // HC-11: Choresh exclusion from Mamtera
  if (!disabled?.has('HC-11') && participant.certifications.includes(Certification.Horesh) && task.type === TaskType.Mamtera) return false;

  // HC-1: Level check — single source of truth in isLevelSatisfied()
  if (!disabled?.has('HC-1') && !isLevelSatisfied(participant.level, slot)) return false;

  // HC-2: Certification check
  if (!disabled?.has('HC-2')) {
    for (const cert of slot.requiredCertifications) {
      if (!participant.certifications.includes(cert)) return false;
    }
  }

  // HC-3: Availability check
  if (!disabled?.has('HC-3') && !isFullyCovered(task.timeBlock, participant.availability)) return false;

  // HC-4: Same-group check (optional — only validator uses this inline)
  if (!disabled?.has('HC-4') && opts?.checkSameGroup && task.sameGroupRequired && opts.taskAssignments && opts.participantMap) {
    const otherAssignments = opts.taskAssignments.filter(a => a.slotId !== slot.slotId);
    for (const oa of otherAssignments) {
      const existingP = opts.participantMap.get(oa.participantId);
      if (existingP && existingP.group !== participant.group) return false;
    }
  }

  // HC-5: Double-booking — physical presence is exclusive for ALL tasks (including light)
  if (!disabled?.has('HC-5')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (otherTask && blocksOverlap(task.timeBlock, otherTask.timeBlock)) return false;
    }
  }

  // HC-7: Not already assigned to this task
  if (!disabled?.has('HC-7') && participantAssignments.some(a => a.taskId === task.id)) return false;

  // HC-12: No consecutive blocking tasks
  if (!disabled?.has('HC-12')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask) continue;
      if (otherTask.timeBlock.end.getTime() === task.timeBlock.start.getTime()) {
        if (otherTask.blocksConsecutive && task.blocksConsecutive) return false;
      }
      if (task.timeBlock.end.getTime() === otherTask.timeBlock.start.getTime()) {
        if (task.blocksConsecutive && otherTask.blocksConsecutive) return false;
      }
    }
  }

  return true;
}

// ─── R8: Rejection Reason Codes ──────────────────────────────────────────────

/** Constraint code identifying why a participant was rejected for a slot. */
export type RejectionCode =
  | 'HC-1'   // Level mismatch
  | 'HC-2'   // Missing certification
  | 'HC-3'   // Availability gap
  | 'HC-4'   // Same-group conflict
  | 'HC-5'   // Double-booking
  | 'HC-7'   // Already assigned to this task
  | 'HC-11'  // Choresh exclusion from Mamtera
  | 'HC-12'  // Consecutive high-load tasks
  | 'HC-13'; // Senior hard block

/**
 * R8: Same logic as isEligible() but returns the specific constraint code
 * that caused rejection (or null if eligible). Useful for diagnostic
 * messages when slots are left unfilled.
 */
export function getRejectionReason(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  opts?: {
    /** When true, check sameGroupRequired against existing assignments */
    checkSameGroup?: boolean;
    /** All assignments for the task (needed for same-group check) */
    taskAssignments?: Assignment[];
    /** Participant lookup (needed for same-group comparison) */
    participantMap?: Map<string, Participant>;
    /** Hard constraints that are disabled (skip those checks) */
    disabledHC?: Set<string>;
  },
): RejectionCode | null {
  const disabled = opts?.disabledHC;
  if (!disabled?.has('HC-13') && checkSeniorHardBlock(participant, task, slot)) return 'HC-13';
  if (!disabled?.has('HC-11') && participant.certifications.includes(Certification.Horesh) && task.type === TaskType.Mamtera) return 'HC-11';
  if (!disabled?.has('HC-1') && !isLevelSatisfied(participant.level, slot)) return 'HC-1';
  if (!disabled?.has('HC-2')) {
    for (const cert of slot.requiredCertifications) {
      if (!participant.certifications.includes(cert)) return 'HC-2';
    }
  }
  if (!disabled?.has('HC-3') && !isFullyCovered(task.timeBlock, participant.availability)) return 'HC-3';
  // HC-4: Same-group check — mirrors isEligible() logic
  if (!disabled?.has('HC-4') && opts?.checkSameGroup && task.sameGroupRequired && opts.taskAssignments && opts.participantMap) {
    const otherAssignments = opts.taskAssignments.filter(a => a.slotId !== slot.slotId);
    for (const oa of otherAssignments) {
      const existingP = opts.participantMap.get(oa.participantId);
      if (existingP && existingP.group !== participant.group) return 'HC-4';
    }
  }
  if (!disabled?.has('HC-5')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (otherTask && blocksOverlap(task.timeBlock, otherTask.timeBlock)) return 'HC-5';
    }
  }
  if (!disabled?.has('HC-7') && participantAssignments.some(a => a.taskId === task.id)) return 'HC-7';
  if (!disabled?.has('HC-12')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask) continue;
      if (otherTask.timeBlock.end.getTime() === task.timeBlock.start.getTime()) {
        if (otherTask.blocksConsecutive && task.blocksConsecutive) return 'HC-12';
      }
      if (task.timeBlock.end.getTime() === otherTask.timeBlock.start.getTime()) {
        if (task.blocksConsecutive && otherTask.blocksConsecutive) return 'HC-12';
      }
    }
  }
  return null;
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
  disabledHC?: Set<string>,
): Participant[] {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  const taskAssignments = currentAssignments.filter(a => a.taskId === task.id);

  return participants.filter((p) => {
    // Build participant's assignments excluding this task
    const pAssignments = currentAssignments.filter(
      (a) => a.participantId === p.id && a.taskId !== task.id,
    );
    return isEligible(p, task, slot, pAssignments, taskMap, {
      checkSameGroup: true,
      taskAssignments,
      participantMap: pMap,
      disabledHC,
    });
  });
}
