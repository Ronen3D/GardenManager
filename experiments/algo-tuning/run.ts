/**
 * One-off experimental harness for studying the optimizer's behavior.
 * Not part of the build. Run with:
 *   npx ts-node experiments/algo-tuning/run.ts [experimentName]
 *
 * Experiments:
 *   calibrate    — measure per-attempt cost on default settings
 *   exp1         — outer-loop convergence at default settings (best-so-far curve)
 *   exp2-iter    — sweep maxIterations cap (with time cap held high)
 *   exp2-time    — sweep maxSolverTimeMs cap (with iter cap held high)
 *   exp3-greedy  — greedy-only baseline (maxIterations=0)
 *   all          — run all of the above sequentially
 */

// ─── localStorage shim — MUST be set up before importing config-store ───────
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

// ─── Now safe to import the rest ──────────────────────────────────────────
import * as fs from 'fs';
import * as path from 'path';

import {
  type Participant,
  type SchedulerConfig,
  type SlotRequirement,
  type Task,
  DEFAULT_CONFIG,
} from '../../src/models/types';
import { SchedulingEngine } from '../../src/engine/scheduler';
import { generateShiftBlocks } from '../../src/shared/utils/time-utils';

// Import config-store as a module (it auto-runs initialization on import? let me be explicit)
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

// ─── Task instantiation (port of app.ts:generateTasksFromTemplates) ────────
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

// ─── Engine builder ─────────────────────────────────────────────────────────
function buildEngine(participants: Participant[], tasks: Task[], configOverrides: Partial<SchedulerConfig> = {}) {
  const restRules = getAllRestRules();
  const restRuleMap = new Map(restRules.map((r) => [r.id, r.durationHours]));
  const dayStartHour = getDayStartHour();

  const engine = new SchedulingEngine(configOverrides, undefined, restRuleMap, dayStartHour);
  // Compute period (7 days from baseDate)
  const baseDate = getScheduleDate();
  const periodStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0);
  engine.setPeriod(periodStart, getScheduleDays());

  engine.addParticipants(participants);
  engine.addTasks(tasks);
  return engine;
}

// ─── Per-attempt record ────────────────────────────────────────────────────
interface AttemptRecord {
  attempt: number;
  attemptScore: number;
  attemptUnfilled: number;
  attemptFeasible: boolean;
  bestScore: number;
  bestUnfilled: number;
  bestFeasible: boolean;
  improved: boolean;
  cumulativeMs: number;
}

interface RunResult {
  label: string;
  config: { maxIterations: number; maxSolverTimeMs: number };
  attempts: number;
  totalMs: number;
  finalBest: { score: number; unfilled: number; feasible: boolean };
  attemptsLog: AttemptRecord[];
}

// ─── Run a single multi-attempt experiment ──────────────────────────────────
async function runExperiment(
  label: string,
  attempts: number,
  configOverrides: Partial<SchedulerConfig>,
  participants: Participant[],
  tasks: Task[],
  printProgress: boolean = true,
): Promise<RunResult> {
  const engine = buildEngine(participants, tasks, configOverrides);
  const cfg = engine.getConfig();
  const t0 = Date.now();
  const log: AttemptRecord[] = [];

  await engine.generateScheduleAsync(attempts, (info) => {
    const cumulativeMs = Date.now() - t0;
    log.push({
      attempt: info.attempt,
      attemptScore: info.attemptScore,
      attemptUnfilled: -1, // not exposed by current callback shape
      attemptFeasible: info.attemptFeasible,
      bestScore: info.currentBestScore,
      bestUnfilled: info.currentBestUnfilled,
      bestFeasible: info.currentBestFeasible,
      improved: info.improved,
      cumulativeMs,
    });
    if (printProgress && (info.attempt % 25 === 0 || info.improved)) {
      process.stdout.write(
        `  [${label}] attempt ${info.attempt}/${attempts}  ` +
        `attemptScore=${info.attemptScore.toFixed(2)}  ` +
        `bestScore=${info.currentBestScore.toFixed(2)}  bestUnfilled=${info.currentBestUnfilled}` +
        `${info.improved ? '  ★' : ''}\n`,
      );
    }
  });

  const totalMs = Date.now() - t0;
  const last = log[log.length - 1];
  return {
    label,
    config: { maxIterations: cfg.maxIterations, maxSolverTimeMs: cfg.maxSolverTimeMs },
    attempts,
    totalMs,
    finalBest: { score: last.bestScore, unfilled: last.bestUnfilled, feasible: last.bestFeasible },
    attemptsLog: log,
  };
}

// ─── Analysis helpers ──────────────────────────────────────────────────────
function summarize(r: RunResult): string {
  const log = r.attemptsLog;
  const n = log.length;
  if (n === 0) return `${r.label}: no attempts logged`;
  const last = log[n - 1];
  const attemptScores = log.map((a) => a.attemptScore);
  const sortedScores = [...attemptScores].sort((a, b) => a - b);
  const median = sortedScores[Math.floor(n / 2)];
  const p25 = sortedScores[Math.floor(n * 0.25)];
  const p75 = sortedScores[Math.floor(n * 0.75)];
  const mean = attemptScores.reduce((s, x) => s + x, 0) / n;
  const variance = attemptScores.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const min = sortedScores[0];
  const max = sortedScores[n - 1];

  // Find when bestSoFar reached within X% of final
  const finalBest = last.bestScore;
  const improvementsHistogram: number[] = [];
  log.forEach((a) => { if (a.improved) improvementsHistogram.push(a.attempt); });

  // Plateau analysis: at what attempt did we first reach within 1%, 5%, 10% of final
  const within = (frac: number): number | null => {
    // Score is composite (higher is better, can be negative). Distance from final:
    for (const a of log) {
      if (Math.abs(a.bestScore - finalBest) <= frac * Math.abs(finalBest)) return a.attempt;
    }
    return null;
  };

  const avgMs = r.totalMs / n;

  return [
    `\n── ${r.label} ──`,
    `  config: maxIter=${r.config.maxIterations}, maxSolverTimeMs=${r.config.maxSolverTimeMs}`,
    `  attempts: ${n}   total: ${(r.totalMs/1000).toFixed(1)}s   avg: ${avgMs.toFixed(0)}ms/attempt`,
    `  final best: score=${last.bestScore.toFixed(2)}, unfilled=${last.bestUnfilled}, feasible=${last.bestFeasible}`,
    `  per-attempt score:`,
    `    min=${min.toFixed(2)}, p25=${p25.toFixed(2)}, median=${median.toFixed(2)}, p75=${p75.toFixed(2)}, max=${max.toFixed(2)}`,
    `    mean=${mean.toFixed(2)}, stdev=${stdev.toFixed(2)}`,
    `  improvements fired: ${improvementsHistogram.length} times`,
    `    first 10: [${improvementsHistogram.slice(0, 10).join(', ')}]`,
    `    last 5:   [${improvementsHistogram.slice(-5).join(', ')}]`,
    `  best-so-far reached within:`,
    `    10% of final at attempt: ${within(0.10) ?? 'never'}`,
    `    5%  of final at attempt: ${within(0.05) ?? 'never'}`,
    `    1%  of final at attempt: ${within(0.01) ?? 'never'}`,
    ``,
  ].join('\n');
}

function saveJson(filename: string, data: unknown): void {
  const out = path.join(__dirname, 'results', filename);
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  console.log(`  → saved ${out}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2] ?? 'all';

  console.log('Initializing store with default seed data…');
  initStore();
  setScheduleDays(7);
  const participants = getAllParticipants();
  const tasks = buildTasks(7, getScheduleDate());
  const totalSlots = tasks.reduce((s, t) => s + t.slots.length, 0);
  console.log(`  participants: ${participants.length}`);
  console.log(`  tasks: ${tasks.length}`);
  console.log(`  total slot-instances: ${totalSlots}`);
  console.log(`  per-day tasks: ~${(tasks.length / 7).toFixed(1)}`);
  console.log('');

  const results: RunResult[] = [];
  const t0 = Date.now();

  // ── Calibration: 10 attempts at default settings ───────────────────────
  if (arg === 'calibrate' || arg === 'all') {
    console.log('=== CALIBRATION (10 attempts, default config) ===');
    const r = await runExperiment('calibrate-defaults', 10, {}, participants, tasks);
    results.push(r);
    console.log(summarize(r));
    const avgMs = r.totalMs / r.attemptsLog.length;
    console.log(`>> Avg per-attempt: ${avgMs.toFixed(0)}ms. 100 attempts ≈ ${(avgMs * 100 / 1000).toFixed(1)}s, 300 ≈ ${(avgMs * 300 / 1000).toFixed(1)}s.\n`);
  }

  // ── Experiment 1: outer-loop convergence (200 attempts × 3 seeds) ──────
  if (arg === 'exp1' || arg === 'all') {
    console.log('=== EXP1: outer-loop convergence (3 runs × 200 attempts) ===');
    for (let seed = 1; seed <= 3; seed++) {
      const r = await runExperiment(`exp1-seed${seed}`, 200, {}, participants, tasks);
      results.push(r);
      console.log(summarize(r));
    }
  }

  // ── Experiment 2-iter: sweep maxIterations cap ─────────────────────────
  if (arg === 'exp2-iter' || arg === 'all') {
    console.log('=== EXP2-ITER: sweep maxIterations (50 attempts each, time cap=60s) ===');
    const iterCaps = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000];
    for (const cap of iterCaps) {
      const r = await runExperiment(
        `exp2-iter-${cap}`,
        50,
        { maxIterations: cap, maxSolverTimeMs: 60000 },
        participants,
        tasks,
        false,
      );
      results.push(r);
      console.log(summarize(r));
    }
  }

  // ── Experiment 2-time: sweep maxSolverTimeMs cap ───────────────────────
  if (arg === 'exp2-time' || arg === 'all') {
    console.log('=== EXP2-TIME: sweep maxSolverTimeMs (50 attempts each, iter cap=200000) ===');
    const timeCaps = [50, 200, 1000, 5000, 30000];
    for (const cap of timeCaps) {
      const r = await runExperiment(
        `exp2-time-${cap}`,
        50,
        { maxIterations: 200000, maxSolverTimeMs: cap },
        participants,
        tasks,
        false,
      );
      results.push(r);
      console.log(summarize(r));
    }
  }

  // ── Experiment 4: matched-wall-time A/B (default vs. proposed) ─────────
  if (arg === 'exp4-compare' || arg === 'all') {
    console.log('=== EXP4-COMPARE: default vs. proposed at matched wall time, 5 seeds each ===');
    for (let seed = 1; seed <= 5; seed++) {
      const r = await runExperiment(
        `exp4-default-seed${seed}`,
        100,
        { maxIterations: 50000, maxSolverTimeMs: 30000 },
        participants,
        tasks,
        false,
      );
      results.push(r);
      console.log(summarize(r));
    }
    for (let seed = 1; seed <= 5; seed++) {
      const r = await runExperiment(
        `exp4-proposed-seed${seed}`,
        30,
        { maxIterations: 500000, maxSolverTimeMs: 2000 },
        participants,
        tasks,
        false,
      );
      results.push(r);
      console.log(summarize(r));
    }
  }

  // ── Experiment 3: greedy-only baseline ─────────────────────────────────
  if (arg === 'exp3-greedy' || arg === 'all') {
    console.log('=== EXP3-GREEDY: maxIterations=0 (50 attempts) ===');
    const r = await runExperiment(
      'exp3-greedy',
      50,
      { maxIterations: 0, maxSolverTimeMs: 60000 },
      participants,
      tasks,
      false,
    );
    results.push(r);
    console.log(summarize(r));
  }

  const totalMs = Date.now() - t0;
  console.log(`\n=== ALL DONE (${(totalMs/1000).toFixed(1)}s total) ===`);
  saveJson(`results-${Date.now()}.json`, { totalMs, runs: results });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
