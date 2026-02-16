"use strict";
/**
 * Soft Constraint Scorers
 *
 * These produce numeric scores (penalties / bonuses) that guide
 * the optimizer toward better schedules without making them invalid.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hamamaPenalty = hamamaPenalty;
exports.shemeshGroupBonus = shemeshGroupBonus;
exports.workloadImbalancePenalty = workloadImbalancePenalty;
exports.collectSoftWarnings = collectSoftWarnings;
exports.computeScheduleScore = computeScheduleScore;
const types_1 = require("../models/types");
const rest_calculator_1 = require("../utils/rest-calculator");
// ─── Individual Penalty Functions ────────────────────────────────────────────
/**
 * SC-1: Hamama penalty — penalise assigning L3/L4 to Hamama.
 * Best: L0 (0 penalty), Acceptable: L3 (high), Avoid: L4 (extreme).
 */
function hamamaPenalty(task, participant, config) {
    if (task.type !== types_1.TaskType.Hamama)
        return 0;
    if (participant.level === types_1.Level.L3)
        return config.hamamaL3Penalty;
    if (participant.level === types_1.Level.L4)
        return config.hamamaL4Penalty;
    return 0;
}
/**
 * SC-2: Shemesh same-group bonus — reward when both Shemesh participants share a group.
 */
function shemeshGroupBonus(task, assignedParticipants, config) {
    if (task.type !== types_1.TaskType.Shemesh)
        return 0;
    if (assignedParticipants.length < 2)
        return 0;
    const groups = new Set(assignedParticipants.map((p) => p.group));
    return groups.size === 1 ? config.shemeshSameGroupBonus : 0;
}
/**
 * SC-3: Workload balance — penalize uneven distribution of non-light assignments.
 * Returns a penalty proportional to the standard deviation of assignment counts.
 */
function workloadImbalancePenalty(participants, assignments, tasks) {
    const taskMap = new Map();
    for (const t of tasks)
        taskMap.set(t.id, t);
    const counts = participants.map((p) => {
        return assignments.filter((a) => {
            const task = taskMap.get(a.taskId);
            return a.participantId === p.id && task && !task.isLight;
        }).length;
    });
    if (counts.length === 0)
        return 0;
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, c) => sum + (c - avg) ** 2, 0) / counts.length;
    return Math.sqrt(variance) * 2; // Scaled penalty
}
// ─── Soft Constraint Warnings ────────────────────────────────────────────────
/**
 * Generate warnings (non-fatal) for soft constraint issues.
 */
function collectSoftWarnings(tasks, participants, assignments) {
    const warnings = [];
    const pMap = new Map();
    for (const p of participants)
        pMap.set(p.id, p);
    const tMap = new Map();
    for (const t of tasks)
        tMap.set(t.id, t);
    for (const task of tasks) {
        const taskAssignments = assignments.filter((a) => a.taskId === task.id);
        const assignedPs = taskAssignments
            .map((a) => pMap.get(a.participantId))
            .filter((p) => !!p);
        // Hamama L3/L4 warning
        if (task.type === types_1.TaskType.Hamama) {
            for (const p of assignedPs) {
                if (p.level === types_1.Level.L3) {
                    warnings.push({
                        severity: types_1.ViolationSeverity.Warning,
                        code: 'HAMAMA_L3',
                        message: `${p.name} (L3) assigned to Hamama — high penalty. Prefer L0.`,
                        taskId: task.id,
                        participantId: p.id,
                    });
                }
                if (p.level === types_1.Level.L4) {
                    warnings.push({
                        severity: types_1.ViolationSeverity.Warning,
                        code: 'HAMAMA_L4',
                        message: `${p.name} (L4) assigned to Hamama — extreme penalty. Avoid at all costs.`,
                        taskId: task.id,
                        participantId: p.id,
                    });
                }
            }
        }
        // Shemesh different groups warning
        if (task.type === types_1.TaskType.Shemesh && assignedPs.length >= 2) {
            const groups = new Set(assignedPs.map((p) => p.group));
            if (groups.size > 1) {
                warnings.push({
                    severity: types_1.ViolationSeverity.Warning,
                    code: 'SHEMESH_MIXED_GROUP',
                    message: `Shemesh ${task.name}: participants from different groups [${[...groups].join(', ')}]. Prefer same group.`,
                    taskId: task.id,
                });
            }
        }
    }
    return warnings;
}
// ─── Composite Score Calculation ─────────────────────────────────────────────
/**
 * Compute the full ScheduleScore for a set of assignments.
 */
function computeScheduleScore(tasks, participants, assignments, config) {
    // Rest fairness
    const profiles = (0, rest_calculator_1.computeAllRestProfiles)(participants, assignments, tasks);
    const fairness = (0, rest_calculator_1.computeRestFairness)(profiles);
    // Penalties
    let totalPenalty = 0;
    let totalBonus = 0;
    const pMap = new Map();
    for (const p of participants)
        pMap.set(p.id, p);
    for (const task of tasks) {
        const taskAssignments = assignments.filter((a) => a.taskId === task.id);
        const assignedPs = taskAssignments
            .map((a) => pMap.get(a.participantId))
            .filter((p) => !!p);
        // Hamama penalties
        for (const p of assignedPs) {
            totalPenalty += hamamaPenalty(task, p, config);
        }
        // Shemesh bonus
        totalBonus += shemeshGroupBonus(task, assignedPs, config);
    }
    // Workload imbalance
    totalPenalty += workloadImbalancePenalty(participants, assignments, tasks);
    // Composite score
    const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
    const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;
    const stdDev = fairness.stdDevRest;
    const compositeScore = config.minRestWeight * minRest -
        config.fairnessWeight * stdDev -
        config.penaltyWeight * totalPenalty +
        config.bonusWeight * totalBonus;
    return {
        minRestHours: minRest,
        avgRestHours: avgRest,
        restStdDev: stdDev,
        totalPenalty,
        totalBonus,
        compositeScore,
    };
}
//# sourceMappingURL=soft-constraints.js.map