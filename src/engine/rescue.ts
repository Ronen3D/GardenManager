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

import { validateHardConstraints } from '../constraints/hard-constraints';
import { type ScoreContext, computeScheduleScore } from '../constraints/soft-constraints';
import type {
  Assignment,
  Participant,
  RescuePlan,
  RescueRequest,
  RescueResult,
  RescueSwap,
  Schedule,
  SchedulerConfig,
  Task,
} from '../models/types';
import { describeSlot, operationalDateKey } from '../utils/date-utils';
import { computeTaskEffectiveHours } from '../web/utils/load-weighting';
import { sortDonorsByProximity, sortParticipantsByLoadProximity } from './rescue-primitives';
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
  impactScore: number;
  compositeDelta?: number;
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
 * Uses effective hours (excluding light tasks, applying load windows).
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
  // Full composite scoring (when available)
  config?: SchedulerConfig;
  scoreCtx?: ScoreContext;
  baselineComposite: number | null;
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
        })
      )
        continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const d2DonorExclude = new Set([donorAssignment.id]);

        const d2DonorExtra =
          donorTask.id === ctx.vacatedTask.id ? [{ slotId: ctx.vacatedSlot.slotId, participantId: p.id }] : undefined;

        if (
          !isEligible(q, donorTask, donorSlot, qAssignments, ctx.taskMap, {
            checkSameGroup: true,
            taskAssignments: ctx.taskAssignmentsFor(donorTask.id, d2DonorExclude, d2DonorExtra),
            participantMap: ctx.participantMap,
            disabledHC: ctx.disabledHC,
            restRuleMap: ctx.restRuleMap,
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
  const MAX_P_DONORS = 5;
  const MAX_Q_DONORS = 3;
  const MAX_DEPTH3 = 200;

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
        })
      )
        continue;

      for (const q of ctx.schedule.participants) {
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
          const d3DonorPExclude = new Set([donorP.id]);

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
            })
          )
            continue;

          for (const r of ctx.schedule.participants) {
            if (r.id === p.id || r.id === q.id || r.id === ctx.vacatedAssignment.participantId) continue;
            const rAssignments = ctx.assignmentsByParticipant.get(r.id) || [];
            const d3DonorQExclude = new Set([donorQ.id]);

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
    const base = (assignmentsByTaskIndex.get(taskId) || []).filter((a) => !excludeIds.has(a.id));
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
    config,
    scoreCtx,
    baselineComposite,
  };

  // Generate plans at each depth, expanding only when needed.
  // Request extra candidates to compensate for filtering out invalid plans.
  const needed = maxPlans ?? (page + 1) * PAGE_SIZE;
  const depth1Plans = generateDepth1Plans(ctx);

  const depth2Plans = depth1Plans.length < needed * 2 ? generateDepth2Plans(ctx) : [];

  const totalSoFar = depth1Plans.length + depth2Plans.length;
  const depth3Plans = totalSoFar < needed * 2 ? generateDepth3Plans(ctx) : [];

  // Assemble all plans in priority order: depth 1 → depth 2 → depth 3
  const allCandidates = [...depth1Plans, ...depth2Plans, ...depth3Plans];

  // Validate each plan and filter out those with hard-constraint violations.
  // Plans that fail validation will always fail during application, so showing
  // them to the user is misleading.
  const validPlans: Array<CandidatePlan & { violations: import('../models/types').ConstraintViolation[] }> = [];
  for (const cp of allCandidates) {
    const tempAssignments = schedule.assignments.map((a) => {
      const sw = cp.swaps.find((s) => s.assignmentId === a.id);
      if (sw) return { ...a, participantId: sw.toParticipantId };
      return a;
    });
    const validation = validateHardConstraints(
      schedule.tasks,
      schedule.participants,
      tempAssignments,
      disabledHC,
      restRuleMap,
      certLabelResolver,
    );
    if (validation.valid) {
      validPlans.push({ ...cp, violations: [] });
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
    impactScore: cp.impactScore,
    compositeDelta: cp.compositeDelta,
    violations: cp.violations,
  }));

  return {
    request,
    plans,
    hasMore: validPlans.length > endIdx,
    page,
  };
}
