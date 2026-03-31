/**
 * Priority Map Deep Analysis
 *
 * Extended simulation focusing on targeted improvements identified from
 * the initial 10-variant run. Tests 6 new refined variants against the
 * current V0 baseline and the best performers (V5, V6, V8).
 *
 * Key findings from Round 1 that motivate these variants:
 *  - Hamama at priority 40 is too late: L0+Hamama-cert participants get
 *    consumed by earlier tasks → seniors forced in → 10k penalty each.
 *  - Karov's Salsala bottleneck (only 3 eligible L0) is underweighted.
 *  - V5 (candidate pool) has best score but worst stability (CV 29%).
 *  - V6 (hybrid) has best L0 fairness but middling score.
 *  - V0 has best feasibility but mediocre score/penalty.
 *
 * Usage: npx ts-node src/priority-map-analysis.ts
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

// ─── Participant Pool (identical to priority-simulation.ts) ──────────────────

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
  createP('a1', 'Alpha-01', Level.L0, [Certification.Nitzan], 'Alpha'),
  createP('a2', 'Alpha-02', Level.L0, [Certification.Salsala], 'Alpha'),
  createP('a3', 'Alpha-03', Level.L0, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a4', 'Alpha-04', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a5', 'Alpha-05', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a6', 'Alpha-06', Level.L2, [Certification.Nitzan], 'Alpha'),
  createP('a7', 'Alpha-07', Level.L3, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a8', 'Alpha-08', Level.L4, [Certification.Hamama], 'Alpha'),
  createP('b1', 'Beta-01', Level.L0, [Certification.Nitzan], 'Beta'),
  createP('b2', 'Beta-02', Level.L0, [Certification.Salsala, Certification.Nitzan], 'Beta'),
  createP('b3', 'Beta-03', Level.L0, [Certification.Hamama], 'Beta'),
  createP('b4', 'Beta-04', Level.L0, [Certification.Horesh], 'Beta'),
  createP('b5', 'Beta-05', Level.L0, [], 'Beta'),
  createP('b6', 'Beta-06', Level.L2, [], 'Beta'),
  createP('b7', 'Beta-07', Level.L3, [Certification.Hamama], 'Beta'),
  createP('b8', 'Beta-08', Level.L4, [], 'Beta'),
  createP('g1', 'Gamma-01', Level.L0, [Certification.Nitzan, Certification.Salsala], 'Gamma'),
  createP('g2', 'Gamma-02', Level.L0, [Certification.Hamama], 'Gamma'),
  createP('g3', 'Gamma-03', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g4', 'Gamma-04', Level.L0, [Certification.Horesh], 'Gamma'),
  createP('g5', 'Gamma-05', Level.L0, [], 'Gamma'),
  createP('g6', 'Gamma-06', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g7', 'Gamma-07', Level.L3, [Certification.Nitzan], 'Gamma'),
  createP('g8', 'Gamma-08', Level.L4, [Certification.Hamama], 'Gamma'),
];

/** Check if any slot in the task has a low-priority level entry (replaces preferJuniors). */
function hasLowPriority(task: Task): boolean {
  return task.slots.some(s => s.acceptableLevels.some(e => e.lowPriority));
}

// ─── Candidate Pool Helper ───────────────────────────────────────────────────

function countEligiblePerSlot(task: Task): { avg: number; min: number; max: number } {
  let total = 0;
  let min = Infinity;
  let max = 0;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.some(e => e.level === p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    total += eligible;
    if (eligible < min) min = eligible;
    if (eligible > max) max = eligible;
  }
  const avg = total / Math.max(1, task.slots.length);
  if (!isFinite(min)) min = 0;
  return { avg, min, max };
}

// ─── Priority Variant Definitions ────────────────────────────────────────────

type PriorityFn = (task: Task) => number;

/** V0: Current production formula (baseline) */
function v0_current(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/** V5: Candidate pool (best composite score from round 1) */
function v5_candidatePool(task: Task): number {
  if (task.sameGroupRequired) return 0;
  const { avg } = countEligiblePerSlot(task);
  const score = Math.min(50, avg * 2);
  if (task.isLight) return Math.max(1, score + 20);
  return Math.max(1, score);
}

/** V6: Hybrid (best L0 fairness from round 1) */
function v6_hybrid(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let structural = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  structural -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  structural -= totalCerts * 3;
  structural -= task.slots.length * 2;
  if (task.isLight) structural += 20;
  const { avg } = countEligiblePerSlot(task);
  const candidateScore = Math.min(50, avg * 2);
  const blended = 0.6 * structural + 0.4 * candidateScore;
  return Math.max(1, blended);
}

/** V8: Bottleneck slot (best senior fairness + penalty from round 1) */
function v8_bottleneck(task: Task): number {
  if (task.sameGroupRequired) return 0;
  const { min } = countEligiblePerSlot(task);
  const score = Math.min(50, min * 3);
  if (task.isLight) return Math.max(1, score + 20);
  return Math.max(1, score);
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW TARGETED VARIANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * VA: Bottleneck-weighted hybrid
 * Uses min-eligible-slot (bottleneck) but blends with structural weight
 * for stability. 50% bottleneck + 50% structural. Reduced light bonus (+10).
 *
 * Rationale: V8's bottleneck approach had best penalty but worst stability.
 * V0's structural approach had best feasibility. Blending should capture
 * both benefits.
 */
function vA_bottleneckHybrid(task: Task): number {
  if (task.sameGroupRequired) return 0;

  // Structural component
  let structural = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  structural -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  structural -= totalCerts * 3;
  structural -= task.slots.length * 2;

  // Bottleneck component
  const { min } = countEligiblePerSlot(task);
  const bottleneckScore = Math.min(50, min * 3);

  // Blend 50/50
  let score = 0.5 * structural + 0.5 * bottleneckScore;
  if (task.isLight) score += 10;
  return Math.max(1, score);
}

/**
 * VB: Penalty-aware priority
 * Explicitly boosts priority of tasks with preferJuniors flag (Hamama)
 * since misassignment carries a 10k penalty. Also penalizes by
 * bottleneck slot tightness.
 *
 * Rationale: The dominant penalty driver is Hamama getting L3/L4 participants.
 * If we schedule Hamama earlier, L0 candidates are still available.
 */
function vB_penaltyAware(task: Task): number {
  if (task.sameGroupRequired) return 0;

  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;

  // Explicit penalty-risk bonus: preferJuniors tasks get big priority boost
  if (hasLowPriority(task)) score -= 20;

  // Bottleneck tightness bonus
  const { min } = countEligiblePerSlot(task);
  if (min <= 5) score -= (6 - min) * 2;

  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * VC: Scarcity-ratio priority
 * Priority = (slots needed) / (average eligible per slot).
 * Higher ratio = scarcer resource = schedule first.
 * This naturally handles the Hamama/Shemesh bottleneck.
 *
 * Rationale: A task needing 4 slots with 20 candidates each (ratio 0.2)
 * is easier than one needing 2 slots with 5 candidates each (ratio 0.4).
 */
function vC_scarcityRatio(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const { avg, min } = countEligiblePerSlot(task);
  // Use geometric mean of avg and min for robustness
  const effective = Math.sqrt(avg * Math.max(1, min));
  const ratio = task.slots.length / Math.max(0.5, effective);

  // Invert: higher ratio (scarcer) → lower score → scheduled first
  // Scale to 1-50 range
  const score = Math.max(1, 50 - ratio * 15);
  if (task.isLight) return Math.max(1, score + 15);
  return Math.max(1, score);
}

/**
 * VD: Duration-pool interaction
 * Combines task duration impact with candidate pool scarcity.
 * Longer tasks with tighter pools get highest priority.
 *
 * Rationale: A 12h Hamama with 7 eligible candidates blocks more schedule
 * space than a 1.5h Aruga with 14 candidates. Duration × scarcity captures
 * the true "damage" of late scheduling.
 */
function vD_durationPool(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const { avg, min } = countEligiblePerSlot(task);
  const durationHrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3_600_000;

  // Duration impact: hours of schedule blocked per slot
  const blockImpact = durationHrs * task.slots.length;

  // Pool tightness: inverse of geometric mean of avg and min eligible
  const poolTightness = 1 / Math.max(1, Math.sqrt(avg * Math.max(1, min)));

  // Combined: high blockImpact + high poolTightness → schedule first
  const difficulty = blockImpact * poolTightness;

  // Normalize to ~1-50 range (empirically calibrated for this task set)
  const score = Math.max(1, 50 - difficulty * 5);

  if (task.isLight) return Math.max(1, score + 15);
  if (hasLowPriority(task)) return Math.max(1, score - 5);
  return Math.max(1, score);
}

/**
 * VE: Weighted multi-signal blend
 * Combines the 4 strongest signals identified in round 1 with tuned weights:
 *  - 30% bottleneck slot tightness
 *  - 30% structural (level+cert) constraints
 *  - 20% penalty risk (preferJuniors)
 *  - 20% candidate pool average
 *
 * Rationale: No single signal dominated across all metrics. A carefully
 * weighted blend should capture the best of each approach.
 */
function vE_multiSignal(task: Task): number {
  if (task.sameGroupRequired) return 0;

  // Signal 1: Structural (0-50 range, lower = harder)
  let structural = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  structural -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  structural -= totalCerts * 3;
  structural -= task.slots.length * 2;

  // Signal 2: Bottleneck slot (0-50 range, lower = tighter)
  const { avg, min } = countEligiblePerSlot(task);
  const bottleneck = Math.min(50, min * 3);

  // Signal 3: Penalty risk (0 or -20)
  const penaltyRisk = hasLowPriority(task) ? -20 : 0;

  // Signal 4: Pool average (0-50 range, lower = tighter)
  const pool = Math.min(50, avg * 2);

  // Weighted blend
  let score = 0.30 * (structural + penaltyRisk) +
              0.30 * bottleneck +
              0.20 * penaltyRisk +
              0.20 * pool;

  if (task.isLight) score += 12;
  return Math.max(1, score);
}

/**
 * VF: Ranked tiers with pool tiebreaker
 * Assigns tasks to discrete priority tiers based on dominant constraints,
 * then uses candidate pool as tiebreaker within tiers.
 *
 * Tier 0: sameGroupRequired (Adanit) — always first
 * Tier 1: preferJuniors + cert required (Hamama) — penalty-critical
 * Tier 2: L0-only + cert required (Shemesh) — very tight pool
 * Tier 3: Mixed levels + cert or exclusion (Karov, Mamtera) — moderate
 * Tier 4: L0-only, no cert (Aruga) — moderate pool
 * Tier 5: Light tasks (Karovit) — always last among non-group
 *
 * Rationale: Discrete tiers encode domain knowledge about which constraint
 * types are genuinely hardest, then pool size resolves within-tier order.
 */
function vF_tieredPool(task: Task): number {
  if (task.sameGroupRequired) return 0;

  const hasCerts = task.slots.some(s => s.requiredCertifications.length > 0);
  const allL0Only = task.slots.every(s =>
    s.acceptableLevels.length === 1 && s.acceptableLevels[0].level === Level.L0);
  const hasExclusion = task.slots.some(s => (s.forbiddenCertifications?.length ?? 0) > 0);

  let tier: number;
  if (hasLowPriority(task) && hasCerts) tier = 1;       // Hamama
  else if (allL0Only && hasCerts) tier = 2;           // Shemesh
  else if (hasCerts || hasExclusion) tier = 3;        // Karov, Mamtera
  else if (allL0Only && !task.isLight) tier = 4;      // Aruga
  else if (task.isLight) tier = 5;                    // Karovit
  else tier = 3;                                      // Fallback

  // Within-tier ordering by min eligible (tighter pool → first)
  const { min } = countEligiblePerSlot(task);
  // Map to 0-9 sub-range within tier
  const subPriority = Math.min(9, min);

  return tier * 10 + subPriority;
}

// ─── Variant Registry ────────────────────────────────────────────────────────

const VARIANTS: { name: string; fn: PriorityFn; description: string }[] = [
  // Round 1 reference variants
  { name: 'V0_current', fn: v0_current, description: 'Current production formula (baseline)' },
  { name: 'V5_pool', fn: v5_candidatePool, description: 'R1 best: candidate pool size' },
  { name: 'V6_hybrid', fn: v6_hybrid, description: 'R1 best: 60% structural + 40% pool' },
  { name: 'V8_bottleneck', fn: v8_bottleneck, description: 'R1 best: min-eligible bottleneck' },
  // New targeted variants
  { name: 'VA_bHybrid', fn: vA_bottleneckHybrid, description: '50% structural + 50% bottleneck, light+10' },
  { name: 'VB_penalty', fn: vB_penaltyAware, description: 'V0 + preferJuniors boost + bottleneck boost' },
  { name: 'VC_scarcity', fn: vC_scarcityRatio, description: 'slots/eligible ratio (geometric mean)' },
  { name: 'VD_durPool', fn: vD_durationPool, description: 'Duration × pool tightness' },
  { name: 'VE_multi', fn: vE_multiSignal, description: '30% struct + 30% bneck + 20% penalty + 20% pool' },
  { name: 'VF_tiered', fn: vF_tieredPool, description: 'Constraint-tier + pool tiebreaker' },
];

// ─── Simulation Runner ───────────────────────────────────────────────────────

const ITERATIONS = 300; // More iterations for tighter confidence intervals

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

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    mean,
    stdDev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    median: n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)],
    p5: sorted[Math.floor(n * 0.05)],
    p10: sorted[Math.floor(n * 0.10)],
    p25: sorted[Math.floor(n * 0.25)],
    p75: sorted[Math.floor(n * 0.75)],
    p90: sorted[Math.floor(n * 0.90)],
    p95: sorted[Math.floor(n * 0.95)],
  };
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function runVariant(variant: { name: string; fn: PriorityFn; description: string }) {
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

  return { name: variant.name, description: variant.description, priorityMap, runs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║     PRIORITY MAP DEEP ANALYSIS — 300 iterations × 10 variants          ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝');
console.log();

// Show priority maps for all variants
console.log('── PRIORITY MAP COMPARISON ───────────────────────────────────────');
{
  resetSlotCounter();
  resetTaskCounter();
  const tasks = generateDailyTasks(BASE_DATE);
  const rows: Record<string, string | number>[] = [];
  for (const t of tasks) {
    if (t.sameGroupRequired) continue; // Skip Adanit (always 0)
    const pool = countEligiblePerSlot(t);
    const row: Record<string, string | number> = {
      task: t.name,
      type: t.type as string,
      slots: t.slots.length,
      pool_avg: pool.avg.toFixed(1),
      pool_min: pool.min,
      pool_max: pool.max,
    };
    for (const v of VARIANTS) {
      row[v.name] = v.fn(t);
    }
    rows.push(row);
  }
  rows.sort((a, b) => (Number(a['V0_current']) || 99) - (Number(b['V0_current']) || 99));
  console.table(rows);
}
console.log();

// Run all variants
const allResults: { name: string; description: string; runs: RunResult[] }[] = [];
const totalStart = Date.now();

for (const variant of VARIANTS) {
  const vStart = Date.now();
  process.stdout.write(`Running ${variant.name} (${ITERATIONS} iter)...`);
  const result = runVariant(variant);
  allResults.push(result);
  const elapsed = ((Date.now() - vStart) / 1000).toFixed(1);
  console.log(` done (${elapsed}s)`);
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
console.log(`\nAll simulations complete in ${totalElapsed}s\n`);

// ─── Analysis ────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  RESULTS');
console.log('══════════════════════════════════════════════════════════════════════════\n');

// 1. Feasibility
console.log('── 1. FEASIBILITY (unfilled slots — lower mean = better) ───────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.unfilled);
    const s = stats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(1),
      p10: s.p10,
      p90: s.p90,
      min: s.min,
      max: s.max,
      stdDev: s.stdDev.toFixed(2),
    });
  }
  console.table(rows);
}

// 2. Composite Score
console.log('── 2. COMPOSITE SCORE (higher = better) ───────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.compositeScore);
    const s = stats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(0),
      median: s.median.toFixed(0),
      p25: s.p25.toFixed(0),
      p75: s.p75.toFixed(0),
      min: s.min.toFixed(0),
      max: s.max.toFixed(0),
      stdDev: s.stdDev.toFixed(0),
    });
  }
  console.table(rows);
}

// 3. Total Penalty (the key driver of composite score differences)
console.log('── 3. TOTAL PENALTY (lower = better) — key driver ─────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.totalPenalty);
    const s = stats(vals);
    const zeroCount = vals.filter(v => v === 0).length;
    const tenKCount = vals.filter(v => v === 10000).length;
    const twentyKCount = vals.filter(v => v === 20000).length;
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(0),
      '0_penalty%': ((zeroCount / ITERATIONS) * 100).toFixed(1) + '%',
      '10k_penalty%': ((tenKCount / ITERATIONS) * 100).toFixed(1) + '%',
      '20k_penalty%': ((twentyKCount / ITERATIONS) * 100).toFixed(1) + '%',
    });
  }
  console.table(rows);
}

// 4. L0 Fairness
console.log('── 4. L0 FAIRNESS (stddev — lower = fairer) ───────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.l0StdDev);
    const s = stats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p25: s.p25.toFixed(3),
      p75: s.p75.toFixed(3),
    });
  }
  console.table(rows);
}

// 5. Senior Fairness
console.log('── 5. SENIOR FAIRNESS (stddev — lower = fairer) ───────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.seniorStdDev);
    const s = stats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p25: s.p25.toFixed(3),
      p75: s.p75.toFixed(3),
    });
  }
  console.table(rows);
}

// 6. Min Rest Hours
console.log('── 6. MIN REST HOURS (higher = better) ────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const vals = r.runs.map(run => run.minRestHours).filter(v => isFinite(v));
    if (vals.length === 0) { rows.push({ variant: r.name, mean: 'N/A' }); continue; }
    const s = stats(vals);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(2),
      p10: s.p10.toFixed(2),
      min: s.min.toFixed(2),
    });
  }
  console.table(rows);
}

// 7. Stability (Score CV)
console.log('── 7. STABILITY (score CV% — lower = more stable) ─────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const scoreVals = r.runs.map(run => run.compositeScore);
    const unfilledVals = r.runs.map(run => run.unfilled);
    const s = stats(scoreVals);
    const u = stats(unfilledVals);
    const cv = s.mean !== 0 ? (s.stdDev / Math.abs(s.mean)) * 100 : 0;
    rows.push({
      variant: r.name,
      'score_CV%': cv.toFixed(2) + '%',
      'score_stdDev': s.stdDev.toFixed(0),
      'unfilled_stdDev': u.stdDev.toFixed(2),
      'IQR_score': (s.p75 - s.p25).toFixed(0),
    });
  }
  console.table(rows);
}

// ─── Multi-Dimensional Ranking ───────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  WEIGHTED COMPOSITE RANKING');
console.log('  (feasibility 25%, score 25%, l0Fair 15%, penalty 15%,');
console.log('   stability 10%, rest 10%)');
console.log('══════════════════════════════════════════════════════════════════════════\n');

{
  const dims = ['feasibility', 'score', 'l0Fair', 'seniorFair', 'penalty', 'stability', 'rest'] as const;
  const weights: Record<typeof dims[number], number> = {
    feasibility: 0.25,
    score: 0.20,
    l0Fair: 0.15,
    seniorFair: 0.05,
    penalty: 0.15,
    stability: 0.10,
    rest: 0.10,
  };

  type DimMap = Record<typeof dims[number], number>;
  const raw = new Map<string, DimMap>();

  for (const r of allResults) {
    const unf = stats(r.runs.map(run => run.unfilled));
    const sc = stats(r.runs.map(run => run.compositeScore));
    const l0 = stats(r.runs.map(run => run.l0StdDev));
    const sr = stats(r.runs.map(run => run.seniorStdDev));
    const pen = stats(r.runs.map(run => run.totalPenalty));
    const rst = stats(r.runs.map(run => run.minRestHours).filter(v => isFinite(v)));
    const cv = sc.mean !== 0 ? sc.stdDev / Math.abs(sc.mean) : 0;

    raw.set(r.name, {
      feasibility: unf.mean,      // lower = better
      score: -sc.mean,            // negate: lower = better
      l0Fair: l0.mean,            // lower = better
      seniorFair: sr.mean,        // lower = better
      penalty: pen.mean,          // lower = better
      stability: cv,              // lower = better
      rest: -rst.mean,            // negate: lower = better
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
    // Weighted rank
    let weightedRank = 0;
    for (const dim of dims) {
      weightedRank += rk[dim] * weights[dim];
    }
    const avgRank = dims.reduce((s, d) => s + rk[d], 0) / dims.length;
    rows.push({
      variant: r.name,
      'rk_feas': rk.feasibility,
      'rk_score': rk.score,
      'rk_l0': rk.l0Fair,
      'rk_sr': rk.seniorFair,
      'rk_pen': rk.penalty,
      'rk_stab': rk.stability,
      'rk_rest': rk.rest,
      'AVG_RANK': avgRank.toFixed(2),
      'WEIGHTED': weightedRank.toFixed(2),
    });
  }
  rows.sort((a, b) => parseFloat(a['WEIGHTED'] as string) - parseFloat(b['WEIGHTED'] as string));
  console.table(rows);
}

// ─── Per-Task Diagnostic: How often is each task type left unfilled? ──────────

console.log('\n── PER-TASK PENALTY ANALYSIS (Hamama assignment distribution) ───');
console.log('This shows whether each variant successfully assigns L0 to Hamama.\n');
{
  // For Hamama specifically, track how often we get 0/10k/20k penalty
  // Penalty = 10k per non-L0 Hamama assignment; there are 2 Hamama tasks/day
  // 0 penalty = both L0, 10k = one non-L0, 20k = both non-L0
  for (const r of allResults) {
    const penalties = r.runs.map(run => run.totalPenalty);
    const zero = penalties.filter(v => v === 0).length;
    const tenK = penalties.filter(v => v === 10000).length;
    const twentyK = penalties.filter(v => v === 20000).length;
    console.log(
      `${r.name.padEnd(16)} ` +
      `both_L0=${((zero / ITERATIONS) * 100).toFixed(1).padStart(5)}%  ` +
      `one_senior=${((tenK / ITERATIONS) * 100).toFixed(1).padStart(5)}%  ` +
      `both_senior=${((twentyK / ITERATIONS) * 100).toFixed(1).padStart(5)}%`
    );
  }
}

console.log('\nDone.');
