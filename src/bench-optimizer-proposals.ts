/**
 * Bench — empirical evaluation of two proposed optimizer changes.
 *
 *   Proposal A: Score sameGroupRequired group choices in greedy
 *               (instead of accepting the first feasible group).
 *   Proposal B: Deterministic post-greedy polish over (assigned, idle)
 *               replacement candidates that strictly improve score.
 *
 * Run with: npx ts-node src/bench-optimizer-proposals.ts
 */

import { isLevelSatisfied, validateHardConstraints } from './constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from './constraints/soft-constraints';
import { type OptimizationResult, optimizeMultiAttempt } from './engine/optimizer';
import { isEligible } from './engine/validator';
import { isLowPriority } from './models/level-utils';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type SchedulerConfig,
  type Task,
} from './models/types';
import { computeTaskEffectiveHours } from './shared/utils/load-weighting';
import { generateDailyTasks, generateWeeklyTasks } from './tasks/cli-task-factory';
import { computeAllCapacities } from './utils/capacity';

// ─── Fixture builders ───────────────────────────────────────────────────────

function p(id: string, name: string, level: Level, certs: string[], group: string): Participant {
  return {
    id,
    name,
    level,
    certifications: certs,
    group,
    availability: [{ start: new Date(2026, 1, 14), end: new Date(2026, 1, 23) }],
    dateUnavailability: [],
  };
}

/** 30 participants, three groups of 10. Used in production-realistic scenarios. */
function buildBalancedParticipants(): Participant[] {
  const out: Participant[] = [];
  for (const g of ['Alpha', 'Beta', 'Gamma'] as const) {
    const prefix = g.slice(0, 1).toLowerCase();
    for (let i = 1; i <= 10; i++) {
      const level = i <= 7 ? Level.L0 : i === 8 ? Level.L2 : i === 9 ? Level.L3 : Level.L4;
      const certs: string[] = ['Nitzan'];
      if (i % 2 === 0) certs.push('Salsala');
      if (i % 3 === 0) certs.push('Hamama');
      if (i % 5 === 0) certs.push('Horesh');
      out.push(p(`${prefix}${i}`, `${g}-${i.toString().padStart(2, '0')}`, level, certs, g));
    }
  }
  return out;
}

/**
 * Adversarial Trap 2 fixture: three groups with near-equivalent same-group
 * feasibility for an Adanit shift, but with deliberately different downstream
 * implications:
 *   - Alpha:  all 10 fully Nitzan-certified, 1× L2, 1× L3, 1× L4 → feasible.
 *             But Alpha has the only L2/L3/L4 with a critical "preferredTask"
 *             tied to non-Adanit shifts → using Alpha for Adanit costs SC-10.
 *   - Beta:   same composition, no preferences → neutral.
 *   - Gamma:  same composition, but L4 has lowPriority=true on one slot →
 *             scoring against Gamma costs lowPriorityLevelPenalty.
 *
 * Greedy first-feasible commits to whichever group sorts first by total
 * workload; randomness picks Alpha/Beta/Gamma uniformly when workloads tie.
 * Beta is strictly best, Alpha and Gamma each cost a soft penalty.
 */
function buildTrap2Adversarial(): { participants: Participant[]; tasks: Task[] } {
  const participants: Participant[] = [];
  const groups = ['Alpha', 'Beta', 'Gamma'] as const;
  for (const g of groups) {
    const prefix = g.slice(0, 1).toLowerCase();
    for (let i = 1; i <= 10; i++) {
      // Composition: 7× L0, 1× L2, 1× L3, 1× L4 — every member has Nitzan.
      const level = i <= 7 ? Level.L0 : i === 8 ? Level.L2 : i === 9 ? Level.L3 : Level.L4;
      const part: Participant = {
        id: `${prefix}${i}`,
        name: `${g}-${i.toString().padStart(2, '0')}`,
        level,
        certifications: ['Nitzan'],
        group: g,
        availability: [{ start: new Date(2026, 1, 14), end: new Date(2026, 1, 23) }],
        dateUnavailability: [],
      };
      // Alpha L2/L3/L4 prefer non-Adanit work. The optimizer adds penalty when
      // they end up on Adanit because their preferredTaskName is not 'אדנית'.
      if (g === 'Alpha' && level !== Level.L0) {
        part.preferredTaskName = 'שמש';
      }
      participants.push(part);
    }
  }

  // Adanit task: same-group, sub-team rules; one slot accepts L4 with lowPriority.
  // For Gamma group only, this lowPriority slot will be filled by an L4 because
  // L3 is also assigned (only 1 L3 in the group, 1 L4 left over).
  const baseDate = new Date(2026, 1, 16);
  const slots = [];
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: `adv-adanit-l0-a-${i}`,
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: ['Nitzan'],
      subTeamId: 'segol-main',
      label: 'משתתף בסגול א',
    });
  }
  slots.push({
    slotId: 'adv-adanit-senior-a',
    acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
    requiredCertifications: ['Nitzan'],
    subTeamId: 'segol-main',
    label: 'סגל בסגול א',
  });
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: `adv-adanit-l0-b-${i}`,
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: ['Nitzan'],
      subTeamId: 'segol-secondary',
      label: 'משתתף בסגול ב',
    });
  }
  slots.push({
    slotId: 'adv-adanit-senior-b',
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: ['Nitzan'],
    subTeamId: 'segol-secondary',
    label: "בכיר בסגול ב'",
  });

  const adanitTask: Task = {
    id: 'adv-adanit',
    name: 'משמרת אדנית',
    sourceName: 'אדנית',
    timeBlock: {
      start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 0),
      end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 13, 0),
    },
    requiredCount: 6,
    slots,
    sameGroupRequired: true,
    blocksConsecutive: true,
    restRuleId: 'demo-rest-rule',
  };

  // Add small filler tasks so the optimizer has more to do (and so SC scoring
  // operates on more than one task). Use tasks the senior-pref participants
  // could fill.
  const allTasks: Task[] = [adanitTask, ...generateDailyTasks(baseDate, true)];
  return { participants, tasks: allTasks };
}

// ─── Trap 1 fixture: idle senior with preference unreachable post-greedy ────

/**
 * Builds a fixture where a participant with a preferred task name is left idle
 * because greedy fills the preferred-task slot with someone else (workload
 * tiebreak). After greedy, SA's pairwise-swap can't replace the assigned
 * participant with the idle one.
 */
function buildTrap1Adversarial(): { participants: Participant[]; tasks: Task[] } {
  const participants: Participant[] = [];
  // 18 L0 + 3 seniors per group × 2 groups = 42 total. Many idle on light days.
  for (const g of ['Alpha', 'Beta'] as const) {
    const prefix = g.slice(0, 1).toLowerCase();
    for (let i = 1; i <= 21; i++) {
      const level = i <= 18 ? Level.L0 : i === 19 ? Level.L2 : i === 20 ? Level.L3 : Level.L4;
      const part: Participant = {
        id: `${prefix}${i}`,
        name: `${g}-${i.toString().padStart(2, '0')}`,
        level,
        certifications: ['Nitzan'],
        group: g,
        availability: [{ start: new Date(2026, 1, 14), end: new Date(2026, 1, 23) }],
        dateUnavailability: [],
      };
      // Mark a few participants with preferences for specific tasks
      if (i === 1) part.preferredTaskName = 'שמש';
      if (i === 5) part.preferredTaskName = 'שמש';
      if (i === 10) part.preferredTaskName = 'ערוגת בוקר';
      participants.push(part);
    }
  }

  const baseDate = new Date(2026, 1, 16);
  const tasks = generateWeeklyTasks(baseDate, 3);
  return { participants, tasks };
}

// ─── Score helpers ──────────────────────────────────────────────────────────

function buildScoreCtx(tasks: Task[], participants: Participant[]): ScoreContext {
  let s = tasks[0]?.timeBlock.start ?? new Date();
  let e = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < s) s = t.timeBlock.start;
    if (t.timeBlock.end > e) e = t.timeBlock.end;
  }
  return {
    taskMap: new Map(tasks.map((t) => [t.id, t])),
    pMap: new Map(participants.map((pp) => [pp.id, pp])),
    capacities: computeAllCapacities(participants, s, e, 5),
    notWithPairs: new Map(),
    dayStartHour: 5,
  };
}

function rebuildIndices(assignments: Assignment[]): {
  byParticipant: Map<string, Assignment[]>;
  byTask: Map<string, Assignment[]>;
} {
  const byParticipant = new Map<string, Assignment[]>();
  const byTask = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const pl = byParticipant.get(a.participantId);
    if (pl) pl.push(a);
    else byParticipant.set(a.participantId, [a]);
    const tl = byTask.get(a.taskId);
    if (tl) tl.push(a);
    else byTask.set(a.taskId, [a]);
  }
  return { byParticipant, byTask };
}

// ─── Proposal B: deterministic idle-vs-assigned polish ──────────────────────

/**
 * For every (assignedParticipant, idleParticipant) pair, attempt to replace
 * the assigned with the idle. Accept only strict composite-score improvements.
 *
 * "Idle" means: any participant who could be eligible for SOME assigned slot.
 * We re-evaluate eligibility each pass because earlier replacements change
 * who is idle and who is busy.
 *
 * Maintains all hard constraints via `isEligible`.
 *
 * Returns: { polishedAssignments, replacements, polishedScore }.
 */
function polishIdleVsAssigned(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
  disabledHC?: Set<string>,
  restRuleMap?: Map<string, number>,
): {
  assignments: Assignment[];
  replacements: number;
  durationMs: number;
} {
  const start = Date.now();
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const ctx = buildScoreCtx(tasks, participants);
  const current = assignments.map((a) => ({ ...a }));
  let currentScore = computeScheduleScore(tasks, participants, current, config, ctx).compositeScore;

  let replacements = 0;
  let improved = true;
  let pass = 0;
  while (improved && pass < 5) {
    improved = false;
    pass++;
    const indexed = rebuildIndices(current);

    // Iterate over a snapshot of indices because we mutate `current` mid-loop.
    const positions = current.map((_, i) => i);
    for (const i of positions) {
      const a = current[i];
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      const slot = task.slots.find((s) => s.slotId === a.slotId);
      if (!slot) continue;

      // Skip same-group tasks here — replacing within them is fine if same
      // group; replacing across groups would violate HC-4.
      const sameGroup = task.sameGroupRequired;

      const incumbent = participants.find((pp) => pp.id === a.participantId);
      if (!incumbent) continue;

      // Build a "without me" assignment list to test alternative candidates
      const without = current.filter((c) => c.id !== a.id);
      const idxWithout = rebuildIndices(without);

      let bestDelta = 0;
      let bestCandidate: Participant | null = null;
      for (const cand of participants) {
        if (cand.id === incumbent.id) continue;
        // HC-4: same-group task — candidate must be in same group as remaining
        // task-mates. Determine the existing group from `without` (i.e.
        // excluding the incumbent we're about to replace).
        if (sameGroup) {
          const taskMates = without.filter((c) => c.taskId === a.taskId);
          if (taskMates.length > 0) {
            const groups = new Set(
              taskMates.map((c) => participants.find((pp) => pp.id === c.participantId)?.group ?? ''),
            );
            if (!groups.has(cand.group)) continue;
          }
        }
        // HC-7: candidate cannot already be in this task
        const candAssigns = idxWithout.byParticipant.get(cand.id) || [];
        if (candAssigns.some((c) => c.taskId === a.taskId)) continue;
        if (!isEligible(cand, task, slot, candAssigns, taskMap, { disabledHC, restRuleMap })) continue;

        // Try the replacement: temporarily swap, re-score
        const original = a.participantId;
        a.participantId = cand.id;
        const newScore = computeScheduleScore(tasks, participants, current, config, ctx).compositeScore;
        const delta = newScore - currentScore;
        a.participantId = original; // undo

        if (delta > bestDelta) {
          bestDelta = delta;
          bestCandidate = cand;
        }
      }

      if (bestCandidate && bestDelta > 1e-6) {
        a.participantId = bestCandidate.id;
        currentScore += bestDelta;
        replacements++;
        improved = true;
      }
    }
  }

  return { assignments: current, replacements, durationMs: Date.now() - start };
}

// ─── Proposal A: post-hoc analysis of group-choice variance ─────────────────

/**
 * Across N runs of the optimizer, for each same-group task in the schedule,
 * collect:
 *   - Which group was chosen.
 *   - Whether the resulting same-group assignment was ever associated with a
 *     better composite score in any other run (proxy for "another group
 *     would have been better").
 *
 * This tells us how much score variance is explained by group-choice
 * randomness, which bounds the upside of Proposal A.
 */
function analyseGroupChoiceVariance(
  results: OptimizationResult[],
  tasks: Task[],
  participants: Participant[],
): {
  taskId: string;
  taskName: string;
  groupCounts: Map<string, number>;
  groupAvgScores: Map<string, number>;
  bestGroup: string;
  worstGroup: string;
  spreadScore: number;
}[] {
  const sameGroupTasks = tasks.filter((t) => t.sameGroupRequired);
  const out: Array<{
    taskId: string;
    taskName: string;
    groupCounts: Map<string, number>;
    groupAvgScores: Map<string, number>;
    bestGroup: string;
    worstGroup: string;
    spreadScore: number;
  }> = [];

  for (const task of sameGroupTasks) {
    const groupCounts = new Map<string, number>();
    const groupScoreSums = new Map<string, number>();
    const groupScoreSamples = new Map<string, number>();
    for (const r of results) {
      const taskAssigns = r.assignments.filter((a) => a.taskId === task.id);
      if (taskAssigns.length === 0) continue;
      const part = participants.find((pp) => pp.id === taskAssigns[0].participantId);
      if (!part) continue;
      const group = part.group;
      groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
      groupScoreSums.set(group, (groupScoreSums.get(group) || 0) + r.score.compositeScore);
      groupScoreSamples.set(group, (groupScoreSamples.get(group) || 0) + 1);
    }

    const groupAvgScores = new Map<string, number>();
    for (const [g, sum] of groupScoreSums) {
      const n = groupScoreSamples.get(g) || 1;
      groupAvgScores.set(g, sum / n);
    }

    if (groupAvgScores.size < 2) {
      out.push({
        taskId: task.id,
        taskName: task.name,
        groupCounts,
        groupAvgScores,
        bestGroup: [...groupAvgScores.keys()][0] ?? '',
        worstGroup: [...groupAvgScores.keys()][0] ?? '',
        spreadScore: 0,
      });
      continue;
    }

    let bestGroup = '';
    let worstGroup = '';
    let bestScore = -Infinity;
    let worstScore = Infinity;
    for (const [g, avg] of groupAvgScores) {
      if (avg > bestScore) {
        bestScore = avg;
        bestGroup = g;
      }
      if (avg < worstScore) {
        worstScore = avg;
        worstGroup = g;
      }
    }

    out.push({
      taskId: task.id,
      taskName: task.name,
      groupCounts,
      groupAvgScores,
      bestGroup,
      worstGroup,
      spreadScore: bestScore - worstScore,
    });
  }

  return out;
}

// ─── Diagnostic: count lowPriority placements + idle participants ───────────

function countLowPriorityPlacements(result: OptimizationResult, tasks: Task[], participants: Participant[]): number {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const pMap = new Map(participants.map((p) => [p.id, p]));
  let count = 0;
  for (const a of result.assignments) {
    const task = taskMap.get(a.taskId);
    const part = pMap.get(a.participantId);
    if (!task || !part) continue;
    const slot = task.slots.find((s) => s.slotId === a.slotId);
    if (!slot) continue;
    if (isLowPriority(slot.acceptableLevels, part.level)) count++;
  }
  return count;
}

function countIdle(result: OptimizationResult, participants: Participant[]): number {
  const used = new Set(result.assignments.map((a) => a.participantId));
  return participants.length - used.size;
}

function fmt(x: number): string {
  return x.toFixed(2).padStart(10);
}

// ─── Experiments ────────────────────────────────────────────────────────────

interface ExperimentResult {
  name: string;
  baselineMean: number;
  baselineStd: number;
  baselineMinUnfilled: number;
  baselineMeanUnfilled: number;
  baselineLowPrioMean: number;
  baselineMeanRuntimeMs: number;
  withPolishMean: number;
  withPolishImprovementMean: number;
  withPolishImprovementMax: number;
  withPolishReplacementsMean: number;
  withPolishMeanRuntimeMs: number;
  groupChoiceMaxSpread: number;
  groupChoiceTaskCount: number;
  groupChoiceUnusedGroupTasks: number; // tasks where some group was never chosen
  polishHcViolationsTotal: number; // sum of new HC violations across runs (must be 0)
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function runExperiment(
  name: string,
  participants: Participant[],
  tasks: Task[],
  numRuns: number,
  attemptsPerRun: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): ExperimentResult {
  console.log(`\n── Experiment: ${name} ─────────────────────────────────`);
  console.log(`  ${participants.length} participants × ${tasks.length} tasks`);
  console.log(`  ${numRuns} runs × ${attemptsPerRun} attempts each`);

  const baselineResults: OptimizationResult[] = [];
  const baselineRuntimes: number[] = [];
  const baselineLowPrios: number[] = [];

  for (let r = 0; r < numRuns; r++) {
    const t0 = Date.now();
    const result = optimizeMultiAttempt(
      tasks,
      participants,
      config,
      [],
      attemptsPerRun,
      undefined, // onProgress
      undefined, // disabledHC
      undefined, // phantomContext
      undefined, // restRuleMap
      undefined, // certLabelResolver
      undefined, // scheduleContext
      5, // dayStartHour
    );
    baselineRuntimes.push(Date.now() - t0);
    baselineResults.push(result);
    baselineLowPrios.push(countLowPriorityPlacements(result, tasks, participants));
    process.stdout.write('.');
  }
  console.log('');

  const baselineScores = baselineResults.map((r) => r.score.compositeScore);
  const baselineUnfilled = baselineResults.map((r) => r.unfilledSlots.length);

  // Run polish on each baseline
  const polishResults: { delta: number; replacements: number; ms: number; finalScore: number; violations: number }[] =
    [];
  console.log('  Running idle-vs-assigned polish on each baseline...');
  for (const baseline of baselineResults) {
    const polished = polishIdleVsAssigned(tasks, participants, baseline.assignments, config);
    const ctx = buildScoreCtx(tasks, participants);
    const newScore = computeScheduleScore(tasks, participants, polished.assignments, config, ctx).compositeScore;
    // Validate: ensure polish never introduces NEW HC violations beyond what
    // the baseline already had. The baseline carries HC-6 violations for
    // unfilled slots; we only care about violations the polish CREATES.
    const baselineViolations = validateHardConstraints(tasks, participants, baseline.assignments).violations;
    const polishedViolations = validateHardConstraints(tasks, participants, polished.assignments).violations;
    const baselineCodeMix = baselineViolations
      .map((v) => v.code)
      .sort()
      .join('|');
    const polishedCodeMix = polishedViolations
      .map((v) => v.code)
      .sort()
      .join('|');
    const codeChange = baselineCodeMix !== polishedCodeMix;
    const newViolations = polishedViolations.length - baselineViolations.length;
    polishResults.push({
      delta: newScore - baseline.score.compositeScore,
      replacements: polished.replacements,
      ms: polished.durationMs,
      finalScore: newScore,
      violations: Math.max(0, newViolations) + (codeChange && newViolations === 0 ? 1 : 0),
    });
    process.stdout.write('.');
  }
  console.log('');
  const polishViolationsTotal = polishResults.reduce((s, p) => s + p.violations, 0);

  const groupChoice = analyseGroupChoiceVariance(baselineResults, tasks, participants);
  const groupSpreads = groupChoice.map((g) => g.spreadScore).filter((s) => s > 0);
  const groupCount = groupChoice.length;
  const unused = groupChoice.filter((g) => {
    // For tasks with multiple feasible groups: how many groups are NEVER picked?
    return g.groupAvgScores.size === 1; // only one group ever chosen
  }).length;

  const r: ExperimentResult = {
    name,
    baselineMean: mean(baselineScores),
    baselineStd: stddev(baselineScores),
    baselineMinUnfilled: Math.min(...baselineUnfilled),
    baselineMeanUnfilled: mean(baselineUnfilled),
    baselineLowPrioMean: mean(baselineLowPrios),
    baselineMeanRuntimeMs: mean(baselineRuntimes),
    withPolishMean: mean(polishResults.map((p) => p.finalScore)),
    withPolishImprovementMean: mean(polishResults.map((p) => p.delta)),
    withPolishImprovementMax: Math.max(...polishResults.map((p) => p.delta), 0),
    withPolishReplacementsMean: mean(polishResults.map((p) => p.replacements)),
    withPolishMeanRuntimeMs: mean(polishResults.map((p) => p.ms)),
    groupChoiceMaxSpread: groupSpreads.length > 0 ? Math.max(...groupSpreads) : 0,
    groupChoiceTaskCount: groupCount,
    groupChoiceUnusedGroupTasks: unused,
    polishHcViolationsTotal: polishViolationsTotal,
  };

  console.log(`\n  ── Baseline ──`);
  console.log(`    score:       mean ${fmt(r.baselineMean)}  std ${fmt(r.baselineStd)}`);
  console.log(`    unfilled:    mean ${fmt(r.baselineMeanUnfilled)}  min ${r.baselineMinUnfilled}`);
  console.log(`    lowPrio:     mean ${fmt(r.baselineLowPrioMean)}`);
  console.log(`    runtime:     mean ${fmt(r.baselineMeanRuntimeMs)} ms`);
  console.log(`  ── Proposal B (idle-polish) ──`);
  console.log(`    final score: mean ${fmt(r.withPolishMean)}`);
  console.log(`    delta:       mean ${fmt(r.withPolishImprovementMean)}  max ${fmt(r.withPolishImprovementMax)}`);
  console.log(`    replacements: mean ${fmt(r.withPolishReplacementsMean)}`);
  console.log(`    runtime:     mean ${fmt(r.withPolishMeanRuntimeMs)} ms`);
  console.log(`    HC violations introduced by polish: ${r.polishHcViolationsTotal}`);
  console.log(`  ── Proposal A (group-choice analysis) ──`);
  console.log(`    same-group tasks: ${r.groupChoiceTaskCount}`);
  console.log(`    tasks where one group dominated (others never chosen): ${r.groupChoiceUnusedGroupTasks}`);
  console.log(`    max group avg-score spread (best vs worst group): ${fmt(r.groupChoiceMaxSpread)}`);

  return r;
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BENCH — optimizer proposal evaluation                       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const NUM_RUNS = parseInt(process.env.BENCH_RUNS ?? '8', 10);
  const ATTEMPTS_PER_RUN = parseInt(process.env.BENCH_ATTEMPTS ?? '30', 10);
  console.log(`Config: ${NUM_RUNS} runs × ${ATTEMPTS_PER_RUN} attempts each`);

  // 1. Realistic 7-day garden schedule (production-like)
  const realistic = {
    participants: buildBalancedParticipants(),
    tasks: generateWeeklyTasks(new Date(2026, 1, 16), 7),
  };

  // 2. Adversarial Trap 2 (group choice matters)
  const trap2 = buildTrap2Adversarial();

  // 3. Adversarial Trap 1 (idle-eligible could replace assigned)
  const trap1 = buildTrap1Adversarial();

  const results: ExperimentResult[] = [];
  results.push(runExperiment('Realistic 7-day', realistic.participants, realistic.tasks, NUM_RUNS, ATTEMPTS_PER_RUN));
  results.push(runExperiment('Trap-2 group-choice', trap2.participants, trap2.tasks, NUM_RUNS, ATTEMPTS_PER_RUN));
  results.push(runExperiment('Trap-1 idle-vs-assigned', trap1.participants, trap1.tasks, NUM_RUNS, ATTEMPTS_PER_RUN));

  console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   SUMMARY                                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(
    'Scenario'.padEnd(28) +
      'Δ_polish_mean'.padEnd(18) +
      'Δ_polish_max'.padEnd(18) +
      'reps_mean'.padEnd(12) +
      'group_spread'.padEnd(14) +
      'rt_mean_ms',
  );
  console.log('─'.repeat(110));
  for (const r of results) {
    console.log(
      r.name.padEnd(28) +
        fmt(r.withPolishImprovementMean).padEnd(18) +
        fmt(r.withPolishImprovementMax).padEnd(18) +
        fmt(r.withPolishReplacementsMean).padEnd(12) +
        fmt(r.groupChoiceMaxSpread).padEnd(14) +
        fmt(r.withPolishMeanRuntimeMs),
    );
  }
})();
