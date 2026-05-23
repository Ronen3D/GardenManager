/**
 * Single-run executor for the shift-splitting tuning benchmark.
 *
 * Wraps `optimizeMultiAttempt` with a seeded RNG and captures every metric
 * the analysis needs — including an INDEPENDENT `fullValidate` pass that
 * re-checks every hard constraint against the realized task set. This is
 * deliberate: HC correctness is non-negotiable, so we never trust the
 * optimizer's self-reported `feasible` alone.
 */

import { _benchSetMaxStructuralPasses, optimizeMultiAttempt, setBenchHooks, type OptimizationResult } from '../engine/optimizer';
import { fullValidate } from '../engine/validator';
import { DEFAULT_CONFIG, type SchedulerConfig, type Task } from '../models/types';
import type { BuiltScenario } from './scenarios';
import { withSeededRandom } from './seeded-rng';

/** Result of one optimizer run on one (scenario, params, seed). */
export interface RunResult {
  // Identity
  scenarioId: string;
  splitPenalty: number;
  splittingOn: boolean; // false when the scenario has splittableSet='none'
  maxStructuralPasses: number;
  seed: number;
  attempts: number;
  maxSolverTimeMs: number;
  // Sizing (constant per scenario; included for sanity)
  tasksIn: number;
  slotsIn: number;
  participants: number;
  // Outcome
  feasible: boolean;
  unfilledSlots: number;
  hcViolations: number; // independent fullValidate count
  softWarnings: number;
  // Composite + breakdown
  compositeScore: number;
  minRestHours: number;
  restPerGapBonus: number;
  l0StdDev: number;
  seniorStdDev: number;
  dailyPerParticipantStdDev: number;
  dailyGlobalStdDev: number;
  totalPenalty: number;
  lowPriorityPenalty: number;
  notWithPenalty: number;
  taskPrefPenalty: number;
  splitPenaltyContribution: number;
  // Structural
  splitSlotCount: number; // count of #a halves in realized tasks
  splitOccurrenceCount: number; // distinct splitOccurrenceId across realized tasks
  tasksRealized: number;
  // Timing
  runtimeMs: number;
  greedyMs: number;
  saMs: number;
  polishMs: number;
  iterations: number;
  actualAttempts: number;
}

export interface RunParams {
  splitPenalty: number;
  splittingOn: boolean; // false when the scenario is the OFF control
  maxStructuralPasses: number; // 2 = product default
  seed: number;
  attempts: number; // optimizeMultiAttempt attempts
  maxSolverTimeMs: number; // per-attempt SA cap
}

function totalSlots(tasks: Task[]): number {
  let s = 0;
  for (const t of tasks) s += t.slots.length;
  return s;
}

function countSplitMetrics(tasks: Task[]): { splitSlotCount: number; splitOccurrenceCount: number } {
  let splitSlotCount = 0;
  const occs = new Set<string>();
  for (const t of tasks) {
    if (t.splitPart === 1) splitSlotCount++;
    if (t.splitOccurrenceId) occs.add(t.splitOccurrenceId);
  }
  return { splitSlotCount, splitOccurrenceCount: occs.size };
}

export function runOnce(scenario: BuiltScenario, params: RunParams): RunResult {
  const config: SchedulerConfig = {
    ...DEFAULT_CONFIG,
    splitPenalty: params.splitPenalty,
    maxSolverTimeMs: params.maxSolverTimeMs,
  };

  // Reset bench hooks (other benches in this repo set them; defensive).
  setBenchHooks(null);
  _benchSetMaxStructuralPasses(params.maxStructuralPasses);

  const t0 = Date.now();
  const result: OptimizationResult = withSeededRandom(params.seed, () =>
    optimizeMultiAttempt(
      scenario.tasks,
      scenario.participants,
      config,
      [],
      params.attempts,
      undefined,
      undefined,
      undefined,
      scenario.restRuleMap,
      undefined,
      undefined,
      scenario.dayStartHour,
      // The split-tuning bench measures Phase-2 quality splits against
      // `splitPenalty` — treat the engine as quality mode so structuralRefine
      // runs both arms exactly as production.
      true,
    ),
  );
  const runtimeMs = Date.now() - t0;
  // Restore default before returning so subsequent runs are isolated.
  _benchSetMaxStructuralPasses(null);

  const realizedTasks = result.tasks ?? scenario.tasks;

  // Independent HC validation — guards against any internal bookkeeping bug.
  // SLOT_UNFILLED and GROUP_INSUFFICIENT are *expected* under pressure (both
  // mean "the optimizer couldn't fill this slot", reflected in `unfilledSlots`);
  // we only flag *real* placement violations — cases where the optimizer
  // placed an INVALID assignment (HC-1/2/3/4/5/7/8/11/12/14/15/16). Per the
  // benchmark's correctness bar: improving score by producing an invalid
  // schedule is a failure, not a win.
  const validation = fullValidate(
    realizedTasks,
    scenario.participants,
    result.assignments,
    undefined,
    scenario.restRuleMap,
    undefined,
    undefined,
  );
  const NON_PLACEMENT_CODES = new Set<string>(['SLOT_UNFILLED', 'GROUP_INSUFFICIENT']);
  const hcViolations = validation.violations.filter((v) => !NON_PLACEMENT_CODES.has(v.code)).length;
  const softWarnings = validation.warnings.length;

  const splitMetrics = countSplitMetrics(realizedTasks);

  const score = result.score;
  const breakdown = {
    minRestHours: score.minRestHours ?? 0,
    restPerGapBonus: score.restPerGapBonus ?? 0,
    l0StdDev: score.l0StdDev ?? 0,
    seniorStdDev: score.seniorStdDev ?? 0,
    dailyPerParticipantStdDev: score.dailyPerParticipantStdDev ?? 0,
    dailyGlobalStdDev: score.dailyGlobalStdDev ?? 0,
    totalPenalty: score.totalPenalty ?? 0,
    lowPriorityPenalty: score.lowPriorityPenalty ?? 0,
    notWithPenalty: score.notWithPenalty ?? 0,
    taskPrefPenalty: score.taskPrefPenalty ?? 0,
    splitPenaltyContribution: score.splitPenalty ?? 0,
  };

  return {
    scenarioId: scenario.spec.id,
    splitPenalty: params.splitPenalty,
    splittingOn: params.splittingOn,
    maxStructuralPasses: params.maxStructuralPasses,
    seed: params.seed,
    attempts: params.attempts,
    maxSolverTimeMs: params.maxSolverTimeMs,
    tasksIn: scenario.tasks.length,
    slotsIn: totalSlots(scenario.tasks),
    participants: scenario.participants.length,
    feasible: result.feasible,
    unfilledSlots: result.unfilledSlots.length,
    hcViolations,
    softWarnings,
    compositeScore: score.compositeScore,
    ...breakdown,
    splitSlotCount: splitMetrics.splitSlotCount,
    splitOccurrenceCount: splitMetrics.splitOccurrenceCount,
    tasksRealized: realizedTasks.length,
    runtimeMs,
    greedyMs: result.phaseDurations.greedyMs,
    saMs: result.phaseDurations.saMs,
    polishMs: result.phaseDurations.polishMs,
    iterations: result.iterations,
    actualAttempts: result.actualAttempts,
  };
}
