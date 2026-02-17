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
  ValidationResult,
} from '../models/types';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';

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
      `Slot ${slotId} not found in task ${task.id}`,
      task.id,
      slotId,
      participant.id,
    );
  }
  // Accept explicit match OR "level higher than max listed" (e.g., L2 can fill an L0-only slot)
  const levelOk = slot.acceptableLevels.includes(participant.level)
    || participant.level > Math.max(...slot.acceptableLevels);
  if (!levelOk) {
    return violation(
      'LEVEL_MISMATCH',
      `Participant ${participant.name} (L${participant.level}) does not meet level requirement [${slot.acceptableLevels.map((l) => 'L' + l).join(',')}] for ${task.name} slot "${slot.label}"`,
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
        `Participant ${participant.name} lacks required certification "${cert}" for ${task.name} slot "${slot.label}"`,
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
      `Participant ${participant.name} is not available for the full duration of ${task.name}`,
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
        `Task ${task.name} requires all participants from the same group, but found groups: [${[...groups].join(', ')}]`,
        task.id,
      ),
    ];
  }
  return [];
}

/**
 * HC-10: Level 4 Exclusion — L4 participants are strictly forbidden from
 * Shemesh, Aruga, and Hamama tasks. This is a hard constraint, not a preference.
 */
export function checkL4Exclusion(
  task: Task,
  assignedParticipants: Participant[],
): ConstraintViolation[] {
  const forbiddenTypes: TaskType[] = [TaskType.Shemesh, TaskType.Aruga, TaskType.Hamama];
  if (!forbiddenTypes.includes(task.type)) return [];

  const violations: ConstraintViolation[] = [];
  for (const p of assignedParticipants) {
    if (p.level === Level.L4) {
      violations.push(
        violation(
          'L4_FORBIDDEN',
          `${p.name} (L4) is strictly forbidden from ${task.type} task "${task.name}"`,
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
    if (p.chopidr) {
      violations.push(
        violation(
          'CHORESH_FORBIDDEN_MAMTERA',
          `${p.name} is marked as Choresh and is strictly forbidden from Mamtera task "${task.name}"`,
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

  for (let i = 0; i < allWithTasks.length; i++) {
    for (let j = i + 1; j < allWithTasks.length; j++) {
      const taskA = taskMap.get(allWithTasks[i].taskId)!;
      const taskB = taskMap.get(allWithTasks[j].taskId)!;
      if (blocksOverlap(taskA.timeBlock, taskB.timeBlock)) {
        violations.push(
          violation(
            'DOUBLE_BOOKING',
            `Participant ${participantId} is double-booked: "${taskA.name}" and "${taskB.name}" overlap`,
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
          `Slot "${slot.label}" in ${task.name} has no participant assigned`,
          task.id,
          slot.slotId,
        ),
      );
    } else if (slotAssignments.length > 1) {
      violations.push(
        violation(
          'SLOT_OVERBOOKED',
          `Slot "${slot.label}" in ${task.name} has ${slotAssignments.length} participants (expected 1)`,
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
          `Participant ${a.participantId} is assigned multiple times to ${task.name}`,
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
 * Required: 4× L0, 1× L2+, 1× L3/L4 (total = 6)
 * Segol Main:      2× L0, 1× L3/L4
 * Segol Secondary: 2× L0, 1× L2+
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
        `Adanit task ${task.name}: group needs at least 6 participants with Nitzan certification, found ${nitzanHolders.length}. Missing Nitzan for Adanit.`,
        task.id,
      ),
    );
  }

  const levels = groupParticipants.map((p) => p.level);

  const l0Count = levels.filter((l) => l === Level.L0).length;
  const l2PlusCount = levels.filter(
    (l) => l === Level.L2 || l === Level.L3 || l === Level.L4,
  ).length;
  const l3l4Count = levels.filter((l) => l === Level.L3 || l === Level.L4).length;

  // Need: 4× L0 (2 per team), 1× L3/L4 (Segol Main), 1× L2+ (Segol Secondary)
  if (l0Count < 4) {
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L0',
        `Adanit task ${task.name}: group needs at least 4 L0 participants, found ${l0Count}. Missing L0 for Adanit.`,
        task.id,
      ),
    );
  }
  if (l3l4Count < 1) {
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L3L4',
        `Adanit task ${task.name}: group needs at least 1 L3/L4 participant (Segol Main), found ${l3l4Count}. Missing L3/L4 for Adanit.`,
        task.id,
      ),
    );
  }
  if (l2PlusCount < 2) {
    // Need 1× L3/L4 for Segol Main + 1× L2+ for Segol Secondary = 2 total L2+
    violations.push(
      violation(
        'ADANIT_INSUFFICIENT_L2PLUS',
        `Adanit task ${task.name}: group needs at least 2 participants at L2 or higher (1× L3/L4 for Main, 1× L2+ for Secondary), found ${l2PlusCount}. Missing L2+ for Adanit.`,
        task.id,
      ),
    );
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
): ValidationResult {
  const allViolations: ConstraintViolation[] = [];
  const pMap = buildParticipantMap(participants);
  const tMap = buildTaskMap(tasks);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);

    // HC-6: All slots filled
    allViolations.push(...checkSlotsFilled(task, assignments));

    // HC-7: Unique participants per task
    allViolations.push(...checkUniqueParticipantsPerTask(task, assignments));

    // Per-assignment checks
    for (const a of taskAssignments) {
      const participant = pMap.get(a.participantId);
      if (!participant) {
        allViolations.push(
          violation(
            'PARTICIPANT_NOT_FOUND',
            `Assignment references unknown participant ${a.participantId}`,
            task.id,
            a.slotId,
            a.participantId,
          ),
        );
        continue;
      }

      // HC-1: Level
      const levelV = checkLevelRequirement(participant, task, a.slotId);
      if (levelV) allViolations.push(levelV);

      // HC-2: Certifications
      const certV = checkCertificationRequirement(participant, task, a.slotId);
      if (certV) allViolations.push(certV);

      // HC-3: Availability
      const availV = checkAvailability(participant, task);
      if (availV) allViolations.push(availV);
    }

    // HC-4: Same group
    const assignedParticipants = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => p !== undefined);
    allViolations.push(...checkSameGroup(task, assignedParticipants));

    // HC-10: L4 forbidden from Shemesh/Aruga/Hamama
    allViolations.push(...checkL4Exclusion(task, assignedParticipants));

    // HC-11: Choresh forbidden from Mamtera
    allViolations.push(...checkChoreshExclusion(task, assignedParticipants));
  }

  // HC-5: Double booking (per participant)
  for (const p of participants) {
    allViolations.push(...checkNoDoubleBooking(p.id, assignments, tMap));
  }

  return {
    valid: allViolations.length === 0,
    violations: allViolations,
  };
}
