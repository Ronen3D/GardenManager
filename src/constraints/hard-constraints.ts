/**
 * Hard Constraint Validators
 *
 * If any hard constraint is violated, the schedule is INVALID.
 * Returns ConstraintViolation[] with severity=Error.
 */

import {
  type Assignment,
  type ConstraintViolation,
  type Level,
  type Participant,
  type SlotRequirement,
  type Task,
  type ValidationResult,
  ViolationSeverity,
} from '../models/types';
import { isTimeInsideWindow } from '../shared/utils/load-weighting';
import {
  blocksOverlap,
  isBlockedByDateUnavailability,
  isFullyCovered,
  type ScheduleContext,
} from '../shared/utils/time-utils';
import { describeTaskBidi, describeTaskInstance } from '../utils/date-utils';
import { findMaxMatching, type SlotCandidates } from './group-matching';
import { checkSleepRecovery } from './sleep-recovery';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildParticipantMap(participants: Participant[]): Map<string, Participant> {
  const map = new Map<string, Participant>();
  for (const p of participants) map.set(p.id, p);
  return map;
}

function buildTaskMap(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) map.set(t.id, t);
  return map;
}

/** Snapshot-scoped capability override entry (mirrors EligibilityOpts shape). */
export type CapabilityLossOverride = {
  participantId: string;
  lostCertifications: string[];
  start: Date;
  end: Date;
};

/**
 * Build an `effective certifications` predicate for a participant evaluated at
 * a specific task's timeBlock, with `extraCapabilityLoss` subtracted when any
 * entry overlaps. Zero-allocation pass-through when no losses apply.
 */
function effectiveCertsAt(
  participant: Participant,
  task: Task,
  losses: CapabilityLossOverride[] | undefined,
): { has: (cert: string) => boolean } {
  if (!losses || losses.length === 0) {
    return { has: (c) => participant.certifications.includes(c) };
  }
  let lost: Set<string> | null = null;
  for (const loss of losses) {
    if (loss.participantId !== participant.id) continue;
    if (!blocksOverlap(task.timeBlock, { start: loss.start, end: loss.end })) continue;
    if (!lost) lost = new Set();
    for (const c of loss.lostCertifications) lost.add(c);
  }
  if (!lost) {
    return { has: (c) => participant.certifications.includes(c) };
  }
  const lostFinal = lost;
  return { has: (c) => participant.certifications.includes(c) && !lostFinal.has(c) };
}

function violation(
  code: string,
  message: string,
  taskId: string,
  slotId?: string,
  participantId?: string,
): ConstraintViolation {
  return { severity: ViolationSeverity.Error, code, message, taskId, slotId, participantId };
}

// ─── Individual Constraint Checks ────────────────────────────────────────────

/**
 * HC-1 pure boolean check: does the participant's level satisfy the slot's
 * acceptableLevels list?
 *
 * A level is satisfied if and only if it appears in the slot's
 * acceptableLevels array (regardless of the lowPriority flag).
 * acceptableLevels is the single source of truth for level eligibility.
 */
export function isLevelSatisfied(level: Level, slot: SlotRequirement): boolean {
  return slot.acceptableLevels.some((e) => e.level === level);
}

/**
 * HC-1: Level requirement — participant's level must match slot's acceptableLevels.
 */
export function checkLevelRequirement(
  participant: Participant,
  task: Task,
  slotId: string,
): ConstraintViolation | null {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) {
    return violation(
      'SLOT_NOT_FOUND',
      `${describeTaskInstance(task)} \u200F— משבצת ${slotId} לא נמצאה`,
      task.id,
      slotId,
      participant.id,
    );
  }
  if (!isLevelSatisfied(participant.level, slot)) {
    return violation(
      'LEVEL_MISMATCH',
      `${participant.name} (דרגה ${participant.level}) \u200F— ${describeTaskInstance(task)} (נדרש: ${slot.acceptableLevels.map((e) => 'דרגה ' + e.level).join(', ')})`,
      task.id,
      slotId,
      participant.id,
    );
  }
  return null;
}

/**
 * HC-2: Certification requirement — participant must hold all required certs.
 *
 * @param extraCapabilityLoss Optional schedule-scoped capability overrides.
 *        When the task's timeBlock overlaps a matching entry, the listed
 *        certs are treated as absent — HC-2 fires for any required cert
 *        that's been lost.
 */
export function checkCertificationRequirement(
  participant: Participant,
  task: Task,
  slotId: string,
  certLabelResolver: (certId: string) => string = (id) => id,
  extraCapabilityLoss?: CapabilityLossOverride[],
): ConstraintViolation | null {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return null;

  const effective = effectiveCertsAt(participant, task, extraCapabilityLoss);
  for (const cert of slot.requiredCertifications) {
    if (!effective.has(cert)) {
      return violation(
        'CERT_MISSING',
        `${participant.name} \u200F— ${describeTaskInstance(task)} (חסר: ${certLabelResolver(cert)})`,
        task.id,
        slotId,
        participant.id,
      );
    }
  }
  return null;
}

/**
 * HC-3: Availability — participant must be available for entire task duration.
 *
 * @param extraUnavailability Optional schedule-scoped windows (Future SOS).
 *        When any entry belongs to the participant and overlaps the task,
 *        HC-3 fires just as it would for master-data unavailability.
 * @param scheduleContext Required to evaluate weekly `dateUnavailability`
 *        rules in operational-day semantics. When omitted, the recurring-rule
 *        check is skipped (the caller must have pre-expanded blackouts into
 *        `participant.availability`). All production call paths pass it.
 */
export function checkAvailability(
  participant: Participant,
  task: Task,
  extraUnavailability?: Array<{ participantId: string; start: Date; end: Date }>,
  scheduleContext?: ScheduleContext,
): ConstraintViolation | null {
  if (!isFullyCovered(task.timeBlock, participant.availability)) {
    return violation(
      'AVAILABILITY_VIOLATION',
      `${participant.name} \u200F— ${describeTaskInstance(task)}`,
      task.id,
      undefined,
      participant.id,
    );
  }
  if (
    scheduleContext &&
    isBlockedByDateUnavailability(task.timeBlock, participant.dateUnavailability, scheduleContext)
  ) {
    return violation(
      'AVAILABILITY_VIOLATION',
      `${participant.name} \u200F— ${describeTaskInstance(task)}`,
      task.id,
      undefined,
      participant.id,
    );
  }
  if (extraUnavailability) {
    for (const u of extraUnavailability) {
      if (u.participantId !== participant.id) continue;
      if (blocksOverlap(task.timeBlock, { start: u.start, end: u.end })) {
        return violation(
          'AVAILABILITY_VIOLATION',
          `${participant.name} \u200F— ${describeTaskInstance(task)}`,
          task.id,
          undefined,
          participant.id,
        );
      }
    }
  }
  return null;
}

/**
 * HC-4: Same group constraint (Adanit) — all participants in task must share one group.
 */
export function checkSameGroup(task: Task, assignedParticipants: Participant[]): ConstraintViolation[] {
  if (!task.sameGroupRequired || assignedParticipants.length === 0) return [];

  const groups = new Set(assignedParticipants.map((p) => p.group));
  if (groups.size > 1) {
    return [
      violation(
        'GROUP_MISMATCH',
        `${describeTaskInstance(task)} \u200F— קבוצות: ${[...groups].join(', ')} (נדרשת קבוצה אחת)`,
        task.id,
      ),
    ];
  }
  return [];
}

/**
 * HC-11: Forbidden certification check — participants holding a certification
 * listed in a slot's forbiddenCertifications are forbidden from that slot.
 *
 * Honors `extraCapabilityLoss`: a cert that's been lost for the overlapping
 * window is treated as absent, so the participant becomes eligible for slots
 * that previously forbade that cert.
 */
export function checkForbiddenCertifications(
  task: Task,
  taskAssignments: Assignment[],
  pMap: Map<string, Participant>,
  certLabelResolver: (certId: string) => string = (id) => id,
  extraCapabilityLoss?: CapabilityLossOverride[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  for (const a of taskAssignments) {
    const slot = task.slots.find((s) => s.slotId === a.slotId);
    if (!slot?.forbiddenCertifications?.length) continue;
    const p = pMap.get(a.participantId);
    if (!p) continue;
    const effective = effectiveCertsAt(p, task, extraCapabilityLoss);
    const forbidden = slot.forbiddenCertifications.filter((c) => effective.has(c));
    if (forbidden.length > 0) {
      violations.push(
        violation(
          'EXCLUDED_CERTIFICATION',
          `${p.name} \u200F— ${describeTaskInstance(task)} (מחזיק/ה: ${forbidden.map(certLabelResolver).join(', ')})`,
          task.id,
          slot.slotId,
          p.id,
        ),
      );
    }
  }
  return violations;
}

/**
 * HC-5: No double-booking — a participant cannot be physically present in two
 * places at once. This applies to ALL tasks regardless of load weight.
 * Physical presence is a strictly exclusive constraint.
 */
export function checkNoDoubleBooking(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  participantName?: string,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const displayName = participantName ?? participantId;
  const participantAssignments = assignments.filter((a) => a.participantId === participantId);

  // Check ALL assignments for physical overlap (including zero-load tasks)
  const allWithTasks = participantAssignments.filter((a) => taskMap.has(a.taskId));

  if (allWithTasks.length < 2) return violations;

  // Simple zero-allocation nested loop checking for overlaps
  for (let i = 0; i < allWithTasks.length; i++) {
    const taskA = taskMap.get(allWithTasks[i].taskId)!;
    const startA = taskA.timeBlock.start.getTime();
    const endA = taskA.timeBlock.end.getTime();

    for (let j = i + 1; j < allWithTasks.length; j++) {
      const taskB = taskMap.get(allWithTasks[j].taskId)!;
      const startB = taskB.timeBlock.start.getTime();
      const endB = taskB.timeBlock.end.getTime();

      // Check if one task starts before another ends and ends after it starts
      if (startA < endB && endA > startB) {
        violations.push(
          violation(
            'DOUBLE_BOOKING',
            `${displayName} \u200F— "${describeTaskBidi(taskA)}" \u200F↔ "${describeTaskBidi(taskB)}"`,
            taskA.id,
            undefined,
            participantId,
          ),
        );
      }
    }
  }

  return violations;
}

/**
 * HC-6: Slot fill — every slot in a task must be assigned exactly one participant.
 */
export function checkSlotsFilled(task: Task, assignments: Assignment[]): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);

  for (const slot of task.slots) {
    const slotAssignments = taskAssignments.filter((a) => a.slotId === slot.slotId);
    if (slotAssignments.length === 0) {
      violations.push(violation('SLOT_UNFILLED', `${describeTaskInstance(task)}`, task.id, slot.slotId));
    } else if (slotAssignments.length > 1) {
      violations.push(
        violation(
          'SLOT_OVERBOOKED',
          `${describeTaskInstance(task)} \u200F— ${slotAssignments.length} במקום 1`,
          task.id,
          slot.slotId,
        ),
      );
    }
  }
  return violations;
}

/**
 * HC-7: Unique participant per task — no participant assigned twice to the same task.
 */
export function checkUniqueParticipantsPerTask(task: Task, assignments: Assignment[]): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const seen = new Set<string>();

  for (const a of taskAssignments) {
    if (seen.has(a.participantId)) {
      violations.push(
        violation(
          'DUPLICATE_IN_TASK',
          `${a.participantId} \u200F— ${describeTaskInstance(task)}`,
          task.id,
          a.slotId,
          a.participantId,
        ),
      );
    }
    seen.add(a.participantId);
  }
  return violations;
}

/**
 * HC-8: Group feasibility for sameGroupRequired tasks — the assigned group
 * must have enough participants to fill every slot, matching each slot's
 * acceptableLevels and requiredCertifications.
 *
 * Honors the global `disabledHC` set: if HC-1, HC-2, or HC-11 are disabled,
 * the matching predicate drops the corresponding filter so HC-8 cannot
 * indirectly re-impose a constraint the user has explicitly relaxed. With
 * all three disabled, HC-8 degenerates to a pure cardinality check
 * (group size ≥ slot count).
 *
 * Feasibility is decided by maximum bipartite matching (see
 * {@link findMaxMatching}). A group is sufficient iff every slot can be
 * matched to a distinct eligible member; greedy claim-first-available is
 * insufficient when slots have heterogeneous tightness (e.g. one slot needs
 * a rare cert that only one member holds, while another slot also accepts
 * that member).
 */
export function checkGroupFeasibility(
  task: Task,
  groupParticipants: Participant[],
  certLabelResolver: (certId: string) => string = (id) => id,
  disabledHC?: Set<string>,
): ConstraintViolation[] {
  if (!task.sameGroupRequired) return [];

  const enforceLevel = !disabledHC?.has('HC-1');
  const enforceReqCert = !disabledHC?.has('HC-2');
  const enforceForbiddenCert = !disabledHC?.has('HC-11');

  const slotInputs: SlotCandidates[] = task.slots.map((slot) => ({
    slotId: slot.slotId,
    candidates: groupParticipants
      .filter((p) => {
        if (enforceLevel && !slot.acceptableLevels.some((e) => e.level === p.level)) return false;
        if (enforceReqCert) {
          for (const cert of slot.requiredCertifications) {
            if (!p.certifications.includes(cert)) return false;
          }
        }
        if (enforceForbiddenCert && slot.forbiddenCertifications?.some((c) => p.certifications.includes(c)))
          return false;
        return true;
      })
      .map((p) => p.id),
  }));

  const result = findMaxMatching(slotInputs);
  if (result.unfilled.length === 0) return [];

  const slotById = new Map(task.slots.map((s) => [s.slotId, s] as const));
  const violations: ConstraintViolation[] = [];
  for (const slotId of result.unfilled) {
    const slot = slotById.get(slotId);
    const parts: string[] = [];
    if (slot && enforceLevel) parts.push(slot.acceptableLevels.map((e) => `דרגה ${e.level}`).join('/'));
    if (slot && enforceReqCert && slot.requiredCertifications.length > 0) {
      parts.push(slot.requiredCertifications.map(certLabelResolver).join(', '));
    }
    const desc = parts.length > 0 ? `נדרש: ${parts.join(' + ')}` : 'אין מספיק משתתפים בקבוצה';
    violations.push(violation('GROUP_INSUFFICIENT', `${describeTaskInstance(task)} \u200F— ${desc}`, task.id, slotId));
  }
  return violations;
}

// ─── HC-12: No Consecutive High-Load Tasks ──────────────────────────────────

/**
 * Determine whether a task effectively blocks consecutive placement at a
 * given edge ('start' or 'end').
 *
 * Two-rule model:
 *   1. Task-level `blocksConsecutive=true` is absolute and unconditional —
 *      both edges block, regardless of any load windows.
 *   2. Otherwise, an individual `LoadWindow` may opt-in via
 *      `blocksAtBoundary=true`. The opt-in fires at whichever boundary
 *      the window's interval covers (start, end, or both).
 *
 * Sample at task.start for 'start' and at end-1ms for 'end' (half-open
 * interval [start, end) — same convention as `getLoadWeightAtTime`).
 */
export function effectivelyBlocksAt(task: Task, edge: 'start' | 'end'): boolean {
  // Rule 1: task-level flag is absolute.
  if (task.blocksConsecutive) return true;

  // Rule 2: per-window opt-in, evaluated at the boundary instant.
  const windows = task.loadWindows;
  if (!windows || windows.length === 0) return false;

  const sampleTime = edge === 'start' ? task.timeBlock.start : new Date(task.timeBlock.end.getTime() - 1);
  for (const w of windows) {
    if (!w.blocksAtBoundary) continue;
    if (isTimeInsideWindow(sampleTime, w)) return true;
  }
  return false;
}

/**
 * HC-12: A participant must NOT have two back-to-back assignments where
 * the first task's end blocks AND the next task's start blocks (per
 * `effectivelyBlocksAt`).
 */
export function checkNoConsecutiveHighLoad(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  participantName?: string,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const displayName = participantName ?? participantId;

  // Collect this participant's assignments with their tasks
  const pAssignments = assignments
    .filter((a) => a.participantId === participantId)
    .map((a) => ({ assignment: a, task: taskMap.get(a.taskId)! }))
    .filter((x) => x.task != null)
    // Sort by task start time
    .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());

  // Check each adjacent pair
  for (let i = 0; i < pAssignments.length - 1; i++) {
    const current = pAssignments[i];
    const next = pAssignments[i + 1];

    // Only check truly adjacent tasks (end of current == start of next, or overlapping boundary)
    const gap = next.task.timeBlock.start.getTime() - current.task.timeBlock.end.getTime();
    if (gap > 0) continue; // There's a gap → buffer exists

    // Same task → internal transition, not a violation
    if (current.task.id === next.task.id) continue;

    if (effectivelyBlocksAt(current.task, 'end') && effectivelyBlocksAt(next.task, 'start')) {
      violations.push(
        violation(
          'CONSECUTIVE_HIGH_LOAD',
          `${displayName} \u200F— "${describeTaskBidi(current.task)}" \u200F→ "${describeTaskBidi(next.task)}"`,
          next.task.id,
          undefined,
          participantId,
        ),
      );
    }
  }

  return violations;
}

// ─── HC-14: Rest Rules ──────────────────────────────────────────────────────

/**
 * HC-14: A participant must have a minimum gap between any two tasks that
 * both reference a rest rule.
 *
 * - Same rule → that rule's duration
 * - Different rules → min of both durations
 * - One or neither has a rule → HC-14 does not apply
 *
 * Two-phase algorithm:
 * Phase 1: Within each rule group, adjacent pairs (sorted by time) are
 *   sufficient by transitivity (gap(A,C) ≥ gap(A,B) + gap(B,C) ≥ 2·d ≥ d).
 * Phase 2: Across rule groups, ALL forward cross-rule pairs within the
 *   max-rule-duration window must be checked. Adjacent-only is unsound when
 *   3+ rules with different durations interleave: a small-duration rule
 *   between two large ones lets the long-rule pair slip through (the
 *   transitive bound min(dA,dB) + dur(B) + min(dB,dC) does not dominate
 *   min(dA,dC) when dB ≪ dA, dC). The forward gap is monotone non-decreasing
 *   as j advances (tasks are sorted by start), so we break once gap ≥ maxDur.
 */
export function checkRestRules(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  restRuleMap: Map<string, number>,
  participantName?: string,
): ConstraintViolation[] {
  if (restRuleMap.size === 0) return [];

  const violations: ConstraintViolation[] = [];
  const displayName = participantName || participantId;

  // Collect tasks with a valid rest rule
  const tagged: Array<{ assignment: Assignment; task: Task }> = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task || !task.restRuleId || !restRuleMap.has(task.restRuleId)) continue;
    tagged.push({ assignment: a, task });
  }
  if (tagged.length < 2) return [];

  // Phase 1: Same-rule adjacent pairs
  const byRule = new Map<string, typeof tagged>();
  for (const entry of tagged) {
    const rid = entry.task.restRuleId!;
    let list = byRule.get(rid);
    if (!list) {
      list = [];
      byRule.set(rid, list);
    }
    list.push(entry);
  }
  const violatedPairs = new Set<string>(); // "taskIdA|taskIdB" to avoid duplicates across phases

  for (const [ruleId, entries] of byRule) {
    if (entries.length < 2) continue;
    const durationMs = restRuleMap.get(ruleId)!;
    entries.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
    for (let i = 0; i < entries.length - 1; i++) {
      const cur = entries[i];
      const nxt = entries[i + 1];
      if (cur.task.id === nxt.task.id) continue;
      const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
      if (gap < durationMs) {
        const pairKey = cur.task.id < nxt.task.id ? `${cur.task.id}|${nxt.task.id}` : `${nxt.task.id}|${cur.task.id}`;
        violatedPairs.add(pairKey);
        violations.push(
          violation(
            'CATEGORY_BREAK_VIOLATION',
            `${displayName} \u200F— ${(gap / 3600000).toFixed(1)} שעות בין "${describeTaskBidi(cur.task)}" ל-"${describeTaskBidi(nxt.task)}" (מינימום ${(durationMs / 3600000).toFixed(1)})`,
            nxt.task.id,
            undefined,
            participantId,
          ),
        );
      }
    }
  }

  // Phase 2: Cross-rule pairs — all forward pairs within the max-rule-duration
  // window. See header comment for why adjacent-only is unsound.
  if (byRule.size > 1) {
    tagged.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
    let maxDurMs = 0;
    for (const d of restRuleMap.values()) if (d > maxDurMs) maxDurMs = d;
    for (let i = 0; i < tagged.length - 1; i++) {
      const cur = tagged[i];
      const curEnd = cur.task.timeBlock.end.getTime();
      for (let j = i + 1; j < tagged.length; j++) {
        const nxt = tagged[j];
        const gap = nxt.task.timeBlock.start.getTime() - curEnd;
        if (gap >= maxDurMs) break; // monotone forward gap; no later j can violate from this i
        if (cur.task.id === nxt.task.id) continue;
        if (cur.task.restRuleId === nxt.task.restRuleId) continue; // same-rule handled in phase 1
        const pairKey = cur.task.id < nxt.task.id ? `${cur.task.id}|${nxt.task.id}` : `${nxt.task.id}|${cur.task.id}`;
        if (violatedPairs.has(pairKey)) continue;
        const durationMs = Math.min(restRuleMap.get(cur.task.restRuleId!)!, restRuleMap.get(nxt.task.restRuleId!)!);
        if (gap < durationMs) {
          violatedPairs.add(pairKey);
          violations.push(
            violation(
              'CATEGORY_BREAK_VIOLATION',
              `${displayName} \u200F— ${(gap / 3600000).toFixed(1)} שעות בין "${describeTaskBidi(cur.task)}" ל-"${describeTaskBidi(nxt.task)}" (מינימום ${(durationMs / 3600000).toFixed(1)})`,
              nxt.task.id,
              undefined,
              participantId,
            ),
          );
        }
      }
    }
  }

  return violations;
}

// ─── Aggregate Validation ────────────────────────────────────────────────────

/**
 * Run ALL hard constraint checks against a complete schedule.
 * Returns aggregated violations — if any exist, the schedule is infeasible.
 *
 * Pre-builds per-task and per-participant assignment indexes to eliminate
 * redundant O(A) scans per task/participant (previously O(T×A + P×A)).
 */
export function validateHardConstraints(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  certLabelResolver: (certId: string) => string = (id) => id,
  extraUnavailability?: Array<{ participantId: string; start: Date; end: Date }>,
  scheduleContext?: ScheduleContext,
  extraCapabilityLoss?: CapabilityLossOverride[],
): ValidationResult {
  const allViolations: ConstraintViolation[] = [];
  const pMap = buildParticipantMap(participants);
  const tMap = buildTaskMap(tasks);

  // ── Pre-index assignments O(A) ──
  const assignmentsByTask = new Map<string, Assignment[]>();
  const assignmentsByParticipant = new Map<string, Assignment[]>();
  for (const a of assignments) {
    let tList = assignmentsByTask.get(a.taskId);
    if (!tList) {
      tList = [];
      assignmentsByTask.set(a.taskId, tList);
    }
    tList.push(a);

    let pList = assignmentsByParticipant.get(a.participantId);
    if (!pList) {
      pList = [];
      assignmentsByParticipant.set(a.participantId, pList);
    }
    pList.push(a);
  }

  for (const task of tasks) {
    const taskAssignments = assignmentsByTask.get(task.id) || [];

    // HC-6: All slots filled — use pre-indexed task assignments
    if (!disabledHC?.has('HC-6')) {
      for (const slot of task.slots) {
        const slotAssignments = taskAssignments.filter((a) => a.slotId === slot.slotId);
        if (slotAssignments.length === 0) {
          allViolations.push(violation('SLOT_UNFILLED', `${describeTaskInstance(task)}`, task.id, slot.slotId));
        } else if (slotAssignments.length > 1) {
          allViolations.push(
            violation(
              'SLOT_OVERBOOKED',
              `${describeTaskInstance(task)} \u200F— ${slotAssignments.length} במקום 1`,
              task.id,
              slot.slotId,
            ),
          );
        }
      }
    }

    // HC-7: Unique participants per task — use pre-indexed task assignments
    if (!disabledHC?.has('HC-7')) {
      const seen = new Set<string>();
      for (const a of taskAssignments) {
        if (seen.has(a.participantId)) {
          const pName = pMap.get(a.participantId)?.name || a.participantId;
          allViolations.push(
            violation(
              'DUPLICATE_IN_TASK',
              `${pName} \u200F— ${describeTaskInstance(task)}`,
              task.id,
              a.slotId,
              a.participantId,
            ),
          );
        }
        seen.add(a.participantId);
      }
    }

    // Per-assignment checks
    for (const a of taskAssignments) {
      const participant = pMap.get(a.participantId);
      if (!participant) {
        const slot = task.slots.find((s) => s.slotId === a.slotId);
        allViolations.push(
          violation(
            'PARTICIPANT_NOT_FOUND',
            `${describeTaskInstance(task)} \u200F— מזהה: ${a.participantId}`,
            task.id,
            a.slotId,
            a.participantId,
          ),
        );
        continue;
      }

      // HC-1: Level
      if (!disabledHC?.has('HC-1')) {
        const levelV = checkLevelRequirement(participant, task, a.slotId);
        if (levelV) allViolations.push(levelV);
      }

      // HC-2: Certifications
      if (!disabledHC?.has('HC-2')) {
        const certV = checkCertificationRequirement(
          participant,
          task,
          a.slotId,
          certLabelResolver,
          extraCapabilityLoss,
        );
        if (certV) allViolations.push(certV);
      }

      // HC-3: Availability
      if (!disabledHC?.has('HC-3')) {
        const availV = checkAvailability(participant, task, extraUnavailability, scheduleContext);
        if (availV) allViolations.push(availV);
      }
    }

    // HC-11: Forbidden certification — per-slot check
    if (!disabledHC?.has('HC-11')) {
      allViolations.push(
        ...checkForbiddenCertifications(task, taskAssignments, pMap, certLabelResolver, extraCapabilityLoss),
      );
    }

    // HC-4: Same group — use pre-indexed task assignments
    if (!disabledHC?.has('HC-4')) {
      const assignedParticipants = taskAssignments
        .map((a) => pMap.get(a.participantId))
        .filter((p): p is Participant => p !== undefined);
      allViolations.push(...checkSameGroup(task, assignedParticipants));
    }

    // HC-8: Group feasibility for sameGroupRequired tasks
    if (!disabledHC?.has('HC-8') && task.sameGroupRequired) {
      const assignedPIds = new Set(taskAssignments.map((a) => a.participantId));
      const assignedParticipants = participants.filter((p) => assignedPIds.has(p.id));
      if (assignedParticipants.length > 0) {
        const group = assignedParticipants[0].group;
        const groupMembers = participants.filter((p) => p.group === group);
        allViolations.push(...checkGroupFeasibility(task, groupMembers, certLabelResolver, disabledHC));
      }
    }
  }

  // HC-5: Double booking — use pre-indexed participant assignments
  if (!disabledHC?.has('HC-5')) {
    for (const p of participants) {
      const pAssigns = assignmentsByParticipant.get(p.id) || [];
      if (pAssigns.length < 2) continue; // Can't double-book with 0-1 assignments
      // Sweep-line on pre-filtered, sorted assignments
      const sorted = pAssigns
        .filter((a) => tMap.has(a.taskId))
        .sort((a, b) => tMap.get(a.taskId)!.timeBlock.start.getTime() - tMap.get(b.taskId)!.timeBlock.start.getTime());
      if (sorted.length < 2) continue;
      // Prefix-max of end times for correct backward-walk early termination
      const prefixMaxEnd: number[] = new Array(sorted.length);
      prefixMaxEnd[0] = tMap.get(sorted[0].taskId)!.timeBlock.end.getTime();
      for (let k = 1; k < sorted.length; k++) {
        const kEnd = tMap.get(sorted[k].taskId)!.timeBlock.end.getTime();
        prefixMaxEnd[k] = kEnd > prefixMaxEnd[k - 1] ? kEnd : prefixMaxEnd[k - 1];
      }
      let maxEndMs = prefixMaxEnd[0];
      for (let i = 1; i < sorted.length; i++) {
        const task = tMap.get(sorted[i].taskId)!;
        const startMs = task.timeBlock.start.getTime();
        const endMs = task.timeBlock.end.getTime();
        if (startMs < maxEndMs) {
          for (let j = i - 1; j >= 0; j--) {
            if (prefixMaxEnd[j] <= startMs) break;
            const prevTask = tMap.get(sorted[j].taskId)!;
            if (blocksOverlap(prevTask.timeBlock, task.timeBlock)) {
              allViolations.push(
                violation(
                  'DOUBLE_BOOKING',
                  `${p.name} \u200F— "${describeTaskBidi(prevTask)}" \u200F↔ "${describeTaskBidi(task)}"`,
                  prevTask.id,
                  undefined,
                  p.id,
                ),
              );
            }
          }
        }
        if (endMs > maxEndMs) maxEndMs = endMs;
      }
    }
  }

  // HC-12: No consecutive high-load tasks — use pre-indexed participant assignments
  if (!disabledHC?.has('HC-12')) {
    for (const p of participants) {
      const pAssigns = assignmentsByParticipant.get(p.id) || [];
      if (pAssigns.length < 2) continue;
      const sorted = pAssigns
        .map((a) => ({ assignment: a, task: tMap.get(a.taskId)! }))
        .filter((x) => x.task != null)
        .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const nxt = sorted[i + 1];
        if (cur.task.id === nxt.task.id) continue;
        const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
        if (gap > 0) continue;
        if (effectivelyBlocksAt(cur.task, 'end') && effectivelyBlocksAt(nxt.task, 'start')) {
          allViolations.push(
            violation(
              'CONSECUTIVE_HIGH_LOAD',
              `${p.name} \u200F— "${describeTaskBidi(cur.task)}" \u200F→ "${describeTaskBidi(nxt.task)}"`,
              nxt.task.id,
              undefined,
              p.id,
            ),
          );
        }
      }
    }
  }

  // HC-14: Rest rules — minimum gap between rest-rule-tagged tasks
  if (!disabledHC?.has('HC-14') && restRuleMap && restRuleMap.size > 0) {
    for (const p of participants) {
      const pAssigns = assignmentsByParticipant.get(p.id) || [];
      if (pAssigns.length < 2) continue;
      allViolations.push(...checkRestRules(p.id, pAssigns, tMap, restRuleMap, p.name));
    }
  }

  // HC-15: Sleep & Recovery — per-task recovery window forbids loaded placements
  if (!disabledHC?.has('HC-15')) {
    for (const p of participants) {
      const pAssigns = assignmentsByParticipant.get(p.id) || [];
      if (pAssigns.length < 2) continue;
      allViolations.push(...checkSleepRecovery(p.id, pAssigns, tMap, p.name));
    }
  }

  return {
    valid: allViolations.length === 0,
    violations: allViolations,
  };
}
