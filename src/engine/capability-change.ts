/**
 * Capability Change — mid-schedule certification loss planner.
 *
 * When a participant loses one or more certifications for a window, this
 * module identifies every assignment of theirs in the window where the slot
 * required the lost cert, and composes a single batch plan that fills all
 * affected slots together. Mirrors Future SOS in shape but differs in two
 * critical ways:
 *
 *   1. Affected-slot detection is cert-driven — only slots whose
 *      `requiredCertifications` overlap the lost set are vacated. The
 *      participant keeps their other assignments.
 *
 *   2. The focal participant is NOT excluded from the candidate pool —
 *      per-slot HC-2 / HC-11 (with `extraCapabilityLoss` layered) filters
 *      them out of cert-restricted slots while leaving them eligible for
 *      others. This lets depth-2/3 chains relocate the focal into newly-
 *      opened non-restricted slots, preserving fairness/workload balance.
 */

import { validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import type {
  Assignment,
  Participant,
  Schedule,
  SchedulerConfig,
  Task,
} from '../models/types';
import { blocksOverlap } from '../shared/utils/time-utils';
import {
  type AffectedAssignment,
  applyCompositionToAssignments,
  type BatchRescuePlan,
  buildPerParticipantChanges,
  dfsCompose,
  hashSwaps,
  mergeSwaps,
  selectDiversePlans,
} from './future-sos';
import { isSchedulerDiagOn } from './optimizer';
import {
  type CandidateChain,
  type ChainEnumerationCaps,
  deriveCapsForBatchSize,
  enumerateChainsForSlot,
  type FallbackLevel,
  type SlotEnumerationContext,
} from './rescue-primitives';
import { isFutureTask, isModifiableAssignment } from './temporal';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface CapabilityChangeRequest {
  participantId: string;
  /** Cert IDs the participant has lost. At least one. */
  lostCertifications: string[];
  /** Window during which the loss applies. */
  window: { start: Date; end: Date };
  reason?: string;
}

export interface CapabilityChangeResult {
  request: CapabilityChangeRequest;
  /** Modifiable future assignments where the slot required a lost cert. */
  affected: AffectedAssignment[];
  /** Affected assignments the user opted out of replacing. */
  excludedInWindow: AffectedAssignment[];
  /** Affected assignments locked in the past — informational only. */
  lockedInPast: AffectedAssignment[];
  /** Top-N plans, ranked by compositeDelta desc. Reuses `BatchRescuePlan`. */
  plans: BatchRescuePlan[];
  /** Affected assignment IDs for which no valid chain could be found. */
  infeasibleAssignmentIds: string[];
  /** True when the DFS composition hit its wall-clock budget. */
  timedOut: boolean;
}

export interface GenerateCapabilityChangeOpts {
  maxPlans?: number;
  caps?: ChainEnumerationCaps;
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  certLabelResolver?: (certId: string) => string;
  timeBudgetMs?: number;
  /** Affected assignment IDs the user opted out of replacing. */
  excludedAssignmentIds?: ReadonlySet<string>;
  config: SchedulerConfig;
  scoreCtx: ScoreContext;
  scheduleContext?: import('../shared/utils/time-utils').ScheduleContext;
}

// ─── Affected-set identification ────────────────────────────────────────────

/**
 * Find all assignments held by the participant in the given window where the
 * slot's required certifications overlap the lost set. Splits into
 * modifiable (need rescue) vs past-frozen (informational only).
 */
export function findCertAffectedAssignments(
  schedule: Schedule,
  request: CapabilityChangeRequest,
  anchor: Date,
): { affected: AffectedAssignment[]; lockedInPast: AffectedAssignment[] } {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const lostSet = new Set(request.lostCertifications);
  const affected: AffectedAssignment[] = [];
  const lockedInPast: AffectedAssignment[] = [];

  for (const a of schedule.assignments) {
    if (a.participantId !== request.participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    if (!blocksOverlap(task.timeBlock, request.window)) continue;
    const slot = task.slots.find((s) => s.slotId === a.slotId);
    if (!slot) continue;
    // Cert-driven predicate: include only if the slot requires at least one
    // of the lost certs. Slots requiring nothing the focal lost are still
    // valid placements and stay untouched.
    let requiresLost = false;
    for (const c of slot.requiredCertifications) {
      if (lostSet.has(c)) {
        requiresLost = true;
        break;
      }
    }
    if (!requiresLost) continue;

    if (!isFutureTask(task, anchor) || !isModifiableAssignment(a, taskMap, anchor)) {
      lockedInPast.push({ assignment: a, task, slot });
    } else {
      affected.push({ assignment: a, task, slot });
    }
  }

  affected.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  lockedInPast.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  return { affected, lockedInPast };
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function generateCapabilityChangePlans(
  schedule: Schedule,
  request: CapabilityChangeRequest,
  anchor: Date,
  opts: GenerateCapabilityChangeOpts,
): CapabilityChangeResult {
  const { affected: allAffected, lockedInPast } = findCertAffectedAssignments(schedule, request, anchor);

  const maxPlans = opts.maxPlans ?? 3;
  const affectedCount = allAffected.filter((a) => !opts.excludedAssignmentIds?.has(a.assignment.id)).length;
  const caps = opts.caps ?? deriveCapsForBatchSize(affectedCount);
  const defaultBudget = Math.min(4000, Math.max(500, 500 + 250 * Math.max(0, affectedCount - 2)));
  const timeBudgetMs = opts.timeBudgetMs ?? defaultBudget;

  const excludedIds = opts.excludedAssignmentIds;
  const excludedInWindow: AffectedAssignment[] = [];
  const affected: AffectedAssignment[] = [];
  for (const a of allAffected) {
    if (excludedIds?.has(a.assignment.id)) excludedInWindow.push(a);
    else affected.push(a);
  }

  if (affected.length === 0) {
    return {
      request,
      affected,
      excludedInWindow,
      lockedInPast,
      plans: [],
      infeasibleAssignmentIds: [],
      timedOut: false,
    };
  }

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const participantMap = new Map<string, Participant>();
  for (const p of schedule.participants) participantMap.set(p.id, p);

  const assignmentsByParticipant = new Map<string, Assignment[]>();
  const assignmentsByTask = new Map<string, Assignment[]>();
  for (const a of schedule.assignments) {
    let l = assignmentsByParticipant.get(a.participantId);
    if (!l) {
      l = [];
      assignmentsByParticipant.set(a.participantId, l);
    }
    l.push(a);
    let tl = assignmentsByTask.get(a.taskId);
    if (!tl) {
      tl = [];
      assignmentsByTask.set(a.taskId, tl);
    }
    tl.push(a);
  }

  // Existing scheduleUnavailability still applies — non-focal candidates must
  // honour any prior FSOS windows. Focal IS allowed to take new slots, so we
  // do NOT inject a focal availability window here.
  const extraUnavailability = (schedule.scheduleUnavailability ?? []).map((u) => ({
    participantId: u.participantId,
    start: u.start,
    end: u.end,
  }));

  // Layer this request on top of any prior capability losses already on the
  // snapshot. Both apply during eligibility checks and final validation.
  const extraCapabilityLoss = [
    ...(schedule.capabilityLoss ?? []).map((c) => ({
      participantId: c.participantId,
      lostCertifications: c.lostCertifications,
      start: c.start,
      end: c.end,
    })),
    {
      participantId: request.participantId,
      lostCertifications: request.lostCertifications,
      start: request.window.start,
      end: request.window.end,
    },
  ];

  const baselineScore = computeScheduleScore(
    schedule.tasks,
    schedule.participants,
    schedule.assignments,
    opts.config,
    opts.scoreCtx,
  );

  const slotCtx: SlotEnumerationContext = {
    schedule,
    taskMap,
    participantMap,
    assignmentsByParticipant,
    assignmentsByTask,
    anchor,
    disabledHC: opts.disabledHC,
    restRuleMap: opts.restRuleMap,
    scheduleContext: opts.scheduleContext,
    config: opts.config,
    scoreCtx: opts.scoreCtx,
    baselineComposite: baselineScore.compositeScore,
    extraUnavailability,
    extraCapabilityLoss,
    // Focal stays in the candidate pool — HC-2/HC-11 with the override
    // already filters them out of cert-restricted slots.
    excludeParticipantIds: new Set(),
  };

  const runStage = (
    fallbackLevel: FallbackLevel,
    budgetMs: number,
  ): {
    validPlans: BatchRescuePlan[];
    invalidPlans: BatchRescuePlan[];
    infeasibleIds: string[];
    timedOut: boolean;
    anySolvable: boolean;
  } => {
    const candidatesPerSlot: CandidateChain[][] = [];
    const infeasibleIds: string[] = [];
    for (const v of affected) {
      const chains = enumerateChainsForSlot(slotCtx, v.assignment, caps, fallbackLevel);
      if (chains.length === 0) infeasibleIds.push(v.assignment.id);
      candidatesPerSlot.push(chains);
    }

    const solvableIdx: number[] = [];
    for (let i = 0; i < candidatesPerSlot.length; i++) {
      if (candidatesPerSlot[i].length > 0) solvableIdx.push(i);
    }
    if (solvableIdx.length === 0) {
      if (isSchedulerDiagOn()) {
        console.log(
          `[capability-change] stage=${fallbackLevel} K=${affectedCount} caps=${JSON.stringify(caps)} ` +
            `no-solvable-slots infeasible=${infeasibleIds.length}/${affected.length}`,
        );
      }
      return { validPlans: [], invalidPlans: [], infeasibleIds, timedOut: false, anySolvable: false };
    }

    const orderedSolvable = [...solvableIdx].sort((a, b) => candidatesPerSlot[a].length - candidatesPerSlot[b].length);
    const orderedCandidates = orderedSolvable.map((i) => candidatesPerSlot[i]);

    const deadline = Date.now() + budgetMs;
    const { compositions, timedOut } = dfsCompose(orderedCandidates, Math.max(maxPlans * 4, 8), deadline);

    if (compositions.length === 0) {
      return { validPlans: [], invalidPlans: [], infeasibleIds, timedOut, anySolvable: true };
    }

    const isPartial = infeasibleIds.length > 0;

    const computeFallbackDepthUsed = (chains: CandidateChain[]): 4 | 5 | undefined => {
      let max: 1 | 2 | 3 | 4 | 5 = 1;
      for (const c of chains) if (c.depth > max) max = c.depth;
      return max === 4 || max === 5 ? max : undefined;
    };

    const scored: BatchRescuePlan[] = [];
    const scoredInvalid: BatchRescuePlan[] = [];
    for (let i = 0; i < compositions.length; i++) {
      const comp = compositions[i];
      const touched = new Set<string>();
      for (const c of comp.chains) for (const id of c.touchedAssignmentIds) touched.add(id);

      const tempAssignments = applyCompositionToAssignments(schedule, comp.chains);

      const validation = validateHardConstraints(
        schedule.tasks,
        schedule.participants,
        tempAssignments,
        opts.disabledHC,
        opts.restRuleMap,
        opts.certLabelResolver,
        extraUnavailability,
        opts.scheduleContext,
        extraCapabilityLoss,
      );

      const depthHistogram: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const c of comp.chains) depthHistogram[c.depth]++;
      const fallbackDepthUsed = computeFallbackDepthUsed(comp.chains);

      if (validation.violations.length > 0) {
        scoredInvalid.push({
          id: `capch-${hashSwaps(mergeSwaps(comp.chains))}-${i}`,
          rank: 0,
          swaps: mergeSwaps(comp.chains),
          compositeDelta: comp.deltaSum,
          depthHistogram,
          perParticipantChanges: buildPerParticipantChanges(schedule.assignments, tempAssignments, touched),
          violations: validation.violations,
          isPartial,
          fallbackDepthUsed,
        });
        continue;
      }

      const candScore = computeScheduleScore(
        schedule.tasks,
        schedule.participants,
        tempAssignments,
        opts.config,
        opts.scoreCtx,
      );
      const compositeDelta = candScore.compositeScore - baselineScore.compositeScore;

      scored.push({
        id: `capch-${hashSwaps(mergeSwaps(comp.chains))}-${i}`,
        rank: 0,
        swaps: mergeSwaps(comp.chains),
        compositeDelta,
        depthHistogram,
        perParticipantChanges: buildPerParticipantChanges(schedule.assignments, tempAssignments, touched),
        violations: validation.violations,
        isPartial,
        fallbackDepthUsed,
      });
    }

    scored.sort((a, b) => {
      const delta = b.compositeDelta - a.compositeDelta;
      if (Math.abs(delta) > 0.1) return delta;
      const aDisturbed = a.perParticipantChanges.length;
      const bDisturbed = b.perParticipantChanges.length;
      if (aDisturbed !== bDisturbed) return aDisturbed - bDisturbed;
      return a.swaps.length - b.swaps.length;
    });

    const top = selectDiversePlans(scored, maxPlans);
    for (let i = 0; i < top.length; i++) top[i].rank = i + 1;

    return { validPlans: top, invalidPlans: scoredInvalid, infeasibleIds, timedOut, anySolvable: true };
  };

  // Same fallback cascade as Future SOS — feasibility-only escalation through
  // depth 4 and depth 5.
  const FALLBACK_MAX_BUDGET_MS = 10_000;
  const fallbackBudget = Math.min(FALLBACK_MAX_BUDGET_MS, timeBudgetMs * 4);

  const stage1 = runStage('none', timeBudgetMs);
  let finalPlans = stage1.validPlans;
  let finalInfeasible = stage1.infeasibleIds;
  let finalTimedOut = stage1.timedOut;
  let lastInvalidBucket = stage1.invalidPlans;
  let stageAnySolvable = stage1.anySolvable;

  if (finalPlans.length === 0 && (stage1.anySolvable || stage1.infeasibleIds.length > 0)) {
    console.warn(
      `[capability-change] depth-4 fallback fired for participant ${request.participantId} ` +
        `(window ${request.window.start.toISOString()}..${request.window.end.toISOString()}, ` +
        `lost=${request.lostCertifications.join(',')}, ` +
        `infeasibleSlots=${stage1.infeasibleIds.length}/${affected.length})`,
    );
    const stage2 = runStage('depth4', fallbackBudget);
    finalPlans = stage2.validPlans;
    finalInfeasible = stage2.infeasibleIds;
    finalTimedOut = stage2.timedOut;
    lastInvalidBucket = stage2.invalidPlans;
    stageAnySolvable = stage2.anySolvable;
  }

  if (finalPlans.length === 0 && (stageAnySolvable || finalInfeasible.length > 0)) {
    console.warn(
      `[capability-change] depth-5 fallback fired for participant ${request.participantId} ` +
        `(window ${request.window.start.toISOString()}..${request.window.end.toISOString()})`,
    );
    const stage3 = runStage('depth5', fallbackBudget);
    finalPlans = stage3.validPlans;
    finalInfeasible = stage3.infeasibleIds;
    finalTimedOut = stage3.timedOut;
    lastInvalidBucket = stage3.invalidPlans;
  }

  if (finalPlans.length === 0 && lastInvalidBucket.length > 0) {
    lastInvalidBucket.sort((a, b) => {
      const delta = b.compositeDelta - a.compositeDelta;
      if (Math.abs(delta) > 0.1) return delta;
      const aDisturbed = a.perParticipantChanges.length;
      const bDisturbed = b.perParticipantChanges.length;
      if (aDisturbed !== bDisturbed) return aDisturbed - bDisturbed;
      return a.swaps.length - b.swaps.length;
    });
    const topInvalid = selectDiversePlans(lastInvalidBucket, maxPlans);
    for (let i = 0; i < topInvalid.length; i++) topInvalid[i].rank = i + 1;
    finalPlans = topInvalid;
  }

  return {
    request,
    affected,
    excludedInWindow,
    lockedInPast,
    plans: finalPlans,
    infeasibleAssignmentIds: finalInfeasible,
    timedOut: finalTimedOut,
  };
}

// ─── Entry persistence ──────────────────────────────────────────────────────

/**
 * Append a new CapabilityLoss entry, merging with any existing entry that
 * shares the same participant AND the exact same lost-cert set AND has an
 * overlapping window. Different cert sets (e.g. losing Hamama in one window
 * and Nitzan in another) coexist as independent events.
 */
export function upsertCapabilityLoss(
  existing: NonNullable<Schedule['capabilityLoss']> | undefined,
  entry: {
    id: string;
    participantId: string;
    lostCertifications: string[];
    start: Date;
    end: Date;
    reason?: string;
    createdAt: Date;
    anchorAtCreation: Date;
    appliedSwapCount?: number;
  },
): NonNullable<Schedule['capabilityLoss']> {
  const entrySet = new Set(entry.lostCertifications);
  const sameSet = (a: string[], b: Set<string>) =>
    a.length === b.size && a.every((c) => b.has(c));

  const result = (existing ?? []).map((e) => ({ ...e }));
  let mergedStart = entry.start;
  let mergedEnd = entry.end;
  const overlappingIdx: number[] = [];
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    if (r.participantId !== entry.participantId) continue;
    if (!sameSet(r.lostCertifications, entrySet)) continue;
    if (mergedStart.getTime() < r.end.getTime() && r.start.getTime() < mergedEnd.getTime()) {
      overlappingIdx.push(i);
      if (r.start.getTime() < mergedStart.getTime()) mergedStart = r.start;
      if (r.end.getTime() > mergedEnd.getTime()) mergedEnd = r.end;
    }
  }
  for (let i = overlappingIdx.length - 1; i >= 0; i--) result.splice(overlappingIdx[i], 1);
  result.push({
    id: entry.id,
    participantId: entry.participantId,
    lostCertifications: [...entry.lostCertifications],
    start: mergedStart,
    end: mergedEnd,
    reason: entry.reason,
    createdAt: entry.createdAt,
    anchorAtCreation: entry.anchorAtCreation,
    appliedSwapCount: entry.appliedSwapCount,
  });
  return result;
}
