/**
 * Validator - Standalone validation module for real-time constraint checking.
 *
 * Used after every manual override to verify schedule integrity.
 */

import {
  Task,
  Assignment,
  Participant,
  SlotRequirement,
  ValidationResult,
  ConstraintViolation,
  ViolationSeverity,
  SwapRequest,
  Level,
  Certification,
  TaskTemplate,
  SlotTemplate,
  SubTeamRole,
} from '../models/types';
import { validateHardConstraints, isLevelSatisfied, effectivelyBlocksAt, CATEGORY_BREAK_MS } from '../constraints/hard-constraints';
import { collectSoftWarnings } from '../constraints/soft-constraints';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { checkSeniorHardBlock } from '../constraints/senior-policy';
import { isAcceptedLevel, isLowPriority } from '../models/level-utils';

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
  categoryBreakMs?: number,
): FullValidationResult {
  const hard = validateHardConstraints(tasks, participants, assignments, disabledHC, categoryBreakMs);
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
  categoryBreakMs?: number,
): FullValidationResult {
  // Create a temporary copy with the swap applied
  const tempAssignments = assignments.map((a) => {
    if (a.id === swap.assignmentId) {
      return { ...a, participantId: swap.newParticipantId };
    }
    return { ...a };
  });

  return fullValidate(tasks, participants, tempAssignments, undefined, categoryBreakMs);
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
  | 'HC-11'  // Forbidden certification (per-slot)
  | 'HC-12'  // Consecutive high-load tasks
  | 'HC-13'  // Senior hard block
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
  /** HC-14 category break threshold in ms (defaults to CATEGORY_BREAK_MS) */
  categoryBreakMs?: number;
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

  // HC-13: Senior hard blocks (L4 non-natural/non-Hamama, L3 Mamtera)
  if (!disabled?.has('HC-13') && checkSeniorHardBlock(participant, task, slot)) return 'HC-13';

  // HC-11: Forbidden certification check (per-slot)
  if (!disabled?.has('HC-11') && slot.forbiddenCertifications?.some(c => participant.certifications.includes(c))) return 'HC-11';

  // HC-1: Level check — single source of truth in isLevelSatisfied()
  if (!disabled?.has('HC-1') && !isLevelSatisfied(participant.level, slot)) return 'HC-1';

  // HC-2: Certification check
  if (!disabled?.has('HC-2')) {
    for (const cert of slot.requiredCertifications) {
      if (!participant.certifications.includes(cert)) return 'HC-2';
    }
  }

  // HC-3: Availability check
  if (!disabled?.has('HC-3') && !isFullyCovered(task.timeBlock, participant.availability)) return 'HC-3';

  // HC-4: Same-group check (optional — only validator uses this inline)
  if (!disabled?.has('HC-4') && opts?.checkSameGroup && task.sameGroupRequired && opts.taskAssignments && opts.participantMap) {
    const otherAssignments = opts.taskAssignments.filter(a => a.slotId !== slot.slotId);
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
  if (!disabled?.has('HC-7') && participantAssignments.some(a => a.taskId === task.id)) return 'HC-7';

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

  // HC-14: Category break — minimum gap between category-flagged tasks
  // Note: for overlapping tasks, gap is negative so HC-14 fires,
  // but HC-5 (double-booking) is checked first and rejects before reaching here.
  if (!disabled?.has('HC-14') && task.requiresCategoryBreak) {
    const breakMs = opts?.categoryBreakMs ?? CATEGORY_BREAK_MS;
    const taskStart = task.timeBlock.start.getTime();
    const taskEnd = task.timeBlock.end.getTime();
    for (const a of participantAssignments) {
      const otherTask = taskMap.get(a.taskId);
      if (!otherTask?.requiresCategoryBreak) continue;
      const gap = Math.max(
        taskStart - otherTask.timeBlock.end.getTime(),
        otherTask.timeBlock.start.getTime() - taskEnd,
      );
      if (gap < breakMs) return 'HC-14';
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
  categoryBreakMs?: number,
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
      categoryBreakMs,
    });
  });
}

// ─── Template-level eligibility (static checks, no runtime context) ─────────

export interface TemplateEligibilityResult {
  eligible: boolean;
  /** Hebrew human-readable reasons (empty when eligible) */
  reasons: string[];
}

/**
 * HC-13 check adapted for SlotTemplate (same shape as SlotRequirement for
 * the fields we need: subTeamRole, acceptableLevels).
 * Returns true when the senior is BLOCKED from this slot.
 */
function isSeniorBlockedForTemplateSlot(level: Level, slot: SlotTemplate): boolean {
  if (level === Level.L0) return false;
  // Low-priority levels are allowed (with soft penalty) — not blocked
  if (isLowPriority(slot.acceptableLevels, level)) return false;
  // Inline isNaturalRole logic (mirrors senior-policy.ts, _task param unused)
  if (slot.subTeamRole != null) {
    if (level === Level.L4 || level === Level.L3) {
      return slot.subTeamRole !== SubTeamRole.SegolMain;
    }
    if (level === Level.L2) {
      return slot.subTeamRole !== SubTeamRole.SegolSecondary;
    }
    return true;
  }
  if (isLowPriority(slot.acceptableLevels, level)) return true;
  return !isAcceptedLevel(slot.acceptableLevels, level);
}

const CERT_LABELS_HE: Record<string, string> = {
  Nitzan: 'ניצן', Salsala: 'סלסלה', Hamama: 'חממה', Horesh: 'חורש',
};

/**
 * Check whether a participant (by level + certifications) can fill ANY slot
 * in a task template. Only static constraints are checked (HC-1, HC-2, HC-11, HC-13).
 *
 * Used by the preference-selection UI to warn when a preference can never be satisfied.
 */
export function checkTemplateEligibility(
  level: Level,
  certifications: Certification[],
  template: TaskTemplate,
): TemplateEligibilityResult {
  // Collect all slots: top-level + sub-team slots
  const allSlots: SlotTemplate[] = [
    ...template.slots,
    ...template.subTeams.flatMap(st => st.slots),
  ];

  if (allSlots.length === 0) return { eligible: true, reasons: [] };

  // Track which constraint codes blocked across ALL slots
  const blockedBy = new Set<string>();

  for (const slot of allSlots) {
    // HC-13: Senior hard block
    if (isSeniorBlockedForTemplateSlot(level, slot)) { blockedBy.add('HC-13'); continue; }
    // HC-11: Forbidden certifications
    if (slot.forbiddenCertifications?.some(c => certifications.includes(c))) { blockedBy.add('HC-11'); continue; }
    // HC-1: Level check (reuse existing isLevelSatisfied — works with SlotTemplate since it has acceptableLevels)
    if (!isLevelSatisfied(level, slot as unknown as SlotRequirement)) { blockedBy.add('HC-1'); continue; }
    // HC-2: Required certifications
    if (slot.requiredCertifications.some(c => !certifications.includes(c))) { blockedBy.add('HC-2'); continue; }
    // Passed all checks — eligible for this slot
    return { eligible: true, reasons: [] };
  }

  // No slot passed — build human-readable reasons
  const reasons: string[] = [];
  if (blockedBy.has('HC-13')) {
    reasons.push(`סגל בדרגה L${level} לא יכול להשתבץ למשימה הזו (מחוץ לתחום הטבעי)`);
  }
  if (blockedBy.has('HC-1')) {
    reasons.push(`הדרגה (L${level}) לא מתאימה לאף משבצת במשימה הזו`);
  }
  if (blockedBy.has('HC-2')) {
    // Find which certs are required across slots but the participant lacks
    const missingCerts = new Set<Certification>();
    for (const slot of allSlots) {
      for (const c of slot.requiredCertifications) {
        if (!certifications.includes(c)) missingCerts.add(c);
      }
    }
    const names = [...missingCerts].map(c => CERT_LABELS_HE[c] || c).join(', ');
    reasons.push(`חסרה הסמכה נדרשת (${names}) לכל המשבצות במשימה הזו`);
  }
  if (blockedBy.has('HC-11')) {
    const forbidden = new Set<Certification>();
    for (const slot of allSlots) {
      for (const c of slot.forbiddenCertifications || []) {
        if (certifications.includes(c)) forbidden.add(c);
      }
    }
    const names = [...forbidden].map(c => CERT_LABELS_HE[c] || c).join(', ');
    reasons.push(`יש לך הסמכה אסורה (${names}) במשימה הזו`);
  }

  return { eligible: false, reasons };
}
