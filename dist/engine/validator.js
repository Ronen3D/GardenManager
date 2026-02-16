"use strict";
/**
 * Validator - Standalone validation module for real-time constraint checking.
 *
 * Used after every manual override to verify schedule integrity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullValidate = fullValidate;
exports.previewSwap = previewSwap;
exports.getEligibleParticipantsForSlot = getEligibleParticipantsForSlot;
const hard_constraints_1 = require("../constraints/hard-constraints");
const soft_constraints_1 = require("../constraints/soft-constraints");
const time_utils_1 = require("../utils/time-utils");
/**
 * Run a full validation (hard + soft) on a schedule.
 */
function fullValidate(tasks, participants, assignments) {
    const hard = (0, hard_constraints_1.validateHardConstraints)(tasks, participants, assignments);
    const warnings = (0, soft_constraints_1.collectSoftWarnings)(tasks, participants, assignments);
    const hardCount = hard.violations.length;
    const warnCount = warnings.length;
    let summary;
    if (hardCount === 0 && warnCount === 0) {
        summary = 'Schedule is valid with no issues.';
    }
    else if (hardCount === 0) {
        summary = `Schedule is valid but has ${warnCount} warning(s).`;
    }
    else {
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
function previewSwap(tasks, participants, assignments, swap) {
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
function getEligibleParticipantsForSlot(task, slotId, participants, currentAssignments, tasks) {
    const slot = task.slots.find((s) => s.slotId === slotId);
    if (!slot)
        return [];
    const taskMap = new Map();
    for (const t of tasks)
        taskMap.set(t.id, t);
    return participants.filter((p) => {
        // Level check
        if (!slot.acceptableLevels.includes(p.level))
            return false;
        // Certification check
        for (const cert of slot.requiredCertifications) {
            if (!p.certifications.includes(cert))
                return false;
        }
        // Availability check
        if (!(0, time_utils_1.isFullyCovered)(task.timeBlock, p.availability))
            return false;
        // Same-group check for Adanit
        if (task.sameGroupRequired) {
            const existingAssignments = currentAssignments.filter((a) => a.taskId === task.id && a.slotId !== slotId);
            if (existingAssignments.length > 0) {
                const existingParticipant = participants.find((pp) => pp.id === existingAssignments[0].participantId);
                if (existingParticipant && existingParticipant.group !== p.group)
                    return false;
            }
        }
        // Double-booking check for non-light tasks
        if (!task.isLight) {
            const participantAssignments = currentAssignments.filter((a) => a.participantId === p.id && a.taskId !== task.id);
            for (const a of participantAssignments) {
                const otherTask = taskMap.get(a.taskId);
                if (otherTask && !otherTask.isLight) {
                    if ((0, time_utils_1.blocksOverlap)(task.timeBlock, otherTask.timeBlock))
                        return false;
                }
            }
        }
        // Not already assigned to this task
        if (currentAssignments.some((a) => a.taskId === task.id && a.participantId === p.id)) {
            return false;
        }
        return true;
    });
}
//# sourceMappingURL=validator.js.map