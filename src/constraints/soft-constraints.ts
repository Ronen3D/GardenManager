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
  ParticipantCapacity,
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
import { computeSeniorHamamaPenalty } from './senior-policy';
import { dateKey } from '../utils/date-utils';

/**
 * SC-3: Workload balance — penalize uneven distribution of non-light assignments.
 *
 * Split-pool: L0 participants are balanced among themselves, seniors (L2-L4)
 * are balanced among themselves. No cross-level comparison.
 *
 * When `capacities` is provided, each participant's "fair share" target is
 * proportional to their available hours rather than the flat pool average.
 * E.g. if pool total is 100h and participant A has 60% of the pool's capacity,
 * their target is 60h, not the simple average. Deviations remain in hours so
 * the weight calibration and display values are preserved.
 *
 * Returns { l0Penalty, seniorPenalty, l0StdDev, l0Avg, seniorStdDev, seniorAvg }.
 */
export function workloadImbalanceSplit(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  prebuiltTaskMap?: Map<string, Task>,
  assignmentsByParticipant?: Map<string, Assignment[]>,
  capacities?: Map<string, ParticipantCapacity>,
): { l0Penalty: number; seniorPenalty: number; l0StdDev: number; l0Avg: number; seniorStdDev: number; seniorAvg: number; combinedStdDev: number } {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map(t => [t.id, t]));

  // Accumulate per-participant effective hours and capacity
  const l0Data: { hours: number; cap: number }[] = [];
  const seniorData: { hours: number; cap: number }[] = [];

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

    const cap = capacities?.get(p.id)?.totalAvailableHours ?? 0;
    if (p.level === Level.L0) {
      l0Data.push({ hours: effectiveHours, cap });
    } else {
      seniorData.push({ hours: effectiveHours, cap });
    }
  }

  /**
   * Compute stats with proportional targets when capacities are available.
   *
   * Without capacities: target_i = totalLoad / N (flat average, legacy behaviour).
   * With capacities:    target_i = totalLoad × (cap_i / totalCap).
   *
   * All values remain in hours, preserving weight calibration.
   */
  const computeStats = (data: { hours: number; cap: number }[]) => {
    if (data.length === 0) return { stdDev: 0, avg: 0, penalty: 0 };
    const totalLoad = data.reduce((s, d) => s + d.hours, 0);
    const avg = totalLoad / data.length;

    const totalCap = data.reduce((s, d) => s + d.cap, 0);
    const useProportional = capacities && totalCap > 0;

    let variance = 0;
    for (const d of data) {
      // Proportional target: each person's fair share scales with their capacity
      const target = useProportional
        ? totalLoad * (d.cap / totalCap)
        : avg;
      variance += (d.hours - target) ** 2;
    }
    variance /= data.length;
    const stdDev = Math.sqrt(variance);
    return { stdDev, avg, penalty: stdDev * 2 };
  };

  const l0Stats = computeStats(l0Data);
  const seniorStats = computeStats(seniorData);

  // Compute combined std-dev across both pools with proportional targets
  const allData = [...l0Data, ...seniorData];
  let combinedStdDev = 0;
  if (allData.length > 0) {
    const totalLoad = allData.reduce((s, d) => s + d.hours, 0);
    const totalCap = allData.reduce((s, d) => s + d.cap, 0);
    const useProportional = capacities && totalCap > 0;
    const avg = totalLoad / allData.length;

    let sumSqDev = 0;
    for (const d of allData) {
      const target = useProportional
        ? totalLoad * (d.cap / totalCap)
        : avg;
      sumSqDev += (d.hours - target) ** 2;
    }
    combinedStdDev = Math.sqrt(sumSqDev / allData.length);
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

// ─── Soft Constraint Warnings ────────────────────────────────────────────────

// ─── SC-8: Daily Workload Balance ────────────────────────────────────────────

/**
 * SC-8: Daily workload imbalance — penalise schedules where some calendar
 * days are extremely busy while others are extremely light.
 *
 * Two complementary metrics:
 *  1. **Per-participant daily std-dev** — each participant should have their
 *     effective hours spread roughly evenly across the days they work.
 *     When `capacities` is provided, days where a participant has zero
 *     available hours are excluded from their std-dev calculation so that
 *     unavailable days don't inflate the penalty with phantom zeros.
 *  2. **Global daily std-dev** — the total effective hours scheduled per
 *     calendar day (across all participants) should be roughly equal.
 *     This metric is absolute and unaffected by individual availability.
 *
 * Both values are returned so the caller can weight them in the composite.
 */
export function dailyWorkloadImbalance(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  prebuiltTaskMap?: Map<string, Task>,
  assignmentsByParticipant?: Map<string, Assignment[]>,
  capacities?: Map<string, ParticipantCapacity>,
): { dailyPerParticipantStdDev: number; dailyGlobalStdDev: number } {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map(t => [t.id, t]));

  // ── Collect all calendar days present in the schedule ──
  const allDays = new Set<string>();
  for (const t of tasks) {
    allDays.add(dateKey(t.timeBlock.start));
  }
  const dayList = [...allDays].sort();
  if (dayList.length <= 1) {
    // Only one day — nothing to balance
    return { dailyPerParticipantStdDev: 0, dailyGlobalStdDev: 0 };
  }

  // ── Per-participant daily loads ──
  // participantId → (dateKey → effectiveHours)
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < dayList.length; i++) dayIndex.set(dayList[i], i);
  const numDays = dayList.length;

  // Global totals per day (sum of all participants' loads on that day)
  const globalDayTotals = new Float64Array(numDays);

  let sumOfParticipantStdDevs = 0;
  let participantCount = 0;

  for (const p of participants) {
    const dailyLoad = new Float64Array(numDays); // zero-initialised

    const pAssignments = assignmentsByParticipant
      ? (assignmentsByParticipant.get(p.id) || [])
      : assignments.filter(a => a.participantId === p.id);

    for (const a of pAssignments) {
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      const dk = dateKey(task.timeBlock.start);
      const idx = dayIndex.get(dk);
      if (idx === undefined) continue;
      const eff = computeTaskEffectiveHours(task);
      dailyLoad[idx] += eff;
      globalDayTotals[idx] += eff;
    }

    // Std-dev of this participant's daily loads.
    // When capacities are available, exclude days where the participant
    // has zero available hours — those are fully-unavailable days whose
    // "0 load" is expected, not a sign of imbalance.
    const pCap = capacities?.get(p.id);
    let sum = 0;
    let availableDayCount = 0;
    for (let i = 0; i < numDays; i++) {
      const dk = dayList[i];
      const dayAvail = pCap?.dailyAvailableHours.get(dk);
      //  Skip fully-unavailable days when capacity data is present
      if (pCap && (dayAvail === undefined || dayAvail <= 0)) continue;
      sum += dailyLoad[i];
      availableDayCount++;
    }
    if (availableDayCount > 0) {
      const avg = sum / availableDayCount;
      let variance = 0;
      for (let i = 0; i < numDays; i++) {
        const dk = dayList[i];
        const dayAvail = pCap?.dailyAvailableHours.get(dk);
        if (pCap && (dayAvail === undefined || dayAvail <= 0)) continue;
        variance += (dailyLoad[i] - avg) ** 2;
      }
      variance /= availableDayCount;
      sumOfParticipantStdDevs += Math.sqrt(variance);
    }
    participantCount++;
  }

  const dailyPerParticipantStdDev =
    participantCount > 0 ? sumOfParticipantStdDevs / participantCount : 0;

  // ── Global daily std-dev ──
  let gSum = 0;
  for (let i = 0; i < numDays; i++) gSum += globalDayTotals[i];
  const gAvg = gSum / numDays;
  let gVariance = 0;
  for (let i = 0; i < numDays; i++) gVariance += (globalDayTotals[i] - gAvg) ** 2;
  gVariance /= numDays;
  const dailyGlobalStdDev = Math.sqrt(gVariance);

  return { dailyPerParticipantStdDev, dailyGlobalStdDev };
}

// ─── Soft Constraint Warnings ────────────────────────────────────────────────

/**
 * Generate warnings (non-fatal) for soft constraint issues.
 */
export function collectSoftWarnings(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  disabledSW?: Set<string>,
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

    // Hamama: warn for L4 in Hamama — absolute last resort
    // (L2/L3 are hard-blocked from Hamama by HC-13 and should never appear here)
    if (!disabledSW?.has('HAMAMA_SENIOR') && task.type === TaskType.Hamama) {
      for (const p of assignedPs) {
        if (p.level === Level.L4) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'HAMAMA_SENIOR',
            message: `${p.name} (דרגה 4) משובץ לחממה — מוצא אחרון. רק דרגה 0 צריכים להיות כאן; דרגה 4 הוא חלופה כשאין דרגה 0 זמינים.`,
            taskId: task.id,
            participantId: p.id,
          });
        }
      }
    }

    // SC-7: Group mismatch — safety-net warning (HC-4 hard constraint should
    // prevent this; if it appears, something bypassed the constraint).
    if (!disabledSW?.has('GROUP_MISMATCH') && task.sameGroupRequired && assignedPs.length > 0) {
      const groups = new Set(assignedPs.map((p) => p.group));
      if (groups.size > 1) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'GROUP_MISMATCH',
          message: `משימה ${task.name} דורשת אותה קבוצה אך כוללת משתתפים מ-${groups.size} קבוצות: [${[...groups].join(', ')}] — זה אמור להיתפס על ידי HC-4`,
          taskId: task.id,
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
  /** Optional: pre-computed per-participant capacities for proportional workload */
  capacities?: Map<string, ParticipantCapacity>;
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
  disabledSW?: Set<string>,
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

  // Split-pool workload stats — pass pre-built data + capacities
  const wlSplit = workloadImbalanceSplit(participants, assignments, tasks, taskMap, byParticipant, ctx?.capacities);

  // Reuse the combined std-dev already computed inside workloadImbalanceSplit
  // to avoid a redundant O(P×A) effective-hours scan.
  const combinedStdDev = wlSplit.combinedStdDev;

  // Penalties
  let totalPenalty = 0;

  // Workload imbalance is captured directly via l0FairnessWeight * l0StdDev
  // and seniorFairnessWeight * seniorStdDev in the composite formula — no
  // double-counting through totalPenalty.


  // SC-5 (back-to-back penalty) removed — redundant with minRestWeight and HC-12.

  // SC-6: Senior Hamama penalty — pass pre-built maps
  // When HAMAMA_SENIOR is disabled, zero out seniorHamamaPenalty so L4-in-Hamama
  // assignments are not penalised in the composite score.
  const effectiveConfig = disabledSW?.has('HAMAMA_SENIOR')
    ? { ...config, seniorHamamaPenalty: 0 }
    : config;
  totalPenalty += computeSeniorHamamaPenalty(participants, assignments, tasks, effectiveConfig, pMap, taskMap);

  // SC-8: Daily workload balance — pass pre-built data + capacities
  const dailyBalance = dailyWorkloadImbalance(participants, assignments, tasks, taskMap, byParticipant, ctx?.capacities);

  // Composite score
  const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
  const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;

  const compositeScore =
    config.minRestWeight * minRest -
    config.l0FairnessWeight * wlSplit.l0StdDev -
    config.seniorFairnessWeight * wlSplit.seniorStdDev -
    config.dailyBalanceWeight * (dailyBalance.dailyPerParticipantStdDev + dailyBalance.dailyGlobalStdDev) -
    totalPenalty;

  return {
    minRestHours: minRest,
    avgRestHours: avgRest,
    restStdDev: combinedStdDev,
    totalPenalty,
    compositeScore,
    l0StdDev: wlSplit.l0StdDev,
    l0AvgEffective: wlSplit.l0Avg,
    seniorStdDev: wlSplit.seniorStdDev,
    seniorAvgEffective: wlSplit.seniorAvg,
    dailyPerParticipantStdDev: dailyBalance.dailyPerParticipantStdDev,
    dailyGlobalStdDev: dailyBalance.dailyGlobalStdDev,
  };
}
