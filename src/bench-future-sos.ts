/**
 * Benchmark — generateBatchRescuePlans at realistic scale.
 *
 * Goal: measure the wall-clock cost of Future SOS batch rescue on a 7-day
 * schedule with ~30 participants, across varying K (affected slots) and
 * candidate caps. Establish whether the audit's "performance concern"
 * (issue #4) manifests in practice before considering any optimisation.
 *
 * Usage: npx ts-node src/bench-future-sos.ts
 */

import { generateBatchRescuePlans } from './engine/future-sos';
import { optimize } from './engine/optimizer';
import { computeScheduleScore, type ScoreContext } from './constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Schedule,
  type Task,
} from './models/types';
import { generateDailyTasks } from './tasks/cli-task-factory';
import { computeAllCapacities } from './utils/capacity';

// ─── Fixture ────────────────────────────────────────────────────────────────

const BASE_DATE = new Date(2026, 1, 15); // Feb 15, 2026

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

/** Three groups of 10 = 30 participants (realistic garden-team size). */
function buildParticipants(): Participant[] {
  const out: Participant[] = [];
  for (const g of ['Alpha', 'Beta', 'Gamma'] as const) {
    const prefix = g.slice(0, 1).toLowerCase();
    for (let i = 1; i <= 10; i++) {
      // Level distribution: 7× L0, 1× L2, 1× L3, 1× L4 per group.
      const level = i <= 7 ? Level.L0 : i === 8 ? Level.L2 : i === 9 ? Level.L3 : Level.L4;
      // Cert mix so the optimizer has flexibility.
      const certs: string[] = [];
      if (i % 2 === 0) certs.push('Nitzan');
      if (i % 3 === 0) certs.push('Salsala');
      if (i % 5 === 0) certs.push('Hamama');
      if (i % 4 === 0) certs.push('Horesh');
      out.push(p(`${prefix}${i}`, `${g}-${i.toString().padStart(2, '0')}`, level, certs, g));
    }
  }
  return out;
}

/** 7 daily task packs. */
function buildSevenDayTasks(): Task[] {
  const all: Task[] = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(BASE_DATE.getFullYear(), BASE_DATE.getMonth(), BASE_DATE.getDate() + d);
    // Only reset the id counters on the first day so all tasks end up in a
    // single flat, collision-free list.
    all.push(...generateDailyTasks(day, d === 0));
  }
  return all;
}

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

interface BenchRow {
  k: number;
  participants: number;
  tasks: number;
  assignments: number;
  capsLabel: string;
  totalMs: number;
  plans: number;
  infeasible: number;
  timedOut: boolean;
  topDelta: number | null;
}

function printTable(rows: BenchRow[]): void {
  const headers = ['K', 'Caps', 'Plans', 'Infeas', 'TimedOut', 'TopΔ', 'Wall'];
  const widths = [3, 14, 6, 7, 9, 10, 10];
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('│ ');
  console.log(headerLine);
  console.log('─'.repeat(headerLine.length));
  for (const r of rows) {
    const row = [
      String(r.k).padEnd(widths[0]),
      r.capsLabel.padEnd(widths[1]),
      String(r.plans).padEnd(widths[2]),
      String(r.infeasible).padEnd(widths[3]),
      (r.timedOut ? 'yes' : 'no').padEnd(widths[4]),
      (r.topDelta !== null ? r.topDelta.toFixed(1) : '—').padEnd(widths[5]),
      fmtMs(r.totalMs).padEnd(widths[6]),
    ].join('│ ');
    console.log(row);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BENCH — generateBatchRescuePlans @ realistic scale          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const participants = buildParticipants();
  const tasks = buildSevenDayTasks();

  console.log(`\nFixture: ${participants.length} participants × ${tasks.length} tasks (7 days)`);

  // Generate a full schedule via the real optimizer so the baseline has the
  // kind of assignment density the feature will see in production.
  console.log('Generating baseline schedule (optimizer, 1 attempt)...');
  const optStart = Date.now();
  const result = optimize(tasks, participants, { ...DEFAULT_CONFIG, maxSolverTimeMs: 15000 }, [], undefined, 0);
  const optMs = Date.now() - optStart;
  console.log(`  Baseline: ${result.assignments.length} assignments, ${fmtMs(optMs)}`);

  const schedule: Schedule = {
    id: 'bench',
    tasks,
    participants,
    assignments: result.assignments,
    feasible: result.feasible,
    score: result.score,
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5 },
    periodStart: new Date(2025, 0, 1),
    periodDays: 7,
    restRuleSnapshot: {},
    sleepRecoverySnapshot: {},
    certLabelSnapshot: {},
  };
  const scoreCtx = buildScoreCtx(tasks, participants);

  // Raw cost of one full-composite score (the inner loop cost driver).
  const scoreIters = 20;
  const sStart = Date.now();
  for (let i = 0; i < scoreIters; i++) {
    computeScheduleScore(tasks, participants, schedule.assignments, DEFAULT_CONFIG, scoreCtx);
  }
  const perScoreMs = (Date.now() - sStart) / scoreIters;
  console.log(`  computeScheduleScore: ${fmtMs(perScoreMs)} / call (avg of ${scoreIters})`);

  // Pick a participant with lots of assignments to maximise K.
  const byPid = new Map<string, number>();
  for (const a of schedule.assignments) byPid.set(a.participantId, (byPid.get(a.participantId) ?? 0) + 1);
  // Prefer an L0 with the most common cert ('Nitzan') — more slots they can
  // be swapped into, fewer infeasibles, exercises depth-2/3 more.
  const isEasyFocal = (pid: string) => {
    const pp = participants.find((pp) => pp.id === pid);
    return pp !== undefined && pp.level === Level.L0 && pp.certifications.includes('Nitzan');
  };
  const sortedByLoad = [...byPid.entries()].sort((a, b) => b[1] - a[1]);
  const easyEntry = sortedByLoad.find(([pid]) => isEasyFocal(pid));
  const chosen = easyEntry ?? sortedByLoad[0];
  const focalId = chosen[0];
  const focalCount = chosen[1];
  const focalP = participants.find((pp) => pp.id === focalId)!;
  console.log(
    `  Focal: ${focalId} (${focalP.name}, L${focalP.level}, certs=[${focalP.certifications.join(',')}]) holds ${focalCount} assignments over 7 days\n`,
  );

  // Build increasing windows — day 2 only, day 2-3, day 2-4, …  — to sweep K.
  const anchor = new Date(2026, 1, 14); // Anchor before schedule → every task is future
  const windows: Array<{ label: string; start: Date; end: Date }> = [];
  for (let days = 1; days <= 6; days++) {
    const start = new Date(BASE_DATE.getFullYear(), BASE_DATE.getMonth(), BASE_DATE.getDate() + 1, 0);
    const end = new Date(BASE_DATE.getFullYear(), BASE_DATE.getMonth(), BASE_DATE.getDate() + 1 + days, 0);
    windows.push({ label: `day 2…${days + 1}`, start, end });
  }

  const capsList: Array<{ label: string; caps: { depth1: number; depth2: number; depth3: number } }> = [
    { label: 'default', caps: { depth1: 6, depth2: 4, depth3: 2 } },
    { label: 'wide', caps: { depth1: 10, depth2: 8, depth3: 4 } },
  ];

  const rows: BenchRow[] = [];

  for (const win of windows) {
    for (const capCfg of capsList) {
      const t0 = Date.now();
      const res = generateBatchRescuePlans(
        schedule,
        { participantId: focalId, window: { start: win.start, end: win.end } },
        anchor,
        { config: DEFAULT_CONFIG, scoreCtx, maxPlans: 3, caps: capCfg.caps },
      );
      const totalMs = Date.now() - t0;
      rows.push({
        k: res.affected.length,
        participants: participants.length,
        tasks: tasks.length,
        assignments: schedule.assignments.length,
        capsLabel: `${capCfg.label} {${capCfg.caps.depth1},${capCfg.caps.depth2},${capCfg.caps.depth3}}`,
        totalMs,
        plans: res.plans.length,
        infeasible: res.infeasibleAssignmentIds.length,
        timedOut: res.timedOut,
        topDelta: res.plans[0]?.compositeDelta ?? null,
      });
    }
  }

  console.log('\nResults (K = number of affected in-window assignments):\n');
  printTable(rows);

  // Also measure with a budget-constrained run vs unbounded to see how the
  // time cap interacts with the DFS.
  console.log('\nBudget sweep (K = largest):\n');
  const largest = rows[rows.length - 1].k > 0 ? windows[windows.length - 1] : windows[0];
  const budgets = [100, 250, 500, 1000, 3000];
  const budgetRows: BenchRow[] = [];
  for (const budget of budgets) {
    const t0 = Date.now();
    const res = generateBatchRescuePlans(
      schedule,
      { participantId: focalId, window: { start: largest.start, end: largest.end } },
      anchor,
      {
        config: DEFAULT_CONFIG,
        scoreCtx,
        maxPlans: 3,
        caps: { depth1: 6, depth2: 4, depth3: 2 },
        timeBudgetMs: budget,
      },
    );
    const totalMs = Date.now() - t0;
    budgetRows.push({
      k: res.affected.length,
      participants: participants.length,
      tasks: tasks.length,
      assignments: schedule.assignments.length,
      capsLabel: `budget=${budget}ms`,
      totalMs,
      plans: res.plans.length,
      infeasible: res.infeasibleAssignmentIds.length,
      timedOut: res.timedOut,
      topDelta: res.plans[0]?.compositeDelta ?? null,
    });
  }
  printTable(budgetRows);

  // ── Slack fixture — everyone has every cert & L0 → maximum candidate fan-out.
  //    This is the worst case for per-candidate full-composite scoring.
  console.log('\n── Slack fixture (30 all-cert L0 participants, exercises depth-2/3) ──');
  const slackParticipants: Participant[] = [];
  for (let i = 1; i <= 30; i++) {
    slackParticipants.push(
      p(`sl${i}`, `Slack-${i.toString().padStart(2, '0')}`, Level.L0, ['Nitzan', 'Salsala', 'Hamama', 'Horesh'], 'Slk'),
    );
  }
  const slackResult = optimize(
    tasks,
    slackParticipants,
    { ...DEFAULT_CONFIG, maxSolverTimeMs: 15000 },
    [],
    undefined,
    0,
  );
  console.log(`  Baseline: ${slackResult.assignments.length} assignments`);

  const slackSchedule: Schedule = {
    id: 'bench-slack',
    tasks,
    participants: slackParticipants,
    assignments: slackResult.assignments,
    feasible: slackResult.feasible,
    score: slackResult.score,
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5 },
    periodStart: new Date(2025, 0, 1),
    periodDays: 7,
    restRuleSnapshot: {},
    sleepRecoverySnapshot: {},
    certLabelSnapshot: {},
  };
  const slackCtx = buildScoreCtx(tasks, slackParticipants);

  const slackByPid = new Map<string, number>();
  for (const a of slackSchedule.assignments) slackByPid.set(a.participantId, (slackByPid.get(a.participantId) ?? 0) + 1);
  const slackFocal = [...slackByPid.entries()].sort((a, b) => b[1] - a[1])[0];
  console.log(`  Focal: ${slackFocal[0]} holds ${slackFocal[1]} assignments\n`);

  const slackRows: BenchRow[] = [];
  for (const win of windows) {
    for (const capCfg of capsList) {
      const t0 = Date.now();
      const res = generateBatchRescuePlans(
        slackSchedule,
        { participantId: slackFocal[0], window: { start: win.start, end: win.end } },
        anchor,
        { config: DEFAULT_CONFIG, scoreCtx: slackCtx, maxPlans: 3, caps: capCfg.caps },
      );
      const totalMs = Date.now() - t0;
      slackRows.push({
        k: res.affected.length,
        participants: slackParticipants.length,
        tasks: tasks.length,
        assignments: slackSchedule.assignments.length,
        capsLabel: `${capCfg.label} {${capCfg.caps.depth1},${capCfg.caps.depth2},${capCfg.caps.depth3}}`,
        totalMs,
        plans: res.plans.length,
        infeasible: res.infeasibleAssignmentIds.length,
        timedOut: res.timedOut,
        topDelta: res.plans[0]?.compositeDelta ?? null,
      });
    }
  }
  printTable(slackRows);

  console.log('\nDone.');
})();
