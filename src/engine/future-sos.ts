/**
 * Future SOS — multi-slot rescue planner.
 *
 * When a participant is marked unavailable for a future window, this module
 * identifies every assignment of theirs in the window and composes a single
 * batch plan that fills ALL vacated slots together. Batch composition is
 * scored by the full composite score (same scorer as the optimizer) and
 * pruned by admissible bounds — bounded disruption (depth ≤ 3 per slot)
 * with global quality.
 */

import { validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import type {
  Assignment,
  ConstraintViolation,
  Participant,
  RescueSwap,
  Schedule,
  SchedulerConfig,
  SlotRequirement,
  Task,
} from '../models/types';
import { blocksOverlap } from '../shared/utils/time-utils';
import {
  type CandidateChain,
  type ChainEnumerationCaps,
  DEFAULT_CAPS,
  enumerateChainsForSlot,
  type FallbackLevel,
  type SlotEnumerationContext,
} from './rescue-primitives';
import { isFutureTask, isModifiableAssignment } from './temporal';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface FutureSosRequest {
  participantId: string;
  window: { start: Date; end: Date };
}

export interface AffectedAssignment {
  assignment: Assignment;
  task: Task;
  slot: SlotRequirement;
}

export interface PerParticipantChange {
  participantId: string;
  added: Assignment[];
  removed: Assignment[];
}

export interface BatchRescuePlan {
  id: string;
  rank: number;
  swaps: RescueSwap[];
  /** candidate composite − baseline composite. Positive = improvement. */
  compositeDelta: number;
  /** { 1: n1, 2: n2, 3: n3, 4: n4, 5: n5 } — chain depths used across all slots. */
  depthHistogram: Record<1 | 2 | 3 | 4 | 5, number>;
  perParticipantChanges: PerParticipantChange[];
  violations: ConstraintViolation[];
  /**
   * True when at least one affected slot had no candidate chain (so this plan
   * only fills the solvable subset). The UI must not let users apply a partial
   * plan and should clearly mark it as an illustrative preview.
   */
  isPartial: boolean;
  /**
   * Highest chain depth used in this plan when depth 4 or 5 was reached via
   * the deep-chain fallback cascade. Undefined for normal depth 1..3 plans.
   * The UI uses this to render a "fallback mode" banner.
   */
  fallbackDepthUsed?: 4 | 5;
}

export interface BatchRescueResult {
  request: FutureSosRequest;
  /** Assignments in the window that require a replacement. */
  affected: AffectedAssignment[];
  /** Assignments in the window that the user opted out of replacing. */
  excludedInWindow: AffectedAssignment[];
  /** Assignments in the window that are frozen (past) — shown for info only. */
  lockedInPast: AffectedAssignment[];
  /** Top-N plans, ranked by compositeDelta desc. */
  plans: BatchRescuePlan[];
  /** Assignment IDs for which no valid chain could be found. */
  infeasibleAssignmentIds: string[];
  /**
   * True when the DFS composition hit its wall-clock budget and returned
   * best-so-far. When true, `plans` may be empty or sub-optimal even if
   * there is no infeasibility — the caller should surface this to the user
   * so they can retry with a narrower window.
   */
  timedOut: boolean;
}

export interface GenerateBatchOpts {
  maxPlans?: number;
  caps?: ChainEnumerationCaps;
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  certLabelResolver?: (certId: string) => string;
  /** Budget in ms for the DFS composition stage. Default 500. */
  timeBudgetMs?: number;
  /**
   * Assignment IDs the user opted out of replacing. Still returned in
   * `excludedInWindow` for display, but the planner does not try to fill
   * them — the participant keeps the slot despite the window.
   */
  excludedAssignmentIds?: ReadonlySet<string>;
  config: SchedulerConfig;
  scoreCtx: ScoreContext;
  /** Schedule window context for HC-3 operational-day rule evaluation. */
  scheduleContext?: import('../shared/utils/time-utils').ScheduleContext;
}

// ─── Affected-set identification ────────────────────────────────────────────

/**
 * Find all assignments held by the participant that overlap the window.
 * Splits into modifiable (need rescue) vs past-frozen (informational only).
 */
export function findAffectedAssignments(
  schedule: Schedule,
  participantId: string,
  window: { start: Date; end: Date },
  anchor: Date,
): { affected: AffectedAssignment[]; lockedInPast: AffectedAssignment[] } {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const affected: AffectedAssignment[] = [];
  const lockedInPast: AffectedAssignment[] = [];

  for (const a of schedule.assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    if (!blocksOverlap(task.timeBlock, window)) continue;
    const slot = task.slots.find((s) => s.slotId === a.slotId);
    if (!slot) continue;

    if (!isFutureTask(task, anchor) || !isModifiableAssignment(a, taskMap, anchor)) {
      lockedInPast.push({ assignment: a, task, slot });
    } else {
      affected.push({ assignment: a, task, slot });
    }
  }

  // Stable order: earliest task start first.
  affected.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  lockedInPast.sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  return { affected, lockedInPast };
}

// ─── Composition helpers ────────────────────────────────────────────────────

type Composition = { chains: CandidateChain[]; deltaSum: number };

function applyCompositionToAssignments(schedule: Schedule, chains: CandidateChain[]): Assignment[] {
  const swapMap = new Map<string, string>();
  for (const c of chains) {
    for (const s of c.swaps) swapMap.set(s.assignmentId, s.toParticipantId);
  }
  return schedule.assignments.map((a) => {
    const pid = swapMap.get(a.id);
    return pid ? { ...a, participantId: pid } : a;
  });
}

/**
 * 32-bit non-cryptographic hash over a plan's swap list — enough uniqueness
 * for plan ID stability (UI state, test equivalence) without pulling in a
 * real hash dep. Independent of time → identical inputs produce identical IDs.
 */
function hashSwaps(swaps: RescueSwap[]): string {
  let h = 2166136261; // FNV-1a offset basis
  const key = swaps
    .map((s) => `${s.assignmentId}>${s.toParticipantId}`)
    .sort()
    .join('|');
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Maximal Marginal Relevance selection over a composite-ranked plan list.
 *
 * Without this the top-K often collapses to near-duplicates (slot-0's best
 * candidate reused across the first several compositions, varying only in
 * slot-1). MMR picks the highest-scoring plan first, then each subsequent
 * pick maximizes compositeDelta − λ · max-similarity-to-already-picked.
 * Similarity is Jaccard overlap of the (toParticipantId, taskId) pairs —
 * two plans putting the same people on the same tasks score ~1.0 and get
 * demoted. λ = 0.3 keeps quality primary but breaks tie-cluster dominance.
 */
function selectDiversePlans(ranked: BatchRescuePlan[], k: number, lambda = 0.3): BatchRescuePlan[] {
  if (ranked.length <= k) return ranked;
  const keys = ranked.map((p) => new Set(p.swaps.map((s) => `${s.toParticipantId}|${s.taskId}`)));
  const picked: number[] = [0];
  while (picked.length < k && picked.length < ranked.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (picked.includes(i)) continue;
      let maxSim = 0;
      for (const j of picked) {
        const a = keys[i];
        const b = keys[j];
        if (a.size === 0 && b.size === 0) continue;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const union = a.size + b.size - inter;
        const sim = union === 0 ? 0 : inter / union;
        if (sim > maxSim) maxSim = sim;
      }
      const s = ranked[i].compositeDelta - lambda * maxSim * Math.max(1, Math.abs(ranked[0].compositeDelta));
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    picked.push(bestIdx);
  }
  return picked.map((i) => ranked[i]);
}

function mergeSwaps(chains: CandidateChain[]): RescueSwap[] {
  const merged: RescueSwap[] = [];
  const seen = new Set<string>();
  for (const c of chains) {
    for (const s of c.swaps) {
      if (seen.has(s.assignmentId)) continue;
      seen.add(s.assignmentId);
      merged.push(s);
    }
  }
  return merged;
}

function buildPerParticipantChanges(
  baseline: Assignment[],
  candidate: Assignment[],
  touchedAssignmentIds: Set<string>,
): PerParticipantChange[] {
  const baseById = new Map<string, Assignment>();
  for (const a of baseline) baseById.set(a.id, a);
  const candById = new Map<string, Assignment>();
  for (const a of candidate) candById.set(a.id, a);

  const byParticipant = new Map<string, { added: Assignment[]; removed: Assignment[] }>();
  const ensure = (pid: string) => {
    let entry = byParticipant.get(pid);
    if (!entry) {
      entry = { added: [], removed: [] };
      byParticipant.set(pid, entry);
    }
    return entry;
  };

  for (const id of touchedAssignmentIds) {
    const before = baseById.get(id);
    const after = candById.get(id);
    if (!before || !after) continue;
    if (before.participantId === after.participantId) continue;
    ensure(before.participantId).removed.push(before);
    ensure(after.participantId).added.push(after);
  }

  const result: PerParticipantChange[] = [];
  for (const [pid, v] of byParticipant) {
    result.push({ participantId: pid, added: v.added, removed: v.removed });
  }
  return result;
}

// ─── DFS composition with branch-and-bound ──────────────────────────────────

interface DfsState {
  chosen: (CandidateChain | null)[];
  usedAssignmentIds: Set<string>;
  usedPairs: Set<string>; // "pid|taskId"
  sumSoloDelta: number;
}

function pairKey(participantId: string, taskId: string): string {
  return `${participantId}|${taskId}`;
}

interface DfsOutcome {
  compositions: Composition[];
  timedOut: boolean;
}

function dfsCompose(candidatesPerSlot: CandidateChain[][], topK: number, deadline: number): DfsOutcome {
  // Suffix "best remaining" sums, for admissible upper-bound pruning.
  const suffixBest: number[] = new Array(candidatesPerSlot.length + 1).fill(0);
  for (let i = candidatesPerSlot.length - 1; i >= 0; i--) {
    const best = candidatesPerSlot[i].length > 0 ? candidatesPerSlot[i][0].soloCompositeDelta : -Infinity;
    suffixBest[i] = suffixBest[i + 1] + (Number.isFinite(best) ? best : 0);
  }

  const best: Composition[] = [];
  let timedOut = false;
  const state: DfsState = {
    chosen: new Array(candidatesPerSlot.length).fill(null),
    usedAssignmentIds: new Set(),
    usedPairs: new Set(),
    sumSoloDelta: 0,
  };

  function tryInsert(comp: Composition) {
    if (best.length < topK) {
      best.push(comp);
      best.sort((a, b) => b.deltaSum - a.deltaSum);
      return;
    }
    if (comp.deltaSum > best[best.length - 1].deltaSum) {
      best[best.length - 1] = comp;
      best.sort((a, b) => b.deltaSum - a.deltaSum);
    }
  }

  function worstKeptDelta(): number {
    return best.length < topK ? -Infinity : best[best.length - 1].deltaSum;
  }

  function recurse(i: number) {
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }

    if (i === candidatesPerSlot.length) {
      const chains = state.chosen.filter((c): c is CandidateChain => c !== null);
      tryInsert({ chains, deltaSum: state.sumSoloDelta });
      return;
    }

    // Admissible prune: even with the best possible remaining chains,
    // can this branch improve on the current worst kept?
    const upperBound = state.sumSoloDelta + suffixBest[i];
    if (upperBound <= worstKeptDelta()) return;

    const cands = candidatesPerSlot[i];
    for (const cand of cands) {
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }

      // Conflict checks.
      let conflict = false;
      for (const id of cand.touchedAssignmentIds) {
        if (state.usedAssignmentIds.has(id)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      for (const pair of cand.participantTaskPairs) {
        if (state.usedPairs.has(pairKey(pair.participantId, pair.taskId))) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      // Advance.
      const addedAssn: string[] = [];
      const addedPairs: string[] = [];
      for (const id of cand.touchedAssignmentIds) {
        state.usedAssignmentIds.add(id);
        addedAssn.push(id);
      }
      for (const pair of cand.participantTaskPairs) {
        const k = pairKey(pair.participantId, pair.taskId);
        state.usedPairs.add(k);
        addedPairs.push(k);
      }
      state.chosen[i] = cand;
      state.sumSoloDelta += cand.soloCompositeDelta;

      recurse(i + 1);

      // Backtrack.
      state.sumSoloDelta -= cand.soloCompositeDelta;
      state.chosen[i] = null;
      for (const id of addedAssn) state.usedAssignmentIds.delete(id);
      for (const k of addedPairs) state.usedPairs.delete(k);
    }
  }

  recurse(0);
  return { compositions: best, timedOut };
}

// ─── Effective-window helper ────────────────────────────────────────────────

/**
 * Subtract a set of kept-task intervals from a requested window, returning
 * the (possibly-split, possibly-empty) remaining windows.
 *
 * Used to punch holes in focal's Future-SOS unavailability around assignments
 * the user chose to keep (opt-out). Without this, the final validator fires
 * HC-3 on every kept in-window assignment even though the user explicitly
 * said "leave this one with focal."
 */
export function computeEffectiveUnavailabilityWindows(
  window: { start: Date; end: Date },
  keptBlocks: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  let current: Array<{ start: Date; end: Date }> = [{ start: window.start, end: window.end }];
  for (const kept of keptBlocks) {
    const next: Array<{ start: Date; end: Date }> = [];
    for (const w of current) {
      // No overlap → keep whole.
      if (kept.end.getTime() <= w.start.getTime() || kept.start.getTime() >= w.end.getTime()) {
        next.push(w);
        continue;
      }
      // Left slice before the kept block, if any.
      if (kept.start.getTime() > w.start.getTime()) {
        next.push({ start: w.start, end: kept.start });
      }
      // Right slice after the kept block, if any.
      if (kept.end.getTime() < w.end.getTime()) {
        next.push({ start: kept.end, end: w.end });
      }
    }
    current = next;
  }
  return current;
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function generateBatchRescuePlans(
  schedule: Schedule,
  request: FutureSosRequest,
  anchor: Date,
  opts: GenerateBatchOpts,
): BatchRescueResult {
  const { affected: allAffected, lockedInPast } = findAffectedAssignments(
    schedule,
    request.participantId,
    request.window,
    anchor,
  );

  const maxPlans = opts.maxPlans ?? 3;
  const caps = opts.caps ?? DEFAULT_CAPS;
  // K-aware budget default: 12^K grows fast. 500ms is adequate for K ≤ 4, but
  // realistic week-long windows routinely hit K=5+ where the DFS would time
  // out mid-composition. Scale the default up for larger batches; callers can
  // still override explicitly.
  const affectedCount = allAffected.filter((a) => !opts.excludedAssignmentIds?.has(a.assignment.id)).length;
  const defaultBudget = affectedCount >= 5 ? 1500 : 500;
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

  // Build extraUnavailability for eligibility checks + final validation:
  //   1. Start from the requested window.
  //   2. Subtract kept-task timeBlocks (opt-out) so focal keeps HC-3 coverage
  //      for assignments the user chose to leave in place — otherwise every
  //      returned plan would carry phantom HC-3 violations on those kept slots.
  //   3. Layer in any existing persisted scheduleUnavailability — without this,
  //      candidate eligibility ignores prior FSOS windows for any participant
  //      and the planner can place a candidate (or reassign focal) onto a task
  //      that's already inside a previously-recorded unavailability.
  const keptTaskBlocks = excludedInWindow.map((e) => e.task.timeBlock);
  const effectiveFocalWindows = computeEffectiveUnavailabilityWindows(request.window, keptTaskBlocks);
  const extraUnavailability: Array<{ participantId: string; start: Date; end: Date }> = [
    ...(schedule.scheduleUnavailability ?? []).map((u) => ({
      participantId: u.participantId,
      start: u.start,
      end: u.end,
    })),
    ...effectiveFocalWindows.map((w) => ({
      participantId: request.participantId,
      start: w.start,
      end: w.end,
    })),
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
    excludeParticipantIds: new Set([request.participantId]),
  };

  // Inner helper — runs enumeration + DFS composition + scoring at a given
  // fallback level. Factored out so the deep-chain cascade can invoke it
  // multiple times without duplicating the scoring block.
  //
  // Returns:
  //  - validPlans: ranked & diversity-selected (never includes invalid plans)
  //  - invalidPlans: kept as a last-resort bucket across the whole cascade
  //  - infeasibleAssignmentIds: slots that had no chain at this fallback level
  //  - timedOut: whether DFS hit its wall-clock deadline
  //  - anySolvable: false iff every slot had zero chains (nothing to compose)
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
      return { validPlans: [], invalidPlans: [], infeasibleIds, timedOut: false, anySolvable: false };
    }

    // Order slots by ascending candidate count (fail-fast DFS).
    const orderedSolvable = [...solvableIdx].sort((a, b) => candidatesPerSlot[a].length - candidatesPerSlot[b].length);
    const orderedCandidates = orderedSolvable.map((i) => candidatesPerSlot[i]);

    const deadline = Date.now() + budgetMs;
    const { compositions, timedOut } = dfsCompose(orderedCandidates, Math.max(maxPlans * 4, 8), deadline);

    if (compositions.length === 0) {
      return { validPlans: [], invalidPlans: [], infeasibleIds, timedOut, anySolvable: true };
    }

    const isPartial = infeasibleIds.length > 0;

    // Highest-depth-used, for the fallback badge. If any chain in the composition
    // is at depth 4 or 5, that's what the UI surfaces.
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
      );

      const depthHistogram: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const c of comp.chains) depthHistogram[c.depth]++;
      const fallbackDepthUsed = computeFallbackDepthUsed(comp.chains);

      if (validation.violations.length > 0) {
        scoredInvalid.push({
          id: `fsos-${hashSwaps(mergeSwaps(comp.chains))}-${i}`,
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
        id: `fsos-${hashSwaps(mergeSwaps(comp.chains))}-${i}`,
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

    // Rank valid plans; leave invalid ones unranked (caller may mix them in only
    // if no valid composition survived anywhere across the cascade).
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

  // Deep-chain fallback cascade — feasibility-only escalation.
  // Stage 1: normal depth 1..3. Stage 2: depth 4 enumeration per slot (unlocks
  // slots that had zero chains AND gives DFS extra breadth to break
  // compositional deadlocks). Stage 3: depth 5 as last-resort.
  // We escalate only when the previous stage produced no valid plans; fallback
  // never overrides a feasible shallow-chain result.
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
      `[future-sos] depth-4 fallback fired for participant ${request.participantId} ` +
        `(window ${request.window.start.toISOString()}..${request.window.end.toISOString()}, ` +
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
      `[future-sos] depth-5 fallback fired for participant ${request.participantId} ` +
        `(window ${request.window.start.toISOString()}..${request.window.end.toISOString()}, ` +
        `infeasibleSlots=${finalInfeasible.length}/${affected.length})`,
    );
    const stage3 = runStage('depth5', fallbackBudget);
    finalPlans = stage3.validPlans;
    finalInfeasible = stage3.infeasibleIds;
    finalTimedOut = stage3.timedOut;
    lastInvalidBucket = stage3.invalidPlans;
  }

  // Last-resort: if no valid plan at any depth, surface the final stage's
  // invalid-bucket compositions (if any). Preserves prior behavior where the
  // UI can show a violating plan behind a confirm dialog.
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
 * Append a new ScheduleUnavailability entry for a participant, merging
 * with any existing overlapping entry (windows unioned).
 *
 * Returns the updated scheduleUnavailability array (new reference).
 */
export function upsertScheduleUnavailability(
  existing: NonNullable<Schedule['scheduleUnavailability']> | undefined,
  entry: {
    id: string;
    participantId: string;
    start: Date;
    end: Date;
    reason?: string;
    createdAt: Date;
    anchorAtCreation: Date;
    appliedSwapCount?: number;
  },
): NonNullable<Schedule['scheduleUnavailability']> {
  const result = (existing ?? []).map((e) => ({ ...e }));
  let mergedStart = entry.start;
  let mergedEnd = entry.end;
  const overlappingIdx: number[] = [];
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    if (r.participantId !== entry.participantId) continue;
    if (mergedStart.getTime() < r.end.getTime() && r.start.getTime() < mergedEnd.getTime()) {
      overlappingIdx.push(i);
      if (r.start.getTime() < mergedStart.getTime()) mergedStart = r.start;
      if (r.end.getTime() > mergedEnd.getTime()) mergedEnd = r.end;
    }
  }
  // Remove overlapping entries (back-to-front so indexes stay valid).
  for (let i = overlappingIdx.length - 1; i >= 0; i--) result.splice(overlappingIdx[i], 1);
  result.push({
    id: entry.id,
    participantId: entry.participantId,
    start: mergedStart,
    end: mergedEnd,
    reason: entry.reason,
    createdAt: entry.createdAt,
    anchorAtCreation: entry.anchorAtCreation,
    appliedSwapCount: entry.appliedSwapCount,
  });
  return result;
}
