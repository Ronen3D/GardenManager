/**
 * Cross-commit perf regression bench.
 *
 * Stable harness for bisecting wall-clock regressions in the optimizer across
 * recent commits. Uses ONLY signatures verified stable from v2.9.9 → HEAD:
 *   - `optimizeMultiAttempt(tasks, participants, config, [], attempts, ...)`
 *   - `generateWeeklyTasks(startDate, numDays)`
 *   - `Level`, `DEFAULT_CONFIG`, `Participant`, `SchedulerConfig`
 *
 * Bench design:
 *   - Iter-bounded SA (set `maxIterations` low, set `maxSolverTimeMs` high)
 *     so SA exits on iteration count, not the time cap. This makes wall-clock
 *     a measurement of **work per iteration**, not the cap.
 *   - Fixed 48-participant production fixture (lifted from bench-day0-vs-fresh.ts).
 *   - Fixed task scenario: `generateWeeklyTasks(2026-02-16, BENCH_DAYS)`.
 *   - Reports median, mean, min, max over BENCH_RUNS independent runs.
 *
 * ENV (defaults tuned for ~30-90s per commit):
 *   BENCH_DAYS=5            # task days
 *   BENCH_ATTEMPTS=2        # multi-attempt count
 *   BENCH_RUNS=4            # independent runs (median taken)
 *   BENCH_MAX_ITERS=2000    # SA iteration cap (keep below true convergence)
 *   BENCH_MAX_TIME_MS=60000 # SA time cap (kept high so iters dominate)
 *
 * Output: a single CSV-ish line per run plus a summary, easy to grep.
 */

// Seed Math.random for reproducibility BEFORE importing the engine.
// SA uses Math.random in shuffle, swap-proposal selection, and tiebreakers; an
// unseeded sequence produces wildly bimodal runtime (some sequences hit many
// accepted swaps → state-mutation cost, others reject most → cheap loop).
// Mulberry32: small, fast, deterministic.
{
  let s = parseInt(process.env.BENCH_SEED ?? '0xC0FFEE', 16);
  Math.random = () => {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import { optimizeMultiAttempt } from './src/engine/optimizer';
// setBenchHooks may not exist in older commits; load it dynamically.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _opt = require('./src/engine/optimizer') as { setBenchHooks?: (h: unknown) => void };
const setBenchHooks: ((h: unknown) => void) | undefined = _opt.setBenchHooks;
import { DEFAULT_CONFIG, Level, type Participant, type SchedulerConfig } from './src/models/types';
import { generateWeeklyTasks } from './src/tasks/cli-task-factory';

// ─── Production-default 48-participant fixture (lifted verbatim) ──────────
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
  const groups = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];
  for (const g of groups) {
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

// ─── Stats ────────────────────────────────────────────────────────────────
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────
function main(): void {
  const DAYS = parseInt(process.env.BENCH_DAYS ?? '5', 10);
  const ATTEMPTS = parseInt(process.env.BENCH_ATTEMPTS ?? '2', 10);
  const RUNS = parseInt(process.env.BENCH_RUNS ?? '4', 10);
  const MAX_ITERS = parseInt(process.env.BENCH_MAX_ITERS ?? '2000', 10);
  const MAX_TIME_MS = parseInt(process.env.BENCH_MAX_TIME_MS ?? '60000', 10);
  const FORCE_T = process.env.BENCH_FORCE_T ? parseFloat(process.env.BENCH_FORCE_T) : null;

  if (FORCE_T !== null) {
    if (!setBenchHooks) {
      console.error('[BENCH] BENCH_FORCE_T set but setBenchHooks not available in this commit. Aborting.');
      process.exit(1);
    }
    const sbh = setBenchHooks;
    sbh({
      perAttempt: () => ({ saInitialTemp: FORCE_T }),
    });
    console.log(`[BENCH] FORCED SA initial temperature: ${FORCE_T}`);
  }

  const baseDate = new Date(2026, 1, 16);
  const participants = buildProduction48(baseDate, DAYS);
  const tasks = generateWeeklyTasks(baseDate, DAYS);

  const config: SchedulerConfig = {
    ...DEFAULT_CONFIG,
    maxIterations: MAX_ITERS,
    maxSolverTimeMs: MAX_TIME_MS,
  };
  const restRuleMap = new Map<string, number>([['demo-rest-rule', 5 * 3600000]]);
  const dayStartHour = 5;

  console.log(`[BENCH] DAYS=${DAYS}  ATTEMPTS=${ATTEMPTS}  RUNS=${RUNS}  MAX_ITERS=${MAX_ITERS}  MAX_TIME_MS=${MAX_TIME_MS}`);
  console.log(`[BENCH] tasks=${tasks.length}  participants=${participants.length}`);

  // Warm-up — first run includes JIT, file load, etc. Discard.
  process.stdout.write('[BENCH] warmup... ');
  const wt0 = Date.now();
  optimizeMultiAttempt(
    tasks, participants, config, [], 1,
    undefined, undefined, undefined, restRuleMap, undefined, undefined, dayStartHour,
  );
  console.log(`${Date.now() - wt0}ms`);

  const times: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const t0 = Date.now();
    const result = optimizeMultiAttempt(
      tasks, participants, config, [], ATTEMPTS,
      undefined, undefined, undefined, restRuleMap, undefined, undefined, dayStartHour,
    );
    const dt = Date.now() - t0;
    times.push(dt);
    // phaseDurations exists from 3.1.0 onward; earlier commits won't have it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pd = (result as any).phaseDurations as { greedyMs: number; saMs: number; polishMs: number } | undefined;
    const phaseStr = pd ? `  greedy=${pd.greedyMs}  sa=${pd.saMs}  polish=${pd.polishMs}` : '';
    console.log(`[BENCH] run ${r + 1}/${RUNS}: ${dt}ms  score=${result.score.compositeScore.toFixed(2)}  unfilled=${result.unfilledSlots.length}${phaseStr}`);
  }

  const med = median(times);
  const avg = mean(times);
  const mn = Math.min(...times);
  const mx = Math.max(...times);
  console.log(`[BENCH-SUMMARY] median=${med.toFixed(0)}ms  mean=${avg.toFixed(0)}ms  min=${mn}ms  max=${mx}ms  n=${RUNS}`);
}

main();
