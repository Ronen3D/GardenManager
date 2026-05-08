/**
 * Unit tests for the mid-schedule capability-change feature.
 *
 * Covers:
 *   1. effectiveCertsForTask / effectiveCertsAt (cert override helper)
 *   2. HC-2 / HC-11 via validateHardConstraints with extraCapabilityLoss
 *   3. upsertCapabilityLoss merge semantics
 *   4. findCertAffectedAssignments predicate
 *   5. generateCapabilityChangePlans smoke tests
 *
 * Run: npx ts-node src/test-capability-change-unit.ts
 */

import {
  checkCertificationRequirement,
  checkForbiddenCertifications,
  validateHardConstraints,
} from './constraints/hard-constraints';
import type { ScoreContext } from './constraints/soft-constraints';
import {
  findCertAffectedAssignments,
  generateCapabilityChangePlans,
  upsertCapabilityLoss,
} from './engine/capability-change';
import { effectiveCertsForTask } from './engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_ALGORITHM_SETTINGS,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Schedule,
  type SlotRequirement,
  type Task,
} from './models/types';

// ─── Tiny test runner ───────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _currentSection = '';

function section(name: string): void {
  _currentSection = name;
  console.log(`\n── ${name} ──────────────────────────────`);
}

function assert(cond: boolean, msg: string): void {
  if (cond) {
    _passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    _failed++;
    console.log(`  ✗ FAIL: [${_currentSection}] ${msg}`);
  }
}

// ─── Fixture builders ───────────────────────────────────────────────────────

const D = (y: number, m: number, d: number, h: number = 0, min: number = 0): Date =>
  new Date(y, m, d, h, min, 0, 0);

const FULL_AVAIL = [{ start: D(2026, 4, 1, 0), end: D(2026, 5, 31, 23, 59) }];

function mkParticipant(overrides: Partial<Participant> & { id: string; name: string }): Participant {
  return {
    level: Level.L0,
    certifications: [],
    group: 'G',
    availability: FULL_AVAIL,
    dateUnavailability: [],
    ...overrides,
  };
}

let _slotIdCounter = 0;
function mkSlot(overrides: Partial<SlotRequirement> = {}): SlotRequirement {
  return {
    slotId: `slot-${++_slotIdCounter}`,
    acceptableLevels: [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
    requiredCertifications: [],
    ...overrides,
  };
}

let _taskIdCounter = 0;
function mkTask(overrides: Partial<Task> & { timeBlock: Task['timeBlock'] }): Task {
  return {
    id: `task-${++_taskIdCounter}`,
    name: `Task ${_taskIdCounter}`,
    sourceName: `Task ${_taskIdCounter}`,
    requiredCount: 1,
    slots: [mkSlot()],
    sameGroupRequired: false,
    blocksConsecutive: false,
    ...overrides,
  };
}

let _assignmentIdCounter = 0;
function mkAssignment(taskId: string, slotId: string, participantId: string): Assignment {
  return {
    id: `a-${++_assignmentIdCounter}`,
    taskId,
    slotId,
    participantId,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
}

function mkSchedule(overrides: Partial<Schedule> & {
  tasks: Task[];
  participants: Participant[];
  assignments: Assignment[];
}): Schedule {
  return {
    id: `sch-${Date.now()}`,
    feasible: true,
    score: {
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
    },
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { ...DEFAULT_ALGORITHM_SETTINGS },
    periodStart: D(2026, 4, 1, 5),
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
    scheduleUnavailability: [],
    capabilityLoss: [],
    ...overrides,
  };
}

function mkScoreCtx(schedule: Schedule): ScoreContext {
  const taskMap = new Map(schedule.tasks.map((t) => [t.id, t] as const));
  const pMap = new Map(schedule.participants.map((p) => [p.id, p] as const));
  return { taskMap, pMap, dayStartHour: 5 };
}

// ─── Section 1: effectiveCertsForTask ───────────────────────────────────────

section('effectiveCertsForTask');

{
  const p = mkParticipant({ id: 'p1', name: 'P1', certifications: ['X', 'Y'] });
  const task = mkTask({ timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 16) } });

  // 1a. Pass-through with no losses
  const e1 = effectiveCertsForTask(p, task, undefined);
  assert(e1.has('X') === true, 'pass-through: has(X) === certifications.includes(X)');
  assert(e1.has('Y') === true, 'pass-through: has(Y) === certifications.includes(Y)');
  assert(e1.has('Z') === false, 'pass-through: has(Z) false (not in certifications)');

  const e1b = effectiveCertsForTask(p, task, []);
  assert(e1b.has('X') === true, 'pass-through with empty losses array');

  // 1b. Matching loss but non-overlapping window
  const lossesNonOverlap = [
    {
      participantId: 'p1',
      lostCertifications: ['X'],
      start: D(2026, 4, 6, 0),
      end: D(2026, 4, 6, 23),
    },
  ];
  const e2 = effectiveCertsForTask(p, task, lossesNonOverlap);
  assert(e2.has('X') === true, 'non-overlapping window: X still present');
  assert(e2.has('Y') === true, 'non-overlapping window: Y still present');

  // 1c. Overlapping window: cert removed
  const lossesOverlap = [
    {
      participantId: 'p1',
      lostCertifications: ['X'],
      start: D(2026, 4, 5, 0),
      end: D(2026, 4, 5, 23),
    },
  ];
  const e3 = effectiveCertsForTask(p, task, lossesOverlap);
  assert(e3.has('X') === false, 'overlapping window: X treated as absent');
  assert(e3.has('Y') === true, 'overlapping window: Y still present');

  // 1d. Multiple overlapping losses: union removed
  const lossesMulti = [
    {
      participantId: 'p1',
      lostCertifications: ['X'],
      start: D(2026, 4, 5, 0),
      end: D(2026, 4, 5, 12),
    },
    {
      participantId: 'p1',
      lostCertifications: ['Y'],
      start: D(2026, 4, 5, 10),
      end: D(2026, 4, 5, 23),
    },
  ];
  const e4 = effectiveCertsForTask(p, task, lossesMulti);
  assert(e4.has('X') === false, 'multi losses: X removed (union)');
  assert(e4.has('Y') === false, 'multi losses: Y removed (union)');

  // 1e. Loss for different participant: ignored
  const lossesOtherP = [
    {
      participantId: 'other',
      lostCertifications: ['X'],
      start: D(2026, 4, 5, 0),
      end: D(2026, 4, 5, 23),
    },
  ];
  const e5 = effectiveCertsForTask(p, task, lossesOtherP);
  assert(e5.has('X') === true, 'loss for other participant ignored: X still present');
  assert(e5.has('Y') === true, 'loss for other participant ignored: Y still present');
}

// ─── Section 2: HC-2 / HC-11 via validateHardConstraints ────────────────────

section('HC-2 / HC-11 with extraCapabilityLoss');

{
  // HC-2 baseline: P holds X; slot requires X.
  const p = mkParticipant({ id: 'p1', name: 'P1', certifications: ['X'] });
  const slot = mkSlot({ requiredCertifications: ['X'] });
  const task = mkTask({
    timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 16) },
    slots: [slot],
  });
  const a = mkAssignment(task.id, slot.slotId, p.id);

  // Without override: no HC-2 violation
  const r0 = validateHardConstraints([task], [p], [a]);
  const certMissingNoOverride = r0.violations.some((v) => v.code === 'CERT_MISSING' && v.participantId === p.id);
  assert(!certMissingNoOverride, 'HC-2: no violation when P holds the required cert (no override)');

  // With matching override: HC-2 fires
  const lossesMatch = [
    {
      participantId: p.id,
      lostCertifications: ['X'],
      start: D(2026, 4, 5, 0),
      end: D(2026, 4, 5, 23),
    },
  ];
  const r1 = validateHardConstraints([task], [p], [a], undefined, undefined, undefined, undefined, undefined, lossesMatch);
  const certMissingWithOverride = r1.violations.some(
    (v) => v.code === 'CERT_MISSING' && v.participantId === p.id,
  );
  assert(certMissingWithOverride, 'HC-2: violation appears when matching override removes the cert');

  // Direct unit-level call to checkCertificationRequirement with override
  const v = checkCertificationRequirement(p, task, slot.slotId, undefined, lossesMatch);
  assert(v !== null && v.code === 'CERT_MISSING', 'checkCertificationRequirement returns CERT_MISSING with override');

  // HC-2 disabled: no violation even with override
  const disabled2 = new Set<string>(['HC-2']);
  const r2 = validateHardConstraints([task], [p], [a], disabled2, undefined, undefined, undefined, undefined, lossesMatch);
  const certMissingDisabled = r2.violations.some((v) => v.code === 'CERT_MISSING' && v.participantId === p.id);
  assert(!certMissingDisabled, 'HC-2 disabled: override does not re-impose CERT_MISSING');
}

{
  // HC-11 baseline: P holds Y; slot forbids Y.
  const p = mkParticipant({ id: 'p2', name: 'P2', certifications: ['Y'] });
  const slot = mkSlot({ forbiddenCertifications: ['Y'] });
  const task = mkTask({
    timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 16) },
    slots: [slot],
  });
  const a = mkAssignment(task.id, slot.slotId, p.id);

  // Without override: HC-11 fires
  const r0 = validateHardConstraints([task], [p], [a]);
  const excludedNoOverride = r0.violations.some(
    (v) => v.code === 'EXCLUDED_CERTIFICATION' && v.participantId === p.id,
  );
  assert(excludedNoOverride, 'HC-11: violation present when P holds forbidden cert (no override)');

  // With matching override removing Y: HC-11 should NOT fire
  const lossesMatch = [
    {
      participantId: p.id,
      lostCertifications: ['Y'],
      start: D(2026, 4, 5, 0),
      end: D(2026, 4, 5, 23),
    },
  ];
  const r1 = validateHardConstraints([task], [p], [a], undefined, undefined, undefined, undefined, undefined, lossesMatch);
  const excludedWithOverride = r1.violations.some(
    (v) => v.code === 'EXCLUDED_CERTIFICATION' && v.participantId === p.id,
  );
  assert(!excludedWithOverride, 'HC-11: violation silenced by symmetric capability-loss override');

  // Direct unit-level call to checkForbiddenCertifications
  const pMap = new Map([[p.id, p]]);
  const directViolations = checkForbiddenCertifications(task, [a], pMap, undefined, lossesMatch);
  assert(directViolations.length === 0, 'checkForbiddenCertifications returns no violations with matching override');

  const directViolationsNoOverride = checkForbiddenCertifications(task, [a], pMap);
  assert(directViolationsNoOverride.length === 1, 'checkForbiddenCertifications returns 1 violation without override');

  // HC-11 disabled: no violation regardless of override
  const disabled11 = new Set<string>(['HC-11']);
  const r2 = validateHardConstraints([task], [p], [a], disabled11);
  const excludedDisabled = r2.violations.some(
    (v) => v.code === 'EXCLUDED_CERTIFICATION' && v.participantId === p.id,
  );
  assert(!excludedDisabled, 'HC-11 disabled: no EXCLUDED_CERTIFICATION violation (no override needed)');
}

// ─── Section 3: upsertCapabilityLoss merge semantics ────────────────────────

section('upsertCapabilityLoss merge semantics');

{
  const baseTime = D(2026, 4, 5, 0);
  const mkEntry = (
    id: string,
    pid: string,
    certs: string[],
    startOffsetH: number,
    endOffsetH: number,
  ) => ({
    id,
    participantId: pid,
    lostCertifications: certs,
    start: new Date(baseTime.getTime() + startOffsetH * 3600000),
    end: new Date(baseTime.getTime() + endOffsetH * 3600000),
    createdAt: new Date(),
    anchorAtCreation: baseTime,
  });

  // 3a. Empty existing → new entry appended
  {
    const result = upsertCapabilityLoss(undefined, mkEntry('e1', 'p1', ['X'], 0, 24));
    assert(result.length === 1, 'empty existing: result has 1 entry');
    assert(result[0].id === 'e1', 'empty existing: entry preserved');
  }

  {
    const result = upsertCapabilityLoss([], mkEntry('e1', 'p1', ['X'], 0, 24));
    assert(result.length === 1, 'empty array existing: result has 1 entry');
  }

  // 3b. Non-overlapping, same participant + same cert set → both kept
  {
    const existing = [
      {
        ...mkEntry('e1', 'p1', ['X'], 0, 24),
      },
    ];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p1', ['X'], 48, 72));
    assert(result.length === 2, 'non-overlapping same set: both kept');
  }

  // 3c. Overlapping, same participant + same cert set → merged (window union)
  {
    const existing = [{ ...mkEntry('e1', 'p1', ['X'], 0, 24) }];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p1', ['X'], 12, 36));
    assert(result.length === 1, 'overlapping same set: merged into 1 entry');
    const merged = result[0];
    assert(merged.start.getTime() === baseTime.getTime(), 'merged start = earliest of two starts');
    assert(
      merged.end.getTime() === baseTime.getTime() + 36 * 3600000,
      'merged end = latest of two ends',
    );
  }

  // 3d. Overlapping, same participant but DIFFERENT cert set → both kept
  {
    const existing = [{ ...mkEntry('e1', 'p1', ['X'], 0, 24) }];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p1', ['Y'], 12, 36));
    assert(result.length === 2, 'overlapping different cert set: both kept');
  }

  // 3e. Overlapping, different participant → both kept
  {
    const existing = [{ ...mkEntry('e1', 'p1', ['X'], 0, 24) }];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p2', ['X'], 12, 36));
    assert(result.length === 2, 'overlapping different participant: both kept');
  }

  // 3f. Cert-set equality is set-equality, not list-equality
  {
    const existing = [{ ...mkEntry('e1', 'p1', ['A', 'B'], 0, 24) }];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p1', ['B', 'A'], 12, 36));
    assert(result.length === 1, "cert set equality: ['A','B'] matches ['B','A'] → merged");
    assert(
      result[0].end.getTime() === baseTime.getTime() + 36 * 3600000,
      'cert set equality: merged window end correct',
    );
  }

  // 3g. Different size cert sets at same participant + overlap → both kept
  {
    const existing = [{ ...mkEntry('e1', 'p1', ['A', 'B'], 0, 24) }];
    const result = upsertCapabilityLoss(existing, mkEntry('e2', 'p1', ['A'], 12, 36));
    assert(result.length === 2, 'size-mismatched cert sets are not equal → both kept');
  }
}

// ─── Section 4: findCertAffectedAssignments predicate ───────────────────────

section('findCertAffectedAssignments predicate');

{
  const p = mkParticipant({ id: 'pAff', name: 'PAff', certifications: ['X', 'Y'] });

  // Window: day 5
  const windowStart = D(2026, 4, 5, 0);
  const windowEnd = D(2026, 4, 5, 23, 59);

  // 4 tasks: requiresX-in-window, requiresX-out-of-window, requiresY-in-window, no-cert-in-window
  const slotX1 = mkSlot({ requiredCertifications: ['X'] });
  const taskX1 = mkTask({
    timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 12) },
    slots: [slotX1],
  });

  const slotX2 = mkSlot({ requiredCertifications: ['X'] });
  const taskX2 = mkTask({
    timeBlock: { start: D(2026, 4, 7, 8), end: D(2026, 4, 7, 12) },
    slots: [slotX2],
  });

  const slotY = mkSlot({ requiredCertifications: ['Y'] });
  const taskY = mkTask({
    timeBlock: { start: D(2026, 4, 5, 14), end: D(2026, 4, 5, 18) },
    slots: [slotY],
  });

  const slotNone = mkSlot({ requiredCertifications: [] });
  const taskNone = mkTask({
    timeBlock: { start: D(2026, 4, 5, 19), end: D(2026, 4, 5, 22) },
    slots: [slotNone],
  });

  const aX1 = mkAssignment(taskX1.id, slotX1.slotId, p.id);
  const aX2 = mkAssignment(taskX2.id, slotX2.slotId, p.id);
  const aY = mkAssignment(taskY.id, slotY.slotId, p.id);
  const aNone = mkAssignment(taskNone.id, slotNone.slotId, p.id);

  const sched = mkSchedule({
    tasks: [taskX1, taskX2, taskY, taskNone],
    participants: [p],
    assignments: [aX1, aX2, aY, aNone],
  });

  // Anchor BEFORE all tasks → in-window X is "future" → goes into affected
  const earlyAnchor = D(2026, 4, 1, 0);
  const r1 = findCertAffectedAssignments(
    sched,
    {
      participantId: p.id,
      lostCertifications: ['X'],
      window: { start: windowStart, end: windowEnd },
    },
    earlyAnchor,
  );
  assert(r1.affected.length === 1, 'lost=X: only 1 in-window X slot affected');
  assert(r1.affected[0].assignment.id === aX1.id, 'affected[0] is the in-window X slot');
  assert(r1.lockedInPast.length === 0, 'no past-locked when anchor is before all tasks');

  // Out-of-window X slot, in-window Y slot, in-window no-cert slot must NOT appear
  const affectedIds = new Set(r1.affected.map((x) => x.assignment.id));
  assert(!affectedIds.has(aX2.id), 'out-of-window X slot not affected');
  assert(!affectedIds.has(aY.id), 'in-window Y slot not affected (lost=X)');
  assert(!affectedIds.has(aNone.id), 'in-window no-cert slot not affected');

  // Anchor AFTER the in-window X slot start → it goes into lockedInPast, not affected
  const lateAnchor = D(2026, 4, 5, 10); // task starts at 8, anchor at 10 → not future
  const r2 = findCertAffectedAssignments(
    sched,
    {
      participantId: p.id,
      lostCertifications: ['X'],
      window: { start: windowStart, end: windowEnd },
    },
    lateAnchor,
  );
  assert(r2.affected.length === 0, 'late anchor: in-window X slot not in affected');
  assert(r2.lockedInPast.length === 1, 'late anchor: in-window X slot in lockedInPast');
  assert(r2.lockedInPast[0].assignment.id === aX1.id, 'late anchor: lockedInPast[0] is the X slot');

  // Empty lostCertifications: returns 0 affected
  const r3 = findCertAffectedAssignments(
    sched,
    {
      participantId: p.id,
      lostCertifications: [],
      window: { start: windowStart, end: windowEnd },
    },
    earlyAnchor,
  );
  assert(r3.affected.length === 0, 'empty lostCertifications: 0 affected');
  assert(r3.lockedInPast.length === 0, 'empty lostCertifications: 0 locked in past');
}

// ─── Section 5: generateCapabilityChangePlans smoke tests ───────────────────

section('generateCapabilityChangePlans smoke tests');

{
  // Tiny scenario: P (loses X) and Q (also has X). 1 slot requires X.
  const p = mkParticipant({ id: 'pp', name: 'PP', certifications: ['X'] });
  const q = mkParticipant({ id: 'qq', name: 'QQ', certifications: ['X'] });

  const slot = mkSlot({ requiredCertifications: ['X'] });
  const task = mkTask({
    timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 16) },
    slots: [slot],
  });
  const a = mkAssignment(task.id, slot.slotId, p.id);

  const sched = mkSchedule({
    tasks: [task],
    participants: [p, q],
    assignments: [a],
  });

  const earlyAnchor = D(2026, 4, 1, 0);
  const result = generateCapabilityChangePlans(
    sched,
    {
      participantId: p.id,
      lostCertifications: ['X'],
      window: { start: D(2026, 4, 5, 0), end: D(2026, 4, 5, 23, 59) },
    },
    earlyAnchor,
    {
      config: DEFAULT_CONFIG,
      scoreCtx: mkScoreCtx(sched),
    },
  );

  assert(result.affected.length === 1, 'tiny: 1 affected assignment');
  assert(result.plans.length >= 1, 'tiny: at least 1 plan');
  if (result.plans.length >= 1) {
    const top = result.plans[0];
    assert(
      top.swaps.some((s) => s.assignmentId === a.id && s.toParticipantId === q.id),
      'tiny: top plan replaces P with Q on the affected slot',
    );
    assert(top.violations.length === 0, 'tiny: top plan has zero violations');
    assert(top.isPartial === false, 'tiny: top plan not partial');
    assert(Math.abs(top.compositeDelta) < 1000, 'tiny: compositeDelta is finite/small');
  }
  assert(result.infeasibleAssignmentIds.length === 0, 'tiny: no infeasible assignments');
}

{
  // Infeasible: P loses X; only P has X (Q does not). 1 slot requires X.
  const p = mkParticipant({ id: 'pp2', name: 'PP2', certifications: ['X'] });
  const q = mkParticipant({ id: 'qq2', name: 'QQ2', certifications: [] });

  const slot = mkSlot({ requiredCertifications: ['X'] });
  const task = mkTask({
    timeBlock: { start: D(2026, 4, 5, 8), end: D(2026, 4, 5, 16) },
    slots: [slot],
  });
  const a = mkAssignment(task.id, slot.slotId, p.id);

  const sched = mkSchedule({
    tasks: [task],
    participants: [p, q],
    assignments: [a],
  });

  const earlyAnchor = D(2026, 4, 1, 0);
  const result = generateCapabilityChangePlans(
    sched,
    {
      participantId: p.id,
      lostCertifications: ['X'],
      window: { start: D(2026, 4, 5, 0), end: D(2026, 4, 5, 23, 59) },
    },
    earlyAnchor,
    {
      config: DEFAULT_CONFIG,
      scoreCtx: mkScoreCtx(sched),
    },
  );

  assert(result.affected.length === 1, 'infeasible: 1 affected assignment');
  assert(
    result.infeasibleAssignmentIds.includes(a.id),
    'infeasible: affected assignment ID flagged as infeasible',
  );
  // Plans MAY contain best-effort partial plans tagged isPartial=true, OR be empty.
  if (result.plans.length > 0) {
    assert(
      result.plans.every((pl) => pl.isPartial === true),
      'infeasible: every returned plan is partial',
    );
  } else {
    assert(true, 'infeasible: plans list empty (acceptable outcome)');
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n=== ${_passed} passed, ${_failed} failed ===`);
process.exit(_failed === 0 ? 0 : 1);
