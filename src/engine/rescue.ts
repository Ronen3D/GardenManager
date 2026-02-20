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

/** Calendar-date key from a Date (YYYY-MM-DD in local time) */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
 * Compute the weekly workload std-dev across all participants.
 * Uses effective hours (excluding light tasks, applying load windows).
 */
function computeWeeklyLoadStdDev(
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
 */
function computeSwapImpact(
  baseAssignments: Assignment[],
  swaps: Array<{ assignmentId: string; newParticipantId: string }>,
  taskMap: Map<string, Task>,
  participants: Participant[],
  affectedDayKey: string,
  baseDayStdDev: number,
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

  const newDayStdDev = computeDayLoadStdDev(affectedDayKey, participants, tempAssignments, taskMap);
  const newWeeklyStdDev = computeWeeklyLoadStdDev(participants, tempAssignments, taskMap);

  return {
    dailyLoadDelta: newDayStdDev - baseDayStdDev,
    weeklyLoadDelta: newWeeklyStdDev - baseWeeklyStdDev,
  };
}

/**
 * Score a candidate plan.
 */
function scorePlan(swapCount: number, dailyDelta: number, weeklyDelta: number): number {
  return W_DAILY * dailyDelta + W_WEEKLY * weeklyDelta + W_SWAPS * swapCount;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Generate rescue plans for a vacated assignment.
 *
 * @param schedule The current schedule
 * @param request The rescue request (which assignment was vacated)
 * @param anchor The temporal anchor (only future slots are eligible)
 * @param page Page number (0-based) for pagination
 * @returns Up to 3 plans for this page, ranked by impact score
 */
export function generateRescuePlans(
  schedule: Schedule,
  request: RescueRequest,
  anchor: Date,
  page: number = 0,
): RescueResult {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  // Build participant lookup for same-group checks (HC-4)
  const participantMap = new Map<string, Participant>(schedule.participants.map(p => [p.id, p]));

  // Helper: get current assignments for a given task, optionally excluding
  // specific assignment IDs (vacated / donated slots) and adding virtual
  // assignments from earlier swaps in the chain.
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

  // Must be a future task
  if (!isFutureTask(vacatedTask, anchor)) {
    return { request, plans: [], hasMore: false, page };
  }

  // Compute baseline metrics for the affected day
  const affectedDayKey = dateKey(vacatedTask.timeBlock.start);
  const baseDayStdDev = computeDayLoadStdDev(affectedDayKey, schedule.participants, schedule.assignments, taskMap);
  const baseWeeklyStdDev = computeWeeklyLoadStdDev(schedule.participants, schedule.assignments, taskMap);

  // Build per-participant assignment index (excluding the vacated assignment)
  const assignmentsByParticipant = new Map<string, Assignment[]>();
  for (const a of schedule.assignments) {
    if (a.id === vacatedAssignment.id) continue; // exclude vacated
    const list = assignmentsByParticipant.get(a.participantId) || [];
    list.push(a);
    assignmentsByParticipant.set(a.participantId, list);
  }

  // ── Depth 1: Direct replacements ──────────────────────────────────────

  const depth1Plans: CandidatePlan[] = [];

  for (const p of schedule.participants) {
    // Skip the person who was removed
    if (p.id === vacatedAssignment.participantId) continue;

    // Check eligibility
    const pAssignments = assignmentsByParticipant.get(p.id) || [];
    const vacatedExclude = new Set([vacatedAssignment.id]);
    if (!isEligible(p, vacatedTask, vacatedSlot, pAssignments, taskMap, {
      checkSameGroup: true,
      taskAssignments: taskAssignmentsFor(vacatedTask.id, vacatedExclude),
      participantMap,
    })) continue;

    // Compute impact
    const swap = { assignmentId: vacatedAssignment.id, newParticipantId: p.id };
    const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
      schedule.assignments, [swap], taskMap, schedule.participants,
      affectedDayKey, baseDayStdDev, baseWeeklyStdDev,
    );
    const impactScore = scorePlan(1, dailyLoadDelta, weeklyLoadDelta);

    const rescueSwap: RescueSwap = {
      assignmentId: vacatedAssignment.id,
      fromParticipantId: vacatedAssignment.participantId,
      toParticipantId: p.id,
      taskName: vacatedTask.name,
      slotLabel: vacatedSlot.label || vacatedSlot.slotId,
    };

    depth1Plans.push({
      swaps: [rescueSwap],
      impactScore,
      dailyLoadDelta,
      weeklyLoadDelta,
    });
  }

  // Sort depth-1 plans
  depth1Plans.sort((a, b) => a.impactScore - b.impactScore);

  // ── Depth 2: One-hop chains ───────────────────────────────────────────

  const depth2Plans: CandidatePlan[] = [];

  // Only generate depth 2 if we need more plans
  if (depth1Plans.length < (page + 1) * PAGE_SIZE) {
    for (const p of schedule.participants) {
      if (p.id === vacatedAssignment.participantId) continue;

      // p must be eligible for the vacated slot
      const pAssignments = assignmentsByParticipant.get(p.id) || [];

      // Check if p can fill the vacated slot WITHOUT their current assignments
      // (they'll give up one of their future assignments)
      const pFutureAssignments = pAssignments.filter(a => {
        const t = taskMap.get(a.taskId);
        return t && isFutureTask(t, anchor) && isModifiableAssignment(a, taskMap, anchor);
      });

      for (const donorAssignment of pFutureAssignments) {
        const donorTask = taskMap.get(donorAssignment.taskId);
        if (!donorTask) continue;
        const donorSlot = donorTask.slots.find(s => s.slotId === donorAssignment.slotId);
        if (!donorSlot) continue;

        // Check if p can fill vacated slot when their donor assignment is removed
        const pAssignmentsWithout = pAssignments.filter(a => a.id !== donorAssignment.id);
        const d2VacatedExclude = new Set([vacatedAssignment.id]);
        if (!isEligible(p, vacatedTask, vacatedSlot, pAssignmentsWithout, taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssignmentsFor(vacatedTask.id, d2VacatedExclude),
          participantMap,
        })) continue;

        // Find someone to fill p's donor slot
        for (const q of schedule.participants) {
          if (q.id === p.id || q.id === vacatedAssignment.participantId) continue;

          const qAssignments = assignmentsByParticipant.get(q.id) || [];
          const d2DonorExclude = new Set([donorAssignment.id]);
          if (!isEligible(q, donorTask, donorSlot, qAssignments, taskMap, {
            checkSameGroup: true,
            taskAssignments: taskAssignmentsFor(donorTask.id, d2DonorExclude),
            participantMap,
          })) continue;

          // Compute 2-swap impact
          const swapSet = [
            { assignmentId: vacatedAssignment.id, newParticipantId: p.id },
            { assignmentId: donorAssignment.id, newParticipantId: q.id },
          ];
          const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
            schedule.assignments, swapSet, taskMap, schedule.participants,
            affectedDayKey, baseDayStdDev, baseWeeklyStdDev,
          );
          const impactScore = scorePlan(2, dailyLoadDelta, weeklyLoadDelta);

          const rescueSwaps: RescueSwap[] = [
            {
              assignmentId: vacatedAssignment.id,
              fromParticipantId: vacatedAssignment.participantId,
              toParticipantId: p.id,
              taskName: vacatedTask.name,
              slotLabel: vacatedSlot.label || vacatedSlot.slotId,
            },
            {
              assignmentId: donorAssignment.id,
              fromParticipantId: p.id,
              toParticipantId: q.id,
              taskName: donorTask.name,
              slotLabel: donorSlot.label || donorSlot.slotId,
            },
          ];

          depth2Plans.push({
            swaps: rescueSwaps,
            impactScore,
            dailyLoadDelta,
            weeklyLoadDelta,
          });
        }
      }
    }
    depth2Plans.sort((a, b) => a.impactScore - b.impactScore);
  }

  // ── Depth 3: Three-swap chains ─────────────────────────────────────────
  //
  // A depth-3 chain extends depth-1 by two hops:
  //   Swap 1: P → vacated slot (P can fill it after giving up donorP)
  //   Swap 2: Q → donorP slot (Q can fill it after giving up donorQ)
  //   Swap 3: R → donorQ slot (R directly eligible)
  //
  // This handles cases where P isn't directly eligible (depth-1) because
  // of a time conflict, but would be if P gave up donorP — and donorP
  // similarly can only be filled by Q who also needs to give something up.

  const depth3Plans: CandidatePlan[] = [];

  const totalSoFar = depth1Plans.length + depth2Plans.length;
  if (totalSoFar < (page + 1) * PAGE_SIZE) {
    // Limit search space: for each P, try their top-N donor assignments,
    // and for each Q, try their top-M donor assignments.
    const MAX_P_DONORS = 5;
    const MAX_Q_DONORS = 3;
    const MAX_DEPTH3 = 200; // bail out once we have enough candidates

    outer:
    for (const p of schedule.participants) {
      if (p.id === vacatedAssignment.participantId) continue;
      const pAssignments = assignmentsByParticipant.get(p.id) || [];

      // P's future modifiable assignments that P could give up
      const pDonors = pAssignments
        .filter(a => {
          const t = taskMap.get(a.taskId);
          return t && isFutureTask(t, anchor) && isModifiableAssignment(a, taskMap, anchor);
        })
        .slice(0, MAX_P_DONORS);

      for (const donorP of pDonors) {
        const donorPTask = taskMap.get(donorP.taskId);
        if (!donorPTask) continue;
        const donorPSlot = donorPTask.slots.find(s => s.slotId === donorP.slotId);
        if (!donorPSlot) continue;

        // Check if P can fill vacated slot when donorP is removed
        const pWithout = pAssignments.filter(a => a.id !== donorP.id);
        const d3VacatedExclude = new Set([vacatedAssignment.id]);
        if (!isEligible(p, vacatedTask, vacatedSlot, pWithout, taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssignmentsFor(vacatedTask.id, d3VacatedExclude),
          participantMap,
        })) continue;

        // Now find Q to fill donorP, where Q also gives up a donor
        for (const q of schedule.participants) {
          if (q.id === p.id || q.id === vacatedAssignment.participantId) continue;
          const qAssignments = assignmentsByParticipant.get(q.id) || [];

          // Q's future modifiable assignments
          const qDonors = qAssignments
            .filter(a => {
              const t = taskMap.get(a.taskId);
              return t && isFutureTask(t, anchor) && isModifiableAssignment(a, taskMap, anchor);
            })
            .slice(0, MAX_Q_DONORS);

          for (const donorQ of qDonors) {
            const donorQTask = taskMap.get(donorQ.taskId);
            if (!donorQTask) continue;
            const donorQSlot = donorQTask.slots.find(s => s.slotId === donorQ.slotId);
            if (!donorQSlot) continue;

            // Check if Q can fill donorP slot when donorQ is removed
            const qWithout = qAssignments.filter(a => a.id !== donorQ.id);
            const d3DonorPExclude = new Set([donorP.id]);
            if (!isEligible(q, donorPTask, donorPSlot, qWithout, taskMap, {
              checkSameGroup: true,
              taskAssignments: taskAssignmentsFor(donorPTask.id, d3DonorPExclude),
              participantMap,
            })) continue;

            // Find R to directly fill donorQ
            for (const r of schedule.participants) {
              if (r.id === p.id || r.id === q.id || r.id === vacatedAssignment.participantId) continue;
              const rAssignments = assignmentsByParticipant.get(r.id) || [];
              const d3DonorQExclude = new Set([donorQ.id]);
              if (!isEligible(r, donorQTask, donorQSlot, rAssignments, taskMap, {
                checkSameGroup: true,
                taskAssignments: taskAssignmentsFor(donorQTask.id, d3DonorQExclude),
                participantMap,
              })) continue;

              // Compute 3-swap impact
              const swapSet = [
                { assignmentId: vacatedAssignment.id, newParticipantId: p.id },
                { assignmentId: donorP.id, newParticipantId: q.id },
                { assignmentId: donorQ.id, newParticipantId: r.id },
              ];
              const { dailyLoadDelta, weeklyLoadDelta } = computeSwapImpact(
                schedule.assignments, swapSet, taskMap, schedule.participants,
                affectedDayKey, baseDayStdDev, baseWeeklyStdDev,
              );
              const impactScore = scorePlan(3, dailyLoadDelta, weeklyLoadDelta);

              depth3Plans.push({
                swaps: [
                  {
                    assignmentId: vacatedAssignment.id,
                    fromParticipantId: vacatedAssignment.participantId,
                    toParticipantId: p.id,
                    taskName: vacatedTask.name,
                    slotLabel: vacatedSlot.label || vacatedSlot.slotId,
                  },
                  {
                    assignmentId: donorP.id,
                    fromParticipantId: p.id,
                    toParticipantId: q.id,
                    taskName: donorPTask.name,
                    slotLabel: donorPSlot.label || donorPSlot.slotId,
                  },
                  {
                    assignmentId: donorQ.id,
                    fromParticipantId: q.id,
                    toParticipantId: r.id,
                    taskName: donorQTask.name,
                    slotLabel: donorQSlot.label || donorQSlot.slotId,
                  },
                ],
                impactScore,
                dailyLoadDelta,
                weeklyLoadDelta,
              });

              if (depth3Plans.length >= MAX_DEPTH3) break outer;
            }
          }
        }
      }
    }
    depth3Plans.sort((a, b) => a.impactScore - b.impactScore);
  }

  // ── Assemble all plans in priority order: depth 1 → depth 2 → depth 3 ──

  const allPlans = [...depth1Plans, ...depth2Plans, ...depth3Plans];

  // Paginate
  const startIdx = page * PAGE_SIZE;
  const endIdx = startIdx + PAGE_SIZE;
  const pagePlans = allPlans.slice(startIdx, endIdx);

  // Convert to RescuePlan format
  const plans: RescuePlan[] = pagePlans.map((cp, i) => ({
    id: `rescue-${Date.now()}-${page}-${i}`,
    rank: i + 1,
    swaps: cp.swaps,
    impactScore: cp.impactScore,
    dailyLoadDelta: cp.dailyLoadDelta,
    weeklyLoadDelta: cp.weeklyLoadDelta,
    violations: [], // Will be populated during apply validation
  }));

  return {
    request,
    plans,
    hasMore: allPlans.length > endIdx,
    page,
  };
}
