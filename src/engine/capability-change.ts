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
import {
  computeScheduleScore,
  effectiveCapacity,
  IncrementalScorer,
  type ScoreContext,
} from '../constraints/soft-constraints';
import {
  type Assignment,
  Level,
  type Participant,
  type ParticipantCapacity,
  type RescueSwap,
  type Schedule,
  type SchedulerConfig,
  type SplitOp,
  type Task,
} from '../models/types';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import { blocksOverlap } from '../shared/utils/time-utils';
import { computeAllCapacities } from '../utils/capacity';
import { describeSlot } from '../utils/date-utils';
import { isSchedulerDiagOn } from './diagnostics';
import {
  type AffectedAssignment,
  applyCompositionToState,
  type BatchRescuePlan,
  buildPerParticipantChanges,
  dfsCompose,
  hashSwaps,
  mergeSwaps,
  selectDiversePlans,
} from './future-sos';
import {
  type CandidateChain,
  type ChainEnumerationCaps,
  deriveCapsForBatchSize,
  enumerateChainsForSlot,
  enumerateSplitFillsForSlot,
  type FallbackLevel,
  isSplitCandidate,
  type SlotCandidate,
  type SlotEnumerationContext,
} from './rescue-primitives';
import { isFutureTask, isModifiableAssignment } from './temporal';
import { isEligible } from './validator';

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

// ─── Focal-continuity gate thresholds ───────────────────────────────────────

/**
 * Active focal-placement extension fires when EITHER of these holds, AND the
 * focal isn't already essentially at target:
 *   - focal retains < 70% of their pre-change effective hours, OR
 *   - focal is below their proportional target by > 3 effective hours.
 *
 * Earlier this was an AND-gate (retention < 0.5 AND deficit > 2), which left
 * the moderate "middle band" (retention 50–70% with a real workload hole)
 * unhelped — the base depth-1 swap fills the vacated cert slot but doesn't
 * give the focal alternative work. Splitting into OR lets either signal fire
 * the extension; the `FOCAL_MIN_DEFICIT_FLOOR` guard prevents over-eager
 * firing when the focal is essentially at target.
 *
 * Per-iteration self-regulation: once the gate fires, the loop's strict
 * composite-improvement check (`delta > 1e-6`) naturally stops adding
 * extension moves once the focal is at target — additional placements would
 * hurt composite and get rejected. So the gate only decides whether to ENTER
 * the loop; the inner gate decides how far to go.
 *
 * `MAX_EXTENSION_SWAPS` bounds the total extension swaps the loop may add.
 * Each swap must strictly improve composite score — the extension never
 * makes a plan worse — so 3 is an upper bound on disruption, not a target.
 * In practice the strict-gain check terminates the loop earlier in most
 * cases; the cap exists to bound worst-case work and prevent runaway
 * rebalancing when a participant has a very large deficit.
 */
// Fixed, reasoned thresholds — not user-tunable and not auto-tuned.
const FOCAL_RETENTION_TRIGGER = 0.7;
const FOCAL_DEFICIT_TRIGGER_HOURS = 3;
const FOCAL_MIN_DEFICIT_FLOOR = 1;
const MAX_EXTENSION_SWAPS = 3;

// ─── Local capacity fallback ────────────────────────────────────────────────

function buildLocalCapacities(schedule: Schedule): Map<string, ParticipantCapacity> {
  if (schedule.tasks.length === 0) return new Map();
  let schedStart = schedule.tasks[0].timeBlock.start;
  let schedEnd = schedule.tasks[0].timeBlock.end;
  for (const t of schedule.tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  return computeAllCapacities(schedule.participants, schedStart, schedEnd, schedule.algorithmSettings.dayStartHour);
}

// ─── Focal workload metrics ─────────────────────────────────────────────────

export interface FocalWorkloadMetrics {
  /** Focal's effective hours in the original (pre-change) schedule. */
  preChangeEffectiveHours: number;
  /** Focal's effective hours after the plan's swaps are applied. */
  postPlanEffectiveHours: number;
  /** Focal's proportional target inside their pool (L0 or senior), post-plan. */
  target: number;
  /** max(0, target − postPlanEffectiveHours). */
  deficit: number;
  /** postPlanEffectiveHours / max(preChangeEffectiveHours, eps). 1 when pre is 0. */
  retentionFraction: number;
}

function focalEffectiveHoursFromAssignments(
  assignments: Assignment[],
  focalId: string,
  taskMap: Map<string, Task>,
): number {
  let h = 0;
  for (const a of assignments) {
    if (a.participantId !== focalId) continue;
    const t = taskMap.get(a.taskId);
    if (!t) continue;
    h += computeTaskEffectiveHours(t);
  }
  return h;
}

/**
 * Compute the focal participant's workload picture given a candidate plan's
 * post-application assignment view. The proportional target follows SC-3's
 * split-pool formula (L0 vs senior, capacity-proportional).
 */
export function computeFocalWorkloadMetrics(
  schedule: Schedule,
  focalId: string,
  postPlanAssignments: Assignment[],
  capacities: Map<string, ParticipantCapacity>,
  taskMap: Map<string, Task>,
): FocalWorkloadMetrics {
  const preChangeEffectiveHours = focalEffectiveHoursFromAssignments(schedule.assignments, focalId, taskMap);
  const postPlanEffectiveHours = focalEffectiveHoursFromAssignments(postPlanAssignments, focalId, taskMap);

  const focal = schedule.participants.find((p) => p.id === focalId);
  let target = 0;
  if (focal) {
    const isL0 = focal.level === Level.L0;
    let poolLoad = 0;
    let poolCapTotal = 0;
    let focalCap = 0;
    for (const p of schedule.participants) {
      const pIsL0 = p.level === Level.L0;
      if (pIsL0 !== isL0) continue;
      const eCap = effectiveCapacity(p, capacities.get(p.id)?.totalAvailableHours ?? 0);
      poolCapTotal += eCap;
      if (p.id === focalId) focalCap = eCap;
      poolLoad += focalEffectiveHoursFromAssignments(postPlanAssignments, p.id, taskMap);
    }
    if (poolCapTotal > 0) target = poolLoad * (focalCap / poolCapTotal);
  }

  const deficit = Math.max(0, target - postPlanEffectiveHours);
  const retentionFraction = preChangeEffectiveHours > 0 ? postPlanEffectiveHours / preChangeEffectiveHours : 1;
  return { preChangeEffectiveHours, postPlanEffectiveHours, target, deficit, retentionFraction };
}

// ─── Apply RescueSwap[] to assignments ──────────────────────────────────────

/**
 * Plain-swap counterpart of `applyCompositionToAssignments`. The base plan
 * exposes `RescueSwap[]` (merged across chains), so the extension pass works
 * off that flat list rather than rebuilding chain structures.
 */
function applySwapsToAssignments(schedule: Schedule, swaps: RescueSwap[]): Assignment[] {
  if (swaps.length === 0) return schedule.assignments.map((a) => ({ ...a }));
  const swapMap = new Map<string, string>();
  for (const s of swaps) swapMap.set(s.assignmentId, s.toParticipantId);
  return schedule.assignments.map((a) => {
    const pid = swapMap.get(a.id);
    return pid ? { ...a, participantId: pid } : { ...a };
  });
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

// ─── Focal-continuity extension pass ────────────────────────────────────────

interface ExtensionContext {
  schedule: Schedule;
  focalId: string;
  taskMap: Map<string, Task>;
  participantMap: Map<string, Participant>;
  capacities: Map<string, ParticipantCapacity>;
  config: SchedulerConfig;
  scoreCtx: ScoreContext;
  anchor: Date;
  affectedIds: Set<string>;
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>;
  extraCapabilityLoss: NonNullable<SlotEnumerationContext['extraCapabilityLoss']>;
  disabledHC: Set<string> | undefined;
  restRuleMap: Map<string, number> | undefined;
  scheduleContext: import('../shared/utils/time-utils').ScheduleContext | undefined;
  certLabelResolver: ((c: string) => string) | undefined;
  baselineComposite: number;
}

/**
 * Attempt to extend a base plan with up to `MAX_EXTENSION_SWAPS` single-swap
 * placements of the focal participant into other compatible slots. Each
 * extension swap must strictly improve composite score. Returns a new
 * BatchRescuePlan tagged with `focalContinuityExtended: true` when at least
 * one extension was applied, or `null` when the gate did not fire, no
 * eligible improving target existed, the extended composition was worse
 * than the base plan, or the final assignments failed full HC validation.
 *
 * The scan uses IncrementalScorer over a fresh post-plan-view scorer so each
 * trial is O(k) rather than O(P·A). Pattern mirrors `polishReplaceWithIdle`
 * in the optimizer; the focal is the only "candidate" considered (we are not
 * doing a general polish, just placing the focal).
 */
function tryFocalContinuityExtensions(basePlan: BatchRescuePlan, ctx: ExtensionContext): BatchRescuePlan | null {
  // Don't extend partial / HC-violating plans — they aren't applyable as-is.
  if (basePlan.isPartial || basePlan.violations.length > 0) return null;

  const postPlanAssignments = applySwapsToAssignments(ctx.schedule, basePlan.swaps);

  // Gate check uses metrics computed against the post-plan view.
  const metrics = computeFocalWorkloadMetrics(
    ctx.schedule,
    ctx.focalId,
    postPlanAssignments,
    ctx.capacities,
    ctx.taskMap,
  );
  // Floor: skip if focal is essentially at target — any further placement would
  // push them over and the per-iteration strict-improvement check would reject
  // it anyway, so we save the work.
  if (metrics.deficit < FOCAL_MIN_DEFICIT_FLOOR) return null;
  // OR-trigger: either retention drop OR absolute deficit fires the extension.
  const triggeredByRetention = metrics.retentionFraction < FOCAL_RETENTION_TRIGGER;
  const triggeredByDeficit = metrics.deficit > FOCAL_DEFICIT_TRIGGER_HOURS;
  if (!triggeredByRetention && !triggeredByDeficit) return null;

  const focal = ctx.participantMap.get(ctx.focalId);
  if (!focal) return null;

  // Fresh indices over the post-plan view. Mutating these during trial / commit
  // is safe because postPlanAssignments is a fresh array of shallow-copied
  // Assignment objects — not the schedule's frozen array.
  const byParticipant = new Map<string, Assignment[]>();
  const byTask = new Map<string, Assignment[]>();
  for (const a of postPlanAssignments) {
    let pl = byParticipant.get(a.participantId);
    if (!pl) {
      pl = [];
      byParticipant.set(a.participantId, pl);
    }
    pl.push(a);
    let tl = byTask.get(a.taskId);
    if (!tl) {
      tl = [];
      byTask.set(a.taskId, tl);
    }
    tl.push(a);
  }

  // Build a fresh ScoreContext for the post-plan view so the scorer's
  // pool stats, daily totals, capacity targets, and notWith attribution
  // all reflect post-plan reality. `opts.scoreCtx` carries the immutable
  // bits (capacities, notWithPairs, dayStartHour, phantomTaskIds).
  const postPlanScoreCtx: ScoreContext = {
    ...ctx.scoreCtx,
    taskMap: ctx.taskMap,
    pMap: ctx.participantMap,
    assignmentsByParticipant: byParticipant,
    assignmentsByTask: byTask,
    capacities: ctx.capacities,
  };

  const incScorer = IncrementalScorer.build(
    ctx.schedule.tasks,
    ctx.schedule.participants,
    postPlanAssignments,
    ctx.config,
    postPlanScoreCtx,
  );
  let currentComposite = incScorer.compositeScore;

  const extensionSwaps: RescueSwap[] = [];
  const extensionTouched = new Set<string>();

  for (let iter = 0; iter < MAX_EXTENSION_SWAPS; iter++) {
    let best: {
      a: Assignment;
      task: Task;
      slot: import('../models/types').SlotRequirement;
      from: string;
      delta: number;
    } | null = null;

    for (const a of postPlanAssignments) {
      // Don't redo a slot the extension already grabbed.
      if (extensionTouched.has(a.id)) continue;
      // Don't touch slots the base plan already rearranged.
      if (ctx.affectedIds.has(a.id)) continue;
      // Already focal → nothing to gain.
      if (a.participantId === ctx.focalId) continue;

      const task = ctx.taskMap.get(a.taskId);
      if (!task) continue;
      if (!isFutureTask(task, ctx.anchor)) continue;
      if (!isModifiableAssignment(a, ctx.taskMap, ctx.anchor)) continue;

      const slot = task.slots.find((s) => s.slotId === a.slotId);
      if (!slot) continue;

      const focalAssigns = byParticipant.get(ctx.focalId) ?? [];
      const taskAssigns = byTask.get(task.id) ?? [];

      if (
        !isEligible(focal, task, slot, focalAssigns, ctx.taskMap, {
          checkSameGroup: true,
          taskAssignments: taskAssigns.filter((ta) => ta.slotId !== slot.slotId),
          participantMap: ctx.participantMap,
          disabledHC: ctx.disabledHC,
          restRuleMap: ctx.restRuleMap,
          scheduleContext: ctx.scheduleContext,
          extraUnavailability: ctx.extraUnavailability,
          extraCapabilityLoss: ctx.extraCapabilityLoss,
        })
      )
        continue;

      // Trial: X → focal at this slot.
      const incumbentPid = a.participantId;
      const incumbentList = byParticipant.get(incumbentPid);
      if (!incumbentList) continue;
      const savedI = incScorer.saveParticipant(incumbentPid);
      const savedF = incScorer.saveParticipant(ctx.focalId);
      if (!savedI || !savedF) continue;

      const idx = incumbentList.indexOf(a);
      if (idx === -1) continue;
      incumbentList.splice(idx, 1);
      a.participantId = ctx.focalId;
      let focalList = byParticipant.get(ctx.focalId);
      if (!focalList) {
        focalList = [];
        byParticipant.set(ctx.focalId, focalList);
      }
      focalList.push(a);

      const newComposite = incScorer.recomputeForSwap(incumbentPid, ctx.focalId);
      const delta = newComposite - currentComposite;

      // Undo trial.
      a.participantId = incumbentPid;
      const fIdx = focalList.indexOf(a);
      if (fIdx !== -1) focalList.splice(fIdx, 1);
      if (focalList.length === 0) byParticipant.delete(ctx.focalId);
      incumbentList.push(a);
      incScorer.restoreParticipant(incumbentPid, savedI);
      incScorer.restoreParticipant(ctx.focalId, savedF);
      incScorer.finalizeUndo();

      if (delta > 1e-6 && (best === null || delta > best.delta)) {
        best = { a, task, slot, from: incumbentPid, delta };
      }
    }

    if (!best) break;

    // Commit best.
    const incumbentList = byParticipant.get(best.from);
    if (!incumbentList) break;
    const idx = incumbentList.indexOf(best.a);
    if (idx === -1) break;
    incumbentList.splice(idx, 1);
    best.a.participantId = ctx.focalId;
    let focalList = byParticipant.get(ctx.focalId);
    if (!focalList) {
      focalList = [];
      byParticipant.set(ctx.focalId, focalList);
    }
    focalList.push(best.a);
    currentComposite = incScorer.recomputeForSwap(best.from, ctx.focalId);

    extensionSwaps.push({
      assignmentId: best.a.id,
      fromParticipantId: best.from,
      toParticipantId: ctx.focalId,
      taskId: best.task.id,
      taskName: best.task.name,
      slotLabel: describeSlot(best.slot.label, best.task.timeBlock),
    });
    extensionTouched.add(best.a.id);
  }

  if (extensionSwaps.length === 0) return null;

  // Defense in depth: full HC validation on the final assignments. The
  // incremental scan checked per-slot via isEligible, but two extension
  // swaps could conceivably interact in a way that only the bipartite
  // group-matching layer (HC-8) or pair-wise HC-12 across both new slots
  // catches. Reject the extension if anything fails.
  const validation = validateHardConstraints(
    ctx.schedule.tasks,
    ctx.schedule.participants,
    postPlanAssignments,
    ctx.disabledHC,
    ctx.restRuleMap,
    ctx.certLabelResolver,
    ctx.extraUnavailability,
    ctx.scheduleContext,
    ctx.extraCapabilityLoss,
  );
  if (validation.violations.length > 0) return null;

  // Final score via the full scorer for consistency with the base plan's
  // compositeDelta calculation (incremental drift is small but we don't
  // want comparator noise).
  const finalScore = computeScheduleScore(
    ctx.schedule.tasks,
    ctx.schedule.participants,
    postPlanAssignments,
    ctx.config,
    ctx.scoreCtx,
  );
  const compositeDelta = finalScore.compositeScore - ctx.baselineComposite;

  // Strict improvement guard against the base plan — extension must earn
  // its disruption.
  if (compositeDelta <= basePlan.compositeDelta + 1e-6) return null;

  const allSwaps = [...basePlan.swaps, ...extensionSwaps];
  const touched = new Set<string>();
  for (const s of allSwaps) touched.add(s.assignmentId);

  let focalContinuityHoursAdded = 0;
  for (const sw of extensionSwaps) {
    const t = ctx.taskMap.get(sw.taskId);
    if (!t) continue;
    focalContinuityHoursAdded += computeTaskEffectiveHours(t);
  }

  return {
    id: `${basePlan.id}-foc${extensionSwaps.length}`,
    rank: 0,
    swaps: allSwaps,
    compositeDelta,
    depthHistogram: { ...basePlan.depthHistogram },
    perParticipantChanges: buildPerParticipantChanges(ctx.schedule.assignments, postPlanAssignments, touched),
    violations: [],
    isPartial: basePlan.isPartial,
    fallbackDepthUsed: basePlan.fallbackDepthUsed,
    focalContinuityExtended: true,
    focalContinuityHoursAdded,
  };
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
    // Bias inner q/r/s/t loops to try the focal first within the depth
    // budget. Pure iteration-order hint; all eligibility/exclusion guards
    // still apply. Surfaces focal-inclusive chains earlier in depth 3+
    // (which has internal break caps) and is harmless at depth 2.
    priorityParticipantId: request.participantId,
  };

  // Capacities for the proportional-target computation that drives the
  // focal-continuity gate. Reuse the engine's pre-computed map when
  // available; otherwise derive locally from the schedule window so the
  // gate still works in CLI/test contexts where opts.scoreCtx is minimal.
  const capacities: Map<string, ParticipantCapacity> = opts.scoreCtx.capacities ?? buildLocalCapacities(schedule);

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
    const candidatesPerSlot: SlotCandidate[][] = [];
    const infeasibleIds: string[] = [];
    const splittingMode = schedule.algorithmSettings?.splittingMode ?? 'quality';
    for (const v of affected) {
      const chains = enumerateChainsForSlot(slotCtx, v.assignment, caps, fallbackLevel);
      // Dual-enumerator: split-fill candidates for `splittable` parents only.
      // Identity fast path when splittingMode is 'off' or no template opts in.
      const splits =
        splittingMode !== 'off' && v.task.splittable
          ? enumerateSplitFillsForSlot(slotCtx, v.assignment, affectedCount)
          : [];
      const slotPool: SlotCandidate[] = [...chains, ...splits];
      slotPool.sort((a, b) => b.soloCompositeDelta - a.soloCompositeDelta);
      if (slotPool.length === 0) infeasibleIds.push(v.assignment.id);
      candidatesPerSlot.push(slotPool);
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

    const computeFallbackDepthUsed = (cands: SlotCandidate[]): 4 | 5 | undefined => {
      let max: 1 | 2 | 3 | 4 | 5 = 1;
      for (const c of cands) {
        if (!isSplitCandidate(c) && c.depth > max) max = c.depth;
      }
      return max === 4 || max === 5 ? max : undefined;
    };

    const chainsOf = (cands: SlotCandidate[]): CandidateChain[] =>
      cands.filter((c): c is CandidateChain => !isSplitCandidate(c));
    const splitOpsOf = (cands: SlotCandidate[]): SplitOp[] => {
      const out: SplitOp[] = [];
      for (const c of cands) if (isSplitCandidate(c)) out.push(c.splitOp);
      return out;
    };

    const scored: BatchRescuePlan[] = [];
    const scoredInvalid: BatchRescuePlan[] = [];
    for (let i = 0; i < compositions.length; i++) {
      const comp = compositions[i];
      const touched = new Set<string>();
      for (const c of comp.slotCands) for (const id of c.touchedAssignmentIds) touched.add(id);

      const trial = applyCompositionToState(schedule, comp.slotCands);

      const validation = validateHardConstraints(
        trial.tasks,
        schedule.participants,
        trial.assignments,
        opts.disabledHC,
        opts.restRuleMap,
        opts.certLabelResolver,
        extraUnavailability,
        opts.scheduleContext,
        extraCapabilityLoss,
      );

      const depthHistogram: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const c of comp.slotCands) {
        if (!isSplitCandidate(c)) depthHistogram[c.depth]++;
      }
      const fallbackDepthUsed = computeFallbackDepthUsed(comp.slotCands);
      const chainSubset = chainsOf(comp.slotCands);
      const splitOpsForPlan = splitOpsOf(comp.slotCands);

      if (validation.violations.length > 0) {
        scoredInvalid.push({
          id: `capch-${hashSwaps(mergeSwaps(chainSubset))}-${i}`,
          rank: 0,
          swaps: mergeSwaps(chainSubset),
          splitOps: splitOpsForPlan.length > 0 ? splitOpsForPlan : undefined,
          compositeDelta: comp.deltaSum,
          depthHistogram,
          perParticipantChanges: buildPerParticipantChanges(schedule.assignments, trial.assignments, touched),
          violations: validation.violations,
          isPartial,
          fallbackDepthUsed,
        });
        continue;
      }

      // Override scoreCtx.taskMap for trial state — see the rationale in
      // future-sos.ts's matching block. opts.scoreCtx's taskMap was built
      // over the pre-split tasks; without this rebuild the per-assignment
      // soft-score loops can't find the half-tasks.
      const trialScoreCtx =
        trial.tasks === schedule.tasks
          ? opts.scoreCtx
          : {
              ...opts.scoreCtx,
              taskMap: new Map(trial.tasks.map((t) => [t.id, t])),
              assignmentsByParticipant: undefined,
              assignmentsByTask: undefined,
            };
      const candScore = computeScheduleScore(
        trial.tasks,
        schedule.participants,
        trial.assignments,
        opts.config,
        trialScoreCtx,
      );
      const compositeDelta = candScore.compositeScore - baselineScore.compositeScore;

      scored.push({
        id: `capch-${hashSwaps(mergeSwaps(chainSubset))}-${i}`,
        rank: 0,
        swaps: mergeSwaps(chainSubset),
        splitOps: splitOpsForPlan.length > 0 ? splitOpsForPlan : undefined,
        compositeDelta,
        depthHistogram,
        perParticipantChanges: buildPerParticipantChanges(schedule.assignments, trial.assignments, touched),
        violations: validation.violations,
        isPartial,
        fallbackDepthUsed,
      });
    }

    // Precompute focal continuity delta per plan once for the tiebreaker.
    // Smaller = focal closer to their proportional target post-plan.
    const focalDeltaCache = new Map<string, number>();
    const computeFocalDelta = (plan: BatchRescuePlan): number => {
      const postPlanAssigns = applySwapsToAssignments(schedule, plan.swaps);
      const m = computeFocalWorkloadMetrics(schedule, request.participantId, postPlanAssigns, capacities, taskMap);
      return Math.abs(m.target - m.postPlanEffectiveHours);
    };
    for (const plan of scored) focalDeltaCache.set(plan.id, computeFocalDelta(plan));

    const sortByQuality = (arr: BatchRescuePlan[]): void => {
      arr.sort((a, b) => {
        const delta = b.compositeDelta - a.compositeDelta;
        if (Math.abs(delta) > 0.1) return delta;
        // Tiebreaker: prefer plans where focal is closer to their target.
        const aFocal = focalDeltaCache.get(a.id) ?? 0;
        const bFocal = focalDeltaCache.get(b.id) ?? 0;
        if (Math.abs(aFocal - bFocal) > 0.01) return aFocal - bFocal;
        const aDisturbed = a.perParticipantChanges.length;
        const bDisturbed = b.perParticipantChanges.length;
        if (aDisturbed !== bDisturbed) return aDisturbed - bDisturbed;
        return a.swaps.length - b.swaps.length;
      });
    };
    sortByQuality(scored);

    // Active focal-placement extension: walk the top candidates, attempt to
    // place the focal into compatible non-affected slots when their workload
    // deficit triggers the gate. Each extension adds at most 2 strictly-
    // improving swaps. Variants are appended alongside the originals so
    // diversity selection can pick whichever scores better.
    const extCtx: ExtensionContext = {
      schedule,
      focalId: request.participantId,
      taskMap,
      participantMap,
      capacities,
      config: opts.config,
      scoreCtx: opts.scoreCtx,
      anchor,
      affectedIds: new Set(affected.map((aa) => aa.assignment.id)),
      extraUnavailability,
      extraCapabilityLoss,
      disabledHC: opts.disabledHC,
      restRuleMap: opts.restRuleMap,
      scheduleContext: opts.scheduleContext,
      certLabelResolver: opts.certLabelResolver,
      baselineComposite: baselineScore.compositeScore,
    };
    // Widened from `max(maxPlans*2, 6)` to `max(maxPlans*3, 10)` (2026-05-24)
    // so a quality-ranked-#7-#10 base plan that would uniquely benefit from
    // the focal extension still gets the chance — bound stays small enough
    // to keep total per-call cost bounded by `scored.length * O(extension)`.
    const extensionConsiderLimit = Math.min(scored.length, Math.max(maxPlans * 3, 10));
    const extendedVariants: BatchRescuePlan[] = [];
    for (let i = 0; i < extensionConsiderLimit; i++) {
      const ext = tryFocalContinuityExtensions(scored[i], extCtx);
      if (ext) {
        focalDeltaCache.set(ext.id, computeFocalDelta(ext));
        extendedVariants.push(ext);
      }
    }

    const augmented = extendedVariants.length > 0 ? [...scored, ...extendedVariants] : scored;
    if (extendedVariants.length > 0) sortByQuality(augmented);

    const top = selectDiversePlans(augmented, maxPlans);
    for (let i = 0; i < top.length; i++) top[i].rank = i + 1;

    return { validPlans: top, invalidPlans: scoredInvalid, infeasibleIds, timedOut, anySolvable: true };
  };

  // Same fallback cascade as Future SOS — feasibility-only escalation through
  // depth 4 and depth 5.
  const FALLBACK_MAX_BUDGET_MS = 10_000;
  const fallbackBudget = Math.min(FALLBACK_MAX_BUDGET_MS, timeBudgetMs * 4);

  // Hard-constraint invariant: HC-violating plans are never surfaced. If no
  // valid plan is found at any depth, return an empty plans list and let the
  // UI present the infeasible-state modal — never promote invalidPlans here.
  const stage1 = runStage('none', timeBudgetMs);
  let finalPlans = stage1.validPlans;
  let finalInfeasible = stage1.infeasibleIds;
  let finalTimedOut = stage1.timedOut;
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
  const sameSet = (a: string[], b: Set<string>) => a.length === b.size && a.every((c) => b.has(c));

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
