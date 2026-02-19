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
 * SC-1: Hamama penalty — now handled entirely by senior policy
 * (`seniorHamamaPenalty`).  This function is kept for API
 * compatibility but always returns 0.
 */
export function hamamaPenalty(
  task: Task,
  participant: Participant,
  _config: SchedulerConfig,
): number {
  // All senior-in-Hamama penalties are applied via computeSeniorOutOfRolePenalty.
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
  prebuiltTaskMap?: Map<string, Task>,
  assignmentsByParticipant?: Map<string, Assignment[]>,
): { l0Penalty: number; seniorPenalty: number; l0StdDev: number; l0Avg: number; seniorStdDev: number; seniorAvg: number; combinedStdDev: number } {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map(t => [t.id, t]));

  const l0Loads: number[] = [];
  const seniorLoads: number[] = [];

  for (const p of participants) {
    let effectiveHours = 0;
    if (assignmentsByParticipant) {
      const pAssignments = assignmentsByParticipant.get(p.id) || [];
      for (const a of pAssignments) {
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        effectiveHours += computeTaskEffectiveHours(task);
      }
    } else {
      for (const a of assignments) {
        if (a.participantId !== p.id) continue;
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        effectiveHours += computeTaskEffectiveHours(task);
      }
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

  // Compute combined std-dev across both pools, reusing the already-scanned
  // loads so computeScheduleScore doesn't need a separate O(P×A) pass.
  const totalCount = l0Loads.length + seniorLoads.length;
  let combinedStdDev = 0;
  if (totalCount > 0) {
    let totalSum = 0;
    let totalSumSq = 0;
    for (const x of l0Loads) { totalSum += x; totalSumSq += x * x; }
    for (const x of seniorLoads) { totalSum += x; totalSumSq += x * x; }
    const avg = totalSum / totalCount;
    combinedStdDev = Math.sqrt(Math.max(0, totalSumSq / totalCount - avg * avg));
  }

  return {
    l0Penalty: l0Stats.penalty,
    seniorPenalty: seniorStats.penalty,
    l0StdDev: l0Stats.stdDev,
    l0Avg: l0Stats.avg,
    seniorStdDev: seniorStats.stdDev,
    seniorAvg: seniorStats.avg,
    combinedStdDev,
  };
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
  prebuiltTaskMap?: Map<string, Task>,
  assignmentsByParticipant?: Map<string, Assignment[]>,
): number {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map(t => [t.id, t]));

  let penalty = 0;

  for (const p of participants) {

    // Gather this participant's non-light tasks sorted by start
    const pTasks: Task[] = [];
    if (assignmentsByParticipant) {
      const pAssignments = assignmentsByParticipant.get(p.id) || [];
      for (const a of pAssignments) {
        const task = taskMap.get(a.taskId);
        if (task && !task.isLight) pTasks.push(task);
      }
    } else {
      for (const a of assignments) {
        if (a.participantId !== p.id) continue;
        const task = taskMap.get(a.taskId);
        if (task && !task.isLight) pTasks.push(task);
      }
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

    // Hamama: warn for ALL seniors (L2/L3/L4) — absolute last resort
    if (task.type === TaskType.Hamama) {
      for (const p of assignedPs) {
        if (p.level === Level.L2 || p.level === Level.L3 || p.level === Level.L4) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'HAMAMA_SENIOR',
            message: `${p.name} (L${p.level}) assigned to Hamama — absolute last resort. Seniors should only be placed here if no other schedule is possible.`,
            taskId: task.id,
            participantId: p.id,
          });
        }
      }
    }

    // SC-7: Group mismatch warning (same-group tasks with mixed groups)
    if (task.sameGroupRequired && assignedPs.length > 0) {
      const groups = new Set(assignedPs.map((p) => p.group));
      if (groups.size > 1) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'GROUP_MISMATCH',
          message: `Task ${task.name} prefers same-group but has participants from ${groups.size} groups: [${[...groups].join(', ')}]`,
          taskId: task.id,
        });
      }
    }
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
 * Pre-built data structures for fast repeated scoring.
 * Pass this to computeScheduleScore() to avoid rebuilding immutable maps
 * on every call (critical when called thousands of times in local search).
 */
export interface ScoreContext {
  taskMap: Map<string, Task>;
  pMap: Map<string, Participant>;
  /** Optional: per-participant assignment index maintained by the caller */
  assignmentsByParticipant?: Map<string, Assignment[]>;
  /** Optional: per-task assignment index maintained by the caller */
  assignmentsByTask?: Map<string, Assignment[]>;
}

/**
 * Compute the full ScheduleScore for a set of assignments.
 *
 * Uses split-pool fairness: L0 std-dev is the primary fairness driver,
 * senior (L2-L4) std-dev is secondary. No cross-level comparison.
 *
 * When `ctx` is provided, reuses pre-built maps instead of constructing
 * them from scratch — eliminates ~5 redundant O(P×A) scans per call.
 */
export function computeScheduleScore(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
  ctx?: ScoreContext,
): ScheduleScore {
  // Reuse or build lookup maps
  const taskMap = ctx?.taskMap ?? new Map(tasks.map(t => [t.id, t]));
  const pMap = ctx?.pMap ?? new Map(participants.map(p => [p.id, p]));

  // Reuse or build per-participant index
  let byParticipant: Map<string, Assignment[]>;
  if (ctx?.assignmentsByParticipant) {
    byParticipant = ctx.assignmentsByParticipant;
  } else {
    byParticipant = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = byParticipant.get(a.participantId);
      if (list) list.push(a);
      else byParticipant.set(a.participantId, [a]);
    }
  }

  // Reuse or build per-task index
  let assignmentsByTask: Map<string, Assignment[]>;
  if (ctx?.assignmentsByTask) {
    assignmentsByTask = ctx.assignmentsByTask;
  } else {
    assignmentsByTask = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = assignmentsByTask.get(a.taskId);
      if (list) list.push(a);
      else assignmentsByTask.set(a.taskId, [a]);
    }
  }

  // Rest metrics — pass pre-built data to avoid P redundant taskMap builds
  const profiles = computeAllRestProfiles(participants, assignments, tasks, taskMap, byParticipant);
  const fairness = computeRestFairness(profiles);

  // Split-pool workload stats — pass pre-built data
  const wlSplit = workloadImbalanceSplit(participants, assignments, tasks, taskMap, byParticipant);

  // Reuse the combined std-dev already computed inside workloadImbalanceSplit
  // to avoid a redundant O(P×A) effective-hours scan.
  const combinedStdDev = wlSplit.combinedStdDev;

  // Penalties
  let totalPenalty = 0;
  let totalBonus = 0;

  for (const task of tasks) {
    const taskAssignments = assignmentsByTask.get(task.id) || [];
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);

    // Hamama penalties
    for (const p of assignedPs) {
      totalPenalty += hamamaPenalty(task, p, config);
    }
  }

  // Workload imbalance is captured directly via l0FairnessWeight * l0StdDev
  // and seniorFairnessWeight * seniorStdDev in the composite formula — no
  // double-counting through totalPenalty.

  // Group mismatch penalty (SC-7)
  for (const task of tasks) {
    if (!task.sameGroupRequired) continue;
    const taskAssignments = assignmentsByTask.get(task.id) || [];
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);
    if (assignedPs.length > 0) {
      const groups = new Set(assignedPs.map((p) => p.group));
      if (groups.size > 1) {
        totalPenalty += config.groupMismatchPenalty;
      }
    }
  }

  // Back-to-back shift penalty (SC-5) — pass pre-built data
  totalPenalty += backToBackPenalty(participants, assignments, tasks, config.backToBackPenalty, taskMap, byParticipant);

  // SC-6: Senior out-of-role penalty — pass pre-built maps
  totalPenalty += computeSeniorOutOfRolePenalty(participants, assignments, tasks, config, pMap, taskMap);

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
