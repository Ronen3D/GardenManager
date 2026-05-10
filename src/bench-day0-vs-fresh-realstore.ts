/**
 * Bench — "X days fresh" vs "(X-1) + day-0 phantom" using the REAL store seed.
 *
 * Same comparison as `bench-day0-vs-fresh.ts`, but reads participants and
 * task templates from `web/config-store.ts` instead of a hand-coded fixture.
 * This forces a Node localStorage shim so the store's first-run seed path
 * (`seedDefaultParticipants` + `seedDefaultTaskTemplates`) executes.
 *
 * The original `bench-day0-vs-fresh.ts` used `generateWeeklyTasks` from
 * `tasks/cli-task-factory.ts` — which is documented (`cli-task-factory.ts:6-8`)
 * as NOT used by the web app. This version uses the actual web-app templates.
 *
 * Run with:
 *   npx ts-node src/bench-day0-vs-fresh-realstore.ts
 *
 * Tunable env vars (same as the fixture-based bench).
 */

// ─── localStorage shim — must run BEFORE importing config-store ─────────────
{
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
    get length() {
      return Object.keys(mem).length;
    },
    key: (i: number) => Object.keys(mem)[i] ?? null,
  } as Storage;
}

import { type OptimizationResult, optimizeMultiAttempt } from './engine/optimizer';
import { buildPhantomContext, mergePhantomRules, type PhantomContext } from './engine/phantom';
import type { ContinuityAssignment, ContinuityParticipant, ContinuitySnapshot } from './models/continuity-schema';
import {
  DEFAULT_CONFIG,
  type Participant,
  type SchedulerConfig,
  type SlotRequirement,
  type Task,
  type TaskTemplate,
} from './models/types';
import { computeTemplateSectionKey } from './shared/layout-key';
import { generateShiftBlocks, hourInOpDay } from './shared/utils/time-utils';
import * as store from './web/config-store';

// ─── Node-side mirror of `app.ts:generateTasksFromTemplates()` ──────────────
// Pure-data version — accepts everything explicitly so we can drive `numDays`
// and `baseDate` without going through the store.

let _tSlotCounter = 0;
let _tTaskCounter = 0;

function buildTasksFromTemplates(
  numDays: number,
  baseDate: Date,
  dayStartHour: number,
  templates: TaskTemplate[],
): Task[] {
  _tSlotCounter = 0;
  _tTaskCounter = 0;
  const allTasks: Task[] = [];

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
      const startDate = new Date(hourInOpDay(baseDate, dayStartHour, dayIdx + 1, tpl.startHour));
      const shifts: { start: Date; end: Date }[] =
        tpl.shiftsPerDay === 1
          ? [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }]
          : generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams) {
          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) continue;
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              label: s.label,
              subTeamLabel: st.name,
              subTeamId: st.id,
            });
          }
        }
        for (const s of tpl.slots) {
          if (s.acceptableLevels.length === 0) continue;
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }
        if (slots.length === 0) continue;

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_tTaskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          restRuleId: tpl.restRuleId,
          sleepRecovery: tpl.sleepRecovery
            ? { ...tpl.sleepRecovery, triggerShifts: [...tpl.sleepRecovery.triggerShifts] }
            : undefined,
          shiftIndex: si + 1,
          sectionKey: computeTemplateSectionKey(tpl),
          color: tpl.color || '#7f8c8d',
        });
      }
    }
  }
  return allTasks;
}

// ─── Make the store-seeded participants span the bench window ──────────────
// `seedDefaultParticipants` builds availability windows that start "now" and
// run forward — perfect for the web UI but not aligned to our chosen baseDate.
// Patch each participant's availability to a wide window around baseDate so
// HC-3 doesn't reject every assignment.

function widenAvailability(participants: Participant[], baseDate: Date, spanDays: number): Participant[] {
  return participants.map((p) => ({
    ...p,
    availability: [
      {
        start: new Date(baseDate.getTime() - 24 * 3600000),
        end: new Date(baseDate.getTime() + (spanDays + 2) * 24 * 3600000),
      },
    ],
  }));
}

// ─── Day-0 baseline: best of N fresh 1-day attempts ────────────────────────

function buildPriorDaySnapshot(
  participants: Participant[],
  templates: TaskTemplate[],
  baseDate: Date,
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  dayStartHour: number,
  attempts: number,
): { snapshot: ContinuitySnapshot; durationMs: number; assignmentCount: number; totalSlots: number } {
  const priorDate = new Date(baseDate.getTime() - 24 * 3600000);
  const priorTasks = buildTasksFromTemplates(1, priorDate, dayStartHour, templates);
  const totalSlots = priorTasks.reduce((s, t) => s + t.slots.length, 0);

  const t0 = Date.now();
  const result: OptimizationResult = optimizeMultiAttempt(
    priorTasks,
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

  const taskById = new Map(priorTasks.map((t) => [t.id, t]));
  const partById = new Map(participants.map((pp) => [pp.id, pp]));
  const byParticipant = new Map<string, ContinuityAssignment[]>();

  for (const a of result.assignments) {
    const t = taskById.get(a.taskId);
    if (!t) continue;
    const ca: ContinuityAssignment = {
      sourceName: t.sourceName ?? t.name,
      taskName: t.name,
      timeBlock: {
        start: t.timeBlock.start.toISOString(),
        end: t.timeBlock.end.toISOString(),
      },
      blocksConsecutive: t.blocksConsecutive ?? false,
      restRuleId: t.restRuleId,
      restRuleDurationHours: t.restRuleId ? (restRuleMap.get(t.restRuleId) ?? 0) / 3600000 : undefined,
      baseLoadWeight: t.baseLoadWeight,
      loadWindows: t.loadWindows?.map((lw) => ({
        id: lw.id ?? `lw-${Math.random().toString(36).slice(2, 8)}`,
        startHour: lw.startHour,
        startMinute: lw.startMinute,
        endHour: lw.endHour,
        endMinute: lw.endMinute,
        weight: lw.weight,
        blocksAtBoundary: lw.blocksAtBoundary,
      })),
    };
    const arr = byParticipant.get(a.participantId) ?? [];
    arr.push(ca);
    byParticipant.set(a.participantId, arr);
  }

  const snapParticipants: ContinuityParticipant[] = [];
  for (const [pid, asgns] of byParticipant) {
    const part = partById.get(pid);
    if (!part) continue;
    snapParticipants.push({
      name: part.name,
      level: part.level,
      certifications: part.certifications,
      group: part.group,
      assignments: asgns,
    });
  }

  return {
    snapshot: {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      dayIndex: 1,
      dayWindow: { start: priorDate.toISOString(), end: baseDate.toISOString() },
      participants: snapParticipants,
    },
    durationMs,
    assignmentCount: result.assignments.length,
    totalSlots,
  };
}

// ─── Run kinds ──────────────────────────────────────────────────────────────

interface RunResult {
  durationMs: number;
  bestScore: number;
  bestUnfilled: number;
  totalSlots: number;
  daysCovered: number;
  totalTasks: number;
  feasible: boolean;
}

function totalSlotsOf(tasks: Task[]): number {
  let s = 0;
  for (const t of tasks) s += t.slots.length;
  return s;
}

function runFresh(
  X: number,
  baseDate: Date,
  participants: Participant[],
  templates: TaskTemplate[],
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
): RunResult {
  const tasks = buildTasksFromTemplates(X, baseDate, dayStartHour, templates);
  const t0 = Date.now();
  const result = optimizeMultiAttempt(
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
  return {
    durationMs,
    bestScore: result.score.compositeScore,
    bestUnfilled: result.unfilledSlots.length,
    totalSlots: totalSlotsOf(tasks),
    daysCovered: X,
    totalTasks: tasks.length,
    feasible: result.feasible,
  };
}

function runWithDay0(
  X: number,
  baseDate: Date,
  participants: Participant[],
  templates: TaskTemplate[],
  config: SchedulerConfig,
  baseRestRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
  day0Snapshot: ContinuitySnapshot,
): RunResult {
  const optimizeDays = X - 1;
  const tasks = buildTasksFromTemplates(optimizeDays, baseDate, dayStartHour, templates);
  const phantomCtx: PhantomContext = buildPhantomContext(day0Snapshot, participants);
  const restRuleMap = mergePhantomRules(baseRestRuleMap, phantomCtx);

  const t0 = Date.now();
  const result = optimizeMultiAttempt(
    tasks,
    participants,
    config,
    [],
    attempts,
    undefined,
    undefined,
    phantomCtx,
    restRuleMap,
    undefined,
    undefined,
    dayStartHour,
  );
  const durationMs = Date.now() - t0;
  return {
    durationMs,
    bestScore: result.score.compositeScore,
    bestUnfilled: result.unfilledSlots.length,
    totalSlots: totalSlotsOf(tasks),
    daysCovered: optimizeDays,
    totalTasks: tasks.length,
    feasible: result.feasible,
  };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

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

function welchT(a: number[], b: number[]): { t: number; p: number } {
  const ma = mean(a),
    mb = mean(b);
  const va = stddev(a) ** 2,
    vb = stddev(b) ** 2;
  const na = a.length,
    nb = b.length;
  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) return { t: 0, p: 1 };
  const t = (ma - mb) / se;
  const z = Math.abs(t);
  return { t, p: 2 * (1 - normalCdf(z)) };
}
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const tt = 1 / (1 + 0.3275911 * ax);
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429;
  const y = 1 - ((((a5 * tt + a4) * tt + a3) * tt + a2) * tt + a1) * tt * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}
function star(p: number): string {
  if (p < 0.001) return '***';
  if (p < 0.01) return ' **';
  if (p < 0.05) return '  *';
  if (p < 0.1) return '  .';
  return '   ';
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const NUM_RUNS = parseInt(process.env.BENCH_RUNS ?? '10', 10);
  const ATTEMPTS = parseInt(process.env.BENCH_ATTEMPTS ?? '30', 10);
  const MAX_TIME_MS = parseInt(process.env.BENCH_MAX_TIME_MS ?? '8000', 10);
  const DAY0_ATTEMPTS = parseInt(process.env.BENCH_DAY0_ATTEMPTS ?? '20', 10);
  const DAYS = (process.env.BENCH_DAYS ?? '3,5,7').split(',').map((s) => parseInt(s.trim(), 10));

  // Initialize store from defaults (localStorage shim above ensures clean seed)
  store.initStore();
  const baseParticipants = store.getAllParticipants();
  const templates = store.getAllTaskTemplates();
  const restRuleMap = store.buildRestRuleMap();
  const dayStartHour = store.getDayStartHour();

  // The configured Day Start Hour for the default seed is taken from the
  // store. The default availability windows were anchored "now"; we widen
  // them to a fixed bench baseDate so HC-3 doesn't reject all assignments.
  const config: SchedulerConfig = { ...DEFAULT_CONFIG, maxSolverTimeMs: MAX_TIME_MS };
  const baseDate = new Date(2026, 1, 16);
  const maxX = Math.max(...DAYS);
  const participants = widenAvailability(baseParticipants, baseDate, maxX);

  // Diagnostic: what's the seeded fixture really like?
  const grouped = new Map<string, number>();
  for (const p of participants) grouped.set(p.group, (grouped.get(p.group) ?? 0) + 1);
  const totalSlotsPerDay = buildTasksFromTemplates(1, baseDate, dayStartHour, templates).reduce(
    (s, t) => s + t.slots.length,
    0,
  );

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('Bench (REAL store seed) — "X days fresh" vs "(X-1) + day-0 phantom"');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  Days tested:      X ∈ { ${DAYS.join(', ')} }`);
  console.log(`  Runs per cell:    ${NUM_RUNS}`);
  console.log(`  Attempts/run:     ${ATTEMPTS}`);
  console.log(`  SA cap:           ${MAX_TIME_MS}ms per attempt`);
  console.log(`  Day-0 attempts:   ${DAY0_ATTEMPTS} (one-time setup per X)`);
  console.log(`  Real seed loaded: ${participants.length} participants, ${templates.length} templates`);
  console.log(`  Groups:           ${[...grouped.entries()].map(([g, n]) => `${g}=${n}`).join(', ')}`);
  console.log(`  Slots / day:      ${totalSlotsPerDay}`);
  console.log(
    `  Rest rules:       ${[...restRuleMap.entries()].map(([k, v]) => `${k}=${(v / 3600000).toFixed(1)}h`).join(', ') || '(none)'}`,
  );
  console.log(`  Day start hour:   ${dayStartHour}`);
  console.log('───────────────────────────────────────────────────────────────────────────');

  interface CellResult {
    X: number;
    approach: 'A-fresh' | 'B-day0';
    runs: RunResult[];
    day0BuildMs?: number;
    day0Assignments?: number;
    day0TotalSlots?: number;
  }
  const cells: CellResult[] = [];

  // Build day-0 baseline once per X (templates and participants are X-independent now,
  // so we could share — but we keep the per-X structure for parity with the prior bench).
  const day0ByX = new Map<
    number,
    { snapshot: ContinuitySnapshot; durationMs: number; assignmentCount: number; totalSlots: number }
  >();
  console.log('\nBuilding day-0 baselines (best of N attempts on a fresh 1-day schedule)...');
  for (const X of DAYS) {
    process.stdout.write(`  X=${X}: building day-0 (${DAY0_ATTEMPTS} attempts)... `);
    const r = buildPriorDaySnapshot(
      participants,
      templates,
      baseDate,
      config,
      restRuleMap,
      dayStartHour,
      DAY0_ATTEMPTS,
    );
    day0ByX.set(X, r);
    console.log(`${(r.durationMs / 1000).toFixed(2)}s, ${r.assignmentCount}/${r.totalSlots} assignments`);
  }
  console.log('───────────────────────────────────────────────────────────────────────────');

  for (const X of DAYS) {
    const day0 = day0ByX.get(X)!;

    console.log(`\n[X=${X}] === Approach A: optimize ${X} days fresh ===`);
    process.stdout.write(`  ${NUM_RUNS} runs... `);
    const t0 = Date.now();
    const aRuns: RunResult[] = [];
    for (let r = 0; r < NUM_RUNS; r++) {
      aRuns.push(runFresh(X, baseDate, participants, templates, config, restRuleMap, ATTEMPTS, dayStartHour));
      process.stdout.write('.');
    }
    console.log(` done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    cells.push({ X, approach: 'A-fresh', runs: aRuns });

    console.log(`[X=${X}] === Approach B: optimize ${X - 1} days + day-0 phantom ===`);
    process.stdout.write(`  ${NUM_RUNS} runs... `);
    const t1 = Date.now();
    const bRuns: RunResult[] = [];
    for (let r = 0; r < NUM_RUNS; r++) {
      bRuns.push(
        runWithDay0(X, baseDate, participants, templates, config, restRuleMap, ATTEMPTS, dayStartHour, day0.snapshot),
      );
      process.stdout.write('.');
    }
    console.log(` done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    cells.push({
      X,
      approach: 'B-day0',
      runs: bRuns,
      day0BuildMs: day0.durationMs,
      day0Assignments: day0.assignmentCount,
      day0TotalSlots: day0.totalSlots,
    });
  }

  // ─── Per-X comparison ─────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('PER-X COMPARISON — runtime, score, unfilled, variance');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  for (const X of DAYS) {
    const a = cells.find((c) => c.X === X && c.approach === 'A-fresh')!;
    const b = cells.find((c) => c.X === X && c.approach === 'B-day0')!;
    const aDur = a.runs.map((r) => r.durationMs);
    const bDur = b.runs.map((r) => r.durationMs);
    const aScore = a.runs.map((r) => r.bestScore);
    const bScore = b.runs.map((r) => r.bestScore);
    const aUnf = a.runs.map((r) => r.bestUnfilled);
    const bUnf = b.runs.map((r) => r.bestUnfilled);
    const aSlots = a.runs[0].totalSlots;
    const bSlots = b.runs[0].totalSlots;
    const aDays = a.runs[0].daysCovered;
    const bDays = b.runs[0].daysCovered;
    const aTasks = a.runs[0].totalTasks;
    const bTasks = b.runs[0].totalTasks;

    console.log(`\n──── X = ${X} days ────`);
    console.log(
      `Problem size:   A = ${aTasks} tasks (${aSlots} slots, ${aDays}d)   B = ${bTasks} tasks (${bSlots} slots, ${bDays}d) + ${b.day0Assignments}/${b.day0TotalSlots} phantom`,
    );
    console.log(`Day-0 setup:    ${(b.day0BuildMs! / 1000).toFixed(2)}s (one-time, amortizable)`);

    console.log('');
    console.log(`  RUNTIME (optimizer-only, ms):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aDur), 0)} ± ${fmt(stddev(aDur), 0)}    median ${fmt(median(aDur), 0)}    min ${fmt(Math.min(...aDur), 0)}    max ${fmt(Math.max(...aDur), 0)}`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bDur), 0)} ± ${fmt(stddev(bDur), 0)}    median ${fmt(median(bDur), 0)}    min ${fmt(Math.min(...bDur), 0)}    max ${fmt(Math.max(...bDur), 0)}`,
    );
    const dPct = mean(aDur) === 0 ? 0 : ((mean(bDur) - mean(aDur)) / mean(aDur)) * 100;
    const dPv = welchT(bDur, aDur).p;
    console.log(
      `    Δ (B-A):   ${fmt(mean(bDur) - mean(aDur), 0)}ms (${dPct >= 0 ? '+' : ''}${fmt(dPct, 1)}%)   p=${fmt(dPv, 4)}${star(dPv)}`,
    );

    const aTotalMean = mean(aDur);
    const bTotalMean = mean(bDur) + b.day0BuildMs!;
    const dTotalPct = aTotalMean === 0 ? 0 : ((bTotalMean - aTotalMean) / aTotalMean) * 100;
    console.log(`  TOTAL WALL-CLOCK (incl day-0 setup, ms):`);
    console.log(
      `    A-fresh:   ${fmt(aTotalMean, 0)}    B-day0+setup: ${fmt(bTotalMean, 0)}    Δ ${dTotalPct >= 0 ? '+' : ''}${fmt(dTotalPct, 1)}%`,
    );

    const aScoreP = aScore.map((s) => s / aDays);
    const bScoreP = bScore.map((s) => s / bDays);
    console.log('');
    console.log(`  COMPOSITE SCORE (raw, NOT directly comparable):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aScore), 2)} ± ${fmt(stddev(aScore), 2)}    median ${fmt(median(aScore), 2)}`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bScore), 2)} ± ${fmt(stddev(bScore), 2)}    median ${fmt(median(bScore), 2)}`,
    );
    console.log(`  SCORE / SCORED-DAY (normalised):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aScoreP), 2)} ± ${fmt(stddev(aScoreP), 2)}    median ${fmt(median(aScoreP), 2)}`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bScoreP), 2)} ± ${fmt(stddev(bScoreP), 2)}    median ${fmt(median(bScoreP), 2)}`,
    );
    const scorePv = welchT(bScoreP, aScoreP).p;
    const scorePctDiff = mean(aScoreP) === 0 ? 0 : ((mean(bScoreP) - mean(aScoreP)) / Math.abs(mean(aScoreP))) * 100;
    console.log(
      `    Δ (B-A) /day:   ${fmt(mean(bScoreP) - mean(aScoreP), 2)} (${scorePctDiff >= 0 ? '+' : ''}${fmt(scorePctDiff, 2)}%)   p=${fmt(scorePv, 4)}${star(scorePv)}`,
    );

    const aUnfPct = aUnf.map((u, i) => (u / a.runs[i].totalSlots) * 100);
    const bUnfPct = bUnf.map((u, i) => (u / b.runs[i].totalSlots) * 100);
    console.log('');
    console.log(`  UNFILLED SLOTS (raw count):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aUnf), 1)} ± ${fmt(stddev(aUnf), 1)}    median ${fmt(median(aUnf), 1)}    range [${Math.min(...aUnf)}, ${Math.max(...aUnf)}]`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bUnf), 1)} ± ${fmt(stddev(bUnf), 1)}    median ${fmt(median(bUnf), 1)}    range [${Math.min(...bUnf)}, ${Math.max(...bUnf)}]`,
    );
    console.log(`  UNFILLED RATE (% of slots):`);
    console.log(`    A-fresh:   mean ${fmt(mean(aUnfPct), 2)}%`);
    console.log(`    B-day0:    mean ${fmt(mean(bUnfPct), 2)}%`);

    const aFeas = a.runs.filter((r) => r.feasible).length;
    const bFeas = b.runs.filter((r) => r.feasible).length;
    console.log(`  FEASIBLE RUNS:   A: ${aFeas}/${a.runs.length}   B: ${bFeas}/${b.runs.length}`);
  }

  // ─── Cross-X compact matrix ───────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY MATRIX');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(
    `${'X'.padEnd(4)} | ${'A-time(ms)'.padStart(12)} | ${'B-time(ms)'.padStart(12)} | ${'Δtime%'.padStart(8)} | ${'A-score/d'.padStart(10)} | ${'B-score/d'.padStart(10)} | ${'Δscore%'.padStart(8)} | ${'A-unf%'.padStart(8)} | ${'B-unf%'.padStart(8)}`,
  );
  console.log('─'.repeat(110));
  for (const X of DAYS) {
    const a = cells.find((c) => c.X === X && c.approach === 'A-fresh')!;
    const b = cells.find((c) => c.X === X && c.approach === 'B-day0')!;
    const aDurMean = mean(a.runs.map((r) => r.durationMs));
    const bDurMean = mean(b.runs.map((r) => r.durationMs));
    const aDays = a.runs[0].daysCovered;
    const bDays = b.runs[0].daysCovered;
    const aScoreP = mean(a.runs.map((r) => r.bestScore / aDays));
    const bScoreP = mean(b.runs.map((r) => r.bestScore / bDays));
    const aUnfPct = mean(a.runs.map((r) => (r.bestUnfilled / r.totalSlots) * 100));
    const bUnfPct = mean(b.runs.map((r) => (r.bestUnfilled / r.totalSlots) * 100));
    const dTime = aDurMean === 0 ? 0 : ((bDurMean - aDurMean) / aDurMean) * 100;
    const dScore = aScoreP === 0 ? 0 : ((bScoreP - aScoreP) / Math.abs(aScoreP)) * 100;
    console.log(
      `${String(X).padEnd(4)} | ${fmt(aDurMean, 0).padStart(12)} | ${fmt(bDurMean, 0).padStart(12)} | ${(`${dTime >= 0 ? '+' : ''}${fmt(dTime, 1)}%`).padStart(8)} | ${fmt(aScoreP, 2).padStart(10)} | ${fmt(bScoreP, 2).padStart(10)} | ${(`${dScore >= 0 ? '+' : ''}${fmt(dScore, 2)}%`).padStart(8)} | ${fmt(aUnfPct, 2).padStart(8)} | ${fmt(bUnfPct, 2).padStart(8)}`,
    );
  }

  console.log('\n─── Raw per-run (sanity) ────────────────────────────────────────────────');
  for (const c of cells) {
    const tag = `X=${c.X} ${c.approach}`;
    const scores = c.runs.map((r) => fmt(r.bestScore, 1)).join(', ');
    const times = c.runs.map((r) => fmt(r.durationMs, 0)).join(', ');
    const unfs = c.runs.map((r) => String(r.bestUnfilled)).join(', ');
    console.log(`  [${tag.padEnd(13)}] score : ${scores}`);
    console.log(`  [${tag.padEnd(13)}] time  : ${times}`);
    console.log(`  [${tag.padEnd(13)}] unfilled: ${unfs}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
}

main();
