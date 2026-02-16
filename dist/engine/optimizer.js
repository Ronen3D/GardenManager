"use strict";
/**
 * Optimizer - Max-Min Fairness scheduler with penalty/bonus heuristics.
 *
 * Uses a greedy constructive heuristic followed by local search (swap-based)
 * to maximize the composite score (rest fairness + penalties + bonuses).
 *
 * Algorithm:
 *  1. Greedy Phase: Assign participants to task slots respecting hard constraints,
 *     using a priority that favors participants with the most accumulated rest.
 *  2. Local Search Phase: Iteratively try swaps between assignments to improve
 *     composite score, accepting improvements only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetAssignmentCounter = resetAssignmentCounter;
exports.greedyAssign = greedyAssign;
exports.localSearchOptimize = localSearchOptimize;
exports.optimize = optimize;
const types_1 = require("../models/types");
const time_utils_1 = require("../utils/time-utils");
const hard_constraints_1 = require("../constraints/hard-constraints");
const soft_constraints_1 = require("../constraints/soft-constraints");
let _assignmentCounter = 0;
function nextAssignmentId() {
    return `asgn-${++_assignmentCounter}`;
}
/** Reset counter (for testing) */
function resetAssignmentCounter() {
    _assignmentCounter = 0;
}
// ─── Eligibility Checks ─────────────────────────────────────────────────────
/**
 * Check if a participant is eligible for a specific slot in a task,
 * considering current assignments (no double-booking of non-light tasks).
 */
function isEligibleForSlot(participant, task, slot, currentAssignments, taskMap) {
    // Level check
    if (!slot.acceptableLevels.includes(participant.level))
        return false;
    // Certification check
    for (const cert of slot.requiredCertifications) {
        if (!participant.certifications.includes(cert))
            return false;
    }
    // Availability check
    if (!(0, time_utils_1.isFullyCovered)(task.timeBlock, participant.availability))
        return false;
    // Double-booking check (non-light tasks only)
    if (!task.isLight) {
        const participantNonLight = currentAssignments.filter((a) => {
            if (a.participantId !== participant.id)
                return false;
            const t = taskMap.get(a.taskId);
            return t && !t.isLight;
        });
        for (const a of participantNonLight) {
            const otherTask = taskMap.get(a.taskId);
            if ((0, time_utils_1.blocksOverlap)(task.timeBlock, otherTask.timeBlock))
                return false;
        }
    }
    // Already assigned to this task?
    const alreadyInTask = currentAssignments.some((a) => a.taskId === task.id && a.participantId === participant.id);
    if (alreadyInTask)
        return false;
    return true;
}
/**
 * Get all eligible participants for a slot, sorted by priority.
 */
function getEligibleCandidates(task, slot, participants, currentAssignments, taskMap, participantWorkload) {
    const eligible = participants.filter((p) => isEligibleForSlot(p, task, slot, currentAssignments, taskMap));
    // Sort by workload (ascending = less work first) for fairness
    eligible.sort((a, b) => {
        const wa = participantWorkload.get(a.id) || 0;
        const wb = participantWorkload.get(b.id) || 0;
        return wa - wb;
    });
    // For Hamama: prioritize L0 over L3 over L4
    if (task.type === types_1.TaskType.Hamama) {
        eligible.sort((a, b) => {
            const priority = (l) => {
                if (l === types_1.Level.L0)
                    return 0;
                if (l === types_1.Level.L3)
                    return 1;
                if (l === types_1.Level.L4)
                    return 2;
                return 3;
            };
            return priority(a.level) - priority(b.level);
        });
    }
    return eligible;
}
// ─── Greedy Phase ────────────────────────────────────────────────────────────
/**
 * Sort tasks for assignment order. Constrained tasks first:
 * Adanit (same-group, complex), then Hamama, then others.
 */
function sortTasksByDifficulty(tasks) {
    const priority = {
        [types_1.TaskType.Adanit]: 0,
        [types_1.TaskType.Hamama]: 1,
        [types_1.TaskType.Karov]: 2,
        [types_1.TaskType.Mamtera]: 3,
        [types_1.TaskType.Shemesh]: 4,
        [types_1.TaskType.Aruga]: 5,
        [types_1.TaskType.Karovit]: 6,
    };
    return [...tasks].sort((a, b) => {
        const pa = priority[a.type] ?? 99;
        const pb = priority[b.type] ?? 99;
        if (pa !== pb)
            return pa - pb;
        return a.timeBlock.start.getTime() - b.timeBlock.start.getTime();
    });
}
/**
 * Greedy construction: assign participants to all task slots.
 * Returns assignments (may be partial if infeasible).
 */
function greedyAssign(tasks, participants, lockedAssignments = []) {
    const taskMap = new Map();
    for (const t of tasks)
        taskMap.set(t.id, t);
    const assignments = [...lockedAssignments];
    const unfilledSlots = [];
    // Track workload
    const workload = new Map();
    for (const p of participants)
        workload.set(p.id, 0);
    for (const a of lockedAssignments) {
        const task = taskMap.get(a.taskId);
        if (task && !task.isLight) {
            workload.set(a.participantId, (workload.get(a.participantId) || 0) + 1);
        }
    }
    const sortedTasks = sortTasksByDifficulty(tasks);
    for (const task of sortedTasks) {
        // For same-group tasks (Adanit), we need special handling
        if (task.sameGroupRequired) {
            const assigned = assignSameGroupTask(task, participants, assignments, taskMap, workload);
            if (!assigned) {
                // Mark all slots as unfilled
                for (const slot of task.slots) {
                    const alreadyFilled = assignments.some((a) => a.taskId === task.id && a.slotId === slot.slotId);
                    if (!alreadyFilled) {
                        unfilledSlots.push({ taskId: task.id, slotId: slot.slotId });
                    }
                }
            }
            continue;
        }
        // Standard slot-by-slot assignment
        for (const slot of task.slots) {
            // Skip if already assigned (locked)
            const existing = assignments.find((a) => a.taskId === task.id && a.slotId === slot.slotId);
            if (existing)
                continue;
            const candidates = getEligibleCandidates(task, slot, participants, assignments, taskMap, workload);
            if (candidates.length > 0) {
                const chosen = candidates[0];
                assignments.push({
                    id: nextAssignmentId(),
                    taskId: task.id,
                    slotId: slot.slotId,
                    participantId: chosen.id,
                    status: types_1.AssignmentStatus.Scheduled,
                    updatedAt: new Date(),
                });
                if (!task.isLight) {
                    workload.set(chosen.id, (workload.get(chosen.id) || 0) + 1);
                }
            }
            else {
                unfilledSlots.push({ taskId: task.id, slotId: slot.slotId });
            }
        }
    }
    return { assignments, unfilledSlots };
}
/**
 * Special handler for same-group tasks like Adanit.
 * Tries each group and picks the first one that can fill all slots.
 */
function assignSameGroupTask(task, participants, currentAssignments, taskMap, workload) {
    // Already have some locked assignments for this task?
    const lockedForTask = currentAssignments.filter((a) => a.taskId === task.id);
    const lockedSlotIds = new Set(lockedForTask.map((a) => a.slotId));
    // If locked assignments exist, determine the required group
    let requiredGroup;
    if (lockedForTask.length > 0) {
        const groups = new Set();
        for (const a of lockedForTask) {
            const p = participants.find((pp) => pp.id === a.participantId);
            if (p)
                groups.add(p.group);
        }
        if (groups.size === 1) {
            requiredGroup = [...groups][0];
        }
    }
    // Collect all groups
    const allGroups = [...new Set(participants.map((p) => p.group))];
    const groupsToTry = requiredGroup ? [requiredGroup] : allGroups;
    // Sort groups by total workload (ascending) for fairness
    groupsToTry.sort((ga, gb) => {
        const wa = participants
            .filter((p) => p.group === ga)
            .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
        const wb = participants
            .filter((p) => p.group === gb)
            .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
        return wa - wb;
    });
    for (const group of groupsToTry) {
        const groupParticipants = participants.filter((p) => p.group === group);
        const tempAssignments = [];
        let success = true;
        for (const slot of task.slots) {
            if (lockedSlotIds.has(slot.slotId))
                continue;
            const candidates = getEligibleCandidates(task, slot, groupParticipants, [...currentAssignments, ...tempAssignments], taskMap, workload);
            if (candidates.length > 0) {
                tempAssignments.push({
                    id: nextAssignmentId(),
                    taskId: task.id,
                    slotId: slot.slotId,
                    participantId: candidates[0].id,
                    status: types_1.AssignmentStatus.Scheduled,
                    updatedAt: new Date(),
                });
            }
            else {
                success = false;
                break;
            }
        }
        if (success) {
            // Commit temporary assignments
            for (const a of tempAssignments) {
                currentAssignments.push(a);
                const t = taskMap.get(a.taskId);
                if (t && !t.isLight) {
                    workload.set(a.participantId, (workload.get(a.participantId) || 0) + 1);
                }
            }
            return true;
        }
        // else: try next group
    }
    return false;
}
// ─── Local Search Phase ──────────────────────────────────────────────────────
/**
 * Try to improve the schedule by swapping participants between assignments.
 * Only accepts improvements to composite score.
 */
function localSearchOptimize(tasks, participants, assignments, config) {
    let best = [...assignments.map((a) => ({ ...a }))];
    let bestScore = (0, soft_constraints_1.computeScheduleScore)(tasks, participants, best, config);
    const taskMap = new Map();
    for (const t of tasks)
        taskMap.set(t.id, t);
    const startTime = Date.now();
    let iterations = 0;
    let improved = true;
    while (improved && iterations < config.maxIterations) {
        if (Date.now() - startTime > config.maxSolverTimeMs)
            break;
        improved = false;
        // Try swapping each pair of assignments that are in different tasks
        for (let i = 0; i < best.length && !improved; i++) {
            for (let j = i + 1; j < best.length && !improved; j++) {
                iterations++;
                if (iterations > config.maxIterations)
                    break;
                if (Date.now() - startTime > config.maxSolverTimeMs)
                    break;
                const ai = best[i];
                const aj = best[j];
                // Skip locked/manual assignments
                if (ai.status === types_1.AssignmentStatus.Locked || ai.status === types_1.AssignmentStatus.Manual)
                    continue;
                if (aj.status === types_1.AssignmentStatus.Locked || aj.status === types_1.AssignmentStatus.Manual)
                    continue;
                // Skip if same participant
                if (ai.participantId === aj.participantId)
                    continue;
                // Try swap
                const candidate = best.map((a) => ({ ...a }));
                candidate[i] = { ...candidate[i], participantId: aj.participantId, updatedAt: new Date() };
                candidate[j] = { ...candidate[j], participantId: ai.participantId, updatedAt: new Date() };
                // Validate hard constraints quickly
                const validation = (0, hard_constraints_1.validateHardConstraints)(tasks, participants, candidate);
                if (!validation.valid)
                    continue;
                // Score the candidate
                const candidateScore = (0, soft_constraints_1.computeScheduleScore)(tasks, participants, candidate, config);
                if (candidateScore.compositeScore > bestScore.compositeScore) {
                    best = candidate;
                    bestScore = candidateScore;
                    improved = true;
                }
            }
        }
    }
    return best;
}
/**
 * Full optimization pipeline: greedy + local search.
 */
function optimize(tasks, participants, config, lockedAssignments = []) {
    const startTime = Date.now();
    // Phase 1: Greedy construction
    const greedy = greedyAssign(tasks, participants, lockedAssignments);
    // Phase 2: Local search improvement
    const improved = localSearchOptimize(tasks, participants, greedy.assignments, config);
    // Validate final result
    const validation = (0, hard_constraints_1.validateHardConstraints)(tasks, participants, improved);
    const score = (0, soft_constraints_1.computeScheduleScore)(tasks, participants, improved, config);
    return {
        assignments: improved,
        score,
        feasible: validation.valid && greedy.unfilledSlots.length === 0,
        unfilledSlots: greedy.unfilledSlots,
        iterations: 0, // Could track this in localSearch if needed
        durationMs: Date.now() - startTime,
    };
}
//# sourceMappingURL=optimizer.js.map