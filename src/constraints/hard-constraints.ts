/**
 * Hard Constraint Validators
 *
 * If any hard constraint is violated, the schedule is INVALID.
 * Returns ConstraintViolation[] with severity=Error.
 */

import {
  Task,
  Assignment,
  Participant,
  ConstraintViolation,
  ViolationSeverity,
  Level,
  SlotRequirement,
  ValidationResult,
} from '../models/types';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { isHighLoadAtBoundary } from '../web/utils/load-weighting';
import { describeSlot } from '../utils/date-utils';

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
  return slot.acceptableLevels.some(e => e.level === level);
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
      `משבצת ${slotId} לא נמצאה במשימה ${task.id}`,
      task.id,
      slotId,
      participant.id,
    );
  }
  if (!isLevelSatisfied(participant.level, slot)) {
    return violation(
      'LEVEL_MISMATCH',
      `משתתף ${participant.name} (דרגה ${participant.level}) לא עומד בדרישת הדרגה [${slot.acceptableLevels.map((e) => 'דרגה ' + e.level).join(',')}] עבור ${task.name} משבצת "${describeSlot(slot.label, task.timeBlock)}"`,
      task.id,
      slotId,
      participant.id,
    );
  }
  return null;
}

/**
 * HC-2: Certification requirement — participant must hold all required certs.
 */
export function checkCertificationRequirement(
  participant: Participant,
  task: Task,
  slotId: string,
): ConstraintViolation | null {
  const slot = task.slots.find((s) => s.slotId === slotId);
  if (!slot) return null;

  for (const cert of slot.requiredCertifications) {
    if (!participant.certifications.includes(cert)) {
      return violation(
        'CERT_MISSING',
        `משתתף ${participant.name} חסר הסמכה נדרשת "${cert}" עבור ${task.name} משבצת "${describeSlot(slot.label, task.timeBlock)}"`,
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
 */
export function checkAvailability(
  participant: Participant,
  task: Task,
): ConstraintViolation | null {
  if (!isFullyCovered(task.timeBlock, participant.availability)) {
    return violation(
      'AVAILABILITY_VIOLATION',
      `משתתף ${participant.name} לא זמין למשך הזמן המלא של ${task.name}`,
      task.id,
      undefined,
      participant.id,
    );
  }
  return null;
}

/**
 * HC-4: Same group constraint (Adanit) — all participants in task must share one group.
 */
export function checkSameGroup(
  task: Task,
  assignedParticipants: Participant[],
): ConstraintViolation[] {
  if (!task.sameGroupRequired || assignedParticipants.length === 0) return [];

  const groups = new Set(assignedParticipants.map((p) => p.group));
  if (groups.size > 1) {
    return [
      violation(
        'GROUP_MISMATCH',
        `משימה ${task.name} דורשת שכל המשתתפים יהיו מאותה קבוצה, אך נמצאו קבוצות: [${[...groups].join(', ')}]`,
        task.id,
      ),
    ];
  }
  return [];
}

/**
 * HC-11: Forbidden certification check — participants holding a certification
 * listed in a slot's forbiddenCertifications are forbidden from that slot.
 */
export function checkForbiddenCertifications(
  task: Task,
  taskAssignments: Assignment[],
  pMap: Map<string, Participant>,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  for (const a of taskAssignments) {
    const slot = task.slots.find(s => s.slotId === a.slotId);
    if (!slot?.forbiddenCertifications?.length) continue;
    const p = pMap.get(a.participantId);
    if (!p) continue;
    const forbidden = slot.forbiddenCertifications.filter(c => p.certifications.includes(c));
    if (forbidden.length > 0) {
      violations.push(
        violation(
          'EXCLUDED_CERTIFICATION',
          `${p.name} מחזיק/ה בהסמכה ${forbidden.join(', ')} ואסור/ה במשבצת "${describeSlot(slot.label, task.timeBlock)}" במשימת "${task.name}"`,
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
 * places at once. This applies to ALL tasks including light/Karovit.
 * Physical presence is a strictly exclusive constraint.
 */
export function checkNoDoubleBooking(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const participantAssignments = assignments.filter((a) => a.participantId === participantId);

  // Check ALL assignments for physical overlap (including light tasks)
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
            `משתתף ${participantId} משובץ/ת בכפל: "${taskA.name}" ו-"${taskB.name}" חופפים`,
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
export function checkSlotsFilled(
  task: Task,
  assignments: Assignment[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);

  for (const slot of task.slots) {
    const slotAssignments = taskAssignments.filter((a) => a.slotId === slot.slotId);
    if (slotAssignments.length === 0) {
      violations.push(
        violation(
          'SLOT_UNFILLED',
          `למשבצת "${describeSlot(slot.label, task.timeBlock)}" ב-${task.name} לא משובץ משתתף`,
          task.id,
          slot.slotId,
        ),
      );
    } else if (slotAssignments.length > 1) {
      violations.push(
        violation(
          'SLOT_OVERBOOKED',
          `למשבצת "${describeSlot(slot.label, task.timeBlock)}" ב-${task.name} יש ${slotAssignments.length} משתתפים (צפוי 1)`,
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
export function checkUniqueParticipantsPerTask(
  task: Task,
  assignments: Assignment[],
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const taskAssignments = assignments.filter((a) => a.taskId === task.id);
  const seen = new Set<string>();

  for (const a of taskAssignments) {
    if (seen.has(a.participantId)) {
      violations.push(
        violation(
          'DUPLICATE_IN_TASK',
          `משתתף ${a.participantId} משובץ/ת מספר פעמים ב-${task.name}`,
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
 * This is data-driven: slot definitions determine what's needed, not hardcoded
 * counts. For the default Adanit template (6 slots: 4×L0+Nitzan, 1×L2+Nitzan,
 * 1×L3/L4+Nitzan), this produces equivalent results to the previous hardcoded check.
 */
export function checkGroupFeasibility(
  task: Task,
  groupParticipants: Participant[],
): ConstraintViolation[] {
  if (!task.sameGroupRequired) return [];

  const violations: ConstraintViolation[] = [];
  // Track which participants have been "claimed" by a slot (greedy matching)
  const claimed = new Set<string>();

  // Sort slots most-constrained-first (same as optimizer) so greedy matching
  // doesn't falsely claim a flexible slot leaves a strict one unfillable.
  const sortedSlots = [...task.slots].sort(
    (a, b) => Math.min(...b.acceptableLevels.map(e => e.level)) - Math.min(...a.acceptableLevels.map(e => e.level)),
  );

  for (const slot of sortedSlots) {
    const match = groupParticipants.find(p => {
      if (claimed.has(p.id)) return false;
      if (!slot.acceptableLevels.some(e => e.level === p.level)) return false;
      for (const cert of slot.requiredCertifications) {
        if (!p.certifications.includes(cert)) return false;
      }
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) return false;
      return true;
    });
    if (match) {
      claimed.add(match.id);
    } else {
      const levelDesc = slot.acceptableLevels.map(e => `דרגה ${e.level}`).join('/');
      const certDesc = slot.requiredCertifications.length > 0
        ? ` + ${slot.requiredCertifications.join(', ')}`
        : '';
      violations.push(
        violation(
          'GROUP_INSUFFICIENT',
          `משימה "${task.name}": הקבוצה חסרה משתתף כשיר למשבצת "${describeSlot(slot.label, task.timeBlock)}" (נדרש: ${levelDesc}${certDesc})`,
          task.id,
          slot.slotId,
        ),
      );
    }
  }

  return violations;
}

// ─── HC-12: No Consecutive High-Load Tasks ──────────────────────────────────

/**
 * Determine whether a task effectively blocks consecutive placement at a
 * given edge ('start' or 'end').
 *
 * For tasks with loadWindows (e.g. Karov), the boundary is blocking only
 * when the task is at high load at that edge — a Karov ending in a hot
 * window blocks, but one ending in a cold zone does not.
 *
 * For tasks without loadWindows, the static `blocksConsecutive` flag is used.
 */
export function effectivelyBlocksAt(task: Task, edge: 'start' | 'end'): boolean {
  if (task.loadWindows && task.loadWindows.length > 0) {
    return isHighLoadAtBoundary(task, edge);
  }
  return task.blocksConsecutive;
}

/**
 * HC-12: A participant must NOT have two back-to-back assignments where
 * the first task ends at high load and the next starts at high load.
 *
 * For tasks with loadWindows, load is evaluated at the boundary instant.
 * For tasks without loadWindows, the blocksConsecutive flag is used.
 */
export function checkNoConsecutiveHighLoad(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

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
          `למשתתף ${participantId} משימות עוקבות ללא הפסקה: "${current.task.name}" ו-"${next.task.name}"`,
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
 *   sufficient because all pairs share the same threshold.
 * Phase 2: Across rule groups, adjacent pairs in the global sorted list
 *   (only checking cross-rule pairs) are sufficient because the min-threshold
 *   is constant for any pair from the same two rules.
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
    if (!list) { list = []; byRule.set(rid, list); }
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
        violations.push(violation(
          'CATEGORY_BREAK_VIOLATION',
          `ל-${displayName} הפרש של ${(gap / 3600000).toFixed(1)} שעות בלבד בין "${cur.task.name}" ל-"${nxt.task.name}" (נדרשות ${(durationMs / 3600000).toFixed(1)} שעות לפחות)`,
          nxt.task.id, undefined, participantId,
        ));
      }
    }
  }

  // Phase 2: Cross-rule adjacent pairs
  if (byRule.size > 1) {
    tagged.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
    for (let i = 0; i < tagged.length - 1; i++) {
      const cur = tagged[i];
      const nxt = tagged[i + 1];
      if (cur.task.id === nxt.task.id) continue;
      if (cur.task.restRuleId === nxt.task.restRuleId) continue; // same-rule handled in phase 1
      const pairKey = cur.task.id < nxt.task.id ? `${cur.task.id}|${nxt.task.id}` : `${nxt.task.id}|${cur.task.id}`;
      if (violatedPairs.has(pairKey)) continue;
      const durationMs = Math.min(restRuleMap.get(cur.task.restRuleId!)!, restRuleMap.get(nxt.task.restRuleId!)!);
      const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
      if (gap < durationMs) {
        violations.push(violation(
          'CATEGORY_BREAK_VIOLATION',
          `ל-${displayName} הפרש של ${(gap / 3600000).toFixed(1)} שעות בלבד בין "${cur.task.name}" ל-"${nxt.task.name}" (נדרשות ${(durationMs / 3600000).toFixed(1)} שעות לפחות)`,
          nxt.task.id, undefined, participantId,
        ));
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
): ValidationResult {
  const allViolations: ConstraintViolation[] = [];
  const pMap = buildParticipantMap(participants);
  const tMap = buildTaskMap(tasks);

  // ── Pre-index assignments O(A) ──
  const assignmentsByTask = new Map<string, Assignment[]>();
  const assignmentsByParticipant = new Map<string, Assignment[]>();
  for (const a of assignments) {
    let tList = assignmentsByTask.get(a.taskId);
    if (!tList) { tList = []; assignmentsByTask.set(a.taskId, tList); }
    tList.push(a);

    let pList = assignmentsByParticipant.get(a.participantId);
    if (!pList) { pList = []; assignmentsByParticipant.set(a.participantId, pList); }
    pList.push(a);
  }

  for (const task of tasks) {
    const taskAssignments = assignmentsByTask.get(task.id) || [];

    // HC-6: All slots filled — use pre-indexed task assignments
    if (!disabledHC?.has('HC-6')) {
      for (const slot of task.slots) {
        const slotAssignments = taskAssignments.filter(a => a.slotId === slot.slotId);
        if (slotAssignments.length === 0) {
          allViolations.push(violation(
            'SLOT_UNFILLED',
            `למשבצת "${describeSlot(slot.label, task.timeBlock)}" ב-${task.name} לא משובץ משתתף`,
            task.id, slot.slotId,
          ));
        } else if (slotAssignments.length > 1) {
          allViolations.push(violation(
            'SLOT_OVERBOOKED',
            `למשבצת "${describeSlot(slot.label, task.timeBlock)}" ב-${task.name} יש ${slotAssignments.length} משתתפים (צפוי 1)`,
            task.id, slot.slotId,
          ));
        }
      }
    }

    // HC-7: Unique participants per task — use pre-indexed task assignments
    if (!disabledHC?.has('HC-7')) {
      const seen = new Set<string>();
      for (const a of taskAssignments) {
        if (seen.has(a.participantId)) {
          const pName = pMap.get(a.participantId)?.name || a.participantId;
          allViolations.push(violation(
            'DUPLICATE_IN_TASK',
            `${pName} משובץ/ת מספר פעמים ב-${task.name}`,
            task.id, a.slotId, a.participantId,
          ));
        }
        seen.add(a.participantId);
      }
    }

    // Per-assignment checks
    for (const a of taskAssignments) {
      const participant = pMap.get(a.participantId);
      if (!participant) {
        allViolations.push(
          violation(
            'PARTICIPANT_NOT_FOUND',
            `שיבוץ מפנה למשתתף לא ידוע ${a.participantId}`,
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
        const certV = checkCertificationRequirement(participant, task, a.slotId);
        if (certV) allViolations.push(certV);
      }

      // HC-3: Availability
      if (!disabledHC?.has('HC-3')) {
        const availV = checkAvailability(participant, task);
        if (availV) allViolations.push(availV);
      }
    }

    // HC-11: Forbidden certification — per-slot check
    if (!disabledHC?.has('HC-11')) {
      allViolations.push(...checkForbiddenCertifications(task, taskAssignments, pMap));
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
      const assignedPIds = new Set(taskAssignments.map(a => a.participantId));
      const assignedParticipants = participants.filter(p => assignedPIds.has(p.id));
      if (assignedParticipants.length > 0) {
        const group = assignedParticipants[0].group;
        const groupMembers = participants.filter(p => p.group === group);
        allViolations.push(...checkGroupFeasibility(task, groupMembers));
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
        .filter(a => tMap.has(a.taskId))
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
              allViolations.push(violation(
                'DOUBLE_BOOKING',
                `${p.name} משובץ/ת בכפל: "${prevTask.name}" ו-"${task.name}" חופפים`,
                prevTask.id, undefined, p.id,
              ));
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
        .map(a => ({ assignment: a, task: tMap.get(a.taskId)! }))
        .filter(x => x.task != null)
        .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
      for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i];
        const nxt = sorted[i + 1];
        if (cur.task.id === nxt.task.id) continue;
        const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
        if (gap > 0) continue;
        if (effectivelyBlocksAt(cur.task, 'end') && effectivelyBlocksAt(nxt.task, 'start')) {
          allViolations.push(violation(
            'CONSECUTIVE_HIGH_LOAD',
            `ל-${p.name} משימות עוקבות ללא הפסקה: "${cur.task.name}" ו-"${nxt.task.name}"`,
            nxt.task.id, undefined, p.id,
          ));
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

  return {
    valid: allViolations.length === 0,
    violations: allViolations,
  };
}
