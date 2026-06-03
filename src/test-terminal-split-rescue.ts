/**
 * Terminal chain-internal split (Rescue feasibility fallback) tests.
 *
 * Covers the depth-2 terminal-split rung in `generateRescuePlans`: when pure
 * chains (depth 1..4) + seed-slot split all fail, a chain `[V←p]` whose
 * terminal displaced donor `T` is backfilled by a SPLIT can rescue the slot.
 *
 * Scenario (the adversarial control proven by src/measure-terminal-split.ts):
 *   V and T overlap 08:00–12:00. Only pStar (cv+ck) can take V besides the
 *   departing pGone, so pStar must vacate T; T (splittable, ck-gated) has no
 *   single whole-availability ck-holder (aHalf=08–10, bHalf=10–12) — only a
 *   terminal split fills it.
 *
 * Group A (pure src/, no src/web import). Wired into `npm test` via
 * `runTerminalSplitRescueTests`. Standalone: `npx ts-node src/test-terminal-split-rescue.ts`.
 */

import { validateHardConstraints } from './constraints/hard-constraints';
import type { ScoreContext } from './constraints/soft-constraints';
import { generateRescuePlans } from './engine/rescue';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type RescuePlan,
  type Schedule,
  type SchedulerConfig,
  type ScheduleScore,
  SchedulingEngine,
  type SlotRequirement,
  type Task,
} from './index';
import { computeAllCapacities } from './utils/capacity';

type AssertFn = (condition: boolean, name: string) => void;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const base = new Date(2026, 5, 1); // 2026-06-01 (op-day 1)
const earlyAnchor = new Date(2026, 4, 20); // before period → all tasks future
const wideAvail = [{ start: new Date(2026, 4, 28), end: new Date(2026, 5, 12) }];
const D = (h: number) => new Date(2026, 5, 1, h, 0, 0, 0);

const dummyScore: ScheduleScore = {
  minRestHours: 0,
  avgRestHours: 0,
  workloadStdDev: 0,
  totalPenalty: 0,
  compositeScore: 0,
  l0StdDev: 0,
  l0AvgEffective: 0,
  seniorStdDev: 0,
  seniorAvgEffective: 0,
  dailyPerParticipantStdDev: 0,
  dailyGlobalStdDev: 0,
  restPerGapBonus: 0,
};

function mkP(id: string, certs: string[], level: Level, availability: { start: Date; end: Date }[]): Participant {
  return { id, name: id, level, certifications: certs, group: 'G', availability, dateUnavailability: [] };
}

function slot(id: string, certs: string[]): SlotRequirement {
  return {
    slotId: id,
    acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }],
    requiredCertifications: certs,
    label: id,
  };
}

function mkTask(id: string, certs: string[], splittable: boolean, sameGroupRequired = false): Task {
  return {
    id,
    name: id,
    timeBlock: { start: D(8), end: D(12) },
    requiredCount: 1,
    slots: [slot(`${id}-s1`, certs)],
    sameGroupRequired,
    blocksConsecutive: false,
    splittable,
  };
}

function mkSchedule(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  splittingMode: 'off' | 'feasibility' | 'quality' = 'quality',
): Schedule {
  return {
    id: 'ts-sched',
    tasks,
    participants,
    assignments,
    feasible: true,
    score: { ...dummyScore },
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5, splittingMode },
    periodStart: base,
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
  };
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
    pMap: new Map(participants.map((p) => [p.id, p])),
    capacities: computeAllCapacities(participants, s, e, 5),
    notWithPairs: new Map(),
    dayStartHour: 5,
  };
}

interface Scenario {
  schedule: Schedule;
  scoreCtx: ScoreContext;
  config: SchedulerConfig;
  participants: Participant[];
  tasks: Task[];
}

/** The control scenario. `donorSplittable`/`donorSameGroup` flex the donor T. */
function buildScenario(opts: {
  donorSplittable: boolean;
  donorSameGroup?: boolean;
  splittingMode?: 'off' | 'feasibility' | 'quality';
}): Scenario {
  const pStar = mkP('pStar', ['cv', 'ck'], Level.L3, wideAvail);
  const pGone = mkP('pGone', ['cv'], Level.L3, wideAvail);
  const aHalf = mkP('aHalf', ['ck'], Level.L2, [{ start: D(8), end: D(10) }]);
  const bHalf = mkP('bHalf', ['ck'], Level.L2, [{ start: D(10), end: D(12) }]);
  const participants = [pStar, pGone, aHalf, bHalf];

  const T = mkTask('T', ['ck'], opts.donorSplittable, opts.donorSameGroup ?? false);
  const V = mkTask('V', ['cv'], false); // V itself is NOT splittable → forces the chain route
  const tasks = [T, V];

  const now = new Date();
  const assignments: Assignment[] = [
    {
      id: 'asg-T',
      taskId: 'T',
      slotId: 'T-s1',
      participantId: 'pStar',
      status: AssignmentStatus.Manual,
      updatedAt: now,
    },
    {
      id: 'asg-V',
      taskId: 'V',
      slotId: 'V-s1',
      participantId: 'pGone',
      status: AssignmentStatus.Manual,
      updatedAt: now,
    },
  ];

  const schedule = mkSchedule(tasks, participants, assignments, opts.splittingMode ?? 'quality');
  return { schedule, scoreCtx: buildScoreCtx(tasks, participants), config: { ...DEFAULT_CONFIG }, participants, tasks };
}

function rescueV(sc: Scenario): RescuePlan[] {
  const res = generateRescuePlans(
    sc.schedule,
    { vacatedAssignmentId: 'asg-V', taskId: 'V', slotId: 'V-s1', vacatedBy: 'pGone' },
    earlyAnchor,
    0,
    5,
    undefined,
    undefined,
    5,
    (id) => id,
    sc.config,
    sc.scoreCtx,
    undefined,
  );
  return res.plans;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function runShapeUnlock(assert: AssertFn): void {
  const sc = buildScenario({ donorSplittable: true });
  const plans = rescueV(sc);
  const terminal = plans.find((p) => p.terminalSplit === true);

  assert(terminal !== undefined, 'unlock: a terminal-split plan is surfaced when pure rescue fails');
  if (!terminal) return;
  assert(terminal.swaps.length === 1, 'unlock: terminal plan carries exactly one chain swap (V←p)');
  assert((terminal.splitOps?.length ?? 0) === 1, 'unlock: terminal plan carries exactly one splitOp');
  assert(terminal.swaps[0]?.toParticipantId === 'pStar', 'unlock: the chain moves pStar into V');
  const op = terminal.splitOps?.[0];
  assert(op?.taskId === 'T', 'unlock: the split targets the displaced donor T');
  assert(
    op !== undefined && op.fillA.participantId !== op.fillB.participantId,
    'unlock: the two half-fillers are different people (HC-16)',
  );
  const fillers = op ? new Set([op.fillA.participantId, op.fillB.participantId]) : new Set();
  assert(fillers.has('aHalf') && fillers.has('bHalf'), 'unlock: the halves are filled by aHalf + bHalf');
  // Disjoint-id safety basis.
  assert(op?.originalAssignmentId === 'asg-T', 'unlock: split targets the donor assignment (disjoint from the V swap)');
  assert(terminal.swaps[0]?.assignmentId === 'asg-V', 'unlock: the swap targets the vacated V assignment');
}

function runLoadBearingOff(assert: AssertFn): void {
  // With splitting OFF, neither seed-split nor the terminal fallback may fire,
  // and pure rescue genuinely has no plan → 0 plans (proves the split is the
  // load-bearing element, not cosmetic).
  const sc = buildScenario({ donorSplittable: true, splittingMode: 'off' });
  const plans = rescueV(sc);
  assert(plans.length === 0, 'load-bearing: splittingMode=off ⇒ zero rescue plans (no terminal split)');
}

function runNegativeNonSplittable(assert: AssertFn): void {
  const sc = buildScenario({ donorSplittable: false });
  const plans = rescueV(sc);
  assert(
    !plans.some((p) => p.terminalSplit === true),
    'negative: a non-splittable donor produces no terminal-split plan',
  );
  assert(plans.length === 0, 'negative: non-splittable donor ⇒ no rescue plan at all');
}

function runNegativeSameGroup(assert: AssertFn): void {
  const sc = buildScenario({ donorSplittable: true, donorSameGroup: true });
  const plans = rescueV(sc);
  assert(
    !plans.some((p) => p.terminalSplit === true),
    'negative: a sameGroupRequired donor is excluded from terminal-split (v1 scope)',
  );
}

function runApplyParity(assert: AssertFn): void {
  const sc = buildScenario({ donorSplittable: true });
  const terminal = rescueV(sc).find((p) => p.terminalSplit === true);
  assert(terminal !== undefined, 'apply: a terminal plan exists to apply');
  if (!terminal) return;

  // Load the same hand-built state into an engine and apply through the real
  // commit path. A surfaced plan MUST apply (no surfaced-but-unappliable).
  const eng = new SchedulingEngine({ ...DEFAULT_CONFIG }, undefined, undefined, 5, 'quality');
  eng.addParticipants(sc.participants);
  eng.addTasks(sc.tasks);
  eng.importSchedule(
    mkSchedule(
      sc.tasks,
      sc.participants,
      sc.schedule.assignments.map((a) => ({ ...a })),
    ),
  );

  const res = eng.applyPlanOps({
    swaps: terminal.swaps.map((s) => ({ assignmentId: s.assignmentId, newParticipantId: s.toParticipantId })),
    splitOps: terminal.splitOps,
  });
  assert(res.valid === true, 'apply: the surfaced terminal plan applies via engine.applyPlanOps (valid)');

  const after = eng.getSchedule();
  assert(after !== null, 'apply: engine has a schedule after apply');
  if (!after) return;
  // Independent HC re-check on the realized state (never trust plan.violations).
  const val = validateHardConstraints(after.tasks, after.participants, after.assignments, undefined, undefined);
  const realViolations = val.violations.filter((v) => v.code !== 'SLOT_UNFILLED' && v.code !== 'GROUP_INSUFFICIENT');
  assert(realViolations.length === 0, 'apply: realized state has no hard-constraint violations (independent validate)');

  // The donor T is now realized as two halves filled by the two people.
  const halfA = after.assignments.find((a) => a.id === 'asg-T#a');
  const halfB = after.assignments.find((a) => a.id === 'asg-T#b');
  assert(halfA !== undefined && halfB !== undefined, 'apply: donor split realized as #a/#b assignments');
  assert(
    after.assignments.find((a) => a.id === 'asg-V')?.participantId === 'pStar',
    'apply: pStar now holds the rescued V slot',
  );
  assert(
    after.assignments.find((a) => a.id === 'asg-T') === undefined,
    'apply: the original whole donor assignment was removed (replaced by halves)',
  );
}

function runZeroRegressionNormalSlot(assert: AssertFn): void {
  // A normally-rescuable slot: an idle eligible person exists → depth-1 plan,
  // and NO terminal-split plan (the fallback is never reached).
  const pA = mkP('pA', ['cv'], Level.L3, wideAvail);
  const pIdle = mkP('pIdle', ['cv'], Level.L3, wideAvail); // idle, eligible for V
  const filler = mkP('filler', ['ck'], Level.L2, wideAvail);
  const participants = [pA, pIdle, filler];
  const T = mkTask('T', ['ck'], true);
  const V = mkTask('V', ['cv'], false);
  const tasks = [T, V];
  const now = new Date();
  const assignments: Assignment[] = [
    {
      id: 'asg-T',
      taskId: 'T',
      slotId: 'T-s1',
      participantId: 'filler',
      status: AssignmentStatus.Manual,
      updatedAt: now,
    },
    { id: 'asg-V', taskId: 'V', slotId: 'V-s1', participantId: 'pA', status: AssignmentStatus.Manual, updatedAt: now },
  ];
  const schedule = mkSchedule(tasks, participants, assignments);
  const res = generateRescuePlans(
    schedule,
    { vacatedAssignmentId: 'asg-V', taskId: 'V', slotId: 'V-s1', vacatedBy: 'pA' },
    earlyAnchor,
    0,
    5,
    undefined,
    undefined,
    5,
    (id) => id,
    { ...DEFAULT_CONFIG },
    buildScoreCtx(tasks, participants),
    undefined,
  );
  assert(res.plans.length > 0, 'zero-regression: a normally-rescuable slot still yields pure plans');
  assert(
    !res.plans.some((p) => p.terminalSplit === true),
    'zero-regression: no terminal-split plan when pure rescue already succeeds',
  );
}

export async function runTerminalSplitRescueTests(assert: AssertFn): Promise<void> {
  console.log('\n── Terminal-split rescue: shape unlock ──');
  runShapeUnlock(assert);
  console.log('── Terminal-split rescue: load-bearing (off ⇒ 0 plans) ──');
  runLoadBearingOff(assert);
  console.log('── Terminal-split rescue: negative — non-splittable donor ──');
  runNegativeNonSplittable(assert);
  console.log('── Terminal-split rescue: negative — same-group donor excluded ──');
  runNegativeSameGroup(assert);
  console.log('── Terminal-split rescue: validate-vs-apply parity + HC ──');
  runApplyParity(assert);
  console.log('── Terminal-split rescue: zero-regression on a normal slot ──');
  runZeroRegressionNormalSlot(assert);
}

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const assert: AssertFn = (cond, name) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ FAIL: ${name}`);
    }
  };
  runTerminalSplitRescueTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
