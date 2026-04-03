/**
 * Priority Map Simulation Harness
 *
 * Runs 200 iterations per priority variant to evaluate the quality of the
 * computed structural priority against alternative formulations.
 *
 * Usage: npx ts-node src/priority-simulation.ts
 */

import {
  Participant,
  Level,
  Certification,
  Task,
  DEFAULT_CONFIG,
  SchedulerConfig,
} from './models/types';
import { generateDailyTasks, resetSlotCounter, resetTaskCounter } from './tasks/cli-task-factory';
import { optimize, greedyAssign, resetAssignmentCounter } from './engine/optimizer';

// ─── Participant Pool (same as demo.ts — 24 people across 3 groups) ──────────

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

// ─── Priority Variant Definitions ────────────────────────────────────────────

type PriorityFn = (task: Task) => number;

/**
 * V0: Current production formula (baseline)
 */
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

/**
 * V1: Stronger level restriction weight (×8 instead of ×5)
 * Hypothesis: Level restrictions are the dominant constraint bottleneck;
 * giving them more weight should help the greedy phase.
 */
function v1_strongerLevelWeight(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 8; // ← 8 instead of 5
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * V2: Stronger certification weight (×6 instead of ×3)
 * Hypothesis: Certification requirements can severely narrow the candidate pool.
 */
function v2_strongerCertWeight(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 6; // ← 6 instead of 3
  score -= task.slots.length * 2;
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * V3: Stronger slot count weight (×4 instead of ×2)
 * Hypothesis: Tasks with more slots are combinatorially harder.
 */
function v3_strongerSlotWeight(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 4; // ← 4 instead of 2
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * V4: No light bonus (remove the +20 for light tasks)
 * Hypothesis: Light tasks should compete on structural difficulty alone.
 */
function v4_noLightBonus(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;
  // No light bonus
  return Math.max(1, score);
}

/**
 * V5: Candidate-pool-based priority
 * Computes the actual number of participants that could fill each slot
 * (level + cert match only, ignoring scheduling state).
 * Fewer eligible candidates → lower score → scheduled first.
 */
function v5_candidatePoolBased(task: Task): number {
  if (task.sameGroupRequired) return 0;

  let totalEligible = 0;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      // Level check
      if (!slot.acceptableLevels.some(e => e.level === p.level)) continue;
      // Certification check
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      // Excluded cert check
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    totalEligible += eligible;
  }
  const avgEligible = totalEligible / Math.max(1, task.slots.length);
  // Invert: fewer candidates → lower priority score → scheduled first
  // Scale to roughly match the 0-50 range of the structural approach
  const score = Math.min(50, avgEligible * 2);
  if (task.isLight) return Math.max(1, score + 20);
  return Math.max(1, score);
}

/**
 * V6: Hybrid — structural × candidate pool
 * Blends structural features with actual candidate pool size.
 */
function v6_hybrid(task: Task): number {
  if (task.sameGroupRequired) return 0;

  // Structural component (same as v0)
  let structural = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  structural -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  structural -= totalCerts * 3;
  structural -= task.slots.length * 2;
  if (task.isLight) structural += 20;

  // Candidate pool component
  let totalEligible = 0;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.some(e => e.level === p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    totalEligible += eligible;
  }
  const avgEligible = totalEligible / Math.max(1, task.slots.length);
  const candidateScore = Math.min(50, avgEligible * 2);

  // Blend: 60% structural, 40% candidate pool
  const blended = 0.6 * structural + 0.4 * candidateScore;
  return Math.max(1, blended);
}

/**
 * V7: Duration-aware — longer tasks are harder to fit around overlaps
 */
function v7_durationAware(task: Task): number {
  if (task.sameGroupRequired) return 0;
  let score = 50;
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 5;
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 3;
  score -= task.slots.length * 2;
  // Duration penalty: longer tasks block more time
  const durationHrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3_600_000;
  score -= Math.max(0, (durationHrs - 4) * 1.5); // penalty kicks in above 4h
  if (task.isLight) score += 20;
  return Math.max(1, score);
}

/**
 * V8: Min-eligible-slot-focused
 * Priority based on the MINIMUM eligible candidate count across slots
 * (the bottleneck slot determines difficulty).
 */
function v8_minSlotBottleneck(task: Task): number {
  if (task.sameGroupRequired) return 0;

  let minEligible = Infinity;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.some(e => e.level === p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    minEligible = Math.min(minEligible, eligible);
  }
  if (!isFinite(minEligible)) minEligible = 0;

  // Fewer candidates in bottleneck slot → lower score → first
  const score = Math.min(50, minEligible * 3);
  if (task.isLight) return Math.max(1, score + 20);
  return Math.max(1, score);
}

/**
 * V9: Optimized blend — combines the best ideas:
 * stronger level weight, stronger cert weight, candidate pool awareness,
 * duration penalty, and reduced light bonus.
 */
function v9_optimizedBlend(task: Task): number {
  if (task.sameGroupRequired) return 0;

  let score = 50;
  // Stronger level restriction (×7)
  const avgLevels = task.slots.reduce((s, sl) => s + sl.acceptableLevels.length, 0)
    / Math.max(1, task.slots.length);
  score -= (5 - avgLevels) * 7;
  // Stronger cert weight (×5)
  const totalCerts = task.slots.reduce((s, sl) => s + sl.requiredCertifications.length, 0);
  score -= totalCerts * 5;
  // Moderate slot weight (×3)
  score -= task.slots.length * 3;
  // Duration penalty for long tasks
  const durationHrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3_600_000;
  score -= Math.max(0, (durationHrs - 4) * 1);
  // Bottleneck penalty: add penalty for tightest slot
  let minEligible = Infinity;
  for (const slot of task.slots) {
    let eligible = 0;
    for (const p of allParticipants) {
      if (!slot.acceptableLevels.some(e => e.level === p.level)) continue;
      if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
      if (slot.forbiddenCertifications?.some(c => p.certifications.includes(c))) continue;
      eligible++;
    }
    minEligible = Math.min(minEligible, eligible);
  }
  if (isFinite(minEligible)) {
    score -= Math.max(0, (6 - minEligible)) * 2; // penalty if <6 eligible for bottleneck slot
  }
  // Reduced light bonus (+10 instead of +20)
  if (task.isLight) score += 10;
  return Math.max(1, score);
}

const VARIANTS: { name: string; fn: PriorityFn; description: string }[] = [
  { name: 'V0_current', fn: v0_current, description: 'Current production formula' },
  { name: 'V1_strongLevel', fn: v1_strongerLevelWeight, description: 'Level restriction weight ×8 (was ×5)' },
  { name: 'V2_strongCert', fn: v2_strongerCertWeight, description: 'Certification weight ×6 (was ×3)' },
  { name: 'V3_strongSlot', fn: v3_strongerSlotWeight, description: 'Slot count weight ×4 (was ×2)' },
  { name: 'V4_noLightBonus', fn: v4_noLightBonus, description: 'No +20 bonus for light tasks' },
  { name: 'V5_candidatePool', fn: v5_candidatePoolBased, description: 'Priority from actual candidate pool size' },
  { name: 'V6_hybrid', fn: v6_hybrid, description: '60% structural + 40% candidate pool' },
  { name: 'V7_duration', fn: v7_durationAware, description: 'Add duration penalty for >4h tasks' },
  { name: 'V8_bottleneck', fn: v8_minSlotBottleneck, description: 'Priority from minimum-eligible-slot bottleneck' },
  { name: 'V9_optimized', fn: v9_optimizedBlend, description: 'Tuned blend of best features' },
];

// ─── Simulation Runner ───────────────────────────────────────────────────────

const ITERATIONS = 200;

interface VariantResult {
  name: string;
  description: string;
  priorityMap: Map<string, number>; // taskId → priority
  runs: RunResult[];
}

interface RunResult {
  unfilled: number;
  compositeScore: number;
  l0StdDev: number;
  seniorStdDev: number;
  minRestHours: number;
  dailyPerParticipantStdDev: number;
  dailyGlobalStdDev: number;
  totalPenalty: number;
  feasible: boolean;
}

function stats(values: number[]): { mean: number; stdDev: number; min: number; max: number; median: number; p10: number; p90: number } {
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
    p10: sorted[Math.floor(n * 0.1)],
    p90: sorted[Math.floor(n * 0.9)],
  };
}

/**
 * Fisher-Yates shuffle
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Run the full optimizer (greedy + local search) with a patched priority function.
 *
 * We monkey-patch `task.schedulingPriority` on each task before calling optimize(),
 * so the optimizer uses our variant priorities instead of computing them internally.
 */
function runVariant(variant: { name: string; fn: PriorityFn; description: string }): VariantResult {
  const config: SchedulerConfig = {
    ...DEFAULT_CONFIG,
    maxIterations: 5000,    // Reduced for simulation speed (still enough for convergence)
    maxSolverTimeMs: 3000,  // 3s per run
  };

  const priorityMap = new Map<string, number>();
  const runs: RunResult[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    // Reset counters for clean task/slot IDs
    resetAssignmentCounter();
    resetSlotCounter();
    resetTaskCounter();

    // Generate fresh tasks each iteration (IDs reset)
    const tasks = generateDailyTasks(BASE_DATE);

    // Apply the variant priority function to all tasks
    for (const t of tasks) {
      const pri = variant.fn(t);
      t.schedulingPriority = pri;
      if (i === 0) priorityMap.set(`${t.sourceName || t.name}:${t.name}`, pri);
    }

    // Shuffle participants for diversity (except first run)
    const participants = i === 0 ? [...allParticipants] : shuffle([...allParticipants]);

    // Run full optimize (greedy + local search)
    const jitter = i === 0 ? 0 : 0.3;
    const result = optimize(tasks, participants, config, [], undefined, jitter);

    runs.push({
      unfilled: result.unfilledSlots.length,
      compositeScore: result.score.compositeScore,
      l0StdDev: result.score.l0StdDev,
      seniorStdDev: result.score.seniorStdDev,
      minRestHours: result.score.minRestHours,
      dailyPerParticipantStdDev: result.score.dailyPerParticipantStdDev,
      dailyGlobalStdDev: result.score.dailyGlobalStdDev,
      totalPenalty: result.score.totalPenalty,
      feasible: result.feasible,
    });
  }

  return { name: variant.name, description: variant.description, priorityMap, runs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════════════╗');
console.log('║          PRIORITY MAP SIMULATION — 200 iterations × 10 variants        ║');
console.log('╚══════════════════════════════════════════════════════════════════════════╝');
console.log();

// First: show the priority map for the current formula
console.log('── Current Task Set Priority Map (V0) ────────────────────────────');
{
  resetSlotCounter();
  resetTaskCounter();
  const tasks = generateDailyTasks(BASE_DATE);
  const rows: { task: string; type: string; slots: number; priority: number; v5_pool: number; v8_bottleneck: number }[] = [];
  for (const t of tasks) {
    rows.push({
      task: t.name,
      type: (t.sourceName || t.name) as string,
      slots: t.slots.length,
      priority: v0_current(t),
      v5_pool: v5_candidatePoolBased(t),
      v8_bottleneck: v8_minSlotBottleneck(t),
    });
  }
  // Sort by V0 priority to show scheduling order
  rows.sort((a, b) => a.priority - b.priority);
  console.table(rows);
}
console.log();

// Run all variants
const allResults: VariantResult[] = [];
const totalStart = Date.now();

for (const variant of VARIANTS) {
  const vStart = Date.now();
  process.stdout.write(`Running ${variant.name} (${ITERATIONS} iterations)...`);
  const result = runVariant(variant);
  allResults.push(result);
  const elapsed = ((Date.now() - vStart) / 1000).toFixed(1);
  console.log(` done (${elapsed}s)`);
}

const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
console.log(`\nAll simulations complete in ${totalElapsed}s\n`);

// ─── Results Analysis ────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  COMPARATIVE RESULTS');
console.log('══════════════════════════════════════════════════════════════════════════');
console.log();

// 1. Feasibility / Unfilled Slots
console.log('── 1. FEASIBILITY (Unfilled Slots) ──────────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const unfilledValues = r.runs.map(run => run.unfilled);
    const feasibleCount = r.runs.filter(run => run.feasible).length;
    const s = stats(unfilledValues);
    rows.push({
      variant: r.name,
      'feasible%': ((feasibleCount / ITERATIONS) * 100).toFixed(1) + '%',
      'unfilled_mean': s.mean.toFixed(2),
      'unfilled_median': s.median.toFixed(1),
      'unfilled_min': s.min,
      'unfilled_max': s.max,
      'unfilled_stdDev': s.stdDev.toFixed(2),
      'zero_unfilled%': ((unfilledValues.filter(v => v === 0).length / ITERATIONS) * 100).toFixed(1) + '%',
    });
  }
  console.table(rows);
}

// 2. Composite Score
console.log('── 2. COMPOSITE SCORE (higher = better) ─────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.compositeScore);
    const s = stats(values);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(2),
      p10: s.p10.toFixed(2),
      p90: s.p90.toFixed(2),
      min: s.min.toFixed(2),
      max: s.max.toFixed(2),
      stdDev: s.stdDev.toFixed(2),
    });
  }
  console.table(rows);
}

// 3. L0 Fairness (lower stddev = fairer)
console.log('── 3. L0 FAIRNESS — Workload StdDev (lower = fairer) ────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.l0StdDev);
    const s = stats(values);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p10: s.p10.toFixed(3),
      p90: s.p90.toFixed(3),
      stdDev: s.stdDev.toFixed(3),
    });
  }
  console.table(rows);
}

// 4. Senior Fairness
console.log('── 4. SENIOR FAIRNESS — Workload StdDev (lower = fairer) ────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.seniorStdDev);
    const s = stats(values);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p10: s.p10.toFixed(3),
      p90: s.p90.toFixed(3),
      stdDev: s.stdDev.toFixed(3),
    });
  }
  console.table(rows);
}

// 5. Min Rest Hours (higher = better)
console.log('── 5. MIN REST HOURS (higher = better) ──────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.minRestHours);
    const finiteValues = values.filter(v => isFinite(v));
    if (finiteValues.length === 0) {
      rows.push({ variant: r.name, mean: 'N/A' });
      continue;
    }
    const s = stats(finiteValues);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(2),
      min: s.min.toFixed(2),
      p10: s.p10.toFixed(2),
      stdDev: s.stdDev.toFixed(2),
    });
  }
  console.table(rows);
}

// 6. Daily Balance
console.log('── 6. DAILY BALANCE — Per-Participant StdDev (lower = more even) ─');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.dailyPerParticipantStdDev);
    const s = stats(values);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(3),
      median: s.median.toFixed(3),
      p10: s.p10.toFixed(3),
      p90: s.p90.toFixed(3),
      stdDev: s.stdDev.toFixed(3),
    });
  }
  console.table(rows);
}

// 7. Total Penalty
console.log('── 7. TOTAL PENALTY (lower = better) ────────────────────────────');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const values = r.runs.map(run => run.totalPenalty);
    const s = stats(values);
    rows.push({
      variant: r.name,
      mean: s.mean.toFixed(2),
      median: s.median.toFixed(2),
      min: s.min.toFixed(2),
      max: s.max.toFixed(2),
    });
  }
  console.table(rows);
}

// 8. Stability — how consistent are results across runs?
console.log('── 8. STABILITY — Score Coefficient of Variation (lower = more stable) ─');
{
  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const scoreVals = r.runs.map(run => run.compositeScore);
    const unfilledVals = r.runs.map(run => run.unfilled);
    const scoreS = stats(scoreVals);
    const unfilledS = stats(unfilledVals);
    const scoreCv = scoreS.mean !== 0 ? (scoreS.stdDev / Math.abs(scoreS.mean)) * 100 : 0;
    rows.push({
      variant: r.name,
      'score_CV%': scoreCv.toFixed(2) + '%',
      'score_stdDev': scoreS.stdDev.toFixed(2),
      'unfilled_stdDev': unfilledS.stdDev.toFixed(2),
    });
  }
  console.table(rows);
}

// 9. Composite Ranking
console.log('══════════════════════════════════════════════════════════════════════════');
console.log('  COMPOSITE RANKING');
console.log('══════════════════════════════════════════════════════════════════════════');
console.log();
{
  // Rank each variant across dimensions (lower rank = better)
  const dimensions = ['feasibility', 'compositeScore', 'l0Fairness', 'seniorFairness', 'penalty', 'stability'] as const;

  type DimValues = Record<typeof dimensions[number], number>;
  const variantValues = new Map<string, DimValues>();

  for (const r of allResults) {
    const feasCount = r.runs.filter(run => run.feasible).length;
    const scoreS = stats(r.runs.map(run => run.compositeScore));
    const l0S = stats(r.runs.map(run => run.l0StdDev));
    const srS = stats(r.runs.map(run => run.seniorStdDev));
    const penS = stats(r.runs.map(run => run.totalPenalty));
    const scoreCv = scoreS.mean !== 0 ? scoreS.stdDev / Math.abs(scoreS.mean) : 0;

    variantValues.set(r.name, {
      feasibility: -feasCount, // Negate so lower = more feasible
      compositeScore: -scoreS.mean, // Negate so lower = higher score
      l0Fairness: l0S.mean,
      seniorFairness: srS.mean,
      penalty: penS.mean,
      stability: scoreCv,
    });
  }

  // Rank per dimension
  const ranks = new Map<string, Record<typeof dimensions[number], number>>();
  for (const dim of dimensions) {
    const sorted = [...variantValues.entries()]
      .sort((a, b) => a[1][dim] - b[1][dim]);
    sorted.forEach(([name], idx) => {
      if (!ranks.has(name)) ranks.set(name, {} as Record<typeof dimensions[number], number>);
      ranks.get(name)![dim] = idx + 1;
    });
  }

  const rows: Record<string, unknown>[] = [];
  for (const r of allResults) {
    const rk = ranks.get(r.name)!;
    const avgRank = dimensions.reduce((s, d) => s + rk[d], 0) / dimensions.length;
    rows.push({
      variant: r.name,
      'rank_feasibility': rk.feasibility,
      'rank_score': rk.compositeScore,
      'rank_l0Fair': rk.l0Fairness,
      'rank_srFair': rk.seniorFairness,
      'rank_penalty': rk.penalty,
      'rank_stability': rk.stability,
      'AVG_RANK': avgRank.toFixed(2),
    });
  }
  // Sort by average rank
  rows.sort((a, b) => parseFloat(a['AVG_RANK'] as string) - parseFloat(b['AVG_RANK'] as string));
  console.table(rows);
}

// 10. Priority Map Comparison
console.log('\n── PRIORITY ORDERING COMPARISON (V0 vs top variants) ─────────────');
{
  resetSlotCounter();
  resetTaskCounter();
  const tasks = generateDailyTasks(BASE_DATE);
  const compareRows: Record<string, string | number>[] = [];

  for (const t of tasks) {
    const row: Record<string, string | number> = {
      task: t.name,
      type: (t.sourceName || t.name) as string,
    };
    for (const v of VARIANTS) {
      row[v.name] = v.fn(t);
    }
    compareRows.push(row);
  }
  // Sort by V0 priority
  compareRows.sort((a, b) => (Number(a['V0_current']) || 99) - (Number(b['V0_current']) || 99));
  console.table(compareRows);
}

console.log('\nDone.');
