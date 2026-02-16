"use strict";
/**
 * Hard Constraint Validators
 *
 * If any hard constraint is violated, the schedule is INVALID.
 * Returns ConstraintViolation[] with severity=Error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkLevelRequirement = checkLevelRequirement;
exports.checkCertificationRequirement = checkCertificationRequirement;
exports.checkAvailability = checkAvailability;
exports.checkSameGroup = checkSameGroup;
exports.checkNoDoubleBooking = checkNoDoubleBooking;
exports.checkSlotsFilled = checkSlotsFilled;
exports.checkUniqueParticipantsPerTask = checkUniqueParticipantsPerTask;
exports.checkAdanitGroupFeasibility = checkAdanitGroupFeasibility;
exports.validateHardConstraints = validateHardConstraints;
const types_1 = require("../models/types");
const time_utils_1 = require("../utils/time-utils");
// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildParticipantMap(participants) {
    const map = new Map();
    for (const p of participants)
        map.set(p.id, p);
    return map;
}
function buildTaskMap(tasks) {
    const map = new Map();
    for (const t of tasks)
        map.set(t.id, t);
    return map;
}
function violation(code, message, taskId, slotId, participantId) {
    return { severity: types_1.ViolationSeverity.Error, code, message, taskId, slotId, participantId };
}
// ─── Individual Constraint Checks ────────────────────────────────────────────
/**
 * HC-1: Level requirement — participant's level must match slot's acceptableLevels.
 */
function checkLevelRequirement(participant, task, slotId) {
    const slot = task.slots.find((s) => s.slotId === slotId);
    if (!slot) {
        return violation('SLOT_NOT_FOUND', `Slot ${slotId} not found in task ${task.id}`, task.id, slotId, participant.id);
    }
    if (!slot.acceptableLevels.includes(participant.level)) {
        return violation('LEVEL_MISMATCH', `Participant ${participant.name} (L${participant.level}) does not meet level requirement [${slot.acceptableLevels.map((l) => 'L' + l).join(',')}] for ${task.name} slot "${slot.label}"`, task.id, slotId, participant.id);
    }
    return null;
}
/**
 * HC-2: Certification requirement — participant must hold all required certs.
 */
function checkCertificationRequirement(participant, task, slotId) {
    const slot = task.slots.find((s) => s.slotId === slotId);
    if (!slot)
        return null;
    for (const cert of slot.requiredCertifications) {
        if (!participant.certifications.includes(cert)) {
            return violation('CERT_MISSING', `Participant ${participant.name} lacks required certification "${cert}" for ${task.name} slot "${slot.label}"`, task.id, slotId, participant.id);
        }
    }
    return null;
}
/**
 * HC-3: Availability — participant must be available for entire task duration.
 */
function checkAvailability(participant, task) {
    if (!(0, time_utils_1.isFullyCovered)(task.timeBlock, participant.availability)) {
        return violation('AVAILABILITY_VIOLATION', `Participant ${participant.name} is not available for the full duration of ${task.name}`, task.id, undefined, participant.id);
    }
    return null;
}
/**
 * HC-4: Same group constraint (Adanit) — all participants in task must share one group.
 */
function checkSameGroup(task, assignedParticipants) {
    if (!task.sameGroupRequired || assignedParticipants.length === 0)
        return [];
    const groups = new Set(assignedParticipants.map((p) => p.group));
    if (groups.size > 1) {
        return [
            violation('GROUP_MISMATCH', `Task ${task.name} requires all participants from the same group, but found groups: [${[...groups].join(', ')}]`, task.id),
        ];
    }
    return [];
}
/**
 * HC-5: No double-booking — a participant cannot be assigned to two overlapping
 * non-light tasks at the same time. Light tasks (Karovit) can overlap with anything.
 */
function checkNoDoubleBooking(participantId, assignments, taskMap) {
    const violations = [];
    const participantAssignments = assignments.filter((a) => a.participantId === participantId);
    // Get non-light assignments
    const nonLightAssignments = participantAssignments.filter((a) => {
        const task = taskMap.get(a.taskId);
        return task && !task.isLight;
    });
    for (let i = 0; i < nonLightAssignments.length; i++) {
        for (let j = i + 1; j < nonLightAssignments.length; j++) {
            const taskA = taskMap.get(nonLightAssignments[i].taskId);
            const taskB = taskMap.get(nonLightAssignments[j].taskId);
            if ((0, time_utils_1.blocksOverlap)(taskA.timeBlock, taskB.timeBlock)) {
                violations.push(violation('DOUBLE_BOOKING', `Participant ${participantId} is double-booked: "${taskA.name}" and "${taskB.name}" overlap`, taskA.id, undefined, participantId));
            }
        }
    }
    return violations;
}
/**
 * HC-6: Slot fill — every slot in a task must be assigned exactly one participant.
 */
function checkSlotsFilled(task, assignments) {
    const violations = [];
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    for (const slot of task.slots) {
        const slotAssignments = taskAssignments.filter((a) => a.slotId === slot.slotId);
        if (slotAssignments.length === 0) {
            violations.push(violation('SLOT_UNFILLED', `Slot "${slot.label}" in ${task.name} has no participant assigned`, task.id, slot.slotId));
        }
        else if (slotAssignments.length > 1) {
            violations.push(violation('SLOT_OVERBOOKED', `Slot "${slot.label}" in ${task.name} has ${slotAssignments.length} participants (expected 1)`, task.id, slot.slotId));
        }
    }
    return violations;
}
/**
 * HC-7: Unique participant per task — no participant assigned twice to the same task.
 */
function checkUniqueParticipantsPerTask(task, assignments) {
    const violations = [];
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const seen = new Set();
    for (const a of taskAssignments) {
        if (seen.has(a.participantId)) {
            violations.push(violation('DUPLICATE_IN_TASK', `Participant ${a.participantId} is assigned multiple times to ${task.name}`, task.id, a.slotId, a.participantId));
        }
        seen.add(a.participantId);
    }
    return violations;
}
/**
 * HC-8: Adanit group feasibility — the assigned group must have enough participants
 * at the required levels.
 */
function checkAdanitGroupFeasibility(task, groupParticipants) {
    if (task.type !== types_1.TaskType.Adanit)
        return [];
    const violations = [];
    const levels = groupParticipants.map((p) => p.level);
    const l0Count = levels.filter((l) => l === types_1.Level.L0).length;
    const l1Count = levels.filter((l) => l === types_1.Level.L1).length;
    const l3l4Count = levels.filter((l) => l === types_1.Level.L3 || l === types_1.Level.L4).length;
    // Need: 5× L0, 1× L1, 2× L3/L4
    if (l0Count < 5) {
        violations.push(violation('ADANIT_INSUFFICIENT_L0', `Adanit task ${task.name}: group needs at least 5 L0 participants, found ${l0Count}`, task.id));
    }
    if (l1Count < 1) {
        violations.push(violation('ADANIT_INSUFFICIENT_L1', `Adanit task ${task.name}: group needs at least 1 L1 participant, found ${l1Count}`, task.id));
    }
    if (l3l4Count < 2) {
        violations.push(violation('ADANIT_INSUFFICIENT_L3L4', `Adanit task ${task.name}: group needs at least 2 L3/L4 participants, found ${l3l4Count}`, task.id));
    }
    return violations;
}
// ─── Aggregate Validation ────────────────────────────────────────────────────
/**
 * Run ALL hard constraint checks against a complete schedule.
 * Returns aggregated violations — if any exist, the schedule is infeasible.
 */
function validateHardConstraints(tasks, participants, assignments) {
    const allViolations = [];
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
                allViolations.push(violation('PARTICIPANT_NOT_FOUND', `Assignment references unknown participant ${a.participantId}`, task.id, a.slotId, a.participantId));
                continue;
            }
            // HC-1: Level
            const levelV = checkLevelRequirement(participant, task, a.slotId);
            if (levelV)
                allViolations.push(levelV);
            // HC-2: Certifications
            const certV = checkCertificationRequirement(participant, task, a.slotId);
            if (certV)
                allViolations.push(certV);
            // HC-3: Availability
            const availV = checkAvailability(participant, task);
            if (availV)
                allViolations.push(availV);
        }
        // HC-4: Same group
        const assignedParticipants = taskAssignments
            .map((a) => pMap.get(a.participantId))
            .filter((p) => p !== undefined);
        allViolations.push(...checkSameGroup(task, assignedParticipants));
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
//# sourceMappingURL=hard-constraints.js.map