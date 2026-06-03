/**
 * Rescue Engine — Minimum-Disruption Plan Generator for Live Mode.
 *
 * When a slot is vacated (participant removed or marked unavailable),
 * this engine generates up to 3 "Rescue Plans" at the minimum possible
 * swap depth, scored by full composite score delta.
 *
 * Algorithm:
 *  1. Enumerate all single-swap (depth 1) candidates.
 *  2. If ≥ 3 single-swap candidates exist, return the top 3 (paginated).
 *  3. If < 3, backfill with 2-swap chains, then 3-swap chains.
 *  4. Plans are ranked by impactScore (lower = less disruption).
 *     When SchedulerConfig and ScoreContext are provided, impactScore is
 *     the negated composite score delta from computeScheduleScore() — the
 *     same scoring the optimizer uses (split-pool fairness, rest bonus,
 *     daily balance, lowPriority/notWith/taskPref penalties).
 *     Falls back to legacy workload-delta formula when scoring context
 *     is unavailable.
 *
 * All candidates must pass hard-constraint validation.
 * No plan may touch frozen assignments.
 */

import { sameGroupUnitTaskIds, validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  type Participant,
  type RescuePlan,
  type RescueRequest,
  type RescueResult,
  type RescueSwap,
  type Schedule,
  type SchedulerConfig,
  type SplitOp,
  type Task,
} from '../models/types';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import type { ScheduleContext } from '../shared/utils/time-utils';
import { describeSlot, operationalDateKey } from '../utils/date-utils';
import { isSchedulerDiagOn } from './diagnostics';
import { makeSplitHalf } from './optimizer';
import {
  enumerateSplitFillsForSlot,
  type SlotEnumerationContext,
  sortDonorsByProximity,
  sortParticipantsByLoadProximity,
} from './rescue-primitives';
import { isFutureTask, isModifiableAssignment } from './temporal';
import { isEligible } from './validator';

// ─── Scoring Weights ─────────────────────────────────────────────────────────

const W_DAILY = 10; // Primary: daily workload impact
const W_WEEKLY = 3; // Secondary: weekly workload impact
const W_SWAPS = 1; // Tiebreaker: number of swaps

const PAGE_SIZE = 3;

// ─── Helper Types ────────────────────────────────────────────────────────────

interface CandidatePlan {
  swaps: RescueSwap[];
  /**
   * Optional split-fill operations. Plans are mono-kind — either
   * `swaps.length > 0` (chain) or `splitOps.length === 1` (single-slot
   * split-fill) — EXCEPT the terminal-split feasibility fallback, which carries
   * `swaps.length >= 1` AND `splitOps.length === 1` (chain + split of the
   * terminal displaced donor). The swap and split target disjoint assignment
   * ids, so they apply/validate independently.
   */
  splitOps?: SplitOp[];
  impactScore: number;
  compositeDelta?: number;
  /** Set by the terminal chain-internal split fallback (see RescuePlan). */
  terminalSplit?: boolean;
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Compute the daily workload std-dev for a specific day, given assignments.
 * This is the std-dev of effective hours per participant on that day.
 */
function computeDayLoadStdDev(
  dayKey: string,
  participants: Participant[],
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  dayStartHour: number,
  byParticipant?: Map<string, Assignment[]>,
): number {
  // Build or reuse per-participant index — O(A) instead of O(P×A)
  if (!byParticipant) {
    byParticipant = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = byParticipant.get(a.participantId);
      if (list) list.push(a);
      else byParticipant.set(a.participantId, [a]);
    }
  }
  const loads: number[] = [];
  for (const p of participants) {
    let hours = 0;
    const pAssignments = byParticipant.get(p.id);
    if (pAssignments) {
      for (const a of pAssignments) {
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        if (operationalDateKey(task.timeBlock.start, dayStartHour) !== dayKey) continue;
        hours += computeTaskEffectiveHours(task);
      }
    }
    loads.push(hours);
  }
  if (loads.length === 0) return 0;
  const avg = loads.reduce((s, v) => s + v, 0) / loads.length;
  const variance = loads.reduce((s, v) => s + (v - avg) ** 2, 0) / loads.length;
  return Math.sqrt(variance);
}

/**
 * Compute the total workload std-dev across all participants.
 * Uses effective hours (zero-load tasks contribute 0, load windows applied).
 * Note: this measures total load across ALL assignments, not per-week.
 */
function computeTotalLoadStdDev(
  participants: Participant[],
  assignments: Assignment[],
  taskMap: Map<string, Task>,
  byParticipant?: Map<string, Assignment[]>,
): number {
  // Build or reuse per-participant index — O(A) instead of O(P×A)
  if (!byParticipant) {
    byParticipant = new Map<string, Assignment[]>();
    for (const a of assignments) {
      const list = byParticipant.get(a.participantId);
      if (list) list.push(a);
      else byParticipant.set(a.participantId, [a]);
    }
  }
  const loads: number[] = [];
  for (const p of participants) {
    let hours = 0;
    const pAssignments = byParticipant.get(p.id);
    if (pAssignments) {
      for (const a of pAssignments) {
        const task = taskMap.get(a.taskId);
        if (!task) continue;
        hours += computeTaskEffectiveHours(task);
      }
    }
    loads.push(hours);
  }
  if (loads.length === 0) return 0;
  const avg = loads.reduce((s, v) => s + v, 0) / loads.length;
  const variance = loads.reduce((s, v) => s + (v - avg) ** 2, 0) / loads.length;
  return Math.sqrt(variance);
}

/**
 * Simulate a set of swaps and compute the impact on daily and weekly std-dev.
 * Measures daily delta for ALL days affected by the swap chain, not just one.
 */
function computeSwapImpact(
  baseAssignments: Assignment[],
  swaps: Array<{ assignmentId: string; newParticipantId: string }>,
  taskMap: Map<string, Task>,
  participants: Participant[],
  baseDayStdDevs: Map<string, number>,
  baseWeeklyStdDev: number,
  dayStartHour: number,
): { dailyLoadDelta: number; weeklyLoadDelta: number } {
  // Build swap lookup for O(1) instead of O(swaps) per assignment
  const swapMap = new Map<string, string>();
  for (const sw of swaps) swapMap.set(sw.assignmentId, sw.newParticipantId);

  // Apply swaps to a temporary assignment list & build per-participant index
  const tempByParticipant = new Map<string, Assignment[]>();
  const tempAssignments: Assignment[] = [];
  for (const a of baseAssignments) {
    const newPid = swapMap.get(a.id);
    const mapped = newPid ? { ...a, participantId: newPid } : a;
    tempAssignments.push(mapped);
    const list = tempByParticipant.get(mapped.participantId);
    if (list) list.push(mapped);
    else tempByParticipant.set(mapped.participantId, [mapped]);
  }

  // Build ID→Assignment lookup for O(1) access
  const assignmentById = new Map<string, Assignment>();
  for (const a of baseAssignments) assignmentById.set(a.id, a);

  // Collect all days affected by the swaps
  const affectedDays = new Set<string>();
  for (const [aId] of swapMap) {
    const assignment = assignmentById.get(aId);
    if (assignment) {
      const task = taskMap.get(assignment.taskId);
      if (task) affectedDays.add(operationalDateKey(task.timeBlock.start, dayStartHour));
    }
  }

  // Sum daily deltas across all affected days
  let totalDailyDelta = 0;
  for (const day of affectedDays) {
    let baseDayStdDev = baseDayStdDevs.get(day);
    if (baseDayStdDev === undefined) {
      baseDayStdDev = computeDayLoadStdDev(day, participants, baseAssignments, taskMap, dayStartHour);
      // Cache for subsequent candidate evaluations at this depth
      baseDayStdDevs.set(day, baseDayStdDev);
    }
    const newDayStdDev = computeDayLoadStdDev(
      day,
      participants,
      tempAssignments,
      taskMap,
      dayStartHour,
      tempByParticipant,
    );
    totalDailyDelta += newDayStdDev - baseDayStdDev;
  }

  const newWeeklyStdDev = computeTotalLoadStdDev(participants, tempAssignments, taskMap, tempByParticipant);

  return {
    dailyLoadDelta: totalDailyDelta,
    weeklyLoadDelta: newWeeklyStdDev - baseWeeklyStdDev,
  };
}

/**
 * Score a candidate plan (legacy formula — used when config/scoreCtx are not available).
 */
function scorePlan(swapCount: number, dailyDelta: number, weeklyDelta: number): number {
  return W_DAILY * dailyDelta + W_WEEKLY * weeklyDelta + W_SWAPS * swapCount;
}

/**
 * Score a candidate plan using the full composite score from soft-constraints.
 * Returns the negated composite delta so that lower impactScore = less disruption
 * (consistent with the legacy formula's semantics).
 *
 * When composite scoring is not available (config/scoreCtx missing), falls back
 * to the legacy workload-delta formula.
 */
function scoreCandidate(
  ctx: RescueContext,
  swaps: Array<{ assignmentId: string; newParticipantId: string }>,
  swapCount: number,
): { impactScore: number; compositeDelta: number | undefined } {
  if (ctx.baselineComposite !== null && ctx.config && ctx.scoreCtx) {
    // Build temporary assignments with swaps applied
    const swapMap = new Map<string, string>();
    for (const sw of swaps) swapMap.set(sw.assignmentId, sw.newParticipantId);
    const tempAssignments = ctx.schedule.assignments.map((a) => {
      const newPid = swapMap.get(a.id);
      return newPid ? { ...a, participantId: newPid } : a;
    });
    const candidateScore = computeScheduleScore(
      ctx.schedule.tasks,
      ctx.schedule.participants,
      tempAssignments,
      ctx.config,
      ctx.scoreCtx,
    );
    const delta = candidateScore.compositeScore - ctx.baselineComposite;
    // Negate: positive delta (improvement) → negative impactScore (better plan)
    return { impactScore: -delta, compositeDelta: delta };
  }
  // Legacy fallback
  const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
    ctx.schedule.assignments,
    swaps,
    ctx.taskMap,
    ctx.schedule.participants,
    ctx.baseDayStdDevs,
    ctx.baseWeeklyStdDev,
    ctx.dayStartHour,
  );
  return { impactScore: scorePlan(swapCount, dailyLoadDelta, weeklyLoadDelta), compositeDelta: undefined };
}

// ─── Shared context for depth-search functions ──────────────────────────────

interface RescueContext {
  schedule: Schedule;
  taskMap: Map<string, Task>;
  participantMap: Map<string, Participant>;
  vacatedAssignment: Assignment;
  vacatedTask: Task;
  vacatedSlot: import('../models/types').SlotRequirement;
  assignmentsByParticipant: Map<string, Assignment[]>;
  baseDayStdDevs: Map<string, number>;
  baseWeeklyStdDev: number;
  anchor: Date;
  taskAssignmentsFor: (
    taskId: string,
    excludeIds: Set<string>,
    extraAssignments?: Array<{ slotId: string; participantId: string }>,
  ) => Assignment[];
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  dayStartHour: number;
  /** Schedule window context for HC-3 operational-day rule evaluation. */
  scheduleContext?: ScheduleContext;
  /**
   * Schedule-scoped Future-SOS unavailability windows. Layered on top of
   * participant master availability during HC-3 evaluation, both at the
   * per-step `isEligible` gate AND at the final `validateHardConstraints`
   * call. Without it, generation enumerates candidates that final validation
   * later filters out — wasting depth-3/4 budget caps and triggering
   * spurious depth-4 fallbacks.
   */
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>;
  /**
   * Schedule-scoped capability overrides (mid-schedule cert loss). Same
   * symmetry argument as `extraUnavailability`: layered into both the
   * per-step `isEligible` gate and the final `validateHardConstraints` call
   * so candidates rejected by HC-2/HC-11 don't waste enumeration budget.
   */
  extraCapabilityLoss?: Array<{
    participantId: string;
    lostCertifications: string[];
    start: Date;
    end: Date;
  }>;
  // Full composite scoring (when available)
  config?: SchedulerConfig;
  scoreCtx?: ScoreContext;
  baselineComposite: number | null;
}

// ─── Trial-state construction for validation ────────────────────────────────

/**
 * Build the (tasks, assignments) pair a CandidatePlan would produce if
 * applied. Used by the post-enumeration validation loop to run
 * `validateHardConstraints` on the post-mutation state.
 *
 * Pure swap chains: clone `schedule.assignments` with each swap's
 * participantId substituted; tasks unchanged.
 *
 * Split-fill plans: replace the parent task with `[residual?, halfA, halfB]`
 * via `makeSplitHalf`, remove the original assignment, push two new
 * synthetic half-assignments — exactly mirroring `applyPlanOps` in
 * `scheduler.ts` so what passes validation here is what the apply path
 * actually commits.
 */
function buildTrialStateForCandidate(
  schedule: Schedule,
  cp: CandidatePlan,
): { tasks: Task[]; assignments: Assignment[] } {
  // Unified builder mirroring engine.applyPlanOps: apply every split-op first
  // (replace the parent task with residual + #a/#b halves; remove the original
  // assignment; push two synthetic half-assignments), THEN apply chain swaps as
  // participant substitution over the resulting assignment list. This supports
  // pure-swap plans, pure-split plans, AND terminal-split mixed plans with one
  // code path. For pure-swap (no splitOps) and pure-split (no swaps) plans the
  // pipeline reduces to the original two branches byte-for-byte.
  let tasks: Task[] = schedule.tasks;
  let assignments: Assignment[] = schedule.assignments;

  if (cp.splitOps && cp.splitOps.length > 0) {
    let curTasks = schedule.tasks;
    let curAsgs: Assignment[] = schedule.assignments;
    const now = new Date();
    for (const op of cp.splitOps) {
      const T = curTasks.find((t) => t.id === op.taskId);
      if (!T) continue;
      const slot = T.slots.find((s) => s.slotId === op.slotId);
      if (!slot) continue;
      const halfA = makeSplitHalf(T, 1, T.timeBlock.start.getTime(), op.midpointMs, slot);
      const halfB = makeSplitHalf(T, 2, op.midpointMs, T.timeBlock.end.getTime(), slot);
      const survivingSlots = T.slots.filter((s) => s.slotId !== op.slotId);
      const nextTasks: Task[] = [];
      for (const t of curTasks) {
        if (t.id === T.id) {
          if (survivingSlots.length > 0) {
            // Stamp sameGroupLinkId on residual for sameGroupRequired parents so
            // HC-8 link-union groups residual + halves as one unit.
            nextTasks.push({
              ...T,
              slots: survivingSlots,
              requiredCount: survivingSlots.length,
              sameGroupLinkId: T.sameGroupRequired ? (T.sameGroupLinkId ?? T.id) : T.sameGroupLinkId,
            });
          }
          nextTasks.push(halfA, halfB);
        } else {
          nextTasks.push(t);
        }
      }
      const nextAsgs: Assignment[] = [];
      for (const a of curAsgs) {
        if (a.id === op.originalAssignmentId) continue;
        nextAsgs.push(a);
      }
      nextAsgs.push({
        id: `${op.originalAssignmentId}#a`,
        taskId: halfA.id,
        slotId: halfA.slots[0].slotId,
        participantId: op.fillA.participantId,
        status: AssignmentStatus.Manual,
        updatedAt: now,
      });
      nextAsgs.push({
        id: `${op.originalAssignmentId}#b`,
        taskId: halfB.id,
        slotId: halfB.slots[0].slotId,
        participantId: op.fillB.participantId,
        status: AssignmentStatus.Manual,
        updatedAt: now,
      });
      curTasks = nextTasks;
      curAsgs = nextAsgs;
    }
    tasks = curTasks;
    assignments = curAsgs;
  }

  if (cp.swaps.length > 0) {
    assignments = assignments.map((a) => {
      const sw = cp.swaps.find((s) => s.assignmentId === a.id);
      return sw ? { ...a, participantId: sw.toParticipantId } : a;
    });
  }

  return { tasks, assignments };
}

// ─── Split-fill candidates ───────────────────────────────────────────────────

/**
 * Build a SlotEnumerationContext for a single vacated slot (rescue's K=1
 * batch size) and call `enumerateSplitFillsForSlot`, mapping each
 * `SplitCandidate` to a CandidatePlan with `splitOps`. The composite delta
 * from the enumerator becomes both the plan's `compositeDelta` and the
 * negated `impactScore` (same convention as chain plans when full scoring
 * is active).
 */
function enumerateSplitFillCandidatesForRescue(
  schedule: Schedule,
  taskMap: Map<string, Task>,
  participantMap: Map<string, Participant>,
  assignmentsByTask: Map<string, Assignment[]>,
  assignmentsByParticipant: Map<string, Assignment[]>,
  vacatedAssignment: Assignment,
  anchor: Date,
  disabledHC: Set<string> | undefined,
  restRuleMap: Map<string, number> | undefined,
  scheduleContext: ScheduleContext | undefined,
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>,
  extraCapabilityLoss:
    | Array<{
        participantId: string;
        lostCertifications: string[];
        start: Date;
        end: Date;
      }>
    | undefined,
  config: SchedulerConfig,
  scoreCtx: ScoreContext,
  baselineComposite: number,
): CandidatePlan[] {
  const ctx: SlotEnumerationContext = {
    schedule,
    taskMap,
    participantMap,
    assignmentsByParticipant,
    assignmentsByTask,
    anchor,
    disabledHC,
    restRuleMap,
    scheduleContext,
    config,
    scoreCtx,
    baselineComposite,
    extraUnavailability,
    extraCapabilityLoss,
    excludeParticipantIds: new Set<string>(),
  };
  const splitCandidates = enumerateSplitFillsForSlot(ctx, vacatedAssignment, 1);
  return splitCandidates.map((sc) => ({
    swaps: [],
    splitOps: [sc.splitOp],
    impactScore: -sc.soloCompositeDelta,
    compositeDelta: sc.soloCompositeDelta,
  }));
}

// ─── Terminal chain-internal split candidates (feasibility fallback) ─────────

/** Per-donor split candidate cap and overall terminal candidate cap. Frozen
 *  constants protecting the deadline-less rescue path — NOT tunables. */
const TERMINAL_SPLIT_TOPK_PER_DONOR = 4;
const MAX_TERMINAL_SPLIT_CANDIDATES = 24;

/**
 * Score a mixed (swaps + one splitOp) candidate from its realized trial state.
 * The chain scorer `scoreCandidate` only substitutes participants and cannot
 * realize the split's task-set change, so we build the trial (residual + #a/#b
 * halves, then the chain swap) and run the full composite over it — rebuilding
 * `scoreCtx.taskMap` so the new half-task ids are scored (mirrors the trial
 * scoring in `enumerateSplitFillsForSlot`).
 */
function scoreMixedCandidate(
  schedule: Schedule,
  cp: CandidatePlan,
  config: SchedulerConfig,
  scoreCtx: ScoreContext,
  baselineComposite: number,
): number {
  const trial = buildTrialStateForCandidate(schedule, cp);
  const trialScoreCtx: ScoreContext =
    trial.tasks === schedule.tasks
      ? scoreCtx
      : {
          ...scoreCtx,
          taskMap: new Map(trial.tasks.map((t) => [t.id, t])),
          assignmentsByParticipant: undefined,
          assignmentsByTask: undefined,
        };
  const score = computeScheduleScore(trial.tasks, schedule.participants, trial.assignments, config, trialScoreCtx);
  return score.compositeScore - baselineComposite;
}

/**
 * Terminal chain-internal split candidates: a depth-2 chain `[V←p]` whose
 * displaced donor task `T` (the task `p` vacates) is backfilled by a SPLIT
 * rather than a whole replacement. Each candidate carries `swaps:[V←p]` and
 * `splitOps:[split(T)]` — disjoint assignment ids, so they apply atomically.
 *
 * Scope (v1): non-`sameGroupRequired` donors only (sidesteps the chain-aware
 * group-lock + residual link-stamp hazards). Gated by the caller to the
 * zero-valid-plans feasibility fallback; bounded by frozen candidate caps
 * because the single-slot rescue path has no wall-clock deadline.
 */
function enumerateTerminalSplitCandidatesForRescue(
  schedule: Schedule,
  taskMap: Map<string, Task>,
  participantMap: Map<string, Participant>,
  assignmentsByTask: Map<string, Assignment[]>,
  assignmentsByParticipant: Map<string, Assignment[]>,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: import('../models/types').SlotRequirement,
  anchor: Date,
  dayStartHour: number,
  taskAssignmentsFor: (taskId: string, excludeIds: Set<string>) => Assignment[],
  disabledHC: Set<string> | undefined,
  restRuleMap: Map<string, number> | undefined,
  scheduleContext: ScheduleContext | undefined,
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>,
  extraCapabilityLoss:
    | Array<{ participantId: string; lostCertifications: string[]; start: Date; end: Date }>
    | undefined,
  config: SchedulerConfig,
  scoreCtx: ScoreContext,
  baselineComposite: number,
): CandidatePlan[] {
  const out: CandidatePlan[] = [];
  const vacatedExcl = new Set([vacatedAssignment.id]);
  const pool = sortParticipantsByLoadProximity(
    schedule.participants,
    vacatedTask,
    dayStartHour,
    taskMap,
    assignmentsByParticipant,
  );

  for (const p of pool) {
    if (out.length >= MAX_TERMINAL_SPLIT_CANDIDATES) break;
    if (p.id === vacatedAssignment.participantId) continue;
    const pAsgs = assignmentsByParticipant.get(p.id) || [];

    for (const donor of pAsgs) {
      if (out.length >= MAX_TERMINAL_SPLIT_CANDIDATES) break;
      const T = taskMap.get(donor.taskId);
      if (!T || T.id === vacatedTask.id) continue;
      if (!T.splittable || T.splitGroupId !== undefined) continue;
      if (T.sameGroupRequired === true) continue; // v1: non-same-group donors only
      if (!isFutureTask(T, anchor)) continue;
      if (!isModifiableAssignment(donor, taskMap, anchor)) continue;

      // p must be able to take V after leaving exactly this donor.
      const pWithoutDonor = pAsgs.filter((a) => a.id !== donor.id);
      if (
        !isEligible(p, vacatedTask, vacatedSlot, pWithoutDonor, taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssignmentsFor(vacatedTask.id, vacatedExcl),
          participantMap,
          disabledHC,
          restRuleMap,
          scheduleContext,
          extraUnavailability,
          extraCapabilityLoss,
        })
      )
        continue;

      // Split-fill the donor slot. enumerateSplitFillsForSlot auto-excludes the
      // donor's participant (p) from the half-fillers and HC-pre-checks each
      // half; we re-score the FULL mixed plan and the final validator confirms.
      const splitCtx: SlotEnumerationContext = {
        schedule,
        taskMap,
        participantMap,
        assignmentsByParticipant,
        assignmentsByTask,
        anchor,
        disabledHC,
        restRuleMap,
        scheduleContext,
        config,
        scoreCtx,
        baselineComposite,
        extraUnavailability,
        extraCapabilityLoss,
        excludeParticipantIds: new Set<string>(),
      };
      const splits = enumerateSplitFillsForSlot(splitCtx, donor, 1).slice(0, TERMINAL_SPLIT_TOPK_PER_DONOR);

      for (const sc of splits) {
        // Disjoint-id safety basis: the chain swap mutates V's assignment, the
        // split removes the donor's — they must not be the same id.
        if (sc.splitOp.originalAssignmentId === vacatedAssignment.id) continue;
        const swap: RescueSwap = {
          assignmentId: vacatedAssignment.id,
          fromParticipantId: vacatedAssignment.participantId,
          toParticipantId: p.id,
          taskId: vacatedTask.id,
          taskName: vacatedTask.name,
          slotLabel: describeSlot(vacatedSlot.label, vacatedTask.timeBlock),
        };
        const cp: CandidatePlan = {
          swaps: [swap],
          splitOps: [sc.splitOp],
          impactScore: 0,
          compositeDelta: 0,
          terminalSplit: true,
        };
        const delta = scoreMixedCandidate(schedule, cp, config, scoreCtx, baselineComposite);
        cp.impactScore = -delta;
        cp.compositeDelta = delta;
        out.push(cp);
      }
    }
  }

  // Best composite first (consistent with the depth generators' internal sort).
  out.sort((a, b) => (b.compositeDelta ?? 0) - (a.compositeDelta ?? 0));
  return out;
}

// ─── Depth 1: Direct replacements ───────────────────────────────────────────

function generateDepth1Plans(ctx: RescueContext): CandidatePlan[] {
  const plans: CandidatePlan[] = [];

  for (const p of ctx.schedule.participants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const vacatedExclude = new Set([ctx.vacatedAssignment.id]);
    if (
      !isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pAssignments, ctx.taskMap, {
        checkSameGroup: true,
        taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, vacatedExclude),
        participantMap: ctx.participantMap,
        disabledHC: ctx.disabledHC,
        restRuleMap: ctx.restRuleMap,
        scheduleContext: ctx.scheduleContext,
        extraUnavailability: ctx.extraUnavailability,
        extraCapabilityLoss: ctx.extraCapabilityLoss,
      })
    )
      continue;

    const swapOp = { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id };
    const { impactScore, compositeDelta } = scoreCandidate(ctx, [swapOp], 1);

    plans.push({
      swaps: [
        {
          assignmentId: ctx.vacatedAssignment.id,
          fromParticipantId: ctx.vacatedAssignment.participantId,
          toParticipantId: p.id,
          taskId: ctx.vacatedTask.id,
          taskName: ctx.vacatedTask.name,
          slotLabel: describeSlot(ctx.vacatedSlot.label, ctx.vacatedTask.timeBlock),
        },
      ],
      impactScore,
      compositeDelta,
    });
  }

  plans.sort((a, b) => a.impactScore - b.impactScore);
  return plans;
}

// ─── Depth 2: One-hop chains ────────────────────────────────────────────────

function generateDepth2Plans(ctx: RescueContext): CandidatePlan[] {
  const plans: CandidatePlan[] = [];

  for (const p of ctx.schedule.participants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pFutureAssignments = pAssignments.filter((a) => {
      const t = ctx.taskMap.get(a.taskId);
      return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
    });

    for (const donorAssignment of pFutureAssignments) {
      const donorTask = ctx.taskMap.get(donorAssignment.taskId);
      if (!donorTask) continue;
      const donorSlot = donorTask.slots.find((s) => s.slotId === donorAssignment.slotId);
      if (!donorSlot) continue;

      const pAssignmentsWithout = pAssignments.filter((a) => a.id !== donorAssignment.id);
      const d2VacatedExclude = new Set([ctx.vacatedAssignment.id]);
      if (
        !isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pAssignmentsWithout, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, d2VacatedExclude),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        // Include vacatedAssignment.id so that when the donor task IS the
        // vacated task, the obsolete (vacatedSlot, vacatedBy) entry is
        // removed before the virtual (vacatedSlot, p) is added — otherwise
        // HC-4 same-group could compare q against vacatedBy's group when
        // vacatedBy is being replaced by p.
        const d2DonorExclude = new Set([donorAssignment.id, ctx.vacatedAssignment.id]);

        const d2DonorExtra =
          donorTask.id === ctx.vacatedTask.id ? [{ slotId: ctx.vacatedSlot.slotId, participantId: p.id }] : undefined;

        if (
          !isEligible(q, donorTask, donorSlot, qAssignments, ctx.taskMap, {
            checkSameGroup: true,
            taskAssignments: ctx.taskAssignmentsFor(donorTask.id, d2DonorExclude, d2DonorExtra),
            participantMap: ctx.participantMap,
            disabledHC: ctx.disabledHC,
            restRuleMap: ctx.restRuleMap,
            scheduleContext: ctx.scheduleContext,
            extraUnavailability: ctx.extraUnavailability,
            extraCapabilityLoss: ctx.extraCapabilityLoss,
          })
        )
          continue;

        const swapSet = [
          { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id },
          { assignmentId: donorAssignment.id, newParticipantId: q.id },
        ];
        const { impactScore, compositeDelta } = scoreCandidate(ctx, swapSet, 2);

        plans.push({
          swaps: [
            {
              assignmentId: ctx.vacatedAssignment.id,
              fromParticipantId: ctx.vacatedAssignment.participantId,
              toParticipantId: p.id,
              taskId: ctx.vacatedTask.id,
              taskName: ctx.vacatedTask.name,
              slotLabel: describeSlot(ctx.vacatedSlot.label, ctx.vacatedTask.timeBlock),
            },
            {
              assignmentId: donorAssignment.id,
              fromParticipantId: p.id,
              toParticipantId: q.id,
              taskId: donorTask.id,
              taskName: donorTask.name,
              slotLabel: describeSlot(donorSlot.label, donorTask.timeBlock),
            },
          ],
          impactScore,
          compositeDelta,
        });
      }
    }
  }

  plans.sort((a, b) => a.impactScore - b.impactScore);
  return plans;
}

// ─── Depth 3: Two-hop chains ────────────────────────────────────────────────

function generateDepth3Plans(ctx: RescueContext): CandidatePlan[] {
  const plans: CandidatePlan[] = [];
  // Adaptive caps: at typical N≤40 these match the historical fixed values
  // (5/3/200). They only widen for larger teams, where the 200-plan early-exit
  // would otherwise cut quality-correlated candidates before they could be
  // enumerated.
  const N = ctx.schedule.participants.length;
  const MAX_P_DONORS = Math.max(5, Math.ceil(N / 8));
  const MAX_Q_DONORS = Math.max(3, Math.ceil(N / 12));
  const MAX_DEPTH3 = Math.max(200, N * 5);

  // Shared helpers with rescue-primitives — identical participant/donor sort
  // so batch rescue (Future SOS) and single-slot rescue produce consistent
  // plan quality under the same schedule.
  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    ctx.vacatedTask,
    ctx.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = ctx.vacatedTask.timeBlock.start.getTime();

  outer: for (const p of sortedParticipants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;
    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];

    const pDonors = sortDonorsByProximity(
      pAssignments.filter((a) => {
        const t = ctx.taskMap.get(a.taskId);
        return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
      }),
      vacatedStart,
      ctx.taskMap,
    ).slice(0, MAX_P_DONORS);

    for (const donorP of pDonors) {
      const donorPTask = ctx.taskMap.get(donorP.taskId);
      if (!donorPTask) continue;
      const donorPSlot = donorPTask.slots.find((s) => s.slotId === donorP.slotId);
      if (!donorPSlot) continue;

      const pWithout = pAssignments.filter((a) => a.id !== donorP.id);
      const d3VacatedExclude = new Set([ctx.vacatedAssignment.id]);
      if (
        !isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pWithout, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, d3VacatedExclude),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      // Iterate q in load-proximity order (matches depth-4) so the MAX_DEPTH3
      // early-exit truncates the *least* load-proximal triples instead of
      // whichever participants happened to come first in schedule order.
      for (const q of sortedParticipants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;
        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];

        const qDonors = sortDonorsByProximity(
          qAssignments.filter((a) => {
            const t = ctx.taskMap.get(a.taskId);
            return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
          }),
          vacatedStart,
          ctx.taskMap,
        ).slice(0, MAX_Q_DONORS);

        for (const donorQ of qDonors) {
          const donorQTask = ctx.taskMap.get(donorQ.taskId);
          if (!donorQTask) continue;
          const donorQSlot = donorQTask.slots.find((s) => s.slotId === donorQ.slotId);
          if (!donorQSlot) continue;

          const qWithout = qAssignments.filter((a) => a.id !== donorQ.id);
          // See depth-2 comment: include vacatedAssignment.id so the obsolete
          // (vacatedSlot, vacatedBy) is removed before the virtual is added.
          const d3DonorPExclude = new Set([donorP.id, ctx.vacatedAssignment.id]);

          const d3DonorPExtra: Array<{ slotId: string; participantId: string }> = [];
          if (donorPTask.id === ctx.vacatedTask.id) {
            d3DonorPExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
          }

          if (
            !isEligible(q, donorPTask, donorPSlot, qWithout, ctx.taskMap, {
              checkSameGroup: true,
              taskAssignments: ctx.taskAssignmentsFor(
                donorPTask.id,
                d3DonorPExclude,
                d3DonorPExtra.length > 0 ? d3DonorPExtra : undefined,
              ),
              participantMap: ctx.participantMap,
              disabledHC: ctx.disabledHC,
              restRuleMap: ctx.restRuleMap,
              scheduleContext: ctx.scheduleContext,
              extraUnavailability: ctx.extraUnavailability,
              extraCapabilityLoss: ctx.extraCapabilityLoss,
            })
          )
            continue;

          // r in load-proximity order, same rationale as q above.
          for (const r of sortedParticipants) {
            if (r.id === p.id || r.id === q.id || r.id === ctx.vacatedAssignment.participantId) continue;
            const rAssignments = ctx.assignmentsByParticipant.get(r.id) || [];
            const d3DonorQExclude = new Set([donorQ.id, donorP.id, ctx.vacatedAssignment.id]);

            const d3DonorQExtra: Array<{ slotId: string; participantId: string }> = [];
            if (donorQTask.id === ctx.vacatedTask.id) {
              d3DonorQExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
            }
            if (donorQTask.id === donorPTask.id) {
              d3DonorQExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
            }

            if (
              !isEligible(r, donorQTask, donorQSlot, rAssignments, ctx.taskMap, {
                checkSameGroup: true,
                taskAssignments: ctx.taskAssignmentsFor(
                  donorQTask.id,
                  d3DonorQExclude,
                  d3DonorQExtra.length > 0 ? d3DonorQExtra : undefined,
                ),
                participantMap: ctx.participantMap,
                disabledHC: ctx.disabledHC,
                restRuleMap: ctx.restRuleMap,
                scheduleContext: ctx.scheduleContext,
                extraUnavailability: ctx.extraUnavailability,
                extraCapabilityLoss: ctx.extraCapabilityLoss,
              })
            )
              continue;

            const swapSet = [
              { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id },
              { assignmentId: donorP.id, newParticipantId: q.id },
              { assignmentId: donorQ.id, newParticipantId: r.id },
            ];
            const { impactScore, compositeDelta } = scoreCandidate(ctx, swapSet, 3);

            plans.push({
              swaps: [
                {
                  assignmentId: ctx.vacatedAssignment.id,
                  fromParticipantId: ctx.vacatedAssignment.participantId,
                  toParticipantId: p.id,
                  taskId: ctx.vacatedTask.id,
                  taskName: ctx.vacatedTask.name,
                  slotLabel: describeSlot(ctx.vacatedSlot.label, ctx.vacatedTask.timeBlock),
                },
                {
                  assignmentId: donorP.id,
                  fromParticipantId: p.id,
                  toParticipantId: q.id,
                  taskId: donorPTask.id,
                  taskName: donorPTask.name,
                  slotLabel: describeSlot(donorPSlot.label, donorPTask.timeBlock),
                },
                {
                  assignmentId: donorQ.id,
                  fromParticipantId: q.id,
                  toParticipantId: r.id,
                  taskId: donorQTask.id,
                  taskName: donorQTask.name,
                  slotLabel: describeSlot(donorQSlot.label, donorQTask.timeBlock),
                },
              ],
              impactScore,
              compositeDelta,
            });

            if (plans.length >= MAX_DEPTH3) break outer;
          }
        }
      }
    }
  }

  if (plans.length >= MAX_DEPTH3 && isSchedulerDiagOn()) {
    console.log(
      `[rescue] depth-3 cap reached (${MAX_DEPTH3} candidates) for task=${ctx.vacatedTask.id} ` +
        `slot=${ctx.vacatedSlot.slotId} — N=${ctx.schedule.participants.length}, P×Q=${MAX_P_DONORS}×${MAX_Q_DONORS}`,
    );
  }

  plans.sort((a, b) => a.impactScore - b.impactScore);
  return plans;
}

// ─── Depth 4: Three-hop chains (fallback only) ──────────────────────────────

/**
 * Generate depth-4 swap chains as a last-resort fallback.
 *
 * ONLY invoked when depth 1..3 return zero hard-constraint-valid plans.
 * Never used for quality ranking or backfill; the goal is to unlock feasibility
 * when the natural replacement pool is exhausted (cert/group/rest gates lock
 * every shallower candidate). Plans returned here carry `fallbackDepth = 4` so
 * the UI can warn the user that the chain is unusually deep.
 */
function generateDepth4Plans(ctx: RescueContext): CandidatePlan[] {
  const plans: CandidatePlan[] = [];
  const MAX_P_DONORS = 3;
  const MAX_Q_DONORS = 2;
  const MAX_R_DONORS = 2;
  const MAX_DEPTH4 = 100;

  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    ctx.vacatedTask,
    ctx.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = ctx.vacatedTask.timeBlock.start.getTime();

  outer: for (const p of sortedParticipants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;
    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];

    const pDonors = sortDonorsByProximity(
      pAssignments.filter((a) => {
        const t = ctx.taskMap.get(a.taskId);
        return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
      }),
      vacatedStart,
      ctx.taskMap,
    ).slice(0, MAX_P_DONORS);

    for (const donorP of pDonors) {
      const donorPTask = ctx.taskMap.get(donorP.taskId);
      if (!donorPTask) continue;
      const donorPSlot = donorPTask.slots.find((s) => s.slotId === donorP.slotId);
      if (!donorPSlot) continue;

      const pWithout = pAssignments.filter((a) => a.id !== donorP.id);
      const d4VacatedExclude = new Set([ctx.vacatedAssignment.id]);
      if (
        !isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pWithout, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, d4VacatedExclude),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of sortedParticipants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;
        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];

        const qDonors = sortDonorsByProximity(
          qAssignments.filter((a) => {
            const t = ctx.taskMap.get(a.taskId);
            return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
          }),
          vacatedStart,
          ctx.taskMap,
        ).slice(0, MAX_Q_DONORS);

        for (const donorQ of qDonors) {
          const donorQTask = ctx.taskMap.get(donorQ.taskId);
          if (!donorQTask) continue;
          const donorQSlot = donorQTask.slots.find((s) => s.slotId === donorQ.slotId);
          if (!donorQSlot) continue;

          const qWithout = qAssignments.filter((a) => a.id !== donorQ.id);
          const d4DonorPExclude = new Set([donorP.id, ctx.vacatedAssignment.id]);

          const d4DonorPExtra: Array<{ slotId: string; participantId: string }> = [];
          if (donorPTask.id === ctx.vacatedTask.id) {
            d4DonorPExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
          }

          if (
            !isEligible(q, donorPTask, donorPSlot, qWithout, ctx.taskMap, {
              checkSameGroup: true,
              taskAssignments: ctx.taskAssignmentsFor(
                donorPTask.id,
                d4DonorPExclude,
                d4DonorPExtra.length > 0 ? d4DonorPExtra : undefined,
              ),
              participantMap: ctx.participantMap,
              disabledHC: ctx.disabledHC,
              restRuleMap: ctx.restRuleMap,
              scheduleContext: ctx.scheduleContext,
              extraUnavailability: ctx.extraUnavailability,
              extraCapabilityLoss: ctx.extraCapabilityLoss,
            })
          )
            continue;

          for (const r of sortedParticipants) {
            if (r.id === p.id || r.id === q.id || r.id === ctx.vacatedAssignment.participantId) continue;
            const rAssignments = ctx.assignmentsByParticipant.get(r.id) || [];

            const rDonors = sortDonorsByProximity(
              rAssignments.filter((a) => {
                const t = ctx.taskMap.get(a.taskId);
                return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
              }),
              vacatedStart,
              ctx.taskMap,
            ).slice(0, MAX_R_DONORS);

            for (const donorR of rDonors) {
              const donorRTask = ctx.taskMap.get(donorR.taskId);
              if (!donorRTask) continue;
              const donorRSlot = donorRTask.slots.find((s) => s.slotId === donorR.slotId);
              if (!donorRSlot) continue;

              const rWithout = rAssignments.filter((a) => a.id !== donorR.id);
              const d4DonorQExclude = new Set([donorQ.id, donorP.id, ctx.vacatedAssignment.id]);

              const d4DonorQExtra: Array<{ slotId: string; participantId: string }> = [];
              if (donorQTask.id === ctx.vacatedTask.id) {
                d4DonorQExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
              }
              if (donorQTask.id === donorPTask.id) {
                d4DonorQExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
              }

              if (
                !isEligible(r, donorQTask, donorQSlot, rWithout, ctx.taskMap, {
                  checkSameGroup: true,
                  taskAssignments: ctx.taskAssignmentsFor(
                    donorQTask.id,
                    d4DonorQExclude,
                    d4DonorQExtra.length > 0 ? d4DonorQExtra : undefined,
                  ),
                  participantMap: ctx.participantMap,
                  disabledHC: ctx.disabledHC,
                  restRuleMap: ctx.restRuleMap,
                  scheduleContext: ctx.scheduleContext,
                  extraUnavailability: ctx.extraUnavailability,
                  extraCapabilityLoss: ctx.extraCapabilityLoss,
                })
              )
                continue;

              for (const s of sortedParticipants) {
                if (s.id === p.id || s.id === q.id || s.id === r.id || s.id === ctx.vacatedAssignment.participantId)
                  continue;
                const sAssignments = ctx.assignmentsByParticipant.get(s.id) || [];
                const d4DonorRExclude = new Set([donorR.id, donorQ.id, donorP.id, ctx.vacatedAssignment.id]);

                const d4DonorRExtra: Array<{ slotId: string; participantId: string }> = [];
                if (donorRTask.id === ctx.vacatedTask.id) {
                  d4DonorRExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
                }
                if (donorRTask.id === donorPTask.id) {
                  d4DonorRExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
                }
                if (donorRTask.id === donorQTask.id) {
                  d4DonorRExtra.push({ slotId: donorQSlot.slotId, participantId: r.id });
                }

                if (
                  !isEligible(s, donorRTask, donorRSlot, sAssignments, ctx.taskMap, {
                    checkSameGroup: true,
                    taskAssignments: ctx.taskAssignmentsFor(
                      donorRTask.id,
                      d4DonorRExclude,
                      d4DonorRExtra.length > 0 ? d4DonorRExtra : undefined,
                    ),
                    participantMap: ctx.participantMap,
                    disabledHC: ctx.disabledHC,
                    restRuleMap: ctx.restRuleMap,
                    scheduleContext: ctx.scheduleContext,
                    extraUnavailability: ctx.extraUnavailability,
                    extraCapabilityLoss: ctx.extraCapabilityLoss,
                  })
                )
                  continue;

                const swapSet = [
                  { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id },
                  { assignmentId: donorP.id, newParticipantId: q.id },
                  { assignmentId: donorQ.id, newParticipantId: r.id },
                  { assignmentId: donorR.id, newParticipantId: s.id },
                ];
                const { impactScore, compositeDelta } = scoreCandidate(ctx, swapSet, 4);

                plans.push({
                  swaps: [
                    {
                      assignmentId: ctx.vacatedAssignment.id,
                      fromParticipantId: ctx.vacatedAssignment.participantId,
                      toParticipantId: p.id,
                      taskId: ctx.vacatedTask.id,
                      taskName: ctx.vacatedTask.name,
                      slotLabel: describeSlot(ctx.vacatedSlot.label, ctx.vacatedTask.timeBlock),
                    },
                    {
                      assignmentId: donorP.id,
                      fromParticipantId: p.id,
                      toParticipantId: q.id,
                      taskId: donorPTask.id,
                      taskName: donorPTask.name,
                      slotLabel: describeSlot(donorPSlot.label, donorPTask.timeBlock),
                    },
                    {
                      assignmentId: donorQ.id,
                      fromParticipantId: q.id,
                      toParticipantId: r.id,
                      taskId: donorQTask.id,
                      taskName: donorQTask.name,
                      slotLabel: describeSlot(donorQSlot.label, donorQTask.timeBlock),
                    },
                    {
                      assignmentId: donorR.id,
                      fromParticipantId: r.id,
                      toParticipantId: s.id,
                      taskId: donorRTask.id,
                      taskName: donorRTask.name,
                      slotLabel: describeSlot(donorRSlot.label, donorRTask.timeBlock),
                    },
                  ],
                  impactScore,
                  compositeDelta,
                });

                if (plans.length >= MAX_DEPTH4) break outer;
              }
            }
          }
        }
      }
    }
  }

  plans.sort((a, b) => a.impactScore - b.impactScore);
  return plans;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Generate rescue plans for a vacated assignment.
 *
 * @param schedule The current schedule
 * @param request The rescue request (which assignment was vacated)
 * @param anchor The temporal anchor (only future slots are eligible)
 * @param page Page number (0-based) for pagination
 * @param maxPlans Maximum number of plans to return (overrides page slicing).
 *   When set, returns the top `maxPlans` plans regardless of page.
 * @returns Up to `maxPlans` (or PAGE_SIZE) plans, ranked by impact score
 */
export function generateRescuePlans(
  schedule: Schedule,
  request: RescueRequest,
  anchor: Date,
  page: number = 0,
  maxPlans?: number,
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  certLabelResolver?: (certId: string) => string,
  config?: SchedulerConfig,
  scoreCtx?: ScoreContext,
  scheduleContext?: ScheduleContext,
): RescueResult {
  // Validate page parameter
  page = Math.max(0, Math.floor(page));

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const participantMap = new Map<string, Participant>(schedule.participants.map((p) => [p.id, p]));

  // Pre-index assignments by task for O(slots_per_task) lookups instead of O(A)
  const assignmentsByTaskIndex = new Map<string, Assignment[]>();
  for (const a of schedule.assignments) {
    const list = assignmentsByTaskIndex.get(a.taskId);
    if (list) list.push(a);
    else assignmentsByTaskIndex.set(a.taskId, [a]);
  }

  function taskAssignmentsFor(
    taskId: string,
    excludeIds: Set<string>,
    extraAssignments?: Array<{ slotId: string; participantId: string }>,
  ): Assignment[] {
    // Link-aware: for a SPLIT same-group occurrence the HC-4 precheck must see
    // assignees across the whole residual+halves unit so chain enumeration
    // doesn't waste budget on cross-group candidates the final validator will
    // reject. `[taskId]` fast path for every normal task (zero behaviour
    // change when nothing is a split same-group fragment).
    const qt = taskMap.get(taskId);
    const unitIds = qt ? sameGroupUnitTaskIds(qt, taskMap.values()) : [taskId];
    const base: Assignment[] = [];
    for (const tid of unitIds) {
      for (const a of assignmentsByTaskIndex.get(tid) || []) {
        if (!excludeIds.has(a.id)) base.push(a);
      }
    }
    if (extraAssignments) {
      for (const ea of extraAssignments) {
        base.push({ id: '__virtual__', taskId, slotId: ea.slotId, participantId: ea.participantId } as Assignment);
      }
    }
    return base;
  }

  // Find the vacated assignment
  const vacatedAssignment = schedule.assignments.find((a) => a.id === request.vacatedAssignmentId);
  if (!vacatedAssignment) {
    return { request, plans: [], hasMore: false, page };
  }

  const vacatedTask = taskMap.get(vacatedAssignment.taskId);
  if (!vacatedTask) {
    return { request, plans: [], hasMore: false, page };
  }

  const vacatedSlot = vacatedTask.slots.find((s) => s.slotId === vacatedAssignment.slotId);
  if (!vacatedSlot) {
    return { request, plans: [], hasMore: false, page };
  }

  if (!isFutureTask(vacatedTask, anchor)) {
    return { request, plans: [], hasMore: false, page };
  }

  if (!isModifiableAssignment(vacatedAssignment, taskMap, anchor)) {
    return { request, plans: [], hasMore: false, page };
  }

  // Compute baseline composite score (full soft-constraint scoring when config available)
  const baselineComposite =
    config && scoreCtx
      ? computeScheduleScore(schedule.tasks, schedule.participants, schedule.assignments, config, scoreCtx)
          .compositeScore
      : null;

  // Compute legacy baseline metrics (used as fallback when config/scoreCtx not provided)
  const affectedDayKey = operationalDateKey(vacatedTask.timeBlock.start, dayStartHour);
  const baseDayStdDevs = new Map<string, number>();
  baseDayStdDevs.set(
    affectedDayKey,
    computeDayLoadStdDev(affectedDayKey, schedule.participants, schedule.assignments, taskMap, dayStartHour),
  );
  const baseWeeklyStdDev = computeTotalLoadStdDev(schedule.participants, schedule.assignments, taskMap);

  // Build per-participant assignment index (excluding the vacated assignment)
  const assignmentsByParticipant = new Map<string, Assignment[]>();
  for (const a of schedule.assignments) {
    if (a.id === vacatedAssignment.id) continue;
    const list = assignmentsByParticipant.get(a.participantId) || [];
    list.push(a);
    assignmentsByParticipant.set(a.participantId, list);
  }

  // Schedule-scoped Future-SOS windows feed both per-step eligibility and
  // final validation. Snapshotting once here keeps the array reference stable
  // across the whole enumeration so V8 can hoist it; it also matches the
  // exact same value passed to `validateHardConstraints` below.
  const extraUnavailability = schedule.scheduleUnavailability ?? [];
  const extraCapabilityLoss = schedule.capabilityLoss?.length
    ? schedule.capabilityLoss.map((c) => ({
        participantId: c.participantId,
        lostCertifications: c.lostCertifications,
        start: c.start,
        end: c.end,
      }))
    : undefined;

  const ctx: RescueContext = {
    schedule,
    taskMap,
    participantMap,
    vacatedAssignment,
    vacatedTask,
    vacatedSlot,
    assignmentsByParticipant,
    baseDayStdDevs,
    baseWeeklyStdDev,
    anchor,
    taskAssignmentsFor,
    disabledHC,
    restRuleMap,
    dayStartHour,
    scheduleContext,
    extraUnavailability,
    extraCapabilityLoss,
    config,
    scoreCtx,
    baselineComposite,
  };

  // Generate plans at each depth, expanding only when needed.
  // Request extra candidates to compensate for filtering out invalid plans.
  //
  // Backfill is gated on count *and* quality: when the best shallow plan is a
  // regression (negative compositeDelta), we keep enumerating deeper depths
  // even if we already have enough candidates by count — a deeper chain may
  // surface a non-regressing plan that the user actually wants. When
  // compositeDelta is undefined (legacy scoring path) we fall back to 0,
  // preserving the historical count-only behaviour.
  const needed = maxPlans ?? (page + 1) * PAGE_SIZE;
  const depth1Plans = generateDepth1Plans(ctx);

  // Split-fill candidates: realize the vacated slot as two halves staffed by
  // two different people. Only enumerated when full composite scoring is
  // available, the parent task is `splittable`, and `splittingMode !== 'off'`.
  // Mixed into the depth-1 pool — the planner ranks them on the same scale.
  const splittingMode = schedule.algorithmSettings?.splittingMode ?? 'quality';
  const splitFillPlans: CandidatePlan[] =
    splittingMode !== 'off' && config && scoreCtx && baselineComposite !== null && vacatedTask.splittable
      ? enumerateSplitFillCandidatesForRescue(
          schedule,
          taskMap,
          participantMap,
          assignmentsByTaskIndex,
          assignmentsByParticipant,
          vacatedAssignment,
          anchor,
          disabledHC,
          restRuleMap,
          scheduleContext,
          extraUnavailability,
          extraCapabilityLoss,
          config,
          scoreCtx,
          baselineComposite,
        )
      : [];

  const topD1Delta = depth1Plans[0]?.compositeDelta ?? 0;
  const skipDepth2 = depth1Plans.length >= needed * 2 && topD1Delta >= 0;
  const depth2Plans = skipDepth2 ? [] : generateDepth2Plans(ctx);

  const totalSoFar = depth1Plans.length + depth2Plans.length;
  const bestShallowDelta = Math.max(topD1Delta, depth2Plans[0]?.compositeDelta ?? -Infinity);
  const skipDepth3 = totalSoFar >= needed * 2 && bestShallowDelta >= 0;
  const depth3Plans = skipDepth3 ? [] : generateDepth3Plans(ctx);

  // Assemble all plans in disruption-tiered priority order: depth-1 chains,
  // then single-slot split-fills, then depth-2, then depth-3. Each tier is
  // internally sorted by composite delta (best first) by its generator; the
  // tiers are NOT globally re-sorted — shallower/less-disruptive repairs are
  // deliberately surfaced ahead of deeper ones (the engine's minimum-disruption
  // contract), and a split-fill (2 people, 1 task) ranks between a 1-swap and a
  // 2-swap chain. Pagination then slices the top PAGE_SIZE.
  const allCandidates = [...depth1Plans, ...splitFillPlans, ...depth2Plans, ...depth3Plans];

  // Validate each plan and filter out those with hard-constraint violations.
  // Plans that fail validation will always fail during application, so showing
  // them to the user is misleading.
  type ValidatedPlan = CandidatePlan & {
    violations: import('../models/types').ConstraintViolation[];
    fallbackDepth?: number;
  };
  const validPlans: ValidatedPlan[] = [];
  for (const cp of allCandidates) {
    const trial = buildTrialStateForCandidate(schedule, cp);
    const validation = validateHardConstraints(
      trial.tasks,
      schedule.participants,
      trial.assignments,
      disabledHC,
      restRuleMap,
      certLabelResolver,
      extraUnavailability,
      scheduleContext,
      extraCapabilityLoss,
    );
    if (validation.valid) {
      validPlans.push({ ...cp, violations: [] });
    }
  }

  // Deep-chain fallback: when depth 1..3 produce zero valid plans, try depth 4.
  // This is a feasibility unlocker, not a quality improver — we only reach it
  // when every shallower chain was blocked by HC gates. Plans from this path
  // are flagged with fallbackDepth = 4 so the UI can warn the user.
  if (validPlans.length === 0) {
    console.warn(
      `[rescue] depth-4 fallback fired for assignment ${request.vacatedAssignmentId} ` +
        `(task=${vacatedTask.id}, slot=${vacatedSlot.slotId}) — depth 1..3 returned zero valid plans`,
    );
    const depth4Plans = generateDepth4Plans(ctx);
    for (const cp of depth4Plans) {
      const trial = buildTrialStateForCandidate(schedule, cp);
      const validation = validateHardConstraints(
        trial.tasks,
        schedule.participants,
        trial.assignments,
        disabledHC,
        restRuleMap,
        certLabelResolver,
        extraUnavailability,
        scheduleContext,
        extraCapabilityLoss,
      );
      if (validation.valid) {
        validPlans.push({ ...cp, violations: [], fallbackDepth: 4 });
      }
    }
  }

  // Terminal chain-internal split fallback: when even the depth-4 deep-chain
  // fallback yields zero valid plans, try a depth-2 chain whose terminal
  // displaced donor is backfilled by a SPLIT (two part-eligible people) instead
  // of one whole replacement. Strictly a feasibility unlocker, gated by the
  // same global split settings as seed-split. Plans are tagged fallbackDepth=4
  // (reuses the deep-chain warning styling) + terminalSplit=true (precise copy).
  if (validPlans.length === 0 && splittingMode !== 'off' && config && scoreCtx && baselineComposite !== null) {
    console.warn(
      `[rescue] terminal-split fallback fired for assignment ${request.vacatedAssignmentId} ` +
        `(task=${vacatedTask.id}, slot=${vacatedSlot.slotId}) — depth 1..4 returned zero valid plans`,
    );
    const terminalPlans = enumerateTerminalSplitCandidatesForRescue(
      schedule,
      taskMap,
      participantMap,
      assignmentsByTaskIndex,
      assignmentsByParticipant,
      vacatedAssignment,
      vacatedTask,
      vacatedSlot,
      anchor,
      dayStartHour,
      taskAssignmentsFor,
      disabledHC,
      restRuleMap,
      scheduleContext,
      extraUnavailability,
      extraCapabilityLoss,
      config,
      scoreCtx,
      baselineComposite,
    );
    for (const cp of terminalPlans) {
      const trial = buildTrialStateForCandidate(schedule, cp);
      const validation = validateHardConstraints(
        trial.tasks,
        schedule.participants,
        trial.assignments,
        disabledHC,
        restRuleMap,
        certLabelResolver,
        extraUnavailability,
        scheduleContext,
        extraCapabilityLoss,
      );
      if (validation.valid) {
        validPlans.push({ ...cp, violations: [], fallbackDepth: 4, terminalSplit: true });
      }
    }
  }

  // When maxPlans is specified, return the top N plans (no page slicing)
  const startIdx = maxPlans !== undefined ? 0 : page * PAGE_SIZE;
  const endIdx = maxPlans !== undefined ? maxPlans : startIdx + PAGE_SIZE;
  const pagePlans = validPlans.slice(startIdx, endIdx);

  const plans: RescuePlan[] = pagePlans.map((cp, i) => ({
    id: `rescue-${Date.now()}-${page}-${i}`,
    rank: i + 1,
    swaps: cp.swaps,
    splitOps: cp.splitOps,
    impactScore: cp.impactScore,
    compositeDelta: cp.compositeDelta,
    violations: cp.violations,
    fallbackDepth: cp.fallbackDepth,
    terminalSplit: cp.terminalSplit,
  }));

  return {
    request,
    plans,
    hasMore: validPlans.length > endIdx,
    page,
  };
}
