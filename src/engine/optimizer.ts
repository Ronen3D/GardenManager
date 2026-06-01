/**
 * Optimizer - Max-Min Fairness scheduler with penalty heuristics.
 *
 * Uses a greedy constructive heuristic followed by local search (swap-based)
 * to maximize the composite score (rest fairness + penalties).
 *
 * Algorithm:
 *  1. Greedy Phase: Assign participants to task slots respecting hard constraints,
 *     using a priority that favors participants with the most accumulated rest.
 *  2. Local Search Phase: Iteratively try swaps between assignments to improve
 *     composite score, accepting improvements only.
 *
 * ┌─────────────────────────────────────────────────┐
 * │  🌱  Welcome to the Garden Manager Optimizer!  │
 * │                                                  │
 * │   "In the garden of algorithms, every swap      │
 * │    is a chance to make things grow better."     │
 * │                                                  │
 * │         🌻  Happy scheduling!  🌻               │
 * └─────────────────────────────────────────────────┘
 */

import { findMaxMatching, type SlotCandidates } from '../constraints/group-matching';
import {
  checkNoConsecutiveHighLoad as aggregateHc12,
  checkRestRules as aggregateHc14,
  checkSplitSiblingDisjoint,
  effectivelyBlocksAt,
  isLevelSatisfied,
  sameGroupUnitTaskIds,
  validateHardConstraints,
} from '../constraints/hard-constraints';
import { checkSleepRecoveryForPlacement } from '../constraints/sleep-recovery';
import { computeScheduleScore, IncrementalScorer, type ScoreContext } from '../constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  Level,
  type Participant,
  type ParticipantCapacity,
  type SchedulerConfig,
  type ScheduleScore,
  type SlotRequirement,
  type Task,
} from '../models/types';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import {
  blocksOverlap,
  isBlockedByDateUnavailability,
  isFullyCovered,
  type ScheduleContext,
} from '../shared/utils/time-utils';
import { computeAllCapacities } from '../utils/capacity';
import { describeSlot, operationalDateKey, taskOpDayStart } from '../utils/date-utils';
import {
  type AttemptRow,
  consumePolishProgressForAttempt,
  finalizeSnapshot,
  isSchedulerDiagOn,
  isVerboseDiag,
  recordAttempt,
  recordGreedyFailures,
  recordPhase,
  recordPolishPass,
  recordRejection,
  recordSAStats,
  recordSATempSample,
  resetSnapshot,
  setCapturingFinal,
  setCurrentAttemptIndex,
} from './diagnostics';
import type { PhantomContext } from './phantom';
import { getRejectionReason, isEligible } from './validator';

// ─── Simulated Annealing Constants ──────────────────────────────────────────
// Extracted from localSearch() for readability. Values are calibrated for the
// Garden Manager scheduling problem; do not change without benchmarking.

/**
 * Initial SA temperature. Day-count-adaptive based on benchmark data
 * (`bench-diversity-sweep.ts`, ~14h sweep across 1d..7d × {fresh, +cont}):
 *
 *  - ≤40 tasks (1-2 day schedules): T=55. Lowering T trended slightly
 *    negative across all 4 measured cells (1d/1d+cont/2d/2d+cont) at p>0.16.
 *  - ≥60 tasks (3-7 day schedules): T=5. Composite score gain ranges from
 *    +0.6% (3d, p<0.05) to +2.0% (6-7d, p<0.001).
 *
 * The 40-task threshold falls at the boundary of measured signal — 41 tasks
 * is unmeasured but extrapolates to "small enough that lowering hurts" and
 * 60 tasks (3-day default-template) is the first regime where lowering
 * helps significantly.
 */
function getSaInitialTemperature(taskCount: number): number {
  return taskCount <= 40 ? 55 : 5;
}

/** Geometric cooling rate per iteration. */
const SA_COOLING_RATE = 0.997;

/** Iterations without improvement before reheating to (initial T)/3. */
const SA_REHEAT_THRESHOLD = 500;

/** Probability of attempting an unfilled-slot insert move per iteration. */
const SA_INSERT_PROBABILITY = 0.2;

/**
 * Diagnostic record for a task slot that the scheduler could not fill.
 *
 * `hcCodes` is a machine-stable list of HC codes (e.g. ['HC-12', 'HC-14'])
 * that indicates which constraints blocked the slot. Used by the multi-attempt
 * driver to classify unfilled slots into ordering-fixable vs SA-insertable
 * vs structurally-infeasible, and route the elite-boost / SA-intensify budget
 * accordingly. `reason` remains a human-readable Hebrew string for UI display.
 */
export interface UnfilledSlot {
  taskId: string;
  slotId: string;
  reason: string;
  hcCodes?: string[];
}

/**
 * Reusable scratch buffer for HC-12/HC-14 checks inside isSwapFeasible.
 * Avoids per-call .map().filter() array allocations on the hot path.
 * Safe because isSwapFeasible is only called synchronously from the SA loop.
 */
const _hcScratch: Task[] = [];

/** Check if a participant holds any certification forbidden by the slot. */
function hasForbiddenCertification(p: Participant, slot: SlotRequirement): boolean {
  if (!slot.forbiddenCertifications?.length) return false;
  return slot.forbiddenCertifications.some((c) => p.certifications.includes(c));
}

/**
 * Greedy preference score for sorting: lower is better.
 *  -1: participant prefers this task name
 *   0: neutral (no preference for this task name)
 *  +1: participant dislikes this task name
 */
function computeGreedyPreferenceScore(p: Participant, task: Task): number {
  if (p.preferredTaskName && p.preferredTaskName === task.sourceName) return -1;
  if (p.lessPreferredTaskName && p.lessPreferredTaskName === task.sourceName) return +1;
  return 0;
}

/** P4: Add an assignment into the per-participant index */
function addToAssignmentMap(map: Map<string, Assignment[]>, a: Assignment): void {
  const arr = map.get(a.participantId);
  if (arr) arr.push(a);
  else map.set(a.participantId, [a]);
}

/** P4: Build a per-participant assignment index */
function buildAssignmentMap(assignments: Assignment[]): Map<string, Assignment[]> {
  const map = new Map<string, Assignment[]>();
  for (const a of assignments) addToAssignmentMap(map, a);
  return map;
}

let _assignmentCounter = 0;
function nextAssignmentId(): string {
  return `asgn-${++_assignmentCounter}`;
}

/** Reset counter (for testing) */
export function resetAssignmentCounter(): void {
  _assignmentCounter = 0;
}

// ─── Eligibility Checks ─────────────────────────────────────────────────────

/**
 * Check if a participant is eligible for a specific slot in a task,
 * considering current assignments (no double-booking).
 */
// ─── Benchmark hooks ────────────────────────────────────────────────────────
// Module-level state that lets benchmark scripts override SA initial
// temperature, slot ordering, and per-attempt jitter without restructuring
// the optimizer. When _benchHooks is null these have zero effect on
// production code paths.
export interface BenchHookConfig {
  perAttempt?: (
    attemptIdx: number,
    totalAttempts: number,
    totalTasks: number,
    totalParticipants: number,
  ) => {
    saInitialTemp?: number;
    randomizeSlotOrder?: boolean;
    jitter?: number;
  };
}
let _benchHooks: BenchHookConfig | null = null;
let _benchActiveSaTemp: number | null = null;
let _benchActiveRandomSlots = false;
export function setBenchHooks(h: BenchHookConfig | null): void {
  _benchHooks = h;
  _benchActiveSaTemp = null;
  _benchActiveRandomSlots = false;
}

/**
 * Phase 2 (D1+D3) dispatch flag — TRUE by default in production.
 *
 * When `true` (production default), `computeStructuralPriority` uses the
 * lowPriority-aware effective-cert-impact for S2 and the log-scale
 * pool-fraction for the sub-priority. When `false`, the legacy tiered
 * formula runs byte-identical to the pre-Phase-2 baseline; the priority
 * bench's `baseline` variant flips the flag off so it can compare D1+D3
 * against the legacy reference.
 *
 * Empirical basis for the production default: the canonical bench
 * (60 seeds × 30 attempts × 10 fixtures, see
 * [tmp/priority-bench-phase2-report.md](../../tmp/priority-bench-phase2-report.md))
 * found D1+D3 statistically improves fixture-default (Δ = +65.7 mean
 * composite, p = 0.000, 83% of seeds better, 24% lower stdDev), with
 * zero HC violations and zero regressions on the other 9 fixtures.
 * Three pathology anchors flip from fail→pass (P-universal-cert-tier,
 * P-saturated-pool, P-hamama-realistic); two remain failing in both
 * variants (P-adjacency-isolation, P-restRule-density) as documented
 * unfixed pathologies.
 *
 * Threshold for D1's S2 trigger: `θ_S2 = 0.5` — calibrated against the
 * default fixture so a moderate cert (Hamama at 50% globally, ~80% in
 * the lowPrio-aware L0-subset) trips it.
 */
let _useEnhancedRarity = true;
/** D1 — S2 tier-shift trigger. When effective cert impact > this, the task
 *  is demoted one tier (harder). Calibrated against the default fixture so
 *  Hamama (impact ≈ 0.8 against L0+Hamama subset) trips it. */
const D1_CERT_IMPACT_THRESHOLD = 0.5;
/** D1 — symmetric "vacuous-cert" relief: when effective cert impact < this,
 *  `hasCerts` and `hasExclusion` are treated as false in the base tier
 *  classifier. Without this, a universal-cert L0-only task (impact = 0)
 *  would stay stuck in Tier 2 even though the cert removes no one. The
 *  classic Tier 2 trap; this is what flips P-universal-cert-tier. */
const D1_LOW_IMPACT_THRESHOLD = 0.1;

export function _benchSetEnhancedRarity(on: boolean): void {
  _useEnhancedRarity = on;
}

export function _benchGetEnhancedRarity(): boolean {
  return _useEnhancedRarity;
}

/**
 * R4: Thin wrapper around the shared isEligible() that adds diagnostic
 * logging when enabled.  All constraint logic lives in validator.ts.
 */
function isEligibleForSlot(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  scheduleContext?: ScheduleContext,
): boolean {
  // Diag 'on' (and 'verbose') capture HC-rejection histograms; 'verbose'
  // additionally emits per-event console logs. Both modes share the same
  // `getRejectionReason` call — its cost is identical to `isEligible` since
  // both wrap the same `checkEligibility` (validator.ts), so capturing the
  // code is free relative to the boolean form.
  if (isSchedulerDiagOn()) {
    const code = getRejectionReason(participant, task, slot, participantAssignments, taskMap, {
      disabledHC,
      restRuleMap,
      scheduleContext,
    });
    if (code) {
      if (isVerboseDiag()) {
        const _tag = `${participant.name} → ${task.name} [${describeSlot(slot.label, task.timeBlock)}]`;
        console.log(`[Elig] REJECT: ${_tag} — ${code}`);
      }
      recordRejection(code, task.id, participant.id);
    }
    return code === null;
  }
  return isEligible(participant, task, slot, participantAssignments, taskMap, {
    disabledHC,
    restRuleMap,
    scheduleContext,
  });
}

/**
 * Get all eligible participants for a slot, sorted by priority.
 */
function getEligibleCandidates(
  task: Task,
  slot: SlotRequirement,
  participants: Participant[],
  assignmentsByParticipant: Map<string, Assignment[]>,
  taskMap: Map<string, Task>,
  participantWorkload: Map<string, number>,
  dailyWorkload?: Map<string, Map<string, number>>,
  disabledHC?: Set<string>,
  /** Per-group count of members eligible for same-group tasks. When provided,
   *  participants from groups with fewer eligible members are deprioritised
   *  (tie-break only) to keep tight groups available for same-group duties. */
  sameGroupEligibleCount?: Map<string, number>,
  restRuleMap?: Map<string, number>,
  dayStartHour?: number,
  scheduleContext?: ScheduleContext,
  /** Per-participant capacities. When provided, the workload tie-breaker reads
   *  in utilization space (load / capacity) instead of absolute hours, so a
   *  partial-availability participant isn't pushed onto the assignment ahead
   *  of a participant with more headroom. */
  capacities?: Map<string, ParticipantCapacity>,
): Participant[] {
  const eligible = participants.filter((p) =>
    isEligibleForSlot(
      p,
      task,
      slot,
      assignmentsByParticipant.get(p.id) || [],
      taskMap,
      disabledHC,
      restRuleMap,
      scheduleContext,
    ),
  );

  // Operational day of the task being assigned
  const taskDay = operationalDateKey(task.timeBlock.start, dayStartHour ?? 5);

  // ── C1 FIX: Single composite comparator ──
  // Merges what were three sequential (destructive) sorts into one stable sort.
  // Same-group:  workload → same-group-required count → level → preference → random
  // Non-group:   (lowPriority level sort) → workload → group capacity → preference → random

  // P3: Pre-compute random keys for a transitive, unbiased tiebreaker
  const rngKey = new Map<string, number>();
  for (const p of eligible) rngKey.set(p.id, Math.random());

  // Per-participant workloadMultiplier lookup (default 1.0). Divides physical
  // capacity at the fairness/greedy layer so a high-multiplier participant
  // looks more loaded for any given hours and is picked less often. Soft
  // balancing only — never reaches HC.
  const multByPid = new Map<string, number>();
  for (const p of eligible) multByPid.set(p.id, p.workloadMultiplier ?? 1);

  /**
   * Workload tie-breaker score. When `capacities` are provided, reads in
   * utilization space (load_p / cap_p) so a participant with 18h available
   * today doesn't compete 1:1 against a participant with 9h available today —
   * the algorithm prefers whoever has more headroom. When capacities are
   * missing, falls back to absolute hours (the historical formula).
   *
   * The 2.0 weight on the day axis is preserved across both code paths.
   *
   * Capacity is divided by the participant's `workloadMultiplier` so that
   * `mult > 1` shrinks effective capacity (looks more loaded → picked less)
   * and `mult < 1` grows it (picked more). Default 1.0 = unchanged.
   */
  const workloadScore = (pid: string): number => {
    const w = participantWorkload.get(pid) || 0;
    const day = dailyWorkload?.get(pid)?.get(taskDay) ?? 0;
    const cap = capacities?.get(pid);
    const mult = multByPid.get(pid) ?? 1;
    const divisor = mult > 0 ? mult : 1;
    const totalCap = (cap?.totalAvailableHours ?? 0) / divisor;
    const dayCap = (cap?.dailyAvailableHours.get(taskDay) ?? 0) / divisor;
    const periodPart = totalCap > 0 ? w / totalCap : w;
    const dayPart = dayCap > 0 ? day / dayCap : 0;
    return periodPart + 2.0 * dayPart;
  };

  eligible.sort((a, b) => {
    if (task.sameGroupRequired) {
      // T1: blended workload score — utilization-space when capacities exist,
      // absolute hours otherwise. Capacity-proportional fairness is also
      // applied in the SC-3/SC-8 scoring phase; matching shapes here reduces
      // the SA correction work needed to reach the proportional optimum.
      const scoreA = workloadScore(a.id);
      const scoreB = workloadScore(b.id);
      if (scoreA !== scoreB) return scoreA - scoreB;
      // T2: Same-group-required assignment count — prefer participants with fewer
      // same-group shifts so L3/L4 naturally alternate instead of one level hoarding.
      const sameGroupCountA = (assignmentsByParticipant.get(a.id) || []).filter(
        (asgn) => taskMap.get(asgn.taskId)?.sameGroupRequired,
      ).length;
      const sameGroupCountB = (assignmentsByParticipant.get(b.id) || []).filter(
        (asgn) => taskMap.get(asgn.taskId)?.sameGroupRequired,
      ).length;
      if (sameGroupCountA !== sameGroupCountB) return sameGroupCountA - sameGroupCountB;
      // T3: level ascending — when prior tiebreakers tied and the slot accepts
      // multiple levels (e.g. [L3, L4]), prefer the lower level.
      if (a.level !== b.level) return a.level - b.level;
      // T4: Task preference tiebreaker (gentle nudge)
      const prefA = computeGreedyPreferenceScore(a, task);
      const prefB = computeGreedyPreferenceScore(b, task);
      if (prefA !== prefB) return prefA - prefB;
      // T5: random tiebreak (pre-computed key)
      return (rngKey.get(a.id) || 0) - (rngKey.get(b.id) || 0);
    }

    // ── All non-same-group tasks ──
    // Low-priority level sort: prefer normal-priority participants over
    // lowPriority ones for this slot. lowPriority participants are last resort.
    {
      const aLow = slot.acceptableLevels.find((e) => e.level === a.level)?.lowPriority ? 1 : 0;
      const bLow = slot.acceptableLevels.find((e) => e.level === b.level)?.lowPriority ? 1 : 0;
      if (aLow !== bLow) return aLow - bLow;
    }

    // Primary fairness driver: blended workload score in utilization space
    // when capacities exist (otherwise absolute hours). Matches the
    // capacity-proportional target used by SC-3/SC-8 in the scoring phase.
    const scoreA = workloadScore(a.id);
    const scoreB = workloadScore(b.id);
    if (scoreA !== scoreB) return scoreA - scoreB;

    // Same-group task protection: prefer participants from groups with more
    // members eligible for same-group tasks (those groups can spare people).
    // Participants from tight groups are deprioritised to keep them available
    // for same-group shifts (e.g. Adanit).
    if (sameGroupEligibleCount) {
      const aCap = sameGroupEligibleCount.get(a.group) ?? 0;
      const bCap = sameGroupEligibleCount.get(b.group) ?? 0;
      if (aCap !== bCap) return bCap - aCap;
    }

    // Task preference tiebreaker (gentle nudge)
    const prefA = computeGreedyPreferenceScore(a, task);
    const prefB = computeGreedyPreferenceScore(b, task);
    if (prefA !== prefB) return prefA - prefB;

    // Random tiebreak (pre-computed key)
    return (rngKey.get(a.id) || 0) - (rngKey.get(b.id) || 0);
  });

  return eligible;
}

// ─── Scheduling Context ─────────────────────────────────────────────────────

/**
 * Pool-wide signals derived from (tasks, participants) that are invariant
 * across the attempts of a single `optimizeMultiAttempt*` run. Built once by
 * `buildSchedulingContext`, then passed to `computeStructuralPriority` so the
 * tier formula can reason about candidate-pool bottlenecks, cert rarity,
 * low-priority penalty risk, and other structural signals that were
 * previously opaque to the ordering phase.
 *
 * All fields are read-only after construction. Safe to share across nested
 * optimize() calls within the same multi-attempt run.
 */
export interface SchedulingContext {
  /** For each (taskId, slotId) → number of participants passing level ∩ cert ∩ ¬forbidden. */
  eligiblePerSlot: Map<string, Map<string, number>>;
  /** Per-task min across its slots — the bottleneck slot count. */
  minEligiblePerTask: Map<string, number>;
  /** certId → 1 − (participants holding cert / totalParticipants). Missing cert = 1. */
  certRarity: Map<string, number>;
  /** group → count of L2+ participants (seniors). */
  seniorCountByGroup: Map<string, number>;
  /** taskId → max(0, slotsWithLowPriority − nonLowPrioEligiblePool). */
  lowPrioRisk: Map<string, number>;
  /** taskId → computeTaskEffectiveHours(task) × slotCount. */
  effHoursByTask: Map<string, number>;
  /** Sum of totalAvailableHours across all participants in the schedule window. 0 if capacities unavailable. */
  totalCapacityHours: number;
  // ─── Phase 2 (D1+D3) — lowPriority-aware tightness signals ─────────────
  // Always populated. Consumed by `computeStructuralPriority` only when the
  // module-level `_useEnhancedRarity` flag is on (default off; flipped by
  // the priority bench's D1+D3 variant). When off, byte-identical behavior
  // to the pre-Phase-2 formula.
  /** For each (taskId, slotId) → count of participants whose level matches a
   *  NON-lowPriority entry of the slot (level-only filter, no cert). The
   *  denominator of `cleanPool / nonLowPrio` pool-fraction. */
  nonLowPrioLevelEligiblePerSlot: Map<string, Map<string, number>>;
  /** For each (taskId, slotId) → non-lowPrio-level-eligible ∩ required certs
   *  ∩ ¬forbidden. The numerator of pool-fraction; the "clean fill" pool the
   *  optimizer actually wants to draw from. */
  cleanPoolPerSlot: Map<string, Map<string, number>>;
  /** Per task: min cleanPool count across its slots (bottleneck). */
  minCleanPoolPerTask: Map<string, number>;
  /** Per task: min nonLowPrioLevelEligible count across its slots. */
  minNonLowPrioLevelEligiblePerTask: Map<string, number>;
  /** Per task: `1 − minCleanPool / max(1, minNonLowPrioLevelEligible)`,
   *  clamped to [0, 1]. Replaces global `certRarity` as the S2 input under
   *  D1: rarity is now measured against the pool the slot CAN draw from,
   *  not pool-wide. A universal-cert task on an L0-only slot has impact ≈ 0
   *  (no one excluded by the cert); a rare cert on a narrow level subset
   *  has impact close to 1. */
  effectiveCertImpactPerTask: Map<string, number>;
}

/**
 * Build a {@link SchedulingContext} from the task and participant inputs.
 *
 * Costs O(T × S × P) — negligible vs. a multi-attempt optimize loop which does
 * equivalent work inside the greedy phase via getRejectionReason.
 *
 * @param tasks          The tasks to be scheduled.
 * @param participants   The full participant pool.
 * @param capacities     Optional pre-computed capacities (for totalCapacityHours).
 *                       When omitted, totalCapacityHours is left at 0.
 */
export function buildSchedulingContext(
  tasks: Task[],
  participants: Participant[],
  capacities?: Map<string, { totalAvailableHours: number }>,
): SchedulingContext {
  const P = Math.max(1, participants.length);

  // Cert rarity: 1 − (holders / P) across the full pool.
  const certHolders = new Map<string, number>();
  for (const p of participants) {
    for (const c of p.certifications) {
      certHolders.set(c, (certHolders.get(c) || 0) + 1);
    }
  }
  const certRarity = new Map<string, number>();
  for (const [cert, count] of certHolders) {
    certRarity.set(cert, 1 - count / P);
  }

  // Per-group senior (L2+) count.
  const seniorCountByGroup = new Map<string, number>();
  for (const p of participants) {
    if (p.level !== Level.L0) {
      seniorCountByGroup.set(p.group, (seniorCountByGroup.get(p.group) || 0) + 1);
    }
  }

  // Per-task signals.
  const eligiblePerSlot = new Map<string, Map<string, number>>();
  const minEligiblePerTask = new Map<string, number>();
  const lowPrioRisk = new Map<string, number>();
  const effHoursByTask = new Map<string, number>();
  // Phase 2 fields
  const nonLowPrioLevelEligiblePerSlot = new Map<string, Map<string, number>>();
  const cleanPoolPerSlot = new Map<string, Map<string, number>>();
  const minCleanPoolPerTask = new Map<string, number>();
  const minNonLowPrioLevelEligiblePerTask = new Map<string, number>();
  const effectiveCertImpactPerTask = new Map<string, number>();

  for (const task of tasks) {
    const perSlot = new Map<string, number>();
    const perSlotNonLowPrio = new Map<string, number>();
    const perSlotClean = new Map<string, number>();
    let minEligible = Number.POSITIVE_INFINITY;
    let minNonLowPrio = Number.POSITIVE_INFINITY;
    let minClean = Number.POSITIVE_INFINITY;
    let lowPrioSlots = 0;
    const nonLowPrioPool = new Set<string>();

    for (const slot of task.slots) {
      let count = 0;
      let nonLowPrioCount = 0;
      let cleanCount = 0;
      const hasLowPrioEntry = slot.acceptableLevels.some((e) => e.lowPriority);
      if (hasLowPrioEntry) lowPrioSlots++;

      for (const p of participants) {
        const passesLevel = isLevelSatisfied(p.level, slot);
        const passesCert = !slot.requiredCertifications.some((c) => !p.certifications.includes(c));
        const passesForbidden = !hasForbiddenCertification(p, slot);

        if (passesLevel && passesCert && passesForbidden) count++;

        // Non-lowPriority level match: matches a NON-lowPriority entry of THIS slot.
        const nonLowPrioMatch = slot.acceptableLevels.some((e) => e.level === p.level && !e.lowPriority);
        if (nonLowPrioMatch) {
          nonLowPrioCount++;
          nonLowPrioPool.add(p.id);
          if (passesCert && passesForbidden) cleanCount++;
        }
      }
      perSlot.set(slot.slotId, count);
      perSlotNonLowPrio.set(slot.slotId, nonLowPrioCount);
      perSlotClean.set(slot.slotId, cleanCount);
      if (count < minEligible) minEligible = count;
      if (nonLowPrioCount < minNonLowPrio) minNonLowPrio = nonLowPrioCount;
      if (cleanCount < minClean) minClean = cleanCount;
    }

    eligiblePerSlot.set(task.id, perSlot);
    minEligiblePerTask.set(task.id, Number.isFinite(minEligible) ? minEligible : 0);
    lowPrioRisk.set(task.id, Math.max(0, lowPrioSlots - nonLowPrioPool.size));
    effHoursByTask.set(task.id, computeTaskEffectiveHours(task) * Math.max(1, task.slots.length));

    nonLowPrioLevelEligiblePerSlot.set(task.id, perSlotNonLowPrio);
    cleanPoolPerSlot.set(task.id, perSlotClean);
    const mnlp = Number.isFinite(minNonLowPrio) ? minNonLowPrio : 0;
    const mcp = Number.isFinite(minClean) ? minClean : 0;
    minNonLowPrioLevelEligiblePerTask.set(task.id, mnlp);
    minCleanPoolPerTask.set(task.id, mcp);
    // Effective cert impact: 1 − cleanPool / nonLowPrioLevelEligible at the
    // bottleneck. 0 means certs eliminate no one from the level-eligible
    // pool (universal-cert case); 1 means certs eliminate everyone. When
    // nonLowPrioLevelEligible is 0 the task is structurally infeasible —
    // preflight catches that; we return 0 here so ordering doesn't break.
    const impact = mnlp > 0 ? Math.max(0, Math.min(1, 1 - mcp / mnlp)) : 0;
    effectiveCertImpactPerTask.set(task.id, impact);
  }

  let totalCapacityHours = 0;
  if (capacities) {
    for (const cap of capacities.values()) totalCapacityHours += cap.totalAvailableHours;
  }

  return {
    eligiblePerSlot,
    minEligiblePerTask,
    certRarity,
    seniorCountByGroup,
    lowPrioRisk,
    effHoursByTask,
    totalCapacityHours,
    nonLowPrioLevelEligiblePerSlot,
    cleanPoolPerSlot,
    minCleanPoolPerTask,
    minNonLowPrioLevelEligiblePerTask,
    effectiveCertImpactPerTask,
  };
}

// ─── Greedy Phase ────────────────────────────────────────────────────────────

/**
 * Compute a scheduling priority using constraint-type tiers with optional
 * pool-signal refinements when a {@link SchedulingContext} is provided.
 *
 * Base tiers (returned when ctx is omitted — legacy callers):
 *   Tier 0: Same-group tasks (Adanit) — always first
 *   Tier 1: Has lowPriority levels + cert required — penalty-critical
 *   Tier 2: L0-only + cert required (Shemesh) — very tight pool
 *   Tier 3: Mixed levels + cert or exclusion (Karov, Mamtera, Karovit)
 *   Tier 4: L0-only unconstrained (Aruga) — wide pool
 *   Fallback: Tier 3.
 *
 * Signal refinements when ctx is provided (bounded to keep stability invariants):
 *   S2 cert rarity: if max over required certs has rarity > 0.7 → tier − 1.
 *   S3 stickiness: (dur≥10) + (dur≥14) + blocksConsecutive + restRuleId;
 *                  score ≥ 2 → tier − 1. Subsumes the standalone duration bump.
 *   S4 lowPrio risk: lowPrioRisk(t) > 0 → tier − 1.
 *   At most ONE of {S2, S3, S4} applies (first-match short-circuit) — signals
 *   may shift a task at most one tier so the random-tiebreak-within-tier
 *   stability property is preserved.
 *   S1 bottleneck sub-priority: minEligiblePerTask clamped to [0, 9] is
 *   added as the low-order digit (`tier*10 + subMin`). Sub-priority keeps
 *   jitter ±1 inside the tier.
 *
 * `task.schedulingPriority` (explicit override) is consulted by the caller
 * before falling back to this function — it is not read here.
 *
 * Within each tier, tasks are randomly ordered (no sub-priority tiebreaker).
 * Simulation (300 iter × 22 variants, Round 3) showed that removing a
 * sub-priority tiebreaker improves composite score by +6.4% (p=0.005) and
 * reduces mean penalty by -8.8%, because random tiebreaking gives the
 * jitter + multi-attempt mechanism more exploration room. We reintroduce a
 * sub-priority here only as the bottleneck signal and keep it bounded.
 */
export function computeStructuralPriority(task: Task, ctx?: SchedulingContext): number {
  if (task.sameGroupRequired) {
    // S5 senior pressure sub-priority (tier 0 only).
    // Higher pressure = needs more seniors per group = schedule earlier.
    // Mapped to sub ∈ [0, 9] where 0 is highest priority (earliest).
    if (!ctx) return 0;
    let seniorSlotCount = 0;
    for (const slot of task.slots) {
      if (slot.acceptableLevels.some((e) => e.level !== Level.L0)) seniorSlotCount++;
    }
    if (seniorSlotCount === 0) return 0; // No senior demand → highest-priority tier-0 slot (random tiebreak still applies)
    let minSeniorCount = Number.POSITIVE_INFINITY;
    for (const count of ctx.seniorCountByGroup.values()) {
      if (count < minSeniorCount) minSeniorCount = count;
    }
    if (!Number.isFinite(minSeniorCount) || minSeniorCount === 0) {
      // No seniors available anywhere — push to front (can't hurt; may still be unfillable).
      return 0;
    }
    const pressure = seniorSlotCount / minSeniorCount;
    // Invert so higher pressure yields lower priority value (earlier sort).
    const sub = Math.max(0, Math.min(9, 9 - Math.round(pressure * 3)));
    return sub;
  }

  const hasCerts = task.slots.some((s) => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(
    (s) => s.acceptableLevels.length === 1 && s.acceptableLevels[0].level === Level.L0,
  );
  const hasExclusion = task.slots.some((s) => (s.forbiddenCertifications?.length ?? 0) > 0);
  const hasLowPriority = task.slots.some((s) => s.acceptableLevels.some((e) => e.lowPriority));

  // D1 — vacuous-cert relief. When the enhanced-rarity flag is on AND
  // effective cert impact is below D1_LOW_IMPACT_THRESHOLD, the cert
  // constraints exist structurally but don't actually narrow the pool
  // (e.g. universal Nitzan). Treat hasCerts / hasExclusion as false for
  // the base tier classifier so the task isn't stuck in Tier 2. Under
  // the default (baseline) flag this is a no-op.
  let hasCertsForClassifier = hasCerts;
  let hasExclusionForClassifier = hasExclusion;
  if (_useEnhancedRarity && ctx) {
    const impact = ctx.effectiveCertImpactPerTask.get(task.id) ?? 0;
    if (impact < D1_LOW_IMPACT_THRESHOLD) {
      hasCertsForClassifier = false;
      hasExclusionForClassifier = false;
    }
  }

  let tier: number;
  if (hasLowPriority && hasCertsForClassifier)
    tier = 1; // Penalty-critical (e.g. Hamama)
  else if (allL0Only && hasCertsForClassifier)
    tier = 2; // Shemesh: tight L0+cert pool
  else if (hasCertsForClassifier || hasExclusionForClassifier)
    tier = 3; // Karov, Mamtera: moderate
  else if (allL0Only)
    tier = 4; // Aruga: wide L0 pool
  else tier = 3; // Fallback

  const durationHours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3_600_000;

  if (ctx) {
    // First-match tier shift (at most one of S2/S3/S4 applies). Guard
    // tier > 1 everywhere so signals never cascade past the lowPriority tier.
    if (tier > 1) {
      // S2 cert impact / rarity. Under baseline: pool-wide rarity > 0.7.
      // Under D1: effective cert impact (cleanPool / nonLowPrioLevelEligible
      // at the bottleneck slot) > D1_CERT_IMPACT_THRESHOLD.
      let s2Fires = false;
      if (_useEnhancedRarity) {
        const impact = ctx.effectiveCertImpactPerTask.get(task.id) ?? 0;
        s2Fires = impact > D1_CERT_IMPACT_THRESHOLD;
      } else {
        let maxRarity = 0;
        for (const slot of task.slots) {
          for (const c of slot.requiredCertifications) {
            const r = ctx.certRarity.get(c) ?? 1;
            if (r > maxRarity) maxRarity = r;
          }
        }
        s2Fires = maxRarity > 0.7;
      }
      if (s2Fires) {
        tier -= 1;
      } else {
        // S3 stickiness
        const stick =
          (durationHours >= 10 ? 1 : 0) +
          (durationHours >= 14 ? 1 : 0) +
          (task.blocksConsecutive ? 1 : 0) +
          (task.restRuleId ? 1 : 0);
        if (stick >= 2) {
          tier -= 1;
        } else if ((ctx.lowPrioRisk.get(task.id) ?? 0) > 0) {
          // S4 lowPrio penalty risk
          tier -= 1;
        }
      }
    }

    // S1 bottleneck sub-priority. Under baseline: clamp(minEligible, 0, 9)
    // — saturates at 9 for any pool ≥ 9. Under D3: log-scale on pool
    // fraction (cleanPool / nonLowPrioLevelEligible at the bottleneck);
    // tight pool (f → 0) → low subMin (early); wide pool (f → 1) → high
    // subMin (late). Maps f = 1 → 9, f = 0.5 → 8, f = 0.25 → 6, f = 0.125
    // → 5, f = 1/64 → 0. Note: the plan as written had this direction
    // inverted; the actual semantic (tight → early) matches the legacy
    // sort-ascending-by-priority convention.
    let subMin: number;
    if (_useEnhancedRarity) {
      const clean = ctx.minCleanPoolPerTask.get(task.id) ?? 0;
      const nonLow = ctx.minNonLowPrioLevelEligiblePerTask.get(task.id) ?? 0;
      const denom = Math.max(1, nonLow);
      const fRaw = clean / denom;
      const fSafe = Math.max(fRaw, 1 / 64);
      subMin = Math.max(0, Math.min(9, Math.round(Math.log2(fSafe) * 1.5 + 9)));
    } else {
      const minEligible = ctx.minEligiblePerTask.get(task.id) ?? 9;
      subMin = Math.max(0, Math.min(9, minEligible));
    }
    return tier * 10 + subMin;
  }

  // Legacy no-ctx path: preserve the previous duration-only bump for callers
  // (tests, the elite-boost fallback when ctx is not threaded) so behavior is
  // unchanged for them.
  if (tier > 1 && durationHours >= 12) tier -= 1;
  return tier * 10;
}

/**
 * Sort tasks for assignment order. Most-constrained tasks first.
 * Uses explicit schedulingPriority if set on the task, otherwise computes
 * priority from constraint tiers via {@link computeStructuralPriority}.
 *
 * Exported so the priority bench's anchor fixtures
 * ([src/bench-priority/anchors](../bench-priority/anchors)) can observe
 * ordering directly without running the full optimizer pipeline.
 */
export function sortTasksByDifficulty(tasks: Task[], jitter: number = 0, ctx?: SchedulingContext): Task[] {
  // P3: Pre-compute random keys for transitive tiebreaker
  const taskRngKey = new Map<string, number>();
  for (const t of tasks) taskRngKey.set(t.id, Math.random());

  const basePriority = new Map<string, number>();
  for (const t of tasks) {
    basePriority.set(t.id, t.schedulingPriority ?? computeStructuralPriority(t, ctx));
  }

  // Task-order jitter: with probability `jitter`, apply a random ±1
  // perturbation to each task's base priority.
  // Priority-0 tasks are never perturbed — structurally critical to schedule first.
  const maxBase = Math.max(...[...basePriority.values()]);
  const jitteredPriority = new Map<string, number>();
  for (const t of tasks) {
    const base = basePriority.get(t.id)!;
    if (jitter > 0 && base > 0 && Math.random() < jitter) {
      const delta = Math.random() < 0.5 ? -1 : 1;
      jitteredPriority.set(t.id, Math.max(1, Math.min(maxBase, base + delta)));
    } else {
      jitteredPriority.set(t.id, base);
    }
  }

  return [...tasks].sort((a, b) => {
    const pa = jitteredPriority.get(a.id) ?? 99;
    const pb = jitteredPriority.get(b.id) ?? 99;
    if (pa !== pb) return pa - pb;
    const ta = a.timeBlock.start.getTime();
    const tb = b.timeBlock.start.getTime();
    if (ta !== tb) return ta - tb;
    // Random tiebreak within same priority+time tier for multi-attempt diversity
    return (taskRngKey.get(a.id) || 0) - (taskRngKey.get(b.id) || 0);
  });
}

/**
 * Greedy construction: assign participants to all task slots.
 * Returns assignments (may be partial if infeasible).
 */
export function greedyAssign(
  tasks: Task[],
  participants: Participant[],
  pinnedAssignments: Assignment[] = [],
  disabledHC?: Set<string>,
  taskOrderJitter: number = 0,
  phantomContext?: PhantomContext,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  ctx?: SchedulingContext,
  scheduleContext?: ScheduleContext,
  certLabelResolver?: (certId: string) => string,
  /** Per-participant capacities. When provided, the greedy comparator reads
   *  in utilization space so partial-availability participants aren't
   *  preferred over participants with more headroom. Pre-computed by the
   *  caller (`optimize` / `localSearchOptimize`) so all phases share one map. */
  capacities?: Map<string, ParticipantCapacity>,
): {
  assignments: Assignment[];
  unfilledSlots: UnfilledSlot[];
  pinnedIds: Set<string>;
  /** The task list greedy operated on. Same reference as the `tasks` arg
   *  unless a feasibility split replaced an occurrence with two halves
   *  (Stage 4). Callers thread THIS into SA/scoring/validation/result so the
   *  whole pipeline agrees on the realized task set. */
  tasks: Task[];
} {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Seed phantom tasks into taskMap so constraint checks can resolve them
  if (phantomContext) {
    for (const pt of phantomContext.phantomTasks) taskMap.set(pt.id, pt);
  }

  const pinnedIds = new Set(pinnedAssignments.map((a) => a.id));
  const assignments: Assignment[] = [...pinnedAssignments];
  const unfilledSlots: UnfilledSlot[] = [];

  // P4: Pre-build per-participant assignment index for O(1) lookups
  const assignmentsByParticipant = buildAssignmentMap(pinnedAssignments);

  // Seed phantom assignments into per-participant index for cross-schedule
  // constraint enforcement (HC-5, HC-12, HC-14). NOT added to assignments[]
  // or workload maps — phantoms affect only eligibility, not scoring/output.
  if (phantomContext) {
    for (const pa of phantomContext.phantomAssignments) addToAssignmentMap(assignmentsByParticipant, pa);
  }

  // Track workload
  const workload = new Map<string, number>();
  // Track per-day workload: participantId → (operationalDateKey → effectiveHours)
  const dailyWorkload = new Map<string, Map<string, number>>();
  for (const p of participants) {
    workload.set(p.id, 0);
    dailyWorkload.set(p.id, new Map());
  }
  for (const a of pinnedAssignments) {
    const task = taskMap.get(a.taskId);
    if (task) {
      // Zero-load tasks contribute 0 via computeTaskEffectiveHours — invisible to fairness.
      const eff = computeTaskEffectiveHours(task);
      workload.set(a.participantId, (workload.get(a.participantId) || 0) + eff);
      const dk = operationalDateKey(task.timeBlock.start, dayStartHour);
      let pDaily = dailyWorkload.get(a.participantId);
      if (!pDaily) {
        pDaily = new Map();
        dailyWorkload.set(a.participantId, pDaily);
      }
      pDaily.set(dk, (pDaily.get(dk) || 0) + eff);
    }
  }

  // ITEM 10: Pre-compute per-group count of members eligible for same-group
  // tasks. When multiple same-group tasks exist with different cert requirements,
  // we compute eligibility per unique cert set and take the minimum per group
  // (the tightest bottleneck). Used as a tie-breaker to protect tight groups.
  const sameGroupTasks = tasks.filter((t) => t.sameGroupRequired);
  let sameGroupEligibleCount: Map<string, number> | undefined;
  if (sameGroupTasks.length > 0) {
    // Collect unique cert requirement sets across all same-group tasks
    const uniqueCertSets: string[][] = [];
    for (const t of sameGroupTasks) {
      const certSet = new Set<string>();
      for (const s of t.slots) {
        for (const c of s.requiredCertifications) certSet.add(c);
      }
      const sorted = [...certSet].sort();
      if (!uniqueCertSets.some((ex) => ex.length === sorted.length && ex.every((c, i) => c === sorted[i]))) {
        uniqueCertSets.push(sorted);
      }
    }

    // For each unique cert set, compute per-group eligible count
    const perSetCounts: Map<string, number>[] = [];
    for (const certs of uniqueCertSets) {
      const groupCount = new Map<string, number>();
      for (const p of participants) {
        if (certs.every((c) => p.certifications.includes(c))) {
          groupCount.set(p.group, (groupCount.get(p.group) || 0) + 1);
        }
      }
      perSetCounts.push(groupCount);
    }

    // Single cert set (current production case): use directly. Multiple: take min.
    if (perSetCounts.length === 1) {
      sameGroupEligibleCount = perSetCounts[0];
    } else {
      sameGroupEligibleCount = new Map<string, number>();
      const allGroups = new Set<string>(participants.map((p) => p.group));
      for (const g of allGroups) {
        sameGroupEligibleCount.set(g, Math.min(...perSetCounts.map((m) => m.get(g) ?? 0)));
      }
    }
  }

  const sortedTasks = sortTasksByDifficulty(tasks, taskOrderJitter, ctx);

  for (const task of sortedTasks) {
    // For same-group tasks (Adanit), we need special handling
    if (task.sameGroupRequired) {
      const assigned = assignSameGroupTask(
        task,
        participants,
        assignments,
        taskMap,
        workload,
        assignmentsByParticipant,
        dailyWorkload,
        disabledHC,
        restRuleMap,
        dayStartHour,
        scheduleContext,
        capacities,
      );
      if (!assigned) {
        // Mark all slots as unfilled with specific reasons
        for (const slot of task.slots) {
          const alreadyFilled = assignments.some((a) => a.taskId === task.id && a.slotId === slot.slotId);
          if (!alreadyFilled) {
            const levelStr = slot.acceptableLevels.map((e) => 'L' + e.level).join('/');
            const certStr =
              slot.requiredCertifications.length > 0
                ? ` + ${slot.requiredCertifications.map((c) => certLabelResolver?.(c) ?? c).join(', ')}`
                : '';
            const reason = `אף קבוצה לא יכולה למלא את כל העמדות. חסר ${levelStr}${certStr}`;
            unfilledSlots.push({ taskId: task.id, slotId: slot.slotId, reason, hcCodes: ['HC-4'] });
          }
        }
      }
      continue;
    }

    // Standard slot-by-slot assignment — fill most-constrained slots first
    const orderedSlots = _benchActiveRandomSlots
      ? shuffle([...task.slots])
      : [...task.slots].sort(
          (a, b) =>
            Math.min(...b.acceptableLevels.map((e) => e.level)) - Math.min(...a.acceptableLevels.map((e) => e.level)),
        );
    for (const slot of orderedSlots) {
      // Skip if already assigned (pinned)
      const existing = assignments.find((a) => a.taskId === task.id && a.slotId === slot.slotId);
      if (existing) continue;

      const candidates = getEligibleCandidates(
        task,
        slot,
        participants,
        assignmentsByParticipant,
        taskMap,
        workload,
        dailyWorkload,
        disabledHC,
        sameGroupEligibleCount,
        restRuleMap,
        dayStartHour,
        scheduleContext,
        capacities,
      );

      if (candidates.length > 0) {
        const chosen = candidates[0];
        const newAssignment: Assignment = {
          id: nextAssignmentId(),
          taskId: task.id,
          slotId: slot.slotId,
          participantId: chosen.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        assignments.push(newAssignment);
        addToAssignmentMap(assignmentsByParticipant, newAssignment);
        const eff = computeTaskEffectiveHours(task);
        workload.set(chosen.id, (workload.get(chosen.id) || 0) + eff);
        const dk = operationalDateKey(task.timeBlock.start, dayStartHour);
        let pDaily = dailyWorkload.get(chosen.id);
        if (!pDaily) {
          pDaily = new Map();
          dailyWorkload.set(chosen.id, pDaily);
        }
        pDaily.set(dk, (pDaily.get(dk) || 0) + eff);
      } else {
        // ── Backtracking: try depth-1 swap chains to free a participant ──
        // Find participants who pass level/cert/availability but are blocked by
        // a current assignment. The "blocker" is identified by simulation:
        // any of p's existing assignments whose removal makes p eligible for
        // the target slot is a candidate. This is HC-agnostic and covers
        // every assignment-induced rejection — HC-5 (overlap), HC-12 (back-to-back
        // blocking), HC-14 (rest-rule gap), HC-15 (sleep recovery). Earlier
        // versions only considered time-overlapping assignments (HC-5), which
        // missed adjacent / near-adjacent blockers that depth-1 can repair.
        let backtrackSuccess = false;
        let swapPlan: {
          p: Participant;
          blockingAssign: Assignment;
          blockingTask: Task;
          replacement: Participant;
        } | null = null;

        for (const p of participants) {
          // Quick filter: skip if participant can't possibly fill this slot.
          // Each check is gated by disabledHC so a globally-relaxed HC doesn't
          // get silently re-imposed here — must stay aligned with the
          // authoritative isEligible() in validator.ts and the SA swap gate.
          if (!disabledHC?.has('HC-1') && !isLevelSatisfied(p.level, slot)) continue;
          if (!disabledHC?.has('HC-2') && slot.requiredCertifications.some((c) => !p.certifications.includes(c)))
            continue;
          if (!disabledHC?.has('HC-3') && !isFullyCovered(task.timeBlock, p.availability)) continue;
          if (!disabledHC?.has('HC-11') && hasForbiddenCertification(p, slot)) continue;

          // Already eligible (shouldn't happen since candidates was empty, but guard)
          const pAssigns = assignmentsByParticipant.get(p.id) || [];
          if (isEligibleForSlot(p, task, slot, pAssigns, taskMap, disabledHC, restRuleMap, scheduleContext)) continue;

          // Find which of p's current assignments blocks them from this slot.
          // The simulation `pAssigns - {blockingAssign}` re-checked against
          // isEligibleForSlot is the authoritative test; any assignment whose
          // removal flips eligibility is a valid blocker, regardless of HC.
          const pAssignsCopy = [...pAssigns];
          for (const blockingAssign of pAssignsCopy) {
            if (
              pinnedIds.has(blockingAssign.id) ||
              blockingAssign.status === AssignmentStatus.Manual ||
              blockingAssign.status === AssignmentStatus.Frozen
            )
              continue;

            const blockingTask = taskMap.get(blockingAssign.taskId);
            if (!blockingTask) continue;
            // Don't steal from same-group tasks (Adanit) — would cascade group integrity
            if (blockingTask.sameGroupRequired) continue;

            const blockingSlot = blockingTask.slots.find((s) => s.slotId === blockingAssign.slotId);
            if (!blockingSlot) continue;

            // Blocker gate: would removing this assignment unblock p? Computed
            // once per blocker (independent of replacement choice).
            const pAssignsWithout = pAssigns.filter((a) => a.id !== blockingAssign.id);
            if (!isEligibleForSlot(p, task, slot, pAssignsWithout, taskMap, disabledHC, restRuleMap, scheduleContext))
              continue;

            // Try to find a replacement for the blocking assignment
            for (const replacement of participants) {
              if (replacement.id === p.id) continue;
              // Replacement must not already be assigned to the task being stolen from (HC-7)
              const rAssigns = assignmentsByParticipant.get(replacement.id) || [];
              if (rAssigns.some((a) => a.taskId === blockingAssign.taskId)) continue;
              if (
                !isEligibleForSlot(
                  replacement,
                  blockingTask,
                  blockingSlot,
                  rAssigns,
                  taskMap,
                  disabledHC,
                  restRuleMap,
                  scheduleContext,
                )
              )
                continue;

              swapPlan = { p, blockingAssign, blockingTask, replacement };
              break;
            }
            if (swapPlan) break;
          }
          if (swapPlan) break;
        }

        if (swapPlan) {
          const { p, blockingAssign, blockingTask, replacement } = swapPlan;
          // ── Execute backtrack swap ──
          // 1. Remove blocking assignment from p
          const blockIdx = assignments.indexOf(blockingAssign);
          if (blockIdx !== -1) {
            assignments.splice(blockIdx, 1);
            const pList = assignmentsByParticipant.get(p.id);
            if (pList) {
              const pi = pList.indexOf(blockingAssign);
              if (pi !== -1) pList.splice(pi, 1);
            }
            // Update workload for p (remove blocking task load)
            const blockEff = computeTaskEffectiveHours(blockingTask);
            workload.set(p.id, (workload.get(p.id) || 0) - blockEff);
            const blockDk = operationalDateKey(blockingTask.timeBlock.start, dayStartHour);
            const pDailyMap = dailyWorkload.get(p.id);
            if (pDailyMap) pDailyMap.set(blockDk, (pDailyMap.get(blockDk) || 0) - blockEff);

            // 2. Assign replacement to the blocking slot
            const replacementAssign: Assignment = {
              id: nextAssignmentId(),
              taskId: blockingAssign.taskId,
              slotId: blockingAssign.slotId,
              participantId: replacement.id,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            assignments.push(replacementAssign);
            addToAssignmentMap(assignmentsByParticipant, replacementAssign);
            workload.set(replacement.id, (workload.get(replacement.id) || 0) + blockEff);
            let rDaily = dailyWorkload.get(replacement.id);
            if (!rDaily) {
              rDaily = new Map();
              dailyWorkload.set(replacement.id, rDaily);
            }
            rDaily.set(blockDk, (rDaily.get(blockDk) || 0) + blockEff);

            // 3. Assign p to the target slot
            const targetAssign: Assignment = {
              id: nextAssignmentId(),
              taskId: task.id,
              slotId: slot.slotId,
              participantId: p.id,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            assignments.push(targetAssign);
            addToAssignmentMap(assignmentsByParticipant, targetAssign);
            const targetEff = computeTaskEffectiveHours(task);
            workload.set(p.id, (workload.get(p.id) || 0) + targetEff);
            const targetDk = operationalDateKey(task.timeBlock.start, dayStartHour);
            let pDailyTarget = dailyWorkload.get(p.id);
            if (!pDailyTarget) {
              pDailyTarget = new Map();
              dailyWorkload.set(p.id, pDailyTarget);
            }
            pDailyTarget.set(targetDk, (pDailyTarget.get(targetDk) || 0) + targetEff);

            backtrackSuccess = true;
          }
        }

        if (!backtrackSuccess) {
          // R8: Build specific reason with constraint codes for diagnostics
          const levelStr = slot.acceptableLevels.map((e) => 'L' + e.level).join('/');
          const certStr =
            slot.requiredCertifications.length > 0
              ? ` + ${slot.requiredCertifications.map((c) => certLabelResolver?.(c) ?? c).join(', ')}`
              : '';
          const profile = `${levelStr}${certStr}`;

          // Collect per-participant rejection codes to surface constraint conflicts
          const rejectionCounts = new Map<string, number>();
          for (const p of participants) {
            const pAssigns = assignmentsByParticipant.get(p.id) || [];
            const code = getRejectionReason(p, task, slot, pAssigns, taskMap, { disabledHC, restRuleMap });
            if (code) {
              rejectionCounts.set(code, (rejectionCounts.get(code) || 0) + 1);
            }
          }

          let reason: string;
          const hcCodes: string[] = [];
          const hc12Count = rejectionCounts.get('HC-12') || 0;
          const hc14Count = rejectionCounts.get('HC-14') || 0;
          if (hc14Count > 0 && hc12Count > 0) {
            reason = `התנגשות אילוצים (${profile}): ${hc14Count} חסומים ע"י HC-14 (מרווח מינימלי), ${hc12Count} ע"י HC-12 (עומס רצוף)`;
            hcCodes.push('HC-14', 'HC-12');
          } else if (hc14Count > 0) {
            reason = `חסימת HC-14 (מרווח מינימלי): כל מועמדי ${profile} משובצים למשימות קרובות עם דרישת מרווח`;
            hcCodes.push('HC-14');
          } else if (hc12Count > 0) {
            reason = `חסימת HC-12 (עומס רצוף): כל מועמדי ${profile} משובצים למשימות כבדות סמוכות`;
            hcCodes.push('HC-12');
          } else {
            reason = `חסר ${profile}`;
            // Include any HC codes that appeared in rejections (e.g. HC-1 level, HC-2 cert)
            for (const code of rejectionCounts.keys()) hcCodes.push(code);
          }
          unfilledSlots.push({ taskId: task.id, slotId: slot.slotId, reason, hcCodes });
        }
      }
    }
  }

  // ─── Greedy summary log (gated by diagnostic flag) ──────────────
  if (isSchedulerDiagOn()) {
    const totalSlots = tasks.reduce((n, t) => n + t.slots.length, 0);
    const filledCount = assignments.length - pinnedAssignments.length;
    const usedIds = new Set(assignments.map((a) => a.participantId));
    const idleCount = participants.length - usedIds.size;
    console.log(
      `[Scheduler] Greedy done: ${filledCount}/${totalSlots} slots filled, ` +
        `${unfilledSlots.length} unfilled, ${idleCount}/${participants.length} participants idle`,
    );
    if (unfilledSlots.length > 0) {
      const byTask = new Map<string, number>();
      for (const u of unfilledSlots) {
        const t = taskMap.get(u.taskId);
        const key = t ? t.name : u.taskId;
        byTask.set(key, (byTask.get(key) || 0) + 1);
      }
      for (const [tName, count] of byTask) {
        console.warn(`  ↳ ${tName}: ${count} unfilled slot(s)`);
      }
    }
  }

  // Stage 4 — feasibility split: for any splittable occurrence that ended up
  // with an unfilled slot, try realizing it as two equal halves worked by two
  // DIFFERENT participants. Pure post-pass: byte-identical to today when
  // splitting is off / nothing splittable was left unfilled.
  const effTasks = applyFeasibilitySplits({
    tasks,
    taskMap,
    participants,
    assignments,
    assignmentsByParticipant,
    workload,
    dailyWorkload,
    unfilledSlots,
    disabledHC,
    restRuleMap,
    dayStartHour,
    scheduleContext,
    capacities,
    sameGroupEligibleCount,
  });

  return { assignments, unfilledSlots, pinnedIds, tasks: effTasks };
}

/** Context for the post-greedy feasibility-split pass. */
export interface FeasibilitySplitCtx {
  tasks: Task[];
  taskMap: Map<string, Task>;
  participants: Participant[];
  assignments: Assignment[];
  assignmentsByParticipant: Map<string, Assignment[]>;
  workload: Map<string, number>;
  dailyWorkload: Map<string, Map<string, number>>;
  unfilledSlots: UnfilledSlot[];
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  dayStartHour: number;
  scheduleContext?: ScheduleContext;
  capacities?: Map<string, ParticipantCapacity>;
  sameGroupEligibleCount?: Map<string, number>;
}

/**
 * Build one half (`#a` first, `#b` second) of a single split SLOT of an
 * occurrence. Splitting is slot-level: each call carries exactly ONE slot
 * (deep-copied with a per-half-unique slotId suffix), so an occurrence can
 * keep some slots whole while splitting others independently. All behavior
 * fields (incl. sleepRecovery + shiftIndex per D17) are inherited so each
 * half independently triggers HC-15 from its own end. `sectionKey` is the
 * parent's so the grid/exports render one section. `splitGroupId` keys the
 * split-SLOT pair (`${taskId}::${slotId}`) so HC-16 enforces two-different-
 * people per split slot; `splitOccurrenceId` ties every half of the same
 * occurrence together for HC-15's same-occurrence exemption;
 * `splitOriginalMs` = the pre-split occurrence span (K for the run-coalescer).
 * A `sameGroupRequired` parent also stamps `sameGroupLinkId` so HC-8 treats
 * the residual + all halves as one same-group unit.
 */
export function makeSplitHalf(T: Task, part: 1 | 2, startMs: number, endMs: number, slot: SlotRequirement): Task {
  const suffix = part === 1 ? '#a' : '#b';
  const splitGroupId = `${T.id}::${slot.slotId}`;
  return {
    ...T,
    id: `${splitGroupId}${suffix}`,
    name: `${T.name} (${part}/2)`,
    timeBlock: { start: new Date(startMs), end: new Date(endMs) },
    slots: [{ ...slot, slotId: `${slot.slotId}${suffix}` }],
    requiredCount: 1,
    sleepRecovery: T.sleepRecovery
      ? { ...T.sleepRecovery, triggerShifts: [...T.sleepRecovery.triggerShifts] }
      : undefined,
    splitGroupId,
    splitPart: part,
    splitOriginalMs: T.timeBlock.end.getTime() - T.timeBlock.start.getTime(),
    splitOccurrenceId: T.id,
    sameGroupLinkId: T.sameGroupRequired ? T.id : undefined,
  };
}

export function applyFeasibilitySplits(ctx: FeasibilitySplitCtx): Task[] {
  const {
    tasks,
    taskMap,
    participants,
    assignments,
    assignmentsByParticipant,
    workload,
    dailyWorkload,
    unfilledSlots,
    disabledHC,
    restRuleMap,
    dayStartHour,
    scheduleContext,
    capacities,
    sameGroupEligibleCount,
  } = ctx;

  // Per-occurrence set of slotIds greedy left unfilled (slot-level: a slot is
  // split independently, others of the same occurrence may stay whole).
  const unfilledByTask = new Map<string, Set<string>>();
  for (const u of unfilledSlots) {
    let s = unfilledByTask.get(u.taskId);
    if (!s) {
      s = new Set();
      unfilledByTask.set(u.taskId, s);
    }
    s.add(u.slotId);
  }
  if (unfilledByTask.size === 0) return tasks;

  let working: Task[] | null = null; // lazily cloned only if a split commits

  const effHours = (t: Task) => computeTaskEffectiveHours(t);
  const removeAssignment = (a: Assignment): void => {
    const idx = assignments.indexOf(a);
    if (idx !== -1) assignments.splice(idx, 1);
    const list = assignmentsByParticipant.get(a.participantId);
    if (list) {
      const li = list.indexOf(a);
      if (li !== -1) list.splice(li, 1);
    }
  };
  const addLoad = (pid: string, t: Task): void => {
    const e = effHours(t);
    workload.set(pid, (workload.get(pid) || 0) + e);
    // Bucket a split `#b` (whose timeBlock.start is the occurrence midpoint)
    // to its occurrence op-day so these greedy load maps agree with the
    // taskOpDayStart-based SC-8 scorer. Non-split / `#a` / residual unchanged.
    const dk = operationalDateKey(taskOpDayStart(t), dayStartHour);
    let pd = dailyWorkload.get(pid);
    if (!pd) {
      pd = new Map();
      dailyWorkload.set(pid, pd);
    }
    pd.set(dk, (pd.get(dk) || 0) + e);
  };
  const subLoad = (pid: string, t: Task): void => {
    const e = effHours(t);
    workload.set(pid, (workload.get(pid) || 0) - e);
    const dk = operationalDateKey(taskOpDayStart(t), dayStartHour);
    const pd = dailyWorkload.get(pid);
    if (pd) pd.set(dk, (pd.get(dk) || 0) - e);
  };
  const clearUnfilled = (taskId: string, slotId: string): void => {
    for (let i = unfilledSlots.length - 1; i >= 0; i--) {
      if (unfilledSlots[i].taskId === taskId && unfilledSlots[i].slotId === slotId) {
        unfilledSlots.splice(i, 1);
      }
    }
  };
  const groupOf = new Map<string, string>();
  for (const p of participants) groupOf.set(p.id, p.group);
  const eligIds = (task: Task, slot: SlotRequirement, pool: Participant[]): Participant[] =>
    getEligibleCandidates(
      task,
      slot,
      pool,
      assignmentsByParticipant,
      taskMap,
      workload,
      dailyWorkload,
      disabledHC,
      sameGroupEligibleCount,
      restRuleMap,
      dayStartHour,
      scheduleContext,
      capacities,
    );

  /**
   * Strict same-group split. `assignSameGroupTask` is all-or-nothing, so an
   * unfilled `sameGroupRequired` occurrence has only pinned assignments (if
   * any). Pick a single group that can cover the whole occurrence with the
   * fewest split slots (whole-first parsimony via two `findMaxMatching`
   * passes), then realize residual + per-split-slot halves all tagged with a
   * shared `sameGroupLinkId`. Returns the `working`-list replacements, or
   * null when no group can realize it (occurrence left unfilled — today's
   * behavior).
   */
  const splitSameGroup = (
    T: Task,
    unfilledIds: Set<string>,
    startMs: number,
    midMs: number,
    endMs: number,
  ): Task[] | null => {
    const existing = assignments.filter((a) => a.taskId === T.id);
    const pinnedSlotIds = new Set(existing.map((a) => a.slotId));
    const usedIds = new Set(existing.map((a) => a.participantId));
    let requiredGroup: string | undefined;
    {
      const gs = new Set<string>();
      for (const a of existing) {
        const g = groupOf.get(a.participantId);
        if (g) gs.add(g);
      }
      if (gs.size === 1) requiredGroup = [...gs][0];
    }

    const slotsToFill = T.slots.filter((s) => !pinnedSlotIds.has(s.slotId) && unfilledIds.has(s.slotId));
    if (slotsToFill.length === 0) return null;

    const groupMembers = new Map<string, Participant[]>();
    for (const p of participants) {
      const l = groupMembers.get(p.group);
      if (l) l.push(p);
      else groupMembers.set(p.group, [p]);
    }
    const allGroups = [...groupMembers.keys()];
    const groupsToTry = requiredGroup ? [requiredGroup] : allGroups;
    // Fairness ordering: lightest-loaded group first (mirrors
    // assignSameGroupTask); random tiebreak for multi-attempt diversity.
    const grng = new Map<string, number>();
    for (const g of groupsToTry) grng.set(g, Math.random());
    groupsToTry.sort((ga, gb) => {
      const wa = (groupMembers.get(ga) || []).reduce((s, p) => s + (workload.get(p.id) || 0), 0);
      const wb = (groupMembers.get(gb) || []).reduce((s, p) => s + (workload.get(p.id) || 0), 0);
      if (wa !== wb) return wa - wb;
      return (grng.get(ga) || 0) - (grng.get(gb) || 0);
    });

    const candIds = (task: Task, slot: SlotRequirement, members: Participant[]): string[] =>
      eligIds(task, slot, members)
        .map((p) => p.id)
        .filter((id) => !usedIds.has(id));

    for (const group of groupsToTry) {
      const members = groupMembers.get(group) || [];
      if (members.length === 0) continue;

      // Tier 1: maximum WHOLE coverage by this group → split only the rest.
      const m1 = findMaxMatching(slotsToFill.map((s) => ({ slotId: s.slotId, candidates: candIds(T, s, members) })));
      const splitSet = new Set(m1.unfilled);
      // Group covers everything whole ⇒ not a split case (and unreachable:
      // assignSameGroupTask would already have committed it). Try next group.
      if (splitSet.size === 0) continue;

      const halves = new Map<string, { Sa: Task; Sb: Task }>();
      for (const s of slotsToFill) {
        if (splitSet.has(s.slotId)) {
          halves.set(s.slotId, {
            Sa: makeSplitHalf(T, 1, startMs, midMs, s),
            Sb: makeSplitHalf(T, 2, midMs, endMs, s),
          });
        }
      }
      // Tier 2: re-match the full expanded set (whole + #a/#b sub-slots).
      const expanded: SlotCandidates[] = [];
      for (const s of slotsToFill) {
        const hv = halves.get(s.slotId);
        if (hv) {
          expanded.push({ slotId: `${s.slotId}#a`, candidates: candIds(hv.Sa, hv.Sa.slots[0], members) });
          expanded.push({ slotId: `${s.slotId}#b`, candidates: candIds(hv.Sb, hv.Sb.slots[0], members) });
        } else {
          expanded.push({ slotId: s.slotId, candidates: candIds(T, s, members) });
        }
      }
      const m2 = findMaxMatching(expanded);
      if (m2.unfilled.length > 0) continue; // this group can't realize it

      // ── Realize with `group` ──
      const survivingSlots = T.slots.filter((s) => !splitSet.has(s.slotId));
      const replacements: Task[] = [];
      if (survivingSlots.length > 0) {
        const Tr: Task = {
          ...T,
          slots: survivingSlots,
          requiredCount: survivingSlots.length,
          sameGroupLinkId: T.id,
        };
        taskMap.set(T.id, Tr);
        replacements.push(Tr);
      } else {
        taskMap.delete(T.id);
      }
      for (const s of slotsToFill) {
        const hv = halves.get(s.slotId);
        if (hv) {
          taskMap.set(hv.Sa.id, hv.Sa);
          taskMap.set(hv.Sb.id, hv.Sb);
          for (const [half, key] of [
            [hv.Sa, `${s.slotId}#a`],
            [hv.Sb, `${s.slotId}#b`],
          ] as const) {
            const pid = m2.assignments.get(key);
            if (!pid) continue;
            const hSlot = half.slots[0];
            const na: Assignment = {
              id: nextAssignmentId(),
              taskId: half.id,
              slotId: hSlot.slotId,
              participantId: pid,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            assignments.push(na);
            addToAssignmentMap(assignmentsByParticipant, na);
            addLoad(pid, half);
          }
          replacements.push(hv.Sa, hv.Sb);
        } else {
          const pid = m2.assignments.get(s.slotId);
          if (pid) {
            const na: Assignment = {
              id: nextAssignmentId(),
              taskId: T.id, // stays on the residual (Tr.id === T.id)
              slotId: s.slotId,
              participantId: pid,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            assignments.push(na);
            addToAssignmentMap(assignmentsByParticipant, na);
            addLoad(pid, T); // full occurrence span ⇒ full load
          }
        }
        clearUnfilled(T.id, s.slotId);
      }
      return replacements;
    }
    return null; // no group could realize the split
  };

  for (const [taskId, unfilledIds] of unfilledByTask) {
    const T = taskMap.get(taskId);
    if (!T || !T.splittable || T.splitGroupId) continue;
    const startMs = T.timeBlock.start.getTime();
    const endMs = T.timeBlock.end.getTime();
    const midMs = startMs + Math.floor((endMs - startMs) / 2);
    if (midMs <= startMs || midMs >= endMs) continue; // too short to halve

    if (T.sameGroupRequired) {
      const replacements = splitSameGroup(T, unfilledIds, startMs, midMs, endMs);
      if (replacements) {
        working = working ?? [...tasks];
        const wi = working.findIndex((t) => t.id === T.id);
        if (wi !== -1) working.splice(wi, 1, ...replacements);
      }
      continue;
    }

    // ── Non-same-group: split each unfilled slot independently. Filled slots
    // (and unfilled slots whose split fails) stay whole on the residual Tr. ──
    const committedHalves: Task[] = [];
    const splitSlotIds = new Set<string>();
    for (const slot of T.slots) {
      if (!unfilledIds.has(slot.slotId)) continue; // filled / not flagged ⇒ stays whole
      const Sa = makeSplitHalf(T, 1, startMs, midMs, slot);
      const Sb = makeSplitHalf(T, 2, midMs, endMs, slot);
      taskMap.set(Sa.id, Sa);
      taskMap.set(Sb.id, Sb);

      const slotAssigns: Assignment[] = [];
      const aHolders = new Set<string>();
      let ok = true;
      for (const half of [Sa, Sb] as const) {
        const hSlot = half.slots[0];
        const cands = eligIds(half, hSlot, participants);
        // Two-different-people per split slot (HC-16). Belt-and-suspenders:
        // the per-placement HC-16 gate already filters the #a holder out of
        // #b's candidates whenever HC-16 is active.
        const chosen = half === Sb ? cands.find((c) => !aHolders.has(c.id)) : cands[0];
        if (!chosen) {
          ok = false;
          break;
        }
        const na: Assignment = {
          id: nextAssignmentId(),
          taskId: half.id,
          slotId: hSlot.slotId,
          participantId: chosen.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        assignments.push(na);
        addToAssignmentMap(assignmentsByParticipant, na);
        addLoad(chosen.id, half);
        slotAssigns.push(na);
        if (half === Sa) aHolders.add(chosen.id);
      }

      if (ok) {
        committedHalves.push(Sa, Sb);
        splitSlotIds.add(slot.slotId);
        clearUnfilled(T.id, slot.slotId);
      } else {
        // Revert just this slot; leave it whole on Tr with its unfilled entry
        // intact ⇒ exactly today's per-slot fallback.
        for (const na of slotAssigns) {
          removeAssignment(na);
          subLoad(na.participantId, taskMap.get(na.taskId)!);
        }
        taskMap.delete(Sa.id);
        taskMap.delete(Sb.id);
      }
    }

    if (committedHalves.length === 0) continue; // nothing split for this occurrence

    const survivingSlots = T.slots.filter((s) => !splitSlotIds.has(s.slotId));
    const replacements: Task[] = [];
    if (survivingSlots.length > 0) {
      // Residual keeps surviving slots + their (untouched) assignments since
      // Tr.id === T.id. Never mutate T (S5 zero-contamination).
      const Tr: Task = { ...T, slots: survivingSlots, requiredCount: survivingSlots.length };
      taskMap.set(T.id, Tr);
      replacements.push(Tr);
    } else {
      taskMap.delete(T.id);
    }
    replacements.push(...committedHalves);
    working = working ?? [...tasks];
    const wi = working.findIndex((t) => t.id === T.id);
    if (wi !== -1) working.splice(wi, 1, ...replacements);
  }

  return working ?? tasks;
}

/**
 * Special handler for same-group tasks like Adanit.
 * Tries each group and picks the first one that can fill all slots.
 */
function assignSameGroupTask(
  task: Task,
  participants: Participant[],
  currentAssignments: Assignment[],
  taskMap: Map<string, Task>,
  workload: Map<string, number>,
  assignmentsByParticipant: Map<string, Assignment[]>,
  dailyWorkload?: Map<string, Map<string, number>>,
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  scheduleContext?: ScheduleContext,
  capacities?: Map<string, ParticipantCapacity>,
): boolean {
  // Already have some pinned assignments for this task?
  const pinnedForTask = currentAssignments.filter((a) => a.taskId === task.id);
  const pinnedSlotIds = new Set(pinnedForTask.map((a) => a.slotId));

  // If pinned assignments exist, determine the required group
  let requiredGroup: string | undefined;
  if (pinnedForTask.length > 0) {
    const groups = new Set<string>();
    for (const a of pinnedForTask) {
      const p = participants.find((pp) => pp.id === a.participantId);
      if (p) groups.add(p.group);
    }
    if (groups.size === 1) {
      requiredGroup = [...groups][0];
    }
  }

  // Collect all groups
  const allGroups = [...new Set(participants.map((p) => p.group))];
  const groupsToTry = requiredGroup ? [requiredGroup] : allGroups;

  // Pre-build group → participants map to avoid repeated filter() scans
  const groupParticipantsMap = new Map<string, Participant[]>();
  for (const p of participants) {
    const list = groupParticipantsMap.get(p.group);
    if (list) list.push(p);
    else groupParticipantsMap.set(p.group, [p]);
  }

  // Sort groups by total workload (ascending) for fairness
  // Uses precomputed group map instead of repeated filter() calls.
  // Random tiebreaker ensures different attempts explore different groups
  // when workloads are tied (critical for multi-attempt diversity).
  const groupRng = new Map<string, number>();
  for (const g of groupsToTry) groupRng.set(g, Math.random());
  groupsToTry.sort((ga, gb) => {
    const wa = (groupParticipantsMap.get(ga) || []).reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    const wb = (groupParticipantsMap.get(gb) || []).reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    if (wa !== wb) return wa - wb;
    return (groupRng.get(ga) || 0) - (groupRng.get(gb) || 0);
  });

  const slotsToFill = task.slots.filter((s) => !pinnedSlotIds.has(s.slotId));

  // Track best partial result across groups (diagnostic only)
  let bestFilledCount = 0;

  for (const group of groupsToTry) {
    const groupParticipants = groupParticipantsMap.get(group) || [];

    // P4: Build temp map for this group attempt. Per-slot eligibility within
    // the same task is independent of slot order — every slot in a same-group
    // task shares one timeBlock — so we score eligibility once and let the
    // matcher enforce per-task uniqueness (HC-7) via "each participant at
    // most one slot".
    const tempMap = new Map<string, Assignment[]>();
    for (const [pid, arr] of assignmentsByParticipant) {
      tempMap.set(pid, [...arr]);
    }

    const slotInputs: SlotCandidates[] = slotsToFill.map((slot) => ({
      slotId: slot.slotId,
      candidates: getEligibleCandidates(
        task,
        slot,
        groupParticipants,
        tempMap,
        taskMap,
        workload,
        dailyWorkload,
        disabledHC,
        undefined,
        restRuleMap,
        dayStartHour,
        scheduleContext,
        capacities,
      ).map((p) => p.id),
    }));

    const matching = findMaxMatching(slotInputs);

    if (matching.unfilled.length === 0) {
      // Full success — commit and return immediately
      for (const slot of slotsToFill) {
        const pid = matching.assignments.get(slot.slotId);
        if (!pid) continue;
        const newAssignment: Assignment = {
          id: nextAssignmentId(),
          taskId: task.id,
          slotId: slot.slotId,
          participantId: pid,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        currentAssignments.push(newAssignment);
        addToAssignmentMap(assignmentsByParticipant, newAssignment);
        const eff = computeTaskEffectiveHours(task);
        workload.set(pid, (workload.get(pid) || 0) + eff);
        if (dailyWorkload) {
          const dk = operationalDateKey(task.timeBlock.start, dayStartHour);
          let pDaily = dailyWorkload.get(pid);
          if (!pDaily) {
            pDaily = new Map();
            dailyWorkload.set(pid, pDaily);
          }
          pDaily.set(dk, (pDaily.get(dk) || 0) + eff);
        }
      }
      return true;
    }

    // Track best partial result
    const filledCount = slotsToFill.length - matching.unfilled.length;
    if (filledCount > bestFilledCount) {
      bestFilledCount = filledCount;
    }
  }

  // HC-4: No group could fill ALL slots. Cross-group fill is forbidden
  // (sameGroupRequired is a hard constraint). Report as infeasible.
  if (bestFilledCount > 0 && isSchedulerDiagOn()) {
    console.warn(
      `[Scheduler] ${task.name}: no group could fill all ${slotsToFill.length} slots. ` +
        `Best group filled ${bestFilledCount}/${slotsToFill.length}. HC-4 forbids cross-group fill.`,
    );
  }

  return false;
}

// ─── Local Search Phase ──────────────────────────────────────────────────────

/**
 * P1 Delta Validation: Check whether swapping the participants at indices
 * idxI and idxJ produces a feasible schedule. Only validates constraints
 * for the two affected participants instead of the entire schedule.
 *
 * Accepts pre-built per-participant and per-task assignment indices to
 * avoid O(n) scans on every call. The caller must pass the indices as
 * they exist AFTER the swap has been applied to the candidate array.
 *
 * Exported for regression tests — the SA hot path calls it internally.
 */
export function isSwapFeasible(
  candidate: Assignment[],
  idxI: number,
  idxJ: number,
  taskMap: Map<string, Task>,
  pMap: Map<string, Participant>,
  /** P1: Pre-built per-participant assignment index for the candidate */
  byParticipant: Map<string, Assignment[]>,
  /** P1: Pre-built per-task assignment index for the candidate */
  byTask: Map<string, Assignment[]>,
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
  scheduleContext?: ScheduleContext,
): boolean {
  const aI = candidate[idxI];
  const aJ = candidate[idxJ];
  const pI = pMap.get(aI.participantId);
  const pJ = pMap.get(aJ.participantId);
  const taskI = taskMap.get(aI.taskId);
  const taskJ = taskMap.get(aJ.taskId);
  if (!pI || !pJ || !taskI || !taskJ) return false;

  // HC-1: Level check — single source of truth in isLevelSatisfied()
  const slotI = taskI.slots.find((s) => s.slotId === aI.slotId);
  const slotJ = taskJ.slots.find((s) => s.slotId === aJ.slotId);
  if (!slotI || !slotJ) return false;
  if (!disabledHC?.has('HC-1')) {
    if (!isLevelSatisfied(pI.level, slotI) || !isLevelSatisfied(pJ.level, slotJ)) return false;
  }

  // HC-2: Certification
  if (!disabledHC?.has('HC-2')) {
    for (const c of slotI.requiredCertifications) if (!pI.certifications.includes(c)) return false;
    for (const c of slotJ.requiredCertifications) if (!pJ.certifications.includes(c)) return false;
  }

  // HC-3: Availability — both pre-expanded availability windows AND the
  // recurring weekly dateUnavailability rules must be honored. Without the
  // rule check, SA can accept a swap that places a participant into a
  // cross-midnight task whose operational day matches a weekly blackout,
  // silently producing an HC-3 violation that the final validator catches.
  if (!disabledHC?.has('HC-3')) {
    if (!isFullyCovered(taskI.timeBlock, pI.availability)) return false;
    if (!isFullyCovered(taskJ.timeBlock, pJ.availability)) return false;
    if (scheduleContext) {
      if (isBlockedByDateUnavailability(taskI.timeBlock, pI.dateUnavailability, scheduleContext)) return false;
      if (isBlockedByDateUnavailability(taskJ.timeBlock, pJ.dateUnavailability, scheduleContext)) return false;
    }
  }

  // HC-11: Forbidden certification check (per-slot)
  if (!disabledHC?.has('HC-11')) {
    if (hasForbiddenCertification(pI, slotI)) return false;
    if (hasForbiddenCertification(pJ, slotJ)) return false;
  }

  // HC-7: Unique participant per task — use per-task index (O(k) instead of O(n))
  if (!disabledHC?.has('HC-7')) {
    const taskIAssignments = byTask.get(aI.taskId) || [];
    for (const a of taskIAssignments) {
      if (a === aI) continue;
      if (a.participantId === aI.participantId) return false;
    }
    const taskJAssignments = byTask.get(aJ.taskId) || [];
    for (const a of taskJAssignments) {
      if (a === aJ) continue;
      if (a.participantId === aJ.participantId) return false;
    }
  }

  // HC-4: Same-group — mandatory. If either swapped assignment belongs to a
  // sameGroupRequired task, verify all participants in that task share one group.
  if (!disabledHC?.has('HC-4')) {
    const checkSameGroupForTask = (taskId: string): boolean => {
      const task = taskMap.get(taskId);
      if (!task || !task.sameGroupRequired) return true;
      // Link-aware: for a SPLIT same-group occurrence the assignees live across
      // the residual + half fragments, so consider the whole `sameGroupLinkId`
      // unit (not just this fragment) — otherwise SA would accept a cross-group
      // swap the link-aware final validator then rejects (GROUP_MISMATCH).
      const groups = new Set<string>();
      for (const tid of sameGroupUnitTaskIds(task, taskMap.values())) {
        for (const a of byTask.get(tid) || []) {
          const p = pMap.get(a.participantId);
          if (p) groups.add(p.group);
        }
      }
      return groups.size <= 1;
    };
    if (!checkSameGroupForTask(aI.taskId) || !checkSameGroupForTask(aJ.taskId)) return false;
  }

  // HC-5: Double-booking for both affected participants — use per-participant index
  if (!disabledHC?.has('HC-5')) {
    const checkDoubleBooking = (pid: string): boolean => {
      const pAssignments = byParticipant.get(pid) || [];
      for (let x = 0; x < pAssignments.length; x++) {
        for (let y = x + 1; y < pAssignments.length; y++) {
          const tX = taskMap.get(pAssignments[x].taskId);
          const tY = taskMap.get(pAssignments[y].taskId);
          if (tX && tY && blocksOverlap(tX.timeBlock, tY.timeBlock)) return false;
        }
      }
      return true;
    };
    if (!checkDoubleBooking(pI.id) || !checkDoubleBooking(pJ.id)) return false;
  }

  // Shift-splitting: does either swapped participant's POST-swap list contain
  // a split half? Only then must HC-12/HC-14 use the coalesced run view (and
  // HC-16 apply). Cheap predicate; keeps the dominant non-split SA path on the
  // hand-optimized `_hcScratch` fast path (zero regression / no perf cost).
  const hasSplitInList = (pid: string): boolean => {
    const raw = byParticipant.get(pid) || [];
    for (let i = 0; i < raw.length; i++) {
      if (taskMap.get(raw[i].taskId)?.splitGroupId !== undefined) return true;
    }
    return false;
  };
  const splitI = hasSplitInList(pI.id);
  const splitJ = hasSplitInList(pJ.id);

  // HC-16: Split-sibling disjointness — a pairwise swap must never leave one
  // participant holding BOTH halves of a split occurrence. SA's own gate
  // (this function) is the only thing standing between an accepted swap and
  // the committed schedule, so without this SA could accept a swap the
  // aggregate validator then flags SPLIT_SIBLING_CONFLICT — an invalid
  // schedule returned by the optimizer. Inert when no split is involved.
  if (!disabledHC?.has('HC-16')) {
    if (splitI && checkSplitSiblingDisjoint(pI.id, byParticipant.get(pI.id) || [], taskMap).length > 0) return false;
    if (splitJ && checkSplitSiblingDisjoint(pJ.id, byParticipant.get(pJ.id) || [], taskMap).length > 0) return false;
  }

  // HC-12: No consecutive blocking tasks for both affected participants.
  // Split involved → delegate to the coalesce-aware aggregate so SA agrees
  // with the final validator (a legal note-6 run must not be rejected).
  // Otherwise the module-level `_hcScratch` fast path (no allocations).
  if (!disabledHC?.has('HC-12')) {
    const checkConsecutiveHighLoad = (pid: string, hasSplit: boolean): boolean => {
      if (hasSplit) {
        return aggregateHc12(pid, byParticipant.get(pid) || [], taskMap).length === 0;
      }
      const raw = byParticipant.get(pid) || [];
      _hcScratch.length = 0;
      for (let i = 0; i < raw.length; i++) {
        const task = taskMap.get(raw[i].taskId);
        if (task != null) _hcScratch.push(task);
      }
      _hcScratch.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());
      for (let x = 0; x < _hcScratch.length - 1; x++) {
        const cur = _hcScratch[x];
        const nxt = _hcScratch[x + 1];
        if (cur.id === nxt.id) continue;
        const gap = nxt.timeBlock.start.getTime() - cur.timeBlock.end.getTime();
        if (gap > 0) continue;
        if (effectivelyBlocksAt(cur, 'end') && effectivelyBlocksAt(nxt, 'start')) return false;
      }
      return true;
    };
    if (!checkConsecutiveHighLoad(pI.id, splitI) || !checkConsecutiveHighLoad(pJ.id, splitJ)) return false;
  }

  // HC-14: Rest rules — minimum gap between rest-rule-tagged tasks
  // Uses module-level _hcScratch to avoid per-call allocations.
  if (!disabledHC?.has('HC-14') && restRuleMap && restRuleMap.size > 0) {
    let maxRestDurMs = 0;
    for (const d of restRuleMap.values()) if (d > maxRestDurMs) maxRestDurMs = d;
    const checkRestRules = (pid: string, hasSplit: boolean): boolean => {
      // Split involved → coalesce-aware aggregate so SA agrees with the final
      // validator (a legal split run is one rest-unit, not a 0-gap violation).
      if (hasSplit) {
        return aggregateHc14(pid, byParticipant.get(pid) || [], taskMap, restRuleMap).length === 0;
      }
      const raw = byParticipant.get(pid) || [];
      _hcScratch.length = 0;
      for (let i = 0; i < raw.length; i++) {
        const task = taskMap.get(raw[i].taskId);
        if (task != null && task.restRuleId && restRuleMap.has(task.restRuleId)) _hcScratch.push(task);
      }
      if (_hcScratch.length < 2) return true;
      _hcScratch.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());

      // Phase 1: Same-rule adjacent pairs (group by rule)
      const ruleGroups = new Map<string, Task[]>();
      for (const t of _hcScratch) {
        let list = ruleGroups.get(t.restRuleId!);
        if (!list) {
          list = [];
          ruleGroups.set(t.restRuleId!, list);
        }
        list.push(t);
      }
      for (const [rid, tasks] of ruleGroups) {
        if (tasks.length < 2) continue;
        const dur = restRuleMap.get(rid)!;
        // tasks are already sorted (subset of sorted _hcScratch)
        for (let x = 0; x < tasks.length - 1; x++) {
          if (tasks[x].id === tasks[x + 1].id) continue;
          const gap = tasks[x + 1].timeBlock.start.getTime() - tasks[x].timeBlock.end.getTime();
          if (gap < dur) return false;
        }
      }

      // Phase 2: Cross-rule pairs — all forward pairs within the
      // max-rule-duration window. Adjacent-only is unsound when 3+ rules with
      // different durations interleave (a small-duration rule between two
      // large ones lets a long-rule pair slip through). The forward gap is
      // monotone non-decreasing (sorted by start), so we break once
      // gap >= maxDur. Mirrors checkRestRules() in hard-constraints.ts.
      if (ruleGroups.size > 1) {
        for (let x = 0; x < _hcScratch.length - 1; x++) {
          const cur = _hcScratch[x];
          const curEnd = cur.timeBlock.end.getTime();
          for (let y = x + 1; y < _hcScratch.length; y++) {
            const nxt = _hcScratch[y];
            const gap = nxt.timeBlock.start.getTime() - curEnd;
            if (gap >= maxRestDurMs) break;
            if (cur.id === nxt.id) continue;
            if (cur.restRuleId === nxt.restRuleId) continue;
            const dur = Math.min(restRuleMap.get(cur.restRuleId!)!, restRuleMap.get(nxt.restRuleId!)!);
            if (gap < dur) return false;
          }
        }
      }
      return true;
    };
    if (!checkRestRules(pI.id, splitI) || !checkRestRules(pJ.id, splitJ)) return false;
  }

  // HC-15: Sleep & Recovery — only the new placement can introduce a violation.
  // pI is the participant now occupying slot I (post-swap), so pI's new task
  // is taskI; symmetrically pJ's new task is taskJ. Pre-existing violations
  // between unchanged assignment pairs are not the swap's fault, so we check
  // only each participant's new task as the candidate. checkSleepRecoveryForPlacement
  // skips `candidate.id === other.id`, so passing the post-swap list is correct.
  if (!disabledHC?.has('HC-15')) {
    if (checkSleepRecoveryForPlacement(taskI, byParticipant.get(pI.id) || [], taskMap)) return false;
    if (checkSleepRecoveryForPlacement(taskJ, byParticipant.get(pJ.id) || [], taskMap)) return false;
  }

  return true;
}

/**
 * Try to improve the schedule by swapping participants between assignments
 * and inserting participants into unfilled slots.
 *
 * Uses simulated-annealing style acceptance: at the start of the search
 * the "temperature" is high and the algorithm occasionally accepts swaps
 * that lower the score (escaping local minima). Temperature decays
 * linearly toward zero so the tail of the search is purely hill-climbing.
 *
 * Insert moves: When unfilled slots exist, periodically tries to place
 * an eligible participant into an unfilled slot. Accepted inserts get a
 * large bonus (UNFILLED_SLOT_PENALTY per slot filled) to strongly prefer
 * feasibility over score quality.
 *
 * Performance: swaps are applied in-place on the `current` array and
 * undone if rejected, avoiding O(n) clones per attempt. A ScoreContext
 * is pre-built once and reused across all `computeScheduleScore` calls
 * to eliminate redundant map construction and O(P×A) scans.
 */
const UNFILLED_SLOT_PENALTY = 50000;

export function localSearchOptimize(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
  disabledHC?: Set<string>,
  unfilledSlots?: UnfilledSlot[],
  phantomContext?: PhantomContext,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  pinnedIds: Set<string> = new Set(),
  abortSignal?: AbortSignal,
  saIntensifyTaskIds?: Set<string>,
  scheduleContext?: ScheduleContext,
  stopSignal?: AbortSignal,
  /** Task count used to seed the SA initial temperature. Defaults to
   *  `tasks.length`. `optimize()` passes the PRE-split count so a feasibility
   *  split that grows the list cannot silently fall off the 40-task
   *  temperature cliff (`getSaInitialTemperature`). Inert when equal. */
  preSplitTaskCount?: number,
  /** Splitting mode gate forwarded to `structuralRefine`. `true` ⇒ quality
   *  mode (MERGE strict, QUALITY-SPLIT runs); `false` ⇒ feasibility mode
   *  (MERGE non-strict, QUALITY-SPLIT skipped). Default `true` preserves the
   *  pre-tri-state behavior for any legacy caller. */
  qualitySplitEnabled: boolean = true,
): {
  assignments: Assignment[];
  /** The realized task set. Same reference as the input `tasks` unless the
   *  post-polish structural-refine pass committed a quality split or a merge;
   *  `optimize()` reads `lsResult.tasks ?? greedy.tasks` so validation,
   *  scoring and the frozen schedule all agree on this list. */
  tasks: Task[];
  filledSlots: Array<{ taskId: string; slotId: string }>;
  iterations: number;
  saMs: number;
  polishMs: number;
  /** Composite score after the initial greedy pass (before SA). */
  postGreedyComposite: number;
  /** Composite score at SA exit, before `polishReplaceWithIdle` runs. */
  postSAComposite: number;
} {
  const current = [...assignments.map((a) => ({ ...a }))];

  // Track unfilled slots that SA might fill via insert moves.
  // Keyed as taskId|slotId pairs because SlotRequirement.slotId is only
  // unique within a task — two distinct unfilled slots can share a slotId.
  const remainingUnfilled = unfilledSlots ? [...unfilledSlots] : [];
  const filledSlots: Array<{ taskId: string; slotId: string }> = [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Seed phantom tasks into taskMap for cross-schedule constraint resolution
  if (phantomContext) {
    for (const pt of phantomContext.phantomTasks) taskMap.set(pt.id, pt);
  }

  // P1: Pre-build participant map once for delta validation
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  // P1: Pre-build per-participant and per-task indices for O(k) lookups.
  // With in-place swaps these are patched and unpatched rather than rebuilt.
  const byParticipant = buildAssignmentMap(current);

  // Seed phantom assignments into per-participant index. SA never selects
  // phantom assignments for swapping (they're not in `current`), but
  // feasibility checks via isEligibleForSlot read from byParticipant.
  if (phantomContext) {
    for (const pa of phantomContext.phantomAssignments) addToAssignmentMap(byParticipant, pa);
  }
  const byTask = new Map<string, Assignment[]>();
  for (const a of current) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }

  // Pre-compute capacities for proportional workload scoring
  let schedStart = tasks[0]?.timeBlock.start ?? new Date();
  let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const capacities = computeAllCapacities(participants, schedStart, schedEnd, dayStartHour);

  // Build ScoreContext once — taskMap, pMap, and the mutable indices are
  // kept consistent via in-place patching so the same ctx is valid for
  // every scoring call throughout the search.
  // Build notWithPairs from participant data for scoring context
  const notWithPairs = new Map<string, Set<string>>();
  for (const p of participants) {
    if (p.notWithIds && p.notWithIds.length > 0) {
      notWithPairs.set(p.id, new Set(p.notWithIds));
    }
  }

  const scoreCtx: ScoreContext = {
    taskMap,
    pMap,
    assignmentsByParticipant: byParticipant,
    assignmentsByTask: byTask,
    capacities,
    notWithPairs,
    dayStartHour,
    phantomTaskIds: phantomContext?.phantomTaskIds,
  };

  const currentScore = computeScheduleScore(tasks, participants, current, config, scoreCtx);
  // Capture the post-greedy composite for diagnostics (cost: zero — value already exists).
  const postGreedyComposite = currentScore.compositeScore;
  // Snapshot best independently — current is mutated in-place
  let best = current.map((a) => ({ ...a }));
  let bestScore = currentScore;

  // Build incremental scorer for O(k) swap scoring
  let incScorer = IncrementalScorer.build(tasks, participants, current, config, scoreCtx);
  let currentComposite = incScorer.compositeScore;

  const startTime = Date.now();
  let iterations = 0;

  // SA loop telemetry — local counters always increment (cheap), the snapshot
  // push at SA exit is gated. Discarded silently when diag is off.
  let swapAccept = 0;
  let swapReject = 0;
  let insertAccept = 0;
  let insertReject = 0;
  let reheats = 0;
  // Move-generator throughput: counts every (i,j) pair / insert candidate the
  // generator visits, vs. the subset that reaches scoring (i.e., passed
  // isSwapFeasible / isEligibleForSlot + HC-4/HC-7). Surfacing the gap is what
  // exposes proposal-generation as a bottleneck.
  let proposalAttempts = 0;
  let proposalsFound = 0;
  // SA cooling-curve sampling: increment per outer loop iteration; sample temp
  // when (outerIter % SA_TEMP_SAMPLE_INTERVAL === 0). Gated behind diag flag
  // so off-mode pays only the increment + mod check.
  let outerIter = 0;
  const SA_TEMP_SAMPLE_INTERVAL = 100;

  const maxIter = config.maxIterations;
  const saInitialTemp = getSaInitialTemperature(preSplitTaskCount ?? tasks.length);
  let temperature = _benchActiveSaTemp ?? saInitialTemp;
  const _saInitialForReheat = _benchActiveSaTemp ?? saInitialTemp;
  let itersSinceImprovement = 0;

  // Pre-allocate index order array once and shuffle in-place each pass
  // to avoid per-iteration allocation.
  const idxOrder = Array.from({ length: current.length }, (_, k) => k);

  // Build assignment-ID → position-in-participant-list map for true O(1)
  // swap patching (avoids indexOf scans on each attempt).
  const assignmentPos = new Map<string, { pid: string; idx: number }>();
  for (const [pid, list] of byParticipant) {
    for (let idx = 0; idx < list.length; idx++) {
      assignmentPos.set(list[idx].id, { pid, idx });
    }
  }

  while (iterations < maxIter) {
    if (Date.now() - startTime > config.maxSolverTimeMs || abortSignal?.aborted || stopSignal?.aborted) break;

    // Cooling-curve sample (gated; off-mode pays only the mod check + branch).
    if (outerIter % SA_TEMP_SAMPLE_INTERVAL === 0 && isSchedulerDiagOn()) {
      recordSATempSample(iterations, temperature);
    }
    outerIter++;

    // Geometric temperature decay with reheating
    temperature *= SA_COOLING_RATE;
    if (itersSinceImprovement >= SA_REHEAT_THRESHOLD && temperature < 1) {
      temperature = _saInitialForReheat / 3;
      itersSinceImprovement = 0;
      reheats++;
    }

    // Shuffle in-place (Fisher-Yates) — reuses the pre-allocated array
    for (let k = idxOrder.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [idxOrder[k], idxOrder[m]] = [idxOrder[m], idxOrder[k]];
    }

    let accepted = false;

    // ── Insert moves: try to fill unfilled slots ──
    // When unfilled slots exist, use 50% probability to aggressively prioritise
    // feasibility over quality. Otherwise use the default 20%.
    const insertProb = remainingUnfilled.length > 0 ? 0.5 : SA_INSERT_PROBABILITY;
    if (remainingUnfilled.length > 0 && Math.random() < insertProb) {
      // Pick a random unfilled slot. When `saIntensifyTaskIds` is set (from
      // elite-boost classification: tasks whose unfill is HC-12/HC-14 adjacency
      // rather than ordering-fixable), bias the pick with 80% probability
      // toward those task IDs so SA spends its insert-move budget where SA
      // can actually help. Falls back to uniform pick when the intensify set
      // is empty or has no overlap with remainingUnfilled.
      let ufIdx: number;
      if (saIntensifyTaskIds && saIntensifyTaskIds.size > 0 && Math.random() < 0.8) {
        const intensifyIdxs: number[] = [];
        for (let k = 0; k < remainingUnfilled.length; k++) {
          if (saIntensifyTaskIds.has(remainingUnfilled[k].taskId)) intensifyIdxs.push(k);
        }
        ufIdx =
          intensifyIdxs.length > 0
            ? intensifyIdxs[Math.floor(Math.random() * intensifyIdxs.length)]
            : Math.floor(Math.random() * remainingUnfilled.length);
      } else {
        ufIdx = Math.floor(Math.random() * remainingUnfilled.length);
      }
      const uf = remainingUnfilled[ufIdx];
      const ufTask = taskMap.get(uf.taskId);
      if (ufTask) {
        const ufSlot = ufTask.slots.find((s) => s.slotId === uf.slotId);
        if (ufSlot) {
          // Shuffle participant order for this attempt
          const pOrder = [...participants];
          for (let k = pOrder.length - 1; k > 0; k--) {
            const m = Math.floor(Math.random() * (k + 1));
            [pOrder[k], pOrder[m]] = [pOrder[m], pOrder[k]];
          }
          for (const p of pOrder) {
            proposalAttempts++;
            const pAssigns = byParticipant.get(p.id) || [];
            if (!isEligibleForSlot(p, ufTask, ufSlot, pAssigns, taskMap, disabledHC, restRuleMap, scheduleContext))
              continue;
            // Also check HC-7: no duplicate participant in the same task
            const taskAssigns = byTask.get(uf.taskId) || [];
            if (taskAssigns.some((a) => a.participantId === p.id)) continue;

            // HC-4: Same-group constraint for insert moves. Link-aware so a
            // SPLIT same-group occurrence is judged across its whole
            // residual+halves unit (consistent with the final validator).
            if (!disabledHC?.has('HC-4') && ufTask.sameGroupRequired) {
              const existingGroups = new Set<string>();
              for (const tid of sameGroupUnitTaskIds(ufTask, taskMap.values())) {
                for (const a of byTask.get(tid) || []) {
                  const ep = pMap.get(a.participantId);
                  if (ep) existingGroups.add(ep.group);
                }
              }
              if (existingGroups.size > 0 && !existingGroups.has(p.group)) continue;
            }

            // Candidate cleared eligibility + HC-7 + HC-4: count it as
            // having reached scoring.
            proposalsFound++;

            // Create new assignment and score
            const newA: Assignment = {
              id: nextAssignmentId(),
              taskId: uf.taskId,
              slotId: uf.slotId,
              participantId: p.id,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            // Temporarily add to current
            current.push(newA);
            addToAssignmentMap(byParticipant, newA);
            const taskList = byTask.get(uf.taskId);
            if (taskList) taskList.push(newA);
            else byTask.set(uf.taskId, [newA]);

            const score = computeScheduleScore(tasks, participants, current, config, scoreCtx);
            // Insert moves get a large bonus per filled slot
            const insertBonus = UNFILLED_SLOT_PENALTY;
            const effectiveScore = score.compositeScore + insertBonus;

            if (effectiveScore > currentComposite) {
              // Accept insert
              insertAccept++;
              // Update position map for the new assignment
              const pList = byParticipant.get(p.id)!;
              assignmentPos.set(newA.id, { pid: p.id, idx: pList.length - 1 });
              // Update idxOrder to include the new index
              idxOrder.push(current.length - 1);
              // Remove from unfilled
              remainingUnfilled.splice(ufIdx, 1);
              filledSlots.push({ taskId: uf.taskId, slotId: uf.slotId });
              accepted = true;

              // Rebuild incremental scorer — the insert changed the
              // assignment set, so per-participant caches and running
              // statistics must be recomputed to keep SA accurate.
              incScorer = IncrementalScorer.build(tasks, participants, current, config, scoreCtx);
              currentComposite = incScorer.compositeScore;

              // Rebuild position map after scorer rebuild (scorer doesn't
              // touch assignmentPos but indices may have shifted)
              assignmentPos.clear();
              for (const [pid, list] of byParticipant) {
                for (let idx = 0; idx < list.length; idx++) {
                  assignmentPos.set(list[idx].id, { pid, idx });
                }
              }

              // Track global best
              if (currentComposite > bestScore.compositeScore) {
                best = current.map((a) => ({ ...a }));
                bestScore = { ...score, compositeScore: currentComposite };
              }
            } else {
              // Undo insert
              insertReject++;
              current.pop();
              const pAssignList = byParticipant.get(p.id);
              if (pAssignList) {
                pAssignList.pop();
                if (pAssignList.length === 0) byParticipant.delete(p.id);
              }
              const tList = byTask.get(uf.taskId);
              if (tList) {
                tList.pop();
                if (tList.length === 0) byTask.delete(uf.taskId);
              }
            }
            break; // Only try one candidate per iteration
          }
        }
      }
      iterations++;
      if (accepted) continue;
    }

    // Try swapping each pair of assignments
    for (let ii = 0; ii < idxOrder.length && !accepted; ii++) {
      const i = idxOrder[ii];
      for (let jj = ii + 1; jj < idxOrder.length && !accepted; jj++) {
        const j = idxOrder[jj];
        if (Date.now() - startTime > config.maxSolverTimeMs || abortSignal?.aborted || stopSignal?.aborted) break;

        const ai = current[i];
        const aj = current[j];

        // Skip pinned/manual/frozen assignments (don't count as iterations)
        if (pinnedIds.has(ai.id) || ai.status === AssignmentStatus.Manual || ai.status === AssignmentStatus.Frozen)
          continue;
        if (pinnedIds.has(aj.id) || aj.status === AssignmentStatus.Manual || aj.status === AssignmentStatus.Frozen)
          continue;

        // Skip if same participant (don't count as iterations)
        if (ai.participantId === aj.participantId) continue;

        // Count only actual swap attempts against iteration budget
        iterations++;
        proposalAttempts++;
        if (iterations > maxIter) break;

        // ── In-place swap ───────────────────────────────────────────
        const oldPidI = ai.participantId;
        const oldPidJ = aj.participantId;

        // 1. Mutate participant IDs in-place
        ai.participantId = oldPidJ;
        aj.participantId = oldPidI;

        // 2. Patch byParticipant index in true O(1) via position map
        //    (avoids indexOf scans on each attempt).
        const posInfoI = assignmentPos.get(ai.id)!;
        const posInfoJ = assignmentPos.get(aj.id)!;
        const listPidI = byParticipant.get(oldPidI)!;
        const listPidJ = byParticipant.get(oldPidJ)!;
        const posI = posInfoI.idx;
        const posJ = posInfoJ.idx;
        listPidI[posI] = aj; // aj now belongs to oldPidI
        listPidJ[posJ] = ai; // ai now belongs to oldPidJ
        // Update position map to reflect the swap
        assignmentPos.set(ai.id, { pid: oldPidJ, idx: posJ });
        assignmentPos.set(aj.id, { pid: oldPidI, idx: posI });

        // byTask: no change needed — same object references, same taskIds

        // 3. Delta validation with patched indices
        if (
          !isSwapFeasible(current, i, j, taskMap, pMap, byParticipant, byTask, disabledHC, restRuleMap, scheduleContext)
        ) {
          // Undo in-place swap
          ai.participantId = oldPidI;
          aj.participantId = oldPidJ;
          listPidI[posI] = ai;
          listPidJ[posJ] = aj;
          assignmentPos.set(ai.id, { pid: oldPidI, idx: posI });
          assignmentPos.set(aj.id, { pid: oldPidJ, idx: posJ });
          continue;
        }

        // Proposal cleared HC-feasibility — count it as having reached scoring.
        proposalsFound++;

        // 4. Incremental score: only recompute for the two swapped participants
        //    Save state for undo
        const savedA = incScorer.saveParticipant(oldPidJ); // ai now has oldPidJ
        const savedB = incScorer.saveParticipant(oldPidI); // aj now has oldPidI
        if (!savedA || !savedB) {
          // Defensive: scorer lacks data for a participant — undo in-place swap
          ai.participantId = oldPidI;
          aj.participantId = oldPidJ;
          listPidI[posI] = ai;
          listPidJ[posJ] = aj;
          assignmentPos.set(ai.id, { pid: oldPidI, idx: posI });
          assignmentPos.set(aj.id, { pid: oldPidJ, idx: posJ });
          continue;
        }
        const newComposite = incScorer.recomputeForSwap(oldPidJ, oldPidI);
        const delta = newComposite - currentComposite;

        // Accept if strictly better, or probabilistically if worse (SA)
        if (delta > 0 || (temperature > 0.01 && Math.random() < Math.exp(delta / temperature))) {
          swapAccept++;
          ai.updatedAt = new Date();
          aj.updatedAt = new Date();
          currentComposite = newComposite;
          accepted = true;

          // Track global best (snapshot since current is mutated in-place)
          if (newComposite > bestScore.compositeScore) {
            best = current.map((a) => ({ ...a }));
            bestScore = { ...bestScore, compositeScore: newComposite };
          }
        } else {
          swapReject++;
          // Undo in-place swap
          ai.participantId = oldPidI;
          aj.participantId = oldPidJ;
          listPidI[posI] = ai;
          listPidJ[posJ] = aj;
          assignmentPos.set(ai.id, { pid: oldPidI, idx: posI });
          assignmentPos.set(aj.id, { pid: oldPidJ, idx: posJ });
          // Restore incremental scorer state
          incScorer.restoreParticipant(oldPidJ, savedA);
          incScorer.restoreParticipant(oldPidI, savedB);
          incScorer.finalizeUndo();
        }
      }
    }

    // Track stagnation for reheating
    if (accepted) {
      itersSinceImprovement = 0;
    } else {
      itersSinceImprovement++;
    }

    // If nothing was accepted in this full pass AND temperature has decayed
    // significantly AND reheating can't help, the search has converged.
    if (!accepted && temperature < 0.5 && itersSinceImprovement > SA_REHEAT_THRESHOLD) break;
  }

  // SA loop done. Capture timing + stats. saMs spans only the SA loop;
  // post-SA reconciliation/sweep is small and folded into saMs implicitly
  // through the time elapsed before polish.
  const saExitTimeMs = Date.now();
  const saMs = saExitTimeMs - startTime;
  // Capture post-SA / pre-polish composite. `bestScore` is the SA-tracked best;
  // post-SA insert sweep may add to `best` afterwards without updating
  // `bestScore`, but the slight drift (visible only when insert sweep fires) is
  // an acceptable diagnostic-only inaccuracy in exchange for zero extra
  // computeScheduleScore calls on the per-attempt path.
  const postSAComposite = bestScore.compositeScore;
  recordSAStats({
    iters: iterations,
    swapAccept,
    swapReject,
    insertAccept,
    insertReject,
    reheats,
    tempAtExit: temperature,
    itersSinceImprovementAtExit: itersSinceImprovement,
    proposalAttempts,
    proposalsFound,
  });

  // ── Reconcile filledSlots with best ──────────────────────────────────────
  // SA insert moves update filledSlots/remainingUnfilled eagerly on `current`,
  // but `best` is only snapshotted when currentComposite exceeds bestScore.
  // Slots accepted via the insert bonus that never made it to `best` must be
  // restored to remainingUnfilled so the post-SA sweep can retry them.
  for (let k = filledSlots.length - 1; k >= 0; k--) {
    const fk = filledSlots[k];
    if (!best.some((a) => a.taskId === fk.taskId && a.slotId === fk.slotId)) {
      const original = (unfilledSlots || []).find((uf) => uf.taskId === fk.taskId && uf.slotId === fk.slotId);
      if (original) {
        remainingUnfilled.push(original);
      }
      filledSlots.splice(k, 1);
    }
  }

  // ── Post-SA Insert Sweep ─────────────────────────────────────────────────
  // SA swaps may have freed participants that no stochastic insert iteration
  // happened to find. Build fresh indices from `best` and deterministically
  // try to fill every remaining unfilled slot.
  if (remainingUnfilled.length > 0) {
    const sweepByParticipant = buildAssignmentMap(best);
    // Seed phantom assignments into the per-participant index. `best` never
    // contains phantoms (they're not in `current`), so a fresh map built from
    // it would be phantom-blind and let isEligibleForSlot miss cross-schedule
    // HC-5/HC-12/HC-14 — letting this last-ditch deterministic fill place a
    // candidate that greedy / in-loop-SA / polish all correctly rejected.
    // Matches the seeding the other three paths already do; there is no
    // downstream phantom-aware revalidation, so the sweep is the last guard.
    if (phantomContext) {
      for (const pa of phantomContext.phantomAssignments) addToAssignmentMap(sweepByParticipant, pa);
    }
    const sweepByTask = new Map<string, Assignment[]>();
    for (const a of best) {
      const list = sweepByTask.get(a.taskId);
      if (list) list.push(a);
      else sweepByTask.set(a.taskId, [a]);
    }

    for (const uf of [...remainingUnfilled]) {
      const ufTask = taskMap.get(uf.taskId);
      if (!ufTask) continue;
      const ufSlot = ufTask.slots.find((s) => s.slotId === uf.slotId);
      if (!ufSlot) continue;

      for (const p of participants) {
        const pAssigns = sweepByParticipant.get(p.id) || [];
        if (!isEligibleForSlot(p, ufTask, ufSlot, pAssigns, taskMap, disabledHC, restRuleMap, scheduleContext))
          continue;
        // HC-7: no duplicate participant in same task
        const taskAssigns = sweepByTask.get(uf.taskId) || [];
        if (taskAssigns.some((a) => a.participantId === p.id)) continue;

        // HC-4: Same-group constraint for sweep inserts
        if (!disabledHC?.has('HC-4') && ufTask.sameGroupRequired) {
          const existingGroups = new Set<string>();
          for (const a of taskAssigns) {
            const ep = pMap.get(a.participantId);
            if (ep) existingGroups.add(ep.group);
          }
          if (existingGroups.size > 0 && !existingGroups.has(p.group)) continue;
        }

        const newA: Assignment = {
          id: nextAssignmentId(),
          taskId: uf.taskId,
          slotId: uf.slotId,
          participantId: p.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        best.push(newA);
        addToAssignmentMap(sweepByParticipant, newA);
        const tList = sweepByTask.get(uf.taskId);
        if (tList) tList.push(newA);
        else sweepByTask.set(uf.taskId, [newA]);
        filledSlots.push({ taskId: uf.taskId, slotId: uf.slotId });
        break;
      }
    }
  }

  // ── Post-SA Polish: replace assigned with idle when strictly better ──────
  // SA's pairwise-swap neighborhood + insert-into-unfilled cannot reach a
  // configuration where an idle eligible participant replaces an already-
  // assigned one in a filled slot. The polish closes this structural gap
  // deterministically, accepting only strict composite-score improvements
  // while preserving every hard constraint via isEligibleForSlot.
  // sameGroupRequired tasks are skipped — within-group swaps are reachable
  // by SA and cross-group replacements are infeasible for a single primitive.
  // The fresh-recompute at optimize() (computeScheduleScore) will re-derive
  // the final score from scratch, masking any incScorer FP drift; do not
  // remove that safety net.
  const polishStartMs = Date.now();
  polishReplaceWithIdle(
    best,
    tasks,
    participants,
    config,
    pinnedIds,
    taskMap,
    pMap,
    phantomContext,
    disabledHC,
    restRuleMap,
    dayStartHour,
    capacities,
    notWithPairs,
    startTime,
    abortSignal,
    stopSignal,
    scheduleContext,
  );
  const polishMs = Date.now() - polishStartMs;
  recordPhase('sa', saMs);
  recordPhase('polish', polishMs);

  // ── Post-polish structural refinement (quality split / merge) ──────────
  // Runs BETWEEN SA invocations so the SA loop's task set (and thus the
  // run-constant IncrementalScorer._splitPenalty) is never mutated mid-search
  // (Option B). Identity fast path returns the same refs when nothing is
  // splittable/split ⇒ zero added cost and byte-identical with splitting off.
  const sr = structuralRefine(
    best,
    tasks,
    participants,
    config,
    pinnedIds,
    pMap,
    phantomContext,
    disabledHC,
    restRuleMap,
    dayStartHour,
    capacities,
    notWithPairs,
    scheduleContext,
    qualitySplitEnabled,
  );
  let resultTasks = tasks;
  let resultAssignments = best;
  if (sr.changed) {
    resultTasks = sr.tasks;
    resultAssignments = sr.assignments;
    // Bounded refinement on the NEW frozen list: a single deterministic
    // polish pass re-staffs the fresh fragments globally (replace-with-idle,
    // strict-improvement, HC-safe). It builds its own indices from the passed
    // assignments and rebuilds the scorer (so _splitPenalty is re-derived for
    // the new split count). Conservative substitute for a second cold SA — it
    // captures the global re-staffing payoff without the runtime / invariant
    // risk of mutating the SA core.
    const refinedTaskMap = new Map<string, Task>();
    for (const t of resultTasks) refinedTaskMap.set(t.id, t);
    if (phantomContext) for (const pt of phantomContext.phantomTasks) refinedTaskMap.set(pt.id, pt);
    polishReplaceWithIdle(
      resultAssignments,
      resultTasks,
      participants,
      config,
      pinnedIds,
      refinedTaskMap,
      pMap,
      phantomContext,
      disabledHC,
      restRuleMap,
      dayStartHour,
      capacities,
      notWithPairs,
      startTime,
      abortSignal,
      stopSignal,
      scheduleContext,
    );
  }

  return {
    assignments: resultAssignments,
    tasks: resultTasks,
    filledSlots,
    iterations,
    saMs,
    polishMs,
    postGreedyComposite,
    postSAComposite,
  };
}

// ─── Post-SA Polish ──────────────────────────────────────────────────────────

const MAX_POLISH_PASSES = 3;

/**
 * Replace each assigned participant with an idle eligible candidate when
 * doing so strictly improves the composite score. Operates in-place on `best`.
 *
 * Determinism: iterates participants in input order, accepts only strict
 * improvements (delta > 1e-6). Same input → same output.
 *
 * Skips sameGroupRequired tasks and pinned/Manual/Frozen incumbents.
 *
 * Reuses IncrementalScorer for O(k) per-attempt scoring. Builds fresh
 * indices from `best` so the post-SA insert sweep's mutations are seen.
 */
function polishReplaceWithIdle(
  best: Assignment[],
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  pinnedIds: Set<string>,
  taskMap: Map<string, Task>,
  pMap: Map<string, Participant>,
  phantomContext: PhantomContext | undefined,
  disabledHC: Set<string> | undefined,
  restRuleMap: Map<string, number> | undefined,
  dayStartHour: number,
  capacities: Map<string, ParticipantCapacity>,
  notWithPairs: Map<string, Set<string>>,
  startTime: number,
  abortSignal: AbortSignal | undefined,
  stopSignal: AbortSignal | undefined,
  scheduleContext: ScheduleContext | undefined,
): void {
  // Build fresh indices from `best`. The post-SA insert sweep extended `best`
  // without updating any of the SA-loop indices, so reusing them would feed
  // the scorer a stale assignment set. Phantom assignments are seeded into
  // byParticipant for cross-schedule eligibility (HC-5/12/14), matching
  // localSearchOptimize's own seeding pattern.
  const polishByParticipant = buildAssignmentMap(best);
  if (phantomContext) {
    for (const pa of phantomContext.phantomAssignments) addToAssignmentMap(polishByParticipant, pa);
  }
  const polishByTask = new Map<string, Assignment[]>();
  for (const a of best) {
    const list = polishByTask.get(a.taskId);
    if (list) list.push(a);
    else polishByTask.set(a.taskId, [a]);
  }

  const polishCtx: ScoreContext = {
    taskMap,
    pMap,
    assignmentsByParticipant: polishByParticipant,
    assignmentsByTask: polishByTask,
    capacities,
    notWithPairs,
    dayStartHour,
    phantomTaskIds: phantomContext?.phantomTaskIds,
  };

  const incScorer = IncrementalScorer.build(tasks, participants, best, config, polishCtx);
  let currentComposite = incScorer.compositeScore;

  for (let pass = 0; pass < MAX_POLISH_PASSES; pass++) {
    let improvedThisPass = false;
    let passReplacements = 0;
    let passDelta = 0;

    // Snapshot the assignment array so mid-pass mutations don't shift indices
    // we're about to visit. `best[i]` may be replaced as we commit; we only
    // mutate `participantId` in place, never reorder.
    const passSnapshot = [...best];

    for (const a of passSnapshot) {
      // Stop / abort handling — mirror SA loop's check (line 1531).
      if (Date.now() - startTime > config.maxSolverTimeMs || abortSignal?.aborted || stopSignal?.aborted) {
        // Still record what this partial pass accomplished before bailing.
        if (improvedThisPass) recordPolishPass(passReplacements, passDelta);
        return;
      }

      // Skip pinned / manual / frozen incumbents — same gate as SA.
      if (pinnedIds.has(a.id) || a.status === AssignmentStatus.Manual || a.status === AssignmentStatus.Frozen) continue;

      const task = taskMap.get(a.taskId);
      if (!task) continue;

      // Skip sameGroupRequired — within-group is SA's job, cross-group is
      // infeasible for a single replacement primitive.
      if (task.sameGroupRequired) continue;

      const slot = task.slots.find((s) => s.slotId === a.slotId);
      if (!slot) continue;

      const incumbentPid = a.participantId;
      const incumbentList = polishByParticipant.get(incumbentPid);
      if (!incumbentList) continue; // defensive

      let bestDelta = 0;
      let bestCandidate: Participant | null = null;

      for (const cand of participants) {
        if (cand.id === incumbentPid) continue;

        const candList = polishByParticipant.get(cand.id) ?? [];

        // HC-7: candidate cannot already be in this task
        const taskAssigns = polishByTask.get(a.taskId) ?? [];
        if (taskAssigns.some((c) => c.participantId === cand.id)) continue;

        // Authoritative HC gate
        if (!isEligibleForSlot(cand, task, slot, candList, taskMap, disabledHC, restRuleMap, scheduleContext)) continue;

        // Save scorer state before any mutation. saveParticipant snapshots the
        // perParticipant cache; recomputeForSwap will rebuild from the (newly
        // mutated) byParticipant index.
        const savedI = incScorer.saveParticipant(incumbentPid);
        const savedC = incScorer.saveParticipant(cand.id);
        if (!savedI || !savedC) continue;

        // Apply trial replacement to indices and assignment object
        const incIdx = incumbentList.indexOf(a);
        if (incIdx === -1) continue; // defensive
        incumbentList.splice(incIdx, 1);
        a.participantId = cand.id;
        let candListEntry = polishByParticipant.get(cand.id);
        if (!candListEntry) {
          candListEntry = [];
          polishByParticipant.set(cand.id, candListEntry);
        }
        candListEntry.push(a);

        const newComposite = incScorer.recomputeForSwap(incumbentPid, cand.id);
        const delta = newComposite - currentComposite;

        // Always undo the trial; we commit only the best candidate at the end.
        a.participantId = incumbentPid;
        // Remove from candidate list
        const candIdx = candListEntry.indexOf(a);
        if (candIdx !== -1) candListEntry.splice(candIdx, 1);
        if (candListEntry.length === 0 && candList.length === 0) polishByParticipant.delete(cand.id);
        // Restore to incumbent list at the same position (push is fine — order
        // within the list does not affect scoring or eligibility).
        incumbentList.push(a);
        // Restore scorer state
        incScorer.restoreParticipant(incumbentPid, savedI);
        incScorer.restoreParticipant(cand.id, savedC);
        incScorer.finalizeUndo();

        if (delta > bestDelta + 1e-6) {
          bestDelta = delta;
          bestCandidate = cand;
        }
      }

      if (bestCandidate && bestDelta > 1e-6) {
        // Commit the best replacement permanently.
        const incIdx = incumbentList.indexOf(a);
        if (incIdx === -1) continue; // defensive
        incumbentList.splice(incIdx, 1);
        a.participantId = bestCandidate.id;
        a.updatedAt = new Date();
        let committedList = polishByParticipant.get(bestCandidate.id);
        if (!committedList) {
          committedList = [];
          polishByParticipant.set(bestCandidate.id, committedList);
        }
        committedList.push(a);
        currentComposite = incScorer.recomputeForSwap(incumbentPid, bestCandidate.id);
        improvedThisPass = true;
        passReplacements++;
        passDelta += bestDelta;
      }
    }

    if (!improvedThisPass) break;
    recordPolishPass(passReplacements, passDelta);
  }
}

// ─── Post-Polish Structural Refinement (quality split / merge) ───────────────

/** Anti-oscillation: an occurrence is touched at most once per optimize()
 *  run, and the sweep runs at most this many passes (mirrors
 *  MAX_POLISH_PASSES' bounded-deterministic shape).
 *
 *  Mutable only so benchmark scripts can sweep this parameter (see
 *  `_benchSetMaxStructuralPasses`). Production code never reassigns it —
 *  the constant 2 is the product value. */
let MAX_STRUCTURAL_PASSES = 2;
/** @internal Bench-only override. Pass `null` to restore the product default
 *  of 2. Has zero effect on production code paths (never called there). */
export function _benchSetMaxStructuralPasses(n: number | null): void {
  MAX_STRUCTURAL_PASSES = n ?? 2;
}
/** Strict-improvement margin (polish's convention). The economic gate is
 *  `config.splitPenalty` itself — already inside the composite via
 *  `countSplitOccurrences` — so this is only a churn guard. */
const STRUCT_EPS = 1e-6;

/**
 * Deterministic structural refinement, run AFTER `polishReplaceWithIdle`,
 * BETWEEN SA invocations (the SA loop never sees a changed task set, so the
 * run-constant `IncrementalScorer._splitPenalty` stays valid — Option B).
 *
 * Two operations, MERGE first then QUALITY-SPLIT, each committed only on a
 * strict full-`computeScheduleScore` composite improvement (the re-based
 * `splitPenalty` is inside that composite, so it is the real gate):
 *  - MERGE  — collapse a split slot's `#a`/`#b` back to one whole slot worked
 *             by ONE person (drops that slot's split penalty). The natural
 *             anti-proliferation guard; also reclaims feasibility splits SA
 *             later made unnecessary.
 *  - SPLIT  — realise every slot of a fully-filled `splittable` occurrence as
 *             two halves worked by two different people, when the
 *             fairness/rest/balance gain beats `splitPenalty`.
 *
 * Scope: MERGE handles both non-`sameGroupRequired` and `sameGroupRequired`
 * occurrences — for the latter the merged whole slot's incumbent is filtered
 * to the link's surviving group via `pickEligible`'s `requiredGroup`
 * parameter (HC-8 guarantees surviving link members all share one group),
 * and the no-residual branch stamps `sameGroupLinkId` so still-split sibling
 * slots stay coordinated. QUALITY-SPLIT remains non-`sameGroupRequired`-only:
 * cross-group rotation is SA's job (swap + insert), and intra-group
 * reshuffling is already reachable via within-group SA swaps — extending
 * QUALITY-SPLIT would require pulling Stage-4's group-cover matcher into a
 * deterministic Phase-2 path, which is not earned by current evidence.
 *
 * Safety: a candidate is viable ONLY if every affected slot is fully staffed
 * by HC-eligible participants (`isEligibleForSlot` — the authoritative
 * per-placement check incl. HC-16/12/14/15/5/1). Structural moves never
 * create an unfilled slot, so the soft-only composite (which does not see
 * unfilled slots) can't be fooled into accepting a hidden gap.
 *
 * Identity fast path: when no task is `splittable` and none is already split,
 * returns the SAME `tasks`/`assignments` refs, `changed:false` — zero cost,
 * byte-identical to splitting-off behaviour.
 */
export function structuralRefine(
  best: Assignment[],
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  pinnedIds: Set<string>,
  pMap: Map<string, Participant>,
  phantomContext: PhantomContext | undefined,
  disabledHC: Set<string> | undefined,
  restRuleMap: Map<string, number> | undefined,
  dayStartHour: number,
  capacities: Map<string, ParticipantCapacity>,
  notWithPairs: Map<string, Set<string>>,
  scheduleContext: ScheduleContext | undefined,
  /** Tri-state splitting mode gate:
   *  - `true` (quality mode): MERGE uses strict composite gain; QUALITY-SPLIT runs.
   *  - `false` (feasibility mode): MERGE uses non-strict "not worse" gate
   *    (with `config.splitPenalty` substituted to 0 upstream so the composite
   *    excludes split cost on both sides); QUALITY-SPLIT is skipped. */
  qualitySplitEnabled: boolean,
): { tasks: Task[]; assignments: Assignment[]; changed: boolean } {
  // Identity fast path — nothing splittable and nothing already split.
  let anySplittable = false;
  let anySplit = false;
  for (const t of tasks) {
    if (t.splittable) anySplittable = true;
    if (t.splitGroupId !== undefined) anySplit = true;
    if (anySplittable && anySplit) break;
  }
  if (!anySplittable && !anySplit) return { tasks, assignments: best, changed: false };

  const isPinnedLike = (a: Assignment): boolean =>
    pinnedIds.has(a.id) || a.status === AssignmentStatus.Manual || a.status === AssignmentStatus.Frozen;

  const buildByParticipant = (asgs: Assignment[]): Map<string, Assignment[]> => {
    const m = buildAssignmentMap(asgs);
    if (phantomContext) for (const pa of phantomContext.phantomAssignments) addToAssignmentMap(m, pa);
    return m;
  };
  const taskMapOf = (ts: Task[]): Map<string, Task> => {
    const m = new Map<string, Task>();
    for (const t of ts) m.set(t.id, t);
    if (phantomContext) for (const pt of phantomContext.phantomTasks) m.set(pt.id, pt);
    return m;
  };
  const compositeOf = (ts: Task[], asgs: Assignment[]): number => {
    const tm = taskMapOf(ts);
    const bp = buildByParticipant(asgs);
    const bt = new Map<string, Assignment[]>();
    for (const a of asgs) {
      const l = bt.get(a.taskId);
      if (l) l.push(a);
      else bt.set(a.taskId, [a]);
    }
    const ctx: ScoreContext = {
      taskMap: tm,
      pMap,
      assignmentsByParticipant: bp,
      assignmentsByTask: bt,
      capacities,
      notWithPairs,
      dayStartHour,
      phantomTaskIds: phantomContext?.phantomTaskIds,
    };
    return computeScheduleScore(ts, participants, asgs, config, ctx).compositeScore;
  };
  // Deterministic least-loaded-eligible pick (no Math.random — multi-attempt
  // determinism). `exclude` enforces HC-16's two-different-people per split
  // slot at selection time (isEligibleForSlot re-checks it authoritatively).
  // `tm` MUST be the full candidate task map (built via `taskMapOf`):
  // checkEligibility resolves the participant's OTHER assignments via taskMap
  // (HC-5 double-booking, HC-12/HC-14/HC-15/HC-16) — a single-task map would
  // silently skip every cross-task hard constraint and let an infeasible
  // staffing through. `bp` MUST be the per-participant assignment index
  // built via `buildByParticipant` (which seeds phantom assignments). Callers
  // hoist both out of inner loops to avoid rebuilding maps that haven't
  // changed; when a placement is committed inside a loop, callers update `bp`
  // incrementally via `addToAssignmentMap` to keep it in sync with the
  // assignment list passed to subsequent picks.
  const pickEligible = (
    task: Task,
    slot: SlotRequirement,
    tm: Map<string, Task>,
    bp: Map<string, Assignment[]>,
    loadByPid: Map<string, number>,
    exclude: string | null,
    /** Link-aware group filter used by same-group MERGE: when set, only
     *  participants whose `group` matches are considered. HC-8 guarantees the
     *  link's surviving members all share one group; filtering here keeps the
     *  merged whole slot inside that group without rebuilding the
     *  `taskAssignments` / `participantMap` payload `checkEligibility` would
     *  need to fire its HC-4 branch. Default `undefined` = no filter, which
     *  preserves byte-identical behavior for every non-same-group caller. */
    requiredGroup?: string,
  ): Participant | null => {
    let bestP: Participant | null = null;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const p of participants) {
      if (exclude !== null && p.id === exclude) continue;
      if (requiredGroup !== undefined && p.group !== requiredGroup) continue;
      if (!isEligibleForSlot(p, task, slot, bp.get(p.id) || [], tm, disabledHC, restRuleMap, scheduleContext)) {
        continue;
      }
      const load = loadByPid.get(p.id) ?? 0;
      if (load < bestLoad - 1e-9 || (Math.abs(load - bestLoad) <= 1e-9 && (bestP === null || p.id < bestP.id))) {
        bestLoad = load;
        bestP = p;
      }
    }
    return bestP;
  };
  const loadMapOf = (asgs: Assignment[], tm: Map<string, Task>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of asgs) {
      const t = tm.get(a.taskId);
      if (!t) continue;
      m.set(a.participantId, (m.get(a.participantId) ?? 0) + computeTaskEffectiveHours(t));
    }
    return m;
  };

  // Participant→group lookup, built once. Used by same-group MERGE to derive
  // the link's surviving-member group (passed as `requiredGroup` to
  // `pickEligible`). Mirrors the Stage-4 `splitSameGroup` index pattern.
  const groupOf = new Map<string, string>();
  for (const p of participants) groupOf.set(p.id, p.group);

  let workTasks = tasks;
  let workAsgs = best;
  let changed = false;
  const touched = new Set<string>(); // occurrence ids modified this run

  for (let pass = 0; pass < MAX_STRUCTURAL_PASSES; pass++) {
    let committedThisPass = false;
    let baseComposite = compositeOf(workTasks, workAsgs);

    // ── MERGE first ──────────────────────────────────────────────────────
    // Group the split halves present in workTasks by splitGroupId.
    const pairs = new Map<string, { a?: Task; b?: Task }>();
    for (const t of workTasks) {
      if (t.splitGroupId === undefined || t.splitPart === undefined) continue;
      let e = pairs.get(t.splitGroupId);
      if (!e) {
        e = {};
        pairs.set(t.splitGroupId, e);
      }
      if (t.splitPart === 1) e.a = t;
      else e.b = t;
    }
    for (const sgId of [...pairs.keys()].sort()) {
      const { a: Sa, b: Sb } = pairs.get(sgId)!;
      if (!Sa || !Sb) continue;
      const occId = Sa.splitOccurrenceId;
      if (occId === undefined || touched.has(occId)) continue;
      const residual = workTasks.find((t) => t.id === occId && t.splitGroupId === undefined);
      // Occurrence task ids whose assignments must be free of pin/Manual/Frozen.
      const occTaskIds = new Set<string>([Sa.id, Sb.id]);
      if (residual) occTaskIds.add(residual.id);
      if (workAsgs.some((x) => occTaskIds.has(x.taskId) && isPinnedLike(x))) continue;

      // Link-awareness for same-group MERGE. `requiredGroup` is the group of
      // any surviving link member's incumbent — HC-8 guarantees they all
      // share one group — passed to `pickEligible` so the merged whole slot
      // stays inside that group. `linkHasOtherSurvivors` also decides the
      // no-residual branch's `sameGroupLinkId` stamp so still-split sibling
      // slots remain coordinated. For non-same-group splits Sa.sameGroupLinkId
      // is undefined ⇒ both stay undefined ⇒ byte-identical to prior behavior.
      let requiredGroup: string | undefined;
      let linkHasOtherSurvivors = false;
      if (Sa.sameGroupLinkId !== undefined) {
        const survivingIds = new Set<string>();
        for (const t of workTasks) {
          if (t.id === Sa.id || t.id === Sb.id) continue;
          if (t.sameGroupLinkId === Sa.sameGroupLinkId) survivingIds.add(t.id);
        }
        linkHasOtherSurvivors = survivingIds.size > 0;
        if (linkHasOtherSurvivors) {
          for (const a of workAsgs) {
            if (survivingIds.has(a.taskId)) {
              const g = groupOf.get(a.participantId);
              if (g !== undefined) {
                requiredGroup = g;
                break;
              }
            }
          }
        }
      }

      // Reconstruct the whole slot from #a's slot (slotId === base + '#a').
      const halfSlot = Sa.slots[0];
      const baseSlotId = halfSlot.slotId.slice(0, -2);
      const wholeSlot: SlotRequirement = { ...halfSlot, slotId: baseSlotId };

      let candTasks: Task[];
      let wholeTaskId: string;
      let wholeTask: Task;
      if (residual) {
        const merged: Task = {
          ...residual,
          slots: [...residual.slots, wholeSlot],
          requiredCount: residual.slots.length + 1,
        };
        wholeTask = merged;
        wholeTaskId = merged.id;
        candTasks = workTasks.filter((t) => t.id !== Sa.id && t.id !== Sb.id && t.id !== residual.id);
        candTasks.push(merged);
      } else {
        // No residual task for this occurrence (single-slot occurrence whose
        // residual Stage-4 dropped, OR every slot is split so no id===occId
        // task exists). Reconstruct THIS slot as a fresh whole task keyed by
        // the occurrence id — structurally identical to a Stage-4 residual
        // (id===occId, no split fields), so any still-split sibling slots stay
        // valid as a slot-level mixed whole+split occurrence. Never mutate.
        //
        // For same-group MERGE in a mixed-split state (other slot pairs of
        // this occurrence are still split), the merged whole task MUST keep
        // `sameGroupLinkId = occId` so HC-8 continues to treat residual +
        // siblings as one link unit. When this MERGE empties the link (no
        // other surviving members), the whole task stands alone and
        // `sameGroupLinkId` is undefined — HC-8 then validates it as a
        // non-linked sameGroupRequired single-slot task (trivially passes).
        const whole: Task = {
          ...Sa,
          id: occId,
          name: Sa.name.replace(/ \(1\/2\)$/, ''),
          timeBlock: { start: new Date(Sa.timeBlock.start), end: new Date(Sb.timeBlock.end) },
          slots: [wholeSlot],
          requiredCount: 1,
          splitGroupId: undefined,
          splitPart: undefined,
          splitOriginalMs: undefined,
          splitOccurrenceId: undefined,
          sameGroupLinkId: Sa.sameGroupRequired && linkHasOtherSurvivors ? occId : undefined,
        };
        wholeTask = whole;
        wholeTaskId = whole.id;
        candTasks = workTasks.filter((t) => t.id !== Sa.id && t.id !== Sb.id);
        candTasks.push(whole);
      }

      // Drop the two half-assignments; staff the reconstructed whole slot with
      // ONE eligible participant. No eligible participant ⇒ the merge would
      // create an unfilled slot (which the soft composite cannot see) ⇒ skip.
      const candAsgs = workAsgs.filter((x) => x.taskId !== Sa.id && x.taskId !== Sb.id);
      const candTm = taskMapOf(candTasks);
      const candBp = buildByParticipant(candAsgs);
      const loadByPid = loadMapOf(candAsgs, candTm);
      const chosen = pickEligible(wholeTask, wholeSlot, candTm, candBp, loadByPid, null, requiredGroup);
      if (!chosen) continue;
      candAsgs.push({
        id: nextAssignmentId(),
        taskId: wholeTaskId,
        slotId: wholeSlot.slotId,
        participantId: chosen.id,
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      });

      const candComposite = compositeOf(candTasks, candAsgs);
      // MERGE gate: strict gain in quality mode, "not worse" in feasibility
      // mode. In feasibility mode `config.splitPenalty` is 0 upstream, so
      // compositeOf excludes split cost on both sides and this is literally
      // "merged is not worse on soft score alone".
      const mergeAccepts = qualitySplitEnabled
        ? candComposite > baseComposite + STRUCT_EPS
        : candComposite >= baseComposite - STRUCT_EPS;
      if (mergeAccepts) {
        workTasks = candTasks;
        workAsgs = candAsgs;
        changed = true;
        committedThisPass = true;
        touched.add(occId);
        baseComposite = candComposite;
      }
    }

    // ── QUALITY SPLIT (quality mode only) ────────────────────────────────
    if (!qualitySplitEnabled) {
      if (!committedThisPass) break;
      continue;
    }
    const splitCandidates = workTasks
      .filter(
        (t) =>
          t.splittable === true &&
          t.splitGroupId === undefined &&
          t.sameGroupRequired !== true &&
          !touched.has(t.id) &&
          t.slots.length > 0,
      )
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    for (const T of splitCandidates) {
      const startMs = T.timeBlock.start.getTime();
      const endMs = T.timeBlock.end.getTime();
      const midMs = startMs + Math.floor((endMs - startMs) / 2);
      if (midMs <= startMs || midMs >= endMs) continue; // too short to halve

      // Every slot of T must currently be filled (quality split only re-shapes
      // a feasible whole occurrence; unfilled slots are Stage-4's job) and free
      // of pin/Manual/Frozen.
      const tAssigns = workAsgs.filter((x) => x.taskId === T.id);
      if (tAssigns.length < T.slots.length) continue;
      if (tAssigns.some(isPinnedLike)) continue;
      const filledSlotIds = new Set(tAssigns.map((x) => x.slotId));
      if (!T.slots.every((s) => filledSlotIds.has(s.slotId))) continue;

      // Build the candidate: drop T + its assignments, add #a/#b per slot,
      // staff each with two DIFFERENT eligible people (least-loaded).
      // `halves` is appended in slot-major order — halves[2i] is the #a half
      // and halves[2i+1] is the #b half of T.slots[i] — so the per-slot loop
      // reads them by position rather than by `.find` over the slotId suffix.
      const halves: Task[] = [];
      for (const s of T.slots) {
        halves.push(makeSplitHalf(T, 1, startMs, midMs, s));
        halves.push(makeSplitHalf(T, 2, midMs, endMs, s));
      }
      const candTasks = workTasks.filter((t) => t.id !== T.id).concat(halves);
      let candAsgs = workAsgs.filter((x) => x.taskId !== T.id);
      // `candTasks` is stable across the slot loop (only `candAsgs` grows),
      // so the task map is built once. `candBp` (per-participant assignment
      // index) is built once and updated incrementally via
      // `addToAssignmentMap` after each #a/#b placement, so the next pick
      // sees the participant's freshly-added half without a full rebuild.
      const candTm = taskMapOf(candTasks);
      const candBp = buildByParticipant(candAsgs);
      let feasible = true;
      for (let i = 0; i < T.slots.length; i++) {
        const Sa = halves[2 * i];
        const Sb = halves[2 * i + 1];
        const la = loadMapOf(candAsgs, candTm);
        const pa = pickEligible(Sa, Sa.slots[0], candTm, candBp, la, null);
        if (!pa) {
          feasible = false;
          break;
        }
        const newAsgA: Assignment = {
          id: nextAssignmentId(),
          taskId: Sa.id,
          slotId: Sa.slots[0].slotId,
          participantId: pa.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        candAsgs = candAsgs.concat(newAsgA);
        addToAssignmentMap(candBp, newAsgA);
        const lb = loadMapOf(candAsgs, candTm);
        const pb = pickEligible(Sb, Sb.slots[0], candTm, candBp, lb, pa.id);
        if (!pb) {
          feasible = false;
          break;
        }
        const newAsgB: Assignment = {
          id: nextAssignmentId(),
          taskId: Sb.id,
          slotId: Sb.slots[0].slotId,
          participantId: pb.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        candAsgs = candAsgs.concat(newAsgB);
        addToAssignmentMap(candBp, newAsgB);
      }
      if (!feasible) continue;

      const candComposite = compositeOf(candTasks, candAsgs);
      if (candComposite > baseComposite + STRUCT_EPS) {
        workTasks = candTasks;
        workAsgs = candAsgs;
        changed = true;
        committedThisPass = true;
        touched.add(T.id);
        baseComposite = candComposite;
      }
    }

    if (!committedThisPass) break;
  }

  return { tasks: workTasks, assignments: workAsgs, changed };
}

// ─── Main Optimize Function ──────────────────────────────────────────────────

export interface OptimizationResult {
  assignments: Assignment[];
  score: ScheduleScore;
  feasible: boolean;
  unfilledSlots: UnfilledSlot[];
  iterations: number;
  durationMs: number;
  actualAttempts: number;
  /** Per-phase wall-clock breakdown of the most recent `optimize()` call. For
   *  multi-attempt results these reflect the final/best attempt only.
   *  Always-on (cheap timestamp arithmetic). */
  phaseDurations: { greedyMs: number; saMs: number; polishMs: number };
  /** Per-phase composite scores (post-greedy / post-SA / post-polish=final).
   *  Cheap to populate (values already computed inside the pipeline) and
   *  consumed by diagnostics — feel free to ignore in non-diag callers. */
  phaseScores: { postGreedy: number; postSA: number; final: number };
  /** Greedy phase's original unfilled-slot list — preserved here for
   *  diagnostics. Differs from `unfilledSlots`: that field is the post-SA-
   *  insert remaining set; this one captures what greedy alone left behind. */
  greedyUnfilledSlots: UnfilledSlot[];
  /** 1-indexed attempt index at which `best` was last updated. Populated by
   *  `optimizeMultiAttempt` / `optimizeMultiAttemptAsync`; undefined for
   *  single-attempt `optimize()` calls. Used by the priority bench
   *  ([src/bench-priority/]) to measure ordering quality — a lower value
   *  means the ordering reached the good region of solution space faster,
   *  with less downstream SA repair. Zero (when populated) means no attempt
   *  in this call improved over the seed (continuation mode only). */
  attemptOfBest?: number;
  /**
   * The realized task set this result was scored/validated against. Equals
   * the input `tasks` reference unless a feasibility split (Stage 4) replaced
   * an occurrence with two halves. Consumers (`_commitOptimizationResult`,
   * `continueOptimizationAsync`) read `result.tasks ?? tasks` so the frozen
   * schedule, validation and continuation seed all use the same list.
   * Optional: older/seed results without it fall back to the input list.
   */
  tasks?: Task[];
}

/**
 * Full optimization pipeline: greedy + local search.
 */
export function optimize(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  pinnedAssignments: Assignment[] = [],
  disabledHC?: Set<string>,
  taskOrderJitter: number = 0,
  phantomContext?: PhantomContext,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  certLabelResolver?: (certId: string) => string,
  abortSignal?: AbortSignal,
  ctx?: SchedulingContext,
  saIntensifyTaskIds?: Set<string>,
  scheduleContext?: ScheduleContext,
  stopSignal?: AbortSignal,
  /** Splitting mode gate forwarded to `localSearchOptimize` →
   *  `structuralRefine`. See `localSearchOptimize`'s parameter doc. */
  qualitySplitEnabled: boolean = true,
): OptimizationResult {
  const startTime = Date.now();

  // Build SchedulingContext on-demand for callers that didn't pre-build.
  // Multi-attempt drivers pass a pre-built ctx so we don't repeat this
  // O(T×S×P) work per attempt.
  const schedulingCtx = ctx ?? buildSchedulingContext(tasks, participants);

  // Pre-compute per-participant capacities once. Shared across greedy,
  // local search, polish, and final scoring so all phases see the same
  // capacity-proportional view of the world.
  let schedStart = tasks[0]?.timeBlock.start ?? new Date();
  let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const capacities = computeAllCapacities(participants, schedStart, schedEnd, dayStartHour);

  // Phase 1: Greedy construction
  const greedyStartMs = Date.now();
  const greedy = greedyAssign(
    tasks,
    participants,
    pinnedAssignments,
    disabledHC,
    taskOrderJitter,
    phantomContext,
    restRuleMap,
    dayStartHour,
    schedulingCtx,
    scheduleContext,
    certLabelResolver,
    capacities,
  );
  const greedyMs = Date.now() - greedyStartMs;
  recordPhase('greedy', greedyMs);

  // The SA-input task set: identical reference to `tasks` unless a Stage-4
  // feasibility split replaced an occurrence with two halves. The post-polish
  // structural-refine pass may further change the realized list (quality
  // split / merge) — see `realizedTasks` below; validation, scoring and the
  // result must all agree on THAT list.
  const effectiveTasks = greedy.tasks;

  // Phase 2: Local search improvement (also tries to fill unfilled slots).
  // `tasks.length` (pre-split) seeds the SA temperature so a split that grows
  // the list cannot fall off the 40-task cliff.
  const lsResult = localSearchOptimize(
    effectiveTasks,
    participants,
    greedy.assignments,
    config,
    disabledHC,
    greedy.unfilledSlots,
    phantomContext,
    restRuleMap,
    dayStartHour,
    greedy.pinnedIds,
    abortSignal,
    saIntensifyTaskIds,
    scheduleContext,
    stopSignal,
    tasks.length,
    qualitySplitEnabled,
  );

  // The realized task set after greedy Stage-4 AND the post-polish structural
  // refinement (quality split / merge). Same ref as `effectiveTasks` when the
  // structural pass committed nothing. Validation, final scoring and the
  // result all use THIS list so they agree with `lsResult.assignments`.
  const realizedTasks = lsResult.tasks ?? effectiveTasks;

  // Remove slots that SA managed to fill. Match on (taskId, slotId) — slotId
  // alone is only unique within a task, so two unfilled tasks can share an id.
  const filledKeys = new Set(lsResult.filledSlots.map((fk) => `${fk.taskId}|${fk.slotId}`));
  const remainingUnfilled = greedy.unfilledSlots.filter((uf) => !filledKeys.has(`${uf.taskId}|${uf.slotId}`));

  // Validate final result. Pass restRuleMap so HC-14 is part of the feasibility
  // verdict — otherwise `validation.valid` (and therefore the schedule's
  // `feasible` flag, which is derived from it) is silently blind to HC-14, while
  // the scheduler's post-optimize validation reports HC-14 violations in
  // `schedule.violations`. That split let `violations` and `feasible` disagree.
  const validation = validateHardConstraints(
    realizedTasks,
    participants,
    lsResult.assignments,
    disabledHC,
    restRuleMap,
    certLabelResolver,
    undefined,
    scheduleContext,
  );

  // Reuse the capacities computed at the top of optimize() — same inputs
  // (participants, schedule window, dayStartHour) produce the same map, so
  // computing it twice is wasted work.
  const finalCapacities = capacities;
  // Rebuild notWithPairs for final scoring
  const finalNotWithPairs = new Map<string, Set<string>>();
  for (const p of participants) {
    if (p.notWithIds && p.notWithIds.length > 0) {
      finalNotWithPairs.set(p.id, new Set(p.notWithIds));
    }
  }
  const finalCtx: ScoreContext = {
    taskMap: new Map(realizedTasks.map((t) => [t.id, t])),
    pMap: new Map(participants.map((p) => [p.id, p])),
    capacities: finalCapacities,
    notWithPairs: finalNotWithPairs,
    dayStartHour,
  };
  // Mark the *final* score pass so soft-constraints scoring can capture
  // notWith violator identities for diagnostics. Off-mode short-circuits
  // inside setCapturingFinal — zero cost.
  setCapturingFinal(true);
  const score = computeScheduleScore(realizedTasks, participants, lsResult.assignments, config, finalCtx);
  setCapturingFinal(false);

  return {
    assignments: lsResult.assignments,
    score,
    feasible: validation.valid && remainingUnfilled.length === 0,
    unfilledSlots: remainingUnfilled,
    iterations: lsResult.iterations,
    durationMs: Date.now() - startTime,
    actualAttempts: 1,
    phaseDurations: { greedyMs, saMs: lsResult.saMs, polishMs: lsResult.polishMs },
    phaseScores: {
      postGreedy: lsResult.postGreedyComposite,
      postSA: lsResult.postSAComposite,
      final: score.compositeScore,
    },
    greedyUnfilledSlots: greedy.unfilledSlots.slice(),
    // The realized task set (input `tasks`, possibly + Stage-4 feasibility
    // splits, possibly + post-polish quality split/merge).
    // `_commitOptimizationResult` / continuation read `result.tasks ?? tasks`.
    tasks: realizedTasks,
  };
}

// ─── Multi-Attempt Optimization ──────────────────────────────────────────────

/** Progress callback signature for multi-attempt optimization */
export type MultiAttemptProgressCallback = (info: {
  attempt: number;
  totalAttempts: number;
  currentBestScore: number;
  currentBestFeasible: boolean;
  currentBestUnfilled: number;
  attemptScore: number;
  attemptFeasible: boolean;
  improved: boolean;
}) => void;

/** Build a flat AttemptRow from an OptimizationResult. Only called when diag
 *  is on; copies primitives only (no Assignment / Task / Participant refs). */
/** FNV-1a 32-bit hash of the assignment vector. Stable identity for
 *  detecting solution duplicates across multi-attempt runs. Sorts by the
 *  composite key (taskId|slotId|participantId) — slotId alone is non-unique
 *  across tasks. ~O(slots) per call; only invoked once per attempt. */
function hashAssignments(assignments: Assignment[]): string {
  const keys = assignments
    .map((a) => `${a.taskId}|${a.slotId}|${a.participantId}`)
    .sort()
    .join('\n');
  let h = 0x811c9dc5;
  for (let k = 0; k < keys.length; k++) {
    h ^= keys.charCodeAt(k);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function makeAttemptRow(
  attempt: number,
  r: OptimizationResult,
  improved: boolean,
  bestSoFarComposite: number,
): AttemptRow {
  const s = r.score;
  // Per-attempt polish totals derive from a snapshot diff against the previous
  // attempt — zero changes to the polish loop itself.
  const polishProgress = consumePolishProgressForAttempt();
  return {
    attempt,
    compositeScore: s.compositeScore,
    unfilled: r.unfilledSlots.length,
    feasible: r.feasible,
    improved,
    durationMs: r.durationMs,
    iterations: r.iterations,
    postGreedyComposite: r.phaseScores.postGreedy,
    postSAComposite: r.phaseScores.postSA,
    bestSoFarComposite,
    solutionHash: hashAssignments(r.assignments),
    polishPassesThisAttempt: polishProgress.passes,
    polishDeltaThisAttempt: polishProgress.deltaSum,
    score: {
      minRestHours: s.minRestHours,
      avgRestHours: s.avgRestHours,
      restStdDev: s.restStdDev,
      totalPenalty: s.totalPenalty,
      l0StdDev: s.l0StdDev,
      seniorStdDev: s.seniorStdDev,
      dailyPerParticipantStdDev: s.dailyPerParticipantStdDev,
      dailyGlobalStdDev: s.dailyGlobalStdDev,
      restPerGapBonus: s.restPerGapBonus,
      lowPriorityPenalty: s.lowPriorityPenalty ?? 0,
      notWithPenalty: s.notWithPenalty ?? 0,
      taskPrefPenalty: s.taskPrefPenalty ?? 0,
    },
  };
}

/**
 * Fisher-Yates shuffle (in-place). Returns the same array.
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Compare two optimization results.
 * Returns true if `candidate` is better than `current`.
 *
 * Priority order:
 *  1. Fewer unfilled slots (more tasks filled)
 *  2. Higher composite score (fairness - penalties)
 */
function isBetterResult(candidate: OptimizationResult, current: OptimizationResult): boolean {
  const candUnfilled = candidate.unfilledSlots.length;
  const curUnfilled = current.unfilledSlots.length;

  // Strictly fewer unfilled slots always wins
  if (candUnfilled < curUnfilled) return true;
  if (candUnfilled > curUnfilled) return false;

  // Same number of unfilled — compare composite score
  return candidate.score.compositeScore > current.score.compositeScore;
}

// ─── Elite-boost classification ──────────────────────────────────────────────

/**
 * Derives two *additive* recovery hints from the current best's unfilled slots:
 *
 *   - `boostTaskIds`: **every** unfilled task. Each gets its
 *     `schedulingPriority` dropped by 10 for the next batch, scheduling it a
 *     tier earlier in greedy. Universal by design — classification must never
 *     gate the ordering recovery path, because adjacency failures are often
 *     curable by scheduling the sensitive task *before* its blocker is placed
 *     (only possible via ordering).
 *   - `saIntensifyTaskIds`: adjacency-dominated (HC-12 / HC-14). Passed to
 *     `localSearchOptimize` so SA's insert-move budget *additionally* biases
 *     toward these slots. This is a superset-compatible enrichment — a task
 *     can be in both sets simultaneously and both mechanisms work on it.
 *
 * Rationale for dropping the earlier three-way partition (`infeasibleTaskIds`
 * excluded from boost after N persistent HC-1/HC-2 intervals): the exclusion
 * was a premature optimization. Boosting a truly-infeasible task costs one
 * priority recompute; *not* boosting a fixable task costs an unfilled slot.
 * When the pool shrinks (e.g. a group is removed), transient HC-1/HC-2/HC-12
 * flicker more often, and exclusive classification starved fixable tasks of
 * the recovery path that the original algorithm used universally.
 */
/** @internal exported for test coverage only; consumers should not depend on this shape. */
export interface EliteBoostState {
  boostTaskIds: Set<string>;
  saIntensifyTaskIds: Set<string>;
}

/**
 * Options for `optimizeMultiAttemptAsync` continuation mode.
 *
 * When `seedBest` is provided the loop starts with that result as the initial
 * `best`, so any candidate from this call must strictly improve on it to be
 * accepted. When `continuation` is also true, the deterministic attempt-0 mode
 * (no shuffle, no jitter, no elite boost) is suppressed — that baseline is
 * already in the seed — and `eliteBoost` is pre-seeded from the seed's
 * unfilled slots before the first attempt.
 */
export interface MultiAttemptOpts {
  seedBest?: OptimizationResult;
  continuation?: boolean;
}

/** @internal exported for test coverage only. */
export function classifyUnfilledSlots(unfilled: UnfilledSlot[]): EliteBoostState {
  const state: EliteBoostState = {
    boostTaskIds: new Set(),
    saIntensifyTaskIds: new Set(),
  };
  for (const uf of unfilled) {
    // Universal boost — every unfilled task goes into the ordering recovery path.
    state.boostTaskIds.add(uf.taskId);

    // Additive SA bias — tasks whose reasons are dominated by adjacency
    // (HC-12 / HC-14) also benefit from SA intensification on top of boost.
    const codes = uf.hcCodes ?? [];
    if (codes.includes('HC-12') || codes.includes('HC-14')) {
      state.saIntensifyTaskIds.add(uf.taskId);
    }
  }
  return state;
}

/**
 * Run the optimizer multiple times with shuffled participant order and
 * task-order jitter, keeping the best result. This introduces diversity
 * in both participant ordering and task scheduling priority.
 *
 * @param attempts Number of optimization attempts. REQUIRED — callers must
 *   pass an explicit value. The web app resolves its default via
 *   `getStoredDefaultAttempts()` in `src/web/ui-helpers.ts` (fallback 60).
 * @param onProgress Optional callback fired after each attempt
 */
export function optimizeMultiAttempt(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  pinnedAssignments: Assignment[] = [],
  attempts: number,
  onProgress?: MultiAttemptProgressCallback,
  disabledHC?: Set<string>,
  phantomContext?: PhantomContext,
  restRuleMap?: Map<string, number>,
  certLabelResolver?: (certId: string) => string,
  scheduleContext?: ScheduleContext,
  dayStartHour?: number,
  /** Splitting mode gate forwarded to `optimize`. See `optimize` doc. */
  qualitySplitEnabled: boolean = true,
): OptimizationResult {
  let best: OptimizationResult | null = null;
  let attemptOfBest = 0;
  const totalStart = Date.now();
  resetSnapshot();
  const diagOn = isSchedulerDiagOn();

  // Elite restart: every ELITE_INTERVAL attempts, inspect the current best's
  // unfilled slots and refresh the two additive recovery hints. Every unfilled
  // task gets an ordering boost; adjacency-dominated tasks additionally receive
  // SA insert-move intensification. No task is ever *excluded* from either path.
  // When best is feasible, drop any stale boost so the remaining attempts can
  // optimise fairness/penalty without distortion from old hints — best.unfilled
  // is monotone non-increasing under isBetterResult, so a cleared boost is safe.
  const ELITE_INTERVAL = 20;
  let eliteBoost: EliteBoostState = {
    boostTaskIds: new Set(),
    saIntensifyTaskIds: new Set(),
  };

  // Build SchedulingContext once for the whole multi-attempt run — signals
  // depend only on (tasks, participants), both invariant across attempts.
  const ctx = buildSchedulingContext(tasks, participants);

  for (let i = 0; i < attempts; i++) {
    // Refresh elite-boost hints every ELITE_INTERVAL attempts
    if (best && i > 0 && i % ELITE_INTERVAL === 0) {
      eliteBoost =
        best.unfilledSlots.length > 0
          ? classifyUnfilledSlots(best.unfilledSlots)
          : { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
    }

    // Shuffle participant order to create diversity
    // (first attempt uses original order for determinism)
    const shuffledParticipants = i === 0 ? [...participants] : shuffle([...participants]);

    // Apply elite boost: every unfilled task gets its priority dropped by 10
    // so it schedules one tier earlier in greedy. Adjacency-dominated tasks
    // *additionally* receive SA insert-move bias (see `optimize()` call below)
    // — the two mechanisms are additive, never mutually exclusive.
    const attemptTasks =
      eliteBoost.boostTaskIds.size > 0 && i > 0
        ? tasks.map((t) =>
            eliteBoost.boostTaskIds.has(t.id)
              ? {
                  ...t,
                  schedulingPriority: Math.max(1, (t.schedulingPriority ?? computeStructuralPriority(t, ctx)) - 10),
                }
              : t,
          )
        : tasks;

    // BENCH HOOKS: read per-attempt overrides (no-op when bench hooks unset)
    const benchOv = _benchHooks?.perAttempt?.(i, attempts, tasks.length, participants.length);
    _benchActiveSaTemp = benchOv?.saInitialTemp ?? null;
    _benchActiveRandomSlots = benchOv?.randomizeSlotOrder ?? false;

    // Task-order jitter: 0 for first attempt, 0.3 for subsequent (or bench override)
    const jitter = benchOv?.jitter ?? (i === 0 ? 0 : 0.3);
    setCurrentAttemptIndex(i + 1);
    const result = optimize(
      attemptTasks,
      shuffledParticipants,
      config,
      pinnedAssignments,
      disabledHC,
      jitter,
      phantomContext,
      restRuleMap,
      dayStartHour,
      certLabelResolver,
      undefined,
      ctx,
      eliteBoost.saIntensifyTaskIds.size > 0 ? eliteBoost.saIntensifyTaskIds : undefined,
      scheduleContext,
      undefined,
      qualitySplitEnabled,
    );

    const improved = best === null || isBetterResult(result, best);
    if (improved) {
      best = result;
      attemptOfBest = i + 1;
    }

    if (diagOn) {
      recordAttempt(makeAttemptRow(i + 1, result, improved, best!.score.compositeScore));
      if (result.greedyUnfilledSlots.length > 0) {
        recordGreedyFailures(
          i + 1,
          result.greedyUnfilledSlots.map((u) => {
            const t = tasks.find((tk) => tk.id === u.taskId);
            return {
              taskId: u.taskId,
              taskName: t?.name ?? u.taskId,
              slotId: u.slotId,
              slotLabel: t?.slots.find((s) => s.slotId === u.slotId)?.label ?? u.slotId,
              reason: u.reason,
              hcCodes: u.hcCodes,
            };
          }),
        );
      }
    }

    if (onProgress) {
      onProgress({
        attempt: i + 1,
        totalAttempts: attempts,
        currentBestScore: best!.score.compositeScore,
        currentBestFeasible: best!.feasible,
        currentBestUnfilled: best!.unfilledSlots.length,
        attemptScore: result.score.compositeScore,
        attemptFeasible: result.feasible,
        improved,
      });
    }
  }

  // Update total duration and actual attempts performed
  best!.durationMs = Date.now() - totalStart;
  best!.actualAttempts = attempts;
  best!.attemptOfBest = attemptOfBest;
  finalizeSnapshot(best!.durationMs);

  if (diagOn) {
    console.log(
      `[Scheduler] Multi-attempt done: ${attempts} attempts in ${best!.durationMs}ms — ` +
        `best score ${best!.score.compositeScore.toFixed(2)}, ` +
        `unfilled ${best!.unfilledSlots.length}. ` +
        `Run toggleSchedulerDiag('show') for the report.`,
    );
  }

  return best!;
}

/**
 * Async version of optimizeMultiAttempt that yields to the event loop
 * between attempts, allowing the UI to update progress.
 *
 * Uses batched execution: runs BATCH_SIZE attempts synchronously, then
 * yields once via setTimeout so the browser can repaint the progress
 * overlay. This avoids one setTimeout round-trip per attempt while
 * still keeping the UI responsive.
 *
 * `attempts` is REQUIRED — no library-level default. The web app's
 * effective default lives in `src/web/ui-helpers.ts`
 * (`FALLBACK_DEFAULT_ATTEMPTS`, currently 60), overridable per-user via
 * localStorage.
 */
const ASYNC_BATCH_SIZE = 4;

export function optimizeMultiAttemptAsync(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  pinnedAssignments: Assignment[] = [],
  attempts: number,
  onProgress?: MultiAttemptProgressCallback,
  disabledHC?: Set<string>,
  phantomContext?: PhantomContext,
  restRuleMap?: Map<string, number>,
  dayStartHour: number = 5,
  certLabelResolver?: (certId: string) => string,
  abortSignal?: AbortSignal,
  scheduleContext?: ScheduleContext,
  stopSignal?: AbortSignal,
  opts?: MultiAttemptOpts,
  /** Splitting mode gate forwarded to `optimize`. See `optimize` doc. */
  qualitySplitEnabled: boolean = true,
): Promise<OptimizationResult> {
  return new Promise((resolve, reject) => {
    // Continuation mode: seed `best` from the caller's prior result. Any
    // attempt in this call must strictly beat the seed (per `isBetterResult`)
    // to replace it, so the seed acts as a guaranteed lower bound.
    const seedBest = opts?.seedBest;
    const isContinuation = !!opts?.continuation;
    let best: OptimizationResult | null = seedBest ?? null;
    let attemptOfBest = 0;
    let i = 0;
    let attemptsCompleted = 0;
    const totalStart = Date.now();
    resetSnapshot();
    const diagOn = isSchedulerDiagOn();

    // Elite restart state (same classification as sync version)
    const ELITE_INTERVAL = 20;
    let eliteBoost: EliteBoostState = {
      boostTaskIds: new Set(),
      saIntensifyTaskIds: new Set(),
    };
    // Continuation: pre-seed eliteBoost from the seed's unfilled slots before
    // the first attempt. The normal `i % ELITE_INTERVAL === 0` refresh would
    // only fire at i=20 in this call; seeding now lets attempt 1 already
    // benefit from the hint the original run took up to 20 attempts to build.
    if (isContinuation && best && best.unfilledSlots.length > 0) {
      eliteBoost = classifyUnfilledSlots(best.unfilledSlots);
    }

    // Build SchedulingContext once for the whole multi-attempt run — signals
    // depend only on (tasks, participants), both invariant across attempts.
    const ctx = buildSchedulingContext(tasks, participants);

    function finalizeEarlyStop(): boolean {
      if (!stopSignal?.aborted || best === null) return false;
      best.durationMs = Date.now() - totalStart;
      best.actualAttempts = attemptsCompleted;
      best.attemptOfBest = attemptOfBest;
      finalizeSnapshot(best.durationMs);
      if (diagOn) {
        console.log(
          `[Scheduler] Multi-attempt async early-stopped after ${best.actualAttempts} attempts in ${best.durationMs}ms — ` +
            `best score ${best.score.compositeScore.toFixed(2)}, ` +
            `unfilled ${best.unfilledSlots.length}. ` +
            `Run toggleSchedulerDiag('show') for the report.`,
        );
      }
      resolve(best);
      return true;
    }

    function runBatch(): void {
      try {
        // Check early-stop before abort — returning best is more useful than throwing.
        if (finalizeEarlyStop()) return;
        // Check abort before starting a new batch
        if (abortSignal?.aborted) {
          reject(new DOMException('Schedule generation cancelled', 'AbortError'));
          return;
        }

        const batchEnd = Math.min(i + ASYNC_BATCH_SIZE, attempts);

        while (i < batchEnd) {
          // Check early-stop between attempts — graceful exit with best-so-far.
          if (finalizeEarlyStop()) return;
          // Check abort between attempts within a batch
          if (abortSignal?.aborted) {
            reject(new DOMException('Schedule generation cancelled', 'AbortError'));
            return;
          }

          // Refresh elite-boost hints every ELITE_INTERVAL attempts. When best
          // is feasible, drop any stale boost so subsequent attempts can
          // optimise fairness/penalty without distortion from old hints.
          if (best && i > 0 && i % ELITE_INTERVAL === 0) {
            eliteBoost =
              best.unfilledSlots.length > 0
                ? classifyUnfilledSlots(best.unfilledSlots)
                : { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
          }

          // Shuffle participant order (first attempt uses original order).
          // In continuation mode the deterministic baseline is already in
          // `seedBest`, so even attempt 0 of this call uses shuffle.
          const shuffledParticipants = i === 0 && !isContinuation ? [...participants] : shuffle([...participants]);

          // Apply elite boost: every unfilled task gets priority drop; adjacency-
          // dominated tasks additionally receive SA insert-move bias (additive).
          // In continuation mode the pre-seeded boost applies from attempt 0;
          // in normal mode attempt 0 stays deterministic without any boost.
          const attemptTasks =
            eliteBoost.boostTaskIds.size > 0 && (isContinuation || i > 0)
              ? tasks.map((t) =>
                  eliteBoost.boostTaskIds.has(t.id)
                    ? {
                        ...t,
                        schedulingPriority: Math.max(
                          1,
                          (t.schedulingPriority ?? computeStructuralPriority(t, ctx)) - 10,
                        ),
                      }
                    : t,
                )
              : tasks;

          // Task-order jitter: 0 for first attempt (normal mode only), 0.3 otherwise.
          const jitter = i === 0 && !isContinuation ? 0 : 0.3;
          setCurrentAttemptIndex(i + 1);
          const result = optimize(
            attemptTasks,
            shuffledParticipants,
            config,
            pinnedAssignments,
            disabledHC,
            jitter,
            phantomContext,
            restRuleMap,
            dayStartHour,
            certLabelResolver,
            abortSignal,
            ctx,
            eliteBoost.saIntensifyTaskIds.size > 0 ? eliteBoost.saIntensifyTaskIds : undefined,
            scheduleContext,
            stopSignal,
            qualitySplitEnabled,
          );

          const improved = best === null || isBetterResult(result, best);
          if (improved) {
            best = result;
            attemptOfBest = i + 1;
          }

          i++;
          attemptsCompleted = i;

          if (diagOn) {
            recordAttempt(makeAttemptRow(i, result, improved, best!.score.compositeScore));
            if (result.greedyUnfilledSlots.length > 0) {
              recordGreedyFailures(
                i,
                result.greedyUnfilledSlots.map((u) => {
                  const t = tasks.find((tk) => tk.id === u.taskId);
                  return {
                    taskId: u.taskId,
                    taskName: t?.name ?? u.taskId,
                    slotId: u.slotId,
                    slotLabel: t?.slots.find((s) => s.slotId === u.slotId)?.label ?? u.slotId,
                    reason: u.reason,
                    hcCodes: u.hcCodes,
                  };
                }),
              );
            }
          }

          if (onProgress) {
            onProgress({
              attempt: i,
              totalAttempts: attempts,
              currentBestScore: best!.score.compositeScore,
              currentBestFeasible: best!.feasible,
              currentBestUnfilled: best!.unfilledSlots.length,
              attemptScore: result.score.compositeScore,
              attemptFeasible: result.feasible,
              improved,
            });
          }
        }

        if (i < attempts) {
          // Yield to event loop so the UI can repaint between batches
          setTimeout(runBatch, 0);
        } else {
          best!.durationMs = Date.now() - totalStart;
          best!.actualAttempts = attemptsCompleted;
          best!.attemptOfBest = attemptOfBest;
          finalizeSnapshot(best!.durationMs);
          if (diagOn) {
            console.log(
              `[Scheduler] Multi-attempt async done: ${attempts} attempts in ${best!.durationMs}ms — ` +
                `best score ${best!.score.compositeScore.toFixed(2)}, ` +
                `unfilled ${best!.unfilledSlots.length}. ` +
                `Run toggleSchedulerDiag('show') for the report.`,
            );
          }
          resolve(best!);
        }
      } catch (err) {
        reject(err);
      }
    }

    // Yield once before the first batch so callers awaiting this promise
    // get a paint boundary — their loading UI becomes visible before the
    // (synchronous) attempts start.
    setTimeout(runBatch, 0);
  });
}
