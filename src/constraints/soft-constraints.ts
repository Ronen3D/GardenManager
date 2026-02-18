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
import { computeSeniorOutOfRolePenalty } from './senior-policy';

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
 *
 * Split-pool: L0 participants are balanced among themselves, seniors (L2-L4)
 * are balanced among themselves. No cross-level comparison.
 *
 * Returns { l0Penalty, seniorPenalty, l0StdDev, l0Avg, seniorStdDev, seniorAvg }.
 */
export function workloadImbalanceSplit(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): { l0Penalty: number; seniorPenalty: number; l0StdDev: number; l0Avg: number; seniorStdDev: number; seniorAvg: number } {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const l0Loads: number[] = [];
  const seniorLoads: number[] = [];

  for (const p of participants) {
    let effectiveHours = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      effectiveHours += computeTaskEffectiveHours(task);
    }
    if (p.level === Level.L0) {
      l0Loads.push(effectiveHours);
    } else {
      seniorLoads.push(effectiveHours);
    }
  }

  const computeStats = (loads: number[]) => {
    if (loads.length === 0) return { stdDev: 0, avg: 0, penalty: 0 };
    const avg = loads.reduce((a, b) => a + b, 0) / loads.length;
    const variance = loads.reduce((sum, c) => sum + (c - avg) ** 2, 0) / loads.length;
    const stdDev = Math.sqrt(variance);
    return { stdDev, avg, penalty: stdDev * 2 };
  };

  const l0Stats = computeStats(l0Loads);
  const seniorStats = computeStats(seniorLoads);

  return {
    l0Penalty: l0Stats.penalty,
    seniorPenalty: seniorStats.penalty,
    l0StdDev: l0Stats.stdDev,
    l0Avg: l0Stats.avg,
    seniorStdDev: seniorStats.stdDev,
    seniorAvg: seniorStats.avg,
  };
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

    // Hamama: L3 warning, L4 warning (soft — allowed but very undesirable per HC-13)
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
        if (p.level === Level.L4) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'HAMAMA_L4',
            message: `${p.name} (L4) assigned to Hamama — very undesirable. Only as last resort.`,
            taskId: task.id,
            participantId: p.id,
          });
        }
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
 *
 * Uses split-pool fairness: L0 std-dev is the primary fairness driver,
 * senior (L2-L4) std-dev is secondary. No cross-level comparison.
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

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Split-pool workload stats
  const wlSplit = workloadImbalanceSplit(participants, assignments, tasks);

  // Legacy combined restStdDev for backward compat / dashboard display
  // Compute from all participants combined
  const allLoads: number[] = participants.map((p) => {
    let total = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      total += computeTaskEffectiveHours(task);
    }
    return total;
  });
  const allAvg = allLoads.length > 0
    ? allLoads.reduce((s, v) => s + v, 0) / allLoads.length : 0;
  const allVar = allLoads.length > 0
    ? allLoads.reduce((s, v) => s + (v - allAvg) ** 2, 0) / allLoads.length : 0;
  const combinedStdDev = Math.sqrt(allVar);

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

  // Split-pool workload imbalance
  totalPenalty += wlSplit.l0Penalty + wlSplit.seniorPenalty;

  // Level-specific workload fairness (SC-4 — legacy no-op)
  totalPenalty += levelWorkloadFairnessPenalty(participants, assignments, tasks);

  // Back-to-back shift penalty (SC-5)
  totalPenalty += backToBackPenalty(participants, assignments, tasks, config.backToBackPenalty);

  // SC-6: Senior out-of-role penalty
  const l0Avg = wlSplit.l0Avg;
  totalPenalty += computeSeniorOutOfRolePenalty(participants, assignments, tasks, l0Avg, config);

  // Composite score
  const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
  const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;

  const compositeScore =
    config.minRestWeight * minRest -
    config.l0FairnessWeight * wlSplit.l0StdDev -
    config.seniorFairnessWeight * wlSplit.seniorStdDev -
    config.penaltyWeight * totalPenalty +
    config.bonusWeight * totalBonus;

  return {
    minRestHours: minRest,
    avgRestHours: avgRest,
    restStdDev: combinedStdDev,
    totalPenalty,
    totalBonus,
    compositeScore,
    l0StdDev: wlSplit.l0StdDev,
    l0AvgEffective: wlSplit.l0Avg,
    seniorStdDev: wlSplit.seniorStdDev,
    seniorAvgEffective: wlSplit.seniorAvg,
  };
}
