/**
 * Validator - Standalone validation module for real-time constraint checking.
 *
 * Used after every manual override to verify schedule integrity.
 */

import { effectivelyBlocksAt, isLevelSatisfied, validateHardConstraints } from '../constraints/hard-constraints';
import { collectSoftWarnings } from '../constraints/soft-constraints';
import {
  type Assignment,
  type ConstraintViolation,
  type Level,
  type Participant,
  type SlotRequirement,
  type SlotTemplate,
  type SwapRequest,
  type Task,
  type TaskTemplate,
  type ValidationResult,
  ViolationSeverity,
} from '../models/types';
import { blocksOverlap, isBlockedByDateUnavailability, isFullyCovered } from '../web/utils/time-utils';

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
  restRuleMap?: Map<string, number>,
  certLabelResolver?: (certId: string) => string,
): FullValidationResult {
  const hard = validateHardConstraints(tasks, participants, assignments, disabledHC, restRuleMap, certLabelResolver);
  const warnings = collectSoftWarnings(tasks, participants, assignments);

  const hardCount = hard.violations.length;
  const warnCount = warnings.length;

  let summary: string;
  if (hardCount === 0 && warnCount === 0) {
    summary = 'השבצ"ק תקין ללא בעיות.';
  } else if (hardCount === 0) {
    summary = `השיבוץ תקין, אבל יש בו ${warnCount} אזהרות.`;
  } else {
    summary = `השיבוץ לא תקין: ${hardCount} הפרות של אילוצים קשיחים ו-${warnCount} אזהרות.`;
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
  restRuleMap?: Map<string, number>,
  certLabelResolver?: (certId: string) => string,
): FullValidationResult {
  // Create a temporary copy with the swap applied
  const tempAssignments = assignments.map((a) => {
    if (a.id === swap.assignmentId) {
      return { ...a, participantId: swap.newParticipantId };
    }
    return { ...a };
  });

  return fullValidate(tasks, participants, tempAssignments, undefined, restRuleMap, certLabelResolver);
}

// ─── R8: Rejection Reason Codes ──────────────────────────────────────────────

/** Constraint code identifying why a participant was rejected for a slot. */
export type RejectionCode =
  | 'HC-1' // Level mismatch
  | 'HC-2' // Missing certification
  | 'HC-3' // Availability gap
  | 'HC-4' // Same-group conflict
  | 'HC-5' // Double-booking
  | 'HC-7' // Already assigned to this task
  | 'HC-11' // Forbidden certification (per-slot)
  | 'HC-12' // Consecutive high-load tasks
  | 'HC-14'; // Category break (5h minimum)

/** Optional context for eligibility / rejection checks. */
export interface EligibilityOpts {
  /** When true, check sameGroupRequired against existing assignments */
  checkSameGroup?: boolean;
  /** All assignments for the task (needed for same-group check) */
  taskAssignments?: Assignment[];
  /** Participant lookup (needed for same-group comparison) */
  participantMap?: Map<string, Participant>;
  /** Hard constraints that are disabled (skip those checks) */
  disabledHC?: Set<string>;
  /** HC-14 rest rule map: ruleId → durationMs */
  restRuleMap?: Map<string, number>;
  /**
   * Extra schedule-scoped unavailability windows, layered on top of
   * participant master availability. Drives the Future SOS flow: the
   * affected participant is rejected from any task whose timeBlock
   * overlaps one of their entries. Checked alongside HC-3.
   */
  extraUnavailability?: Array<{ participantId: string; start: Date; end: Date }>;
}

/**
 * Core eligibility check — single source of truth for constraint validation.
 *
 * Returns the `RejectionCode` of the first violated hard constraint, or
 * `null` when the participant is eligible. Both `isEligible()` and
 * `getRejectionReason()` delegate to this implementation, eliminating the
 * previous ~60 lines of duplicated logic.
 *
 * @param participant  The candidate participant
 * @param task         The target task
 * @param slot         The specific slot within the task
 * @param participantAssignments  Current assignments for this participant
 * @param taskMap      Map of all tasks by ID
 * @param opts         Optional flags / extra data for context-specific behaviour
 */
function checkEligibility(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  opts?: EligibilityOpts,
): RejectionCode | null {
  const disabled = opts?.disabledHC;

  // HC-11: Forbidden certification check (per-slot)
  if (!disabled?.has('HC-11') && slot.forbiddenCertifications?.some((c) => participant.certifications.includes(c)))
    return 'HC-11';

  // HC-1: Level check — single source of truth in isLevelSatisfied()
  if (!disabled?.has('HC-1') && !isLevelSatisfied(participant.level, slot)) return 'HC-1';

  // HC-2: Certification check
  if (!disabled?.has('HC-2')) {
    for (const cert of slot.requiredCertifications) {
      if (!participant.certifications.includes(cert)) return 'HC-2';
    }
  }

  // HC-3: Availability check (windows + recurring dateUnavailability rules
  //       + schedule-scoped Future SOS windows).
  if (!disabled?.has('HC-3')) {
    if (
      !isFullyCovered(task.timeBlock, participant.availability) ||
      isBlockedByDateUnavailability(task.timeBlock, participant.dateUnavailability)
    )
      return 'HC-3';
    if (opts?.extraUnavailability) {
      for (const u of opts.extraUnavailability) {
        if (u.participantId !== participant.id) continue;
        if (blocksOverlap(task.timeBlock, { start: u.start, end: u.end })) return 'HC-3';
      }
    }
  }

  // HC-4: Same-group check (optional — only validator uses this inline)
  if (
    !disabled?.has('HC-4') &&
    opts?.checkSameGroup &&
    task.sameGroupRequired &&
    opts.taskAssignments &&
    opts.participantMap
  ) {
    const otherAssignments = opts.taskAssignments.filter((a) => a.slotId !== slot.slotId);
    for (const oa of otherAssignments) {
      const existingP = opts.participantMap.get(oa.participantId);
      if (existingP && existingP.group !== participant.group) return 'HC-4';
    }
  }

  // HC-5: Double-booking — physical presence is exclusive for ALL tasks (including light)
  if (!disabled?.has('HC-5')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (otherTask && blocksOverlap(task.timeBlock, otherTask.timeBlock)) return 'HC-5';
    }
  }

  // HC-7: Not already assigned to this task
  if (!disabled?.has('HC-7') && participantAssignments.some((a) => a.taskId === task.id)) return 'HC-7';

  // HC-12: No consecutive blocking tasks
  if (!disabled?.has('HC-12')) {
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask) continue;
      if (otherTask.timeBlock.end.getTime() === task.timeBlock.start.getTime()) {
        if (effectivelyBlocksAt(otherTask, 'end') && effectivelyBlocksAt(task, 'start')) return 'HC-12';
      }
      if (task.timeBlock.end.getTime() === otherTask.timeBlock.start.getTime()) {
        if (effectivelyBlocksAt(task, 'end') && effectivelyBlocksAt(otherTask, 'start')) return 'HC-12';
      }
    }
  }

  // HC-14: Rest rules — minimum gap between rest-rule-tagged tasks
  // Note: for overlapping tasks, gap is negative so HC-14 fires,
  // but HC-5 (double-booking) is checked first and rejects before reaching here.
  if (!disabled?.has('HC-14') && task.restRuleId && opts?.restRuleMap?.has(task.restRuleId)) {
    const ruleMap = opts.restRuleMap;
    const taskDuration = ruleMap.get(task.restRuleId)!;
    const taskStart = task.timeBlock.start.getTime();
    const taskEnd = task.timeBlock.end.getTime();
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask?.restRuleId || !ruleMap.has(otherTask.restRuleId)) continue;
      // Same rule → that rule's duration; different rules → min of both
      const threshold =
        otherTask.restRuleId === task.restRuleId
          ? taskDuration
          : Math.min(taskDuration, ruleMap.get(otherTask.restRuleId)!);
      const gap = Math.max(
        taskStart - otherTask.timeBlock.end.getTime(),
        otherTask.timeBlock.start.getTime() - taskEnd,
      );
      if (gap < threshold) return 'HC-14';
    }
  }

  return null;
}

/**
 * R4: Boolean eligibility check — thin wrapper over `checkEligibility()`.
 * Returns `true` when the participant can fill the slot.
 */
export function isEligible(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  opts?: EligibilityOpts,
): boolean {
  return checkEligibility(participant, task, slot, participantAssignments, taskMap, opts) === null;
}

/**
 * R8: Returns the specific constraint code that caused rejection,
 * or `null` if the participant is eligible. Useful for diagnostic
 * messages when slots are left unfilled.
 */
export function getRejectionReason(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  opts?: EligibilityOpts,
): RejectionCode | null {
  return checkEligibility(participant, task, slot, participantAssignments, taskMap, opts);
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
  restRuleMap?: Map<string, number>,
  extraUnavailability?: Array<{ participantId: string; start: Date; end: Date }>,
): Participant[] {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  const taskAssignments = currentAssignments.filter((a) => a.taskId === task.id);

  return participants.filter((p) => {
    // Build participant's assignments excluding ONLY the current slot (not
    // the whole task). If the participant is already sitting in a DIFFERENT
    // slot of the same task, HC-5/HC-7 must still fire against that
    // assignment — otherwise we'd falsely mark them eligible for this slot.
    const pAssignments = currentAssignments.filter(
      (a) => a.participantId === p.id && !(a.taskId === task.id && a.slotId === slotId),
    );
    return isEligible(p, task, slot, pAssignments, taskMap, {
      checkSameGroup: true,
      taskAssignments,
      participantMap: pMap,
      disabledHC,
      restRuleMap,
      extraUnavailability,
    });
  });
}

/**
 * Hebrew user-facing explanation for each rejection code.
 *
 * Lives in the engine layer (a static string table is not DOM or storage)
 * so validator helpers can return pre-formatted reasons without the web
 * layer duplicating the mapping.
 */
export const REJECTION_REASONS_HE: Record<RejectionCode, string> = {
  'HC-1': 'הדרגה לא מתאימה למשבצת הזו',
  'HC-2': 'חסרה הסמכה נדרשת',
  'HC-3': 'המשתתף לא זמין בשעות המשימה',
  'HC-4': 'המשתתפים חייבים להיות מאותה קבוצה',
  'HC-5': 'המשתתף כבר משובץ במשימה חופפת',
  'HC-7': 'המשתתף כבר משובץ במשימה הזו',
  'HC-11': 'למשתתף הסמכה אסורה למשבצת הזו',
  'HC-12': 'לא ניתן לשבץ למשימות כבדות רצופות',
  'HC-14': 'נדרשת הפסקה של 5 שעות לפחות ממשימת קטגוריה',
};

/** Candidate row for the post-generation swap picker. */
export interface CandidateEligibility {
  participant: Participant;
  eligible: boolean;
  rejectionCode: RejectionCode | null;
  reason: string | null;
}

/**
 * Like `getEligibleParticipantsForSlot` but returns EVERY participant with
 * an `eligible` flag and the specific rejection reason for the ones that
 * cannot fill the slot. Used by the swap picker to surface diagnostics
 * (gap 9: empty-eligible fallback).
 */
export function getCandidatesWithEligibility(
  task: Task,
  slotId: string,
  participants: Participant[],
  currentAssignments: Assignment[],
  tasks: Task[],
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  extraUnavailability?: Array<{ participantId: string; start: Date; end: Date }>,
): CandidateEligibility[] {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  const taskAssignments = currentAssignments.filter((a) => a.taskId === task.id);

  return participants.map((p) => {
    // See note in getEligibleParticipantsForSlot: exclude only the CURRENT
    // slot, not the whole task, so that a participant already assigned to
    // another slot of the same task is correctly flagged as ineligible.
    const pAssignments = currentAssignments.filter(
      (a) => a.participantId === p.id && !(a.taskId === task.id && a.slotId === slotId),
    );
    const code = checkEligibility(p, task, slot, pAssignments, taskMap, {
      checkSameGroup: true,
      taskAssignments,
      participantMap: pMap,
      disabledHC,
      restRuleMap,
      extraUnavailability,
    });
    return {
      participant: p,
      eligible: code === null,
      rejectionCode: code,
      reason: code ? REJECTION_REASONS_HE[code] : null,
    };
  });
}

// ─── Template-level eligibility (static checks, no runtime context) ─────────

export interface TemplateEligibilityResult {
  eligible: boolean;
  /** Hebrew human-readable reasons (empty when eligible) */
  reasons: string[];
}

/**
 * Check whether a participant (by level + certifications) can fill ANY slot
 * in a task template. Only static constraints are checked (HC-1, HC-2, HC-11).
 *
 * Used by the preference-selection UI to warn when a preference can never be satisfied.
 * @param labelResolver optional function to map cert ID → display label (defaults to identity)
 */
export function checkTemplateEligibility(
  level: Level,
  certifications: string[],
  template: TaskTemplate,
  labelResolver: (certId: string) => string = (id) => id,
): TemplateEligibilityResult {
  // Collect all slots: top-level + sub-team slots
  const allSlots: SlotTemplate[] = [...template.slots, ...template.subTeams.flatMap((st) => st.slots)];

  if (allSlots.length === 0) return { eligible: true, reasons: [] };

  // Track which constraint codes blocked across ALL slots
  const blockedBy = new Set<string>();

  for (const slot of allSlots) {
    // HC-11: Forbidden certifications
    if (slot.forbiddenCertifications?.some((c) => certifications.includes(c))) {
      blockedBy.add('HC-11');
      continue;
    }
    // HC-1: Level check (reuse existing isLevelSatisfied — works with SlotTemplate since it has acceptableLevels)
    if (!isLevelSatisfied(level, slot as unknown as SlotRequirement)) {
      blockedBy.add('HC-1');
      continue;
    }
    // HC-2: Required certifications
    if (slot.requiredCertifications.some((c) => !certifications.includes(c))) {
      blockedBy.add('HC-2');
      continue;
    }
    // Passed all checks — eligible for this slot
    return { eligible: true, reasons: [] };
  }

  // No slot passed — build human-readable reasons
  const reasons: string[] = [];
  if (blockedBy.has('HC-1')) {
    reasons.push(`הדרגה (L${level}) לא מתאימה לאף משבצת במשימה הזו`);
  }
  if (blockedBy.has('HC-2')) {
    const missingCerts = new Set<string>();
    for (const slot of allSlots) {
      for (const c of slot.requiredCertifications) {
        if (!certifications.includes(c)) missingCerts.add(c);
      }
    }
    const names = [...missingCerts].map((c) => labelResolver(c)).join(', ');
    reasons.push(`חסרה הסמכה נדרשת (${names}) לכל המשבצות במשימה הזו`);
  }
  if (blockedBy.has('HC-11')) {
    const forbidden = new Set<string>();
    for (const slot of allSlots) {
      for (const c of slot.forbiddenCertifications || []) {
        if (certifications.includes(c)) forbidden.add(c);
      }
    }
    const names = [...forbidden].map((c) => labelResolver(c)).join(', ');
    reasons.push(`יש לך הסמכה אסורה (${names}) במשימה הזו`);
  }

  return { eligible: false, reasons };
}
