/**
 * Bench — "X days fresh" vs "(X-1) days + day-0 phantom context"
 *
 * Question:
 *   Is it faster / better quality to optimize a full X-day schedule from
 *   scratch (Approach A), or to take an existing day-0 schedule, treat it as
 *   locked phantom context for hard constraints (HC-5/12/14/15 look-back),
 *   and only optimize the remaining X-1 days (Approach B)?
 *
 * Approach B mirrors the "המשך מכאן" (continue-from-here) flow in the web UI:
 * `buildPhantomContext` seeds the prior day's tasks/assignments into the
 * optimizer's eligibility indexes. Phantom assignments are NEVER swappable
 * and NEVER scored — they act purely as constraint context.
 *
 * Day-0 in B is built once per X via `buildPriorDaySnapshot` (best of N
 * fresh 1-day attempts), then reused across all NUM_RUNS for B. This mimics
 * the actual user workflow: the user already has day 0, they aren't picking
 * a new one each regenerate.
 *
 * Run with:
 *   npx ts-node src/bench-day0-vs-fresh.ts
 *
 * Tunable via env vars:
 *   BENCH_RUNS         number of independent runs per (X × approach) (default 10)
 *   BENCH_ATTEMPTS     attempts per run (default 30)
 *   BENCH_DAYS         csv of X-values to test (default: 3,5,7)
 *   BENCH_MAX_TIME_MS  per-attempt SA cap (default 8000)
 *   BENCH_DAY0_ATTEMPTS attempts when building day-0 baseline (default 20)
 */

import { type OptimizationResult, optimizeMultiAttempt, setBenchHooks } from './engine/optimizer';
import { buildPhantomContext, mergePhantomRules, type PhantomContext } from './engine/phantom';
import type { ContinuityAssignment, ContinuityParticipant, ContinuitySnapshot } from './models/continuity-schema';
import { DEFAULT_CONFIG, Level, type Participant, type SchedulerConfig, type Task } from './models/types';
import { generateWeeklyTasks } from './tasks/cli-task-factory';

// ─── Production-default 48-participant fixture (faithful to the system seed) ─

function p(
  id: string,
  name: string,
  level: Level,
  certs: string[],
  group: string,
  baseDate: Date,
  spanDays: number,
): Participant {
  return {
    id,
    name,
    level,
    certifications: certs,
    group,
    availability: [
      {
        start: new Date(baseDate.getTime() - 24 * 3600000),
        end: new Date(baseDate.getTime() + (spanDays + 1) * 24 * 3600000),
      },
    ],
    dateUnavailability: [],
  };
}

function buildProduction48(baseDate: Date, spanDays: number): Participant[] {
  const NAMES_BY_GROUP: Record<string, string[]> = {
    'קבוצה 1': [
      'איתי לוין',
      'נועה אברהמי',
      'יונתן רפאלי',
      'מאיה ישראלי',
      'עידו כהן',
      'עדי מזרחי',
      'רועי שפירא',
      'מיכל אשכנזי',
      'עומר דרוקר',
      'ענבר חזן',
      'אורי גבאי',
      'טל בן-דור',
    ],
    'קבוצה 2': [
      'דניאל וייס',
      'שירה אדרי',
      'נדב הראל',
      'ליאור פלד',
      'אסף גרינברג',
      'רוני סגל',
      'גיא מור',
      'יעל שלום',
      'אלון ברק',
      'הילה חדד',
      'מתן אלוני',
      'שחר עמר',
    ],
    'קבוצה 3': [
      'איתן דהן',
      'עמית מלכה',
      'דורון פרידמן',
      'נטע לביא',
      'יובל קליין',
      'קרן אורן',
      'אריאל נחום',
      'דנה צור',
      'אביב סוויסה',
      'גלית שדה',
      'תומר גולן',
      'ספיר מלמד',
    ],
    'קבוצה 4': [
      'אופיר ביטון',
      'נועם פרץ',
      'אייל רוזנפלד',
      'ליהי כץ',
      'בועז נאמן',
      'תמר יוספי',
      'יואב פולק',
      'סיון ריבלין',
      'אוהד שטרן',
      'רותם גנות',
      'ברק אוריון',
      'נעמה שקד',
    ],
  };
  const TEMPLATE: Array<{ level: Level; certs: string[] }> = [
    { level: Level.L4, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L3, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L2, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L2, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L0, certs: ['Nitzan'] },
    { level: Level.L0, certs: ['Nitzan'] },
    { level: Level.L0, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L0, certs: ['Nitzan', 'Hamama'] },
    { level: Level.L0, certs: ['Nitzan'] },
    { level: Level.L0, certs: ['Nitzan'] },
    { level: Level.L0, certs: ['Nitzan'] },
    { level: Level.L0, certs: ['Nitzan'] },
  ];
  const HORESH_INDICES: Record<string, Set<number>> = {
    'קבוצה 1': new Set([8, 9]),
    'קבוצה 2': new Set([8]),
    'קבוצה 3': new Set([8]),
  };
  const TASK_PREF: Record<string, { pref?: string; less?: string }> = {
    'איתי לוין': { pref: 'אדנית' },
    'נועה אברהמי': { less: 'כרוב' },
    'עידו כהן': { pref: 'כרוב' },
    'מאיה ישראלי': { less: 'אדנית' },
    'יונתן רפאלי': { pref: 'אדנית', less: 'כרוב' },
    'רועי שפירא': { pref: 'שמש' },
    'מיכל אשכנזי': { less: 'ממטרה' },
    'ענבר חזן': { pref: 'כרוב' },
    'אורי גבאי': { less: 'ערוגת בוקר' },
    'טל בן-דור': { pref: 'כרוב', less: 'ערוגת ערב' },
    'דניאל וייס': { pref: 'כרוב' },
    'שירה אדרי': { less: 'אדנית' },
    'אסף גרינברג': { pref: 'אדנית' },
    'ליאור פלד': { less: 'כרוב' },
    'נדב הראל': { pref: 'אדנית', less: 'כרוב' },
    'גיא מור': { pref: 'חממה' },
    'יעל שלום': { less: 'ממטרה' },
    'אלון ברק': { pref: 'כרוב' },
    'מתן אלוני': { less: 'ערוגת בוקר' },
    'שחר עמר': { pref: 'כרוב', less: 'ערוגת ערב' },
    'איתן דהן': { pref: 'אדנית' },
    'עמית מלכה': { less: 'כרוב' },
    'יובל קליין': { pref: 'כרוב' },
    'נטע לביא': { less: 'אדנית' },
    'דורון פרידמן': { pref: 'אדנית', less: 'כרוב' },
    'אריאל נחום': { pref: 'שמש' },
    'דנה צור': { less: 'ממטרה' },
    'אביב סוויסה': { pref: 'כרוב' },
    'גלית שדה': { pref: 'כרוב', less: 'ערוגת ערב' },
    'ספיר מלמד': { less: 'ערוגת בוקר' },
    'אופיר ביטון': { pref: 'כרוב' },
    'נועם פרץ': { less: 'אדנית' },
    'אייל רוזנפלד': { pref: 'אדנית' },
    'ליהי כץ': { less: 'כרוב' },
    'בועז נאמן': { pref: 'אדנית', less: 'כרוב' },
    'יואב פולק': { pref: 'חממה' },
    'סיון ריבלין': { less: 'ממטרה' },
    'אוהד שטרן': { pref: 'כרוב' },
    'רותם גנות': { less: 'ערוגת בוקר' },
    'נעמה שקד': { pref: 'כרוב', less: 'ערוגת ערב' },
  };
  const DATE_UNAVAIL: Record<
    string,
    Array<{ dayIndex: number; startHour: number; endHour: number; allDay: boolean; reason: string }>
  > = {
    'מאיה ישראלי': [{ dayIndex: 5, startHour: 14, endHour: 17, allDay: false, reason: 'לימודים' }],
    'עדי מזרחי': [{ dayIndex: 2, startHour: 10, endHour: 13, allDay: false, reason: 'רופא' }],
    'עומר דרוקר': [{ dayIndex: 1, startHour: 8, endHour: 16, allDay: false, reason: 'חופש משפחתי' }],
    'ליאור פלד': [{ dayIndex: 4, startHour: 16, endHour: 19, allDay: false, reason: 'אימון' }],
    'רוני סגל': [{ dayIndex: 3, startHour: 9, endHour: 12, allDay: false, reason: 'תור רפואי' }],
    'אלון ברק': [{ dayIndex: 5, startHour: 8, endHour: 16, allDay: false, reason: 'חופש' }],
    'נטע לביא': [{ dayIndex: 6, startHour: 13, endHour: 16, allDay: false, reason: 'שבת' }],
    'קרן אורן': [{ dayIndex: 2, startHour: 8, endHour: 11, allDay: false, reason: 'לימודים' }],
    'אריאל נחום': [{ dayIndex: 3, startHour: 8, endHour: 16, allDay: false, reason: 'משפחתי' }],
    'תמר יוספי': [{ dayIndex: 4, startHour: 11, endHour: 14, allDay: false, reason: 'תור' }],
    'יואב פולק': [{ dayIndex: 7, startHour: 8, endHour: 16, allDay: false, reason: 'חופש' }],
    'סיון ריבלין': [{ dayIndex: 1, startHour: 15, endHour: 18, allDay: false, reason: 'לימודים' }],
  };
  const NOT_WITH: Array<[string, string]> = [
    ['עדי מזרחי', 'טל בן-דור'],
    ['רועי שפירא', 'יעל שלום'],
    ['עומר דרוקר', 'ענבר חזן'],
    ['עומר דרוקר', 'אורי גבאי'],
    ['רוני סגל', 'שחר עמר'],
    ['גיא מור', 'הילה חדד'],
    ['אלון ברק', 'מתן אלוני'],
    ['אלון ברק', 'דנה צור'],
    ['קרן אורן', 'תומר גולן'],
    ['אריאל נחום', 'גלית שדה'],
    ['אביב סוויסה', 'ספיר מלמד'],
    ['אביב סוויסה', 'אורי גבאי'],
    ['תמר יוספי', 'ברק אוריון'],
    ['יואב פולק', 'רותם גנות'],
    ['אוהד שטרן', 'נעמה שקד'],
    ['אוהד שטרן', 'רוני סגל'],
  ];

  const out: Participant[] = [];
  const nameToId = new Map<string, string>();
  let pid = 0;
  const groups = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];
  for (const g of groups) {
    const names = NAMES_BY_GROUP[g];
    const horesh = HORESH_INDICES[g] ?? new Set<number>();
    for (let i = 0; i < 12; i++) {
      const spec = TEMPLATE[i];
      const certs = [...spec.certs];
      if (horesh.has(i)) certs.push('Horesh');
      const name = names[i];
      const id = `p${++pid}`;
      const part = p(id, name, spec.level, certs, g, baseDate, spanDays);
      const pref = TASK_PREF[name];
      const dateRules = DATE_UNAVAIL[name]?.filter((r) => r.dayIndex <= spanDays);
      part.dateUnavailability = dateRules ? dateRules.map((r, k) => ({ id: `du-${id}-${k}`, ...r })) : [];
      if (pref?.pref) part.preferredTaskName = pref.pref;
      if (pref?.less) part.lessPreferredTaskName = pref.less;
      out.push(part);
      nameToId.set(name, id);
    }
  }
  for (const [na, nb] of NOT_WITH) {
    const ia = nameToId.get(na);
    const ib = nameToId.get(nb);
    if (!ia || !ib) continue;
    const a = out.find((x) => x.id === ia);
    const b = out.find((x) => x.id === ib);
    if (a) a.notWithIds = [...(a.notWithIds ?? []), ib];
    if (b) b.notWithIds = [...(b.notWithIds ?? []), ia];
  }
  return out;
}

// ─── Day-0 baseline: best of N fresh 1-day attempts ────────────────────────

function buildPriorDaySnapshot(
  participants: Participant[],
  baseDate: Date,
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  dayStartHour: number,
  attempts: number,
): { snapshot: ContinuitySnapshot; durationMs: number; assignmentCount: number } {
  const priorDate = new Date(baseDate.getTime() - 24 * 3600000);
  const priorTasks = generateWeeklyTasks(priorDate, 1);

  setBenchHooks(null);
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
      dayWindow: {
        start: priorDate.toISOString(),
        end: baseDate.toISOString(),
      },
      participants: snapParticipants,
    },
    durationMs,
    assignmentCount: result.assignments.length,
  };
}

// ─── Run kinds ──────────────────────────────────────────────────────────────

interface RunResult {
  durationMs: number; // optimizer-only wall-clock
  bestScore: number;
  bestUnfilled: number;
  totalSlots: number;
  daysCovered: number; // days the optimizer worked on (X for A, X-1 for B)
  totalTasks: number;
  feasible: boolean;
  attemptScores: number[];
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
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
): RunResult {
  const tasks = generateWeeklyTasks(baseDate, X);
  setBenchHooks(null);
  const attemptScores: number[] = [];
  const t0 = Date.now();
  const result = optimizeMultiAttempt(
    tasks,
    participants,
    config,
    [],
    attempts,
    (info) => attemptScores.push(info.attemptScore),
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
    attemptScores,
  };
}

function runWithDay0(
  X: number,
  baseDate: Date,
  participants: Participant[],
  config: SchedulerConfig,
  baseRestRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
  day0Snapshot: ContinuitySnapshot,
): RunResult {
  // Optimize only X-1 days; day 0 is supplied as phantom context.
  const optimizeDays = X - 1;
  const tasks = generateWeeklyTasks(baseDate, optimizeDays);
  const phantomCtx: PhantomContext = buildPhantomContext(day0Snapshot, participants);
  const restRuleMap = mergePhantomRules(baseRestRuleMap, phantomCtx);

  setBenchHooks(null);
  const attemptScores: number[] = [];
  const t0 = Date.now();
  const result = optimizeMultiAttempt(
    tasks,
    participants,
    config,
    [],
    attempts,
    (info) => attemptScores.push(info.attemptScore),
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
    attemptScores,
  };
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

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
function min(xs: number[]): number {
  return Math.min(...xs);
}
function max(xs: number[]): number {
  return Math.max(...xs);
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

  const config: SchedulerConfig = { ...DEFAULT_CONFIG, maxSolverTimeMs: MAX_TIME_MS };
  const restRuleMap = new Map<string, number>([['demo-rest-rule', 5 * 3600000]]);
  const dayStartHour = 5;
  const baseDate = new Date(2026, 1, 16);

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('Bench — "X days fresh" vs "(X-1) + day-0 phantom" (continue-from-here)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  Days tested:      X ∈ { ${DAYS.join(', ')} }`);
  console.log(`  Runs per cell:    ${NUM_RUNS}`);
  console.log(`  Attempts/run:     ${ATTEMPTS}`);
  console.log(`  SA cap:           ${MAX_TIME_MS}ms per attempt`);
  console.log(`  Day-0 attempts:   ${DAY0_ATTEMPTS} (one-time setup per X)`);
  console.log(`  Fixture:          48 production participants, 4 groups`);
  console.log('───────────────────────────────────────────────────────────────────────────');

  interface CellResult {
    X: number;
    approach: 'A-fresh' | 'B-day0';
    runs: RunResult[];
    day0BuildMs?: number; // only set for B
    day0Assignments?: number; // only set for B
  }
  const cells: CellResult[] = [];

  // Build participants once per X (spanDays affects the availability range).
  const participantsByX = new Map<number, Participant[]>();
  for (const X of DAYS) {
    participantsByX.set(X, buildProduction48(baseDate, X));
  }

  // Build day-0 baseline once per X. We use the X-day participants (they have
  // the right spanDays so prior-day availability is in range).
  const day0ByX = new Map<number, { snapshot: ContinuitySnapshot; durationMs: number; assignmentCount: number }>();
  console.log('\nBuilding day-0 baselines (best of N attempts on a fresh 1-day schedule)...');
  for (const X of DAYS) {
    const participants = participantsByX.get(X)!;
    process.stdout.write(`  X=${X}: building day-0 (${DAY0_ATTEMPTS} attempts)... `);
    const r = buildPriorDaySnapshot(participants, baseDate, config, restRuleMap, dayStartHour, DAY0_ATTEMPTS);
    day0ByX.set(X, r);
    console.log(`${(r.durationMs / 1000).toFixed(2)}s, ${r.assignmentCount} assignments`);
  }
  console.log('───────────────────────────────────────────────────────────────────────────');

  // Run the main matrix.
  for (const X of DAYS) {
    const participants = participantsByX.get(X)!;
    const day0 = day0ByX.get(X)!;

    console.log(`\n[X=${X}] === Approach A: optimize ${X} days fresh ===`);
    process.stdout.write(`  ${NUM_RUNS} runs... `);
    const t0 = Date.now();
    const aRuns: RunResult[] = [];
    for (let r = 0; r < NUM_RUNS; r++) {
      aRuns.push(runFresh(X, baseDate, participants, config, restRuleMap, ATTEMPTS, dayStartHour));
      process.stdout.write('.');
    }
    console.log(` done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    cells.push({ X, approach: 'A-fresh', runs: aRuns });

    console.log(`[X=${X}] === Approach B: optimize ${X - 1} days + day-0 phantom ===`);
    process.stdout.write(`  ${NUM_RUNS} runs... `);
    const t1 = Date.now();
    const bRuns: RunResult[] = [];
    for (let r = 0; r < NUM_RUNS; r++) {
      bRuns.push(runWithDay0(X, baseDate, participants, config, restRuleMap, ATTEMPTS, dayStartHour, day0.snapshot));
      process.stdout.write('.');
    }
    console.log(` done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    cells.push({
      X,
      approach: 'B-day0',
      runs: bRuns,
      day0BuildMs: day0.durationMs,
      day0Assignments: day0.assignmentCount,
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
      `Problem size:   A = ${aTasks} tasks (${aSlots} slots, ${aDays}d)   B = ${bTasks} tasks (${bSlots} slots, ${bDays}d) + ${b.day0Assignments} phantom`,
    );
    console.log(`Day-0 setup:    ${(b.day0BuildMs! / 1000).toFixed(2)}s (one-time, amortizable)`);
    console.log('');

    // Runtime
    console.log(`  RUNTIME (optimizer-only, ms):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aDur), 0)} ± ${fmt(stddev(aDur), 0)}    median ${fmt(median(aDur), 0)}    min ${fmt(min(aDur), 0)}    max ${fmt(max(aDur), 0)}`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bDur), 0)} ± ${fmt(stddev(bDur), 0)}    median ${fmt(median(bDur), 0)}    min ${fmt(min(bDur), 0)}    max ${fmt(max(bDur), 0)}`,
    );
    const dPct = mean(aDur) === 0 ? 0 : ((mean(bDur) - mean(aDur)) / mean(aDur)) * 100;
    const dPv = welchT(bDur, aDur).p;
    console.log(
      `    Δ (B-A):   ${fmt(mean(bDur) - mean(aDur), 0)}ms (${dPct >= 0 ? '+' : ''}${fmt(dPct, 1)}%)   p=${fmt(dPv, 4)}${star(dPv)}`,
    );

    // Total wall-clock including day-0 build (charged once even though the user
    // typically already has it).
    const aTotalMean = mean(aDur);
    const bTotalMean = mean(bDur) + b.day0BuildMs!;
    const dTotalPct = aTotalMean === 0 ? 0 : ((bTotalMean - aTotalMean) / aTotalMean) * 100;
    console.log(`  TOTAL WALL-CLOCK (one-time-incl-day0-setup, ms):`);
    console.log(
      `    A-fresh:   ${fmt(aTotalMean, 0)}    B-day0+setup: ${fmt(bTotalMean, 0)}    Δ ${dTotalPct >= 0 ? '+' : ''}${fmt(dTotalPct, 1)}%`,
    );

    // Score
    const aScoreP = aScore.map((s) => s / aDays);
    const bScoreP = bScore.map((s) => s / bDays);
    console.log('');
    console.log(`  COMPOSITE SCORE (raw, NOT directly comparable — different denominators):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aScore), 2)} ± ${fmt(stddev(aScore), 2)}    median ${fmt(median(aScore), 2)}`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bScore), 2)} ± ${fmt(stddev(bScore), 2)}    median ${fmt(median(bScore), 2)}`,
    );
    console.log(`  SCORE / SCORED-DAY (normalised — comparable):`);
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

    // Unfilled
    const aUnfPct = aUnf.map((u, i) => (u / a.runs[i].totalSlots) * 100);
    const bUnfPct = bUnf.map((u, i) => (u / b.runs[i].totalSlots) * 100);
    console.log('');
    console.log(`  UNFILLED SLOTS (raw count):`);
    console.log(
      `    A-fresh:   mean ${fmt(mean(aUnf), 1)} ± ${fmt(stddev(aUnf), 1)}    median ${fmt(median(aUnf), 1)}    range [${min(aUnf)}, ${max(aUnf)}]`,
    );
    console.log(
      `    B-day0:    mean ${fmt(mean(bUnf), 1)} ± ${fmt(stddev(bUnf), 1)}    median ${fmt(median(bUnf), 1)}    range [${min(bUnf)}, ${max(bUnf)}]`,
    );
    console.log(`  UNFILLED RATE (% of slots):`);
    console.log(`    A-fresh:   mean ${fmt(mean(aUnfPct), 2)}%`);
    console.log(`    B-day0:    mean ${fmt(mean(bUnfPct), 2)}%`);

    // Feasibility
    const aFeas = a.runs.filter((r) => r.feasible).length;
    const bFeas = b.runs.filter((r) => r.feasible).length;
    console.log(`  FEASIBLE RUNS:   A: ${aFeas}/${a.runs.length}   B: ${bFeas}/${b.runs.length}`);
  }

  // ─── Cross-X compact matrix ───────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY MATRIX (lower-is-better for runtime/unfilled, higher-is-better for score)');
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

  // ─── Per-run raw (sanity) ─────────────────────────────────────────────────

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
