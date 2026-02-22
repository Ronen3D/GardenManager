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
  TaskType,
  Level,
  Certification,
  SlotRequirement,
  ValidationResult,
} from '../models/types';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { validateSeniorHardBlocks } from './senior-policy';

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
 * Accepts an explicit match OR a level strictly higher than the highest
 * listed (overqualified).  The overqualified path is intentional for
 * natural-domain tasks where a senior may fill a junior slot as a fallback.
 *
 * Callers must enforce HC-13 (senior hard blocks) independently to prevent
 * seniors entering non-natural / restricted task types.  In particular,
 * `isEligibleForSlot()` in validator.ts checks HC-13 BEFORE calling this
 * function, ensuring the overqualified path only fires when HC-13 has
 * already approved the assignment (e.g. L4 in an L0 Hamama slot).
 * The optimizer's swap-feasibility check and `validateHardConstraints()`
 * both evaluate HC-1 and HC-13 as independent constraints that must all
 * pass — ordering between them is irrelevant there.
 */
export function isLevelSatisfied(level: Level, slot: SlotRequirement): boolean {
  return slot.acceptableLevels.includes(level)
    || level > Math.max(...slot.acceptableLevels);
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
      `משתתף ${participant.name} (דרגה ${participant.level}) לא עומד בדרישת הדרגה [${slot.acceptableLevels.map((l) => 'דרגה ' + l).join(',')}] עבור ${task.name} משבצת "${slot.label}"`,
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
        `משתתף ${participant.name} חסר הסמכה נדרשת "${cert}" עבור ${task.name} משבצת "${slot.label}"`,
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
 * HC-11: Choresh exclusion — participants marked as "choresh" are strictly
 * forbidden from being assigned to Mamtera tasks.
 */
export function checkChoreshExclusion(
  task: Task,
  assignedParticipants: Participant[],
): ConstraintViolation[] {
  if (task.type !== TaskType.Mamtera) return [];

  const violations: ConstraintViolation[] = [];
  for (const p of assignedParticipants) {
    if (p.certifications.includes(Certification.Horesh)) {
      violations.push(
        violation(
          'CHORESH_FORBIDDEN_MAMTERA',
          `${p.name} מסומן כחורש ואסור לחלוטין במשימת ממטרה "${task.name}"`,
          task.id,
          undefined,
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

  // Sort by start time for O(n log n) sweep-line overlap detection
  allWithTasks.sort((a, b) => {
    const tA = taskMap.get(a.taskId)!;
    const tB = taskMap.get(b.taskId)!;
    return tA.timeBlock.start.getTime() - tB.timeBlock.start.getTime();
  });

  // Sweep-line: track the maximum end time seen so far
  let maxEndMs = taskMap.get(allWithTasks[0].taskId)!.timeBlock.end.getTime();

  for (let i = 1; i < allWithTasks.length; i++) {
    const task = taskMap.get(allWithTasks[i].taskId)!;
    const startMs = task.timeBlock.start.getTime();
    const endMs = task.timeBlock.end.getTime();

    if (startMs < maxEndMs) {
      // Overlap detected — find the previous task(s) that overlap
      // Walk backwards to report all overlapping pairs with this task
      for (let j = i - 1; j >= 0; j--) {
        const prevTask = taskMap.get(allWithTasks[j].taskId)!;
        if (blocksOverlap(prevTask.timeBlock, task.timeBlock)) {
          violations.push(
            violation(
              'DOUBLE_BOOKING',
              `משתתף ${participantId} משובץ בכפל: "${prevTask.name}" ו-"${task.name}" חופפים`,
              prevTask.id,
              undefined,
              participantId,
            ),
          );
        } else {
          // Since sorted by start, earlier tasks that don't overlap won't overlap either
          break;
        }
      }
    }

    if (endMs > maxEndMs) maxEndMs = endMs;
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
          `למשבצת "${slot.label}" ב-${task.name} לא משובץ משתתף`,
          task.id,
          slot.slotId,
        ),
      );
    } else if (slotAssignments.length > 1) {
      violations.push(
        violation(
          'SLOT_OVERBOOKED',
          `למשבצת "${slot.label}" ב-${task.name} יש ${slotAssignments.length} משתתפים (צפוי 1)`,
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
          `משתתף ${a.participantId} משובץ מספר פעמים ב-${task.name}`,
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
 * HC-8: Adanit group feasibility — the assigned group must have enough participants
 * at the required levels AND all must hold Nitzan certification.
 *
 * Required: 4× L0, 1× L2, 1× L3/L4 (total = 6)
 * Segol Main:      2× L0, 1× L3/L4
 * Segol Secondary: 2× L0, 1× L2
 */
export function checkAdanitGroupFeasibility(
  task: Task,
  groupParticipants: Participant[],
): ConstraintViolation[] {
  if (task.type !== TaskType.Adanit) return [];

  const violations: ConstraintViolation[] = [];

  // All Adanit participants must have Nitzan certification
  const nitzanHolders = groupParticipants.filter((p) =>
    p.certifications.includes(Certification.Nitzan),
  );
  if (nitzanHolders.length < 6) {
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_NITZAN',
        `משימת אדנית ${task.name}: הקבוצה צריכה לפחות 6 משתתפים עם הסמכת ניצן, נמצאו ${nitzanHolders.length}. חסרה הסמכת ניצן לאדנית.`,
        task.id,
      ),
    );
  }

  const levels = groupParticipants.map((p) => p.level);

  const l0Count = levels.filter((l) => l === Level.L0).length;
  const l2Count = levels.filter((l) => l === Level.L2).length;
  const l2PlusCount = levels.filter(
    (l) => l === Level.L2 || l === Level.L3 || l === Level.L4,
  ).length;
  const l3l4Count = levels.filter((l) => l === Level.L3 || l === Level.L4).length;

  // Need: 4× L0 (2 per team), 1× L3/L4 (Segol Main), 1× L2 (Segol Secondary)
  if (l0Count < 4) {
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L0',
        `משימת אדנית ${task.name}: הקבוצה צריכה לפחות 4 משתתפים בדרגה 0, נמצאו ${l0Count}. חסרים משתתפי דרגה 0 לאדנית.`,
        task.id,
      ),
    );
  }
  if (l3l4Count < 1) {
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L3L4',
        `משימת אדנית ${task.name}: הקבוצה צריכה לפחות משתתף אחד בדרגה 3/4 (סגול ראשי), נמצאו ${l3l4Count}. חסר משתתף דרגה 3/4 לאדנית.`,
        task.id,
      ),
    );
  }
  if (l2Count < 1) {
    // Segol Secondary requires exactly L2
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L2',
        `משימת אדנית ${task.name}: הקבוצה צריכה לפחות משתתף אחד בדרגה 2 (סגול משני), נמצאו ${l2Count}. חסר משתתף דרגה 2 לאדנית.`,
        task.id,
      ),
    );
  }
  if (l2PlusCount < 2) {
    // Need 1× L3/L4 for Segol Main + 1× L2 for Segol Secondary = 2 total L2+
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L2PLUS',
        `משימת אדנית ${task.name}: הקבוצה צריכה לפחות 2 משתתפים בדרגה 2 ומעלה (1× דרגה 3/4 לראשי, 1× דרגה 2 למשני), נמצאו ${l2PlusCount}. חסרים משתתפי דרגה 2+ לאדנית.`,
        task.id,
      ),
    );
  }

  return violations;
}

// ─── HC-12: No Consecutive High-Load Tasks ──────────────────────────────────

/**
 * HC-12: A participant must NOT have two back-to-back assignments where
 * both tasks have blocksConsecutive=true. This replaces the old
 * high-load boundary check with an explicit per-task flag.
 *
 * Tasks with blocksConsecutive=true (Adanit, Hamama, Shemesh, Mamtera,
 * Aruga) require a buffer between them. Tasks with blocksConsecutive=false
 * (Karov, Karovit) can be placed adjacent to any task.
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

    if (current.task.blocksConsecutive && next.task.blocksConsecutive) {
      violations.push(
        violation(
          'CONSECUTIVE_HIGH_LOAD',
          `למשתתף ${participantId} משימות חוסמות עוקבות: "${current.task.name}" ו-"${next.task.name}" ללא הפסקה.`,
          next.task.id,
          undefined,
          participantId,
        ),
      );
    }
  }

  return violations;
}

// ─── Aggregate Validation ────────────────────────────────────────────────────

/**
 * Run ALL hard constraint checks against a complete schedule.
 * Returns aggregated violations — if any exist, the schedule is infeasible.
 */
export function validateHardConstraints(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  disabledHC?: Set<string>,
): ValidationResult {
  const allViolations: ConstraintViolation[] = [];
  const pMap = buildParticipantMap(participants);
  const tMap = buildTaskMap(tasks);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);

    // HC-6: All slots filled
    if (!disabledHC?.has('HC-6')) {
      allViolations.push(...checkSlotsFilled(task, assignments));
    }

    // HC-7: Unique participants per task
    if (!disabledHC?.has('HC-7')) {
      allViolations.push(...checkUniqueParticipantsPerTask(task, assignments));
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

    // HC-10 replaced by HC-13 (senior policy) — see below

    // HC-11: Choresh forbidden from Mamtera
    if (!disabledHC?.has('HC-11')) {
      const assignedParticipants = taskAssignments
        .map((a) => pMap.get(a.participantId))
        .filter((p): p is Participant => p !== undefined);
      allViolations.push(...checkChoreshExclusion(task, assignedParticipants));
    }

    // HC-4: Same group — mandatory for tasks with sameGroupRequired
    if (!disabledHC?.has('HC-4')) {
      const assignedParticipants = taskAssignments
        .map((a) => pMap.get(a.participantId))
        .filter((p): p is Participant => p !== undefined);
      allViolations.push(...checkSameGroup(task, assignedParticipants));
    }
  }

  // HC-5: Double booking (per participant)
  if (!disabledHC?.has('HC-5')) {
    for (const p of participants) {
      allViolations.push(...checkNoDoubleBooking(p.id, assignments, tMap));
    }
  }

  // HC-12: No consecutive high-load tasks (per participant)
  if (!disabledHC?.has('HC-12')) {
    for (const p of participants) {
      allViolations.push(...checkNoConsecutiveHighLoad(p.id, assignments, tMap));
    }
  }

  // HC-13: Senior hard blocks (L4 non-natural/non-Hamama, L3 Mamtera)
  if (!disabledHC?.has('HC-13')) {
    allViolations.push(...validateSeniorHardBlocks(participants, assignments, tasks));
  }

  return {
    valid: allViolations.length === 0,
    violations: allViolations,
  };
}
