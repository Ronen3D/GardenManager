/**
 * Elite-boost ELITE_INTERVAL sweep. Reimplements optimizeMultiAttempt's
 * outer loop with a parameterized eliteInterval so we can sweep without
 * touching production code.
 *
 * Run with:
 *   npx ts-node --project experiments/algo-tuning/tsconfig.json experiments/algo-tuning/elite-interval-sweep.ts [exp]
 *
 * Where [exp] ∈ {screen, full, all}.
 */

// localStorage shim — must be first
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

/**
 * Two pool-shaping modes:
 *
 * (A) "uniform" — keep all 4 groups, take `perGroupCount` from each. Models
 *     "scattered absences" (flu, training, leave) where each group loses some
 *     people but no group is wholly gone.
 *
 * (B) "remove-groups" — remove `groupsToRemove` whole groups, keep remaining
 *     groups at their full default size of 12. Models "a whole team is out"
 *     (training week, dissolved squad). This is the scenario the user reports
 *     using in manual runs.
 *
 * Both produce the same total pool size for matched parameters
 * (e.g. perGroup=9 across 4 groups OR remove 1 group of 12 → both = 36 ppl)
 * but the constraint structure differs because `sameGroupRequired` tasks
 * (e.g. Adanit) require all assignees to share a group — fewer groups means
 * fewer candidate groups per Adanit instance.
 */
function buildParticipantPoolByRemovingGroups(allParticipants: Participant[], groupsToRemove: number): Participant[] {
  const byGroup = new Map<string, Participant[]>();
  for (const p of allParticipants) {
    const g = p.group ?? '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(p);
  }
  // Remove the LAST `groupsToRemove` groups (deterministic — קבוצה 4 first, then 3, etc.)
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
      // Take all available, then clone L0 participants
      result.push(...list);
      const l0s = list.filter((p) => p.level === 0);
      const need = perGroupCount - list.length;
      for (let i = 0; i < need; i++) {
        const src = l0s[i % l0s.length];
        result.push({
          ...src,
          id: `${src.id}-clone${i + 1}`,
          name: `${src.name} (שיבוט ${i + 1})`,
          // Spread availability/dateUnavailability arrays to avoid sharing references
          availability: src.availability.map((a) => ({ ...a })),
          dateUnavailability: src.dateUnavailability.map((d) => ({ ...d })),
          // Clear pakal assignments on clones — pakals are unique-per-participant
          // by design (Adanit-style sub-team slots), so cloning would create collisions.
          pakalIds: [],
          certifications: [...src.certifications],
        });
      }
    }
  }
  return result;
}

// ─── Internal helpers (mirror optimizer.ts internals) ──────────────────────
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function isBetterResult(candidate: OptimizationResult, current: OptimizationResult): boolean {
  const candUnfilled = candidate.unfilledSlots.length;
  const curUnfilled = current.unfilledSlots.length;
  if (candUnfilled < curUnfilled) return true;
  if (candUnfilled > curUnfilled) return false;
  return candidate.score.compositeScore > current.score.compositeScore;
}

// ─── Reimplemented multi-attempt loop with parameterized eliteInterval ────
interface AttemptRecord {
  attempt: number;
  attemptScore: number;
  attemptUnfilled: number;
  bestScore: number;
  bestUnfilled: number;
  improved: boolean;
  refreshFiredAtThisAttempt: boolean;
  boostSetSize: number;
  intensifySetSize: number;
}

interface RunResult {
  bestScore: number;
  bestUnfilled: number;
  bestFeasible: boolean;
  attempts: number;
  totalMs: number;
  refreshCount: number;
  log: AttemptRecord[];
}

function runMultiAttempt(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  attempts: number,
  eliteInterval: number,
  restRuleMap: Map<string, number> | undefined,
  dayStartHour: number,
): RunResult {
  let best: OptimizationResult | null = null;
  const ctx = buildSchedulingContext(tasks, participants);
  let eliteBoost: EliteBoostState = { boostTaskIds: new Set(), saIntensifyTaskIds: new Set() };
  const log: AttemptRecord[] = [];
  let refreshCount = 0;
  const t0 = Date.now();

  for (let i = 0; i < attempts; i++) {
    let refreshFired = false;
    if (best && i > 0 && i % eliteInterval === 0 && best.unfilledSlots.length > 0) {
      eliteBoost = classifyUnfilledSlots(best.unfilledSlots);
      refreshFired = true;
      refreshCount++;
    }

    const shuffledParticipants = i === 0 ? [...participants] : shuffle([...participants]);

    const attemptTasks =
      eliteBoost.boostTaskIds.size > 0 && i > 0
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

    const improved = best === null || isBetterResult(result, best);
    if (improved) best = result;

    log.push({
      attempt: i + 1,
      attemptScore: result.score.compositeScore,
      attemptUnfilled: result.unfilledSlots.length,
      bestScore: best!.score.compositeScore,
      bestUnfilled: best!.unfilledSlots.length,
      improved,
      refreshFiredAtThisAttempt: refreshFired,
      boostSetSize: eliteBoost.boostTaskIds.size,
      intensifySetSize: eliteBoost.saIntensifyTaskIds.size,
    });
  }

  const totalMs = Date.now() - t0;
  return {
    bestScore: best!.score.compositeScore,
    bestUnfilled: best!.unfilledSlots.length,
    bestFeasible: best!.feasible,
    attempts,
    totalMs,
    refreshCount,
    log,
  };
}

// ─── Cell aggregator ───────────────────────────────────────────────────────
interface CellStats {
  label: string;
  eliteInterval: number;
  workload: { participants: number; tasks: number; slots: number };
  seeds: number;
  bestScores: number[];
  bestUnfilled: number[];
  refreshCounts: number[];
  perRunMs: number[];
  bestMean: number;
  bestStdev: number;
  bestMin: number;
  bestMax: number;
  bestMedian: number;
  unfilledMean: number;
  unfilledMax: number;
  totalMsMean: number;
  refreshMean: number;
  // Diversity metric: stdev of per-attempt scores within each run, averaged
  attemptScoreStdevMean: number;
}

function aggregate(label: string, eliteInterval: number, workload: any, runs: RunResult[]): CellStats {
  const bestScores = runs.map((r) => r.bestScore);
  const sorted = [...bestScores].sort((a, b) => a - b);
  const mean = bestScores.reduce((s, x) => s + x, 0) / bestScores.length;
  const variance = bestScores.reduce((s, x) => s + (x - mean) ** 2, 0) / bestScores.length;
  const stdev = Math.sqrt(variance);

  // Per-run intra-attempt score stdev (diversity proxy)
  const perRunStdevs = runs.map((r) => {
    const scores = r.log.map((a) => a.attemptScore);
    const m = scores.reduce((s, x) => s + x, 0) / scores.length;
    const v = scores.reduce((s, x) => s + (x - m) ** 2, 0) / scores.length;
    return Math.sqrt(v);
  });

  return {
    label,
    eliteInterval,
    workload,
    seeds: runs.length,
    bestScores,
    bestUnfilled: runs.map((r) => r.bestUnfilled),
    refreshCounts: runs.map((r) => r.refreshCount),
    perRunMs: runs.map((r) => r.totalMs),
    bestMean: mean,
    bestStdev: stdev,
    bestMin: sorted[0],
    bestMax: sorted[sorted.length - 1],
    bestMedian: sorted[Math.floor(sorted.length / 2)],
    unfilledMean: runs.reduce((s, r) => s + r.bestUnfilled, 0) / runs.length,
    unfilledMax: Math.max(...runs.map((r) => r.bestUnfilled)),
    totalMsMean: runs.reduce((s, r) => s + r.totalMs, 0) / runs.length,
    refreshMean: runs.reduce((s, r) => s + r.refreshCount, 0) / runs.length,
    attemptScoreStdevMean: perRunStdevs.reduce((s, x) => s + x, 0) / perRunStdevs.length,
  };
}

function printCell(c: CellStats): void {
  const mark = c.unfilledMax > 0 ? ' ⚠' : '';
  console.log(
    `  ${c.label.padEnd(36)} ` +
    `mean=${c.bestMean.toFixed(0).padStart(7)} σ=${c.bestStdev.toFixed(0).padStart(5)} ` +
    `[min=${c.bestMin.toFixed(0).padStart(7)}, med=${c.bestMedian.toFixed(0).padStart(7)}, max=${c.bestMax.toFixed(0).padStart(7)}] ` +
    `unf=${c.unfilledMean.toFixed(1).padStart(5)}/max=${c.unfilledMax.toString().padStart(3)} ` +
    `t=${(c.totalMsMean/1000).toFixed(1).padStart(5)}s ` +
    `refresh=${c.refreshMean.toFixed(1).padStart(4)} ` +
    `intraσ=${c.attemptScoreStdevMean.toFixed(0)}` +
    mark,
  );
}

async function runCell(
  label: string,
  eliteInterval: number,
  attempts: number,
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
    const r = runMultiAttempt(tasks, participants, config, attempts, eliteInterval, restRuleMap, dayStartHour);
    runs.push(r);
  }
  const workload = {
    participants: participants.length,
    tasks: tasks.length,
    slots: tasks.reduce((sum, t) => sum + t.slots.length, 0),
  };
  const c = aggregate(label, eliteInterval, workload, runs);
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
  const arg = process.argv[2] ?? 'screen';

  console.log('Initializing store…');
  initStore();
  setScheduleDays(7);
  const allParticipants = getAllParticipants();
  console.log(`  default pool: ${allParticipants.length} participants`);

  const cells: CellStats[] = [];
  const t0 = Date.now();
  const intervals = [1_000_000, 200, 50, 20, 10, 5];   // 1M = effectively disabled
  const attemptCount = 60;
  const cfg: Partial<SchedulerConfig> = { maxIterations: 100000, maxSolverTimeMs: 30000 };

  // ── Screen: pool 36, 3 seeds — quick signal check ──────────────────────
  if (arg === 'screen' || arg === 'all') {
    console.log('\n=== SCREEN: pool 36, 60 attempts, 3 seeds × 6 ELITE_INTERVAL values ===');
    const subset = buildParticipantSubset(allParticipants, 9);
    const tasks = buildTasks(7, getScheduleDate());
    console.log(`  workload: ${subset.length} ppl, ${tasks.length} tasks`);
    console.log('  format: label  mean=μ σ=σ [min,med,max]  unf=u  t=wall  refresh=r  intraσ=s');
    for (const ei of intervals) {
      const label = ei === 1_000_000 ? 'EI=disabled' : `EI=${ei}`;
      cells.push(await runCell(label.padEnd(15), ei, attemptCount, cfg, 3, subset, tasks));
    }
  }

  // ── Calibration: verify pool 36 (3 groups × 12) produces ~5-10 unfilled
  if (arg === 'calibrate' || arg === 'full' || arg === 'all') {
    console.log('\n=== CALIBRATION — verify "remove 1 group → 36 ppl" matches user-observed ~5-10 unfilled ===');
    const tasks = buildTasks(7, getScheduleDate());
    const subset = buildParticipantPoolByRemovingGroups(allParticipants, 1);
    console.log(`  pool: ${subset.length} ppl (groups: ${[...new Set(subset.map((p) => p.group))].join(', ')})`);
    cells.push(await runCell('calib disabled (3grp×12)       ', 1_000_000, attemptCount, cfg, 6, subset, tasks));
  }

  // ── Realistic-only sweep — boundary-focused effort allocation ──────────
  if (arg === 'full' || arg === 'all') {
    const tasks = buildTasks(7, getScheduleDate());

    // TRACK A: TEAM-OUT scenarios (whole group removed — user's manual pattern)
    //   remove 0 → 48 (default, feasible)        — null/control
    //   remove 1 → 36 (one team out, ~5 unfilled) — PRIMARY
    //   remove 2 → 24 (two teams out, deep)       — spot check only
    const teamOutPlan: Array<{ removeGroups: number; eiValues: number[]; seeds: number; label: string }> = [
      { removeGroups: 0, eiValues: intervals, seeds: 6, label: 'A: pool 48 (default — control/null)' },
      { removeGroups: 1, eiValues: intervals, seeds: 12, label: 'A: pool 36 (1 team out — PRIMARY)' },
      { removeGroups: 2, eiValues: [1_000_000, 50, 10], seeds: 4, label: 'A: pool 24 (2 teams out — spot check)' },
    ];
    for (const plan of teamOutPlan) {
      const subset = buildParticipantPoolByRemovingGroups(allParticipants, plan.removeGroups);
      console.log(`\n--- ${plan.label}: ${subset.length} ppl, ${plan.eiValues.length} EI × ${plan.seeds} seeds ---`);
      for (const ei of plan.eiValues) {
        const label = ei === 1_000_000 ? 'EI=disabled' : `EI=${ei}`;
        cells.push(await runCell(label.padEnd(15), ei, attemptCount, cfg, plan.seeds, subset, tasks));
      }
    }

    // TRACK B: INDIVIDUAL-ABSENCE scenarios (some L0s sick from each group)
    //   perGroup=11 → 44 (1 L0 sick per group)  — light realistic stress
    //   perGroup=10 → 40 (2 L0 sick per group)  — boundary
    //   perGroup= 9 → 36 (3 L0 sick per group)  — heavier realistic stress + comparison vs Track A pool 36
    const individualAbsencePlan: Array<{ perGroup: number; eiValues: number[]; seeds: number; label: string }> = [
      { perGroup: 11, eiValues: intervals, seeds: 8, label: 'B: pool 44 (1 L0/grp out)' },
      { perGroup: 10, eiValues: intervals, seeds: 8, label: 'B: pool 40 (2 L0/grp out — boundary)' },
      { perGroup: 9,  eiValues: intervals, seeds: 8, label: 'B: pool 36 (3 L0/grp out — vs Track A)' },
    ];
    for (const plan of individualAbsencePlan) {
      const subset = buildParticipantSubset(allParticipants, plan.perGroup);
      console.log(`\n--- ${plan.label}: ${subset.length} ppl, ${plan.eiValues.length} EI × ${plan.seeds} seeds ---`);
      for (const ei of plan.eiValues) {
        const label = ei === 1_000_000 ? 'EI=disabled' : `EI=${ei}`;
        cells.push(await runCell(label.padEnd(15), ei, attemptCount, cfg, plan.seeds, subset, tasks));
      }
    }
  }

  const totalMs = Date.now() - t0;
  console.log(`\n=== ALL DONE (${(totalMs/1000).toFixed(1)}s) ===`);
  saveJson(`elite-interval-${Date.now()}.json`, { totalMs, cells });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
