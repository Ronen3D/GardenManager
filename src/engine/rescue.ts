/**
 * Rescue Engine — Minimum-Disruption Plan Generator for Live Mode.
 *
 * When a slot is vacated (participant removed or marked unavailable),
 * this engine generates up to 3 "Rescue Plans" at the minimum possible
 * swap depth, scored primarily by daily workload impact.
 *
 * Algorithm:
 *  1. Enumerate all single-swap (depth 1) candidates.
 *  2. If ≥ 3 single-swap candidates exist, return the top 3 (paginated).
 *  3. If < 3, backfill with 2-swap chains, then 3-swap chains.
 *  4. Plans are ranked by impactScore (lower = less disruption).
 *     impactScore emphasises daily workload std-dev change (×10)
 *     over weekly change (×3), with swap count as tiebreaker (×1).
 *
 * All candidates must pass hard-constraint validation.
 * No plan may touch frozen assignments.
 */

import {
  Schedule,
  Assignment,
  Task,
  Participant,
  RescuePlan,
  RescueSwap,
  RescueRequest,
  RescueResult,
} from '../models/types';
import { isEligible } from './validator';
import { isFutureTask, isModifiableAssignment } from './temporal';
import { computeTaskEffectiveHours } from '../web/utils/load-weighting';
import { validateHardConstraints } from '../constraints/hard-constraints';
import { dateKey } from '../utils/date-utils';

// ─── Scoring Weights ─────────────────────────────────────────────────────────

const W_DAILY = 10;   // Primary: daily workload impact
const W_WEEKLY = 3;    // Secondary: weekly workload impact
const W_SWAPS = 1;     // Tiebreaker: number of swaps

const PAGE_SIZE = 3;

// ─── Helper Types ────────────────────────────────────────────────────────────

interface CandidatePlan {
  swaps: RescueSwap[];
  impactScore: number;
  dailyLoadDelta: number;
  weeklyLoadDelta: number;
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
): number {
  const loads: number[] = [];
  for (const p of participants) {
    let hours = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      if (dateKey(task.timeBlock.start) !== dayKey) continue;
      hours += computeTaskEffectiveHours(task);
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
): number {
  const loads: number[] = [];
  for (const p of participants) {
    let hours = 0;
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      hours += computeTaskEffectiveHours(task);
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
): { dailyLoadDelta: number; weeklyLoadDelta: number } {
  // Apply swaps to a temporary assignment list
  const tempAssignments = baseAssignments.map(a => {
    const swap = swaps.find(s => s.assignmentId === a.id);
    if (swap) {
      return { ...a, participantId: swap.newParticipantId };
    }
    return a;
  });

  // Collect all days affected by the swaps
  const affectedDays = new Set<string>();
  for (const sw of swaps) {
    const assignment = baseAssignments.find(a => a.id === sw.assignmentId);
    if (assignment) {
      const task = taskMap.get(assignment.taskId);
      if (task) affectedDays.add(dateKey(task.timeBlock.start));
    }
  }

  // Sum daily deltas across all affected days
  let totalDailyDelta = 0;
  for (const day of affectedDays) {
    let baseDayStdDev = baseDayStdDevs.get(day);
    if (baseDayStdDev === undefined) {
      baseDayStdDev = computeDayLoadStdDev(day, participants, baseAssignments, taskMap);
      // Cache for subsequent candidate evaluations at this depth
      baseDayStdDevs.set(day, baseDayStdDev);
    }
    const newDayStdDev = computeDayLoadStdDev(day, participants, tempAssignments, taskMap);
    totalDailyDelta += newDayStdDev - baseDayStdDev;
  }

  const newWeeklyStdDev = computeTotalLoadStdDev(participants, tempAssignments, taskMap);

  return {
    dailyLoadDelta: totalDailyDelta,
    weeklyLoadDelta: newWeeklyStdDev - baseWeeklyStdDev,
  };
}

/**
 * Score a candidate plan.
 */
function scorePlan(swapCount: number, dailyDelta: number, weeklyDelta: number): number {
  return W_DAILY * dailyDelta + W_WEEKLY * weeklyDelta + W_SWAPS * swapCount;
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
}

// ─── Depth 1: Direct replacements ───────────────────────────────────────────

function generateDepth1Plans(ctx: RescueContext): CandidatePlan[] {
  const plans: CandidatePlan[] = [];

  for (const p of ctx.schedule.participants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const vacatedExclude = new Set([ctx.vacatedAssignment.id]);
    if (!isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pAssignments, ctx.taskMap, {
      checkSameGroup: true,
      taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, vacatedExclude),
      participantMap: ctx.participantMap,
      disabledHC: ctx.disabledHC,
    })) continue;

    const swap = { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id };
    const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
      ctx.schedule.assignments, [swap], ctx.taskMap, ctx.schedule.participants,
      ctx.baseDayStdDevs, ctx.baseWeeklyStdDev,
    );
    const impactScore = scorePlan(1, dailyLoadDelta, weeklyLoadDelta);

    plans.push({
      swaps: [{
        assignmentId: ctx.vacatedAssignment.id,
        fromParticipantId: ctx.vacatedAssignment.participantId,
        toParticipantId: p.id,
        taskId: ctx.vacatedTask.id,
        taskName: ctx.vacatedTask.name,
        slotLabel: ctx.vacatedSlot.label || ctx.vacatedSlot.slotId,
      }],
      impactScore,
      dailyLoadDelta,
      weeklyLoadDelta,
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
    const pFutureAssignments = pAssignments.filter(a => {
      const t = ctx.taskMap.get(a.taskId);
      return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
    });

    for (const donorAssignment of pFutureAssignments) {
      const donorTask = ctx.taskMap.get(donorAssignment.taskId);
      if (!donorTask) continue;
      const donorSlot = donorTask.slots.find(s => s.slotId === donorAssignment.slotId);
      if (!donorSlot) continue;

      const pAssignmentsWithout = pAssignments.filter(a => a.id !== donorAssignment.id);
      const d2VacatedExclude = new Set([ctx.vacatedAssignment.id]);
      if (!isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pAssignmentsWithout, ctx.taskMap, {
        checkSameGroup: true,
        taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, d2VacatedExclude),
        participantMap: ctx.participantMap,
        disabledHC: ctx.disabledHC,
      })) continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const d2DonorExclude = new Set([donorAssignment.id]);

        const d2DonorExtra = donorTask.id === ctx.vacatedTask.id
          ? [{ slotId: ctx.vacatedSlot.slotId, participantId: p.id }]
          : undefined;

        if (!isEligible(q, donorTask, donorSlot, qAssignments, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: ctx.taskAssignmentsFor(donorTask.id, d2DonorExclude, d2DonorExtra),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
        })) continue;

        const swapSet = [
          { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id },
          { assignmentId: donorAssignment.id, newParticipantId: q.id },
        ];
        const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
          ctx.schedule.assignments, swapSet, ctx.taskMap, ctx.schedule.participants,
          ctx.baseDayStdDevs, ctx.baseWeeklyStdDev,
        );
        const impactScore = scorePlan(2, dailyLoadDelta, weeklyLoadDelta);

        plans.push({
          swaps: [
            {
              assignmentId: ctx.vacatedAssignment.id,
              fromParticipantId: ctx.vacatedAssignment.participantId,
              toParticipantId: p.id,
              taskId: ctx.vacatedTask.id,
              taskName: ctx.vacatedTask.name,
              slotLabel: ctx.vacatedSlot.label || ctx.vacatedSlot.slotId,
            },
            {
              assignmentId: donorAssignment.id,
              fromParticipantId: p.id,
              toParticipantId: q.id,
              taskId: donorTask.id,
              taskName: donorTask.name,
              slotLabel: donorSlot.label || donorSlot.slotId,
            },
          ],
          impactScore,
          dailyLoadDelta,
          weeklyLoadDelta,
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

  outer:
  for (const p of ctx.schedule.participants) {
    if (p.id === ctx.vacatedAssignment.participantId) continue;
    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];

    const pDonors = pAssignments
      .filter(a => {
        const t = ctx.taskMap.get(a.taskId);
        return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
      })
      .slice(0, MAX_P_DONORS);

    for (const donorP of pDonors) {
      const donorPTask = ctx.taskMap.get(donorP.taskId);
      if (!donorPTask) continue;
      const donorPSlot = donorPTask.slots.find(s => s.slotId === donorP.slotId);
      if (!donorPSlot) continue;

      const pWithout = pAssignments.filter(a => a.id !== donorP.id);
      const d3VacatedExclude = new Set([ctx.vacatedAssignment.id]);
      if (!isEligible(p, ctx.vacatedTask, ctx.vacatedSlot, pWithout, ctx.taskMap, {
        checkSameGroup: true,
        taskAssignments: ctx.taskAssignmentsFor(ctx.vacatedTask.id, d3VacatedExclude),
        participantMap: ctx.participantMap,
        disabledHC: ctx.disabledHC,
      })) continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === ctx.vacatedAssignment.participantId) continue;
        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];

        const qDonors = qAssignments
          .filter(a => {
            const t = ctx.taskMap.get(a.taskId);
            return t && isFutureTask(t, ctx.anchor) && isModifiableAssignment(a, ctx.taskMap, ctx.anchor);
          })
          .slice(0, MAX_Q_DONORS);

        for (const donorQ of qDonors) {
          const donorQTask = ctx.taskMap.get(donorQ.taskId);
          if (!donorQTask) continue;
          const donorQSlot = donorQTask.slots.find(s => s.slotId === donorQ.slotId);
          if (!donorQSlot) continue;

          const qWithout = qAssignments.filter(a => a.id !== donorQ.id);
          const d3DonorPExclude = new Set([donorP.id]);

          const d3DonorPExtra: Array<{ slotId: string; participantId: string }> = [];
          if (donorPTask.id === ctx.vacatedTask.id) {
            d3DonorPExtra.push({ slotId: ctx.vacatedSlot.slotId, participantId: p.id });
          }

          if (!isEligible(q, donorPTask, donorPSlot, qWithout, ctx.taskMap, {
            checkSameGroup: true,
            taskAssignments: ctx.taskAssignmentsFor(donorPTask.id, d3DonorPExclude, d3DonorPExtra.length > 0 ? d3DonorPExtra : undefined),
            participantMap: ctx.participantMap,
            disabledHC: ctx.disabledHC,
          })) continue;

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

            if (!isEligible(r, donorQTask, donorQSlot, rAssignments, ctx.taskMap, {
              checkSameGroup: true,
              taskAssignments: ctx.taskAssignmentsFor(donorQTask.id, d3DonorQExclude, d3DonorQExtra.length > 0 ? d3DonorQExtra : undefined),
              participantMap: ctx.participantMap,
              disabledHC: ctx.disabledHC,
            })) continue;

            const swapSet = [
              { assignmentId: ctx.vacatedAssignment.id, newParticipantId: p.id },
              { assignmentId: donorP.id, newParticipantId: q.id },
              { assignmentId: donorQ.id, newParticipantId: r.id },
            ];
            const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
              ctx.schedule.assignments, swapSet, ctx.taskMap, ctx.schedule.participants,
              ctx.baseDayStdDevs, ctx.baseWeeklyStdDev,
            );
            const impactScore = scorePlan(3, dailyLoadDelta, weeklyLoadDelta);

            plans.push({
              swaps: [
                {
                  assignmentId: ctx.vacatedAssignment.id,
                  fromParticipantId: ctx.vacatedAssignment.participantId,
                  toParticipantId: p.id,
                  taskId: ctx.vacatedTask.id,
                  taskName: ctx.vacatedTask.name,
                  slotLabel: ctx.vacatedSlot.label || ctx.vacatedSlot.slotId,
                },
                {
                  assignmentId: donorP.id,
                  fromParticipantId: p.id,
                  toParticipantId: q.id,
                  taskId: donorPTask.id,
                  taskName: donorPTask.name,
                  slotLabel: donorPSlot.label || donorPSlot.slotId,
                },
                {
                  assignmentId: donorQ.id,
                  fromParticipantId: q.id,
                  toParticipantId: r.id,
                  taskId: donorQTask.id,
                  taskName: donorQTask.name,
                  slotLabel: donorQSlot.label || donorQSlot.slotId,
                },
              ],
              impactScore,
              dailyLoadDelta,
              weeklyLoadDelta,
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
): RescueResult {
  // Validate page parameter
  page = Math.max(0, Math.floor(page));

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const participantMap = new Map<string, Participant>(schedule.participants.map(p => [p.id, p]));

  function taskAssignmentsFor(
    taskId: string,
    excludeIds: Set<string>,
    extraAssignments?: Array<{ slotId: string; participantId: string }>,
  ): Assignment[] {
    const base = schedule.assignments.filter(
      a => a.taskId === taskId && !excludeIds.has(a.id),
    );
    if (extraAssignments) {
      for (const ea of extraAssignments) {
        base.push({ id: '__virtual__', taskId, slotId: ea.slotId, participantId: ea.participantId } as Assignment);
      }
    }
    return base;
  }

  // Find the vacated assignment
  const vacatedAssignment = schedule.assignments.find(a => a.id === request.vacatedAssignmentId);
  if (!vacatedAssignment) {
    return { request, plans: [], hasMore: false, page };
  }

  const vacatedTask = taskMap.get(vacatedAssignment.taskId);
  if (!vacatedTask) {
    return { request, plans: [], hasMore: false, page };
  }

  const vacatedSlot = vacatedTask.slots.find(s => s.slotId === vacatedAssignment.slotId);
  if (!vacatedSlot) {
    return { request, plans: [], hasMore: false, page };
  }

  if (!isFutureTask(vacatedTask, anchor)) {
    return { request, plans: [], hasMore: false, page };
  }

  if (!isModifiableAssignment(vacatedAssignment, taskMap, anchor)) {
    return { request, plans: [], hasMore: false, page };
  }

  // Compute baseline metrics
  const affectedDayKey = dateKey(vacatedTask.timeBlock.start);
  const baseDayStdDevs = new Map<string, number>();
  baseDayStdDevs.set(affectedDayKey, computeDayLoadStdDev(affectedDayKey, schedule.participants, schedule.assignments, taskMap));
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
    schedule, taskMap, participantMap,
    vacatedAssignment, vacatedTask, vacatedSlot,
    assignmentsByParticipant,
    baseDayStdDevs, baseWeeklyStdDev,
    anchor, taskAssignmentsFor,
    disabledHC,
  };

  // Generate plans at each depth, expanding only when needed
  const needed = maxPlans ?? (page + 1) * PAGE_SIZE;
  const depth1Plans = generateDepth1Plans(ctx);

  const depth2Plans = depth1Plans.length < needed
    ? generateDepth2Plans(ctx)
    : [];

  const totalSoFar = depth1Plans.length + depth2Plans.length;
  const depth3Plans = totalSoFar < needed
    ? generateDepth3Plans(ctx)
    : [];

  // Assemble all plans in priority order: depth 1 → depth 2 → depth 3
  const allPlans = [...depth1Plans, ...depth2Plans, ...depth3Plans];

  // When maxPlans is specified, return the top N plans (no page slicing)
  const startIdx = maxPlans !== undefined ? 0 : page * PAGE_SIZE;
  const endIdx = maxPlans !== undefined ? maxPlans : startIdx + PAGE_SIZE;
  const pagePlans = allPlans.slice(startIdx, endIdx);

  // Convert to RescuePlan format with pre-computed violations
  const plans: RescuePlan[] = pagePlans.map((cp, i) => {
    const tempAssignments = schedule.assignments.map(a => {
      const sw = cp.swaps.find(s => s.assignmentId === a.id);
      if (sw) return { ...a, participantId: sw.toParticipantId };
      return a;
    });
    const validation = validateHardConstraints(schedule.tasks, schedule.participants, tempAssignments, disabledHC);

    return {
      id: `rescue-${Date.now()}-${page}-${i}`,
      rank: i + 1,
      swaps: cp.swaps,
      impactScore: cp.impactScore,
      dailyLoadDelta: cp.dailyLoadDelta,
      weeklyLoadDelta: cp.weeklyLoadDelta,
      violations: validation.violations,
    };
  });

  return {
    request,
    plans,
    hasMore: allPlans.length > endIdx,
    page,
  };
}
