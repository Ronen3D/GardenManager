/**
 * Priority Map Comprehensive Evaluation — Round 3
 *
 * Tests the CURRENT production formula (tiered + bottleneck from computeStructuralPriority)
 * against a broad search space of alternatives organized into 5 families:
 *
 *   Family A: Tier-based variants (refining the current approach)
 *   Family B: Pool/bottleneck-driven variants (data-driven)
 *   Family C: Hybrid/blend variants (multi-signal)
 *   Family D: Aggressive/unconventional formulations
 *   Family E: Fine-tuned refinements of top performers
 *
 * 300 iterations per variant, 20+ variants total.
 * Outputs: per-metric tables, composite ranking, statistical significance indicators.
 *
 * Usage: npx ts-node src/priority-evaluation.ts
 */

import {
  Participant,
  Level,
  Certification,
  Task,
  DEFAULT_CONFIG,
  SchedulerConfig,
} from './models/types';
import { generateDailyTasks } from './tasks/task-definitions';
import { optimize, resetAssignmentCounter } from './engine/optimizer';
import { resetSlotCounter, resetTaskCounter } from './tasks/task-definitions';

// ─── Participant Pool (canonical 24-participant set) ──────────────────────────

const BASE_DATE = new Date(2026, 1, 15);
const DAY_START = new Date(2026, 1, 15, 0, 0);
const DAY_END = new Date(2026, 1, 16, 12, 0);

function createP(
  id: string, name: string, level: Level,
  certs: Certification[], group: string,
): Participant {
  return {
    id, name, level,
    certifications: certs,
    group,
    availability: [{ start: DAY_START, end: DAY_END }],
    dateUnavailability: [],
  };
}

const allParticipants: Participant[] = [
  // Group Alpha (8)
  createP('a1', 'Alpha-01', Level.L0, [Certification.Nitzan], 'Alpha'),
  createP('a2', 'Alpha-02', Level.L0, [Certification.Salsala], 'Alpha'),
  createP('a3', 'Alpha-03', Level.L0, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a4', 'Alpha-04', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a5', 'Alpha-05', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a6', 'Alpha-06', Level.L2, [Certification.Nitzan], 'Alpha'),
  createP('a7', 'Alpha-07', Level.L3, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a8', 'Alpha-08', Level.L4, [Certification.Hamama], 'Alpha'),
  // Group Beta (8)
  createP('b1', 'Beta-01', Level.L0, [Certification.Nitzan], 'Beta'),
  createP('b2', 'Beta-02', Level.L0, [Certification.Salsala, Certification.Nitzan], 'Beta'),
  createP('b3', 'Beta-03', Level.L0, [Certification.Hamama], 'Beta'),
  createP('b4', 'Beta-04', Level.L0, [Certification.Horesh], 'Beta'),
  createP('b5', 'Beta-05', Level.L0, [], 'Beta'),
  createP('b6', 'Beta-06', Level.L2, [], 'Beta'),
  createP('b7', 'Beta-07', Level.L3, [Certification.Hamama], 'Beta'),
  createP('b8', 'Beta-08', Level.L4, [], 'Beta'),
  // Group Gamma (8)
  createP('g1', 'Gamma-01', Level.L0, [Certification.Nitzan, Certification.Salsala], 'Gamma'),
  createP('g2', 'Gamma-02', Level.L0, [Certification.Hamama], 'Gamma'),
  createP('g3', 'Gamma-03', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g4', 'Gamma-04', Level.L0, [Certification.Horesh], 'Gamma'),
  createP('g5', 'Gamma-05', Level.L0, [], 'Gamma'),
  createP('g6', 'Gamma-06', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g7', 'Gamma-07', Level.L3, [Certification.Nitzan], 'Gamma'),
  createP('g8', 'Gamma-08', Level.L4, [Certification.Hamama], 'Gamma'),
];

// ─── Pool Analysis Helper ───────────────────────────────────────────────────

function countEligiblePerSlot(task: Task): { avg: number; min: number; max: number; total: number } {
  let total = 0;
  let min = Infinity;
  let max = 0;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.includes(p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (task.excludedCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    total += eligible;
    if (eligible < min) min = eligible;
    if (eligible > max) max = eligible;
  }
  const avg = total / Math.max(1, task.slots.length);
  if (!isFinite(min)) min = 0;
  return { avg, min, max, total };
}

// ─── Priority Variant Definitions ────────────────────────────────────────────

type PriorityFn = (task: Task) => number;

// ═══════════════════════════════════════════════════════════════════════════════
// BASELINE: Current production formula (computeStructuralPriority)
// ═══════════════════════════════════════════════════════════════════════════════

/** PROD: Current production — tiered + bottleneck (from optimizer.ts) */
function prod_current(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAMILY A: TIER-BASED VARIANTS (refining the current tiered approach)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A1: Compressed tiers — fewer tiers, larger gaps.
 * Tier 0 = group, Tier 1 = penalty+cert+L0-only, Tier 2 = everything else, Tier 3 = light.
 * Rationale: Maybe 5 tiers is too fine-grained; the greedy phase benefits from
 * a simpler ordering with more room for jitter to explore.
 */
function a1_compressedTiers(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors || (allL0Only && hasCerts)) tier = 1; // Merge Hamama+Shemesh
  else if (hasCerts || hasExclusion || (allL0Only && !task.isLight)) tier = 2; // Merge Karov+Mamtera+Aruga
  else tier = 3; // Light + fallback

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

/**
 * A2: Expanded tiers — separate Karov and Mamtera.
 * Mamtera has an exclusion constraint (no Horesh cert) which is unique.
 * Karov has a multi-slot structure with a commander slot.
 */
function a2_expandedTiers(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;
  const hasMixedLevels = task.slots.some(s => s.acceptableLevels.length > 1) &&
    task.slots.some(s => s.acceptableLevels.length === 1);

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;       // Hamama
  else if (allL0Only && hasCerts) tier = 2;           // Shemesh
  else if (hasMixedLevels && hasCerts) tier = 3;      // Karov (mixed levels + certs)
  else if (hasExclusion) tier = 4;                    // Mamtera (exclusion)
  else if (hasCerts) tier = 4;                        // Other cert tasks
  else if (allL0Only && !task.isLight) tier = 5;      // Aruga
  else if (task.isLight) tier = 6;                    // Karovit
  else tier = 4;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

/**
 * A3: Tiers with avg-pool tiebreaker instead of min-pool.
 * Hypothesis: average eligible might be a more stable signal than bottleneck minimum.
 */
function a3_tieredAvgPool(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  // Use average instead of min for tiebreaker
  const { avg } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, Math.round(avg));
  return tier * 10 + subPriority;
}

/**
 * A4: Tiers with no sub-priority (pure tier ordering, random within tier).
 * Tests whether the sub-priority actually helps or just adds noise.
 */
function a4_pureTiers(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  // All tasks in same tier get same priority — random tiebreak by optimizer
  return tier * 10;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAMILY B: POOL/BOTTLENECK-DRIVEN (purely data-driven priority)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * B1: Pure min-eligible bottleneck (no tiers).
 * Just rank by the tightest slot. Light tasks get +15 offset.
 */
function b1_pureBottleneck(task: Task): number {
  if (task.sameGroupRequired) return 0;
  const { min } = countEligiblePerSlot(task);
  let score = Math.min(50, min * 3);
  if (task.isLight) score += 15;
  return Math.max(1, score);
}

/**
 * B2: Harmonic mean of eligible counts across slots.
 * Harmonic mean is more sensitive to small values than arithmetic mean,
 * so it naturally weights bottleneck slots more while considering all slots.
 */
function b2_harmonicMean(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let reciprocalSum = 0;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.includes(p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (task.excludedCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    reciprocalSum += 1 / Math.max(1, eligible);
  }
  const harmonicMean = task.slots.length / reciprocalSum;
  let score = Math.min(50, harmonicMean * 2.5);
  if (task.isLight) score += 15;
  if (task.preferJuniors) score = Math.max(1, score - 8);
  return Math.max(1, score);
}

/**
 * B3: Total constraint density — (slots × constraint features) / eligible.
 * Captures both how many constraints exist AND how tight the pool is.
 */
function b3_constraintDensity(task: Task): number {
  if (task.sameGroupRequired) return 0;

  let constraintFeatures = 0;
  for (const slot of task.slots) {
    constraintFeatures += (5 - slot.acceptableLevels.length); // Fewer levels = more constrained
    constraintFeatures += slot.requiredCertifications.length * 2;
  }
  constraintFeatures += (task.excludedCertifications?.length ?? 0) * 2;
  if (task.preferJuniors) constraintFeatures += 5;

  const { avg } = countEligiblePerSlot(task);
  const density = constraintFeatures / Math.max(1, avg);

  // Higher density → lower score → first
  let score = Math.max(1, 50 - density * 4);
  if (task.isLight) score += 15;
  return Math.max(1, score);
}

/**
 * B4: Slot-count weighted bottleneck.
 * Tasks with more slots have combinatorially harder assignment.
 * Priority = (slots × bottleneck_scarcity).
 */
function b4_slotWeightedBottleneck(task: Task): number {
  if (task.sameGroupRequired) return 0;
  const { min } = countEligiblePerSlot(task);
  // Scarcity factor: invert min eligible
  const scarcity = 1 / Math.max(1, min);
  const difficulty = task.slots.length * scarcity;
  let score = Math.max(1, 50 - difficulty * 12);
  if (task.isLight) score += 15;
  if (task.preferJuniors) score = Math.max(1, score - 5);
  return Math.max(1, score);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAMILY C: HYBRID/BLEND VARIANTS (combining multiple signals)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * C1: Tier-weighted blend — tiers set the range, pool size fine-tunes.
 * Each tier gets a 10-point band, pool fills in 0-9 within band.
 * Same as production but with penalty boost for preferJuniors.
 */
function c1_tierBoostedPenalty(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);

  // Extra: preferJuniors tasks get sub-priority 0 always (highest within tier)
  if (task.preferJuniors) return tier * 10;
  return tier * 10 + subPriority;
}

/**
 * C2: 70% tier-based + 30% continuous bottleneck score.
 * Allows the continuous signal to occasionally override tier boundaries.
 */
function c2_tierContinuousBlend(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  // Tier component: 0-50 scale
  const tierScore = tier * 10;

  // Bottleneck component: 0-50 scale
  const { min } = countEligiblePerSlot(task);
  const bottleneckScore = Math.min(50, min * 3);

  // Blend
  return Math.max(1, Math.round(0.7 * tierScore + 0.3 * bottleneckScore));
}

/**
 * C3: Structural V0-style formula + explicit penalty boost.
 * The original V0 formula with Hamama's priority explicitly lowered.
 */
function c3_v0PenaltyBoosted(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;
  if (task.preferJuniors) score -= 25; // Aggressive Hamama boost
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * C4: Multi-signal with duration awareness.
 * Tier base + bottleneck tiebreak + duration penalty for long tasks.
 */
function c4_tierDuration(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);

  // Duration modifier: long tasks within same tier go first
  const durationHrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3_600_000;
  const durationBoost = durationHrs >= 8 ? -1 : 0; // Long tasks get -1 sub-priority

  return Math.max(1, tier * 10 + Math.max(0, subPriority + durationBoost));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAMILY D: AGGRESSIVE / UNCONVENTIONAL FORMULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * D1: Reverse light ordering — schedule light tasks FIRST.
 * Hypothesis: Light tasks are easy and don't block rest, so placing them first
 * frees up more complex scheduling decisions for later when more state is known.
 */
function d1_lightFirst(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.isLight) tier = 1;                          // Light FIRST
  else if (task.preferJuniors && hasCerts) tier = 2;
  else if (allL0Only && hasCerts) tier = 3;
  else if (hasCerts || hasExclusion) tier = 4;
  else if (allL0Only) tier = 5;
  else tier = 4;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

/**
 * D2: Flat priority — all non-group tasks get same priority.
 * Tests whether task ordering matters at all (null hypothesis).
 * If this performs well, priority is irrelevant.
 */
function d2_flatPriority(task: Task): number {
  if (task.sameGroupRequired) return 0;
  return 25; // Everyone equal
}

/**
 * D3: Inverse of production — schedule "easy" tasks first.
 * Hypothesis: By filling easy tasks first, we leave maximum flexibility
 * for the hard tasks, which benefit more from local search.
 */
function d3_easyFirst(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  // Reverse tier ordering
  let tier: number;
  if (task.isLight) tier = 1;
  else if (allL0Only && !hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && hasCerts) tier = 4;
  else if (task.preferJuniors && hasCerts) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  // Reverse: more eligible → lower score → first
  const subPriority = Math.min(9, Math.max(0, 9 - min));
  return tier * 10 + subPriority;
}

/**
 * D4: Penalty-only priority — only penalized tasks get priority boost.
 * Everything else is flat. Tests whether penalty avoidance is the only
 * thing that matters for priority.
 */
function d4_penaltyOnly(task: Task): number {
  if (task.sameGroupRequired) return 0;
  if (task.preferJuniors) return 5; // Hamama: top priority
  if (task.isLight) return 40;      // Light: low priority
  return 25;                         // Everything else: equal
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAMILY E: FINE-TUNED REFINEMENTS (small adjustments to production)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * E1: Production + Hamama in tier 0 (with Adanit).
 * Most aggressive penalty avoidance: Hamama gets absolute top priority.
 */
function e1_hamamaTier0(task: Task): number {
  if (task.sameGroupRequired) return 0;
  if (task.preferJuniors) return 1; // Hamama: just after group tasks

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

/**
 * E2: Production with wider tier spacing (×15 instead of ×10).
 * Ensures jitter never crosses tier boundaries.
 */
function e2_widerTierSpacing(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(14, min);
  return tier * 15 + subPriority; // ×15 spacing
}

/**
 * E3: Production + Aruga promoted to tier 3.
 * Hypothesis: Aruga (L0-only, no cert) has a decent pool but L0 pressure
 * from Shemesh/Hamama can drain it. Promoting helps.
 */
function e3_arugaPromoted(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion || (allL0Only && !task.isLight)) tier = 3; // Aruga promoted
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

/**
 * E4: Production + geometric mean tiebreaker.
 * Uses sqrt(min × avg) for a more balanced sub-priority signal.
 */
function e4_geometricTiebreak(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  if (task.preferJuniors && hasCerts) tier = 1;
  else if (allL0Only && hasCerts) tier = 2;
  else if (hasCerts || hasExclusion) tier = 3;
  else if (allL0Only && !task.isLight) tier = 4;
  else if (task.isLight) tier = 5;
  else tier = 3;

  const { avg, min } = countEligiblePerSlot(task);
  const geo = Math.sqrt(Math.max(1, min) * avg);
  const subPriority = Math.min(9, Math.round(geo));
  return tier * 10 + subPriority;
}

/**
 * E5: Production + Shemesh/Hamama share tier 1.
 * Both are L0+cert, and the distinction between preferJuniors and not
 * may not matter for greedy ordering since both drain the same pool.
 */
function e5_mergedTier1(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0] === Level.L0);
  const hasExclusion = (task.excludedCertifications?.length ?? 0) > 0;

  let tier: number;
  // Merge: both preferJuniors+cert AND L0-only+cert go to tier 1
  if ((task.preferJuniors && hasCerts) || (allL0Only && hasCerts)) tier = 1;
  else if (hasCerts || hasExclusion) tier = 2;
  else if (allL0Only && !task.isLight) tier = 3;
  else if (task.isLight) tier = 4;
  else tier = 2;

  const { min } = countEligiblePerSlot(task);
  const subPriority = Math.min(9, min);
  return tier * 10 + subPriority;
}

// ─── Variant Registry ────────────────────────────────────────────────────────

const VARIANTS: { name: string; fn: PriorityFn; description: string; family: string }[] = [
  // Baseline
  { name: 'PROD', fn: prod_current, family: 'Baseline', description: 'Current production: tiered + bottleneck' },

  // Family A: Tier variants
  { name: 'A1_compress', fn: a1_compressedTiers, family: 'A:Tier', description: '3 tiers (merge similar)' },
  { name: 'A2_expand', fn: a2_expandedTiers, family: 'A:Tier', description: '6 tiers (separate Karov/Mamtera)' },
  { name: 'A3_avgPool', fn: a3_tieredAvgPool, family: 'A:Tier', description: '5 tiers + avg pool tiebreaker' },
  { name: 'A4_pureTier', fn: a4_pureTiers, family: 'A:Tier', description: '5 tiers, no sub-priority' },

  // Family B: Pool/bottleneck
  { name: 'B1_pureBneck', fn: b1_pureBottleneck, family: 'B:Pool', description: 'Pure min-eligible, no tiers' },
  { name: 'B2_harmonic', fn: b2_harmonicMean, family: 'B:Pool', description: 'Harmonic mean of eligible counts' },
  { name: 'B3_density', fn: b3_constraintDensity, family: 'B:Pool', description: 'Constraint density / eligible' },
  { name: 'B4_slotBneck', fn: b4_slotWeightedBottleneck, family: 'B:Pool', description: 'Slots × bottleneck scarcity' },

  // Family C: Hybrid
  { name: 'C1_tierPen', fn: c1_tierBoostedPenalty, family: 'C:Hybrid', description: 'Tier + forced low sub-pri for preferJuniors' },
  { name: 'C2_blend70', fn: c2_tierContinuousBlend, family: 'C:Hybrid', description: '70% tier + 30% bottleneck continuous' },
  { name: 'C3_v0Pen', fn: c3_v0PenaltyBoosted, family: 'C:Hybrid', description: 'V0 structural + Hamama -25 boost' },
  { name: 'C4_tierDur', fn: c4_tierDuration, family: 'C:Hybrid', description: 'Tier + duration boost for long tasks' },

  // Family D: Aggressive/unconventional
  { name: 'D1_lightFirst', fn: d1_lightFirst, family: 'D:Aggressive', description: 'Light tasks scheduled FIRST' },
  { name: 'D2_flat', fn: d2_flatPriority, family: 'D:Aggressive', description: 'All non-group tasks equal (null hypothesis)' },
  { name: 'D3_easyFirst', fn: d3_easyFirst, family: 'D:Aggressive', description: 'Reverse priority: easy tasks first' },
  { name: 'D4_penOnly', fn: d4_penaltyOnly, family: 'D:Aggressive', description: 'Only boost Hamama, everything else flat' },

  // Family E: Fine-tuned
  { name: 'E1_hamT0', fn: e1_hamamaTier0, family: 'E:Refined', description: 'Hamama at priority 1 (near-Adanit)' },
  { name: 'E2_wide', fn: e2_widerTierSpacing, family: 'E:Refined', description: '×15 tier spacing (jitter-proof)' },
  { name: 'E3_arugaUp', fn: e3_arugaPromoted, family: 'E:Refined', description: 'Aruga promoted to tier 3' },
  { name: 'E4_geoTie', fn: e4_geometricTiebreak, family: 'E:Refined', description: 'Geometric mean tiebreaker' },
  { name: 'E5_merge1', fn: e5_mergedTier1, family: 'E:Refined', description: 'Hamama+Shemesh share tier 1' },
];

// ─── Simulation Engine ───────────────────────────────────────────────────────

const ITERATIONS = 300;

interface RunResult {
  unfilled: number;
  compositeScore: number;
  l0StdDev: number;
  seniorStdDev: number;
  minRestHours: number;
  dailyPerParticipantStdDev: number;
  totalPenalty: number;
  feasible: boolean;
}

interface VariantResult {
  name: string;
  description: string;
  family: string;
  priorityMap: Map<string, number>;
  runs: RunResult[];
}

function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  return {
    mean,
    stdDev,
    min: sorted[0],
    max: sorted[n - 1],
    median: n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)],
    p5: sorted[Math.floor(n * 0.05)],
    p10: sorted[Math.floor(n * 0.10)],
    p25: sorted[Math.floor(n * 0.25)],
    p75: sorted[Math.floor(n * 0.75)],
    p90: sorted[Math.floor(n * 0.90)],
    p95: sorted[Math.floor(n * 0.95)],
    cv: mean !== 0 ? (stdDev / Math.abs(mean)) * 100 : 0,
  };
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function runVariant(variant: typeof VARIANTS[number]): VariantResult {
  const config: SchedulerConfig = {
    ...DEFAULT_CONFIG,
    maxIterations: 5000,
    maxSolverTimeMs: 3000,
  };

  const priorityMap = new Map<string, number>();
  const runs: RunResult[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    resetAssignmentCounter();
    resetSlotCounter();
    resetTaskCounter();
    const tasks = generateDailyTasks(BASE_DATE);

    for (const t of tasks) {
      const pri = variant.fn(t);
      t.schedulingPriority = pri;
      if (i === 0) priorityMap.set(`${t.type}:${t.name}`, pri);
    }

    const participants = i === 0 ? [...allParticipants] : shuffle([...allParticipants]);
    const jitter = i === 0 ? 0 : 0.3;
    const result = optimize(tasks, participants, config, [], undefined, jitter);

    runs.push({
      unfilled: result.unfilledSlots.length,
      compositeScore: result.score.compositeScore,
      l0StdDev: result.score.l0StdDev,
      seniorStdDev: result.score.seniorStdDev,
      minRestHours: result.score.minRestHours,
      dailyPerParticipantStdDev: result.score.dailyPerParticipantStdDev,
      totalPenalty: result.score.totalPenalty,
      feasible: result.feasible,
    });
  }

  return { name: variant.name, description: variant.description, family: variant.family, priorityMap, runs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
console.log('║  PRIORITY MAP COMPREHENSIVE EVALUATION — Round 3                            ║');
console.log(`║  ${ITERATIONS} iterations × ${VARIANTS.length} variants (5 families)${' '.repeat(37)}║`);
console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
console.log();

// ─── Priority Map for all variants ───────────────────────────────────────────

console.log('── PRIORITY MAP COMPARISON (non-group tasks) ──────────────────────');
{
  resetSlotCounter();
  resetTaskCounter();
  const tasks = generateDailyTasks(BASE_DATE);
  const rows: Record<string, string | number>[] = [];
  for (const t of tasks) {
    if (t.sameGroupRequired) continue;
    const pool = countEligiblePerSlot(t);
    const row: Record<string, string | number> = {
      task: t.name,
      type: t.type as string,
      slots: t.slots.length,
      pool_min: pool.min,
      pool_avg: pool.avg.toFixed(1),
    };
    for (const v of VARIANTS) {
      row[v.name] = v.fn(t);
    }
    rows.push(row);
  }
  rows.sort((a, b) => (Number(a['PROD']) || 99) - (Number(b['PROD']) || 99));
  console.table(rows);
}
console.log();

// ─── Run simulations ─────────────────────────────────────────────────────────

const allResults: VariantResult[] = [];
const totalStart = Date.now();

for (const variant of VARIANTS) {
  const vStart = Date.now();
  process.stdout.write(`  ${variant.family.padEnd(14)} ${variant.name.padEnd(14)} (${ITERATIONS} iter)...`);
  const result = runVariant(variant);
  allResults.push(result);
  const elapsed = ((Date.now() - vStart) / 1000).toFixed(1);
  console.log(` ${elapsed}s`);
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
console.log(`\n  Total: ${totalElapsed}s\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('══════════════════════════════════════════════════════════════════════════════');
console.log('  DETAILED RESULTS');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

// Helper to compute difference from PROD baseline
const prodResult = allResults.find(r => r.name === 'PROD')!;
function diffFromProd(variantRuns: RunResult[], metric: keyof RunResult, higherIsBetter: boolean): string {
  const prodVals = prodResult.runs.map(r => r[metric] as number);
  const varVals = variantRuns.map(r => r[metric] as number);
  const prodMean = prodVals.reduce((a, b) => a + b, 0) / prodVals.length;
  const varMean = varVals.reduce((a, b) => a + b, 0) / varVals.length;
  const diff = varMean - prodMean;
  const pct = prodMean !== 0 ? (diff / Math.abs(prodMean)) * 100 : 0;
  const sign = diff > 0 ? '+' : '';
  const better = (higherIsBetter && diff > 0) || (!higherIsBetter && diff < 0);
  const indicator = Math.abs(pct) < 1 ? '≈' : better ? '✓' : '✗';
  return `${sign}${pct.toFixed(1)}% ${indicator}`;
}

// 1. FEASIBILITY
console.log('── 1. FEASIBILITY (unfilled slots) ─────────────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.unfilled);
    const s = computeStats(vals);
    const feasCount = r.runs.filter(run => run.feasible).length;
    rows.push({
      variant: r.name,
      family: r.family,
      'feas%': ((feasCount / ITERATIONS) * 100).toFixed(1) + '%',
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(1),
      p90: s.p90,
      max: s.max,
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'unfilled', false),
    });
  }
  console.table(rows);
}

// 2. COMPOSITE SCORE
console.log('── 2. COMPOSITE SCORE (higher = better) ───────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.compositeScore);
    const s = computeStats(vals);
    rows.push({
      variant: r.name,
      family: r.family,
      mean: s.mean.toFixed(0),
      median: s.median.toFixed(0),
      p25: s.p25.toFixed(0),
      p75: s.p75.toFixed(0),
      stdDev: s.stdDev.toFixed(0),
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'compositeScore', true),
    });
  }
  console.table(rows);
}

// 3. TOTAL PENALTY (key driver)
console.log('── 3. TOTAL PENALTY (lower = better) — key differentiator ─────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.totalPenalty);
    const s = computeStats(vals);
    const zeroCount = vals.filter(v => v === 0).length;
    const tenKCount = vals.filter(v => v >= 9000 && v <= 11000).length;
    const twentyKPlus = vals.filter(v => v >= 19000).length;
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(0),
      'zero%': ((zeroCount / ITERATIONS) * 100).toFixed(1) + '%',
      '10k%': ((tenKCount / ITERATIONS) * 100).toFixed(1) + '%',
      '≥20k%': ((twentyKPlus / ITERATIONS) * 100).toFixed(1) + '%',
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'totalPenalty', false),
    });
  }
  console.table(rows);
}

// 4. L0 FAIRNESS
console.log('── 4. L0 FAIRNESS (workload stdDev — lower = fairer) ──────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.l0StdDev);
    const s = computeStats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p25: s.p25.toFixed(3),
      p75: s.p75.toFixed(3),
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'l0StdDev', false),
    });
  }
  console.table(rows);
}

// 5. SENIOR FAIRNESS
console.log('── 5. SENIOR FAIRNESS (workload stdDev — lower = fairer) ──────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.seniorStdDev);
    const s = computeStats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'seniorStdDev', false),
    });
  }
  console.table(rows);
}

// 6. MIN REST HOURS
console.log('── 6. MIN REST HOURS (higher = better) ────────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.minRestHours).filter(v => isFinite(v));
    if (vals.length === 0) { rows.push({ variant: r.name, mean: 'N/A' }); continue; }
    const s = computeStats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(2),
      p10: s.p10.toFixed(2),
      min: s.min.toFixed(2),
      vs_PROD: r.name === 'PROD' ? '---' : diffFromProd(r.runs, 'minRestHours', true),
    });
  }
  console.table(rows);
}

// 7. STABILITY
console.log('── 7. STABILITY (score CV% — lower = more consistent) ─────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const scoreVals = r.runs.map(run => run.compositeScore);
    const s = computeStats(scoreVals);
    const iqr = s.p75 - s.p25;
    rows.push({
      variant: r.name,
      'CV%': s.cv.toFixed(2) + '%',
      stdDev: s.stdDev.toFixed(0),
      IQR: iqr.toFixed(0),
    });
  }
  console.table(rows);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE RANKING
// ═══════════════════════════════════════════════════════════════════════════════

console.log('══════════════════════════════════════════════════════════════════════════════');
console.log('  WEIGHTED COMPOSITE RANKING');
console.log('  Weights: feasibility=25%, score=20%, penalty=20%, l0Fair=15%,');
console.log('           stability=10%, rest=10%');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

{
  const dims = ['feasibility', 'score', 'penalty', 'l0Fair', 'seniorFair', 'stability', 'rest'] as const;
  const weights: Record<typeof dims[number], number> = {
    feasibility: 0.25,
    score: 0.20,
    penalty: 0.20,
    l0Fair: 0.10,
    seniorFair: 0.05,
    stability: 0.10,
    rest: 0.10,
  };

  type DimMap = Record<typeof dims[number], number>;
  const raw = new Map<string, DimMap>();

  for (const r of allResults) {
    const unf = computeStats(r.runs.map(run => run.unfilled));
    const sc = computeStats(r.runs.map(run => run.compositeScore));
    const l0 = computeStats(r.runs.map(run => run.l0StdDev));
    const sr = computeStats(r.runs.map(run => run.seniorStdDev));
    const pen = computeStats(r.runs.map(run => run.totalPenalty));
    const finiteRest = r.runs.map(run => run.minRestHours).filter(v => isFinite(v));
    const rst = computeStats(finiteRest.length > 0 ? finiteRest : [0]);
    const cv = sc.mean !== 0 ? sc.stdDev / Math.abs(sc.mean) : 0;

    raw.set(r.name, {
      feasibility: unf.mean,
      score: -sc.mean,
      penalty: pen.mean,
      l0Fair: l0.mean,
      seniorFair: sr.mean,
      stability: cv,
      rest: -rst.mean,
    });
  }

  // Rank per dimension
  const ranks = new Map<string, Record<typeof dims[number], number>>();
  for (const dim of dims) {
    const sorted = [...raw.entries()].sort((a, b) => a[1][dim] - b[1][dim]);
    sorted.forEach(([name], idx) => {
      if (!ranks.has(name)) ranks.set(name, {} as Record<typeof dims[number], number>);
      ranks.get(name)![dim] = idx + 1;
    });
  }

  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const rk = ranks.get(r.name)!;
    let weightedRank = 0;
    for (const dim of dims) {
      weightedRank += rk[dim] * (weights[dim] ?? 0);
    }
    rows.push({
      '#': '',
      variant: r.name,
      family: r.family,
      rk_feas: rk.feasibility,
      rk_score: rk.score,
      rk_pen: rk.penalty,
      rk_l0: rk.l0Fair,
      rk_sr: rk.seniorFair,
      rk_stab: rk.stability,
      rk_rest: rk.rest,
      WEIGHTED: weightedRank.toFixed(2),
    });
  }
  rows.sort((a, b) => parseFloat(a['WEIGHTED'] as string) - parseFloat(b['WEIGHTED'] as string));
  rows.forEach((r, i) => { r['#'] = i + 1; });
  console.table(rows);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEAD-TO-HEAD: TOP 5 vs PROD
// ═══════════════════════════════════════════════════════════════════════════════

console.log('══════════════════════════════════════════════════════════════════════════════');
console.log('  HEAD-TO-HEAD: KEY METRICS (mean values, vs PROD baseline)');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

{
  const prodS = {
    unfilled: computeStats(prodResult.runs.map(r => r.unfilled)),
    score: computeStats(prodResult.runs.map(r => r.compositeScore)),
    penalty: computeStats(prodResult.runs.map(r => r.totalPenalty)),
    l0: computeStats(prodResult.runs.map(r => r.l0StdDev)),
    rest: computeStats(prodResult.runs.map(r => r.minRestHours).filter(v => isFinite(v))),
  };

  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const s = {
      unfilled: computeStats(r.runs.map(run => run.unfilled)),
      score: computeStats(r.runs.map(run => run.compositeScore)),
      penalty: computeStats(r.runs.map(run => run.totalPenalty)),
      l0: computeStats(r.runs.map(run => run.l0StdDev)),
      rest: computeStats(r.runs.map(run => run.minRestHours).filter(v => isFinite(v))),
    };

    const zeroPen = r.runs.filter(run => run.totalPenalty === 0).length;
    const prodZeroPen = prodResult.runs.filter(run => run.totalPenalty === 0).length;

    rows.push({
      variant: r.name,
      'unfilled': s.unfilled.mean.toFixed(2),
      'score': s.score.mean.toFixed(0),
      'penalty': s.penalty.mean.toFixed(0),
      'zeroPen%': ((zeroPen / ITERATIONS) * 100).toFixed(1) + '%',
      'l0_sd': s.l0.mean.toFixed(3),
      'rest_h': s.rest.mean.toFixed(2),
      'CV%': s.score.cv.toFixed(1) + '%',
    });
  }
  console.table(rows);

  // Highlight PROD baseline
  console.log(`  PROD baseline: unfilled=${prodS.unfilled.mean.toFixed(2)} score=${prodS.score.mean.toFixed(0)} penalty=${prodS.penalty.mean.toFixed(0)} zeroPen%=${((prodResult.runs.filter(r => r.totalPenalty === 0).length / ITERATIONS) * 100).toFixed(1)}%`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICAL SIGNIFICANCE TEST (Mann-Whitney U approximation)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════════════════════════════════════');
console.log('  STATISTICAL SIGNIFICANCE vs PROD (composite score, two-tailed)');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

{
  const prodScores = prodResult.runs.map(r => r.compositeScore);
  const prodMean = prodScores.reduce((a, b) => a + b, 0) / prodScores.length;
  const prodVar = prodScores.reduce((s, v) => s + (v - prodMean) ** 2, 0) / prodScores.length;

  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    if (r.name === 'PROD') continue;
    const varScores = r.runs.map(run => run.compositeScore);
    const varMean = varScores.reduce((a, b) => a + b, 0) / varScores.length;
    const varVar = varScores.reduce((s, v) => s + (v - varMean) ** 2, 0) / varScores.length;

    // Welch's t-test approximation
    const se = Math.sqrt(prodVar / prodScores.length + varVar / varScores.length);
    const t = se > 0 ? (varMean - prodMean) / se : 0;
    // Approximate p-value from t-statistic (normal approximation for large N)
    const absT = Math.abs(t);
    // Using normal CDF approximation
    const p = 2 * (1 - normalCDF(absT));

    const sig = p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : 'n.s.';
    const direction = varMean > prodMean ? 'better' : varMean < prodMean ? 'worse' : 'same';

    rows.push({
      variant: r.name,
      mean_diff: (varMean - prodMean).toFixed(1),
      direction,
      't_stat': t.toFixed(2),
      'p_approx': p < 0.001 ? '<0.001' : p.toFixed(3),
      significance: sig,
    });
  }
  // Sort by mean_diff descending
  rows.sort((a, b) => parseFloat(b['mean_diff'] as string) - parseFloat(a['mean_diff'] as string));
  console.table(rows);
  console.log('  Significance: *** p<0.001, ** p<0.01, * p<0.05, n.s. not significant');
}

// Normal CDF approximation (Abramowitz & Stegun)
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

console.log('\n══════════════════════════════════════════════════════════════════════════════');
console.log('  FAMILY SUMMARY (best variant per family)');
console.log('══════════════════════════════════════════════════════════════════════════════\n');

{
  const families = [...new Set(VARIANTS.map(v => v.family))];
  for (const fam of families) {
    const famResults = allResults.filter(r => r.family === fam);
    // Pick best by composite score mean
    let best = famResults[0];
    let bestScore = -Infinity;
    for (const r of famResults) {
      const mean = computeStats(r.runs.map(run => run.compositeScore)).mean;
      if (mean > bestScore) { bestScore = mean; best = r; }
    }
    const s = {
      score: computeStats(best.runs.map(r => r.compositeScore)),
      unfilled: computeStats(best.runs.map(r => r.unfilled)),
      penalty: computeStats(best.runs.map(r => r.totalPenalty)),
      l0: computeStats(best.runs.map(r => r.l0StdDev)),
    };
    const zeroPen = best.runs.filter(r => r.totalPenalty === 0).length;
    console.log(`  ${fam.padEnd(14)} Best: ${best.name.padEnd(14)} score=${s.score.mean.toFixed(0)} unfilled=${s.unfilled.mean.toFixed(2)} penalty=${s.penalty.mean.toFixed(0)} zeroPen=${((zeroPen/ITERATIONS)*100).toFixed(1)}% l0sd=${s.l0.mean.toFixed(3)}`);
  }
}

console.log('\nDone.');
