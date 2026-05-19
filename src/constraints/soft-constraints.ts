/**
 * Soft Constraint Scorers
 *
 * These produce numeric scores (penalties / bonuses) that guide
 * the optimizer toward better schedules without making them invalid.
 */

import { recordNotWithViolation } from '../engine/diagnostics';
import { isLowPriority } from '../models/level-utils';
import {
  type Assignment,
  type ConstraintViolation,
  Level,
  type Participant,
  type ParticipantCapacity,
  type SchedulerConfig,
  type ScheduleScore,
  type SlotRequirement,
  type Task,
  ViolationSeverity,
} from '../models/types';
import { computeTaskEffectiveHours, fragmentShare } from '../shared/utils/load-weighting';
import {
  computeAllRestProfiles,
  computeRestFairness,
  computeRestFromAssignments,
  ParticipantRestProfile,
} from '../shared/utils/rest-calculator';
import { describeTaskInstance, operationalDateKey, taskOpDayStart } from '../utils/date-utils';
import { computeLowPriorityLevelPenalty } from './senior-policy';

/**
 * Fair-share capacity divisor. Returns physical capacity divided by the
 * participant's `workloadMultiplier` (default 1). Used by SC-3 pool fairness,
 * the IncrementalScorer per-participant capacity, and the optimizer's greedy
 * workload tie-breaker — all of which compare a participant's hours against
 * a target proportional to their capacity. Dividing capacity by the multiplier
 * shrinks (or grows) that target without touching the raw hours, keeping HC
 * gating and display values untouched.
 *
 * Never used by hard constraints, by `computeAllCapacities`, by global daily
 * balance, or by any physical-availability code path.
 */
export function effectiveCapacity(p: Participant, rawCap: number): number {
  const m = p.workloadMultiplier ?? 1;
  return m > 0 ? rawCap / m : rawCap;
}

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
  phantomTaskIds?: Set<string>,
): {
  l0Penalty: number;
  seniorPenalty: number;
  l0StdDev: number;
  l0Avg: number;
  seniorStdDev: number;
  seniorAvg: number;
  combinedStdDev: number;
} {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map((t) => [t.id, t]));

  // Accumulate per-participant effective hours and capacity
  const l0Data: { hours: number; cap: number }[] = [];
  const seniorData: { hours: number; cap: number }[] = [];

  for (const p of participants) {
    let effectiveHours = 0;
    if (assignmentsByParticipant) {
      const pAssignments = assignmentsByParticipant.get(p.id) || [];
      for (const a of pAssignments) {
        if (phantomTaskIds?.has(a.taskId)) continue;
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        effectiveHours += computeTaskEffectiveHours(task);
      }
    } else {
      for (const a of assignments) {
        if (a.participantId !== p.id) continue;
        if (phantomTaskIds?.has(a.taskId)) continue;
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        effectiveHours += computeTaskEffectiveHours(task);
      }
    }

    const cap = effectiveCapacity(p, capacities?.get(p.id)?.totalAvailableHours ?? 0);
    if (p.level === Level.L0) {
      l0Data.push({ hours: effectiveHours, cap });
    } else {
      seniorData.push({ hours: effectiveHours, cap });
    }
  }

  /**
   * Compute stats with proportional targets when capacities are available.
   *
   * Without capacities: target_i = totalLoad / N (flat average).
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
      const target = useProportional ? totalLoad * (d.cap / totalCap) : avg;
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
      const target = useProportional ? totalLoad * (d.cap / totalCap) : avg;
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
 * SC-8: Daily workload imbalance — penalise schedules where some operational
 * days are loaded out of proportion to the available capacity for that day.
 *
 * Two complementary metrics, each computed against a **capacity-proportional
 * target** when `capacities` are provided:
 *  1. **Per-participant daily std-dev** — each participant's day-load should
 *     match their share of capacity for that day:
 *         target_d = totalLoad_p × (cap_p_d / totalCap_p)
 *     This means a participant available 4h Monday and 24h Tuesday is expected
 *     to carry roughly 6× more load on Tuesday — not equal hours on both.
 *  2. **Global daily std-dev** — the total team-load on a day should match
 *     that day's share of the team's capacity:
 *         target_d = totalGlobalLoad × (teamCap_d / teamCapTotal)
 *     A Friday with reduced team availability is expected to carry less
 *     work, not the same as a full-staffed Sunday.
 *
 * When `capacities` is missing (e.g. tests that don't pass it), the function
 * gracefully degrades to the historical capacity-blind flat-mean formulation.
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
  dayStartHour: number = 5,
  phantomTaskIds?: Set<string>,
): { dailyPerParticipantStdDev: number; dailyGlobalStdDev: number } {
  const taskMap = prebuiltTaskMap ?? new Map(tasks.map((t) => [t.id, t]));

  // ── Collect all operational days present in the schedule ──
  // Bucket by the OCCURRENCE op-day (taskOpDayStart) so a split `#b` whose
  // midpoint crossed the dayStartHour boundary lands on the same day as its
  // residual / `#a` / the equivalent unsplit shift. Non-split tasks return
  // `timeBlock.start` unchanged ⇒ byte-identical when nothing is split.
  const allDays = new Set<string>();
  for (const t of tasks) {
    allDays.add(operationalDateKey(taskOpDayStart(t), dayStartHour));
  }
  const dayList = [...allDays].sort();
  if (dayList.length <= 1) {
    // Only one day — nothing to balance
    return { dailyPerParticipantStdDev: 0, dailyGlobalStdDev: 0 };
  }

  // ── Per-participant daily loads ──
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < dayList.length; i++) dayIndex.set(dayList[i], i);
  const numDays = dayList.length;

  // Global totals per day (sum of all participants' loads on that day)
  const globalDayTotals = new Float64Array(numDays);

  let sumOfParticipantStdDevs = 0;
  let participantCount = 0;

  for (const p of participants) {
    const dailyLoad = new Float64Array(numDays); // zero-initialised
    let totalLoad = 0;

    const pAssignments = assignmentsByParticipant
      ? assignmentsByParticipant.get(p.id) || []
      : assignments.filter((a) => a.participantId === p.id);

    for (const a of pAssignments) {
      if (phantomTaskIds?.has(a.taskId)) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      const dk = operationalDateKey(taskOpDayStart(task), dayStartHour);
      const idx = dayIndex.get(dk);
      if (idx === undefined) continue;
      const eff = computeTaskEffectiveHours(task);
      dailyLoad[idx] += eff;
      globalDayTotals[idx] += eff;
      totalLoad += eff;
    }

    const pCap = capacities?.get(p.id);
    let totalCap = 0;
    if (pCap) {
      for (const dk of dayList) {
        const c = pCap.dailyAvailableHours.get(dk) ?? 0;
        if (c > 0) totalCap += c;
      }
    }

    if (pCap && totalCap > 0) {
      // Capacity-proportional target: each day's expected load scales with
      // that day's share of the participant's total available hours.
      let variance = 0;
      let availDays = 0;
      for (let i = 0; i < numDays; i++) {
        const cd = pCap.dailyAvailableHours.get(dayList[i]) ?? 0;
        if (cd <= 0) continue;
        const target = totalLoad * (cd / totalCap);
        variance += (dailyLoad[i] - target) ** 2;
        availDays++;
      }
      if (availDays > 0) sumOfParticipantStdDevs += Math.sqrt(variance / availDays);
    } else {
      // No-capacity graceful degradation — flat-mean across all days.
      // Used by callers that don't pass a capacities map (e.g. some tests).
      const avg = totalLoad / numDays;
      let variance = 0;
      for (let i = 0; i < numDays; i++) variance += (dailyLoad[i] - avg) ** 2;
      sumOfParticipantStdDevs += Math.sqrt(variance / numDays);
    }
    participantCount++;
  }

  const dailyPerParticipantStdDev = participantCount > 0 ? sumOfParticipantStdDevs / participantCount : 0;

  // ── Global daily std-dev ──
  let gSum = 0;
  for (let i = 0; i < numDays; i++) gSum += globalDayTotals[i];

  let teamCapTotal = 0;
  const teamCapPerDay = new Float64Array(numDays);
  if (capacities) {
    for (let i = 0; i < numDays; i++) {
      const dk = dayList[i];
      let dayCap = 0;
      for (const cap of capacities.values()) dayCap += cap.dailyAvailableHours.get(dk) ?? 0;
      teamCapPerDay[i] = dayCap;
      teamCapTotal += dayCap;
    }
  }

  let gVariance = 0;
  if (capacities && teamCapTotal > 0) {
    // Capacity-proportional global target — each day's expected total scales
    // with that day's share of total team capacity. A Shabbat-eve day with
    // half the staff naturally gets half the load and is not penalised.
    for (let i = 0; i < numDays; i++) {
      const target = gSum * (teamCapPerDay[i] / teamCapTotal);
      gVariance += (globalDayTotals[i] - target) ** 2;
    }
  } else {
    const gAvg = gSum / numDays;
    for (let i = 0; i < numDays; i++) gVariance += (globalDayTotals[i] - gAvg) ** 2;
  }
  const dailyGlobalStdDev = Math.sqrt(gVariance / numDays);

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
  config?: SchedulerConfig,
): ConstraintViolation[] {
  const warnings: ConstraintViolation[] = [];
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);
  const tMap = new Map<string, Task>();
  for (const t of tasks) tMap.set(t.id, t);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const assignedPs = taskAssignments.map((a) => pMap.get(a.participantId)).filter((p): p is Participant => !!p);

    // Low-priority level warning: warn when a participant is assigned to a
    // slot where their level is marked lowPriority (last resort).
    // Only warn when penalty is active (> 0).
    if (!config || config.lowPriorityLevelPenalty > 0) {
      for (const asgn of taskAssignments) {
        const p = pMap.get(asgn.participantId);
        if (!p) continue;
        const slot = task.slots.find((s) => s.slotId === asgn.slotId);
        if (!slot) continue;
        if (isLowPriority(slot.acceptableLevels, p.level)) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'LOW_PRIORITY_LEVEL',
            message: `${p.name} (דרגה ${p.level}) \u200F— ${describeTaskInstance(task)}`,
            taskId: task.id,
            participantId: p.id,
          });
        }
      }
    }

    // SC-7: Group mismatch — always-on safety-net warning (HC-4 hard
    // constraint should prevent this; if it appears, something bypassed it).
    if (task.sameGroupRequired && assignedPs.length > 0) {
      const groups = new Set(assignedPs.map((p) => p.group));
      if (groups.size > 1) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'GROUP_MISMATCH',
          message: `${describeTaskInstance(task)} \u200F— ${groups.size} קבוצות: ${[...groups].join(', ')}`,
          taskId: task.id,
        });
      }
    }

    // SC-10: Less-preferred task name assignment warning
    for (const p of assignedPs) {
      if (p.lessPreferredTaskName && task.sourceName === p.lessPreferredTaskName) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'LESS_PREFERRED_ASSIGNMENT',
          message: `${p.name} \u200F— ${describeTaskInstance(task)}`,
          taskId: task.id,
          participantId: p.id,
        });
      }
    }
  }

  // SC-10: Preferred task name not satisfied — participant has a preference
  // but none of their assignments match it.
  const assignmentsByPid = new Map<string, Assignment[]>();
  for (const a of assignments) {
    let arr = assignmentsByPid.get(a.participantId);
    if (!arr) {
      arr = [];
      assignmentsByPid.set(a.participantId, arr);
    }
    arr.push(a);
  }
  const taskNameSet = new Set(tasks.map((t) => t.sourceName).filter(Boolean));
  for (const p of participants) {
    if (!p.preferredTaskName) continue;
    // Warn if the preferred name doesn't exist in the schedule at all
    if (!taskNameSet.has(p.preferredTaskName)) {
      warnings.push({
        severity: ViolationSeverity.Warning,
        code: 'PREFERRED_NAME_UNAVAILABLE',
        message: `${p.name} \u200F— "${p.preferredTaskName}" לא קיים בלוח`,
        taskId: '',
        participantId: p.id,
      });
      continue;
    }
    const pAssigns = assignmentsByPid.get(p.id) || [];
    const hasPreferred = pAssigns.some((a) => {
      const task = tMap.get(a.taskId);
      return task != null && task.sourceName === p.preferredTaskName;
    });
    if (!hasPreferred && pAssigns.length > 0) {
      warnings.push({
        severity: ViolationSeverity.Warning,
        code: 'PREFERRED_NOT_SATISFIED',
        message: `${p.name} \u200F— מעדיף/ה "${p.preferredTaskName}"`,
        taskId: pAssigns[0].taskId,
        participantId: p.id,
      });
    }
  }

  return warnings;
}

// ─── SC-9: "Not With" Togetherness Penalty ──────────────────────────────────

/** Sub-team a (task, slot) belongs to; slots without a subTeamId share the
 *  catch-all group. */
function subTeamOf(task: Task, slotId: string): string {
  return task.slots.find((s) => s.slotId === slotId)?.subTeamId ?? '__all__';
}

/**
 * Group togethernessRelevant fragments by OCCURRENCE: a split occurrence's
 * residual + every `#a`/`#b` half share `splitOccurrenceId ?? id`, and a
 * non-split task is its own single-fragment occurrence — so the grouping (and
 * therefore every downstream value) is byte-identical to the pre-split
 * per-task model when nothing is split.
 */
function groupAssignmentsByOccurrence(
  assignmentsByTask: ReadonlyMap<string, readonly Assignment[]>,
  taskMap: ReadonlyMap<string, Task>,
): Map<string, Assignment[]> {
  const byOcc = new Map<string, Assignment[]>();
  for (const [taskId, taskAssigns] of assignmentsByTask) {
    const task = taskMap.get(taskId);
    if (!task?.togethernessRelevant) continue;
    const occId = task.splitOccurrenceId ?? task.id;
    let arr = byOcc.get(occId);
    if (!arr) {
      arr = [];
      byOcc.set(occId, arr);
    }
    for (const a of taskAssigns) arr.push(a);
  }
  return byOcc;
}

/**
 * SC-9 shared kernel — the SINGLE source of truth for the not-with penalty so
 * the aggregate `computeNotWithPenalty` and the IncrementalScorer twin cannot
 * drift (the recurring scorer-drift hazard). `occAssigns` are all assignments
 * of ONE occurrence. For every not-with pair the contribution is
 *
 *   notWithPenalty × (Σ time the pair is SIMULTANEOUSLY present in the SAME
 *                     sub-team across the occurrence's fragments ÷ occ span)
 *
 * and each unordered pair is emitted exactly once via
 * `cb(lowPid, highPid, amount, …)` keyed by participant-id order. The
 * aggregate sums every emission; the twin sums emissions whose `lowPid` is the
 * scored participant — so Σ twin ≡ aggregate by construction, independent of
 * whether `notWithPairs` is symmetric.
 *
 * Non-split occurrence (one fragment over the whole task, one assignee per
 * slot): overlap = full span, ratio = 1 ⇒ amount = notWithPenalty — exactly
 * the pre-split per-pair value. Same-slot `#a`/`#b`: disjoint half-open
 * intervals ⇒ overlap 0 ⇒ no contribution (the pair is genuinely never
 * co-present, the product-confirmed semantic).
 */
function forEachOccurrenceNotWithContrib(
  occAssigns: readonly Assignment[],
  taskMap: ReadonlyMap<string, Task>,
  notWithPairs: ReadonlyMap<string, Set<string>>,
  notWithPenalty: number,
  cb: (lowPid: string, highPid: string, amount: number, sampleTaskId: string, sampleTaskName: string) => void,
): void {
  if (occAssigns.length < 2 || notWithPenalty <= 0 || notWithPairs.size === 0) return;
  const n = occAssigns.length;
  const pid: string[] = new Array(n);
  const team: string[] = new Array(n);
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  let occSpan = 0;
  for (let i = 0; i < n; i++) {
    const a = occAssigns[i];
    const t = taskMap.get(a.taskId);
    if (!t) {
      pid[i] = '';
      continue;
    }
    const s = t.timeBlock.start.getTime();
    const e = t.timeBlock.end.getTime();
    pid[i] = a.participantId;
    team[i] = subTeamOf(t, a.slotId);
    start[i] = s;
    end[i] = e;
    const span = t.splitOriginalMs ?? e - s;
    if (span > occSpan) occSpan = span;
  }
  if (occSpan <= 0) return;
  // Accumulate overlap per unordered not-with pair. A valid schedule has ≤1
  // fragment per participant per occurrence, but accumulating keeps the result
  // order-independent if that ever changes.
  const acc = new Map<string, { low: string; high: string; ov: number; tid: string; tn: string }>();
  for (let i = 0; i < n; i++) {
    if (pid[i] === '') continue;
    const set = notWithPairs.get(pid[i]);
    if (!set) continue;
    for (let j = i + 1; j < n; j++) {
      if (pid[j] === '' || pid[i] === pid[j] || team[i] !== team[j] || !set.has(pid[j])) continue;
      const ov = Math.min(end[i], end[j]) - Math.max(start[i], start[j]);
      if (ov <= 0) continue;
      const low = pid[i] < pid[j] ? pid[i] : pid[j];
      const high = pid[i] < pid[j] ? pid[j] : pid[i];
      const key = `${low}|${high}`;
      const prev = acc.get(key);
      if (prev) prev.ov += ov;
      else {
        const t = taskMap.get(occAssigns[i].taskId);
        acc.set(key, { low, high, ov, tid: occAssigns[i].taskId, tn: t?.name ?? '' });
      }
    }
  }
  for (const e of acc.values()) cb(e.low, e.high, notWithPenalty * (e.ov / occSpan), e.tid, e.tn);
}

/**
 * SC-9: total "not with" penalty — overlap-proportional per occurrence (see
 * `forEachOccurrenceNotWithContrib`). Byte-identical to the pre-split
 * per-task model when nothing is split.
 */
export function computeNotWithPenalty(
  _assignments: Assignment[],
  config: SchedulerConfig,
  taskMap: Map<string, Task>,
  assignmentsByTask: Map<string, Assignment[]>,
  notWithPairs: Map<string, Set<string>>,
): number {
  if (config.notWithPenalty <= 0 || notWithPairs.size === 0) return 0;
  const byOcc = groupAssignmentsByOccurrence(assignmentsByTask, taskMap);
  let penalty = 0;
  for (const occAssigns of byOcc.values()) {
    forEachOccurrenceNotWithContrib(
      occAssigns,
      taskMap,
      notWithPairs,
      config.notWithPenalty,
      (low, high, amount, tid, tn) => {
        penalty += amount;
        // Diagnostics: the pair IS co-present (overlap > 0). Gated on
        // _capturingFinal inside the recorder so it fires only on the
        // optimize()-final score pass, not transient mid-SA evaluations.
        recordNotWithViolation(low, high, tid, tn);
      },
    );
  }
  return penalty;
}

// ─── SC-10: Task Name Preference Penalty ──────────────────────────────────

/**
 * SC-10: Compute penalty for task-name preferences.
 *
 * Matches against Task.sourceName (the original template name, not the
 * day-prefixed display name).
 *
 * Three independent components:
 *  - **Avoidance** (per-assignment): each assignment to a participant's
 *    lessPreferredTaskName incurs `config.taskNameAvoidancePenalty`. Stacking
 *    gives SA a gradient — removing one disliked assignment still helps.
 *  - **Preference** (per-participant, binary): if a participant has a
 *    preferredTaskName but none of their assignments match it, incur
 *    `config.taskNamePreferencePenalty` once. Ensures at least one preferred
 *    assignment.
 *  - **Preference bonus** (per-assignment): each assignment to a
 *    participant's preferredTaskName reduces penalty by
 *    `config.taskNamePreferenceBonus`. Provides a continuous gradient so the
 *    optimizer keeps assigning preferred tasks beyond the first one.
 */
export function computeTaskNamePreferencePenalty(
  participants: Participant[],
  config: SchedulerConfig,
  taskMap: Map<string, Task>,
  assignmentsByParticipant: Map<string, Assignment[]>,
  phantomTaskIds?: Set<string>,
): number {
  if (
    config.taskNamePreferencePenalty <= 0 &&
    config.taskNameAvoidancePenalty <= 0 &&
    config.taskNamePreferenceBonus <= 0
  )
    return 0;

  let penalty = 0;
  for (const p of participants) {
    const pAssigns = assignmentsByParticipant.get(p.id) || [];
    if (pAssigns.length === 0) continue;

    // Avoidance: per-assignment penalty for less-preferred task name.
    // Scaled by fragmentShare so a split half of a disliked task costs a
    // time-proportional share (½ + ½ of one occurrence = one whole, not two).
    // fragmentShare === 1 for any non-split task ⇒ byte-identical when off.
    if (p.lessPreferredTaskName && config.taskNameAvoidancePenalty > 0) {
      for (const a of pAssigns) {
        if (phantomTaskIds?.has(a.taskId)) continue;
        const task = taskMap.get(a.taskId);
        if (task && task.sourceName === p.lessPreferredTaskName) {
          penalty += config.taskNameAvoidancePenalty * fragmentShare(task);
        }
      }
    }

    // Preference: binary penalty if no assignment to preferred name
    if (p.preferredTaskName && config.taskNamePreferencePenalty > 0) {
      const hasPreferred = pAssigns.some((a) => {
        if (phantomTaskIds?.has(a.taskId)) return false;
        const task = taskMap.get(a.taskId);
        return task != null && task.sourceName === p.preferredTaskName;
      });
      if (!hasPreferred) {
        penalty += config.taskNamePreferencePenalty;
      }
    }

    // Preference bonus: per-assignment reward for preferred task name,
    // fragment-scaled so two people splitting a preferred shift get ½ bonus
    // each (= one whole bonus total) rather than a full bonus each. The
    // binary "got their preferred at all" check above is intentionally NOT
    // scaled — per the product decision a half still satisfies the
    // preference. fragmentShare === 1 for non-split ⇒ unchanged when off.
    if (p.preferredTaskName && config.taskNamePreferenceBonus > 0) {
      for (const a of pAssigns) {
        if (phantomTaskIds?.has(a.taskId)) continue;
        const task = taskMap.get(a.taskId);
        if (task && task.sourceName === p.preferredTaskName) {
          penalty -= config.taskNamePreferenceBonus * fragmentShare(task);
        }
      }
    }
  }
  return penalty;
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
  /** Optional: "not with" pair preferences for togetherness penalty */
  notWithPairs?: Map<string, Set<string>>;
  /** Hour (0-23) defining the operational day boundary (default 5) */
  dayStartHour?: number;
  /**
   * Optional: phantom task IDs to exclude from scoring iteration. The optimizer
   * seeds `assignmentsByParticipant` and `taskMap` with phantom assignments so
   * HC-5/12/14/15 see them across schedule boundaries; scoring must skip those
   * same entries to keep SA-internal score == final reported score. HC checks
   * read `byParticipant`/`taskMap` directly and never touch this field.
   * Absent / empty → behave as before (no filtering).
   */
  phantomTaskIds?: Set<string>;
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
/**
 * Number of SPLIT SLOTS in a task set = count of first-half
 * (`splitPart === 1`) tasks. Splitting is slot-level: each split SLOT yields
 * exactly one `#a` half, so this equals the number of distinct (per-slot)
 * `splitGroupId`s — an occurrence with two split slots counts as two. The
 * split penalty scales per split slot (more fragmentation ⇒ stronger
 * parsimony pressure), which is the intended slot-level semantic. Zero (and
 * therefore zero penalty) for any task set with no splits — keeping the
 * composite byte-identical to pre-feature behavior when splitting is off.
 * (Name kept for stability; it predates the slot-level model.)
 */
export function countSplitOccurrences(tasks: Task[]): number {
  let n = 0;
  for (const t of tasks) if (t.splitPart === 1) n++;
  return n;
}

/** Total shift-split penalty (run-constant in v1). */
function splitPenaltyTotal(tasks: Task[], config: SchedulerConfig): number {
  const w = config.splitPenalty;
  if (!w) return 0;
  const n = countSplitOccurrences(tasks);
  return n === 0 ? 0 : w * n;
}

export function computeScheduleScore(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
  ctx?: ScoreContext,
): ScheduleScore {
  // Reuse or build lookup maps
  const taskMap = ctx?.taskMap ?? new Map(tasks.map((t) => [t.id, t]));
  const pMap = ctx?.pMap ?? new Map(participants.map((p) => [p.id, p]));

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
  const profiles = computeAllRestProfiles(
    participants,
    assignments,
    tasks,
    taskMap,
    byParticipant,
    ctx?.phantomTaskIds,
  );
  const fairness = computeRestFairness(profiles);

  // Per-gap rest gradient: Σ √gap across all participants. Concave, target-free,
  // so every individual gap improvement is visible to SA — escapes the
  // globalMin plateau in symmetric scenarios where every participant sits at
  // the same minRest. Free to compute (already summed inside each profile).
  let restPerGapBonus = 0;
  for (const prof of profiles.values()) restPerGapBonus += prof.restPerGapBonus;

  // Split-pool workload stats — pass pre-built data + capacities
  const wlSplit = workloadImbalanceSplit(
    participants,
    assignments,
    tasks,
    taskMap,
    byParticipant,
    ctx?.capacities,
    ctx?.phantomTaskIds,
  );

  // Reuse the combined std-dev already computed inside workloadImbalanceSplit
  // to avoid a redundant O(P×A) effective-hours scan.
  const combinedStdDev = wlSplit.combinedStdDev;

  // Penalties — captured per bucket so the score-breakdown panel can show
  // SC-6 / SC-9 / SC-10 contributions individually. Same calls as before, just
  // bound to named locals before being summed.
  // Workload imbalance is captured directly via l0FairnessWeight * l0StdDev
  // and seniorFairnessWeight * seniorStdDev in the composite formula — no
  // double-counting through totalPenalty.
  // SC-5 (back-to-back penalty) removed — redundant with minRestWeight and HC-12.

  // SC-6: Low-priority level penalty — pass pre-built maps
  const lowPriorityPenalty = computeLowPriorityLevelPenalty(participants, assignments, tasks, config, pMap, taskMap);

  // SC-9: "Not with" togetherness penalty
  const notWithPenalty =
    ctx?.notWithPairs && ctx.notWithPairs.size > 0
      ? computeNotWithPenalty(assignments, config, taskMap, assignmentsByTask, ctx.notWithPairs)
      : 0;

  // SC-10: Task name preference penalty
  const taskPrefPenalty = computeTaskNamePreferencePenalty(
    participants,
    config,
    taskMap,
    byParticipant,
    ctx?.phantomTaskIds,
  );

  // Shift-split penalty — run-constant (no in-run splitting in v1). Kept out
  // of `totalPenalty` (which is the SC-6/9/10 bucket the breakdown panel
  // splits) and subtracted directly in the composite, mirrored exactly in
  // IncrementalScorer.deriveComposite. Zero when no task is split.
  const splitPenalty = splitPenaltyTotal(tasks, config);

  const totalPenalty = lowPriorityPenalty + notWithPenalty + taskPrefPenalty;

  // SC-8: Daily workload balance — pass pre-built data + capacities
  const dailyBalance = dailyWorkloadImbalance(
    participants,
    assignments,
    tasks,
    taskMap,
    byParticipant,
    ctx?.capacities,
    ctx?.dayStartHour ?? 5,
    ctx?.phantomTaskIds,
  );

  // Composite score
  const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
  const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;

  const compositeScore =
    config.minRestWeight * minRest +
    config.restPerGapWeight * restPerGapBonus -
    config.l0FairnessWeight * wlSplit.l0StdDev -
    config.seniorFairnessWeight * wlSplit.seniorStdDev -
    config.dailyBalanceWeight * (dailyBalance.dailyPerParticipantStdDev + dailyBalance.dailyGlobalStdDev) -
    totalPenalty -
    splitPenalty;

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
    restPerGapBonus,
    lowPriorityPenalty,
    notWithPenalty,
    taskPrefPenalty,
    splitPenalty,
  };
}

// ─── Incremental Scorer for SA Swaps ─────────────────────────────────────────

/**
 * Pre-computed per-participant data for incremental score updates.
 */
interface ParticipantScoreData {
  effectiveHours: number;
  minRest: number; // min rest gap (Infinity if no blocking rest gaps)
  /** Σ √gap across this participant's gaps — for the per-gap rest gradient */
  restPerGapBonus: number;
  /**
   * operationalDateKey → effective hours.
   *
   * IMMUTABLE AFTER CONSTRUCTION. Built once in `computeParticipantData`
   * and read-only thereafter. `saveParticipant()` aliases this reference
   * instead of cloning, which is only safe because no code mutates the
   * map after it is attached to a `ParticipantScoreData`. If you ever need
   * to update daily loads, REPLACE the whole `ParticipantScoreData` object
   * via `perParticipant.set(...)` (as `recomputeForSwap` does) — never
   * call `.set` / `.delete` on this map in place.
   */
  dailyLoads: ReadonlyMap<string, number>;
  dailyStdDev: number; // std-dev of this participant's daily loads
  isL0: boolean;
  capacity: number; // total available hours
}

/**
 * IncrementalScorer: maintains running statistics to enable O(k) score
 * recomputation on participant swaps instead of O(P×A) full rescoring.
 *
 * Usage:
 *  1. Create via `IncrementalScorer.build(...)` before the SA loop
 *  2. Call `recomputeForSwap(pidA, pidB)` after swapping two participants
 *  3. Read `compositeScore` for the current score
 *  4. Call `undoSwap(pidA, pidB, savedA, savedB)` if the swap is rejected
 */
export class IncrementalScorer {
  private perParticipant: Map<string, ParticipantScoreData>;
  private participants: Participant[];
  /** O(1) participant lookup — avoids O(n) find() in recomputeForSwap */
  private pMap: Map<string, Participant>;
  private config: SchedulerConfig;
  private taskMap: Map<string, Task>;
  private assignmentsByParticipant: Map<string, Assignment[]>;
  private slotByTaskId: Map<string, Map<string, SlotRequirement>>;
  /**
   * Per-task assignment index for not-with scoring. Assignment objects are
   * shared with `assignmentsByParticipant`, so participantId swaps are visible
   * here without rebuilding the task grouping.
   */
  private assignmentsByTask: ReadonlyMap<string, readonly Assignment[]>;
  /**
   * Per-OCCURRENCE assignment index (key = `splitOccurrenceId ?? taskId`) for
   * the overlap-proportional SC-9. Built once in `build()` from the same
   * Assignment objects as `assignmentsByTask`; those objects are shared so
   * participant swaps are visible without rebuilding, and the split set is
   * frozen for the scorer's lifetime (Option B) so the key→list structure is
   * invariant across SA swaps. Identical to the per-task grouping — and unused
   * beyond it — when nothing is split.
   */
  private assignmentsByOccurrence: Map<string, Assignment[]> = new Map();
  /**
   * Phantom task IDs to skip during scoring iteration. Phantoms are seeded
   * into `taskMap` and `assignmentsByParticipant` for cross-boundary HC checks
   * but must NOT contribute to score components (l0StdDev, minRest, penalties)
   * or the optimizer would optimise a different objective than the one finally
   * reported. Empty set disables filtering.
   */
  private phantomTaskIds: Set<string> = new Set();
  private capacities: Map<string, ParticipantCapacity>;
  private dayList: string[];
  private _dayStartHour = 5;

  // Running statistics for L0 pool
  private l0Sum = 0;
  private l0SumSq = 0;
  private l0Count = 0;
  // Running statistics for senior pool
  private seniorSum = 0;
  private seniorSumSq = 0;
  private seniorCount = 0;
  // Global min rest
  private _globalMinRest = 0;
  private _globalAvgRest = 0;
  // Per-gap rest gradient (Σ √gap across all participants).
  // Maintained as a running sum so swap delta is O(k): subtract old A,B
  // contributions, add new A,B contributions in (add|remove)ParticipantContribution.
  private _restPerGapBonusSum = 0;
  // Low-priority level penalty
  private _lowPriorityPenalty = 0;
  /** Per-participant low-priority penalty for O(1) delta updates */
  private _perParticipantLowPriorityPenalty: Map<string, number>;
  // Daily balance
  private _dailyPerParticipantStdDevSum = 0;
  private _participantCount = 0;
  // Global daily totals (mutated by addParticipantContribution / removeParticipantContribution)
  private globalDayTotals: Map<string, number>;
  // Capacity per op-day, summed across all participants. Invariant across SA
  // swaps (capacities don't change with assignment moves), so populated once
  // in build() and read-only thereafter. Used by computeGlobalDailyStdDev to
  // build a capacity-proportional global target.
  private globalDayCapacities: Map<string, number>;
  // Sum of globalDayCapacities — cached to avoid re-summing on every swap.
  private _globalDayCapTotal = 0;

  // Saved low-priority state for undo (set at start of recomputeForSwap)
  private _savedLowPriorityTotal = 0;
  private _savedLowPriorityEntries: [string, number][] = [];

  // "Not with" penalty
  private _notWithPenalty = 0;
  /** Per-participant not-with penalty (attributed to lower-ID participant in each pair) */
  private _perParticipantNotWithPenalty: Map<string, number> = new Map();
  private _notWithPairs: Map<string, Set<string>> = new Map();
  // Saved not-with state for undo
  private _savedNotWithTotal = 0;
  private _savedNotWithEntries: [string, number][] = [];

  // Task preference penalty (SC-10)
  private _taskPrefPenalty = 0;
  private _perParticipantTaskPrefPenalty: Map<string, number> = new Map();
  // Saved task preference state for undo
  private _savedTaskPrefTotal = 0;
  private _savedTaskPrefEntries: [string, number][] = [];
  // Shift-split penalty — run-constant (no in-run splitting in v1: splitting
  // only happens in greedy, before build()). Set once in build(), never
  // touched by recomputeForSwap/undo (participant swaps don't change which
  // tasks are split), so no per-participant / save-restore machinery needed.
  private _splitPenalty = 0;

  // Current composite score
  compositeScore = 0;

  private constructor() {
    this.perParticipant = new Map();
    this.participants = [];
    this.pMap = new Map();
    this.config = {} as SchedulerConfig;
    this.taskMap = new Map();
    this.assignmentsByParticipant = new Map();
    this.slotByTaskId = new Map();
    this.assignmentsByTask = new Map();
    this.capacities = new Map();
    this.dayList = [];
    this.globalDayTotals = new Map();
    this.globalDayCapacities = new Map();
    this._perParticipantLowPriorityPenalty = new Map();
    this._perParticipantNotWithPenalty = new Map();
    this._notWithPairs = new Map();
    this._perParticipantTaskPrefPenalty = new Map();
  }

  /**
   * Build incremental scorer from the full state.
   */
  static build(
    tasks: Task[],
    participants: Participant[],
    assignments: Assignment[],
    config: SchedulerConfig,
    ctx: ScoreContext,
  ): IncrementalScorer {
    const scorer = new IncrementalScorer();
    scorer.participants = participants;
    scorer.pMap = ctx.pMap;
    scorer.config = config;
    scorer.taskMap = ctx.taskMap;
    scorer.phantomTaskIds = ctx.phantomTaskIds ?? new Set();
    scorer.assignmentsByParticipant = ctx.assignmentsByParticipant ?? new Map();
    scorer.slotByTaskId = new Map();
    for (const [taskId, task] of scorer.taskMap) {
      const slots = new Map<string, SlotRequirement>();
      for (const slot of task.slots) {
        if (!slots.has(slot.slotId)) slots.set(slot.slotId, slot);
      }
      scorer.slotByTaskId.set(taskId, slots);
    }
    if (ctx.assignmentsByTask) {
      scorer.assignmentsByTask = ctx.assignmentsByTask;
    } else {
      const byTask = new Map<string, Assignment[]>();
      for (const a of assignments) {
        if (scorer.phantomTaskIds.has(a.taskId)) continue;
        const list = byTask.get(a.taskId);
        if (list) list.push(a);
        else byTask.set(a.taskId, [a]);
      }
      scorer.assignmentsByTask = byTask;
    }
    // Occurrence index for SC-9 (same shared Assignment objects ⇒ stays
    // consistent under participant swaps exactly like assignmentsByTask).
    scorer.assignmentsByOccurrence = groupAssignmentsByOccurrence(scorer.assignmentsByTask, scorer.taskMap);
    scorer.capacities = ctx.capacities ?? new Map();

    // Collect all operational days
    const dsh = ctx.dayStartHour ?? 5;
    scorer._dayStartHour = dsh;
    const allDays = new Set<string>();
    for (const t of tasks) allDays.add(operationalDateKey(taskOpDayStart(t), dsh));
    scorer.dayList = [...allDays].sort();

    // Init global day totals
    for (const d of scorer.dayList) scorer.globalDayTotals.set(d, 0);

    // Init global day capacities — Σ cap_p_d across all participants.
    // Invariant for the lifetime of the scorer (capacities don't change with
    // assignment swaps), so we compute once and cache the sum.
    scorer._globalDayCapTotal = 0;
    for (const d of scorer.dayList) {
      let dayCap = 0;
      for (const cap of scorer.capacities.values()) dayCap += cap.dailyAvailableHours.get(d) ?? 0;
      scorer.globalDayCapacities.set(d, dayCap);
      scorer._globalDayCapTotal += dayCap;
    }

    scorer._participantCount = participants.length;

    // Build per-participant data
    for (const p of participants) {
      const pAssignments = scorer.assignmentsByParticipant.get(p.id) || [];
      const data = scorer.computeParticipantData(p, pAssignments);
      scorer.perParticipant.set(p.id, data);

      // Accumulate running statistics
      if (data.isL0) {
        scorer.l0Sum += data.effectiveHours;
        scorer.l0SumSq += data.effectiveHours ** 2;
        scorer.l0Count++;
      } else {
        scorer.seniorSum += data.effectiveHours;
        scorer.seniorSumSq += data.effectiveHours ** 2;
        scorer.seniorCount++;
      }
      scorer._dailyPerParticipantStdDevSum += data.dailyStdDev;
      scorer._restPerGapBonusSum += data.restPerGapBonus;
      for (const [dk, load] of data.dailyLoads) {
        scorer.globalDayTotals.set(dk, (scorer.globalDayTotals.get(dk) || 0) + load);
      }
    }

    // Compute per-participant low-priority level penalty for O(1) delta updates
    scorer._lowPriorityPenalty = 0;
    for (const p of participants) {
      let pPenalty = 0;
      const pAs = scorer.assignmentsByParticipant.get(p.id) || [];
      for (const a of pAs) {
        if (scorer.phantomTaskIds.has(a.taskId)) continue;
        const task = ctx.taskMap.get(a.taskId);
        if (!task) continue;
        const slot = scorer.getSlot(a.taskId, a.slotId);
        if (slot && isLowPriority(slot.acceptableLevels, p.level)) {
          // Fragment-scaled — lockstep with computeLowPriorityLevelPenalty.
          pPenalty += config.lowPriorityLevelPenalty * fragmentShare(task);
        }
      }
      if (pPenalty > 0) {
        scorer._perParticipantLowPriorityPenalty.set(p.id, pPenalty);
        scorer._lowPriorityPenalty += pPenalty;
      }
    }

    // Compute per-participant "not with" penalty for O(1) delta updates.
    // Attribute each pair's penalty to the participant with the lower ID.
    scorer._notWithPairs = ctx.notWithPairs ?? new Map();
    scorer._notWithPenalty = 0;
    if (scorer._notWithPairs.size > 0 && config.notWithPenalty > 0) {
      // For each participant, compute their not-with penalty
      for (const p of participants) {
        const pPenalty = scorer.computeParticipantNotWithPenalty(p.id);
        if (pPenalty > 0) {
          scorer._perParticipantNotWithPenalty.set(p.id, pPenalty);
          scorer._notWithPenalty += pPenalty;
        }
      }
    }

    // Compute per-participant task name preference penalty for O(1) delta updates.
    scorer._taskPrefPenalty = 0;
    if (
      config.taskNamePreferencePenalty > 0 ||
      config.taskNameAvoidancePenalty > 0 ||
      config.taskNamePreferenceBonus > 0
    ) {
      for (const p of participants) {
        const pPenalty = scorer.computeParticipantTaskPrefPenalty(p.id);
        if (pPenalty !== 0) {
          scorer._perParticipantTaskPrefPenalty.set(p.id, pPenalty);
          scorer._taskPrefPenalty += pPenalty;
        }
      }
    }

    // Shift-split penalty — run-constant: the split set is fixed before
    // build() (splitting only happens in greedy in v1), so this is computed
    // once here and never updated by recomputeForSwap/undo.
    scorer._splitPenalty = splitPenaltyTotal(tasks, config);

    // Compute rest statistics
    scorer.recomputeRestStats();

    // Compute initial composite
    scorer.compositeScore = scorer.deriveComposite();

    return scorer;
  }

  /**
   * Not-with penalty attributed to `pid` — the lower-id half of each pair's
   * overlap-proportional contribution (the SAME `forEachOccurrenceNotWithContrib`
   * kernel the aggregate uses, so Σ over all pids ≡ the aggregate exactly).
   *
   * NOTE: no `!myNotWith` early-out — a pair can be emitted because the OTHER
   * participant declared `pid`, yet be attributed to `pid` as the lower id, so
   * `pid` must run the kernel even when it declares nobody. Each occurrence is
   * processed once for `pid` (seenOcc), reading the occurrence-level index so
   * cross-fragment co-presence (residual ↔ half, half ↔ half of other slots)
   * is seen — a per-task index would miss it.
   */
  private computeParticipantNotWithPenalty(pid: string): number {
    if (this._notWithPairs.size === 0 || this.config.notWithPenalty <= 0) return 0;
    let penalty = 0;
    const pAssigns = this.assignmentsByParticipant.get(pid) || [];
    const seenOcc = new Set<string>();
    for (const a of pAssigns) {
      if (this.phantomTaskIds.has(a.taskId)) continue;
      const task = this.taskMap.get(a.taskId);
      if (!task?.togethernessRelevant) continue;
      const occId = task.splitOccurrenceId ?? task.id;
      if (seenOcc.has(occId)) continue;
      seenOcc.add(occId);
      const occAssigns = this.assignmentsByOccurrence.get(occId);
      if (!occAssigns) continue;
      forEachOccurrenceNotWithContrib(
        occAssigns,
        this.taskMap,
        this._notWithPairs,
        this.config.notWithPenalty,
        (low, _high, amount) => {
          if (low === pid) penalty += amount;
        },
      );
    }
    return penalty;
  }

  private getSlot(taskId: string, slotId: string): SlotRequirement | undefined {
    return this.slotByTaskId.get(taskId)?.get(slotId);
  }

  /**
   * Compute task name preference penalty for a specific participant.
   * Avoidance: per-assignment penalty for lessPreferredTaskName.
   * Preference: binary penalty if no assignment to preferredTaskName.
   */
  private computeParticipantTaskPrefPenalty(pid: string): number {
    const p = this.pMap.get(pid);
    if (!p) return 0;
    const pAssigns = this.assignmentsByParticipant.get(pid) || [];
    if (pAssigns.length === 0) return 0;

    let penalty = 0;

    // Avoidance: per-assignment penalty, fragment-scaled (mirror of the
    // aggregate computeTaskNamePreferencePenalty — must stay in lockstep or
    // SA optimises a different objective than the final score).
    if (p.lessPreferredTaskName && this.config.taskNameAvoidancePenalty > 0) {
      for (const a of pAssigns) {
        if (this.phantomTaskIds.has(a.taskId)) continue;
        const task = this.taskMap.get(a.taskId);
        if (task && task.sourceName === p.lessPreferredTaskName) {
          penalty += this.config.taskNameAvoidancePenalty * fragmentShare(task);
        }
      }
    }

    // Preference: binary penalty
    if (p.preferredTaskName && this.config.taskNamePreferencePenalty > 0) {
      const hasPreferred = pAssigns.some((a) => {
        if (this.phantomTaskIds.has(a.taskId)) return false;
        const task = this.taskMap.get(a.taskId);
        return task != null && task.sourceName === p.preferredTaskName;
      });
      if (!hasPreferred) {
        penalty += this.config.taskNamePreferencePenalty;
      }
    }

    // Preference bonus: per-assignment reward, fragment-scaled (mirror of the
    // aggregate). Binary "has preferred" above is intentionally unscaled.
    if (p.preferredTaskName && this.config.taskNamePreferenceBonus > 0) {
      for (const a of pAssigns) {
        if (this.phantomTaskIds.has(a.taskId)) continue;
        const task = this.taskMap.get(a.taskId);
        if (task && task.sourceName === p.preferredTaskName) {
          penalty -= this.config.taskNamePreferenceBonus * fragmentShare(task);
        }
      }
    }

    return penalty;
  }

  private computeParticipantData(p: Participant, pAssignments: Assignment[]): ParticipantScoreData {
    let effectiveHours = 0;
    const dailyLoads = new Map<string, number>();

    for (const a of pAssignments) {
      if (this.phantomTaskIds.has(a.taskId)) continue;
      const task = this.taskMap.get(a.taskId);
      if (!task) continue;
      const eff = computeTaskEffectiveHours(task);
      effectiveHours += eff;
      // Bucket by occurrence op-day (taskOpDayStart) so a split `#b` whose
      // midpoint crossed the dayStartHour boundary lands with its residual /
      // `#a`. Mirrors the aggregate dailyWorkloadImbalance. Non-split tasks
      // return timeBlock.start unchanged ⇒ byte-identical when off.
      const dk = operationalDateKey(taskOpDayStart(task), this._dayStartHour);
      dailyLoads.set(dk, (dailyLoads.get(dk) || 0) + eff);
    }

    // Rest profile (phantom-blind: phantom assignments must not influence rest scoring)
    const restProfile = computeRestFromAssignments(p.id, pAssignments, this.taskMap, this.phantomTaskIds);

    // Daily std-dev for this participant — capacity-proportional target.
    // Each day's expected load scales with (cap_d / totalCap_p) so a participant
    // available 4h Monday and 24h Tuesday is expected to carry ~6× more on
    // Tuesday, not equal hours on both. Mirrors `dailyWorkloadImbalance`.
    const cap = this.capacities.get(p.id);
    let dailyStdDev = 0;
    if (this.dayList.length > 1) {
      let totalCap = 0;
      if (cap) {
        for (const dk of this.dayList) {
          const c = cap.dailyAvailableHours.get(dk) ?? 0;
          if (c > 0) totalCap += c;
        }
      }

      if (cap && totalCap > 0) {
        let totalLoad = 0;
        for (const dk of this.dayList) totalLoad += dailyLoads.get(dk) || 0;
        let variance = 0;
        let availDays = 0;
        for (const dk of this.dayList) {
          const cd = cap.dailyAvailableHours.get(dk) ?? 0;
          if (cd <= 0) continue;
          const target = totalLoad * (cd / totalCap);
          variance += ((dailyLoads.get(dk) || 0) - target) ** 2;
          availDays++;
        }
        if (availDays > 0) dailyStdDev = Math.sqrt(variance / availDays);
      } else {
        // No-capacity graceful degradation — flat-mean across all days.
        let sum = 0;
        for (const dk of this.dayList) sum += dailyLoads.get(dk) || 0;
        const avg = sum / this.dayList.length;
        let variance = 0;
        for (const dk of this.dayList) variance += ((dailyLoads.get(dk) || 0) - avg) ** 2;
        dailyStdDev = Math.sqrt(variance / this.dayList.length);
      }
    }

    return {
      effectiveHours,
      minRest: restProfile.minRestHours,
      restPerGapBonus: restProfile.restPerGapBonus,
      dailyLoads,
      dailyStdDev,
      isL0: p.level === Level.L0,
      capacity: effectiveCapacity(p, cap?.totalAvailableHours ?? 0),
    };
  }

  private recomputeRestStats(): void {
    let minRest = Infinity;
    let sumRest = 0;
    let restCount = 0;
    for (const d of this.perParticipant.values()) {
      if (Number.isFinite(d.minRest) && d.minRest !== Infinity) {
        minRest = Math.min(minRest, d.minRest);
        sumRest += d.minRest;
        restCount++;
      }
    }
    if (restCount === 0) {
      this._globalMinRest = 0;
      this._globalAvgRest = 0;
    } else {
      this._globalMinRest = minRest;
      this._globalAvgRest = sumRest / restCount;
    }
  }

  /**
   * Compute workload std-dev using proportional targets when capacities exist.
   */
  private computePoolStdDev(sum: number, sumSq: number, count: number, isL0: boolean): number {
    if (count === 0) return 0;

    // Check if proportional targets are available
    let totalCap = 0;
    for (const [pid, data] of this.perParticipant) {
      if (data.isL0 === isL0) totalCap += data.capacity;
    }

    if (totalCap > 0) {
      // Proportional: target_i = totalLoad × (cap_i / totalCap)
      let variance = 0;
      for (const [pid, data] of this.perParticipant) {
        if (data.isL0 !== isL0) continue;
        const target = sum * (data.capacity / totalCap);
        variance += (data.effectiveHours - target) ** 2;
      }
      return Math.sqrt(variance / count);
    }

    // Flat average
    const avg = sum / count;
    const variance = (sumSq - 2 * avg * sum + count * avg * avg) / count;
    return Math.sqrt(Math.max(0, variance));
  }

  private computeGlobalDailyStdDev(): number {
    if (this.dayList.length <= 1) return 0;
    let gSum = 0;
    for (const d of this.dayList) gSum += this.globalDayTotals.get(d) || 0;

    // Capacity-proportional global target — each day's expected total scales
    // with that day's share of total team capacity. A Shabbat-eve day with
    // half the staff naturally gets half the load and is not penalised.
    if (this._globalDayCapTotal > 0) {
      let gVar = 0;
      for (const d of this.dayList) {
        const target = gSum * ((this.globalDayCapacities.get(d) ?? 0) / this._globalDayCapTotal);
        gVar += ((this.globalDayTotals.get(d) || 0) - target) ** 2;
      }
      return Math.sqrt(gVar / this.dayList.length);
    }

    // Graceful degradation when no capacities — flat mean across days.
    const gAvg = gSum / this.dayList.length;
    let gVar = 0;
    for (const d of this.dayList) gVar += ((this.globalDayTotals.get(d) || 0) - gAvg) ** 2;
    return Math.sqrt(gVar / this.dayList.length);
  }

  private deriveComposite(): number {
    const minRest = this._globalMinRest;
    const l0StdDev = this.computePoolStdDev(this.l0Sum, this.l0SumSq, this.l0Count, true);
    const seniorStdDev = this.computePoolStdDev(this.seniorSum, this.seniorSumSq, this.seniorCount, false);

    const dailyPP = this._participantCount > 0 ? this._dailyPerParticipantStdDevSum / this._participantCount : 0;
    const dailyGlobal = this.computeGlobalDailyStdDev();

    return (
      this.config.minRestWeight * minRest +
      this.config.restPerGapWeight * this._restPerGapBonusSum -
      this.config.l0FairnessWeight * l0StdDev -
      this.config.seniorFairnessWeight * seniorStdDev -
      this.config.dailyBalanceWeight * (dailyPP + dailyGlobal) -
      this._lowPriorityPenalty -
      this._notWithPenalty -
      this._taskPrefPenalty -
      this._splitPenalty
    );
  }

  /**
   * Save the current state for a participant (call before swap to enable undo).
   */
  saveParticipant(pid: string): ParticipantScoreData | undefined {
    const data = this.perParticipant.get(pid);
    if (!data) return undefined;
    // dailyLoads is aliased, not cloned: it is treated as immutable after
    // construction (see ParticipantScoreData.dailyLoads docs). recomputeForSwap
    // replaces the whole object via perParticipant.set, so the saved snapshot
    // never observes a mutated map.
    return { ...data };
  }

  /**
   * Recompute score after swapping participants pidA and pidB.
   * Only recomputes data for the two affected participants.
   * Uses pMap for O(1) lookup (was O(n) find()).
   * Returns the new composite score.
   */
  recomputeForSwap(pidA: string, pidB: string): number {
    const pA = this.pMap.get(pidA);
    const pB = this.pMap.get(pidB);
    if (!pA || !pB) return this.compositeScore;

    // Remove old contributions
    this.removeParticipantContribution(pidA);
    this.removeParticipantContribution(pidB);

    // Recompute with new assignments
    const aAssigns = this.assignmentsByParticipant.get(pidA) || [];
    const bAssigns = this.assignmentsByParticipant.get(pidB) || [];
    const newDataA = this.computeParticipantData(pA, aAssigns);
    const newDataB = this.computeParticipantData(pB, bAssigns);

    // Add new contributions
    this.perParticipant.set(pidA, newDataA);
    this.perParticipant.set(pidB, newDataB);
    this.addParticipantContribution(pidA);
    this.addParticipantContribution(pidB);

    // Recompute rest stats (global min might have changed)
    this.recomputeRestStats();

    // Recompute low-priority level penalty for only the two swapped participants
    // using per-participant tracking for O(k) instead of O(P×A).
    // Save state first so finalizeUndo() can revert on rejected swaps.
    this._savedLowPriorityTotal = this._lowPriorityPenalty;
    this._savedLowPriorityEntries = [
      [pidA, this._perParticipantLowPriorityPenalty.get(pidA) || 0],
      [pidB, this._perParticipantLowPriorityPenalty.get(pidB) || 0],
    ];

    {
      // Remove old per-participant penalties
      const oldPenaltyA = this._savedLowPriorityEntries[0][1];
      const oldPenaltyB = this._savedLowPriorityEntries[1][1];
      this._lowPriorityPenalty -= oldPenaltyA + oldPenaltyB;

      // Compute new per-participant low-priority penalties
      const computeLpPenalty = (pid: string): number => {
        const p = this.pMap.get(pid);
        if (!p) return 0;
        let penalty = 0;
        const pAs = this.assignmentsByParticipant.get(pid) || [];
        for (const a of pAs) {
          if (this.phantomTaskIds.has(a.taskId)) continue;
          const task = this.taskMap.get(a.taskId);
          if (!task) continue;
          const slot = this.getSlot(a.taskId, a.slotId);
          if (slot && isLowPriority(slot.acceptableLevels, p.level)) {
            // Fragment-scaled — lockstep with computeLowPriorityLevelPenalty.
            penalty += this.config.lowPriorityLevelPenalty * fragmentShare(task);
          }
        }
        return penalty;
      };

      const newPenaltyA = computeLpPenalty(pidA);
      const newPenaltyB = computeLpPenalty(pidB);
      this._perParticipantLowPriorityPenalty.set(pidA, newPenaltyA);
      this._perParticipantLowPriorityPenalty.set(pidB, newPenaltyB);
      this._lowPriorityPenalty += newPenaltyA + newPenaltyB;
    }

    // Recompute "not with" penalty for the two swapped participants AND any
    // co-participants whose penalty attribution depends on the swapped pair.
    // The attribution rule (pid < partnerId) means a co-participant pidC with
    // pidC < pidA whose penalty covers the (pidC, pidA) pair must also be
    // recomputed when pidA moves between tasks.
    this._savedNotWithTotal = this._notWithPenalty;
    this._savedNotWithEntries = [
      [pidA, this._perParticipantNotWithPenalty.get(pidA) || 0],
      [pidB, this._perParticipantNotWithPenalty.get(pidB) || 0],
    ];
    if (this._notWithPairs.size > 0 && this.config.notWithPenalty > 0) {
      const aInvolvesTogetherness = aAssigns.some(
        (a) => !this.phantomTaskIds.has(a.taskId) && this.taskMap.get(a.taskId)?.togethernessRelevant,
      );
      const bInvolvesTogetherness = bAssigns.some(
        (a) => !this.phantomTaskIds.has(a.taskId) && this.taskMap.get(a.taskId)?.togethernessRelevant,
      );
      if (
        aInvolvesTogetherness ||
        bInvolvesTogetherness ||
        this._savedNotWithEntries[0][1] > 0 ||
        this._savedNotWithEntries[1][1] > 0
      ) {
        // Collect OCCURRENCES touched by the swapped participants. SC-9 is
        // occurrence-scoped (a split occurrence's residual + halves form one
        // unit), so a per-task scan would miss a co-participant on a different
        // fragment of the same occurrence. assignmentsByOccurrence is stable
        // under participant swaps (shared Assignment objects, frozen split
        // set) exactly like assignmentsByTask. Non-split ⇒ occId === taskId ⇒
        // identical set to the pre-split per-task collection.
        const affectedOccIds = new Set<string>();
        for (const a of aAssigns) {
          if (this.phantomTaskIds.has(a.taskId)) continue;
          const t = this.taskMap.get(a.taskId);
          if (t?.togethernessRelevant) affectedOccIds.add(t.splitOccurrenceId ?? t.id);
        }
        for (const a of bAssigns) {
          if (this.phantomTaskIds.has(a.taskId)) continue;
          const t = this.taskMap.get(a.taskId);
          if (t?.togethernessRelevant) affectedOccIds.add(t.splitOccurrenceId ?? t.id);
        }

        // Co-participants in those occurrences whose lower-id attribution could
        // shift when pidA/pidB move. notWith may be asymmetric and the
        // attributee is min(pid, partner), so include EITHER declaration
        // direction — a superset is safe (recompute is idempotent for
        // unchanged participants and every mutated entry is saved for undo).
        const aNotWith = this._notWithPairs.get(pidA);
        const bNotWith = this._notWithPairs.get(pidB);
        const affectedCoParticipants = new Set<string>();
        for (const occId of affectedOccIds) {
          const occAssigns = this.assignmentsByOccurrence.get(occId) || [];
          for (const ta of occAssigns) {
            const coPid = ta.participantId;
            if (coPid === pidA || coPid === pidB) continue;
            const coNotWith = this._notWithPairs.get(coPid);
            if (aNotWith?.has(coPid) || bNotWith?.has(coPid) || coNotWith?.has(pidA) || coNotWith?.has(pidB)) {
              affectedCoParticipants.add(coPid);
            }
          }
        }

        // Save and recompute co-participant penalties
        for (const coPid of affectedCoParticipants) {
          this._savedNotWithEntries.push([coPid, this._perParticipantNotWithPenalty.get(coPid) || 0]);
        }

        // Remove old contributions for all affected participants
        let oldTotal = 0;
        for (const [, oldVal] of this._savedNotWithEntries) {
          oldTotal += oldVal;
        }
        this._notWithPenalty -= oldTotal;

        // Recompute penalties for all affected participants
        const newPenaltyA = this.computeParticipantNotWithPenalty(pidA);
        const newPenaltyB = this.computeParticipantNotWithPenalty(pidB);
        this._perParticipantNotWithPenalty.set(pidA, newPenaltyA);
        this._perParticipantNotWithPenalty.set(pidB, newPenaltyB);
        let newTotal = newPenaltyA + newPenaltyB;
        for (const coPid of affectedCoParticipants) {
          const newCoPenalty = this.computeParticipantNotWithPenalty(coPid);
          this._perParticipantNotWithPenalty.set(coPid, newCoPenalty);
          newTotal += newCoPenalty;
        }
        this._notWithPenalty += newTotal;
      }
    }

    // Recompute task preference penalty for the two swapped participants
    this._savedTaskPrefTotal = this._taskPrefPenalty;
    this._savedTaskPrefEntries = [
      [pidA, this._perParticipantTaskPrefPenalty.get(pidA) || 0],
      [pidB, this._perParticipantTaskPrefPenalty.get(pidB) || 0],
    ];
    const pAObj = this.pMap.get(pidA);
    const pBObj = this.pMap.get(pidB);
    const aHasPrefs = !!(pAObj?.preferredTaskName || pAObj?.lessPreferredTaskName);
    const bHasPrefs = !!(pBObj?.preferredTaskName || pBObj?.lessPreferredTaskName);
    if (aHasPrefs || bHasPrefs || this._savedTaskPrefEntries[0][1] !== 0 || this._savedTaskPrefEntries[1][1] !== 0) {
      // Remove old contributions
      this._taskPrefPenalty -= this._savedTaskPrefEntries[0][1] + this._savedTaskPrefEntries[1][1];
      // Recompute for both
      const newTPrefA = this.computeParticipantTaskPrefPenalty(pidA);
      const newTPrefB = this.computeParticipantTaskPrefPenalty(pidB);
      this._perParticipantTaskPrefPenalty.set(pidA, newTPrefA);
      this._perParticipantTaskPrefPenalty.set(pidB, newTPrefB);
      this._taskPrefPenalty += newTPrefA + newTPrefB;
    }

    this.compositeScore = this.deriveComposite();
    return this.compositeScore;
  }

  /**
   * Restore a participant's cached data (call to undo a swap).
   */
  restoreParticipant(pid: string, saved: ParticipantScoreData): void {
    this.removeParticipantContribution(pid);
    this.perParticipant.set(pid, saved);
    this.addParticipantContribution(pid);
  }

  /**
   * After restoring both participants, call this to finalize the undo.
   */
  finalizeUndo(): void {
    // Restore low-priority penalty state saved at the start of recomputeForSwap
    this._lowPriorityPenalty = this._savedLowPriorityTotal;
    for (const [pid, val] of this._savedLowPriorityEntries) {
      if (val > 0) this._perParticipantLowPriorityPenalty.set(pid, val);
      else this._perParticipantLowPriorityPenalty.delete(pid);
    }
    // Restore "not with" penalty state
    this._notWithPenalty = this._savedNotWithTotal;
    for (const [pid, val] of this._savedNotWithEntries) {
      if (val > 0) this._perParticipantNotWithPenalty.set(pid, val);
      else this._perParticipantNotWithPenalty.delete(pid);
    }
    // Restore task preference penalty state
    this._taskPrefPenalty = this._savedTaskPrefTotal;
    for (const [pid, val] of this._savedTaskPrefEntries) {
      if (val !== 0) this._perParticipantTaskPrefPenalty.set(pid, val);
      else this._perParticipantTaskPrefPenalty.delete(pid);
    }
    this.recomputeRestStats();
    this.compositeScore = this.deriveComposite();
  }

  private removeParticipantContribution(pid: string): void {
    const data = this.perParticipant.get(pid);
    if (!data) return;
    if (data.isL0) {
      this.l0Sum -= data.effectiveHours;
      this.l0SumSq -= data.effectiveHours ** 2;
    } else {
      this.seniorSum -= data.effectiveHours;
      this.seniorSumSq -= data.effectiveHours ** 2;
    }
    this._dailyPerParticipantStdDevSum -= data.dailyStdDev;
    this._restPerGapBonusSum -= data.restPerGapBonus;
    for (const [dk, load] of data.dailyLoads) {
      this.globalDayTotals.set(dk, (this.globalDayTotals.get(dk) || 0) - load);
    }
  }

  private addParticipantContribution(pid: string): void {
    const data = this.perParticipant.get(pid);
    if (!data) return;
    if (data.isL0) {
      this.l0Sum += data.effectiveHours;
      this.l0SumSq += data.effectiveHours ** 2;
    } else {
      this.seniorSum += data.effectiveHours;
      this.seniorSumSq += data.effectiveHours ** 2;
    }
    this._dailyPerParticipantStdDevSum += data.dailyStdDev;
    this._restPerGapBonusSum += data.restPerGapBonus;
    for (const [dk, load] of data.dailyLoads) {
      this.globalDayTotals.set(dk, (this.globalDayTotals.get(dk) || 0) + load);
    }
  }
}
