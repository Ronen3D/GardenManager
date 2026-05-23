/**
 * Bench — Shift-splitting regression-safety checkpoint (plan Stage 1).
 *
 * Purpose
 *   The shift-splitting feature touches the engine core. Before any behavior
 *   change lands we capture a stable BASELINE of the current optimizer on a
 *   heavy, deterministic scenario. Every subsequent stage must keep the
 *   splitting-OFF path within noise of this baseline (the mandatory bar in the
 *   approved plan, D20), and — once the feature is wired — the splitting-ON
 *   path's feasibility cost must stay acceptable.
 *
 *   At Stage 1 only the OFF (= current behavior) column is meaningful; the
 *   feature does not exist yet. The harness is shaped so the ON column is a
 *   one-line drop-in after Stage 2 plumbs `splittingMode`: re-run this
 *   bench after Stages 2–5 and compare ON vs OFF / OFF vs this baseline.
 *
 * Scenario
 *   7 days of the CLI task factory (אדנית sameGroup + שמש guard with
 *   blocksConsecutive + demo-rest-rule, ממטרה/חממה with loadWindows), plus a
 *   sleepRecovery rule grafted onto the guard occurrences so HC-12/HC-14/HC-15
 *   and loadWindows are all exercised together. The participant pool is sized
 *   and availability-gapped so a handful of slots go unfilled — this is
 *   exactly the pressure the future feasibility split is meant to relieve.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CAPTURED OFF BASELINE — pre-feature main (v3.5.6), 2026-05-18
 *   Defaults: 7 days · 54 participants · 140 tasks / 434 slots · 5 runs ·
 *             20 attempts · SA cap 4000ms · DEFAULT_CONFIG
 *
 *     composite        mean  1995.60  ± 277.50   (range 1570.95 … 2217.56)
 *     unfilled slots   mean    56.2   ±   1.8    (53 … 57)
 *     runtime (ms)     mean  28967    ± 2420
 *     iterations       mean 100376    (deterministic — maxIterations cap)
 *     actual attempts  20/20
 *
 *   MANDATORY BAR (plan D20): after Stages 2–5 the splitting-OFF run must
 *   stay within ≈1σ of `composite` above (the SA stochastic envelope,
 *   ~±278) and must not change `unfilled`/`iterations` beyond noise.
 *   When the ON column is wired (post-Stage 2), ON feasibility cost must be
 *   acceptable and ON `unfilled` ≤ OFF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run with:
 *   npx ts-node src/bench-shift-split.ts
 *
 * Tunable via env vars:
 *   BENCH_RUNS         independent runs (default 5)
 *   BENCH_ATTEMPTS     attempts per run (default 20)
 *   BENCH_DAYS         schedule length in days (default 7)
 *   BENCH_MAX_TIME_MS  per-attempt SA cap (default 4000)
 *   BENCH_PARTICIPANTS pool size (default 54; lower ⇒ more unfilled pressure)
 */

import { type OptimizationResult, optimizeMultiAttempt, setBenchHooks } from './engine/optimizer';
import {
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type SchedulerConfig,
  type SleepRecoveryRule,
  type Task,
} from './models/types';
import { generateWeeklyTasks } from './tasks/cli-task-factory';

// ─── Heavy deterministic fixture ─────────────────────────────────────────────

const GROUPS = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];

/** Round-robin level/cert template (no L1 exists in the domain). */
const SPEC: Array<{ level: Level; certs: string[] }> = [
  { level: Level.L4, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L3, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L2, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L2, certs: ['Nitzan'] },
  { level: Level.L0, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L0, certs: ['Nitzan'] },
  { level: Level.L0, certs: ['Nitzan'] },
  { level: Level.L0, certs: ['Nitzan', 'Horesh'] },
];

/**
 * Deterministic constrained pool staffed near production level. Only every
 * 9th participant gets a *partial* (6-hour) unavailability window on one
 * mid-week day — light, targeted pressure that leaves a handful of slots
 * unfilled (the gap the future feasibility split is meant to relieve)
 * without the structural shortage that would swamp the composite signal.
 */
function buildHeavyFixture(baseDate: Date, spanDays: number, poolSize: number): Participant[] {
  const out: Participant[] = [];
  const dayMs = 24 * 3600000;
  for (let i = 0; i < poolSize; i++) {
    const spec = SPEC[i % SPEC.length];
    const id = `p${i + 1}`;
    // Light, targeted gap: ~1-in-9 participants loses a 6h afternoon window
    // on one mid-week day (deterministic by index).
    const gapDay = i % 9 === 4 ? 2 + (i % Math.max(1, spanDays - 2)) : -1;
    const dateUnavailability =
      gapDay > 0
        ? [
            {
              id: `du-${id}`,
              dayIndex: gapDay,
              startHour: 12,
              endHour: 18,
              allDay: false,
              reason: 'בנצ׳מרק — חוסר זמינות',
            },
          ]
        : [];
    out.push({
      id,
      name: `משתתף ${i + 1}`,
      level: spec.level,
      certifications: [...spec.certs],
      group: GROUPS[i % GROUPS.length],
      availability: [
        {
          start: new Date(baseDate.getTime() - dayMs),
          end: new Date(baseDate.getTime() + (spanDays + 1) * dayMs),
        },
      ],
      dateUnavailability,
    });
  }
  return out;
}

/** Graft an HC-15 sleep-recovery rule onto every guard ("שמש") occurrence. */
function attachSleepRecovery(tasks: Task[]): void {
  const rule: SleepRecoveryRule = { triggerShifts: [1], recoveryHours: 6 };
  for (const t of tasks) {
    if (t.sourceName === 'שמש') {
      t.sleepRecovery = { ...rule, triggerShifts: [...rule.triggerShifts] };
    }
  }
}

function buildScenario(baseDate: Date, days: number, poolSize: number): { tasks: Task[]; participants: Participant[] } {
  const tasks = generateWeeklyTasks(baseDate, days);
  attachSleepRecovery(tasks);
  const participants = buildHeavyFixture(baseDate, days, poolSize);
  return { tasks, participants };
}

// ─── Run kinds ───────────────────────────────────────────────────────────────

interface RunResult {
  durationMs: number;
  compositeScore: number; // under DEFAULT_CONFIG ⇒ directly comparable across runs/stages
  unfilled: number;
  totalSlots: number;
  totalTasks: number;
  feasible: boolean;
  iterations: number;
  saMs: number;
  actualAttempts: number;
  /** Split SLOTS in the realized schedule (count of `#a` halves). 0 for OFF. */
  splitSlots: number;
}

function totalSlotsOf(tasks: Task[]): number {
  let s = 0;
  for (const t of tasks) s += t.slots.length;
  return s;
}

function runOnce(
  baseDate: Date,
  days: number,
  poolSize: number,
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
  splitOn: boolean,
): RunResult {
  // Fresh scenario each run: generateWeeklyTasks resets internal id counters,
  // so tasks/ids are identical run-to-run (deterministic baseline).
  const { tasks, participants } = buildScenario(baseDate, days, poolSize);
  // ON column: stamp the effective `splittable` flag the web layer would
  // freeze (splittingMode !== 'off' && template.splittable). sameGroup
  // occurrences are skipped by structuralRefine and handled feasibility-only
  // by Stage-4 exactly as today, so flagging all is a realistic ON workload.
  if (splitOn) for (const t of tasks) t.splittable = true;
  setBenchHooks(null);
  const t0 = Date.now();
  const result: OptimizationResult = optimizeMultiAttempt(
    tasks,
    participants,
    config,
    [],
    attempts,
    undefined,
    undefined,
    undefined,
    restRuleMap,
    undefined,
    undefined,
    dayStartHour,
  );
  const durationMs = Date.now() - t0;
  const realized = result.tasks ?? tasks;
  let splitSlots = 0;
  for (const tk of realized) if (tk.splitPart === 1) splitSlots++;
  return {
    durationMs,
    compositeScore: result.score.compositeScore,
    unfilled: result.unfilledSlots.length,
    totalSlots: totalSlotsOf(tasks),
    totalTasks: tasks.length,
    feasible: result.feasible,
    iterations: result.iterations,
    saMs: result.phaseDurations.saMs,
    actualAttempts: result.actualAttempts,
    splitSlots,
  };
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}
function line(label: string, xs: number[], digits = 2): void {
  console.log(
    `  ${label.padEnd(22)} mean ${fmt(mean(xs), digits).padStart(12)}  ± ${fmt(stddev(xs), digits).padStart(10)}` +
      `  median ${fmt(median(xs), digits).padStart(12)}  [${fmt(Math.min(...xs), digits)}, ${fmt(Math.max(...xs), digits)}]`,
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const RUNS = parseInt(process.env.BENCH_RUNS ?? '5', 10);
  const ATTEMPTS = parseInt(process.env.BENCH_ATTEMPTS ?? '20', 10);
  const DAYS = parseInt(process.env.BENCH_DAYS ?? '7', 10);
  const MAX_TIME_MS = parseInt(process.env.BENCH_MAX_TIME_MS ?? '4000', 10);
  const POOL = parseInt(process.env.BENCH_PARTICIPANTS ?? '54', 10);

  const config: SchedulerConfig = { ...DEFAULT_CONFIG, maxSolverTimeMs: MAX_TIME_MS };
  const restRuleMap = new Map<string, number>([['demo-rest-rule', 5 * 3600000]]);
  const dayStartHour = 5;
  const baseDate = new Date(2026, 1, 16);

  const probe = buildScenario(baseDate, DAYS, POOL);

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('Bench — Shift-splitting regression-safety checkpoint (Stage 1 baseline)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  Days:            ${DAYS}`);
  console.log(`  Participants:    ${POOL}`);
  console.log(`  Tasks / slots:   ${probe.tasks.length} / ${totalSlotsOf(probe.tasks)}`);
  console.log(`  Runs:            ${RUNS}`);
  console.log(`  Attempts/run:    ${ATTEMPTS}`);
  console.log(`  SA cap:          ${MAX_TIME_MS}ms per attempt`);
  console.log(`  Config:          DEFAULT_CONFIG (composite directly comparable)`);
  console.log('───────────────────────────────────────────────────────────────────────────');
  console.log('  Column: OFF (current behavior). ON drops in after Stage 2 plumbs');
  console.log('  splittingMode — re-run then to enforce OFF-within-noise + ON-acceptable.');
  console.log('───────────────────────────────────────────────────────────────────────────');

  process.stdout.write(`Running ${RUNS} OFF runs `);
  const runs: RunResult[] = [];
  for (let r = 0; r < RUNS; r++) {
    runs.push(runOnce(baseDate, DAYS, POOL, config, restRuleMap, ATTEMPTS, dayStartHour, false));
    process.stdout.write('.');
  }
  console.log(' done.\n');

  console.log('─── OFF baseline ──────────────────────────────────────────────────────────');
  line(
    'runtime (ms)',
    runs.map((r) => r.durationMs),
    0,
  );
  line(
    'composite',
    runs.map((r) => r.compositeScore),
  );
  line(
    'unfilled slots',
    runs.map((r) => r.unfilled),
    1,
  );
  line(
    'unfilled %',
    runs.map((r) => (r.unfilled / r.totalSlots) * 100),
  );
  line(
    'iterations',
    runs.map((r) => r.iterations),
    0,
  );
  line(
    'SA ms (best attempt)',
    runs.map((r) => r.saMs),
    0,
  );
  line(
    'actual attempts',
    runs.map((r) => r.actualAttempts),
    0,
  );
  const feas = runs.filter((r) => r.feasible).length;
  console.log(`  ${'feasible runs'.padEnd(22)} ${feas}/${runs.length}`);

  console.log('\n─── Raw per-run (paste into the stage diffs to track drift) ───────────────');
  console.log(`  composite : ${runs.map((r) => fmt(r.compositeScore, 1)).join(', ')}`);
  console.log(`  unfilled  : ${runs.map((r) => r.unfilled).join(', ')}`);
  console.log(`  runtime   : ${runs.map((r) => fmt(r.durationMs, 0)).join(', ')}`);

  // ── ON column (Phase 2: quality split/merge enabled) ────────────────────
  process.stdout.write(`\nRunning ${RUNS} ON runs `);
  const onRuns: RunResult[] = [];
  for (let r = 0; r < RUNS; r++) {
    onRuns.push(runOnce(baseDate, DAYS, POOL, config, restRuleMap, ATTEMPTS, dayStartHour, true));
    process.stdout.write('.');
  }
  console.log(' done.\n');

  console.log('─── ON (splitting enabled) ────────────────────────────────────────────────');
  line(
    'runtime (ms)',
    onRuns.map((r) => r.durationMs),
    0,
  );
  line(
    'composite',
    onRuns.map((r) => r.compositeScore),
  );
  line(
    'unfilled slots',
    onRuns.map((r) => r.unfilled),
    1,
  );
  line(
    'split slots',
    onRuns.map((r) => r.splitSlots),
    1,
  );
  const onFeas = onRuns.filter((r) => r.feasible).length;
  console.log(`  ${'feasible runs'.padEnd(22)} ${onFeas}/${onRuns.length}`);

  // ── Regression bar (approved plan E4 / D20) ─────────────────────────────
  const BASE_COMPOSITE_MEAN = 1995.6;
  const BASE_COMPOSITE_SD = 277.5;
  const offComposite = mean(runs.map((r) => r.compositeScore));
  const offUnfilled = mean(runs.map((r) => r.unfilled));
  const onUnfilled = mean(onRuns.map((r) => r.unfilled));
  const onComposite = mean(onRuns.map((r) => r.compositeScore));
  const offWithin = Math.abs(offComposite - BASE_COMPOSITE_MEAN) <= 1.5 * BASE_COMPOSITE_SD;
  const onUnfilledOk = onUnfilled <= offUnfilled + 1e-9;
  const runtimeRatio = mean(onRuns.map((r) => r.durationMs)) / Math.max(1, mean(runs.map((r) => r.durationMs)));
  console.log('\n─── Verdict ───────────────────────────────────────────────────────────────');
  console.log(
    `  OFF composite within ≈1.5σ of pre-feature baseline (${fmt(BASE_COMPOSITE_MEAN, 1)}±${fmt(BASE_COMPOSITE_SD, 1)}):` +
      ` ${offWithin ? 'PASS' : 'FAIL'}  (OFF mean ${fmt(offComposite, 1)})`,
  );
  console.log(
    `  ON unfilled ≤ OFF unfilled: ${onUnfilledOk ? 'PASS' : 'FAIL'}` +
      `  (ON ${fmt(onUnfilled, 1)} vs OFF ${fmt(offUnfilled, 1)})`,
  );
  console.log(
    `  ON composite vs OFF: ${fmt(onComposite - offComposite, 1)} (≥0 ⇒ quality not regressed)` +
      `   ·   ON/OFF runtime ×${fmt(runtimeRatio, 2)}`,
  );
  console.log('═══════════════════════════════════════════════════════════════════════════');
}

main();
