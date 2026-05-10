/**
 * Full-flow bench — exercises SchedulingEngine.generateScheduleAsync() end-to-end,
 * not just optimizer. Times each phase so we can see where time accumulates
 * outside the optimizer hot loop.
 *
 * Phases timed:
 *   - Engine.addParticipants / addTasks (setup)
 *   - generateScheduleAsync (optimize + _commitOptimizationResult)
 *   - validateHardConstraints (called inside _commitOptimizationResult)
 *   - structuredClone of participants (called inside _commitOptimizationResult)
 *   - JSON.stringify of the full Schedule (proxy for localStorage save cost)
 *
 * The two phases of greatest suspicion across the 4-day window:
 *   - HC-15 sleep-recovery (added 3.0.9) → makes validateHardConstraints heavier
 *   - structuredClone for freeze (added/expanded 3.1.0+)
 *   - Schedule.continuitySnapshot embed (added 3.1.1) → bloats the Schedule
 */

// Seed Math.random for reproducibility BEFORE importing the engine.
{
  let s = parseInt(process.env.BENCH_SEED ?? 'C0FFEE', 16);
  Math.random = () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import { SchedulingEngine } from './src/engine/scheduler';
import { validateHardConstraints } from './src/constraints/hard-constraints';
import { Level, type Participant, type Task } from './src/models/types';
import { generateWeeklyTasks } from './src/tasks/cli-task-factory';

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
    'קבוצה 1': ['איתי לוין','נועה אברהמי','יונתן רפאלי','מאיה ישראלי','עידו כהן','עדי מזרחי','רועי שפירא','מיכל אשכנזי','עומר דרוקר','ענבר חזן','אורי גבאי','טל בן-דור'],
    'קבוצה 2': ['דניאל וייס','שירה אדרי','נדב הראל','ליאור פלד','אסף גרינברג','רוני סגל','גיא מור','יעל שלום','אלון ברק','הילה חדד','מתן אלוני','שחר עמר'],
    'קבוצה 3': ['איתן דהן','עמית מלכה','דורון פרידמן','נטע לביא','יובל קליין','קרן אורן','אריאל נחום','דנה צור','אביב סוויסה','גלית שדה','תומר גולן','ספיר מלמד'],
    'קבוצה 4': ['אופיר ביטון','נועם פרץ','אייל רוזנפלד','ליהי כץ','בועז נאמן','תמר יוספי','יואב פולק','סיון ריבלין','אוהד שטרן','רותם גנות','ברק אוריון','נעמה שקד'],
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
  const out: Participant[] = [];
  let pid = 0;
  for (const g of ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4']) {
    const names = NAMES_BY_GROUP[g];
    const horesh = HORESH_INDICES[g] ?? new Set<number>();
    for (let i = 0; i < 12; i++) {
      const spec = TEMPLATE[i];
      const certs = [...spec.certs];
      if (horesh.has(i)) certs.push('Horesh');
      out.push(p(`p${++pid}`, names[i], spec.level, certs, g, baseDate, spanDays));
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function main(): Promise<void> {
  const DAYS = parseInt(process.env.BENCH_DAYS ?? '5', 10);
  const ATTEMPTS = parseInt(process.env.BENCH_ATTEMPTS ?? '20', 10);
  const RUNS = parseInt(process.env.BENCH_RUNS ?? '3', 10);
  const MAX_TIME_MS = parseInt(process.env.BENCH_MAX_TIME_MS ?? '30000', 10);

  const baseDate = new Date(2026, 1, 16);
  const participants = buildProduction48(baseDate, DAYS);
  const tasks: Task[] = generateWeeklyTasks(baseDate, DAYS);

  // Enrich fixture with realistic things the user's templates likely have:
  // sleepRecovery rules on every other task (HC-15, added 3.0.9), and notWith
  // pairs (drives the IncrementalScorer notWith hot path 3.1.2 added phantom
  // checks to). Without these enrichments the CLI factory tasks bypass these
  // hot paths entirely.
  if (process.env.BENCH_ENRICH !== 'off') {
    const ENRICH_FRACTION = 0.5;
    let enriched = 0;
    for (const t of tasks) {
      if (enriched / tasks.length >= ENRICH_FRACTION) break;
      // Apply sleepRecovery rule to every other task — trigger shift index 1
      // (most tasks have shiftsPerDay=2, so half their instances trigger).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t as any).sleepRecovery = { triggerShifts: [1], recoveryHours: 5 };
      enriched++;
    }
    // Add notWith pairs — using participant names from buildProduction48.
    const notWithPairs: Array<[number, number]> = [
      [0, 11], [1, 22], [2, 33], [3, 44], [4, 15], [5, 26], [6, 37], [7, 18],
      [8, 29], [9, 40], [10, 21], [12, 23], [13, 34], [14, 45], [16, 27], [17, 38],
    ];
    for (const [i, j] of notWithPairs) {
      if (i < participants.length && j < participants.length) {
        participants[i].notWithIds = [...(participants[i].notWithIds ?? []), participants[j].id];
        participants[j].notWithIds = [...(participants[j].notWithIds ?? []), participants[i].id];
      }
    }
    console.log(`[FULL-BENCH] enriched: ${enriched} tasks have sleepRecovery, ${notWithPairs.length} notWith pairs`);
  }

  const restRuleMap = new Map<string, number>([['demo-rest-rule', 5 * 3600000]]);

  console.log(`[FULL-BENCH] DAYS=${DAYS}  ATTEMPTS=${ATTEMPTS}  RUNS=${RUNS}  MAX_TIME=${MAX_TIME_MS}`);
  console.log(`[FULL-BENCH] tasks=${tasks.length}  participants=${participants.length}`);

  // ── Warmup ──
  {
    const eng = new SchedulingEngine({ maxSolverTimeMs: MAX_TIME_MS }, undefined, restRuleMap, 5);
    eng.addTasks(tasks);
    eng.addParticipants(participants);
    await eng.generateScheduleAsync(2);
    console.log('[FULL-BENCH] warmup done');
  }

  const setupTimes: number[] = [];
  const generateTimes: number[] = [];
  const validateTimes: number[] = [];
  const cloneTimes: number[] = [];
  const stringifyTimes: number[] = [];
  const totalTimes: number[] = [];

  for (let r = 0; r < RUNS; r++) {
    // Setup
    const tSetup0 = Date.now();
    const eng = new SchedulingEngine({ maxSolverTimeMs: MAX_TIME_MS }, undefined, restRuleMap, 5);
    eng.addTasks(tasks);
    eng.addParticipants(participants);
    setupTimes.push(Date.now() - tSetup0);

    // Generate (optimizer + _commitOptimizationResult)
    const tGen0 = Date.now();
    const schedule = await eng.generateScheduleAsync(ATTEMPTS);
    const genMs = Date.now() - tGen0;
    generateTimes.push(genMs);

    // Standalone validate (mirrors what _commitOptimizationResult does)
    const tVal0 = Date.now();
    validateHardConstraints(
      tasks,
      participants,
      schedule.assignments,
      undefined, // disabledHC
      restRuleMap,
      undefined, // certLabelResolver
      undefined,
      undefined, // ScheduleContext
    );
    validateTimes.push(Date.now() - tVal0);

    // Standalone deep-clone of all participants
    const tClone0 = Date.now();
    const cloned = participants.map((p) => structuredClone(p));
    cloneTimes.push(Date.now() - tClone0);
    void cloned;

    // Standalone JSON.stringify of the full schedule (proxy for localStorage write)
    const tStr0 = Date.now();
    const json = JSON.stringify(schedule);
    stringifyTimes.push(Date.now() - tStr0);

    totalTimes.push(genMs + (Date.now() - tStr0));

    console.log(
      `[FULL-BENCH] run ${r + 1}/${RUNS}: ` +
      `setup=${setupTimes[r]}ms  ` +
      `generate=${generateTimes[r]}ms  ` +
      `validate=${validateTimes[r]}ms  ` +
      `clone48=${cloneTimes[r]}ms  ` +
      `stringify=${stringifyTimes[r]}ms (${(json.length / 1024).toFixed(0)}KB)  ` +
      `score=${schedule.score.compositeScore.toFixed(2)}  ` +
      `violations=${schedule.violations.length}`,
    );
  }

  console.log('');
  console.log(`[SUMMARY] medians:`);
  console.log(`  setup:           ${median(setupTimes)}ms`);
  console.log(`  generate (full): ${median(generateTimes)}ms`);
  console.log(`  validate alone:  ${median(validateTimes)}ms  (runs INSIDE generate)`);
  console.log(`  clone48 alone:   ${median(cloneTimes)}ms  (runs INSIDE generate)`);
  console.log(`  stringify alone: ${median(stringifyTimes)}ms  (runs OUTSIDE engine, on save)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
