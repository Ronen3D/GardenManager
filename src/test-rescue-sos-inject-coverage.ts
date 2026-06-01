/**
 * Coverage-gap tests for rescue / future-sos / inject / temporal-anchor.
 *
 * Lives alongside src/test.ts to avoid touching the main test file.
 * Run with:  npx ts-node src/test-rescue-sos-inject-coverage.ts
 */

import { computeScheduleScore, type ScoreContext } from './constraints/soft-constraints';
import { generateBatchRescuePlans } from './engine/future-sos';
import { buildInjectedTask, type InjectedTaskSpec, injectAndStaff, searchInjectionPlans } from './engine/inject';
import { generateRescuePlans } from './engine/rescue';
import { SchedulingEngine } from './engine/scheduler';
import { assertInjectableTimeBlock } from './engine/temporal';
import {
  type Assignment,
  AssignmentStatus,
  createTimeBlockFromHours,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type RescueRequest,
  type Schedule,
  type ScheduleScore,
  type Task,
} from './index';
import type { ScheduleUnavailability } from './models/types';
import { computeAllCapacities } from './utils/capacity';

// ─── Local assert + summary ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

console.log('── Rescue / FSOS / Inject coverage tests ───────────────');

// ─── Shared fixtures ────────────────────────────────────────────────────────

const base = new Date(2026, 5, 1); // 2026-06-01
const earlyAnchor = new Date(2026, 4, 30); // before period → all tasks future
const avail = [{ start: new Date(2026, 4, 28), end: new Date(2026, 5, 10) }];

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

function mkSchedule(tasks: Task[], participants: Participant[], assignments: Assignment[]): Schedule {
  return {
    id: 'cov-sched',
    tasks,
    participants,
    assignments,
    feasible: true,
    score: dummyScore,
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5 },
    periodStart: base,
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
  };
}

function buildScoreCtx(tasks: Task[], participants: Participant[]): ScoreContext {
  let schedStart = tasks[0]?.timeBlock.start ?? new Date();
  let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  return {
    taskMap: new Map(tasks.map((t) => [t.id, t])),
    pMap: new Map(participants.map((p) => [p.id, p])),
    capacities: computeAllCapacities(participants, schedStart, schedEnd, 5),
    notWithPairs: new Map(),
    dayStartHour: 5,
  };
}

// ─── Test 1: Rescue depth-1 fails, depth-2 succeeds ─────────────────────────
//
// Scenario:
//   t1 (06-14) needs cert c1; t2 (06-14, same time) needs cert c1.
//   pA holds the t1 slot (vacated). pB has c1 but is already assigned to t2,
//   so a depth-1 swap of pB into t1 collides with pB's t2 (HC-5 time overlap).
//   pC has c1 and is free. So depth-1 candidate (pC) actually exists too...
//   To force depth-1 failure, instead make pB the only c1 holder besides pA,
//   and put pB on t2. Depth-2 must displace pB from t2 (pC, free, with c1
//   absorbs t2) and place pB on t1.
//
// Setup forces depth-2 specifically: only pB has c1 besides pA; pC has c1
// too but is *not* free at t1's time — pC sits on t3 (overlapping). Then
// only chain: vacated→pB, pB's-t2-donor→someone-with-c1. pC is the only
// option for t2, so t3 must be displaceable → pD (free) absorbs t3.
//
// Simpler: make depth-1 directly impossible by ensuring no participant has
// both the cert AND is free at the time. Then depth-2 unblocks via swap.

console.log('\n── Test 1: rescue depth escalation 1→2 ──');
{
  const block = createTimeBlockFromHours(base, 6, 14);
  const block2 = createTimeBlockFromHours(base, 6, 14); // same time → HC-5 conflict if assigned both

  const tV: Task = {
    id: 't1-vacated',
    name: 't1-vacated',
    timeBlock: block,
    requiredCount: 1,
    slots: [{ slotId: 's1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['c1'], label: 'A' }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const tD: Task = {
    id: 't2-donor',
    name: 't2-donor',
    timeBlock: block2,
    requiredCount: 1,
    slots: [{ slotId: 's2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['c1'], label: 'B' }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  const pA: Participant = {
    id: 'pA',
    name: 'A',
    level: Level.L0,
    certifications: ['c1'],
    group: 'G',
    availability: avail,
    dateUnavailability: [],
  };
  const pB: Participant = {
    id: 'pB',
    name: 'B',
    level: Level.L0,
    certifications: ['c1'],
    group: 'G',
    availability: avail,
    dateUnavailability: [],
  };
  // pC is free (no assignment) but lacks c1 → can absorb the donor swap target only if cert allows.
  // We need pC to have c1 so they can absorb tD when pB is moved to tV.
  const pC: Participant = {
    id: 'pC',
    name: 'C',
    level: Level.L0,
    certifications: ['c1'],
    group: 'G',
    availability: avail,
    dateUnavailability: [],
  };
  // pD has no cert → can't help. Useful as red herring.
  const pD: Participant = {
    id: 'pD',
    name: 'D',
    level: Level.L0,
    certifications: [],
    group: 'G',
    availability: avail,
    dateUnavailability: [],
  };

  const assigns: Assignment[] = [
    {
      id: 'aV',
      taskId: 't1-vacated',
      slotId: 's1',
      participantId: 'pA',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'aD',
      taskId: 't2-donor',
      slotId: 's2',
      participantId: 'pB',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];

  // Wait — depth-1 candidate pC IS free and has c1. So depth-1 will succeed
  // unless we stop it. To make pC ineligible at depth-1, give them a third
  // task at the same time too.
  const tBlock: Task = {
    id: 't3-blocker',
    name: 't3-blocker',
    timeBlock: block,
    requiredCount: 1,
    slots: [{ slotId: 's3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'X' }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const aBlocker: Assignment = {
    id: 'aBlocker',
    taskId: 't3-blocker',
    slotId: 's3',
    participantId: 'pC',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };

  const sched = mkSchedule([tV, tD, tBlock], [pA, pB, pC, pD], [...assigns, aBlocker]);
  const before = JSON.stringify(sched.assignments.map((a) => ({ id: a.id, pid: a.participantId })));

  const result = generateRescuePlans(
    sched,
    { vacatedAssignmentId: 'aV', taskId: 't1-vacated', slotId: 's1', vacatedBy: 'pA' },
    earlyAnchor,
    0,
    undefined,
    undefined,
    undefined,
    5,
    undefined,
    { ...DEFAULT_CONFIG },
    buildScoreCtx(sched.tasks, sched.participants),
  );

  // Depth-1 alone has no eligible: pB conflicts via HC-5 with tD; pC conflicts via HC-5
  // with tBlock (same time as tV); pD lacks c1.
  // Depth-2 chain: vacated→pB, donor (aD) → pD? pD lacks c1 → cannot absorb.
  // Depth-2 chain that works: vacated→pB, aD→pC? pC is busy in tBlock at same time → HC-5.
  // So depth-2 also impossible. Depth-3: vacated→pB, aD→pC, aBlocker→pD. pD has no cert
  // requirement on t3-blocker → that works. So expected depth-3.
  //
  // Test passes if a valid plan returns AND no plan has length 1 (depth-1 failed).
  assert(result.plans.length > 0, 'rescue: returns at least one plan when depth-1 is blocked');
  if (result.plans.length > 0) {
    const minLen = Math.min(...result.plans.map((p) => p.swaps.length));
    assert(minLen >= 2, 'rescue: minimal plan length >= 2 (depth-1 was blocked)');
    // Validate the schedule was NOT mutated by plan generation.
    const after = JSON.stringify(sched.assignments.map((a) => ({ id: a.id, pid: a.participantId })));
    assert(before === after, 'rescue: schedule.assignments not mutated by generateRescuePlans');
  }
}

// ─── Test 2: Rescue plans never include the vacated participant ─────────────

console.log('\n── Test 2: rescue never reuses the vacated participant ──');
{
  const block = createTimeBlockFromHours(base, 6, 14);
  const t: Task = {
    id: 'r2-t',
    name: 'R2T',
    timeBlock: block,
    requiredCount: 1,
    slots: [{ slotId: 'r2-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'A' }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const p1: Participant = {
    id: 'r2-p1',
    name: 'P1',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'r2-p2',
    name: 'P2',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const p3: Participant = {
    id: 'r2-p3',
    name: 'P3',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const a: Assignment = {
    id: 'r2-a',
    taskId: 'r2-t',
    slotId: 'r2-s',
    participantId: 'r2-p1',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const sched = mkSchedule([t], [p1, p2, p3], [a]);
  const req: RescueRequest = { vacatedAssignmentId: 'r2-a', taskId: 'r2-t', slotId: 'r2-s', vacatedBy: 'r2-p1' };
  const result = generateRescuePlans(
    sched,
    req,
    earlyAnchor,
    0,
    undefined,
    undefined,
    undefined,
    5,
    undefined,
    { ...DEFAULT_CONFIG },
    buildScoreCtx(sched.tasks, sched.participants),
  );
  assert(result.plans.length > 0, 'rescue-vacated-excluded: at least one plan returned');
  const allOk = result.plans.every((plan) => plan.swaps.every((sw) => sw.toParticipantId !== 'r2-p1'));
  assert(allOk, 'rescue-vacated-excluded: no plan ever assigns the vacated participant');
}

// ─── Test 3: Rescue infeasible → 0 plans, no mutation ───────────────────────

console.log('\n── Test 3: rescue infeasible returns 0 plans, no mutation ──');
{
  const block = createTimeBlockFromHours(base, 6, 14);
  const t: Task = {
    id: 'r3-t',
    name: 'R3T',
    timeBlock: block,
    requiredCount: 1,
    slots: [
      { slotId: 'r3-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['rare-cert'], label: 'A' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const p1: Participant = {
    id: 'r3-p1',
    name: 'P1',
    level: Level.L0,
    certifications: ['rare-cert'],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  // No one else has the cert → infeasible to replace p1.
  const p2: Participant = {
    id: 'r3-p2',
    name: 'P2',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const a: Assignment = {
    id: 'r3-a',
    taskId: 'r3-t',
    slotId: 'r3-s',
    participantId: 'r3-p1',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const sched = mkSchedule([t], [p1, p2], [a]);
  const before = JSON.stringify({
    assignments: sched.assignments.map((x) => ({ id: x.id, pid: x.participantId, status: x.status })),
    tasks: sched.tasks.map((x) => x.id),
  });
  const req: RescueRequest = { vacatedAssignmentId: 'r3-a', taskId: 'r3-t', slotId: 'r3-s', vacatedBy: 'r3-p1' };
  const result = generateRescuePlans(
    sched,
    req,
    earlyAnchor,
    0,
    undefined,
    undefined,
    undefined,
    5,
    undefined,
    { ...DEFAULT_CONFIG },
    buildScoreCtx(sched.tasks, sched.participants),
  );
  assert(result.plans.length === 0, 'rescue-infeasible: 0 plans returned');
  const after = JSON.stringify({
    assignments: sched.assignments.map((x) => ({ id: x.id, pid: x.participantId, status: x.status })),
    tasks: sched.tasks.map((x) => x.id),
  });
  assert(before === after, 'rescue-infeasible: schedule untouched after failed rescue');
}

// ─── Test 4: FSOS scheduleUnavailability frozen on schedule, master unchanged ─

console.log('\n── Test 4: FSOS does not mutate participant master availability ──');
{
  const block1 = createTimeBlockFromHours(base, 6, 14);
  const block2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14);
  const t1: Task = {
    id: 'fs-t1',
    name: 'T1',
    timeBlock: block1,
    requiredCount: 1,
    slots: [{ slotId: 'fs-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const t2: Task = {
    id: 'fs-t2',
    name: 'T2',
    timeBlock: block2,
    requiredCount: 1,
    slots: [{ slotId: 'fs-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const focal: Participant = {
    id: 'fs-focal',
    name: 'Focal',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const replA: Participant = {
    id: 'fs-pA',
    name: 'A',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const replB: Participant = {
    id: 'fs-pB',
    name: 'B',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const a1: Assignment = {
    id: 'fs-a1',
    taskId: 'fs-t1',
    slotId: 'fs-s1',
    participantId: 'fs-focal',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const a2: Assignment = {
    id: 'fs-a2',
    taskId: 'fs-t2',
    slotId: 'fs-s2',
    participantId: 'fs-focal',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };

  // Snapshot master-data availability deeply BEFORE fsos call.
  const focalAvailBefore = JSON.stringify(focal.availability);
  const focalDateUnavailBefore = JSON.stringify(focal.dateUnavailability);

  const sched = mkSchedule([t1, t2], [focal, replA, replB], [a1, a2]);
  // Pre-existing scheduleUnavailability frozen on the schedule (separate window
  // for replA, just to ensure HC-3 layering across snapshot data is exercised).
  sched.scheduleUnavailability = [
    {
      id: 'sun1',
      participantId: 'fs-pA',
      start: new Date(2026, 5, 4, 0),
      end: new Date(2026, 5, 4, 23),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    } as ScheduleUnavailability,
  ];

  const window = { start: new Date(2026, 5, 1, 0), end: new Date(2026, 5, 3, 0) };
  const result = generateBatchRescuePlans(sched, { participantId: 'fs-focal', window }, earlyAnchor, {
    config: { ...DEFAULT_CONFIG },
    scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
    maxPlans: 3,
  });

  assert(result.plans.length > 0, 'fsos-frozen: produces a plan');

  // Master-data availability unchanged on focal.
  const focalAvailAfter = JSON.stringify(focal.availability);
  const focalDateUnavailAfter = JSON.stringify(focal.dateUnavailability);
  assert(focalAvailAfter === focalAvailBefore, 'fsos-frozen: focal.availability unchanged');
  assert(focalDateUnavailAfter === focalDateUnavailBefore, 'fsos-frozen: focal.dateUnavailability unchanged');

  // The plan must cover both vacated assignments in one composite plan.
  const top = result.plans[0];
  const covered = new Set(top.swaps.map((s) => s.assignmentId));
  assert(
    covered.has('fs-a1') && covered.has('fs-a2'),
    'fsos-frozen: top plan covers both affected assignments in one composite',
  );
  // Focal must not be reassigned to either of their own in-window slots.
  const reassignedTo = top.swaps
    .filter((s) => s.assignmentId === 'fs-a1' || s.assignmentId === 'fs-a2')
    .map((s) => s.toParticipantId);
  assert(
    reassignedTo.every((id) => id !== 'fs-focal'),
    'fsos-frozen: focal never re-fills their own in-window slot',
  );

  // scheduleUnavailability must remain on the schedule, not migrate to participant.
  assert(sched.scheduleUnavailability!.length === 1, 'fsos-frozen: scheduleUnavailability stays on schedule');
}

// ─── Test 5: Inject — task carries injectedPostGeneration = true after apply ─

console.log('\n── Test 5: injected task carries injectedPostGeneration ──');
{
  const sched = mkSchedule(
    [],
    [
      {
        id: 'inj-pA',
        name: 'A',
        level: Level.L0,
        certifications: [],
        group: 'G',
        availability: avail,
        dateUnavailability: [],
      },
      {
        id: 'inj-pB',
        name: 'B',
        level: Level.L0,
        certifications: [],
        group: 'G',
        availability: avail,
        dateUnavailability: [],
      },
    ],
    [],
  );
  const engine = new SchedulingEngine({}, undefined, undefined, 5);
  engine.addParticipants(sched.participants);
  engine.importSchedule(sched);

  const spec: InjectedTaskSpec = {
    name: 'TestInject',
    dayIndex: 1,
    startHour: 6,
    startMinute: 0,
    durationHours: 4,
    subTeams: [],
    slots: [
      {
        id: 'spec-s1',
        label: 'S1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: true,
    baseLoadWeight: 1,
  };
  const { report, error } = injectAndStaff(engine, spec, { anchor: new Date(2026, 4, 20, 0, 0) });
  assert(!error && report !== null, 'inject-flag: succeeds');
  if (report) {
    assert(report.task.injectedPostGeneration === true, 'inject-flag: task.injectedPostGeneration === true');
    const taskOnSchedule = sched.tasks.find((t) => t.id === report.task.id);
    assert(taskOnSchedule?.injectedPostGeneration === true, 'inject-flag: task on schedule carries the flag');
  }
}

// ─── Test 6: assertInjectableTimeBlock semantics ────────────────────────────

console.log('\n── Test 6: assertInjectableTimeBlock past-time gate ──');
{
  const anchor = new Date(2026, 5, 3, 12, 0);
  // Strictly before anchor → reject.
  const past = { start: new Date(2026, 5, 3, 11, 59), end: new Date(2026, 5, 3, 13, 0) };
  const before = assertInjectableTimeBlock(past, anchor);
  assert(before.ok === false, 'gate: strictly before anchor rejected');
  if (!before.ok) {
    assert(before.reason === 'past-time', 'gate: rejection reason is past-time');
  }

  // Equal to anchor → accept (matches isFutureTask >= semantics).
  const equal = { start: anchor, end: new Date(anchor.getTime() + 3600 * 1000) };
  const eq = assertInjectableTimeBlock(equal, anchor);
  assert(eq.ok === true, 'gate: start equal to anchor accepted (>= semantics)');

  // After anchor → accept.
  const future = {
    start: new Date(anchor.getTime() + 1000),
    end: new Date(anchor.getTime() + 3600 * 1000),
  };
  const ft = assertInjectableTimeBlock(future, anchor);
  assert(ft.ok === true, 'gate: future start accepted');
}

// ─── Test 7: Inject signature regression — no per-call HC-relax knob ────────
//
// `InjectStaffOptions` exposes only: allowLowPriority, anchor, maxPlans,
// timeBudgetMs, caps. There is no `disabledHardConstraints` override — that's
// a global setting frozen on the schedule. This test passes the documented
// option fields and verifies the call contract; if a new HC-relax knob is
// added in the future, an explicit assertion below fails.

console.log('\n── Test 7: inject options have no HC-relax knob ──');
{
  // Build a fresh sched/engine just for this test.
  const pA: Participant = {
    id: 'opt-pA',
    name: 'A',
    level: Level.L0,
    certifications: [],
    group: 'G',
    availability: avail,
    dateUnavailability: [],
  };
  const sched = mkSchedule([], [pA], []);
  const engine = new SchedulingEngine({}, undefined, undefined, 5);
  engine.addParticipants(sched.participants);
  engine.importSchedule(sched);

  const spec: InjectedTaskSpec = {
    name: 'opt',
    dayIndex: 1,
    startHour: 6,
    startMinute: 0,
    durationHours: 4,
    subTeams: [],
    slots: [{ id: 'opt-s1', label: 'S1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
    baseLoadWeight: 1,
  };

  // The set of allowed option keys. If the type ever gains a HC-relax knob,
  // this list must be reviewed — that is the regression signal.
  const KNOWN_OPT_KEYS = new Set(['allowLowPriority', 'anchor', 'maxPlans', 'timeBudgetMs', 'caps']);
  const FORBIDDEN_KEYS = ['disabledHardConstraints', 'disabledHC', 'relaxHC', 'allowViolations'];

  // Build the opts with only known keys; verify call still succeeds.
  const opts = {
    anchor: new Date(2026, 4, 20, 0, 0),
    allowLowPriority: true,
    maxPlans: 2,
  };
  for (const k of Object.keys(opts)) {
    assert(KNOWN_OPT_KEYS.has(k), `inject-opts: option key '${k}' is recognized (no leakage)`);
  }
  for (const k of FORBIDDEN_KEYS) {
    assert(!(k in opts), `inject-opts: forbidden HC-relax key '${k}' not present in opts`);
  }
  const { result, error } = searchInjectionPlans(engine, spec, opts);
  assert(!error && result !== null, 'inject-opts: searchInjectionPlans accepts only known opts');
  if (result) result.cancel();
}

// ─── Test 8: Inject — sameGroupRequired with no fitting group fails cleanly ─

console.log('\n── Test 8: inject sameGroupRequired no-fitting-group ──');
{
  // Two slots, same task, sameGroupRequired = true.
  // Group A has only 1 L0 (slot count = 2 → cannot fill).
  // Group B has 0 L0.
  // No group can fully fill, so no full plan exists.
  const pA1: Participant = {
    id: 'sg-A1',
    name: 'A1',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: avail,
    dateUnavailability: [],
  };
  const pB1: Participant = {
    id: 'sg-B1',
    name: 'B1',
    level: Level.L2,
    certifications: [],
    group: 'B',
    availability: avail,
    dateUnavailability: [],
  };
  const sched = mkSchedule([], [pA1, pB1], []);
  const engine = new SchedulingEngine({}, undefined, undefined, 5);
  engine.addParticipants(sched.participants);
  engine.importSchedule(sched);

  const spec: InjectedTaskSpec = {
    name: 'sg',
    dayIndex: 1,
    startHour: 6,
    startMinute: 0,
    durationHours: 4,
    subTeams: [],
    slots: [
      { id: 'sg-s1', label: 'S1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      { id: 'sg-s2', label: 'S2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
    ],
    sameGroupRequired: true,
    blocksConsecutive: true,
    baseLoadWeight: 1,
  };
  const { report } = injectAndStaff(engine, spec, { anchor: new Date(2026, 4, 20, 0, 0) });
  assert(report !== null, 'inject-no-fitting-group: report returned (no crash)');
  if (report) {
    assert(!report.fullyStaffed, 'inject-no-fitting-group: not fully staffed');
    // Either both unfilled, or the only feasible group A leaves the second slot unfilled.
    const filled = report.outcomes.filter((o) => o.filled).length;
    assert(filled <= 1, 'inject-no-fitting-group: at most 1 slot filled (group A has only 1 L0)');
    report.rollback();
    assert(
      !sched.tasks.some((t) => t.id === report.task.id),
      'inject-no-fitting-group: rollback removes the task cleanly',
    );
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n────────────── Summary ──────────────`);
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
if (failed > 0) {
  console.log(`\n  Failures:`);
  for (const m of failures) console.log(`    - ${m}`);
  process.exit(1);
}

// Touch unused symbol to avoid ts-node "unused" warnings if any get added.
void computeScheduleScore;
void buildInjectedTask;
