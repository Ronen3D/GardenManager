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
import { describeSlot, operationalDateKey } from '../utils/date-utils';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import { isFutureTask, isModifiableAssignment } from './temporal';
import { isEligible } from './validator';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single candidate chain that fills ONE vacated slot. */
export interface CandidateChain {
  /** Depth 1, 2, 3, 4, or 5 (number of swap steps). Depths 4 and 5 are
   *  produced only by the deep-chain fallback and never appear in normal
   *  depth-1..3 enumeration. */
  depth: 1 | 2 | 3 | 4 | 5;
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
  /** Cap for depth-4 fallback chains per slot. Only consulted when
   *  `enumerateChainsForSlot` is called with fallbackLevel 'depth4' or 'depth5'. */
  depth4?: number;
  /** Cap for depth-5 fallback chains per slot. Only consulted when
   *  `enumerateChainsForSlot` is called with fallbackLevel 'depth5'. */
  depth5?: number;
}

export const DEFAULT_CAPS: ChainEnumerationCaps = { depth1: 6, depth2: 4, depth3: 2, depth4: 1, depth5: 1 };

/** Fallback level passed to `enumerateChainsForSlot`. Controls whether
 *  depth-4 / depth-5 chains are produced in addition to the default
 *  depth-1/2/3 enumeration. */
export type FallbackLevel = 'none' | 'depth4' | 'depth5';

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
  /**
   * Mutable scratch state used by scoreSwapSet. Lazily initialized on first
   * score call; reused across every depth-1/2/3 candidate and every slot in
   * the batch to avoid O(assignments) allocation per candidate. Callers
   * should leave both undefined at construction — the planner owns lifetime.
   */
  _scoreWorkArr?: Assignment[];
  _scoreIdxById?: Map<string, number>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sort participants by daily-load proximity to the affected-day average.
 *
 * Exported so rescue.ts (single-slot) and future-sos.ts (batch) share one
 * implementation. The depth-2/3 enumeration is capped (MAX_DEPTH3) and
 * iterates participants in outer-loop order — caps terminate on schedule-
 * order participants without this, which is effectively random w.r.t.
 * plan quality.
 */
export function sortParticipantsByLoadProximity(
  participants: Participant[],
  vacatedTask: Task,
  dayStartHour: number,
  taskMap: Map<string, Task>,
  assignmentsByParticipant: Map<string, Assignment[]>,
): Participant[] {
  const affectedDay = operationalDateKey(vacatedTask.timeBlock.start, dayStartHour);
  const loads = new Map<string, number>();
  let total = 0;
  for (const p of participants) {
    let hours = 0;
    const pAssignments = assignmentsByParticipant.get(p.id) || [];
    for (const a of pAssignments) {
      const task = taskMap.get(a.taskId);
      if (task && operationalDateKey(task.timeBlock.start, dayStartHour) === affectedDay) {
        hours += computeTaskEffectiveHours(task);
      }
    }
    loads.set(p.id, hours);
    total += hours;
  }
  const avg = participants.length > 0 ? total / participants.length : 0;
  return [...participants].sort(
    (a, b) => Math.abs((loads.get(a.id) || 0) - avg) - Math.abs((loads.get(b.id) || 0) - avg),
  );
}

/**
 * Sort donor assignments by chronological proximity to the vacated task.
 *
 * Exported so both rescue.ts and rescue-primitives.ts get deterministic,
 * quality-ranked donor slicing. Same input (regardless of schedule order)
 * produces the same top-N donors.
 */
export function sortDonorsByProximity(
  donors: Assignment[],
  vacatedStart: number,
  taskMap: Map<string, Task>,
): Assignment[] {
  return [...donors].sort((a, b) => {
    const ta = taskMap.get(a.taskId)?.timeBlock.start.getTime();
    const tb = taskMap.get(b.taskId)?.timeBlock.start.getTime();
    if (ta === undefined && tb === undefined) return 0;
    if (ta === undefined) return 1;
    if (tb === undefined) return -1;
    return Math.abs(ta - vacatedStart) - Math.abs(tb - vacatedStart);
  });
}

function taskAssignmentsFor(
  ctx: SlotEnumerationContext,
  taskId: string,
  excludeIds: Set<string>,
  extraAssignments?: Array<{ slotId: string; participantId: string }>,
): Assignment[] {
  const base = (ctx.assignmentsByTask.get(taskId) || []).filter((a) => !excludeIds.has(a.id));
  if (extraAssignments) {
    for (const ea of extraAssignments) {
      // Unique per-virtual ID — same-task depth-3 chains can inject two
      // virtuals into the same task list. Collisions were harmless today but
      // a tripwire for any future ID-keyed dedup in the HC pipeline.
      base.push({
        id: `__virtual__-${taskId}-${ea.slotId}-${ea.participantId}`,
        taskId,
        slotId: ea.slotId,
        participantId: ea.participantId,
      } as Assignment);
    }
  }
  return base;
}

function scoreSwapSet(
  ctx: SlotEnumerationContext,
  swaps: Array<{ assignmentId: string; newParticipantId: string }>,
): number {
  // Lazy-init a single scratch array + index reused across every scoring call
  // for the whole FSOS batch. Depth-3 alone can produce hundreds of candidates
  // per slot; cloning `schedule.assignments` each time was the dominant
  // allocator pressure and a significant slice of wall time.
  let workArr = ctx._scoreWorkArr;
  let idxById = ctx._scoreIdxById;
  if (!workArr || !idxById) {
    workArr = ctx.schedule.assignments.map((a) => ({ ...a }));
    idxById = new Map<string, number>();
    for (let i = 0; i < workArr.length; i++) idxById.set(workArr[i].id, i);
    ctx._scoreWorkArr = workArr;
    ctx._scoreIdxById = idxById;
  }
  const reverts: Array<{ idx: number; prev: string }> = [];
  for (const s of swaps) {
    const idx = idxById.get(s.assignmentId);
    if (idx === undefined) continue;
    reverts.push({ idx, prev: workArr[idx].participantId });
    workArr[idx].participantId = s.newParticipantId;
  }
  const score = computeScheduleScore(
    ctx.schedule.tasks,
    ctx.schedule.participants,
    workArr,
    ctx.config,
    ctx.scoreCtx,
  );
  for (const r of reverts) workArr[r.idx].participantId = r.prev;
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
  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    vacatedTask,
    ctx.schedule.algorithmSettings.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = vacatedTask.timeBlock.start.getTime();

  for (const p of sortedParticipants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pFutureAssignments = sortDonorsByProximity(
      pAssignments.filter(
        (a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
      ),
      vacatedStart,
      ctx.taskMap,
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
        // q may be the focal (vacated) participant — HC-3 via extraUnavailability
        // will reject them for in-window donor tasks while allowing reassignment
        // to outside-window donor tasks. This is the Future-SOS "reassign focal
        // elsewhere" path; do not filter focal out structurally here.
        if (q.id === p.id) continue;

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
  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    vacatedTask,
    ctx.schedule.algorithmSettings.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = vacatedTask.timeBlock.start.getTime();

  outer: for (const p of sortedParticipants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pDonors = sortDonorsByProximity(
      pAssignments.filter((a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor)),
      vacatedStart,
      ctx.taskMap,
    ).slice(0, MAX_P_DONORS);

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

      for (const q of sortedParticipants) {
        // q may be focal — HC-3 via extraUnavailability rejects them for
        // in-window donor tasks; outside-window donor tasks are a valid
        // reassignment of the focal participant (Future-SOS product intent).
        if (q.id === p.id) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const qDonors = sortDonorsByProximity(
          qAssignments.filter(
            (a) =>
              a.id !== vacatedAssignment.id && a.id !== donorP.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
          ),
          vacatedStart,
          ctx.taskMap,
        ).slice(0, MAX_Q_DONORS);

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

          for (const r of sortedParticipants) {
            // r may be focal — HC-3 via extraUnavailability rejects focal
            // for in-window donor tasks; outside-window donor tasks are a
            // valid focal reassignment under Future-SOS intent.
            if (r.id === p.id || r.id === q.id) continue;

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

// ─── Depth 4 (fallback only) ─────────────────────────────────────────────────

/**
 * Depth-4 chain enumeration. NOT part of the normal enumeration path.
 * Produces chains of the form:
 *   vacated → P, donor_P → Q, donor_Q → R, donor_R → S
 *
 * Only invoked when depth 1..3 return zero valid plans for the slot (single-slot
 * Rescue) or when batch composition over depth-1..3 candidates produces no
 * feasible plan (Future SOS).
 *
 * Donor caps are deliberately tighter than depth 3 — the goal here is
 * feasibility, not breadth.
 */
function depth4(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: SlotRequirement,
  maxDepth4: number,
): CandidateChain[] {
  const plans: CandidateChain[] = [];
  const MAX_P_DONORS = 3;
  const MAX_Q_DONORS = 2;
  const MAX_R_DONORS = 2;
  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    vacatedTask,
    ctx.schedule.algorithmSettings.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = vacatedTask.timeBlock.start.getTime();

  outer: for (const p of sortedParticipants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pDonors = sortDonorsByProximity(
      pAssignments.filter((a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor)),
      vacatedStart,
      ctx.taskMap,
    ).slice(0, MAX_P_DONORS);

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

      for (const q of sortedParticipants) {
        if (q.id === p.id) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const qDonors = sortDonorsByProximity(
          qAssignments.filter(
            (a) =>
              a.id !== vacatedAssignment.id && a.id !== donorP.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
          ),
          vacatedStart,
          ctx.taskMap,
        ).slice(0, MAX_Q_DONORS);

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

          for (const r of sortedParticipants) {
            if (r.id === p.id || r.id === q.id) continue;

            const rAssignments = ctx.assignmentsByParticipant.get(r.id) || [];
            const rDonors = sortDonorsByProximity(
              rAssignments.filter(
                (a) =>
                  a.id !== vacatedAssignment.id &&
                  a.id !== donorP.id &&
                  a.id !== donorQ.id &&
                  isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
              ),
              vacatedStart,
              ctx.taskMap,
            ).slice(0, MAX_R_DONORS);

            for (const donorR of rDonors) {
              const donorRTask = ctx.taskMap.get(donorR.taskId);
              if (!donorRTask) continue;
              const donorRSlot = donorRTask.slots.find((s) => s.slotId === donorR.slotId);
              if (!donorRSlot) continue;

              const donorQExcl = new Set([donorQ.id, donorR.id, donorP.id, vacatedAssignment.id]);
              const rWithout = participantAssignmentsExcluding(ctx, r.id, donorQExcl);
              const donorQExtra: Array<{ slotId: string; participantId: string }> = [];
              if (donorQTask.id === vacatedTask.id) {
                donorQExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
              }
              if (donorQTask.id === donorPTask.id) {
                donorQExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
              }

              if (
                !isEligible(r, donorQTask, donorQSlot, rWithout, ctx.taskMap, {
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

              for (const s of sortedParticipants) {
                if (s.id === p.id || s.id === q.id || s.id === r.id) continue;

                const sAssignments = participantAssignmentsExcluding(ctx, s.id, new Set([donorR.id]));
                const donorRExcl = new Set([donorR.id, donorQ.id, donorP.id, vacatedAssignment.id]);

                const donorRExtra: Array<{ slotId: string; participantId: string }> = [];
                if (donorRTask.id === vacatedTask.id) {
                  donorRExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
                }
                if (donorRTask.id === donorPTask.id) {
                  donorRExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
                }
                if (donorRTask.id === donorQTask.id) {
                  donorRExtra.push({ slotId: donorQSlot.slotId, participantId: r.id });
                }

                if (
                  !isEligible(s, donorRTask, donorRSlot, sAssignments, ctx.taskMap, {
                    checkSameGroup: true,
                    taskAssignments: taskAssignmentsFor(
                      ctx,
                      donorRTask.id,
                      donorRExcl,
                      donorRExtra.length > 0 ? donorRExtra : undefined,
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
                  { assignmentId: donorR.id, newParticipantId: s.id },
                ];
                const soloCompositeDelta = scoreSwapSet(ctx, swapSet);

                plans.push({
                  depth: 4,
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
                    {
                      assignmentId: donorR.id,
                      fromParticipantId: r.id,
                      toParticipantId: s.id,
                      taskId: donorRTask.id,
                      taskName: donorRTask.name,
                      slotLabel: describeSlot(donorRSlot.label, donorRTask.timeBlock),
                    },
                  ],
                  soloCompositeDelta,
                  touchedAssignmentIds: [vacatedAssignment.id, donorP.id, donorQ.id, donorR.id],
                  participantTaskPairs: [
                    { participantId: p.id, taskId: vacatedTask.id },
                    { participantId: q.id, taskId: donorPTask.id },
                    { participantId: r.id, taskId: donorQTask.id },
                    { participantId: s.id, taskId: donorRTask.id },
                  ],
                });

                if (plans.length >= maxDepth4) break outer;
              }
            }
          }
        }
      }
    }
  }

  plans.sort((a, b) => b.soloCompositeDelta - a.soloCompositeDelta);
  return plans;
}

// ─── Depth 5 (fallback only, last-resort) ────────────────────────────────────

/**
 * Depth-5 chain enumeration. Last-resort fallback. Produces chains of the form:
 *   vacated → P, donor_P → Q, donor_Q → R, donor_R → S, donor_S → T
 *
 * Only invoked for the batch (Future SOS) feature when depth-4 re-enumeration
 * still produces no feasible composition. Single-slot Rescue never calls this.
 *
 * Donor caps are the tightest of any depth; the goal is to unlock
 * compositional feasibility, not to generate alternatives.
 */
function depth5(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  vacatedTask: Task,
  vacatedSlot: SlotRequirement,
  maxDepth5: number,
): CandidateChain[] {
  const plans: CandidateChain[] = [];
  const MAX_P_DONORS = 2;
  const MAX_Q_DONORS = 2;
  const MAX_R_DONORS = 2;
  const MAX_S_DONORS = 1;
  const sortedParticipants = sortParticipantsByLoadProximity(
    ctx.schedule.participants,
    vacatedTask,
    ctx.schedule.algorithmSettings.dayStartHour,
    ctx.taskMap,
    ctx.assignmentsByParticipant,
  );
  const vacatedStart = vacatedTask.timeBlock.start.getTime();

  outer: for (const p of sortedParticipants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pDonors = sortDonorsByProximity(
      pAssignments.filter((a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor)),
      vacatedStart,
      ctx.taskMap,
    ).slice(0, MAX_P_DONORS);

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

      for (const q of sortedParticipants) {
        if (q.id === p.id) continue;

        const qAssignments = ctx.assignmentsByParticipant.get(q.id) || [];
        const qDonors = sortDonorsByProximity(
          qAssignments.filter(
            (a) =>
              a.id !== vacatedAssignment.id && a.id !== donorP.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
          ),
          vacatedStart,
          ctx.taskMap,
        ).slice(0, MAX_Q_DONORS);

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

          for (const r of sortedParticipants) {
            if (r.id === p.id || r.id === q.id) continue;

            const rAssignments = ctx.assignmentsByParticipant.get(r.id) || [];
            const rDonors = sortDonorsByProximity(
              rAssignments.filter(
                (a) =>
                  a.id !== vacatedAssignment.id &&
                  a.id !== donorP.id &&
                  a.id !== donorQ.id &&
                  isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
              ),
              vacatedStart,
              ctx.taskMap,
            ).slice(0, MAX_R_DONORS);

            for (const donorR of rDonors) {
              const donorRTask = ctx.taskMap.get(donorR.taskId);
              if (!donorRTask) continue;
              const donorRSlot = donorRTask.slots.find((s) => s.slotId === donorR.slotId);
              if (!donorRSlot) continue;

              const donorQExcl = new Set([donorQ.id, donorR.id, donorP.id, vacatedAssignment.id]);
              const rWithout = participantAssignmentsExcluding(ctx, r.id, donorQExcl);
              const donorQExtra: Array<{ slotId: string; participantId: string }> = [];
              if (donorQTask.id === vacatedTask.id) {
                donorQExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
              }
              if (donorQTask.id === donorPTask.id) {
                donorQExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
              }

              if (
                !isEligible(r, donorQTask, donorQSlot, rWithout, ctx.taskMap, {
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

              for (const s of sortedParticipants) {
                if (s.id === p.id || s.id === q.id || s.id === r.id) continue;

                const sAssignments = ctx.assignmentsByParticipant.get(s.id) || [];
                const sDonors = sortDonorsByProximity(
                  sAssignments.filter(
                    (a) =>
                      a.id !== vacatedAssignment.id &&
                      a.id !== donorP.id &&
                      a.id !== donorQ.id &&
                      a.id !== donorR.id &&
                      isModifiableAssignment(a, ctx.taskMap, ctx.anchor),
                  ),
                  vacatedStart,
                  ctx.taskMap,
                ).slice(0, MAX_S_DONORS);

                for (const donorS of sDonors) {
                  const donorSTask = ctx.taskMap.get(donorS.taskId);
                  if (!donorSTask) continue;
                  const donorSSlot = donorSTask.slots.find((sl) => sl.slotId === donorS.slotId);
                  if (!donorSSlot) continue;

                  const donorRExcl = new Set([donorR.id, donorS.id, donorQ.id, donorP.id, vacatedAssignment.id]);
                  const sWithout = participantAssignmentsExcluding(ctx, s.id, donorRExcl);
                  const donorRExtra: Array<{ slotId: string; participantId: string }> = [];
                  if (donorRTask.id === vacatedTask.id) {
                    donorRExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
                  }
                  if (donorRTask.id === donorPTask.id) {
                    donorRExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
                  }
                  if (donorRTask.id === donorQTask.id) {
                    donorRExtra.push({ slotId: donorQSlot.slotId, participantId: r.id });
                  }

                  if (
                    !isEligible(s, donorRTask, donorRSlot, sWithout, ctx.taskMap, {
                      checkSameGroup: true,
                      taskAssignments: taskAssignmentsFor(
                        ctx,
                        donorRTask.id,
                        donorRExcl,
                        donorRExtra.length > 0 ? donorRExtra : undefined,
                      ),
                      participantMap: ctx.participantMap,
                      disabledHC: ctx.disabledHC,
                      restRuleMap: ctx.restRuleMap,
                      extraUnavailability: ctx.extraUnavailability,
                    })
                  )
                    continue;

                  for (const t of sortedParticipants) {
                    if (t.id === p.id || t.id === q.id || t.id === r.id || t.id === s.id) continue;

                    const tAssignments = participantAssignmentsExcluding(ctx, t.id, new Set([donorS.id]));
                    const donorSExcl = new Set([donorS.id, donorR.id, donorQ.id, donorP.id, vacatedAssignment.id]);

                    const donorSExtra: Array<{ slotId: string; participantId: string }> = [];
                    if (donorSTask.id === vacatedTask.id) {
                      donorSExtra.push({ slotId: vacatedSlot.slotId, participantId: p.id });
                    }
                    if (donorSTask.id === donorPTask.id) {
                      donorSExtra.push({ slotId: donorPSlot.slotId, participantId: q.id });
                    }
                    if (donorSTask.id === donorQTask.id) {
                      donorSExtra.push({ slotId: donorQSlot.slotId, participantId: r.id });
                    }
                    if (donorSTask.id === donorRTask.id) {
                      donorSExtra.push({ slotId: donorRSlot.slotId, participantId: s.id });
                    }

                    if (
                      !isEligible(t, donorSTask, donorSSlot, tAssignments, ctx.taskMap, {
                        checkSameGroup: true,
                        taskAssignments: taskAssignmentsFor(
                          ctx,
                          donorSTask.id,
                          donorSExcl,
                          donorSExtra.length > 0 ? donorSExtra : undefined,
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
                      { assignmentId: donorR.id, newParticipantId: s.id },
                      { assignmentId: donorS.id, newParticipantId: t.id },
                    ];
                    const soloCompositeDelta = scoreSwapSet(ctx, swapSet);

                    plans.push({
                      depth: 5,
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
                        {
                          assignmentId: donorR.id,
                          fromParticipantId: r.id,
                          toParticipantId: s.id,
                          taskId: donorRTask.id,
                          taskName: donorRTask.name,
                          slotLabel: describeSlot(donorRSlot.label, donorRTask.timeBlock),
                        },
                        {
                          assignmentId: donorS.id,
                          fromParticipantId: s.id,
                          toParticipantId: t.id,
                          taskId: donorSTask.id,
                          taskName: donorSTask.name,
                          slotLabel: describeSlot(donorSSlot.label, donorSTask.timeBlock),
                        },
                      ],
                      soloCompositeDelta,
                      touchedAssignmentIds: [vacatedAssignment.id, donorP.id, donorQ.id, donorR.id, donorS.id],
                      participantTaskPairs: [
                        { participantId: p.id, taskId: vacatedTask.id },
                        { participantId: q.id, taskId: donorPTask.id },
                        { participantId: r.id, taskId: donorQTask.id },
                        { participantId: s.id, taskId: donorRTask.id },
                        { participantId: t.id, taskId: donorSTask.id },
                      ],
                    });

                    if (plans.length >= maxDepth5) break outer;
                  }
                }
              }
            }
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
 * Enumerate candidate chains that can fill ONE vacated slot.
 *
 * Default path: depth 1 → 2 → 3 (matches the original enumeration).
 *
 * When `fallbackLevel` is `'depth4'`, depth-4 chains are appended. When it is
 * `'depth5'`, both depth-4 and depth-5 chains are appended. Depth 4 and 5 are
 * never produced by default — the caller must opt in explicitly after
 * verifying that depth-1..3 enumeration failed to yield a feasible plan.
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
  fallbackLevel: FallbackLevel = 'none',
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

  const merged: CandidateChain[] = [...d1, ...d2, ...d3];

  if (fallbackLevel === 'depth4' || fallbackLevel === 'depth5') {
    const d4Cap = caps.depth4 ?? 1;
    const d4MaxEnumeration = Math.max(100, d4Cap * 40);
    const d4 = depth4(ctx, vacatedAssignment, vacatedTask, vacatedSlot, d4MaxEnumeration).slice(0, d4Cap);
    merged.push(...d4);
  }

  if (fallbackLevel === 'depth5') {
    const d5Cap = caps.depth5 ?? 1;
    const d5MaxEnumeration = Math.max(50, d5Cap * 40);
    const d5 = depth5(ctx, vacatedAssignment, vacatedTask, vacatedSlot, d5MaxEnumeration).slice(0, d5Cap);
    merged.push(...d5);
  }

  merged.sort((a, b) => {
    // Primary: higher delta first.
    if (b.soloCompositeDelta !== a.soloCompositeDelta) return b.soloCompositeDelta - a.soloCompositeDelta;
    // Secondary: prefer shallower chains.
    return a.depth - b.depth;
  });
  return merged;
}
