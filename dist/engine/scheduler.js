"use strict";
/**
 * Scheduling Engine - Main orchestrator class.
 *
 * Two-stage workflow:
 *  Stage 1: Data Setup — register participants and tasks.
 *  Stage 2: Optimal Generation — generate schedule, with manual overrides.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchedulingEngine = void 0;
const types_1 = require("../models/types");
const hard_constraints_1 = require("../constraints/hard-constraints");
const soft_constraints_1 = require("../constraints/soft-constraints");
const optimizer_1 = require("./optimizer");
class SchedulingEngine {
    constructor(config = {}) {
        this.participants = new Map();
        this.tasks = new Map();
        this.currentSchedule = null;
        this.config = { ...types_1.DEFAULT_CONFIG, ...config };
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // Stage 1: Data Setup
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Add or update a participant.
     */
    addParticipant(participant) {
        this.participants.set(participant.id, participant);
    }
    /**
     * Add multiple participants.
     */
    addParticipants(participants) {
        for (const p of participants)
            this.addParticipant(p);
    }
    /**
     * Remove a participant by ID.
     */
    removeParticipant(id) {
        return this.participants.delete(id);
    }
    /**
     * Get a participant by ID.
     */
    getParticipant(id) {
        return this.participants.get(id);
    }
    /**
     * Get all participants.
     */
    getAllParticipants() {
        return [...this.participants.values()];
    }
    /**
     * Add or update a task.
     */
    addTask(task) {
        this.tasks.set(task.id, task);
    }
    /**
     * Add multiple tasks.
     */
    addTasks(tasks) {
        for (const t of tasks)
            this.addTask(t);
    }
    /**
     * Remove a task by ID.
     */
    removeTask(id) {
        return this.tasks.delete(id);
    }
    /**
     * Get a task by ID.
     */
    getTask(id) {
        return this.tasks.get(id);
    }
    /**
     * Get all tasks.
     */
    getAllTasks() {
        return [...this.tasks.values()];
    }
    /**
     * Clear all data (reset to initial state).
     */
    reset() {
        this.participants.clear();
        this.tasks.clear();
        this.currentSchedule = null;
        (0, optimizer_1.resetAssignmentCounter)();
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // Stage 2: Schedule Generation & Optimization
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Generate an optimized schedule from the current participants and tasks.
     * This is the main entry point for schedule creation.
     */
    generateSchedule() {
        const tasks = this.getAllTasks();
        const participants = this.getAllParticipants();
        if (tasks.length === 0) {
            throw new Error('No tasks registered. Add tasks before generating a schedule.');
        }
        if (participants.length === 0) {
            throw new Error('No participants registered. Add participants before generating a schedule.');
        }
        const result = (0, optimizer_1.optimize)(tasks, participants, this.config);
        // Collect all violations
        const hardValidation = (0, hard_constraints_1.validateHardConstraints)(tasks, participants, result.assignments);
        const softWarnings = (0, soft_constraints_1.collectSoftWarnings)(tasks, participants, result.assignments);
        const allViolations = [
            ...hardValidation.violations,
            ...softWarnings,
        ];
        // Add infeasibility alerts for unfilled slots
        for (const { taskId, slotId } of result.unfilledSlots) {
            const task = this.tasks.get(taskId);
            const slot = task?.slots.find((s) => s.slotId === slotId);
            allViolations.push({
                severity: types_1.ViolationSeverity.Error,
                code: 'INFEASIBLE_SLOT',
                message: `Infeasible Schedule: Cannot fill slot "${slot?.label ?? slotId}" in task "${task?.name ?? taskId}". No eligible participants available.`,
                taskId,
                slotId,
            });
        }
        const schedule = {
            id: `schedule-${Date.now()}`,
            tasks,
            participants,
            assignments: result.assignments,
            feasible: result.feasible,
            score: result.score,
            violations: allViolations,
            generatedAt: new Date(),
        };
        this.currentSchedule = schedule;
        return schedule;
    }
    /**
     * Get the current schedule (if generated).
     */
    getSchedule() {
        return this.currentSchedule;
    }
    // ═══════════════════════════════════════════════════════════════════════════
    // Real-time Adjustments
    // ═══════════════════════════════════════════════════════════════════════════
    /**
     * Validate the current schedule's hard constraints.
     * Call after every manual change.
     */
    validate() {
        if (!this.currentSchedule) {
            return { valid: false, violations: [{ severity: types_1.ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'No schedule has been generated yet.', taskId: '' }] };
        }
        return (0, hard_constraints_1.validateHardConstraints)(this.currentSchedule.tasks, this.currentSchedule.participants, this.currentSchedule.assignments);
    }
    /**
     * Swap a participant in an existing assignment (manual override).
     * Runs validate() after the swap and returns the result.
     */
    swapParticipant(request) {
        if (!this.currentSchedule) {
            return { valid: false, violations: [{ severity: types_1.ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'No schedule exists to modify.', taskId: '' }] };
        }
        const assignment = this.currentSchedule.assignments.find((a) => a.id === request.assignmentId);
        if (!assignment) {
            return {
                valid: false,
                violations: [{
                        severity: types_1.ViolationSeverity.Error,
                        code: 'ASSIGNMENT_NOT_FOUND',
                        message: `Assignment ${request.assignmentId} not found.`,
                        taskId: '',
                    }],
            };
        }
        const newParticipant = this.participants.get(request.newParticipantId);
        if (!newParticipant) {
            return {
                valid: false,
                violations: [{
                        severity: types_1.ViolationSeverity.Error,
                        code: 'PARTICIPANT_NOT_FOUND',
                        message: `Participant ${request.newParticipantId} not found.`,
                        taskId: assignment.taskId,
                    }],
            };
        }
        // Perform the swap
        assignment.participantId = request.newParticipantId;
        assignment.status = types_1.AssignmentStatus.Manual;
        assignment.updatedAt = new Date();
        // Re-validate
        const validation = this.validate();
        // Update score
        this.currentSchedule.score = (0, soft_constraints_1.computeScheduleScore)(this.currentSchedule.tasks, this.currentSchedule.participants, this.currentSchedule.assignments, this.config);
        this.currentSchedule.feasible = validation.valid;
        this.currentSchedule.violations = [
            ...validation.violations,
            ...(0, soft_constraints_1.collectSoftWarnings)(this.currentSchedule.tasks, this.currentSchedule.participants, this.currentSchedule.assignments),
        ];
        return validation;
    }
    /**
     * Partial re-schedule: lock existing assignments and re-optimize only affected slots.
     * Used when a participant becomes unavailable mid-day.
     */
    partialReSchedule(request) {
        if (!this.currentSchedule) {
            throw new Error('No schedule exists to partially re-schedule.');
        }
        const { lockedAssignmentIds, unavailableParticipantIds } = request;
        const unavailableSet = new Set(unavailableParticipantIds);
        // Separate locked assignments from those that need re-assignment
        const lockedAssignments = [];
        const needsReassignment = [];
        for (const a of this.currentSchedule.assignments) {
            if (lockedAssignmentIds.includes(a.id)) {
                // Keep locked unless the participant is unavailable
                if (unavailableSet.has(a.participantId)) {
                    needsReassignment.push(a);
                }
                else {
                    lockedAssignments.push({ ...a, status: types_1.AssignmentStatus.Locked });
                }
            }
            else if (unavailableSet.has(a.participantId)) {
                needsReassignment.push(a);
            }
            else {
                lockedAssignments.push({ ...a, status: types_1.AssignmentStatus.Locked });
            }
        }
        // Filter out unavailable participants
        const availableParticipants = this.getAllParticipants().filter((p) => !unavailableSet.has(p.id));
        // Re-optimize with locked assignments
        const result = (0, optimizer_1.optimize)(this.currentSchedule.tasks, availableParticipants, this.config, lockedAssignments);
        // Validate
        const hardValidation = (0, hard_constraints_1.validateHardConstraints)(this.currentSchedule.tasks, this.getAllParticipants(), result.assignments);
        const softWarnings = (0, soft_constraints_1.collectSoftWarnings)(this.currentSchedule.tasks, this.getAllParticipants(), result.assignments);
        const schedule = {
            id: `schedule-${Date.now()}`,
            tasks: this.currentSchedule.tasks,
            participants: this.getAllParticipants(),
            assignments: result.assignments,
            feasible: result.feasible,
            score: result.score,
            violations: [...hardValidation.violations, ...softWarnings],
            generatedAt: new Date(),
        };
        this.currentSchedule = schedule;
        return schedule;
    }
    /**
     * Lock a specific assignment (prevent it from being changed by optimizer).
     */
    lockAssignment(assignmentId) {
        if (!this.currentSchedule)
            return false;
        const assignment = this.currentSchedule.assignments.find((a) => a.id === assignmentId);
        if (!assignment)
            return false;
        assignment.status = types_1.AssignmentStatus.Locked;
        assignment.updatedAt = new Date();
        return true;
    }
    /**
     * Unlock a specific assignment.
     */
    unlockAssignment(assignmentId) {
        if (!this.currentSchedule)
            return false;
        const assignment = this.currentSchedule.assignments.find((a) => a.id === assignmentId);
        if (!assignment)
            return false;
        assignment.status = types_1.AssignmentStatus.Scheduled;
        assignment.updatedAt = new Date();
        return true;
    }
    /**
     * Get schedule statistics summary.
     */
    getStats() {
        const s = this.currentSchedule;
        return {
            totalTasks: this.tasks.size,
            totalParticipants: this.participants.size,
            totalAssignments: s?.assignments.length ?? 0,
            feasible: s?.feasible ?? false,
            hardViolations: s?.violations.filter((v) => v.severity === types_1.ViolationSeverity.Error).length ?? 0,
            softWarnings: s?.violations.filter((v) => v.severity === types_1.ViolationSeverity.Warning).length ?? 0,
            score: s?.score ?? null,
        };
    }
}
exports.SchedulingEngine = SchedulingEngine;
//# sourceMappingURL=scheduler.js.map