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

import { sameGroupUnitTaskIds } from '../constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import type {
  Assignment,
  Participant,
  RescueSwap,
  Schedule,
  SchedulerConfig,
  SlotRequirement,
  SplitOp,
  Task,
} from '../models/types';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import type { ScheduleContext } from '../shared/utils/time-utils';
import { describeSlot, operationalDateKey } from '../utils/date-utils';
import { makeSplitHalf } from './optimizer';
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

/**
 * Derive per-slot enumeration caps based on the affected-slot count K of a
 * Future-SOS batch. The original `DEFAULT_CAPS` is calibrated for the worst
 * case (K ≥ 8), which under-explores the common K=2..4 batches where the DFS
 * has plenty of budget. This widens d1/d2/d3 inversely with K and converges to
 * the historical defaults at K ≥ 8 — so existing K=8+ behaviour is preserved.
 *
 * d4/d5 stay at 1: those depths are the deep-chain feasibility fallback, never
 * a quality lever. Widening them would just bloat the invalid-bucket.
 *
 *   K=1 → {13,9,6}   K=4 → {10,6,3}   K=8+ → {6,4,2} (== DEFAULT_CAPS)
 */
export function deriveCapsForBatchSize(K: number): ChainEnumerationCaps {
  return {
    depth1: Math.max(6, Math.min(14, 6 + Math.max(0, 8 - K))),
    depth2: Math.max(4, Math.min(10, 4 + Math.max(0, 6 - K))),
    depth3: Math.max(2, Math.min(6, 2 + Math.max(0, 5 - K))),
    depth4: 1,
    depth5: 1,
  };
}

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
  /** Schedule window context for HC-3 operational-day rule evaluation. */
  scheduleContext?: ScheduleContext;
  config: SchedulerConfig;
  scoreCtx: ScoreContext;
  baselineComposite: number;
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>;
  /**
   * Schedule-scoped capability overrides. When a candidate's task overlaps
   * a matching entry, the listed certs are treated as absent — HC-2 / HC-11
   * see the override during eligibility checks. Drives the mid-schedule
   * capability-change flow.
   */
  extraCapabilityLoss?: Array<{
    participantId: string;
    lostCertifications: string[];
    start: Date;
    end: Date;
  }>;
  /**
   * Participants to exclude entirely from depth-1/2/3 candidate roles
   * (e.g. the focal unavailable participant of a Future SOS batch).
   * They can still appear as the donor's displaced participant.
   */
  excludeParticipantIds: Set<string>;
  /**
   * Assignment ids the batch is vacating from the focal (Future-SOS affected
   * slots / capability-change cert-affected slots). When the focal occupies a
   * donor-receiver role (q/r/s/t), these are removed from its PERSONAL
   * eligibility list so HC-5/12/14/15 model the post-plan state where the batch
   * has freed them — not the stale pre-plan booking. The terminal role used to
   * keep the current vacated slot in the focal's list (over-pruning valid
   * focal-reassignment plans); intermediate roles only stripped the current
   * slot, so the focal's OTHER vacated slots still over-pruned in multi-slot
   * batches. MUST contain only assignments actually being vacated — never the
   * focal's KEPT / opt-out / locked blocks, which remain real blockers. Absent
   * for inject (synthetic placeholder focal) ⇒ enumerators fall back to just the
   * current `vacatedAssignment.id`, a no-op for the placeholder.
   */
  focalVacatedAssignmentIds?: Set<string>;
  /**
   * Optional order-bias hint: when set, depth-2/3/4/5 try this participant
   * first in the `q`/`r`/`s`/`t` candidate-role loops. Pure iteration-order
   * bias — does not affect eligibility, exclusion, scoring, or depth caps.
   * All existing in-loop guards (excludeParticipantIds, outer-role identity
   * checks, isEligible) still apply unchanged. Used by capability-change to
   * front-load focal-inclusive chains within the depth budget; harmless when
   * the priority participant is excluded or fails eligibility (the loop just
   * falls through to the rest of the iteration in original order).
   */
  priorityParticipantId?: string;
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
 *
 * Multiplier-aware: each participant's day-load is multiplied by their
 * `workloadMultiplier` (default 1) before computing proximity to the
 * scaled-average. At the SC-3 / greedy equilibrium each load satisfies
 * `load_p ∝ cap_p / mult_p`, so under equal physical caps the scaled
 * loads are all equal — i.e. every participant looks "balanced" relative
 * to their multiplier-adjusted target. With all multipliers = 1 the
 * formula collapses to the original `|load − flat_avg|` ordering.
 */
export function sortParticipantsByLoadProximity(
  participants: Participant[],
  vacatedTask: Task,
  dayStartHour: number,
  taskMap: Map<string, Task>,
  assignmentsByParticipant: Map<string, Assignment[]>,
): Participant[] {
  const affectedDay = operationalDateKey(vacatedTask.timeBlock.start, dayStartHour);
  const scaledLoads = new Map<string, number>();
  let scaledTotal = 0;
  for (const p of participants) {
    let hours = 0;
    const pAssignments = assignmentsByParticipant.get(p.id) || [];
    for (const a of pAssignments) {
      const task = taskMap.get(a.taskId);
      if (task && operationalDateKey(task.timeBlock.start, dayStartHour) === affectedDay) {
        hours += computeTaskEffectiveHours(task);
      }
    }
    const m = p.workloadMultiplier ?? 1;
    const scaled = hours * (m > 0 ? m : 1);
    scaledLoads.set(p.id, scaled);
    scaledTotal += scaled;
  }
  const avg = participants.length > 0 ? scaledTotal / participants.length : 0;
  return [...participants].sort(
    (a, b) => Math.abs((scaledLoads.get(a.id) || 0) - avg) - Math.abs((scaledLoads.get(b.id) || 0) - avg),
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
  // Link-aware: a SPLIT same-group occurrence's assignees span its
  // residual+halves fragments, so the HC-4 precheck during chain enumeration
  // must consider the whole `sameGroupLinkId` unit (consistent with the
  // link-aware final validator). `[taskId]` fast path for any normal task.
  const qt = ctx.taskMap.get(taskId);
  const unitIds = qt ? sameGroupUnitTaskIds(qt, ctx.taskMap.values()) : [taskId];
  const base: Assignment[] = [];
  for (const tid of unitIds) {
    for (const a of ctx.assignmentsByTask.get(tid) || []) {
      if (!excludeIds.has(a.id)) base.push(a);
    }
  }
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
  const score = computeScheduleScore(ctx.schedule.tasks, ctx.schedule.participants, workArr, ctx.config, ctx.scoreCtx);
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

/**
 * The focal's batch-vacated assignment ids for the current enumeration, always
 * including the slot being filled (`vacatedAssignment.id`) defensively. Threaded
 * from the batch caller via `ctx.focalVacatedAssignmentIds`; falls back to just
 * the current slot when absent (inject's placeholder focal).
 */
function focalVacatedExcl(ctx: SlotEnumerationContext, vacatedAssignment: Assignment): Set<string> {
  const s = new Set(ctx.focalVacatedAssignmentIds ?? []);
  s.add(vacatedAssignment.id);
  return s;
}

/**
 * Build the exclusion set for a donor-receiver role's PERSONAL eligibility list:
 * the chain donor ids being handed off, unioned with the focal's batch-vacated
 * assignments (`focalExcl`). When the receiver IS the focal this removes the
 * slots the batch frees, so HC-5/12/14/15 see the post-plan state instead of a
 * phantom double-booking; when it is anyone else it is a no-op (those ids belong
 * only to the focal). PERSONAL lists only — the task-level `taskAssignmentsFor`
 * exclusion (HC-4 / HC-8) is intentionally left unchanged.
 */
function personalExclWithFocal(focalExcl: Set<string>, ...donorIds: string[]): Set<string> {
  const s = new Set(focalExcl);
  for (const id of donorIds) s.add(id);
  return s;
}

/**
 * Move the priority participant to the front of the iteration list while
 * preserving the relative order of all other entries. No-op when priorityId
 * is undefined, not found in the list, or already at index 0. Allocates a
 * single shallow copy only when reordering is needed.
 */
function withPriorityFirst<T extends Participant>(participants: T[], priorityId: string | undefined): T[] {
  if (!priorityId) return participants;
  const idx = participants.findIndex((p) => p.id === priorityId);
  if (idx <= 0) return participants;
  const reordered = [...participants];
  const [pr] = reordered.splice(idx, 1);
  reordered.unshift(pr);
  return reordered;
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
        scheduleContext: ctx.scheduleContext,
        extraUnavailability: ctx.extraUnavailability,
        extraCapabilityLoss: ctx.extraCapabilityLoss,
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
  const focalExcl = focalVacatedExcl(ctx, vacatedAssignment);

  for (const p of sortedParticipants) {
    if (p.id === vacatedAssignment.participantId) continue;
    if (ctx.excludeParticipantIds.has(p.id)) continue;

    const pAssignments = ctx.assignmentsByParticipant.get(p.id) || [];
    const pFutureAssignments = sortDonorsByProximity(
      pAssignments.filter((a) => a.id !== vacatedAssignment.id && isModifiableAssignment(a, ctx.taskMap, ctx.anchor)),
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
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of withPriorityFirst(ctx.schedule.participants, ctx.priorityParticipantId)) {
        // q may be the focal (vacated) participant — HC-3 via extraUnavailability
        // will reject them for in-window donor tasks while allowing reassignment
        // to outside-window donor tasks. This is the Future-SOS "reassign focal
        // elsewhere" path; do not filter focal out structurally here.
        // `focalExcl` strips the focal's batch-vacated slots from its own
        // eligibility list so HC-5/12/14/15 model the post-plan freed state, not
        // a phantom double-booking on the very slot this chain vacates.
        if (q.id === p.id) continue;

        const qAssignments = participantAssignmentsExcluding(ctx, q.id, personalExclWithFocal(focalExcl, donor.id));
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
            scheduleContext: ctx.scheduleContext,
            extraUnavailability: ctx.extraUnavailability,
            extraCapabilityLoss: ctx.extraCapabilityLoss,
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
  // Adaptive donor caps — ported verbatim from rescue.ts:generateDepth3Plans
  // (MAX_P_DONORS=max(5,⌈N/8⌉), MAX_Q_DONORS=max(3,⌈N/12⌉)) so the batch path
  // (Future-SOS / inject / capability-change) and single-slot rescue search
  // the same donor breadth and produce consistent plan quality. At typical
  // N≤40 these collapse to the historical fixed 5/3; they only widen for
  // larger teams, where a feasible deep chain can need a chronologically
  // distant donor beyond the 5th/3rd. The companion `maxDepth3` early-exit
  // is widened to match in `enumerateChainsForSlot`.
  const N = ctx.schedule.participants.length;
  const MAX_P_DONORS = Math.max(5, Math.ceil(N / 8));
  const MAX_Q_DONORS = Math.max(3, Math.ceil(N / 12));
  const focalExcl = focalVacatedExcl(ctx, vacatedAssignment);
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
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
        // q (intermediate) may be focal — HC-3 via extraUnavailability rejects
        // them for in-window donor tasks; outside-window donor tasks are a valid
        // reassignment of the focal participant (Future-SOS product intent).
        // The qWithout personal list below strips `focalExcl` (the focal's
        // batch-vacated slots) so HC-5/12/14/15 see the post-plan freed state.
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
          const qExcl = personalExclWithFocal(focalExcl, donorP.id, donorQ.id);
          const qWithout = participantAssignmentsExcluding(ctx, q.id, qExcl);
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
              scheduleContext: ctx.scheduleContext,
              extraUnavailability: ctx.extraUnavailability,
              extraCapabilityLoss: ctx.extraCapabilityLoss,
            })
          )
            continue;

          for (const r of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
            // r (terminal) may be focal — HC-3 via extraUnavailability rejects
            // focal for in-window donor tasks; outside-window donor tasks are a
            // valid focal reassignment under Future-SOS intent. `focalExcl`
            // strips the focal's batch-vacated slots from its eligibility list so
            // HC-5/12/14/15 see the post-plan freed state, not a phantom booking.
            if (r.id === p.id || r.id === q.id) continue;

            const rExcl = personalExclWithFocal(focalExcl, donorQ.id);
            const rAssignments = participantAssignmentsExcluding(ctx, r.id, rExcl);
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
                scheduleContext: ctx.scheduleContext,
                extraUnavailability: ctx.extraUnavailability,
                extraCapabilityLoss: ctx.extraCapabilityLoss,
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
  const focalExcl = focalVacatedExcl(ctx, vacatedAssignment);
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
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
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
          const qExcl = personalExclWithFocal(focalExcl, donorP.id, donorQ.id);
          const qWithout = participantAssignmentsExcluding(ctx, q.id, qExcl);
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
              scheduleContext: ctx.scheduleContext,
              extraUnavailability: ctx.extraUnavailability,
              extraCapabilityLoss: ctx.extraCapabilityLoss,
            })
          )
            continue;

          for (const r of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
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
              const rExcl = personalExclWithFocal(focalExcl, donorQ.id, donorR.id, donorP.id);
              const rWithout = participantAssignmentsExcluding(ctx, r.id, rExcl);
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
                  scheduleContext: ctx.scheduleContext,
                  extraUnavailability: ctx.extraUnavailability,
                  extraCapabilityLoss: ctx.extraCapabilityLoss,
                })
              )
                continue;

              for (const s of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
                // s (terminal) may be focal — `focalExcl` strips the focal's
                // batch-vacated slots so HC-5/12/14/15 model the post-plan
                // freed state (depth-4 fallback; same fix as depth-2/3 terminals).
                if (s.id === p.id || s.id === q.id || s.id === r.id) continue;

                const sExcl = personalExclWithFocal(focalExcl, donorR.id);
                const sAssignments = participantAssignmentsExcluding(ctx, s.id, sExcl);
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
                    scheduleContext: ctx.scheduleContext,
                    extraUnavailability: ctx.extraUnavailability,
                    extraCapabilityLoss: ctx.extraCapabilityLoss,
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
  const focalExcl = focalVacatedExcl(ctx, vacatedAssignment);
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
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      for (const q of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
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
          const qExcl = personalExclWithFocal(focalExcl, donorP.id, donorQ.id);
          const qWithout = participantAssignmentsExcluding(ctx, q.id, qExcl);
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
              scheduleContext: ctx.scheduleContext,
              extraUnavailability: ctx.extraUnavailability,
              extraCapabilityLoss: ctx.extraCapabilityLoss,
            })
          )
            continue;

          for (const r of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
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
              const rExcl = personalExclWithFocal(focalExcl, donorQ.id, donorR.id, donorP.id);
              const rWithout = participantAssignmentsExcluding(ctx, r.id, rExcl);
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
                  scheduleContext: ctx.scheduleContext,
                  extraUnavailability: ctx.extraUnavailability,
                  extraCapabilityLoss: ctx.extraCapabilityLoss,
                })
              )
                continue;

              for (const s of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
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
                  const sExcl = personalExclWithFocal(focalExcl, donorR.id, donorS.id, donorQ.id, donorP.id);
                  const sWithout = participantAssignmentsExcluding(ctx, s.id, sExcl);
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
                      scheduleContext: ctx.scheduleContext,
                      extraUnavailability: ctx.extraUnavailability,
                      extraCapabilityLoss: ctx.extraCapabilityLoss,
                    })
                  )
                    continue;

                  for (const t of withPriorityFirst(sortedParticipants, ctx.priorityParticipantId)) {
                    // t (terminal) may be focal — `focalExcl` strips the focal's
                    // batch-vacated slots so HC-5/12/14/15 model the post-plan
                    // freed state (depth-5 fallback; same fix as depth-2/3/4 terminals).
                    if (t.id === p.id || t.id === q.id || t.id === r.id || t.id === s.id) continue;

                    const tExcl = personalExclWithFocal(focalExcl, donorS.id);
                    const tAssignments = participantAssignmentsExcluding(ctx, t.id, tExcl);
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
                        scheduleContext: ctx.scheduleContext,
                        extraUnavailability: ctx.extraUnavailability,
                        extraCapabilityLoss: ctx.extraCapabilityLoss,
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
  // Widen the depth-3 early-exit alongside the adaptive donor caps so the
  // `break outer` count-cap doesn't truncate the wider donor space before the
  // delta sort. `N * 5` mirrors rescue.ts:generateDepth3Plans (MAX_DEPTH3);
  // the `caps.depth3 * 40` floor preserves the prior small-K enumeration depth.
  const d3MaxEnumeration = Math.max(200, ctx.schedule.participants.length * 5, caps.depth3 * 40);
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

// ─── Split-fill enumeration ──────────────────────────────────────────────────

/**
 * Per-slot candidate-pair cap used by `enumerateSplitFillsForSlot`.
 *
 * K-adaptive on the batch size: tightens as the FSOS/cap-change batch
 * widens so total candidates entering `dfsCompose` stay bounded
 * (`K × SPLIT_FILL_TOP_K(K)` ≤ ~60 even at K=10). For single-slot flows
 * (rescue, single-slot inject) K=1 unlocks 10 candidates — enough to
 * present a good ranked list without an arbitrary global cap dropping
 * necessary-split slots in large batches.
 */
export function splitFillTopK(K: number): number {
  if (K <= 4) return 10;
  if (K <= 8) return 8;
  if (K <= 14) return 6;
  return 5;
}

/** A single candidate that fills ONE vacated slot by splitting it. */
export interface SplitCandidate {
  splitOp: SplitOp;
  /** Composite delta vs baseline. Positive = improvement. */
  soloCompositeDelta: number;
  /** Touched assignments: just the original (replaced) one. */
  touchedAssignmentIds: string[];
  /**
   * (participantId, taskId) pairs the candidate places. Both halves point
   * at the original occurrence id so `dfsCompose` conflict detection treats
   * "person already on this occurrence elsewhere" as a clash exactly as for
   * a chain placement on the original task.
   */
  participantTaskPairs: Array<{ participantId: string; taskId: string }>;
}

/**
 * Per-slot candidate as seen by the batch composer (`dfsCompose`). Either a
 * chain (existing surface) or a split-fill (Phase-1 dynamic-split addition).
 * Both share `soloCompositeDelta`, `touchedAssignmentIds`, and
 * `participantTaskPairs`, so the composer's admissible-bound pruning and
 * conflict detection are kind-agnostic.
 */
export type SlotCandidate = CandidateChain | SplitCandidate;

/** Structural type-guard for SlotCandidate. */
export function isSplitCandidate(c: SlotCandidate): c is SplitCandidate {
  return (c as SplitCandidate).splitOp !== undefined;
}

/**
 * Enumerate split-fill candidates for ONE vacated slot.
 *
 * Realises the vacated slot as two half-tasks (`#a`/`#b` via `makeSplitHalf`)
 * staffed by two different participants. Each emitted candidate is hard-
 * constraint-valid against the trial state (HC-15 bidirectional, HC-16
 * disjointness, HC-8 link-union, HC-12/14 coalesce-aware) and scored by
 * composite delta. The caller's planner mixes split candidates with
 * `enumerateChainsForSlot` chain candidates and ranks them on the same
 * composite-score scale; `splitPenalty` from `ctx.config` is the economic
 * gate that keeps splits a fallback, not a default.
 *
 * Gating: returns `[]` immediately when the parent task is not `splittable`,
 * already split (`splitGroupId !== undefined`), not future/modifiable, or
 * has only one slot AND the participant being replaced is the only viable
 * candidate (degenerate). Callers should additionally skip this enumerator
 * when `splittingMode === 'off'` (zero-cost fast path).
 *
 * For `sameGroupRequired` parents: when an existing `sameGroupLinkId` has
 * surviving siblings on `schedule.tasks`, `groupLock` is derived from those
 * siblings' incumbents and both halves must come from that group. Otherwise
 * the enumerator tries every group that has ≥2 viable candidates and emits
 * the top split per group; the global K cap is then applied across groups.
 */
export function enumerateSplitFillsForSlot(
  ctx: SlotEnumerationContext,
  vacatedAssignment: Assignment,
  batchSize: number,
): SplitCandidate[] {
  const vacatedTask = ctx.taskMap.get(vacatedAssignment.taskId);
  if (!vacatedTask) return [];
  const vacatedSlot = vacatedTask.slots.find((s) => s.slotId === vacatedAssignment.slotId);
  if (!vacatedSlot) return [];
  if (!isFutureTask(vacatedTask, ctx.anchor)) return [];
  if (!isModifiableAssignment(vacatedAssignment, ctx.taskMap, ctx.anchor)) return [];

  // Hard gates: must be a non-already-split splittable task.
  if (!vacatedTask.splittable) return [];
  if (vacatedTask.splitGroupId !== undefined) return [];

  const startMs = vacatedTask.timeBlock.start.getTime();
  const endMs = vacatedTask.timeBlock.end.getTime();
  const midMs = startMs + Math.floor((endMs - startMs) / 2);
  // Refuse degenerate spans (sub-minute halves do not produce meaningful coverage).
  if (midMs - startMs < 60_000 || endMs - midMs < 60_000) return [];

  const halfA = makeSplitHalf(vacatedTask, 1, startMs, midMs, vacatedSlot);
  const halfB = makeSplitHalf(vacatedTask, 2, midMs, endMs, vacatedSlot);

  // Same-group: derive `groupLock` from any surviving link member, else try
  // every group in turn (caller-side `searchAcrossGroups` already does this
  // for inject; for rescue/FSOS/cap-change we do it inline).
  const isSameGroup = vacatedTask.sameGroupRequired === true;
  let groupLock: string | undefined;
  const groupsToTry: (string | undefined)[] = [undefined];
  if (isSameGroup) {
    const linkId = vacatedTask.sameGroupLinkId ?? vacatedTask.id;
    // Find any surviving link sibling (a different task that shares the link).
    let lockedGroup: string | undefined;
    for (const t of ctx.taskMap.values()) {
      if (t.id === vacatedTask.id) continue;
      if (t.sameGroupLinkId !== linkId) continue;
      // Find an incumbent on this sibling task.
      const sibAsgs = ctx.assignmentsByTask.get(t.id) || [];
      for (const sa of sibAsgs) {
        if (sa.id === vacatedAssignment.id) continue;
        const sp = ctx.participantMap.get(sa.participantId);
        if (sp) {
          lockedGroup = sp.group;
          break;
        }
      }
      if (lockedGroup) break;
    }
    if (lockedGroup) {
      groupLock = lockedGroup;
      groupsToTry.length = 0;
      groupsToTry.push(lockedGroup);
    } else {
      // No link survivors — try every distinct group present in the pool.
      const seen = new Set<string>();
      const allGroups: string[] = [];
      for (const p of ctx.schedule.participants) {
        if (!seen.has(p.group)) {
          seen.add(p.group);
          allGroups.push(p.group);
        }
      }
      groupsToTry.length = 0;
      for (const g of allGroups) groupsToTry.push(g);
    }
  }

  const excludeAssignments = new Set([vacatedAssignment.id]);
  const taskAsgsForA = taskAssignmentsFor(ctx, vacatedTask.id, excludeAssignments);
  const taskAsgsForB = taskAsgsForA; // same vacated link unit — both halves see it
  const linkId = isSameGroup ? (vacatedTask.sameGroupLinkId ?? vacatedTask.id) : undefined;

  const eligOptsBase = {
    checkSameGroup: true,
    participantMap: ctx.participantMap,
    disabledHC: ctx.disabledHC,
    restRuleMap: ctx.restRuleMap,
    extraUnavailability: ctx.extraUnavailability,
    extraCapabilityLoss: ctx.extraCapabilityLoss,
    scheduleContext: ctx.scheduleContext,
  };

  // Build trial-tasks scaffold (residual + halves replacing T) once. Cloning
  // is done per pair only for the assignment list. The trial taskMap-by-task
  // lookups during `computeScheduleScore` use this shared trialTasks.
  const survivingSlots = vacatedTask.slots.filter((s) => s.slotId !== vacatedSlot.slotId);
  const trialTasks: Task[] = [];
  for (const t of ctx.schedule.tasks) {
    if (t.id === vacatedTask.id) {
      if (survivingSlots.length > 0) {
        // For a sameGroupRequired parent, stamp sameGroupLinkId so HC-8's
        // link-union sees residual + halves as one unit (mirrors
        // optimizer.ts:1373). makeSplitHalf already stamps halves.
        trialTasks.push({
          ...vacatedTask,
          slots: survivingSlots,
          requiredCount: survivingSlots.length,
          sameGroupLinkId: vacatedTask.sameGroupRequired
            ? (vacatedTask.sameGroupLinkId ?? vacatedTask.id)
            : vacatedTask.sameGroupLinkId,
        });
      }
      trialTasks.push(halfA, halfB);
    } else {
      trialTasks.push(t);
    }
  }

  // Build a trial-specific ScoreContext. The caller-provided `ctx.scoreCtx`
  // was built over the pre-split task set, so its `taskMap` does NOT contain
  // the new `#a`/`#b` half-task ids. `computeScheduleScore` consults
  // `ctx?.taskMap ?? new Map(tasks.map(...))` — when a stale ctx is provided,
  // the per-assignment soft-score loops do `task = taskMap.get(a.taskId)` →
  // `undefined` → `if (!task) continue`, silently skipping the halves. The
  // pre-built `assignmentsByParticipant` / `assignmentsByTask` would also be
  // stale (built over pre-split assignments), so we explicitly drop them and
  // let `computeScheduleScore` rebuild from the trial `assignments` arg.
  const trialScoreCtx: ScoreContext = {
    ...ctx.scoreCtx,
    taskMap: new Map(trialTasks.map((t) => [t.id, t])),
    assignmentsByParticipant: undefined,
    assignmentsByTask: undefined,
  };

  // Score one trial pair (a on #a, b on #b) and return composite delta.
  const scoreTrialPair = (aId: string, bId: string): number => {
    const trialAsgs: Assignment[] = [];
    for (const asg of ctx.schedule.assignments) {
      if (asg.id === vacatedAssignment.id) continue;
      trialAsgs.push(asg);
    }
    const now = new Date();
    trialAsgs.push({
      id: `${vacatedAssignment.id}#a`,
      taskId: halfA.id,
      slotId: halfA.slots[0].slotId,
      participantId: aId,
      status: vacatedAssignment.status,
      updatedAt: now,
    });
    trialAsgs.push({
      id: `${vacatedAssignment.id}#b`,
      taskId: halfB.id,
      slotId: halfB.slots[0].slotId,
      participantId: bId,
      status: vacatedAssignment.status,
      updatedAt: now,
    });
    const score = computeScheduleScore(trialTasks, ctx.schedule.participants, trialAsgs, ctx.config, trialScoreCtx);
    return score.compositeScore - ctx.baselineComposite;
  };

  const candidates: SplitCandidate[] = [];

  for (const gl of groupsToTry) {
    // Build group-restricted candidate pool ordered by load proximity.
    const pool = sortParticipantsByLoadProximity(
      ctx.schedule.participants,
      vacatedTask,
      ctx.scheduleContext?.dayStartHour ?? 5,
      ctx.taskMap,
      ctx.assignmentsByParticipant,
    );

    const restricted = gl ? pool.filter((p) => p.group === gl) : pool;
    if (restricted.length < 2) continue;

    // Per-pair pre-filter via isEligible against the half-tasks. The half-task
    // carries splitGroupId/splitOccurrenceId/sameGroupLinkId from makeSplitHalf,
    // so HC-15 bidirectional, HC-16, HC-8 link-union all see the trial identity.
    // Quick A-side eligibility cache: a participant who fails halfA on their
    // own assignments won't pass any pair, so prune once.
    const aEligible: Participant[] = [];
    for (const p of restricted) {
      if (p.id === vacatedAssignment.participantId) continue;
      if (ctx.excludeParticipantIds.has(p.id)) continue;
      const pAsgs = participantAssignmentsExcluding(ctx, p.id, excludeAssignments);
      if (
        !isEligible(p, halfA, halfA.slots[0], pAsgs, ctx.taskMap, {
          ...eligOptsBase,
          taskAssignments: taskAsgsForA,
        })
      )
        continue;
      aEligible.push(p);
    }
    const bEligible: Participant[] = [];
    for (const p of restricted) {
      if (p.id === vacatedAssignment.participantId) continue;
      if (ctx.excludeParticipantIds.has(p.id)) continue;
      const pAsgs = participantAssignmentsExcluding(ctx, p.id, excludeAssignments);
      if (
        !isEligible(p, halfB, halfB.slots[0], pAsgs, ctx.taskMap, {
          ...eligOptsBase,
          taskAssignments: taskAsgsForB,
        })
      )
        continue;
      bEligible.push(p);
    }

    for (const a of aEligible) {
      for (const b of bEligible) {
        if (a.id === b.id) continue; // HC-16
        const delta = scoreTrialPair(a.id, b.id);
        candidates.push({
          splitOp: {
            kind: 'split',
            taskId: vacatedTask.id,
            slotId: vacatedSlot.slotId,
            taskName: vacatedTask.name,
            slotLabel: describeSlot(vacatedSlot.label, vacatedTask.timeBlock),
            originalAssignmentId: vacatedAssignment.id,
            originalParticipantId: vacatedAssignment.participantId,
            midpointMs: midMs,
            fillA: { participantId: a.id, displayName: a.name },
            fillB: { participantId: b.id, displayName: b.name },
            groupLock: gl,
            sameGroupLinkId: isSameGroup ? linkId : undefined,
          },
          soloCompositeDelta: delta,
          touchedAssignmentIds: [vacatedAssignment.id],
          // Use the original occurrence id (not the half-task ids) so
          // dfsCompose conflict detection treats both halves as a single
          // occurrence-placement for each filler.
          participantTaskPairs: [
            { participantId: a.id, taskId: vacatedTask.id },
            { participantId: b.id, taskId: vacatedTask.id },
          ],
        });
      }
    }
  }

  // Top-K by composite delta, deterministic tiebreak.
  candidates.sort((x, y) => {
    if (y.soloCompositeDelta !== x.soloCompositeDelta) return y.soloCompositeDelta - x.soloCompositeDelta;
    const xKey = `${x.splitOp.fillA.participantId}|${x.splitOp.fillB.participantId}`;
    const yKey = `${y.splitOp.fillA.participantId}|${y.splitOp.fillB.participantId}`;
    return xKey < yKey ? -1 : xKey > yKey ? 1 : 0;
  });
  return candidates.slice(0, splitFillTopK(batchSize));
}
