/**
 * Bench — deep evaluation of SA temperature change for diversity benchmarking.
 *
 * Tests the temperature dial across schedule sizes (1d, 2d, 3d, 7d), with
 * and without prior-day continuity (phantom context for cross-boundary HC-12
 * / HC-14 / HC-15). Larger N (default 20 runs) for tight confidence intervals.
 *
 * Variants tested:
 *   baseline       — current SA_INITIAL_TEMPERATURE = 55
 *   T=2, T=5, T=15 — fixed lower temperatures
 *   adaptive       — scale T to problem size (formula in code)
 *
 * Run with:
 *   npx ts-node src/bench-diversity.ts
 *
 * Tunable via env vars:
 *   BENCH_RUNS         number of independent runs per (scenario × variant) (default 20)
 *   BENCH_ATTEMPTS     attempts per run (default 30)
 *   BENCH_SCENARIOS    csv of scenario keys (default: all)
 *   BENCH_VARIANTS     csv of variant keys (default: all)
 *   BENCH_MAX_TIME_MS  per-attempt SA cap (default 8000)
 */

import {
  type BenchHookConfig,
  type OptimizationResult,
  optimizeMultiAttempt,
  setBenchHooks,
} from './engine/optimizer';
import { buildPhantomContext, mergePhantomRules, type PhantomContext } from './engine/phantom';
import {
  type ContinuityAssignment,
  type ContinuityParticipant,
  type ContinuitySnapshot,
} from './models/continuity-schema';
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
      'איתי לוין', 'נועה אברהמי', 'יונתן רפאלי', 'מאיה ישראלי',
      'עידו כהן', 'עדי מזרחי', 'רועי שפירא', 'מיכל אשכנזי',
      'עומר דרוקר', 'ענבר חזן', 'אורי גבאי', 'טל בן-דור',
    ],
    'קבוצה 2': [
      'דניאל וייס', 'שירה אדרי', 'נדב הראל', 'ליאור פלד',
      'אסף גרינברג', 'רוני סגל', 'גיא מור', 'יעל שלום',
      'אלון ברק', 'הילה חדד', 'מתן אלוני', 'שחר עמר',
    ],
    'קבוצה 3': [
      'איתן דהן', 'עמית מלכה', 'דורון פרידמן', 'נטע לביא',
      'יובל קליין', 'קרן אורן', 'אריאל נחום', 'דנה צור',
      'אביב סוויסה', 'גלית שדה', 'תומר גולן', 'ספיר מלמד',
    ],
    'קבוצה 4': [
      'אופיר ביטון', 'נועם פרץ', 'אייל רוזנפלד', 'ליהי כץ',
      'בועז נאמן', 'תמר יוספי', 'יואב פולק', 'סיון ריבלין',
      'אוהד שטרן', 'רותם גנות', 'ברק אוריון', 'נעמה שקד',
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
  // dateUnavailability — use only for spans that include the relevant dayIndex.
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
      part.dateUnavailability = dateRules
        ? dateRules.map((r, k) => ({ id: `du-${id}-${k}`, ...r }))
        : [];
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

// ─── Continuity / prior-day baseline construction ──────────────────────────

/**
 * Generate a one-day prior schedule for the same participants, then convert
 * its assignments into a ContinuitySnapshot the same way the web UI does.
 * The prior day is one calendar day before `baseDate` (operational day starts
 * at dayStartHour).
 */
function buildPriorDaySnapshot(
  participants: Participant[],
  baseDate: Date,
  config: SchedulerConfig,
  restRuleMap: Map<string, number>,
  dayStartHour: number,
): ContinuitySnapshot {
  const priorDate = new Date(baseDate.getTime() - 24 * 3600000);
  const priorTasks = generateWeeklyTasks(priorDate, 1);

  setBenchHooks(null);
  const result: OptimizationResult = optimizeMultiAttempt(
    priorTasks,
    participants,
    config,
    [],
    20, // attempts (single one-time setup)
    undefined,
    undefined,
    undefined,
    restRuleMap,
    undefined,
    undefined,
    dayStartHour,
  );

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
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex: 1,
    dayWindow: {
      start: priorDate.toISOString(),
      end: baseDate.toISOString(),
    },
    participants: snapParticipants,
  };
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

interface Scenario {
  key: string;
  name: string;
  participants: Participant[];
  tasks: Task[];
  withContinuity: boolean;
  continuitySnapshot?: ContinuitySnapshot;
  description: string;
}

function buildScenario(
  kind: string,
  withContinuity: boolean,
  baseConfig: SchedulerConfig,
  restRuleMap: Map<string, number>,
  dayStartHour: number,
): Scenario {
  const baseDate = new Date(2026, 1, 16);
  const m = /^prod-(\d+)d$/.exec(kind);
  if (!m) throw new Error(`Unknown scenario: ${kind}`);
  const days = parseInt(m[1], 10);
  const participants = buildProduction48(baseDate, days);
  const tasks = generateWeeklyTasks(baseDate, days);
  const sc: Scenario = {
    key: `${kind}${withContinuity ? '+cont' : ''}`,
    name: `prod-48p × ${days}d${withContinuity ? ' +continuity' : ''}`,
    participants,
    tasks,
    withContinuity,
    description: `48 production participants, ${days}-day schedule${withContinuity ? ', with prior-day baseline' : ''}`,
  };
  if (withContinuity) {
    sc.continuitySnapshot = buildPriorDaySnapshot(participants, baseDate, baseConfig, restRuleMap, dayStartHour);
  }
  return sc;
}

// ─── Variants ───────────────────────────────────────────────────────────────

type VariantHook = BenchHookConfig | null;

const VARIANTS: Record<string, VariantHook> = {
  baseline: null,
  'T=15': { perAttempt: (i) => (i === 0 ? {} : { saInitialTemp: 15 }) },
  'T=5': { perAttempt: (i) => (i === 0 ? {} : { saInitialTemp: 5 }) },
  'T=2': { perAttempt: (i) => (i === 0 ? {} : { saInitialTemp: 2 }) },
  // Adaptive: scale T to problem size (tasks × participants signal).
  // Fits the empirical curve: small problems benefit from T=55, big ones from T~5.
  // Formula chosen to land at:
  //   20 tasks (1d):   T ≈ 55
  //   40 tasks (2d):   T ≈ 35
  //   60 tasks (3d):   T ≈ 22
  //   140 tasks (7d):  T ≈ 5
  adaptive: {
    perAttempt: (i, _n, totalTasks) => {
      if (i === 0) return {};
      const T = Math.max(5, Math.min(55, 55 - (totalTasks - 20) * 0.43));
      return { saInitialTemp: T };
    },
  },
};

// ─── Stats helpers ──────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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
function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}
function pct(n: number, d: number): string {
  return d === 0 ? '0.00%' : `${((n / d) * 100).toFixed(2)}%`;
}

function welchT(a: number[], b: number[]): { t: number; p: number } {
  const ma = mean(a), mb = mean(b);
  const va = stddev(a) ** 2, vb = stddev(b) ** 2;
  const na = a.length, nb = b.length;
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
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
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

// ─── Single-variant runner ──────────────────────────────────────────────────

interface RunResult {
  bestScore: number;
  bestUnfilled: number;
  bestAttemptIdx: number;
  attemptScores: number[];
  durationMs: number;
}

function runVariant(
  hook: VariantHook,
  scenario: Scenario,
  config: SchedulerConfig,
  baseRestRuleMap: Map<string, number>,
  attempts: number,
  dayStartHour: number,
): RunResult {
  setBenchHooks(hook);
  const attemptScores: number[] = [];
  let bestAttemptIdx = 1;

  let phantomCtx: PhantomContext | undefined;
  let restRuleMap: Map<string, number> = baseRestRuleMap;
  if (scenario.continuitySnapshot) {
    phantomCtx = buildPhantomContext(scenario.continuitySnapshot, scenario.participants);
    restRuleMap = mergePhantomRules(baseRestRuleMap, phantomCtx);
  }

  const start = Date.now();
  const result: OptimizationResult = optimizeMultiAttempt(
    scenario.tasks,
    scenario.participants,
    config,
    [],
    attempts,
    (info) => {
      attemptScores.push(info.attemptScore);
      if (info.improved) bestAttemptIdx = info.attempt;
    },
    undefined,
    phantomCtx,
    restRuleMap,
    undefined,
    undefined,
    dayStartHour,
  );
  const durationMs = Date.now() - start;
  setBenchHooks(null);

  return {
    bestScore: result.score.compositeScore,
    bestUnfilled: result.unfilledSlots.length,
    bestAttemptIdx,
    attemptScores,
    durationMs,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const NUM_RUNS = parseInt(process.env.BENCH_RUNS ?? '20', 10);
  const ATTEMPTS = parseInt(process.env.BENCH_ATTEMPTS ?? '30', 10);
  const MAX_TIME_MS = parseInt(process.env.BENCH_MAX_TIME_MS ?? '8000', 10);
  const SCENARIO_FILTER = process.env.BENCH_SCENARIOS;
  const VARIANT_FILTER = process.env.BENCH_VARIANTS;

  const ALL_SCENARIO_KEYS = ['prod-1d', 'prod-2d', 'prod-3d', 'prod-7d'];
  const scenarioKeys = SCENARIO_FILTER ? SCENARIO_FILTER.split(',') : ALL_SCENARIO_KEYS;
  const variantKeys = VARIANT_FILTER ? VARIANT_FILTER.split(',') : Object.keys(VARIANTS);

  const config: SchedulerConfig = { ...DEFAULT_CONFIG, maxSolverTimeMs: MAX_TIME_MS };
  const restRuleMap = new Map<string, number>([['demo-rest-rule', 5 * 3600000]]);
  const dayStartHour = 5;

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('Deep Diversity Benchmark — temperature variants × scenario sizes × continuity');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  Runs/variant:  ${NUM_RUNS}`);
  console.log(`  Attempts/run:  ${ATTEMPTS}`);
  console.log(`  SA cap:        ${MAX_TIME_MS}ms per attempt`);
  console.log(`  Rest rule:     demo-rest-rule = 5h`);
  console.log(`  Variants:      ${variantKeys.join(', ')}`);
  console.log(`  Scenarios:     ${scenarioKeys.join(', ')} × {no-continuity, +continuity}`);
  console.log('───────────────────────────────────────────────────────────────────────────');

  type ScenarioKey = string; // e.g. "prod-3d+cont"
  const allResults: Record<ScenarioKey, Record<string, RunResult[]>> = {};
  const scenarioMeta: Record<ScenarioKey, Scenario> = {};

  // Pre-build all scenarios (continuity setup is one-time per scenario).
  console.log('\nBuilding scenarios...');
  for (const sKey of scenarioKeys) {
    for (const wc of [false, true]) {
      const sc = buildScenario(sKey, wc, config, restRuleMap, dayStartHour);
      scenarioMeta[sc.key] = sc;
      allResults[sc.key] = {};
      console.log(
        `  [${sc.key.padEnd(15)}] ${sc.tasks.length} tasks, ${sc.participants.length} participants` +
          (sc.continuitySnapshot
            ? `, prior-day phantoms: ${sc.continuitySnapshot.participants.reduce((s, p) => s + p.assignments.length, 0)}`
            : ''),
      );
    }
  }
  console.log('───────────────────────────────────────────────────────────────────────────');

  // Run all variants × scenarios.
  for (const sKey of Object.keys(scenarioMeta)) {
    const sc = scenarioMeta[sKey];
    console.log(`\n[${sc.key}] ${sc.description}`);
    for (const vname of variantKeys) {
      if (!(vname in VARIANTS)) {
        console.log(`  [skip unknown: ${vname}]`);
        continue;
      }
      process.stdout.write(`  ${vname.padEnd(10)} ${NUM_RUNS} runs... `);
      const t0 = Date.now();
      const results: RunResult[] = [];
      for (let r = 0; r < NUM_RUNS; r++) {
        results.push(runVariant(VARIANTS[vname], sc, config, restRuleMap, ATTEMPTS, dayStartHour));
        process.stdout.write('.');
      }
      const elapsed = Date.now() - t0;
      console.log(` done in ${(elapsed / 1000).toFixed(1)}s`);
      allResults[sc.key][vname] = results;
    }
  }

  // ─── Summary tables ───────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY — best composite score (mean ± std), Δ vs baseline, Welch-t p-value');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  for (const sKey of Object.keys(scenarioMeta)) {
    const sc = scenarioMeta[sKey];
    const variants = allResults[sc.key];
    const baselineScores = variants.baseline?.map((r) => r.bestScore);
    if (!baselineScores) continue;

    console.log(`\n[${sc.key}] ${sc.description}`);
    console.log(
      `${'variant'.padEnd(10)} | ${'mean ± std'.padStart(20)} | ${'median'.padStart(10)} | ${'Δ vs base'.padStart(11)} | ${'Δ %'.padStart(8)} | ${'p-value'.padStart(8)} | ${'unfilled'.padStart(8)} | ${'best@idx'.padStart(8)}`,
    );
    console.log('─'.repeat(110));
    const baseMean = mean(baselineScores);
    for (const vname of variantKeys) {
      const results = variants[vname];
      if (!results || results.length === 0) continue;
      const scores = results.map((r) => r.bestScore);
      const m = mean(scores);
      const sd = stddev(scores);
      const md = median(scores);
      const delta = m - baseMean;
      const deltaPct = baseMean !== 0 ? (delta / Math.abs(baseMean)) * 100 : 0;
      const pv = vname === 'baseline' ? NaN : welchT(scores, baselineScores).p;
      const meanUnfilled = mean(results.map((r) => r.bestUnfilled));
      const meanIdx = mean(results.map((r) => r.bestAttemptIdx));
      const sig = Number.isNaN(pv) ? '   ' : star(pv);
      const meanStd = `${fmt(m, 2)} ± ${fmt(sd, 2)}`;
      console.log(
        `${vname.padEnd(10)} | ${meanStd.padStart(20)} | ${fmt(md, 2).padStart(10)} | ${fmt(delta, 2).padStart(11)} | ${`${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`.padStart(8)} | ${(Number.isNaN(pv) ? '—' : fmt(pv, 4)).padStart(8)}${sig} | ${fmt(meanUnfilled, 1).padStart(8)} | ${fmt(meanIdx, 1).padStart(8)}`,
      );
    }
  }

  // Compact cross-scenario matrix (variant rows × scenario cols, Δ% only)
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('CROSS-SCENARIO MATRIX — Δ% vs baseline (significance: . p<0.1, * p<0.05, ** p<0.01, *** p<0.001)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  const sortedScenarios = Object.keys(scenarioMeta);
  const header = ['variant'.padEnd(10), ...sortedScenarios.map((k) => k.padStart(15))].join(' | ');
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const vname of variantKeys) {
    if (vname === 'baseline') continue;
    const cells: string[] = [vname.padEnd(10)];
    for (const sKey of sortedScenarios) {
      const variants = allResults[sKey];
      const base = variants.baseline?.map((r) => r.bestScore);
      const here = variants[vname]?.map((r) => r.bestScore);
      if (!base || !here || here.length === 0) {
        cells.push('—'.padStart(15));
        continue;
      }
      const baseMean = mean(base);
      const m = mean(here);
      const dpct = baseMean !== 0 ? ((m - baseMean) / Math.abs(baseMean)) * 100 : 0;
      const pv = welchT(here, base).p;
      const cell = `${dpct >= 0 ? '+' : ''}${dpct.toFixed(2)}%${star(pv)}`;
      cells.push(cell.padStart(15));
    }
    console.log(cells.join(' | '));
  }

  // ─── Per-run raw scores (for sanity) ──────────────────────────────────────
  console.log('\n─── Raw per-run scores ────────────────────────────────────────────────────');
  for (const sKey of Object.keys(scenarioMeta)) {
    console.log(`[${sKey}]`);
    const variants = allResults[sKey];
    for (const vname of variantKeys) {
      const results = variants[vname];
      if (!results) continue;
      const scores = results.map((r) => r.bestScore.toFixed(2)).join(', ');
      console.log(`  ${vname.padEnd(10)}: ${scores}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════════════════════════');
}

main();
