/**
 * Verification harness for "raise maxIterations 50k → 200k" recommendation.
 * Designed to FALSIFY the recommendation if possible.
 *
 * Run with:
 *   npx ts-node --project experiments/algo-tuning/tsconfig.json experiments/algo-tuning/verify.ts [exp]
 *
 * Where [exp] is one of:
 *   r1-fourway       — 4-way A/B at same default workload, 10 seeds each
 *   r2-pool          — vary participant pool size (24/36/48), 6 seeds each
 *   r3-horizon       — vary days (3/7/14), 5 seeds each
 *   r4-stress        — small pool (24 ppl, 7d), check if SA budget helps when feasibility tight
 *   all              — run all of the above
 */

// ─── localStorage shim — MUST be first ─────────────────────────────────────
class ShimStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.get(k) ?? null; }
  setItem(k: string, v: string): void { this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null; }
}
(globalThis as any).localStorage = new ShimStorage();
(globalThis as any).sessionStorage = new ShimStorage();

import * as fs from 'fs';
import * as path from 'path';

import {
  type Participant,
  type SchedulerConfig,
  type SlotRequirement,
  type Task,
} from '../../src/models/types';
import { SchedulingEngine } from '../../src/engine/scheduler';
import { generateShiftBlocks } from '../../src/shared/utils/time-utils';

const configStore = require('../../src/web/config-store');
const {
  initStore,
  getAllParticipants,
  getAllTaskTemplates,
  getAllRestRules,
  getDayStartHour,
  setScheduleDays,
  getScheduleDays,
  getScheduleDate,
} = configStore as {
  initStore(): void;
  getAllParticipants(): Participant[];
  getAllTaskTemplates(): any[];
  getAllRestRules(): { id: string; durationHours: number }[];
  getDayStartHour(): number;
  setScheduleDays(n: number): void;
  getScheduleDays(): number;
  getScheduleDate(): Date;
};

// ─── Task instantiation ────────────────────────────────────────────────────
let _slotCounter = 0;
let _taskCounter = 0;

function buildTasks(numDays: number, baseDate: Date): Task[] {
  _slotCounter = 0;
  _taskCounter = 0;
  const templates = getAllTaskTemplates();
  const allTasks: Task[] = [];

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
      const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);

      let shifts: { start: Date; end: Date }[];
      if (tpl.eveningStartHour !== undefined && tpl.shiftsPerDay === 2) {
        const morningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);
        const morningEnd = new Date(morningStart.getTime() + tpl.durationHours * 3600000);
        const eveHour = tpl.eveningStartHour;
        const eveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eveHour, 0);
        const eveningEnd = new Date(eveningStart.getTime() + tpl.durationHours * 3600000);
        shifts = [
          { start: morningStart, end: morningEnd },
          { start: eveningStart, end: eveningEnd },
        ];
      } else if (tpl.shiftsPerDay === 1) {
        shifts = [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }];
      } else {
        shifts = generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);
      }

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams ?? []) {
          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) continue;
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_slotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              label: s.label,
              subTeamLabel: st.name,
              subTeamId: st.id,
            });
          }
        }
        for (const s of tpl.slots ?? []) {
          if (s.acceptableLevels.length === 0) continue;
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_slotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }

        if (slots.length === 0) continue;

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_taskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w: any) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          restRuleId: tpl.restRuleId,
          sleepRecovery: tpl.sleepRecovery ? { ...tpl.sleepRecovery } : undefined,
          displayCategory: tpl.displayCategory,
          color: tpl.color || '#7f8c8d',
        });
      }
    }
  }
  return allTasks;
}

// ─── Participant subset sampling (per-group balanced) ──────────────────────
function buildParticipantSubset(allParticipants: Participant[], perGroupCount: number): Participant[] {
  // Group by p.group, take first N per group preserving order
  // (defaults are seeded as L4, L3, L2, L2, L2, L0, L0+H, L0+H, L0, L0, L0, L0)
  const byGroup = new Map<string, Participant[]>();
  for (const p of allParticipants) {
    const g = p.group ?? '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(p);
  }
  const result: Participant[] = [];
  for (const [, list] of byGroup) {
    result.push(...list.slice(0, perGroupCount));
  }
  return result;
}

// ─── Engine builder ────────────────────────────────────────────────────────
function buildEngine(
  participants: Participant[],
  tasks: Task[],
  numDays: number,
  configOverrides: Partial<SchedulerConfig> = {},
) {
  const restRules = getAllRestRules();
  const restRuleMap = new Map(restRules.map((r) => [r.id, r.durationHours]));
  const dayStartHour = getDayStartHour();
  const engine = new SchedulingEngine(configOverrides, undefined, restRuleMap, dayStartHour);
  const baseDate = getScheduleDate();
  const periodStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0);
  engine.setPeriod(periodStart, numDays);
  engine.addParticipants(participants);
  engine.addTasks(tasks);
  return engine;
}

// ─── Single run ────────────────────────────────────────────────────────────
interface RunOutcome {
  bestScore: number;
  bestUnfilled: number;
  bestFeasible: boolean;
  attempts: number;
  totalMs: number;
  perAttemptMs: number;
  attemptScoreP5: number;
  attemptScoreMedian: number;
  attemptScoreP95: number;
  improvementsCount: number;
  lastImprovementAttempt: number;
}

async function runOnce(
  attempts: number,
  configOverrides: Partial<SchedulerConfig>,
  participants: Participant[],
  tasks: Task[],
  numDays: number,
): Promise<RunOutcome> {
  const engine = buildEngine(participants, tasks, numDays, configOverrides);
  const t0 = Date.now();
  const attemptScores: number[] = [];
  let lastBest = Infinity;
  let lastBestUnfilled = Infinity;
  let lastBestFeasible = false;
  const improvements: number[] = [];

  await engine.generateScheduleAsync(attempts, (info) => {
    attemptScores.push(info.attemptScore);
    if (info.improved) improvements.push(info.attempt);
    lastBest = info.currentBestScore;
    lastBestUnfilled = info.currentBestUnfilled;
    lastBestFeasible = info.currentBestFeasible;
  });

  const totalMs = Date.now() - t0;
  const sorted = [...attemptScores].sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const median = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  return {
    bestScore: lastBest,
    bestUnfilled: lastBestUnfilled,
    bestFeasible: lastBestFeasible,
    attempts: attemptScores.length,
    totalMs,
    perAttemptMs: totalMs / attemptScores.length,
    attemptScoreP5: p5,
    attemptScoreMedian: median,
    attemptScoreP95: p95,
    improvementsCount: improvements.length,
    lastImprovementAttempt: improvements[improvements.length - 1] ?? 0,
  };
}

// ─── Cell aggregator (multiple seeds → stats) ──────────────────────────────
interface CellStats {
  label: string;
  config: { attempts: number; maxIter: number; maxTime: number };
  workload: { participants: number; tasks: number; slots: number; days: number };
  seeds: number;
  bestScores: number[];          // best-of-N from each seed
  perRunMs: number[];            // wall time of each seed
  perAttemptMs: number[];        // ms/attempt of each seed
  unfilledCounts: number[];      // unfilled slots in best result of each seed
  feasibleAll: boolean;          // all seeds reached feasibility
  // Aggregates
  bestMean: number;
  bestStdev: number;
  bestMin: number;               // worst best-score across seeds (most negative)
  bestMax: number;               // best best-score across seeds (least negative)
  bestMedian: number;
  totalMsMean: number;
  perAttemptMsMean: number;
  unfilledMax: number;           // worst-case unfilled
}

function aggregate(label: string, configRow: { attempts: number; maxIter: number; maxTime: number }, workload: { participants: number; tasks: number; slots: number; days: number }, runs: RunOutcome[]): CellStats {
  const bestScores = runs.map((r) => r.bestScore);
  const perRunMs = runs.map((r) => r.totalMs);
  const perAttemptMs = runs.map((r) => r.perAttemptMs);
  const unfilledCounts = runs.map((r) => r.bestUnfilled);
  const feasibleAll = runs.every((r) => r.bestFeasible);

  const sortedBest = [...bestScores].sort((a, b) => a - b);
  const mean = bestScores.reduce((s, x) => s + x, 0) / bestScores.length;
  const variance = bestScores.reduce((s, x) => s + (x - mean) ** 2, 0) / bestScores.length;
  const stdev = Math.sqrt(variance);

  return {
    label,
    config: configRow,
    workload,
    seeds: runs.length,
    bestScores,
    perRunMs,
    perAttemptMs,
    unfilledCounts,
    feasibleAll,
    bestMean: mean,
    bestStdev: stdev,
    bestMin: sortedBest[0],
    bestMax: sortedBest[sortedBest.length - 1],
    bestMedian: sortedBest[Math.floor(sortedBest.length / 2)],
    totalMsMean: perRunMs.reduce((s, x) => s + x, 0) / perRunMs.length,
    perAttemptMsMean: perAttemptMs.reduce((s, x) => s + x, 0) / perAttemptMs.length,
    unfilledMax: Math.max(...unfilledCounts),
  };
}

function printCell(c: CellStats): void {
  console.log(
    `  ${c.label.padEnd(38)} ` +
    `mean=${c.bestMean.toFixed(0).padStart(6)} σ=${c.bestStdev.toFixed(0).padStart(5)} ` +
    `[min=${c.bestMin.toFixed(0).padStart(6)}, med=${c.bestMedian.toFixed(0).padStart(6)}, max=${c.bestMax.toFixed(0).padStart(6)}] ` +
    `t=${(c.totalMsMean/1000).toFixed(1)}s ` +
    `unfilled_max=${c.unfilledMax}` +
    (c.feasibleAll ? '' : ' ⚠ INFEASIBLE')
  );
}

// ─── Run a "cell" — N seeds of the same condition ──────────────────────────
async function runCell(
  label: string,
  attempts: number,
  configOverrides: Partial<SchedulerConfig>,
  seeds: number,
  participants: Participant[],
  tasks: Task[],
  numDays: number,
): Promise<CellStats> {
  const runs: RunOutcome[] = [];
  for (let s = 0; s < seeds; s++) {
    const r = await runOnce(attempts, configOverrides, participants, tasks, numDays);
    runs.push(r);
  }
  const cfg = { attempts, maxIter: configOverrides.maxIterations ?? 50000, maxTime: configOverrides.maxSolverTimeMs ?? 30000 };
  const workload = {
    participants: participants.length,
    tasks: tasks.length,
    slots: tasks.reduce((sum, t) => sum + t.slots.length, 0),
    days: numDays,
  };
  const c = aggregate(label, cfg, workload, runs);
  printCell(c);
  return c;
}

function saveJson(filename: string, data: unknown): void {
  const out = path.join(__dirname, 'results', filename);
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`  → saved ${out}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2] ?? 'all';

  console.log('Initializing store…');
  initStore();
  setScheduleDays(7);
  const allParticipants = getAllParticipants();
  console.log(`  default pool: ${allParticipants.length} participants`);

  const cells: CellStats[] = [];
  const t0 = Date.now();

  // ── R1: 4-way A/B at default workload, 10 seeds each ──────────────────
  if (arg === 'r1-fourway' || arg === 'all') {
    console.log('\n=== R1: 4-WAY A/B (default 7d workload, 10 seeds each) ===');
    const tasks = buildTasks(7, getScheduleDate());
    const slots = tasks.reduce((s, t) => s + t.slots.length, 0);
    console.log(`  workload: ${allParticipants.length} ppl, ${tasks.length} tasks, ${slots} slots, 7 days`);
    console.log('  format: label  mean=μ σ=σ [min, median, max]  t=wall  unfilled_max=u');

    cells.push(await runCell('A: default (100×50k, 30s)         ', 100, {}, 10, allParticipants, tasks, 7));
    cells.push(await runCell('B: many-attempts (200×50k, 30s)   ', 200, {}, 10, allParticipants, tasks, 7));
    cells.push(await runCell('C: blended (60×100k, 30s)         ', 60, { maxIterations: 100000 }, 10, allParticipants, tasks, 7));
    cells.push(await runCell('D: proposed-200k (30×200k, 30s)   ', 30, { maxIterations: 200000 }, 10, allParticipants, tasks, 7));
    cells.push(await runCell('E: matched-time-30 (30×200k, 30s) ', 30, { maxIterations: 200000 }, 10, allParticipants, tasks, 7));
  }

  // ── R2: pool size sweep (24, 36, 48), 6 seeds each ────────────────────
  if (arg === 'r2-pool' || arg === 'all') {
    console.log('\n=== R2: POOL SIZE SWEEP (24/36/48 ppl × 7d, 6 seeds each) ===');
    const tasks = buildTasks(7, getScheduleDate());

    for (const perGroup of [6, 9, 12]) {
      const subset = buildParticipantSubset(allParticipants, perGroup);
      console.log(`\n  --- pool size: ${subset.length} (${perGroup}/group) ---`);
      cells.push(await runCell(`pool${subset.length}: default (100×50k)    `, 100, {}, 6, subset, tasks, 7));
      cells.push(await runCell(`pool${subset.length}: proposed (30×200k)   `, 30, { maxIterations: 200000 }, 6, subset, tasks, 7));
    }
  }

  // ── R3: horizon sweep (3, 7, 14 days), 5 seeds each ───────────────────
  if (arg === 'r3-horizon' || arg === 'all') {
    console.log('\n=== R3: HORIZON SWEEP (3/7/14 days × 48 ppl, 5 seeds each) ===');
    for (const days of [3, 7, 14]) {
      const tasks = buildTasks(days, getScheduleDate());
      const slots = tasks.reduce((s, t) => s + t.slots.length, 0);
      console.log(`\n  --- horizon: ${days} days, ${tasks.length} tasks, ${slots} slots ---`);
      cells.push(await runCell(`days${days}: default (100×50k)       `, 100, {}, 5, allParticipants, tasks, days));
      cells.push(await runCell(`days${days}: proposed (30×200k)      `, 30, { maxIterations: 200000 }, 5, allParticipants, tasks, days));
    }
  }

  // ── R5: verify blended (60×100k) at the conditions it wasn't tested ────
  if (arg === 'r5-blended-fill' || arg === 'all') {
    console.log('\n=== R5: BLENDED (60×100k) fill-in at untested conditions ===');
    // Pool 36 × 7d
    {
      const subset = buildParticipantSubset(allParticipants, 9);
      const tasks = buildTasks(7, getScheduleDate());
      console.log(`\n  --- pool 36, 7 days ---`);
      cells.push(await runCell('pool36: blended (60×100k)         ', 60, { maxIterations: 100000 }, 6, subset, tasks, 7));
    }
    // Days 3, 48 ppl
    {
      const tasks = buildTasks(3, getScheduleDate());
      console.log(`\n  --- 48 ppl, 3 days ---`);
      cells.push(await runCell('days3: blended (60×100k)          ', 60, { maxIterations: 100000 }, 5, allParticipants, tasks, 3));
    }
    // Days 14, 48 ppl
    {
      const tasks = buildTasks(14, getScheduleDate());
      console.log(`\n  --- 48 ppl, 14 days ---`);
      cells.push(await runCell('days14: blended (60×100k)         ', 60, { maxIterations: 100000 }, 5, allParticipants, tasks, 14));
    }
  }

  // ── R4: stress test (24 ppl × 7d, force feasibility pressure) ─────────
  if (arg === 'r4-stress' || arg === 'all') {
    console.log('\n=== R4: STRESS (24 ppl × 7d, 8 seeds, look for feasibility differences) ===');
    const subset = buildParticipantSubset(allParticipants, 6); // 24 ppl
    const tasks = buildTasks(7, getScheduleDate());
    const slots = tasks.reduce((s, t) => s + t.slots.length, 0);
    console.log(`  workload: ${subset.length} ppl, ${tasks.length} tasks, ${slots} slots, 7 days`);
    cells.push(await runCell('stress: default (100×50k)         ', 100, {}, 8, subset, tasks, 7));
    cells.push(await runCell('stress: proposed (30×200k)        ', 30, { maxIterations: 200000 }, 8, subset, tasks, 7));
    cells.push(await runCell('stress: many-attempts (200×50k)   ', 200, {}, 8, subset, tasks, 7));
    cells.push(await runCell('stress: blended (60×100k)         ', 60, { maxIterations: 100000 }, 8, subset, tasks, 7));
  }

  const totalMs = Date.now() - t0;
  console.log(`\n=== ALL DONE (${(totalMs/1000).toFixed(1)}s) ===`);
  saveJson(`verify-${Date.now()}.json`, { totalMs, cells });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
