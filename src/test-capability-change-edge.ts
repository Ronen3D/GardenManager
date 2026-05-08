/**
 * Edge-case tests for the mid-schedule **capability change** feature.
 *
 * Scope: window boundary semantics, multi-loss interaction, sameGroupRequired,
 * live-mode anchor, partial plans, malformed inputs, forbidden-cert relaxation,
 * disabled-HC interaction, inject + rescue integration.
 *
 * Run:  npx ts-node src/test-capability-change-edge.ts
 */

import { validateHardConstraints } from './constraints/hard-constraints';
import { computeScheduleScore, type ScoreContext } from './constraints/soft-constraints';
import {
  findCertAffectedAssignments,
  generateCapabilityChangePlans,
  upsertCapabilityLoss,
} from './engine/capability-change';
import { searchInjectionPlans } from './engine/inject';
import { generateRescuePlans } from './engine/rescue';
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
import type { CapabilityLoss } from './models/types';
import { computeAllCapacities } from './utils/capacity';

// ─── tiny test harness ───────────────────────────────────────────────────────

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

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── shared fixtures ────────────────────────────────────────────────────────

const base = new Date(2026, 5, 1); // 2026-06-01 00:00 (calendar)
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

interface MkScheduleOpts {
  capabilityLoss?: CapabilityLoss[];
  disabledHC?: ('HC-1' | 'HC-2' | 'HC-3' | 'HC-4' | 'HC-5' | 'HC-6' | 'HC-7' | 'HC-8' | 'HC-11' | 'HC-12' | 'HC-14' | 'HC-15')[];
}

function mkSchedule(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  opts?: MkScheduleOpts,
): Schedule {
  return {
    id: 'capch-edge-sched',
    tasks,
    participants,
    assignments,
    feasible: true,
    score: dummyScore,
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: {
      config: { ...DEFAULT_CONFIG },
      disabledHardConstraints: opts?.disabledHC ?? [],
      dayStartHour: 5,
    },
    periodStart: base,
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
    scheduleUnavailability: [],
    capabilityLoss: opts?.capabilityLoss,
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

function basicParticipant(
  id: string,
  certs: string[],
  group: string = 'G',
  level: Level = Level.L0,
): Participant {
  return {
    id,
    name: id,
    level,
    certifications: certs,
    group,
    availability: wideAvail,
    dateUnavailability: [],
  };
}

function basicTask(
  id: string,
  startHour: number,
  endHour: number,
  reqCerts: string[] = [],
  forbiddenCerts: string[] | undefined = undefined,
  sameGroupRequired: boolean = false,
  slotCount: number = 1,
): Task {
  const slots = Array.from({ length: slotCount }, (_, i) => ({
    slotId: `${id}-s${i + 1}`,
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: reqCerts,
    forbiddenCertifications: forbiddenCerts,
    label: `slot-${i + 1}`,
  }));
  return {
    id,
    name: id,
    timeBlock: createTimeBlockFromHours(base, startHour, endHour),
    requiredCount: slotCount,
    slots,
    sameGroupRequired,
    blocksConsecutive: false,
  };
}

function mkAssignment(id: string, taskId: string, slotId: string, pid: string): Assignment {
  return {
    id,
    taskId,
    slotId,
    participantId: pid,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
}

// ─── 1. Window boundary semantics ───────────────────────────────────────────

section('1. Window boundary semantics');
{
  const t = basicTask('t-bnd', 8, 12, ['certX']);
  const p = basicParticipant('pBnd', ['certX']);
  const a = mkAssignment('a-bnd', 't-bnd', 't-bnd-s1', 'pBnd');
  const sched = mkSchedule([t], [p, basicParticipant('pOther', [])], [a]);

  const tStart = t.timeBlock.start;
  const tEnd = t.timeBlock.end;
  const ms = (h: number, mn: number = 0) => new Date(tStart.getFullYear(), tStart.getMonth(), tStart.getDate(), h, mn);

  // Task ending exactly at window start → NOT affected
  const r1 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: tEnd, end: ms(20) } },
    earlyAnchor,
  );
  assert(r1.affected.length === 0, 'window-bnd: task ends exactly at window.start → NOT affected');

  // Task starting exactly at window end → NOT affected
  const r2 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: ms(4), end: tStart } },
    earlyAnchor,
  );
  assert(r2.affected.length === 0, 'window-bnd: task starts exactly at window.end → NOT affected');

  // Task fully inside window
  const r3 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: ms(6), end: ms(20) } },
    earlyAnchor,
  );
  assert(r3.affected.length === 1, 'window-bnd: task fully inside window → affected');

  // Window crosses task start (window starts before, ends inside task)
  const r4 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: ms(6), end: ms(10) } },
    earlyAnchor,
  );
  assert(r4.affected.length === 1, 'window-bnd: window covers task start → affected');

  // Window crosses task end
  const r5 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: ms(10), end: ms(14) } },
    earlyAnchor,
  );
  assert(r5.affected.length === 1, 'window-bnd: window covers task end → affected');

  // Window fully inside the task
  const r6 = findCertAffectedAssignments(
    sched,
    { participantId: 'pBnd', lostCertifications: ['certX'], window: { start: ms(9), end: ms(11) } },
    earlyAnchor,
  );
  assert(r6.affected.length === 1, 'window-bnd: task fully contains window → affected');
}

// ─── 2. Multiple capability-loss entries interacting ────────────────────────

section('2. Multiple capability-loss entries interacting');
{
  // Build a task in the *intersection* of two cap-loss windows.
  const t = basicTask('t-multi', 10, 12, ['certX']); // alt slot will require Y / Z
  const tY = basicTask('t-multi-y', 10, 12, ['certY']);
  const tZ = basicTask('t-multi-z', 10, 12, ['certZ']);
  const p = basicParticipant('pMulti', ['certX', 'certY', 'certZ']);
  const aX = mkAssignment('a-mx', 't-multi', 't-multi-s1', 'pMulti');
  const aY = mkAssignment('a-my', 't-multi-y', 't-multi-y-s1', 'pMulti');
  const aZ = mkAssignment('a-mz', 't-multi-z', 't-multi-z-s1', 'pMulti');

  const winW1 = { start: new Date(2026, 5, 1, 8, 0), end: new Date(2026, 5, 1, 14, 0) };
  const winW2 = { start: new Date(2026, 5, 1, 11, 0), end: new Date(2026, 5, 1, 18, 0) };

  // Two existing cap-loss entries on the schedule:
  //  - one for pMulti losing certX in W1
  //  - one for pMulti losing certY in W2
  const existingLosses: CapabilityLoss[] = [
    {
      id: 'cl-x',
      participantId: 'pMulti',
      lostCertifications: ['certX'],
      start: winW1.start,
      end: winW1.end,
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
    {
      id: 'cl-y',
      participantId: 'pMulti',
      lostCertifications: ['certY'],
      start: winW2.start,
      end: winW2.end,
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];

  const sched = mkSchedule([t, tY, tZ], [p, basicParticipant('pNone', [])], [aX, aY, aZ], {
    capabilityLoss: existingLosses,
  });

  // Use validateHardConstraints with extraCapabilityLoss to simulate the
  // schedule's effective state — HC-2 should reject pMulti for X and Y, but
  // NOT for Z (still held).
  const losses = existingLosses.map((c) => ({
    participantId: c.participantId,
    lostCertifications: c.lostCertifications,
    start: c.start,
    end: c.end,
  }));
  const v = validateHardConstraints(
    sched.tasks,
    sched.participants,
    sched.assignments,
    new Set(),
    undefined,
    undefined,
    [],
    undefined,
    losses,
  );
  const certViolForX = v.violations.filter(
    (vv) => vv.code === 'CERT_MISSING' && vv.taskId === 't-multi' && vv.participantId === 'pMulti',
  );
  const certViolForY = v.violations.filter(
    (vv) => vv.code === 'CERT_MISSING' && vv.taskId === 't-multi-y' && vv.participantId === 'pMulti',
  );
  const certViolForZ = v.violations.filter(
    (vv) => vv.code === 'CERT_MISSING' && vv.taskId === 't-multi-z' && vv.participantId === 'pMulti',
  );
  assert(certViolForX.length === 1, 'multi-cl: task in W1∩W2 requiring X → HC-2 fires (X lost)');
  assert(certViolForY.length === 1, 'multi-cl: task in W1∩W2 requiring Y → HC-2 fires (Y lost)');
  assert(certViolForZ.length === 0, 'multi-cl: task in W1∩W2 requiring Z → HC-2 silent (Z still held)');

  // ── upsert merge tests ──
  // Same {X} cert set + overlapping window → MERGE (1 entry, union window)
  const mergedSame = upsertCapabilityLoss([existingLosses[0]], {
    id: 'cl-x-2',
    participantId: 'pMulti',
    lostCertifications: ['certX'],
    start: new Date(2026, 5, 1, 12, 0), // overlaps existing 8..14
    end: new Date(2026, 5, 1, 16, 0),
    createdAt: new Date(),
    anchorAtCreation: earlyAnchor,
  });
  assert(mergedSame.length === 1, 'upsert: same {X} overlapping → merged into one entry');
  if (mergedSame.length === 1) {
    const merged = mergedSame[0];
    assert(
      merged.start.getTime() === winW1.start.getTime() &&
        merged.end.getTime() === new Date(2026, 5, 1, 16, 0).getTime(),
      'upsert: merged entry has union window (8..16)',
    );
  }

  // {X,Y} that overlaps existing {X} → NOT merged (different cert sets)
  const mergedDiff = upsertCapabilityLoss([existingLosses[0]], {
    id: 'cl-xy',
    participantId: 'pMulti',
    lostCertifications: ['certX', 'certY'],
    start: new Date(2026, 5, 1, 12, 0),
    end: new Date(2026, 5, 1, 16, 0),
    createdAt: new Date(),
    anchorAtCreation: earlyAnchor,
  });
  assert(mergedDiff.length === 2, 'upsert: {X,Y} vs existing {X} (overlapping) → NOT merged');
}

// ─── 3. sameGroupRequired interaction ───────────────────────────────────────

section('3. sameGroupRequired interaction');
{
  // 2-slot task, both require certX, sameGroupRequired
  const t = basicTask('t-sg', 10, 12, ['certX'], undefined, true, 2);
  const p = basicParticipant('pSG', ['certX'], 'A');
  const p2 = basicParticipant('pSG2', ['certX'], 'A');
  const p3 = basicParticipant('pSG3', ['certX'], 'A'); // group A replacement candidate
  const p4 = basicParticipant('pSG4', ['certX'], 'B'); // group B - must NOT appear
  const aP = mkAssignment('a-sg-1', 't-sg', 't-sg-s1', 'pSG');
  const aP2 = mkAssignment('a-sg-2', 't-sg', 't-sg-s2', 'pSG2');

  const sched = mkSchedule([t], [p, p2, p3, p4], [aP, aP2]);

  // (a) affected detector: only pSG's slot requires the lost cert *for pSG* —
  // pSG2 also requires X but is NOT focal so should be untouched.
  const det = findCertAffectedAssignments(
    sched,
    {
      participantId: 'pSG',
      lostCertifications: ['certX'],
      window: { start: new Date(2026, 5, 1, 8, 0), end: new Date(2026, 5, 1, 14, 0) },
    },
    earlyAnchor,
  );
  assert(
    det.affected.length === 1 && det.affected[0].assignment.id === 'a-sg-1',
    'sameGroup: affected detector picks up only focal participant\'s slot',
  );

  // (b) planner: replacement must come from group A
  const result = generateCapabilityChangePlans(
    sched,
    {
      participantId: 'pSG',
      lostCertifications: ['certX'],
      window: { start: new Date(2026, 5, 1, 8, 0), end: new Date(2026, 5, 1, 14, 0) },
    },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 5,
    },
  );
  assert(result.plans.length > 0, 'sameGroup: planner finds at least one plan');
  if (result.plans.length > 0) {
    const usesP4 = result.plans.some((pl) => pl.swaps.some((sw) => sw.toParticipantId === 'pSG4'));
    const usesP3 = result.plans.some((pl) => pl.swaps.some((sw) => sw.toParticipantId === 'pSG3'));
    assert(!usesP4, 'sameGroup: no plan uses pSG4 (group B violates HC-4)');
    assert(usesP3, 'sameGroup: at least one plan uses pSG3 (group A)');
  }
}

// ─── 4. Live-mode anchor semantics ──────────────────────────────────────────

section('4. Live-mode anchor semantics');
{
  // periodStart = base (2026-06-01 00:00). dayStartHour = 5 means op-day 1 is
  // 2026-06-01 05:00 .. 2026-06-02 05:00. Anchor at "day 3 noon" =
  // 2026-06-03 12:00. Day 2 task = 2026-06-02 (before anchor, past); day 4
  // task = 2026-06-04 (future).
  const day2Task: Task = {
    id: 't-d2',
    name: 'd2',
    timeBlock: {
      start: new Date(2026, 5, 2, 10, 0),
      end: new Date(2026, 5, 2, 14, 0),
    },
    requiredCount: 1,
    slots: [
      { slotId: 't-d2-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['certX'], label: 'd2' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const day4Task: Task = {
    id: 't-d4',
    name: 'd4',
    timeBlock: {
      start: new Date(2026, 5, 4, 10, 0),
      end: new Date(2026, 5, 4, 14, 0),
    },
    requiredCount: 1,
    slots: [
      { slotId: 't-d4-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['certX'], label: 'd4' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const p = basicParticipant('pLM', ['certX']);
  const aPast = mkAssignment('a-past', 't-d2', 't-d2-s1', 'pLM');
  const aFuture = mkAssignment('a-future', 't-d4', 't-d4-s1', 'pLM');
  const sched = mkSchedule([day2Task, day4Task], [p, basicParticipant('pOther', ['certX'])], [aPast, aFuture]);

  const anchor = new Date(2026, 5, 3, 12, 0);
  // Window covers the whole period (day 1 → day 7).
  const window = {
    start: new Date(2026, 5, 1, 0, 0),
    end: new Date(2026, 5, 8, 0, 0),
  };
  const det = findCertAffectedAssignments(
    sched,
    { participantId: 'pLM', lostCertifications: ['certX'], window },
    anchor,
  );
  assert(
    det.affected.length === 1 && det.affected[0].assignment.id === 'a-future',
    'live-mode: future assignment classified as affected',
  );
  assert(
    det.lockedInPast.length === 1 && det.lockedInPast[0].assignment.id === 'a-past',
    'live-mode: past assignment classified as lockedInPast',
  );

  // Run planner: must NOT vacate the past assignment.
  const result = generateCapabilityChangePlans(
    sched,
    { participantId: 'pLM', lostCertifications: ['certX'], window },
    anchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 3,
    },
  );
  // At least: planner reports affected=[future] and lockedInPast=[past].
  assert(
    result.affected.length === 1 && result.affected[0].assignment.id === 'a-future',
    'live-mode planner: affected = future assignment',
  );
  assert(
    result.lockedInPast.length === 1 && result.lockedInPast[0].assignment.id === 'a-past',
    'live-mode planner: lockedInPast = past assignment',
  );
  // No plan touches the past assignment.
  const planTouchesPast = result.plans.some((pl) => pl.swaps.some((sw) => sw.assignmentId === 'a-past'));
  assert(!planTouchesPast, 'live-mode planner: no plan attempts to swap the past-frozen assignment');
}

// ─── 5. infeasibleAssignmentIds correctness ─────────────────────────────────

section('5. infeasibleAssignmentIds correctness');
{
  // Task A requires rare-cert (only pInf holds it → can't be replaced when
  // pInf loses it). Task B requires certX (pInf and pAlt hold it).
  const tA = basicTask('t-rare', 10, 12, ['rare-cert']);
  const tB = basicTask('t-easy', 13, 15, ['certX']);
  const pInf = basicParticipant('pInf', ['rare-cert', 'certX']);
  const pAlt = basicParticipant('pAlt', ['certX']); // can fill tB but NOT tA
  const aRare = mkAssignment('a-rare', 't-rare', 't-rare-s1', 'pInf');
  const aEasy = mkAssignment('a-easy', 't-easy', 't-easy-s1', 'pInf');

  const sched = mkSchedule([tA, tB], [pInf, pAlt, basicParticipant('pNoCert', [])], [aRare, aEasy]);

  const result = generateCapabilityChangePlans(
    sched,
    {
      participantId: 'pInf',
      lostCertifications: ['rare-cert', 'certX'],
      window: { start: new Date(2026, 5, 1, 8, 0), end: new Date(2026, 5, 1, 18, 0) },
    },
    earlyAnchor,
    {
      config: { ...DEFAULT_CONFIG },
      scoreCtx: buildScoreCtx(sched.tasks, sched.participants),
      maxPlans: 3,
    },
  );
  assert(
    result.infeasibleAssignmentIds.includes('a-rare') && !result.infeasibleAssignmentIds.includes('a-easy'),
    'infeasibleIds: rare-cert assignment infeasible, easy assignment solvable',
  );
  assert(result.plans.length > 0, 'infeasibleIds: planner returns at least one (partial) plan');
  if (result.plans.length > 0) {
    assert(
      result.plans.every((pl) => pl.isPartial),
      'infeasibleIds: every returned plan is flagged isPartial',
    );
    // All plans only swap a-easy (never a-rare).
    const allOnlyTouchEasy = result.plans.every((pl) =>
      pl.swaps.every((sw) => sw.assignmentId === 'a-easy'),
    );
    assert(allOnlyTouchEasy, 'infeasibleIds: partial plans only swap the solvable slot');
  }
}

// ─── 6. Empty / malformed inputs ────────────────────────────────────────────

section('6. Empty / malformed inputs');
{
  const t = basicTask('t-mal', 10, 12, ['certX']);
  const p = basicParticipant('pMal', ['certX']);
  const a = mkAssignment('a-mal', 't-mal', 't-mal-s1', 'pMal');
  const sched = mkSchedule([t], [p, basicParticipant('pAlt', ['certX'])], [a]);
  const wholeWindow = { start: new Date(2026, 5, 1, 0, 0), end: new Date(2026, 5, 8, 0, 0) };

  // (a) lostCertifications: []
  const r1 = findCertAffectedAssignments(
    sched,
    { participantId: 'pMal', lostCertifications: [], window: wholeWindow },
    earlyAnchor,
  );
  assert(r1.affected.length === 0, 'malformed: lostCertifications=[] → 0 affected');

  // (b) lostCertifications: ['NONEXISTENT_CERT']
  const r2 = findCertAffectedAssignments(
    sched,
    { participantId: 'pMal', lostCertifications: ['NONEXISTENT_CERT'], window: wholeWindow },
    earlyAnchor,
  );
  assert(r2.affected.length === 0, 'malformed: nonexistent cert → 0 affected');

  // (c) Degenerate window where end <= start.
  // Goal: confirm the planner does not crash. Document the actual behavior.
  let crashed = false;
  let count = -1;
  try {
    const r3 = findCertAffectedAssignments(
      sched,
      {
        participantId: 'pMal',
        lostCertifications: ['certX'],
        window: { start: new Date(2026, 5, 1, 12, 0), end: new Date(2026, 5, 1, 12, 0) },
      },
      earlyAnchor,
    );
    count = r3.affected.length;
  } catch (_e) {
    crashed = true;
  }
  assert(!crashed, 'malformed: zero-length window does not crash');
  // Note: blocksOverlap requires strict less-than, so a zero-length window
  // strictly inside the task can still match (8 < 12 ∧ 12 < 12 → false here,
  // but the strict interpretation depends on the exact instant). Document
  // the observed value.
  console.log(`     (info) zero-length window inside task → affected.length = ${count}`);

  // Inverted window (end < start): document; check no crash.
  let crashed2 = false;
  let count2 = -1;
  try {
    const r4 = findCertAffectedAssignments(
      sched,
      {
        participantId: 'pMal',
        lostCertifications: ['certX'],
        window: { start: new Date(2026, 5, 1, 14, 0), end: new Date(2026, 5, 1, 8, 0) },
      },
      earlyAnchor,
    );
    count2 = r4.affected.length;
  } catch (_e) {
    crashed2 = true;
  }
  assert(!crashed2, 'malformed: inverted window does not crash');
  console.log(`     (info) inverted window (end<start) → affected.length = ${count2}`);
}

// ─── 7. Forbidden-cert relaxation symmetry ──────────────────────────────────

section('7. Forbidden-cert relaxation symmetry');
{
  const t = basicTask('t-fb', 10, 12, [], ['Hamama']);
  const pH = basicParticipant('pH', ['Hamama']); // Hamama is forbidden by slot
  const pClean = basicParticipant('pClean', []);
  const sched = mkSchedule([t], [pH, pClean], []);

  // Without override: pH should NOT be eligible (HC-11)
  const eligNoOverride = getEligibleParticipantsForSlot(t, 't-fb-s1', sched.participants, [], sched.tasks);
  const phInBaseline = eligNoOverride.some((p) => p.id === 'pH');
  assert(!phInBaseline, 'forbidden-relax: baseline excludes pH (HC-11)');

  // With cap-loss removing Hamama from pH for window covering t → pH eligible
  const losses = [
    {
      participantId: 'pH',
      lostCertifications: ['Hamama'],
      start: new Date(2026, 5, 1, 8, 0),
      end: new Date(2026, 5, 1, 14, 0),
    },
  ];
  const eligOverride = getEligibleParticipantsForSlot(
    t,
    't-fb-s1',
    sched.participants,
    [],
    sched.tasks,
    undefined,
    undefined,
    [],
    undefined,
    losses,
  );
  const phInOverride = eligOverride.some((p) => p.id === 'pH');
  assert(phInOverride, 'forbidden-relax: override (cap-loss removing Hamama) makes pH eligible');

  // Validate via validateHardConstraints: place pH and confirm no HC-11 violation
  const aPH = mkAssignment('a-fb', 't-fb', 't-fb-s1', 'pH');
  const v = validateHardConstraints(
    [t],
    sched.participants,
    [aPH],
    new Set(),
    undefined,
    undefined,
    [],
    undefined,
    losses,
  );
  const hc11Violations = v.violations.filter((vv) => vv.code === 'EXCLUDED_CERTIFICATION');
  assert(hc11Violations.length === 0, 'forbidden-relax: validateHardConstraints emits no HC-11 with override applied');
}

// ─── 8. Disabled-HC interaction (HC-2 globally off) ─────────────────────────

section('8. Disabled-HC interaction (HC-2 globally disabled)');
{
  const t = basicTask('t-d2', 10, 12, ['certX']);
  const p = basicParticipant('pD2', ['certX']);
  const a = mkAssignment('a-d2', 't-d2', 't-d2-s1', 'pD2');

  // Schedule with HC-2 disabled
  const losses: CapabilityLoss[] = [
    {
      id: 'cl-d2',
      participantId: 'pD2',
      lostCertifications: ['certX'],
      start: new Date(2026, 5, 1, 8, 0),
      end: new Date(2026, 5, 1, 14, 0),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  const sched = mkSchedule([t], [p], [a], { capabilityLoss: losses, disabledHC: ['HC-2'] });

  const engine = new SchedulingEngine({}, new Set(['HC-2']), undefined, 5);
  engine.addParticipants(sched.participants);
  engine.addTasks(sched.tasks);
  engine.setPeriod(sched.periodStart, sched.periodDays);
  engine.importSchedule(sched);
  engine.revalidateFull();

  const refreshed = engine.getSchedule();
  const hc2Violations = refreshed!.violations.filter((vv) => vv.code === 'CERT_MISSING');
  assert(hc2Violations.length === 0, 'disabled-HC: HC-2 disabled + cap-loss → no HC-2 violation');
}

// ─── 9. Inject + capability-loss interaction ────────────────────────────────

section('9. Inject + capability-loss interaction');
{
  // Pre-existing schedule has nothing on day 4. We inject a NEW task on day 4
  // requiring certX. P holds certX but is in cap-loss for that day.
  const losses: CapabilityLoss[] = [
    {
      id: 'cl-inj',
      participantId: 'pInj',
      lostCertifications: ['certX'],
      start: new Date(2026, 5, 4, 5, 0),
      end: new Date(2026, 5, 4, 23, 0),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  const pInj = basicParticipant('pInj', ['certX']);
  const pBackup = basicParticipant('pBackup', ['certX']); // valid candidate
  const pNone = basicParticipant('pNone', []); // can't fill the slot
  const sched = mkSchedule([], [pInj, pBackup, pNone], [], { capabilityLoss: losses });

  const engine = new SchedulingEngine({}, undefined, undefined, 5);
  engine.addParticipants(sched.participants);
  engine.setPeriod(sched.periodStart, sched.periodDays);
  engine.importSchedule(sched);

  const r = searchInjectionPlans(
    engine,
    {
      name: 'inj-test',
      dayIndex: 4,
      startHour: 10,
      startMinute: 0,
      durationHours: 2,
      subTeams: [],
      slots: [
        { id: 'inj-s', label: 'X-slot', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['certX'] },
      ],
      sameGroupRequired: false,
      blocksConsecutive: false,
    },
    { anchor: earlyAnchor },
  );
  assert(r.result !== null, 'inject+capLoss: search returns a result');
  if (r.result) {
    const plans = r.result.plans;
    const usesPInj = plans.some((pl) =>
      pl.outcomes.some((o) => o.filled && o.participantId === 'pInj'),
    );
    assert(!usesPInj, 'inject+capLoss: pInj never picked as a candidate');
    const anyFilledByBackup = plans.some((pl) =>
      pl.outcomes.some((o) => o.filled && o.participantId === 'pBackup'),
    );
    assert(anyFilledByBackup, 'inject+capLoss: pBackup fills the slot in some plan');
    // Cleanup
    r.result.cancel();
  }
}

// ─── 10. Rescue (single-slot) honors cap-loss ───────────────────────────────

section('10. Rescue (single-slot) honors cap-loss');
{
  // Two tasks, both day 4 / time 10-12 / require certX. P is the candidate
  // we want to test cap-loss against. Create a vacated slot and verify P is
  // not picked.
  const tV = basicTask('t-resc-v', 10, 12, ['certX']);
  // Move tV to day 4 to align with cap-loss window
  tV.timeBlock = {
    start: new Date(2026, 5, 4, 10, 0),
    end: new Date(2026, 5, 4, 12, 0),
  };
  const losses: CapabilityLoss[] = [
    {
      id: 'cl-resc',
      participantId: 'pResc',
      lostCertifications: ['certX'],
      start: new Date(2026, 5, 4, 5, 0),
      end: new Date(2026, 5, 4, 23, 0),
      createdAt: new Date(),
      anchorAtCreation: earlyAnchor,
    },
  ];
  const vacatedHolder = basicParticipant('pHolder', ['certX']);
  const pResc = basicParticipant('pResc', ['certX']); // should NOT be candidate
  const pBackup = basicParticipant('pBackup', ['certX']); // should be candidate
  const aV = mkAssignment('a-resc', 't-resc-v', 't-resc-v-s1', 'pHolder');
  const sched = mkSchedule(
    [tV],
    [vacatedHolder, pResc, pBackup, basicParticipant('pNo', [])],
    [aV],
    { capabilityLoss: losses },
  );

  const result = generateRescuePlans(
    sched,
    { vacatedAssignmentId: 'a-resc', taskId: 't-resc-v', slotId: 't-resc-v-s1', vacatedBy: 'pHolder' },
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
  assert(result.plans.length > 0, 'rescue+capLoss: at least one plan exists (pBackup)');
  if (result.plans.length > 0) {
    const usesPResc = result.plans.some((pl) =>
      pl.swaps.some((sw) => sw.toParticipantId === 'pResc'),
    );
    assert(!usesPResc, 'rescue+capLoss: pResc never picked (cert lost during the task window)');
    const usesPBackup = result.plans.some((pl) =>
      pl.swaps.some((sw) => sw.toParticipantId === 'pBackup'),
    );
    assert(usesPBackup, 'rescue+capLoss: pBackup picked as a candidate');
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('');
console.log('────────────────────────────────────────');
console.log(`Capability-change edge-case tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
