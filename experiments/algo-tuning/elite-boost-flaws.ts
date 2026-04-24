/**
 * Elite-boost flaw validation harness.
 *
 * Tests three hypotheses derived from code reading of optimizer.ts:
 *
 *   F1 (sticky-after-feasible): once `eliteBoost` is computed at a refresh,
 *      it is never cleared even after `best` becomes feasible. Sticky boost
 *      may degrade fairness/penalty quality on attempts after feasibility.
 *
 *   F3 (intensify-overlap): `saIntensifyTaskIds` is derived from the BEST
 *      attempt's remaining unfilled. SA in a different attempt sees its OWN
 *      greedy's `remainingUnfilled`. If overlap is small, the 80% bias is
 *      mostly a no-op.
 *
 *   META (does boost help at all): compare 4 modes at attempts where boost
 *      actually fires:
 *        - off:       boost disabled entirely
 *        - on:        current behavior (EI=200, sticky)
 *        - cleared:   boost cleared when best becomes feasible
 *        - selective: only boost tasks with ordering-fixable HC codes
 *                     (HC-12 / HC-14 / HC-5) — exclude pure HC-1/HC-2
 *
 * Run:
 *   npx ts-node --project experiments/algo-tuning/tsconfig.json \
 *     experiments/algo-tuning/elite-boost-flaws.ts [primary|secondary|all]
 */

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
import { generateShiftBlocks } from '../../src/shared/utils/time-utils';
import {
  classifyUnfilledSlots,
  buildSchedulingContext,
  computeStructuralPriority,
  optimize,
  type EliteBoostState,
  type OptimizationResult,
  type UnfilledSlot,
} from '../../src/engine/optimizer';

const configStore = require('../../src/web/config-store');
const {
  initStore,
  getAllParticipants,
  getAllTaskTemplates,
  getAllRestRules,
  getDayStartHour,
  setScheduleDays,
  getScheduleDate,
} = configStore as {
  initStore(): void;
  getAllParticipants(): Participant[];
  getAllTaskTemplates(): any[];
  getAllRestRules(): { id: string; durationHours: number }[];
  getDayStartHour(): number;
  setScheduleDays(n: number): void;
  getScheduleDate(): Date;
};

// ─── Task instantiation (copied from elite-interval-sweep.ts) ─────────────
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

      const shifts: { start: Date; end: Date }[] =
        tpl.shiftsPerDay === 1
          ? [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }]
          : generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);

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

function buildParticipantPoolByRemovingGroups(allParticipants: Participant[], groupsToRemove: number): Participant[] {
  const byGroup = new Map<string, Participant[]>();
  for (const p of allParticipants) {
    const g = p.group ?? '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(p);
  }
  const groupNames = [...byGroup.keys()];
  const keepGroups = new Set(groupNames.slice(0, Math.max(0, groupNames.length - groupsToRemove)));
  const result: Participant[] = [];
  for (const [groupName, list] of byGroup) {
    if (keepGroups.has(groupName)) result.push(...list);
  }
  return result;
}

function buildParticipantSubset(allParticipants: Participant[], perGroupCount: number): Participant[] {
  const byGroup = new Map<string, Participant[]>();
  for (const p of allParticipants) {
    const g = p.group ?? '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(p);
  }
  const result: Participant[] = [];
  for (const [groupName, list] of byGroup) {
    if (perGroupCount <= list.length) {
      result.push(...list.slice(0, perGroupCount));
    } else {
      result.push(...list);
      const l0s = list.filter((p) => p.level === 0);
      const need = perGroupCount - list.length;
      for (let i = 0; i < need; i++) {
        const src = l0s[i % l0s.length];
        result.push({
          ...src,
          id: `${src.id}-clone${i + 1}`,
          name: `${src.name} (שיבוט ${i + 1})`,
          availability: src.availability.map((a) => ({ ...a })),
          dateUnavailability: src.dateUnavailability.map((d) => ({ ...d })),
          pakalIds: [],
          certifications: [...src.certifications],
        });
      }
    }
  }
  return result;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function isBetterResult(c: OptimizationResult, cur: OptimizationResult): boolean {
  if (c.unfilledSlots.length < cur.unfilledSlots.length) return true;
  if (c.unfilledSlots.length > cur.unfilledSlots.length) return false;
  return c.score.compositeScore > cur.score.compositeScore;
}

// ─── Selective classification (F4 variant): only boost ordering-fixable tasks ─
// Excludes tasks whose hcCodes are exclusively HC-1 (level), HC-2 (cert), or
// HC-4 (sameGroup unfillable) — boost can't change those.
function classifySelective(unfilled: UnfilledSlot[]): EliteBoostState {
  const state: EliteBoostState = { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
  const ORDERING_FIXABLE = new Set(['HC-5', 'HC-7', 'HC-8', 'HC-11', 'HC-12', 'HC-14']);
  for (const uf of unfilled) {
    const codes = uf.hcCodes ?? [];
    const hasFixable = codes.some((c) => ORDERING_FIXABLE.has(c));
    if (hasFixable || codes.length === 0) state.boostTaskIds.add(uf.taskId);
    if (codes.includes('HC-12') || codes.includes('HC-14')) state.saIntensifyTaskIds.add(uf.taskId);
  }
  return state;
}

// ─── Modes ────────────────────────────────────────────────────────────────────
type BoostMode = 'off' | 'on' | 'cleared' | 'selective';

interface AttemptRecord {
  attempt: number;
  attemptScore: number;
  attemptUnfilled: number;
  bestScore: number;
  bestUnfilled: number;
  improved: boolean;
  refreshFired: boolean;
  boostSetSize: number;
  intensifySetSize: number;
  // F1 instrumentation: was best feasible AND eliteBoost still active?
  boostAppliedAfterFeasible: boolean;
  // F2 instrumentation: how many tier-0 (sameGroupRequired) tasks were boosted?
  tier0BoostedCount: number;
  // F3 instrumentation: of the intensify task IDs, how many appear in this attempt's unfilled?
  intensifyOverlapCount: number;
  intensifyMissCount: number;
}

interface RunResult {
  mode: BoostMode;
  bestScore: number;
  bestUnfilled: number;
  bestFeasible: boolean;
  attempts: number;
  totalMs: number;
  refreshCount: number;
  boostAppliedAfterFeasibleCount: number;
  tier0BoostedTotal: number;
  intensifyOverlapTotal: number;
  intensifyMissTotal: number;
  attemptsWithIntensifySet: number;
  log: AttemptRecord[];
}

function runMultiAttempt(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  attempts: number,
  mode: BoostMode,
  eliteInterval: number,
  restRuleMap: Map<string, number> | undefined,
  dayStartHour: number,
): RunResult {
  let best: OptimizationResult | null = null;
  const ctx = buildSchedulingContext(tasks, participants);
  let eliteBoost: EliteBoostState = { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
  const log: AttemptRecord[] = [];
  let refreshCount = 0;
  let boostAppliedAfterFeasibleCount = 0;
  let tier0BoostedTotal = 0;
  let intensifyOverlapTotal = 0;
  let intensifyMissTotal = 0;
  let attemptsWithIntensifySet = 0;

  // Sameness lookup for tier-0 detection
  const sameGroupTaskIds = new Set(tasks.filter((t) => t.sameGroupRequired).map((t) => t.id));

  const t0 = Date.now();

  for (let i = 0; i < attempts; i++) {
    let refreshFired = false;

    // Refresh logic: identical to production for 'on'/'cleared'/'selective';
    // never fires for 'off'.
    if (mode !== 'off' && best && i > 0 && i % eliteInterval === 0 && best.unfilledSlots.length > 0) {
      eliteBoost = mode === 'selective'
        ? classifySelective(best.unfilledSlots)
        : classifyUnfilledSlots(best.unfilledSlots);
      refreshFired = true;
      refreshCount++;
    }

    // F1 mitigation: if mode === 'cleared', drop boost when best is feasible.
    if (mode === 'cleared' && best && best.unfilledSlots.length === 0) {
      if (eliteBoost.boostTaskIds.size > 0 || eliteBoost.saIntensifyTaskIds.size > 0) {
        eliteBoost = { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
      }
    }

    const shuffledParticipants = i === 0 ? [...participants] : shuffle([...participants]);

    const willApplyBoost = eliteBoost.boostTaskIds.size > 0 && i > 0;

    // F1 instrumentation
    const boostAppliedAfterFeasible = willApplyBoost && best !== null && best.unfilledSlots.length === 0;
    if (boostAppliedAfterFeasible) boostAppliedAfterFeasibleCount++;

    // F2 instrumentation
    let tier0Boosted = 0;
    if (willApplyBoost) {
      for (const id of eliteBoost.boostTaskIds) {
        if (sameGroupTaskIds.has(id)) tier0Boosted++;
      }
      tier0BoostedTotal += tier0Boosted;
    }

    const attemptTasks = willApplyBoost
      ? tasks.map((t) =>
          eliteBoost.boostTaskIds.has(t.id)
            ? { ...t, schedulingPriority: Math.max(1, (t.schedulingPriority ?? computeStructuralPriority(t, ctx)) - 10) }
            : t,
        )
      : tasks;

    const jitter = i === 0 ? 0 : 0.3;
    const result = optimize(
      attemptTasks,
      shuffledParticipants,
      config,
      [],
      undefined,
      jitter,
      undefined,
      restRuleMap,
      dayStartHour,
      undefined,
      undefined,
      ctx,
      eliteBoost.saIntensifyTaskIds.size > 0 ? eliteBoost.saIntensifyTaskIds : undefined,
    );

    // F3 instrumentation: how many intensify task IDs appear in THIS attempt's
    // result.unfilledSlots? (Approximation — true overlap should be against
    // greedy.unfilledSlots before SA, but result.unfilledSlots is what SA
    // ultimately couldn't fill, which is the relevant target.)
    let intensifyOverlap = 0;
    let intensifyMiss = 0;
    if (eliteBoost.saIntensifyTaskIds.size > 0) {
      attemptsWithIntensifySet++;
      const attemptUnfilledTaskIds = new Set(result.unfilledSlots.map((u) => u.taskId));
      for (const id of eliteBoost.saIntensifyTaskIds) {
        if (attemptUnfilledTaskIds.has(id)) intensifyOverlap++;
        else intensifyMiss++;
      }
      intensifyOverlapTotal += intensifyOverlap;
      intensifyMissTotal += intensifyMiss;
    }

    const improved = best === null || isBetterResult(result, best);
    if (improved) best = result;

    log.push({
      attempt: i + 1,
      attemptScore: result.score.compositeScore,
      attemptUnfilled: result.unfilledSlots.length,
      bestScore: best!.score.compositeScore,
      bestUnfilled: best!.unfilledSlots.length,
      improved,
      refreshFired,
      boostSetSize: eliteBoost.boostTaskIds.size,
      intensifySetSize: eliteBoost.saIntensifyTaskIds.size,
      boostAppliedAfterFeasible,
      tier0BoostedCount: tier0Boosted,
      intensifyOverlapCount: intensifyOverlap,
      intensifyMissCount: intensifyMiss,
    });
  }

  return {
    mode,
    bestScore: best!.score.compositeScore,
    bestUnfilled: best!.unfilledSlots.length,
    bestFeasible: best!.feasible,
    attempts,
    totalMs: Date.now() - t0,
    refreshCount,
    boostAppliedAfterFeasibleCount,
    tier0BoostedTotal,
    intensifyOverlapTotal,
    intensifyMissTotal,
    attemptsWithIntensifySet,
    log,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
interface CellStats {
  scenario: string;
  mode: BoostMode;
  attempts: number;
  seeds: number;
  bestScores: number[];
  bestUnfilled: number[];
  bestMean: number;
  bestStdev: number;
  bestMedian: number;
  bestMin: number;
  bestMax: number;
  unfilledMean: number;
  unfilledMax: number;
  totalMsMean: number;
  refreshMean: number;
  // Flaw indicators
  boostAfterFeasibleAttemptsMean: number; // how many post-feasible attempts had boost active
  tier0BoostedAttemptsMean: number;       // how many attempts boosted a tier-0 task
  intensifyHitRateMean: number;           // overlap / (overlap + miss), avg across runs
  intensifyAttemptsMean: number;          // attempts where intensify set non-empty
}

function aggregate(scenario: string, mode: BoostMode, attempts: number, runs: RunResult[]): CellStats {
  const bestScores = runs.map((r) => r.bestScore);
  const sorted = [...bestScores].sort((a, b) => a - b);
  const mean = bestScores.reduce((s, x) => s + x, 0) / bestScores.length;
  const variance = bestScores.reduce((s, x) => s + (x - mean) ** 2, 0) / bestScores.length;
  const stdev = Math.sqrt(variance);

  const intensifyHitRates = runs.map((r) => {
    const total = r.intensifyOverlapTotal + r.intensifyMissTotal;
    return total > 0 ? r.intensifyOverlapTotal / total : 0;
  });

  return {
    scenario,
    mode,
    attempts,
    seeds: runs.length,
    bestScores,
    bestUnfilled: runs.map((r) => r.bestUnfilled),
    bestMean: mean,
    bestStdev: stdev,
    bestMedian: sorted[Math.floor(sorted.length / 2)],
    bestMin: sorted[0],
    bestMax: sorted[sorted.length - 1],
    unfilledMean: runs.reduce((s, r) => s + r.bestUnfilled, 0) / runs.length,
    unfilledMax: Math.max(...runs.map((r) => r.bestUnfilled)),
    totalMsMean: runs.reduce((s, r) => s + r.totalMs, 0) / runs.length,
    refreshMean: runs.reduce((s, r) => s + r.refreshCount, 0) / runs.length,
    boostAfterFeasibleAttemptsMean: runs.reduce((s, r) => s + r.boostAppliedAfterFeasibleCount, 0) / runs.length,
    tier0BoostedAttemptsMean: runs.reduce((s, r) => s + (r.tier0BoostedTotal > 0 ? 1 : 0), 0) / runs.length,
    intensifyHitRateMean: intensifyHitRates.reduce((s, x) => s + x, 0) / runs.length,
    intensifyAttemptsMean: runs.reduce((s, r) => s + r.attemptsWithIntensifySet, 0) / runs.length,
  };
}

function printCell(c: CellStats): void {
  const mark = c.unfilledMax > 0 ? ' ⚠' : '';
  console.log(
    `  ${c.mode.padEnd(10)} ` +
      `mean=${c.bestMean.toFixed(0).padStart(7)} σ=${c.bestStdev.toFixed(0).padStart(5)} ` +
      `[min=${c.bestMin.toFixed(0).padStart(7)}, med=${c.bestMedian.toFixed(0).padStart(7)}, max=${c.bestMax.toFixed(0).padStart(7)}] ` +
      `unf=${c.unfilledMean.toFixed(1).padStart(5)}/max=${c.unfilledMax.toString().padStart(2)} ` +
      `t=${(c.totalMsMean / 1000).toFixed(1).padStart(5)}s ` +
      `refresh=${c.refreshMean.toFixed(1).padStart(4)} ` +
      `postFeasibleBoost=${c.boostAfterFeasibleAttemptsMean.toFixed(1).padStart(5)} ` +
      `intensifyHit=${(c.intensifyHitRateMean * 100).toFixed(0)}% (${c.intensifyAttemptsMean.toFixed(0)} att)` +
      mark,
  );
}

async function runCell(
  scenario: string,
  mode: BoostMode,
  attempts: number,
  eliteInterval: number,
  configOverrides: Partial<SchedulerConfig>,
  seeds: number,
  participants: Participant[],
  tasks: Task[],
): Promise<CellStats> {
  const restRules = getAllRestRules();
  const restRuleMap = new Map(restRules.map((r) => [r.id, r.durationHours]));
  const dayStartHour = getDayStartHour();
  const config: SchedulerConfig = {
    ...require('../../src/models/types').DEFAULT_CONFIG,
    ...configOverrides,
  };
  const runs: RunResult[] = [];
  for (let s = 0; s < seeds; s++) {
    const r = runMultiAttempt(tasks, participants, config, attempts, mode, eliteInterval, restRuleMap, dayStartHour);
    runs.push(r);
  }
  const c = aggregate(scenario, mode, attempts, runs);
  printCell(c);
  return c;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2] ?? 'primary';

  console.log('Initializing store…');
  initStore();
  setScheduleDays(7);
  const allParticipants = getAllParticipants();
  console.log(`  default pool: ${allParticipants.length} participants`);

  const cells: CellStats[] = [];
  const t0 = Date.now();
  const ATTEMPTS = 600; // forces 2 refreshes at i=200 and i=400 with EI=200
  const EI = 200;
  const cfg: Partial<SchedulerConfig> = { maxIterations: 100000, maxSolverTimeMs: 30000 };

  // ── PRIMARY: pool 36 group-removal — boundary, refresh fires twice ─────
  if (arg === 'primary' || arg === 'all') {
    console.log(`\n=== PRIMARY: pool 36 group-removal, ${ATTEMPTS} attempts, EI=${EI} ===`);
    const subset = buildParticipantPoolByRemovingGroups(allParticipants, 1);
    const tasks = buildTasks(7, getScheduleDate());
    console.log(`  workload: ${subset.length} ppl, ${tasks.length} tasks`);
    console.log('  format: mode  mean σ [min,med,max]  unf  t  refresh  postFeasibleBoost  intensifyHit% (#attempts)');
    for (const mode of ['off', 'on', 'cleared', 'selective'] as BoostMode[]) {
      cells.push(await runCell('pool-36-grp-remove', mode, ATTEMPTS, EI, cfg, 8, subset, tasks));
    }
  }

  // ── SECONDARY: pool 40 individual-absence — boundary, sometimes feasible ─
  if (arg === 'secondary' || arg === 'all') {
    console.log(`\n=== SECONDARY: pool 40 individual-absence, ${ATTEMPTS} attempts, EI=${EI} ===`);
    const subset = buildParticipantSubset(allParticipants, 10);
    const tasks = buildTasks(7, getScheduleDate());
    console.log(`  workload: ${subset.length} ppl, ${tasks.length} tasks`);
    for (const mode of ['off', 'on', 'cleared', 'selective'] as BoostMode[]) {
      cells.push(await runCell('pool-40-individual', mode, ATTEMPTS, EI, cfg, 6, subset, tasks));
    }
  }

  // ── TERTIARY: pool 48 default — almost always feasible, tests sticky-after-feasible
  if (arg === 'tertiary' || arg === 'all') {
    console.log(`\n=== TERTIARY: pool 48 default, ${ATTEMPTS} attempts, EI=${EI} ===`);
    const subset = allParticipants;
    const tasks = buildTasks(7, getScheduleDate());
    console.log(`  workload: ${subset.length} ppl, ${tasks.length} tasks`);
    for (const mode of ['off', 'on', 'cleared'] as BoostMode[]) {
      cells.push(await runCell('pool-48-default', mode, ATTEMPTS, EI, cfg, 4, subset, tasks));
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`\n=== ALL DONE (${(totalMs / 1000).toFixed(1)}s) ===`);

  const outDir = path.join(__dirname, 'results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `elite-boost-flaws-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ totalMs, cells }, null, 2));
  console.log(`  → saved ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
