/**
 * Soft Constraint Scorers
 *
 * These produce numeric scores (penalties / bonuses) that guide
 * the optimizer toward better schedules without making them invalid.
 */

import {
  Task,
  Assignment,
  Participant,
  TaskType,
  Level,
  SchedulerConfig,
  ScheduleScore,
  ConstraintViolation,
  ViolationSeverity,
} from '../models/types';
import {
  computeAllRestProfiles,
  computeRestFairness,
} from '../web/utils/rest-calculator';
import { computeTaskEffectiveHours } from '../web/utils/load-weighting';

// ─── Individual Penalty Functions ────────────────────────────────────────────

/**
 * SC-1: Hamama penalty — penalise assigning L3/L4 to Hamama.
 * Best: L0 (0 penalty), Acceptable: L3 (high), Avoid: L4 (extreme).
 */
export function hamamaPenalty(
  task: Task,
  participant: Participant,
  config: SchedulerConfig,
): number {
  if (task.type !== TaskType.Hamama) return 0;
  if (participant.level === Level.L3) return config.hamamaL3Penalty;
  if (participant.level === Level.L4) return config.hamamaL4Penalty;
  return 0;
}

/**
 * SC-2: Shemesh same-group bonus — REMOVED.
 * Shemesh now freely mixes participants from any group (no group constraint).
 * Kept as a no-op for API compatibility.
 */
export function shemeshGroupBonus(
  _task: Task,
  _assignedParticipants: Participant[],
  _config: SchedulerConfig,
): number {
  return 0;
}

/**
 * SC-3: Workload balance — penalize uneven distribution of non-light assignments.
 * Returns a penalty proportional to the standard deviation of assignment counts.
 */
export function workloadImbalancePenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): number {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const effectiveLoads: number[] = participants.map((p) => {
    let effectiveHours = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      effectiveHours += computeTaskEffectiveHours(task);
    }
    return effectiveHours;
  });

  if (effectiveLoads.length === 0) return 0;
  const avg = effectiveLoads.reduce((a, b) => a + b, 0) / effectiveLoads.length;
  const variance = effectiveLoads.reduce((sum, c) => sum + (c - avg) ** 2, 0) / effectiveLoads.length;
  return Math.sqrt(variance) * 2; // Scaled penalty
}

/**
 * SC-4: Legacy per-level fairness penalty.
 * Removed to keep all participants in a single homogeneous fairness pool.
 */
export function levelWorkloadFairnessPenalty(
  _participants: Participant[],
  _assignments: Assignment[],
  _tasks: Task[],
): number {
  return 0;
}

/**
 * SC-5: Back-to-back shift penalty — penalise 0-minute gaps between
 * consecutive assignments for the same participant.
 *
 * This is a SOFT constraint only: the optimizer will prefer schedules
 * with breathing room between shifts, but will never leave a slot
 * unassigned just to create a gap.
 */
export function backToBackPenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  penaltyPerPair: number,
): number {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  let penalty = 0;

  for (const p of participants) {

    // Gather this participant's non-light tasks sorted by start
    const pTasks: Task[] = [];
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (task && !task.isLight) pTasks.push(task);
    }
    if (pTasks.length < 2) continue;

    pTasks.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());

    for (let i = 0; i < pTasks.length - 1; i++) {
      const gapMs = pTasks[i + 1].timeBlock.start.getTime() - pTasks[i].timeBlock.end.getTime();
      if (gapMs <= 0) {
        // Zero or negative gap (overlap should not happen after HC, but guard anyway)
        penalty += penaltyPerPair;
      }
    }
  }

  return penalty;
}

// ─── Soft Constraint Warnings ────────────────────────────────────────────────

/**
 * Generate warnings (non-fatal) for soft constraint issues.
 */
export function collectSoftWarnings(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
): ConstraintViolation[] {
  const warnings: ConstraintViolation[] = [];
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);
  const tMap = new Map<string, Task>();
  for (const t of tasks) tMap.set(t.id, t);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);

    // Hamama L3 warning (L4 is now a hard constraint — HC-10)
    if (task.type === TaskType.Hamama) {
      for (const p of assignedPs) {
        if (p.level === Level.L3) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'HAMAMA_L3',
            message: `${p.name} (L3) assigned to Hamama — high penalty. Prefer L0.`,
            taskId: task.id,
            participantId: p.id,
          });
        }
        // L4 no longer a warning — it's a hard violation (HC-10 L4_FORBIDDEN)
      }
    }

    // (Shemesh group constraint removed — free mixing allowed)
  }

  // SC-5: Back-to-back warnings (zero gap between consecutive assignments)
  const btbTaskMap = new Map<string, Task>();
  for (const t of tasks) btbTaskMap.set(t.id, t);
  for (const p of participants) {
    const pTasks: Task[] = [];
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = btbTaskMap.get(a.taskId);
      if (task && !task.isLight) pTasks.push(task);
    }
    if (pTasks.length < 2) continue;
    pTasks.sort((x, y) => x.timeBlock.start.getTime() - y.timeBlock.start.getTime());
    for (let i = 0; i < pTasks.length - 1; i++) {
      const gapMs = pTasks[i + 1].timeBlock.start.getTime() - pTasks[i].timeBlock.end.getTime();
      if (gapMs <= 0) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'BACK_TO_BACK',
          message: `${p.name} has back-to-back shifts: "${pTasks[i].name}" ends at ${pTasks[i].timeBlock.end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} and "${pTasks[i + 1].name}" starts immediately.`,
          taskId: pTasks[i + 1].id,
          participantId: p.id,
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
export function computeScheduleScore(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
): ScheduleScore {
  // Rest metrics (still used for min/avg rest reporting)
  const profiles = computeAllRestProfiles(participants, assignments, tasks);
  const fairness = computeRestFairness(profiles);

  // Effective-load fairness (used for fairness sigma and optimizer objective)
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const effectiveLoads: number[] = participants.map((p) => {
    let total = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      total += computeTaskEffectiveHours(task);
    }
    return total;
  });
  const effectiveAvg =
    effectiveLoads.length > 0
      ? effectiveLoads.reduce((sum, value) => sum + value, 0) / effectiveLoads.length
      : 0;
  const effectiveVar =
    effectiveLoads.length > 0
      ? effectiveLoads.reduce((sum, value) => sum + (value - effectiveAvg) ** 2, 0) / effectiveLoads.length
      : 0;
  const effectiveStdDev = Math.sqrt(effectiveVar);

  // Penalties
  let totalPenalty = 0;
  let totalBonus = 0;

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);

    // Hamama penalties
    for (const p of assignedPs) {
      totalPenalty += hamamaPenalty(task, p, config);
    }

    // Shemesh bonus
    totalBonus += shemeshGroupBonus(task, assignedPs, config);
  }

  // Workload imbalance
  totalPenalty += workloadImbalancePenalty(participants, assignments, tasks);

  // Level-specific workload fairness (SC-4)
  totalPenalty += levelWorkloadFairnessPenalty(participants, assignments, tasks);

  // Back-to-back shift penalty (SC-5)
  totalPenalty += backToBackPenalty(participants, assignments, tasks, config.backToBackPenalty);

  // Composite score
  const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
  const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;
  const stdDev = effectiveStdDev;

  const compositeScore =
    config.minRestWeight * minRest -
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
