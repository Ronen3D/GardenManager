/**
 * Integration / state-flow tests for the mid-schedule capability-change feature.
 *
 * Run via: npx ts-node src/test-capability-change-integration.ts
 *
 * Coverage targets:
 *   1. SchedulingEngine integration: revalidateFull / validate honor
 *      Schedule.capabilityLoss
 *   2. swapParticipantChain rejects invalid placements due to capabilityLoss
 *   3. getEligibleParticipantsForSlot honors extraCapabilityLoss
 *   4. generateCapabilityChangePlans end-to-end on a real schedule
 *   5. Persistence / serialization round-trip via __date__ reviver
 *   6. Frozen-snapshot integrity vs store-side mutation
 *   7. Layering with scheduleUnavailability + capabilityLoss
 *   8. Disabled-HC gate (HC-2) suppresses capabilityLoss-driven violations
 */

import { validateHardConstraints } from './constraints/hard-constraints';
import type { ScoreContext } from './constraints/soft-constraints';
import {
  findCertAffectedAssignments,
  generateCapabilityChangePlans,
  upsertCapabilityLoss,
} from './engine/capability-change';
import { SchedulingEngine } from './engine/scheduler';
import { getEligibleParticipantsForSlot } from './engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  createTimeBlockFromHours,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Schedule,
  type ScheduleScore,
  type Task,
} from './index';
import type { CapabilityLoss, ScheduleUnavailability } from './models/types';
import { jsonDeserialize, jsonSerialize } from './shared/utils/json-dates';
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

console.log('── Capability-change integration tests ─────────────────');

// ─── Shared fixtures ────────────────────────────────────────────────────────

const base = new Date(2026, 5, 1); // 2026-06-01 (period day 1, 05:00 boundary)
const earlyAnchor = new Date(2026, 4, 30); // before period → all tasks future
const wideAvail = [{ start: new Date(2026, 4, 28), end: new Date(2026, 5, 10) }];

const dummyScore: ScheduleScore = {
  minRestHours: 0,
  avgRestHours: 0,
  restStdDev: 0,
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

function mkSchedule(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  opts?: {
    scheduleUnavailability?: ScheduleUnavailability[];
    capabilityLoss?: CapabilityLoss[];
    disabledHardConstraints?: import('./models/types').HardConstraintCode[];
  },
): Schedule {
  return {
    id: 'capch-test-sched',
    tasks,
    participants,
    assignments,
    feasible: true,
    score: dummyScore,
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: {
      config: { ...DEFAULT_CONFIG },
      disabledHardConstraints: opts?.disabledHardConstraints ?? [],
      dayStartHour: 5,
    },
    periodStart: base,
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
    scheduleUnavailability: opts?.scheduleUnavailability ?? [],
    capabilityLoss: opts?.capabilityLoss ?? [],
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

// jsonSerialize / jsonDeserialize are imported from the pure, DOM-free shared
// module (src/shared/utils/json-dates.ts) — the same implementation the web
// build uses. This file stays node-runnable because that module has zero
// imports and no localStorage/DOM dependency; there is no longer a local copy
// to drift from production.

// ─── Test 1 — engine integration ────────────────────────────────────────────

console.log('\n── Test 1: revalidateFull/validate honor capabilityLoss ──');
{
  const eng = new SchedulingEngine({}, undefined, undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });

  // Two tasks needing cert X, two participants with cert X, both assigned.
  const t1 = createTimeBlockFromHours(base, 6, 14); // day 1
  const t2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14); // day 2
  const taskA: Task = {
    id: 'eng-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'eng-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'A' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskB: Task = {
    id: 'eng-tB',
    name: 'TB',
    timeBlock: t2,
    requiredCount: 1,
    slots: [{ slotId: 'eng-sB', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'B' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'eng-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'eng-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  eng.addParticipants([P, Q]);
  eng.addTasks([taskA, taskB]);
  const sched = eng.generateSchedule();

  // Sanity: schedule should already be feasible (each cert-required slot has a holder).
  // Pin assignments to a known shape so the test reasons about specific IDs.
  // Note: revalidateFull() replaces engine.currentSchedule with a spread copy,
  // so we always re-read via eng.getSchedule() to get the live reference.
  const aA0 = sched.assignments.find((a) => a.taskId === 'eng-tA')!;
  const aB0 = sched.assignments.find((a) => a.taskId === 'eng-tB')!;
  // Force P→tA, Q→tB (greedy could pick either order).
  aA0.participantId = 'eng-P';
  aB0.participantId = 'eng-Q';
  eng.revalidateFull();

  // Baseline: no capability-loss → no HC-2.
  const baseHC2 = eng.getSchedule()!.violations.filter((v) => v.code === 'CERT_MISSING');
  assert(baseHC2.length === 0, 'engine: baseline schedule has zero HC-2 violations');

  // Add capability-loss for P over taskA's window. Mutate via the live schedule
  // reference (eng.getSchedule()) since revalidateFull replaced currentSchedule.
  const live = eng.getSchedule()!;
  live.capabilityLoss = [
    {
      id: 'capl-1',
      participantId: 'eng-P',
      lostCertifications: ['X'],
      start: new Date(t1.start.getTime() - 1_000),
      end: new Date(t1.end.getTime() + 1_000),
      reason: 'test',
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  eng.revalidateFull();
  const hc2After = eng.getSchedule()!.violations.filter((v) => v.code === 'CERT_MISSING');
  assert(
    hc2After.some((v) => v.participantId === 'eng-P' && v.taskId === 'eng-tA'),
    'engine: revalidateFull surfaces HC-2 (CERT_MISSING) for P on tA after capabilityLoss is added',
  );

  // engine.validate() — bare hard validation — also reports the HC-2. Loss
  // entry travels through the new currentSchedule via the spread in revalidateFull.
  const bareValidate = eng.validate();
  assert(
    bareValidate.violations.some(
      (v) => v.code === 'CERT_MISSING' && v.participantId === 'eng-P' && v.taskId === 'eng-tA',
    ),
    'engine: validate() also reports HC-2 from capabilityLoss',
  );
  assert(!bareValidate.valid, 'engine: validate() returns invalid when capabilityLoss yields HC-2');

  // Removing the entry restores cleanliness.
  eng.getSchedule()!.capabilityLoss = [];
  eng.revalidateFull();
  const hc2Cleared = eng.getSchedule()!.violations.filter((v) => v.code === 'CERT_MISSING');
  assert(hc2Cleared.length === 0, 'engine: clearing capabilityLoss removes HC-2 violations');
}

// ─── Test 2 — swapParticipantChain honors capabilityLoss ────────────────────

console.log('\n── Test 2: swapParticipantChain honors capabilityLoss ──');
{
  const eng = new SchedulingEngine({}, undefined, undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });

  const t1 = createTimeBlockFromHours(base, 6, 14);
  const t2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14);
  const taskA: Task = {
    id: 'sw-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'sw-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'A' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskB: Task = {
    id: 'sw-tB',
    name: 'TB',
    timeBlock: t2,
    requiredCount: 1,
    slots: [{ slotId: 'sw-sB', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'B' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'sw-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'sw-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  eng.addParticipants([P, Q]);
  eng.addTasks([taskA, taskB]);
  const sched0 = eng.generateSchedule();
  const aA0 = sched0.assignments.find((a) => a.taskId === 'sw-tA')!;
  const aB0 = sched0.assignments.find((a) => a.taskId === 'sw-tB')!;
  aA0.participantId = 'sw-P';
  aB0.participantId = 'sw-Q';
  eng.revalidateFull();
  const aA = eng.getSchedule()!.assignments.find((a) => a.taskId === 'sw-tA')!;
  const aB = eng.getSchedule()!.assignments.find((a) => a.taskId === 'sw-tB')!;

  // Add capability-loss: P loses X across tA's window. Mutate via live ref.
  eng.getSchedule()!.capabilityLoss = [
    {
      id: 'capl-2',
      participantId: 'sw-P',
      lostCertifications: ['X'],
      start: new Date(t1.start.getTime() - 1_000),
      end: new Date(t1.end.getTime() + 1_000),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  eng.revalidateFull();

  // 2a. Empty chain → returns valid (early-return path), independent of loss.
  const emptyResult = eng.swapParticipantChain([]);
  assert(emptyResult.valid && emptyResult.violations.length === 0, 'swapChain: empty chain returns valid');

  // 2b. No-op chain that re-asserts current state (same participantId on aA + aB).
  // validate() runs against the loss → invalid + HC-2 on P/sw-sA → rolled back.
  const reassertResult = eng.swapParticipantChain([
    { assignmentId: aA.id, newParticipantId: 'sw-P' },
    { assignmentId: aB.id, newParticipantId: 'sw-Q' },
  ]);
  assert(!reassertResult.valid, 'swapChain: re-asserting P→sA under loss returns invalid');
  assert(
    reassertResult.violations.some(
      (v) => v.code === 'CERT_MISSING' && v.participantId === 'sw-P' && v.taskId === 'sw-tA',
    ),
    'swapChain: invalid result references HC-2 on P/sA under capabilityLoss',
  );
  // Rolled back: aA still references sw-P with its original status (NOT Manual).
  const rolledA = eng.getSchedule()!.assignments.find((a) => a.id === aA.id)!;
  assert(rolledA.participantId === 'sw-P', 'swapChain: aA participant rolled back to P');

  // 2c. Q swapped onto sA (Q has X, no loss for Q) → chain validates clean.
  // Q ends up on both tA.sA and tB.sB; tA and tB don't overlap → HC-5 ok; not same task → HC-7 ok.
  const okChain = eng.swapParticipantChain([{ assignmentId: aA.id, newParticipantId: 'sw-Q' }]);
  assert(okChain.valid, 'swapChain: swapping Q onto sA validates clean under capabilityLoss for P');
  const postA = eng.getSchedule()!.assignments.find((a) => a.id === aA.id)!;
  assert(postA.participantId === 'sw-Q', 'swapChain: clean swap committed (aA now holds Q)');
  // Bonus reference (silence unused warning for aB).
  void aB;
}

// ─── Test 3 — getEligibleParticipantsForSlot honors extraCapabilityLoss ────

console.log('\n── Test 3: getEligibleParticipantsForSlot honors extraCapabilityLoss ──');
{
  const t1 = createTimeBlockFromHours(base, 6, 14);
  const t2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14);
  const taskA: Task = {
    id: 'el-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'el-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'A' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskB: Task = {
    id: 'el-tB',
    name: 'TB',
    timeBlock: t2,
    requiredCount: 1,
    slots: [{ slotId: 'el-sB', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'B' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'el-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'el-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  // Existing assignments: P→sA, Q→sB
  const aA: Assignment = {
    id: 'el-aA',
    taskId: 'el-tA',
    slotId: 'el-sA',
    participantId: 'el-P',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const aB: Assignment = {
    id: 'el-aB',
    taskId: 'el-tB',
    slotId: 'el-sB',
    participantId: 'el-Q',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };

  // Without override: P and Q are both eligible for sA (P sits there; Q is free at that time).
  const baseEligible = getEligibleParticipantsForSlot(taskA, 'el-sA', [P, Q], [aA, aB], [taskA, taskB]);
  assert(
    baseEligible.some((p) => p.id === 'el-P') && baseEligible.some((p) => p.id === 'el-Q'),
    'eligible: without extraCapabilityLoss, both P and Q are eligible for sA',
  );

  // With override: P loses X over tA's window → P excluded, Q remains.
  const losses = [
    {
      participantId: 'el-P',
      lostCertifications: ['X'],
      start: new Date(t1.start.getTime() - 1_000),
      end: new Date(t1.end.getTime() + 1_000),
    },
  ];
  const lossEligible = getEligibleParticipantsForSlot(
    taskA,
    'el-sA',
    [P, Q],
    [aA, aB],
    [taskA, taskB],
    undefined,
    undefined,
    undefined,
    undefined,
    losses,
  );
  assert(!lossEligible.some((p) => p.id === 'el-P'), 'eligible: extraCapabilityLoss excludes P from sA');
  assert(
    lossEligible.some((p) => p.id === 'el-Q'),
    'eligible: Q remains eligible for sA under loss',
  );
}

// ─── Test 4 — generateCapabilityChangePlans end-to-end ──────────────────────

console.log('\n── Test 4: generateCapabilityChangePlans end-to-end ──');
{
  const eng = new SchedulingEngine({}, undefined, undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });

  // T1 (cert X required, focal P sits here). T2 (other slot, no cert; Q sits here).
  // Q has cert X. Plan goal: swap Q onto T1, P moves into T2 (focal moves).
  const t1 = createTimeBlockFromHours(base, 6, 14); // day 1 06-14
  const t2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14); // day 2 06-14
  const taskCert: Task = {
    id: 'c4-tCert',
    name: 'TCert',
    timeBlock: t1,
    requiredCount: 1,
    slots: [
      { slotId: 'c4-sCert', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'Cert' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskOther: Task = {
    id: 'c4-tOther',
    name: 'TOther',
    timeBlock: t2,
    requiredCount: 1,
    slots: [
      { slotId: 'c4-sOther', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'Other' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'c4-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'c4-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  eng.addParticipants([P, Q]);
  eng.addTasks([taskCert, taskOther]);
  const sched = eng.generateSchedule();

  // Pin assignments — P on cert task, Q on other.
  const aCert = sched.assignments.find((a) => a.taskId === 'c4-tCert')!;
  const aOther = sched.assignments.find((a) => a.taskId === 'c4-tOther')!;
  aCert.participantId = 'c4-P';
  aOther.participantId = 'c4-Q';
  eng.revalidateFull();

  // Sanity: findCertAffectedAssignments returns aCert.
  const window = { start: new Date(t1.start.getTime() - 1_000), end: new Date(t1.end.getTime() + 1_000) };
  const affected = findCertAffectedAssignments(
    sched,
    { participantId: 'c4-P', lostCertifications: ['X'], window },
    earlyAnchor,
  );
  assert(
    affected.affected.length === 1 && affected.affected[0].assignment.id === aCert.id,
    'capch: findCertAffectedAssignments isolates the cert-required slot',
  );

  // Generate plans.
  const result = generateCapabilityChangePlans(
    sched,
    { participantId: 'c4-P', lostCertifications: ['X'], window },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 5,
    },
  );
  assert(result.plans.length > 0, 'capch: at least one plan returned');

  // Apply the top plan to a copy of the assignments and validate with the
  // override layered → zero HC-2 violations.
  if (result.plans.length > 0) {
    const top = result.plans[0];
    const after = sched.assignments.map((a) => ({ ...a }));
    for (const sw of top.swaps) {
      const idx = after.findIndex((a) => a.id === sw.assignmentId);
      if (idx >= 0) after[idx].participantId = sw.toParticipantId;
    }
    const losses = [
      {
        participantId: 'c4-P',
        lostCertifications: ['X'],
        start: window.start,
        end: window.end,
      },
    ];
    const v = validateHardConstraints(
      sched.tasks,
      sched.participants,
      after,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      losses,
    );
    const hc2Count = v.violations.filter((x) => x.code === 'CERT_MISSING').length;
    assert(hc2Count === 0, 'capch: applied top plan + override → 0 HC-2 violations');

    // Focal stays in candidate pool: SOME plan should move the focal (focal as toParticipantId).
    const focalMoves = result.plans.some((plan) => plan.swaps.some((sw) => sw.toParticipantId === 'c4-P'));
    assert(focalMoves, 'capch: at least one plan reassigns the focal participant (focal stays in pool)');
  }
}

// ─── Test 5 — persistence / serialization round-trip ────────────────────────

console.log('\n── Test 5: persistence round-trip preserves capabilityLoss ──');
{
  const t1 = createTimeBlockFromHours(base, 6, 14);
  const taskA: Task = {
    id: 'p-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'p-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'p-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const aA: Assignment = {
    id: 'p-aA',
    taskId: 'p-tA',
    slotId: 'p-sA',
    participantId: 'p-P',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const sched = mkSchedule([taskA], [P], [aA], {
    capabilityLoss: [
      {
        id: 'capl-rt',
        participantId: 'p-P',
        lostCertifications: ['X'],
        start: new Date(t1.start.getTime()),
        end: new Date(t1.end.getTime()),
        reason: 'מילואים',
        createdAt: new Date(2026, 5, 1, 10, 0, 0),
        anchorAtCreation: earlyAnchor,
        appliedSwapCount: 2,
      },
    ],
  });

  const blob = jsonSerialize(sched);
  const revived = jsonDeserialize<Schedule>(blob);
  const cl = revived.capabilityLoss?.[0];
  assert(!!cl, 'persist: capabilityLoss array survived round-trip');
  if (cl) {
    assert(cl.id === 'capl-rt', 'persist: id preserved');
    assert(cl.participantId === 'p-P', 'persist: participantId preserved');
    assert(
      Array.isArray(cl.lostCertifications) && cl.lostCertifications[0] === 'X',
      'persist: lostCertifications preserved',
    );
    assert(cl.start instanceof Date && cl.start.getTime() === t1.start.getTime(), 'persist: start revived as Date');
    assert(cl.end instanceof Date && cl.end.getTime() === t1.end.getTime(), 'persist: end revived as Date');
    assert(cl.createdAt instanceof Date, 'persist: createdAt revived as Date');
    assert(cl.anchorAtCreation instanceof Date, 'persist: anchorAtCreation revived as Date');
    assert(cl.reason === 'מילואים', 'persist: reason preserved');
    assert(cl.appliedSwapCount === 2, 'persist: appliedSwapCount preserved');
  }
}

// ─── Test 6 — frozen-snapshot integrity vs store-side mutation ─────────────

console.log('\n── Test 6: frozen schedule.participants is immune to source mutation ──');
{
  const eng = new SchedulingEngine({}, undefined, undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });
  const t1 = createTimeBlockFromHours(base, 6, 14);
  const taskA: Task = {
    id: 'fr-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'fr-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  // Source object passed to addParticipant — engine deep-clones on entry.
  const liveP: Participant = {
    id: 'fr-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  eng.addParticipant(liveP);
  eng.addTask(taskA);
  const sched = eng.generateSchedule();

  // Mutate the source object (simulating a live-store edit) — remove cert X.
  liveP.certifications = [];

  // Frozen snapshot stays intact.
  const frozenP = sched.participants.find((p) => p.id === 'fr-P')!;
  assert(
    frozenP.certifications.includes('X'),
    'frozen: schedule.participants[i].certifications still includes X after liveP mutation',
  );

  // revalidateFull does NOT fire HC-2 because the engine validates against the
  // frozen array, not the mutated source object.
  eng.revalidateFull();
  const hc2 = eng.getSchedule()!.violations.filter((v) => v.code === 'CERT_MISSING');
  assert(hc2.length === 0, 'frozen: revalidateFull does not surface HC-2 from store-side cert removal');
}

// ─── Test 7 — layering scheduleUnavailability + capabilityLoss ──────────────

console.log('\n── Test 7: scheduleUnavailability + capabilityLoss layering ──');
{
  const t1 = createTimeBlockFromHours(base, 6, 14); // day 1
  const t2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14); // day 2
  const taskCert: Task = {
    id: 'l-tCert',
    name: 'TCert',
    timeBlock: t1,
    requiredCount: 1,
    slots: [
      { slotId: 'l-sCert', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'], label: 'Cert' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskOther: Task = {
    id: 'l-tOther',
    name: 'TOther',
    timeBlock: t2,
    requiredCount: 1,
    slots: [
      { slotId: 'l-sOther', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'Other' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'l-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'l-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  // No assignments needed for the eligibility checks below.
  const sched = mkSchedule([taskCert, taskOther], [P, Q], []);

  // (a) capabilityLoss on tCert window → HC-2 rejection from cert-restricted slot.
  const losses = [
    {
      participantId: 'l-P',
      lostCertifications: ['X'],
      start: new Date(t1.start.getTime() - 1_000),
      end: new Date(t1.end.getTime() + 1_000),
    },
  ];
  // (b) scheduleUnavailability on tOther's day → HC-3 rejection from Other slot.
  const unavail: ScheduleUnavailability[] = [
    {
      id: 'su-1',
      participantId: 'l-P',
      start: new Date(t2.start.getTime() - 1_000),
      end: new Date(t2.end.getTime() + 1_000),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  const extraUnavail = unavail.map((u) => ({ participantId: u.participantId, start: u.start, end: u.end }));

  // tCert eligibility: P excluded (HC-2), Q included.
  const certEligible = getEligibleParticipantsForSlot(
    taskCert,
    'l-sCert',
    [P, Q],
    [],
    [taskCert, taskOther],
    undefined,
    undefined,
    extraUnavail,
    undefined,
    losses,
  );
  assert(!certEligible.some((p) => p.id === 'l-P'), 'layer: P excluded from cert slot (HC-2)');
  assert(
    certEligible.some((p) => p.id === 'l-Q'),
    'layer: Q remains eligible for cert slot',
  );

  // tOther eligibility: P excluded (HC-3), Q included.
  const otherEligible = getEligibleParticipantsForSlot(
    taskOther,
    'l-sOther',
    [P, Q],
    [],
    [taskCert, taskOther],
    undefined,
    undefined,
    extraUnavail,
    undefined,
    losses,
  );
  assert(
    !otherEligible.some((p) => p.id === 'l-P'),
    'layer: P excluded from other slot (HC-3 via scheduleUnavailability)',
  );
  assert(
    otherEligible.some((p) => p.id === 'l-Q'),
    'layer: Q remains eligible for other slot',
  );

  // validateHardConstraints with both layers active and BOTH bad placements
  // surfaces both rejection codes simultaneously.
  const bad: Assignment[] = [
    {
      id: 'l-aBadCert',
      taskId: 'l-tCert',
      slotId: 'l-sCert',
      participantId: 'l-P',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'l-aBadOther',
      taskId: 'l-tOther',
      slotId: 'l-sOther',
      participantId: 'l-P',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = validateHardConstraints(
    sched.tasks,
    sched.participants,
    bad,
    undefined,
    undefined,
    undefined,
    extraUnavail,
    undefined,
    losses,
  );
  const codes = new Set(v.violations.map((x) => x.code));
  assert(codes.has('CERT_MISSING'), 'layer: HC-2 fires for forced bad cert placement');
  assert(codes.has('AVAILABILITY_VIOLATION'), 'layer: HC-3 fires for forced bad scheduleUnavailability placement');
}

// ─── Test 8 — disabled-HC gate ──────────────────────────────────────────────

console.log('\n── Test 8: disabledHardConstraints HC-2 suppresses capabilityLoss violations ──');
{
  const eng = new SchedulingEngine({}, new Set(['HC-2']), undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });
  const t1 = createTimeBlockFromHours(base, 6, 14);
  const taskA: Task = {
    id: 'd-tA',
    name: 'TA',
    timeBlock: t1,
    requiredCount: 1,
    slots: [{ slotId: 'd-sA', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'd-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  eng.addParticipant(P);
  eng.addTask(taskA);
  eng.generateSchedule();

  eng.getSchedule()!.capabilityLoss = [
    {
      id: 'capl-d',
      participantId: 'd-P',
      lostCertifications: ['X'],
      start: new Date(t1.start.getTime() - 1_000),
      end: new Date(t1.end.getTime() + 1_000),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  eng.revalidateFull();
  const hc2 = eng.getSchedule()!.violations.filter((v) => v.code === 'CERT_MISSING');
  assert(hc2.length === 0, 'disabled-gate: HC-2 disabled → no CERT_MISSING violation despite capabilityLoss');
}

// ─── upsertCapabilityLoss sanity (bonus, supports test 5/8 setup) ───────────

console.log('\n── Bonus: upsertCapabilityLoss merge semantics ──');
{
  const e1: CapabilityLoss = {
    id: 'a',
    participantId: 'P',
    lostCertifications: ['X'],
    start: new Date(2026, 5, 1, 6),
    end: new Date(2026, 5, 1, 14),
    createdAt: new Date(),
    anchorAtCreation: earlyAnchor,
  };
  const merged = upsertCapabilityLoss([e1], {
    id: 'b',
    participantId: 'P',
    lostCertifications: ['X'],
    start: new Date(2026, 5, 1, 12), // overlaps e1
    end: new Date(2026, 5, 1, 18),
    createdAt: new Date(),
    anchorAtCreation: earlyAnchor,
  });
  assert(merged.length === 1, 'upsert: same-set overlapping entry merges to one');
  assert(
    merged[0].start.getTime() === new Date(2026, 5, 1, 6).getTime() &&
      merged[0].end.getTime() === new Date(2026, 5, 1, 18).getTime(),
    'upsert: merged window spans union of both',
  );
  // Different cert set → coexist.
  const coexist = upsertCapabilityLoss(merged, {
    id: 'c',
    participantId: 'P',
    lostCertifications: ['Y'],
    start: new Date(2026, 5, 1, 10),
    end: new Date(2026, 5, 1, 16),
    createdAt: new Date(),
    anchorAtCreation: earlyAnchor,
  });
  assert(coexist.length === 2, 'upsert: different cert set yields independent entry');
}

// ─── Test 9 — focal-continuity extension fires under deficit ────────────────

console.log('\n── Test 9: focal-continuity extension fires on heavy cert-loss deficit ──');
{
  // Scenario: P holds a cert slot (8h, day 1 morning). Q has cert but is idle.
  // R has TWO non-cert slots (day 1 afternoon, day 2 morning — 16h total).
  // P loses cert → depth-1 chain hands the cert slot to Q. Without extension
  // P is left with 0 hours and the L0 pool is wildly imbalanced (0,8,16 vs
  // target 8 each). The extension scans, finds R's non-cert slots are focal-
  // eligible, and lifts P back up by one. Net delta strictly positive → the
  // extension applies.
  const tCert = createTimeBlockFromHours(base, 6, 14);
  const tOther1 = createTimeBlockFromHours(base, 14, 22);
  const day2 = new Date(base.getTime() + 24 * 3600 * 1000);
  const tOther2 = createTimeBlockFromHours(day2, 6, 14);

  const taskCert: Task = {
    id: 'fc-tCert',
    name: 'TCert',
    timeBlock: tCert,
    requiredCount: 1,
    slots: [{ slotId: 'fc-sCert', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskOther1: Task = {
    id: 'fc-tOther1',
    name: 'TOther1',
    timeBlock: tOther1,
    requiredCount: 1,
    slots: [{ slotId: 'fc-sOther1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskOther2: Task = {
    id: 'fc-tOther2',
    name: 'TOther2',
    timeBlock: tOther2,
    requiredCount: 1,
    slots: [{ slotId: 'fc-sOther2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'fc-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'fc-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const R: Participant = {
    id: 'fc-R',
    name: 'R',
    level: Level.L0,
    certifications: [],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };

  const aCert: Assignment = {
    id: 'fc-aCert',
    taskId: taskCert.id,
    slotId: 'fc-sCert',
    participantId: P.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const aOther1: Assignment = {
    id: 'fc-aOther1',
    taskId: taskOther1.id,
    slotId: 'fc-sOther1',
    participantId: R.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const aOther2: Assignment = {
    id: 'fc-aOther2',
    taskId: taskOther2.id,
    slotId: 'fc-sOther2',
    participantId: R.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };

  const sched = mkSchedule([taskCert, taskOther1, taskOther2], [P, Q, R], [aCert, aOther1, aOther2]);
  const window = { start: new Date(tCert.start.getTime() - 1_000), end: new Date(tCert.end.getTime() + 1_000) };

  const result = generateCapabilityChangePlans(
    sched,
    { participantId: P.id, lostCertifications: ['X'], window },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 5,
    },
  );

  assert(result.plans.length > 0, 'fc-ext: at least one plan returned');
  const extended = result.plans.filter((p) => p.focalContinuityExtended === true);
  assert(extended.length > 0, 'fc-ext: at least one plan is focalContinuityExtended');
  if (extended.length > 0) {
    const ext = extended[0];
    assert(
      ext.swaps.some((sw) => sw.toParticipantId === P.id),
      'fc-ext: extended plan places focal P on at least one slot',
    );
    assert((ext.focalContinuityHoursAdded ?? 0) > 0, 'fc-ext: focalContinuityHoursAdded > 0');
    assert(ext.violations.length === 0, 'fc-ext: extended plan passes full HC validation');
  }
}

// ─── Test 10 — light cert-loss does NOT trigger extension ───────────────────

console.log('\n── Test 10: light cert-loss (1 hour) does NOT trigger extension ──');
{
  // P holds ONE cert slot (8h) — a single shift loss. Pool is small; pool
  // target for P is ~half. Deficit after a depth-1 swap is small; gate
  // should NOT fire. Verifies the gate isn't over-eager.
  const tCert = createTimeBlockFromHours(base, 6, 14);
  const taskCert: Task = {
    id: 'lc-tCert',
    name: 'TCert',
    timeBlock: tCert,
    requiredCount: 1,
    slots: [{ slotId: 'lc-sCert', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['X'] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  // Give P a robust amount of OTHER work so retention stays > 50% after the
  // single cert assignment is lost. Two non-cert slots.
  const tOther1 = createTimeBlockFromHours(base, 14, 22);
  const day2 = new Date(base.getTime() + 24 * 3600 * 1000);
  const tOther2 = createTimeBlockFromHours(day2, 6, 14);
  const taskOther1: Task = {
    id: 'lc-tO1',
    name: 'TO1',
    timeBlock: tOther1,
    requiredCount: 1,
    slots: [{ slotId: 'lc-sO1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskOther2: Task = {
    id: 'lc-tO2',
    name: 'TO2',
    timeBlock: tOther2,
    requiredCount: 1,
    slots: [{ slotId: 'lc-sO2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const P: Participant = {
    id: 'lc-P',
    name: 'P',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const Q: Participant = {
    id: 'lc-Q',
    name: 'Q',
    level: Level.L0,
    certifications: ['X'],
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  };
  const aCert: Assignment = {
    id: 'lc-aC',
    taskId: taskCert.id,
    slotId: 'lc-sCert',
    participantId: P.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const aO1: Assignment = {
    id: 'lc-aO1',
    taskId: taskOther1.id,
    slotId: 'lc-sO1',
    participantId: P.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const aO2: Assignment = {
    id: 'lc-aO2',
    taskId: taskOther2.id,
    slotId: 'lc-sO2',
    participantId: P.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const sched = mkSchedule([taskCert, taskOther1, taskOther2], [P, Q], [aCert, aO1, aO2]);
  const window = { start: new Date(tCert.start.getTime() - 1_000), end: new Date(tCert.end.getTime() + 1_000) };

  const result = generateCapabilityChangePlans(
    sched,
    { participantId: P.id, lostCertifications: ['X'], window },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 5,
    },
  );

  assert(result.plans.length > 0, 'fc-light: at least one plan returned');
  const top = result.plans[0];
  // P kept 16h of work (2 of 3 assignments), retention = 16/24 = 0.67 > 0.5
  // → gate must NOT fire on the top plan.
  assert(top.focalContinuityExtended !== true, 'fc-light: top plan has no focal-continuity extension');
}

// ─── Test 11 — middle band: new OR-gate fires where old AND-gate skipped ────

console.log('\n── Test 11: middle-band (retention ≈ 0.6) — new OR-gate catches what old AND-gate missed ──');
{
  // Scenario chosen to land SQUARELY inside the 50–70% retention band, not
  // at the 0.5 boundary, so the test proves the new gate catches the intended
  // cohort.
  //
  // Pool (all L0, equal capacity):
  //   P (focal, has cert X):   2 cert (16h) + 3 non-cert (24h) = 40h pre-loss
  //   T (cert X):              0h pre-loss
  //   Q (no cert):             5 non-cert (40h)
  //   R (no cert):             5 non-cert (40h)
  //
  // Window covers only P's 2 cert slots → P loses 16h, keeps 24h non-cert.
  // Depth-1: T is the only other cert holder → T takes both cert slots = 16h.
  //
  // Post-base: P=24, T=16, Q=40, R=40 = 120h, target=30 each.
  //   P retention = 24/40 = 0.6   (between 0.5 and 0.7 — middle band)
  //   P deficit   = 30 − 24 = 6   (above 3)
  //   Old gate: retention < 0.5 FAILS → AND fails → no extension.
  //   New gate: retention < 0.7 ✓  AND  deficit > 3 ✓  → FIRES.
  // Extension finds a Q/R slot whose displacement to P strictly improves
  // composite (L0 std dev drops from sqrt(108)≈10.4 to sqrt(76)≈8.7).
  const eng = new SchedulingEngine({}, undefined, undefined, 5);
  eng.setPeriod(base, 7);
  eng.setCertLabelSnapshot({ X: 'X-label' });

  // P's 2 cert slots
  const tPCert1 = createTimeBlockFromHours(base, 6, 14);
  const tPCert2 = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14);
  // P's 3 non-cert slots
  const tPNon1 = createTimeBlockFromHours(new Date(2026, 5, 3), 6, 14);
  const tPNon2 = createTimeBlockFromHours(new Date(2026, 5, 4), 6, 14);
  const tPNon3 = createTimeBlockFromHours(new Date(2026, 5, 5), 6, 14);
  // Q's 5 non-cert slots
  const tQ1 = createTimeBlockFromHours(base, 14, 22);
  const tQ2 = createTimeBlockFromHours(new Date(2026, 5, 2), 14, 22);
  const tQ3 = createTimeBlockFromHours(new Date(2026, 5, 3), 14, 22);
  const tQ4 = createTimeBlockFromHours(new Date(2026, 5, 4), 14, 22);
  const tQ5 = createTimeBlockFromHours(new Date(2026, 5, 5), 14, 22);
  // R's 5 non-cert slots
  const tR1 = createTimeBlockFromHours(new Date(2026, 5, 6), 6, 14);
  const tR2 = createTimeBlockFromHours(new Date(2026, 5, 7), 6, 14);
  const tR3 = createTimeBlockFromHours(new Date(2026, 5, 6), 14, 22);
  const tR4 = createTimeBlockFromHours(new Date(2026, 5, 7), 14, 22);
  const tR5 = createTimeBlockFromHours(new Date(2026, 5, 6), 22, 24);

  const mkTask = (id: string, tb: ReturnType<typeof createTimeBlockFromHours>, certs: string[]): Task => ({
    id,
    name: id,
    timeBlock: tb,
    requiredCount: 1,
    slots: [{ slotId: `${id}-s`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: certs }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  });
  const tasks = [
    mkTask('mb-pc1', tPCert1, ['X']),
    mkTask('mb-pc2', tPCert2, ['X']),
    mkTask('mb-pn1', tPNon1, []),
    mkTask('mb-pn2', tPNon2, []),
    mkTask('mb-pn3', tPNon3, []),
    mkTask('mb-q1', tQ1, []),
    mkTask('mb-q2', tQ2, []),
    mkTask('mb-q3', tQ3, []),
    mkTask('mb-q4', tQ4, []),
    mkTask('mb-q5', tQ5, []),
    mkTask('mb-r1', tR1, []),
    mkTask('mb-r2', tR2, []),
    mkTask('mb-r3', tR3, []),
    mkTask('mb-r4', tR4, []),
    mkTask('mb-r5', tR5, []),
  ];

  const mkP = (id: string, certs: string[]): Participant => ({
    id,
    name: id,
    level: Level.L0,
    certifications: certs,
    group: 'G',
    availability: wideAvail,
    dateUnavailability: [],
  });
  const P = mkP('mb-P', ['X']);
  const T = mkP('mb-T', ['X']);
  const Q = mkP('mb-Q', []);
  const R = mkP('mb-R', []);

  eng.addParticipants([P, T, Q, R]);
  eng.addTasks(tasks);
  const sched = eng.generateSchedule();

  // Pin assignments to the documented pre-loss shape.
  const pin = (taskId: string, pid: string) => {
    const a = sched.assignments.find((x) => x.taskId === taskId);
    if (a) a.participantId = pid;
  };
  pin('mb-pc1', 'mb-P');
  pin('mb-pc2', 'mb-P');
  pin('mb-pn1', 'mb-P');
  pin('mb-pn2', 'mb-P');
  pin('mb-pn3', 'mb-P');
  pin('mb-q1', 'mb-Q');
  pin('mb-q2', 'mb-Q');
  pin('mb-q3', 'mb-Q');
  pin('mb-q4', 'mb-Q');
  pin('mb-q5', 'mb-Q');
  pin('mb-r1', 'mb-R');
  pin('mb-r2', 'mb-R');
  pin('mb-r3', 'mb-R');
  pin('mb-r4', 'mb-R');
  pin('mb-r5', 'mb-R');
  eng.revalidateFull();
  const liveSched = eng.getSchedule()!;

  // Window covers ONLY the 2 cert slots.
  const window = {
    start: new Date(tPCert1.start.getTime() - 1_000),
    end: new Date(tPCert2.end.getTime() + 1_000),
  };

  const result = generateCapabilityChangePlans(
    liveSched,
    { participantId: 'mb-P', lostCertifications: ['X'], window },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(liveSched.tasks, liveSched.participants),
      maxPlans: 5,
    },
  );
  assert(result.plans.length > 0, 'mb: at least one plan returned');

  const extended = result.plans.filter((p) => p.focalContinuityExtended === true);
  assert(extended.length > 0, 'mb: extension fires for middle-band retention/deficit (would have skipped under old AND-gate)');
  if (extended.length > 0) {
    const ext = extended[0];
    assert(
      ext.swaps.some((sw) => sw.toParticipantId === 'mb-P'),
      'mb: extended plan moves focal P onto at least one additional slot',
    );
    assert((ext.focalContinuityHoursAdded ?? 0) > 0, 'mb: focalContinuityHoursAdded > 0');
    assert(ext.violations.length === 0, 'mb: extended plan passes full HC validation');
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  process.exit(0);
}
