/**
 * Rescue Primitives — per-slot chain enumeration shared by Future SOS.
 *
 * Produces depth-1/2/3 swap chains that can fill a vacated slot, each
 * ranked by full composite-score delta. Used by the Future SOS batch
 * planner in future-sos.ts.
 *
 * Factored as a standalone module so the batch planner gets clean,
 * parameterised chain enumeration (per-depth caps, extraUnavailability
 * propagation, sorted by solo delta) without coupling to rescue.ts's
 * pagination and UI-oriented scoring.
 */

import { computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import type {
  Assignment,
  Participant,
  RescueSwap,
  Schedule,
  SchedulerConfig,
  SlotRequirement,
  Task,
} from '../models/types';
import { describeSlot } from '../utils/date-utils';
import { isFutureTask, isModifiableAssignment } from './temporal';
import { isEligible } from './validator';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single candidate chain that fills ONE vacated slot. */
export interface CandidateChain {
  /** Depth 1, 2, or 3 (number of swap steps). */
  depth: 1 | 2 | 3;
  swaps: RescueSwap[];
  /**
   * Solo composite delta: candidate composite − baseline composite.
   * Positive = improvement. Used to pre-rank and for admissible pruning.
   */
  soloCompositeDelta: number;
  /** Assignment IDs touched by the chain (conflict tracking during composition). */
  touchedAssignmentIds: string[];
  /**
   * (participantId, taskId) pairs this chain creates or leaves in place.
   * Used to reject compositions that would place the same participant on
   * the same task twice (protects HC-7 across chains).
   */
  participantTaskPairs: Array<{ participantId: string; taskId: string }>;
}

export interface ChainEnumerationCaps {
  depth1: number;
  depth2: number;
  depth3: number;
}

export const DEFAULT_CAPS: ChainEnumerationCaps = { depth1: 6, depth2: 4, depth3: 2 };

export interface SlotEnumerationContext {
  schedule: Schedule;
  taskMap: Map<string, Task>;
  participantMap: Map<string, Participant>;
  assignmentsByParticipant: Map<string, Assignment[]>;
  assignmentsByTask: Map<string, Assignment[]>;
  anchor: Date;
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  config: SchedulerConfig;
  scoreCtx: ScoreContext;
  baselineComposite: number;
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>;
  /**
   * Participants to exclude entirely from depth-1/2/3 candidate roles
   * (e.g. the focal unavailable participant of a Future SOS batch).
   * They can still appear as the donor's displaced participant.
   */
  excludeParticipantIds: Set<string>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function taskAssignmentsFor(
  ctx: SlotEnumerationContext,
  taskId: string,
  excludeIds: Set<string>,
  extraAssignments?: Array<{ slotId: string; participantId: string }>,
): Assignment[] {
  const base = (ctx.assignmentsByTask.get(taskId) || []).filter((a) => !excludeIds.has(a.id));
  if (extraAssignments) {
    for (const ea of extraAssignments) {
      base.push({ id: '__virtual__', taskId, slotId: ea.slotId, participantId: ea.participantId } as Assignment);
    }
  }
  return base;
}

function scoreSwapSet(
  ctx: SlotEnumerationContext,
  swaps: Array<{ assignmentId: string; newParticipantId: string }>,
): number {
  const swapMap = new Map<string, string>();
  for (const s of swaps) swapMap.set(s.assignmentId, s.newParticipantId);
  const tempAssignments = ctx.schedule.assignments.map((a) => {
    const pid = swapMap.get(a.id);
    return pid ? { ...a, participantId: pid } : a;
  });
  const score = computeScheduleScore(
    ctx.schedule.tasks,
    ctx.schedule.participants,
    tempAssignments,
    ctx.config,
    ctx.scoreCtx,
  );
  return score.compositeScore - ctx.baselineComposite;
}

function participantAssignmentsExcluding(
  ctx: SlotEnumerationContext,
  participantId: string,
  excludedAssignmentIds: Set<string>,
): Assignment[] {
  const base = ctx.assignmentsByParticipant.get(participantId) || [];
  if (excludedAssignmentIds.size === 0) return base;
  return base.filter((a) => !excludedAssignmentIds.has(a.id));
}

// ─── Depth 1 ─────────────────────────────────────────────────────────────────

function depth1(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: SlotRequirement,
): CandidateChain[] {
  const plans: CandidateChain[] = [];
  const excludeAssignments = new Set([vacatedAssignment.id]);

  for (const p of ctx.schedule.participants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = participantAssignmentsExcluding(ctx, p.id, excludeAssignments);
    if (
      !isEligible(p, vacatedTask, vacatedSlot, pAssignments, ctx.taskMap, {
        checkSameGroup: true,
        taskAssignments: taskAssignmentsFor(ctx, vacatedTask.id, excludeAssignments),
        participantMap: ctx.participantMap,
        disabledHC: ctx.disabledHC,
        restRuleMap: ctx.restRuleMap,
        extraUnavailability: ctx.extraUnavailability,
      })
    )
      continue;

    const swapOp = { assignmentId: vacatedAssignment.id, newParticipantId: p.id };
    const soloCompositeDelta = scoreSwapSet(ctx, [swapOp]);

    plans.push({
      depth: 1,
      swaps: [
        {
          assignmentId: vacatedAssignment.id,
          fromParticipantId: vacatedAssignment.participantId,
          toParticipantId: p.id,
          taskId: vacatedTask.id,
          taskName: vacatedTask.name,
          slotLabel: describeSlot(vacatedSlot.label, vacatedTask.timeBlock),
        },
      ],
      soloCompositeDelta,
      touchedAssignmentIds: [vacatedAssignment.id],
      participantTaskPairs: [{ participantId: p.id, taskId: vacatedTask.id }],
    });
  }

  plans.sort((a, b) => b.soloCompositeDelta - a.soloCompositeDelta);
  return plans;
}

// ─── Depth 2 ─────────────────────────────────────────────────────────────────

function depth2(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: SlotRequirement,
): CandidateChain[] {
  const plans: CandidateChain[] = [];

  for (const p of ctx.schedule.participants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pFutureAssignments = pAssignments.filter(
      (a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
    );

    for (const donor of pFutureAssignments) {
      const donorTask = ctx.taskMap.get(donor.taskId);
      if (!donorTask) continue;
      const donorSlot = donorTask.slots.find((s) => s.slotId === donor.slotId);
      if (!donorSlot) continue;

      const vacatedExcl = new Set([vacatedAssignment.id, donor.id]);
      const pAssignmentsWithoutDonor = participantAssignmentsExcluding(ctx, p.id, vacatedExcl);
      if (
        !isEligible(p, vacatedTask, vacatedSlot, pAssignmentsWithoutDonor, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssignmentsFor(ctx, vacatedTask.id, vacatedExcl),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          extraUnavailability: ctx.extraUnavailability,
        })
      )
        continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === vacatedAssignment.participantId) continue;

        const qAssignments = participantAssignmentsExcluding(ctx, q.id, new Set([donor.id]));
        const donorExcl = new Set([donor.id, vacatedAssignment.id]);
        const donorExtra =
          donorTask.id === vacatedTask.id ? [{ slotId: vacatedSlot.slotId, participantId: p.id }] : undefined;

        if (
          !isEligible(q, donorTask, donorSlot, qAssignments, ctx.taskMap, {
            checkSameGroup: true,
            taskAssignments: taskAssignmentsFor(ctx, donorTask.id, donorExcl, donorExtra),
            participantMap: ctx.participantMap,
            disabledHC: ctx.disabledHC,
            restRuleMap: ctx.restRuleMap,
            extraUnavailability: ctx.extraUnavailability,
          })
        )
          continue;

        const swapSet = [
          { assignmentId: vacatedAssignment.id, newParticipantId: p.id },
          { assignmentId: donor.id, newParticipantId: q.id },
        ];
        const soloCompositeDelta = scoreSwapSet(ctx, swapSet);

        plans.push({
          depth: 2,
          swaps: [
            {
              assignmentId: vacatedAssignment.id,
              fromParticipantId: vacatedAssignment.participantId,
              toParticipantId: p.id,
              taskId: vacatedTask.id,
              taskName: vacatedTask.name,
              slotLabel: describeSlot(vacatedSlot.label, vacatedTask.timeBlock),
            },
            {
              assignmentId: donor.id,
              fromParticipantId: p.id,
              toParticipantId: q.id,
              taskId: donorTask.id,
              taskName: donorTask.name,
              slotLabel: describeSlot(donorSlot.label, donorTask.timeBlock),
            },
          ],
          soloCompositeDelta,
          touchedAssignmentIds: [vacatedAssignment.id, donor.id],
          participantTaskPairs: [
            { participantId: p.id, taskId: vacatedTask.id },
            { participantId: q.id, taskId: donorTask.id },
          ],
        });
      }
    }
  }

  plans.sort((a, b) => b.soloCompositeDelta - a.soloCompositeDelta);
  return plans;
}

// ─── Depth 3 ─────────────────────────────────────────────────────────────────

function depth3(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: SlotRequirement,
  maxDepth3: number,
): CandidateChain[] {
  const plans: CandidateChain[] = [];
  const MAX_P_DONORS = 5;
  const MAX_Q_DONORS = 3;

  outer: for (const p of ctx.schedule.participants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pDonors = pAssignments
      .filter((a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor))
      .slice(0, MAX_P_DONORS);

    for (const donorP of pDonors) {
      const donorPTask = ctx.taskMap.get(donorP.taskId);
      if (!donorPTask) continue;
      const donorPSlot = donorPTask.slots.find((s) => s.slotId === donorP.slotId);
      if (!donorPSlot) continue;

      const vacatedExcl = new Set([vacatedAssignment.id, donorP.id]);
      const pWithout = participantAssignmentsExcluding(ctx, p.id, vacatedExcl);
      if (
        !isEligible(p, vacatedTask, vacatedSlot, pWithout, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssignmentsFor(ctx, vacatedTask.id, vacatedExcl),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          extraUnavailability: ctx.extraUnavailability,
        })
      )
        continue;

      for (const q of ctx.schedule.participants) {
        if (q.id === p.id || q.id === vacatedAssignment.participantId) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const qDonors = qAssignments
          .filter(
            (a) =>
              a.id !== vacatedAssignment.id && a.id !== donorP.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
          )
          .slice(0, MAX_Q_DONORS);

        for (const donorQ of qDonors) {
          const donorQTask = ctx.taskMap.get(donorQ.taskId);
          if (!donorQTask) continue;
          const donorQSlot = donorQTask.slots.find((s) => s.slotId === donorQ.slotId);
          if (!donorQSlot) continue;

          const donorPExcl = new Set([donorP.id, donorQ.id, vacatedAssignment.id]);
          const qWithout = participantAssignmentsExcluding(ctx, q.id, donorPExcl);
          const donorPExtra: Array<{ slotId: string; participantId: string }> = [];
          if (donorPTask.id === vacatedTask.id) {
            donorPExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
          }

          if (
            !isEligible(q, donorPTask, donorPSlot, qWithout, ctx.taskMap, {
              checkSameGroup: true,
              taskAssignments: taskAssignmentsFor(
                ctx,
                donorPTask.id,
                donorPExcl,
                donorPExtra.length > 0 ? donorPExtra : undefined,
              ),
              participantMap: ctx.participantMap,
              disabledHC: ctx.disabledHC,
              restRuleMap: ctx.restRuleMap,
              extraUnavailability: ctx.extraUnavailability,
            })
          )
            continue;

          for (const r of ctx.schedule.participants) {
            if (r.id === p.id || r.id === q.id || r.id === vacatedAssignment.participantId) continue;

            const rAssignments = participantAssignmentsExcluding(ctx, r.id, new Set([donorQ.id]));
            const donorQExcl = new Set([donorQ.id, donorP.id, vacatedAssignment.id]);

            const donorQExtra: Array<{ slotId: string; participantId: string }> = [];
            if (donorQTask.id === vacatedTask.id) {
              donorQExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
            }
            if (donorQTask.id === donorPTask.id) {
              donorQExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
            }

            if (
              !isEligible(r, donorQTask, donorQSlot, rAssignments, ctx.taskMap, {
                checkSameGroup: true,
                taskAssignments: taskAssignmentsFor(
                  ctx,
                  donorQTask.id,
                  donorQExcl,
                  donorQExtra.length > 0 ? donorQExtra : undefined,
                ),
                participantMap: ctx.participantMap,
                disabledHC: ctx.disabledHC,
                restRuleMap: ctx.restRuleMap,
                extraUnavailability: ctx.extraUnavailability,
              })
            )
              continue;

            const swapSet = [
              { assignmentId: vacatedAssignment.id, newParticipantId: p.id },
              { assignmentId: donorP.id, newParticipantId: q.id },
              { assignmentId: donorQ.id, newParticipantId: r.id },
            ];
            const soloCompositeDelta = scoreSwapSet(ctx, swapSet);

            plans.push({
              depth: 3,
              swaps: [
                {
                  assignmentId: vacatedAssignment.id,
                  fromParticipantId: vacatedAssignment.participantId,
                  toParticipantId: p.id,
                  taskId: vacatedTask.id,
                  taskName: vacatedTask.name,
                  slotLabel: describeSlot(vacatedSlot.label, vacatedTask.timeBlock),
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
              soloCompositeDelta,
              touchedAssignmentIds: [vacatedAssignment.id, donorP.id, donorQ.id],
              participantTaskPairs: [
                { participantId: p.id, taskId: vacatedTask.id },
                { participantId: q.id, taskId: donorPTask.id },
                { participantId: r.id, taskId: donorQTask.id },
              ],
            });

            if (plans.length >= maxDepth3) break outer;
          }
        }
      }
    }
  }

  plans.sort((a, b) => b.soloCompositeDelta - a.soloCompositeDelta);
  return plans;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enumerate candidate chains (depth 1 → 2 → 3) that can fill ONE vacated slot.
 *
 * Returns a merged, sorted list (highest solo composite delta first),
 * capped per depth. Intended for batch composition by the Future SOS planner.
 *
 * A candidate is always hard-constraint-valid at its own depth; cross-chain
 * conflicts are the caller's responsibility (via `touchedAssignmentIds` /
 * `participantTaskPairs`).
 */
export function enumerateChainsForSlot(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  caps: ChainEnumerationCaps = DEFAULT_CAPS,
): CandidateChain[] {
  const vacatedTask = ctx.taskMap.get(vacatedAssignment.taskId);
  if (!vacatedTask) return [];
  const vacatedSlot = vacatedTask.slots.find((s) => s.slotId === vacatedAssignment.slotId);
  if (!vacatedSlot) return [];
  if (!isFutureTask(vacatedTask, ctx.anchor)) return [];
  if (!isModifiableAssignment(vacatedAssignment, ctx.taskMap, ctx.anchor)) return [];

  const d1 = depth1(ctx, vacatedAssignment, vacatedTask, vacatedSlot).slice(0, caps.depth1);
  const d2 = depth2(ctx, vacatedAssignment, vacatedTask, vacatedSlot).slice(0, caps.depth2);
  const d3MaxEnumeration = Math.max(200, caps.depth3 * 40);
  const d3 = depth3(ctx, vacatedAssignment, vacatedTask, vacatedSlot, d3MaxEnumeration).slice(0, caps.depth3);

  const merged = [...d1, ...d2, ...d3];
  merged.sort((a, b) => {
    // Primary: higher delta first.
    if (b.soloCompositeDelta !== a.soloCompositeDelta) return b.soloCompositeDelta - a.soloCompositeDelta;
    // Secondary: prefer shallower chains.
    return a.depth - b.depth;
  });
  return merged;
}
