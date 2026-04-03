/**
 * Test Runner — Validates core engine functionality.
 *
 * Usage: npm test
 */

import {
  SchedulingEngine,
  Participant,
  Level,
  Certification,
  AssignmentStatus,
  ViolationSeverity,
  createTimeBlock,
  createTimeBlockFromHours,
  blockDurationHours,
  blockDurationMinutes,
  blocksOverlap,
  isFullyCovered,
  gapHours,
  gapMinutes,
  generateShiftBlocks,
  mergeBlocks,
  sortBlocksByStart,
  formatBlock,
  getTimelineBounds,
  createHamamaTask,
  createShemeshTask,
  createKarovTask,
  createArugaTask,
  createKarovitTask,
  createAdanitTasks,
  validateHardConstraints,
  computeScheduleScore,
  DEFAULT_CONFIG,
  OneTimeTask,
  computeAllRestProfiles,
  computeRestFairness,
  isEligible,
  getRejectionReason,
  ParticipantRestProfile,
} from './index';
import { fullValidate, previewSwap } from './engine/validator';
import { computeParticipantRest } from './web/utils/rest-calculator';
import { isDateInBlock } from './web/utils/time-utils';
import {
  checkLevelRequirement,
  checkCertificationRequirement,
  checkAvailability,
  checkSameGroup,
  checkSlotsFilled,
  checkUniqueParticipantsPerTask,
  checkGroupFeasibility,
  checkCategoryBreak,
} from './constraints/hard-constraints';
import { workloadImbalanceSplit, dailyWorkloadImbalance, collectSoftWarnings } from './constraints/soft-constraints';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${name}`);
  }
}

// ─── Time Utilities Tests ────────────────────────────────────────────────────

console.log('\n── Time Utilities ──────────────────────');

// Test midnight crossing
const midnightBlock = createTimeBlock(
  new Date(2026, 1, 15, 21, 0),
  new Date(2026, 1, 15, 5, 0), // appears before start → should become next day
);
assert(midnightBlock.end > midnightBlock.start, 'Midnight crossing auto-adjusts end date');
assert(blockDurationHours(midnightBlock) === 8, 'Midnight block duration = 8h');

// Test timeblock from hours
const block1 = createTimeBlockFromHours(new Date(2026, 1, 15), 9, 17);
assert(blockDurationHours(block1) === 8, 'createTimeBlockFromHours: 9-17 = 8h');

const block2 = createTimeBlockFromHours(new Date(2026, 1, 15), 22, 6);
assert(blockDurationHours(block2) === 8, 'createTimeBlockFromHours: 22-06 midnight crossing = 8h');

// Test overlap
const blockA = createTimeBlockFromHours(new Date(2026, 1, 15), 6, 14);
const blockB = createTimeBlockFromHours(new Date(2026, 1, 15), 10, 18);
const blockC = createTimeBlockFromHours(new Date(2026, 1, 15), 14, 22);
assert(blocksOverlap(blockA, blockB) === true, 'Overlapping blocks detected');
assert(blocksOverlap(blockA, blockC) === false, 'Adjacent blocks do not overlap');

// Test gap
assert(gapHours(blockA, blockC) === 0, 'Gap between adjacent blocks = 0');
const blockD = createTimeBlockFromHours(new Date(2026, 1, 15), 20, 4);
assert(gapHours(blockC, blockD) === 0, 'No gap for consecutive/adjacent blocks');

// Test availability coverage
const fullDayAvail = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 0, 0) }];
assert(isFullyCovered(blockA, fullDayAvail) === true, 'Full day covers 6-14 task');

const partialAvail = [{ start: new Date(2026, 1, 15, 8, 0), end: new Date(2026, 1, 15, 12, 0) }];
assert(isFullyCovered(blockA, partialAvail) === false, 'Partial availability does not cover 6-14 task');

// Test shift generation
const shifts = generateShiftBlocks(new Date(2026, 1, 15, 6, 0), 8, 3);
assert(shifts.length === 3, 'Generate 3 shifts');
assert(blockDurationHours(shifts[0]) === 8, 'Each shift is 8h');
assert(shifts[2].end.getHours() === 6, 'Third shift ends at 06:00');

// Test merge blocks
const overlapping = [
  createTimeBlockFromHours(new Date(2026, 1, 15), 6, 10),
  createTimeBlockFromHours(new Date(2026, 1, 15), 8, 14),
  createTimeBlockFromHours(new Date(2026, 1, 15), 18, 22),
];
const merged = mergeBlocks(overlapping);
assert(merged.length === 2, 'Merge overlapping blocks: 3 → 2');
assert(blockDurationHours(merged[0]) === 8, 'Merged block 6-14 = 8h');

// ─── Hard Constraint Tests ───────────────────────────────────────────────────

console.log('\n── Hard Constraints ────────────────────');

const baseDate = new Date(2026, 1, 15);
const dayAvail = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];

const testP0: Participant = {
  id: 'tp0', name: 'TestP0', level: Level.L0,
  certifications: [Certification.Nitzan, Certification.Hamama],
  group: 'TestGroup', availability: dayAvail, dateUnavailability: [],
};
const testP0b: Participant = {
  id: 'tp0b', name: 'TestP0b', level: Level.L0,
  certifications: [Certification.Nitzan],
  group: 'TestGroup', availability: dayAvail, dateUnavailability: [],
};

// Hamama task — requires Hamama cert
const hamamaBlock = createTimeBlockFromHours(baseDate, 6, 18);
const hamamaTask = createHamamaTask(hamamaBlock);

// Test: valid assignment
const validAssignment = [{
  id: 'va1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
  participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
}];
const result1 = validateHardConstraints([hamamaTask], [testP0, testP0b], validAssignment);
assert(result1.valid === true, 'Valid Hamama assignment passes hard constraints');

// Test: missing certification
const badAssignment = [{
  id: 'ba1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
  participantId: testP0b.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
}];
const result2 = validateHardConstraints([hamamaTask], [testP0, testP0b], badAssignment);
assert(result2.valid === false, 'Missing Hamama cert triggers violation');
assert(result2.violations.some((v) => v.code === 'CERT_MISSING'), 'Violation code = CERT_MISSING');

// Test: Shemesh with L0 participants (seniors hard-blocked under strict isolation)
const shemeshBlock = createTimeBlockFromHours(baseDate, 10, 14);
const shemeshTask = createShemeshTask(shemeshBlock);
const shemeshAssignment = [
  {
    id: 'sa1', taskId: shemeshTask.id, slotId: shemeshTask.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
  {
    id: 'sa2', taskId: shemeshTask.id, slotId: shemeshTask.slots[1].slotId,
    participantId: testP0b.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
];
const result3 = validateHardConstraints(
  [shemeshTask],
  [testP0, testP0b],
  shemeshAssignment,
);
assert(result3.valid === true, 'Valid Shemesh assignment with L0 participants');

// Test: double-booking
const taskA2 = createHamamaTask(hamamaBlock);
const doubleBooking = [
  {
    id: 'db1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
  {
    id: 'db2', taskId: taskA2.id, slotId: taskA2.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
];
const result4 = validateHardConstraints(
  [hamamaTask, taskA2],
  [testP0, testP0b],
  doubleBooking,
);
assert(result4.valid === false, 'Double-booking detected');
assert(result4.violations.some((v) => v.code === 'DOUBLE_BOOKING'), 'Violation code = DOUBLE_BOOKING');

// Test: HC-5 sweep-line regression — short task must not mask a long overlapping task
// Counterexample: A(06-14), B(08-09), C(10-12). A↔C overlap must be caught
// even though B (between A and C in start-sorted order) doesn't overlap C.
{
  const longTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 14));  // 06:00–14:00
  const shortTask = createHamamaTask(createTimeBlockFromHours(baseDate, 8, 9));  // 08:00–09:00
  const laterTask = createHamamaTask(createTimeBlockFromHours(baseDate, 10, 12)); // 10:00–12:00

  const dbMask = [
    { id: 'dbm1', taskId: longTask.id, slotId: longTask.slots[0].slotId, participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'dbm2', taskId: shortTask.id, slotId: shortTask.slots[0].slotId, participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'dbm3', taskId: laterTask.id, slotId: laterTask.slots[0].slotId, participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];

  const resultMask = validateHardConstraints(
    [longTask, shortTask, laterTask],
    [testP0, testP0b],
    dbMask,
  );
  // Should find overlaps: A↔B, A↔C, (B doesn't overlap C)
  const dbViolations = resultMask.violations.filter(v => v.code === 'DOUBLE_BOOKING');
  assert(dbViolations.length >= 2, 'HC-5 sweep-line: detects at least 2 overlapping pairs (A↔B, A↔C)');
  // Specifically verify the A↔C pair that the old break would miss
  const foundAC = dbViolations.some(v =>
    v.message.includes(longTask.name) && v.message.includes(laterTask.name),
  );
  assert(foundAC, 'HC-5 sweep-line: long↔later overlap not masked by intervening short task');
}

// ─── Soft Constraint Tests ───────────────────────────────────────────────────

console.log('\n── Soft Constraints ────────────────────');

const testP4: Participant = {
  id: 'tp4', name: 'TestP4', level: Level.L4,
  certifications: [Certification.Hamama],
  group: 'TestGroup', availability: dayAvail, dateUnavailability: [],
};

// Hamama L4 penalty
const l4HamamaAssignment = [{
  id: 'lh1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
  participantId: testP4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
}];
const score1 = computeScheduleScore(
  [hamamaTask],
  [testP0, testP4],
  l4HamamaAssignment,
  DEFAULT_CONFIG,
);
assert(score1.totalPenalty > 0, 'L4 Hamama assignment incurs penalty');
assert(score1.totalPenalty >= DEFAULT_CONFIG.lowPriorityLevelPenalty, 'Penalty >= lowPriorityLevelPenalty config');

// L0 Hamama — should have 0 hamama penalty (only workload-based penalty possible)
const l0HamamaAssignment = [{
  id: 'lh2', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
  participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
}];
const score2 = computeScheduleScore(
  [hamamaTask],
  [testP0, testP4],
  l0HamamaAssignment,
  DEFAULT_CONFIG,
);
assert(score2.totalPenalty < score1.totalPenalty, 'L0 Hamama has less penalty than L4');

// ─── Rest Calculator Tests ───────────────────────────────────────────────────

console.log('\n── Rest Calculator ─────────────────────');

const restTask1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
const restTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));
const restAssignments = [
  {
    id: 'ra1', taskId: restTask1.id, slotId: restTask1.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
  {
    id: 'ra2', taskId: restTask2.id, slotId: restTask2.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
];
const restProfile = computeParticipantRest(testP0.id, restAssignments, [restTask1, restTask2]);
assert(restProfile.restGaps.length === 1, 'One rest gap between two tasks');
assert(restProfile.minRestHours === 4, 'Rest gap = 4h (10:00-14:00)');
assert(restProfile.nonLightAssignmentCount === 2, 'Two non-light assignments counted');

// ─── Validator Tests ─────────────────────────────────────────────────────────

console.log('\n── Validator ───────────────────────────');

const fullResult = fullValidate(
  [hamamaTask],
  [testP0, testP0b],
  validAssignment,
);
assert(fullResult.valid === true, 'fullValidate: valid schedule');
assert(fullResult.summary.includes('תקין'), 'Summary mentions valid');

// Preview swap
const swapPreview = previewSwap(
  [hamamaTask],
  [testP0, testP0b],
  validAssignment,
  { assignmentId: 'va1', newParticipantId: testP0b.id },
);
assert(swapPreview.valid === false, 'Preview swap: missing cert detected');

// ─── Full Engine Integration Test ────────────────────────────────────────────

console.log('\n── Full Engine Integration ─────────────');

const engine = new SchedulingEngine({ maxIterations: 500, maxSolverTimeMs: 5000 });

// Create minimal scenario
const dayWindow = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];
const participants: Participant[] = [];
// 10 L0 participants
for (let i = 0; i < 10; i++) {
  participants.push({
    id: `p${i}`,
    name: `Person-${i}`,
    level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Hamama, Certification.Salsala],
    group: 'TeamA',
    availability: dayWindow,
    dateUnavailability: [],
  });
}
// Add L2, L3, L4
participants.push({
  id: 'pl2', name: 'Commander-L2', level: Level.L2,
  certifications: [Certification.Nitzan], group: 'TeamA', availability: dayWindow, dateUnavailability: [],
});
participants.push({
  id: 'pl3', name: 'Commander-L3', level: Level.L3,
  certifications: [Certification.Nitzan, Certification.Hamama], group: 'TeamA', availability: dayWindow, dateUnavailability: [],
});
participants.push({
  id: 'pl4', name: 'Commander-L4', level: Level.L4,
  certifications: [Certification.Hamama], group: 'TeamA', availability: dayWindow, dateUnavailability: [],
});

engine.addParticipants(participants);

// Create a few tasks manually (not a full day, to keep it manageable)
const tb1 = createTimeBlockFromHours(baseDate, 6, 18);
const tb2 = createTimeBlockFromHours(baseDate, 6, 10);
engine.addTask(createHamamaTask(tb1));
engine.addTask(createShemeshTask(tb2));
engine.addTask(createArugaTask(
  { start: new Date(2026, 1, 15, 6, 0), end: new Date(2026, 1, 15, 7, 30) },
  'Aruga Morning',
));

const schedule = engine.generateSchedule();
assert(schedule.assignments.length > 0, 'Engine generates assignments');

const engineStats = engine.getStats();
assert(engineStats.totalTasks === 3, 'Stats: 3 tasks');
assert(engineStats.totalParticipants === 13, 'Stats: 13 participants');

// Validate
const validation = engine.validate();
console.log(`  Schedule valid: ${validation.valid} (${validation.violations.length} violations)`);

// Manual swap test
if (schedule.assignments.length >= 1) {
  const a = schedule.assignments[0];
  const otherP = participants.find((p) => p.id !== a.participantId);
  if (otherP) {
    const swapResult = engine.swapParticipant({
      assignmentId: a.id,
      newParticipantId: otherP.id,
    });
    console.log(`  Swap result: valid=${swapResult.valid}`);
  }
}

// Partial re-schedule test
console.log('  Testing partial re-schedule...');
const lockedIds = schedule.assignments.slice(0, 2).map((a) => a.id);
const reScheduled = engine.partialReSchedule({
  lockedAssignmentIds: lockedIds,
  unavailableParticipantIds: ['p0'], // Remove one person
});
assert(reScheduled.assignments.length > 0, 'Partial re-schedule produces assignments');
console.log(`  Re-scheduled: ${reScheduled.assignments.length} assignments, feasible=${reScheduled.feasible}`);

// ─── Load Weighting: Hot / Cold / Effective Tests ────────────────────────────

import {
  computeTaskEffectiveHours,
  computeTaskHotHours,
  computeTaskColdHours,
  getTaskBaseLoadWeight,
} from './web/utils/load-weighting';
import type { Task, LoadWindow } from './models/types';

console.log('\n── Load Weighting (Hot/Cold/Effective) ──');

// Helper to build a minimal Task for testing
function makeTask(overrides: Partial<Task> & { timeBlock: Task['timeBlock'] }): Task {
  return {
    id: 'test-task',
    name: 'Test Task',
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    ...overrides,
  };
}

// Helper: Kruv hot windows (05:00-06:30 and 17:00-18:30)
const KRUV_WINDOWS: LoadWindow[] = [
  { id: 'w1', startHour: 5, startMinute: 0, endHour: 6, endMinute: 30, weight: 1 },
  { id: 'w2', startHour: 17, startMinute: 0, endHour: 18, endMinute: 30, weight: 1 },
];

// ── Test 1: Karovit (isLight) → 0 hot, 0 cold, 0 effective ──
{
  const t = makeTask({
    isLight: true,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(computeTaskHotHours(t) === 0, 'T1: Karovit hot = 0');
  assert(computeTaskColdHours(t) === 0, 'T1: Karovit cold = 0');
  assert(computeTaskEffectiveHours(t) === 0, 'T1: Karovit effective = 0');
}

// ── Test 2: Adanit 8h (no windows, baseLoadWeight=1) → all hot, 0 cold ──
{
  const t = makeTask({
    baseLoadWeight: 1,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(computeTaskHotHours(t) === 8, 'T2: Adanit 8h → hot = 8');
  assert(computeTaskColdHours(t) === 0, 'T2: Adanit 8h → cold = 0');
  assert(computeTaskEffectiveHours(t) === 8, 'T2: Adanit 8h → effective = 8');
}

// ── Test 3: Hamama 8h → all hot, 0 cold, effective = 8 ──
{
  const t = makeTask({
    baseLoadWeight: 1,
    timeBlock: { start: new Date(2026, 1, 15, 9, 0), end: new Date(2026, 1, 15, 17, 0) },
  });
  assert(computeTaskHotHours(t) === 8, 'T3: Hamama 8h → hot = 8');
  assert(computeTaskColdHours(t) === 0, 'T3: Hamama → cold = 0');
  assert(computeTaskEffectiveHours(t) === 8, 'T3: Hamama → effective = 8');
}

// ── Test 4: Kruv Shift 1 (05:00–13:00), hits window 05:00–06:30 ──
// Hot = 1.5h, Cold = 6.5h, Effective = 1.5 + 6.5*0.2 = 2.8
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(computeTaskHotHours(t) === 1.5, 'T4: Kruv 05-13 → hot = 1.5');
  assert(computeTaskColdHours(t) === 6.5, 'T4: Kruv 05-13 → cold = 6.5');
  assert(Math.abs(computeTaskEffectiveHours(t) - 2.8) < 0.01, 'T4: Kruv 05-13 → effective ≈ 2.8');
}

// ── Test 5: Kruv Shift 2 (13:00–21:00), hits window 17:00–18:30 ──
// Hot = 1.5h, Cold = 6.5h, Effective = 1.5 + 6.5*0.2 = 2.8
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 13, 0), end: new Date(2026, 1, 15, 21, 0) },
  });
  assert(computeTaskHotHours(t) === 1.5, 'T5: Kruv 13-21 → hot = 1.5');
  assert(computeTaskColdHours(t) === 6.5, 'T5: Kruv 13-21 → cold = 6.5');
  assert(Math.abs(computeTaskEffectiveHours(t) - 2.8) < 0.01, 'T5: Kruv 13-21 → effective ≈ 2.8');
}

// ── Test 6: Kruv Shift 3 (21:00–05:00 next day), hits NO hot windows ──
// Hot = 0h, Cold = 8h, Effective = 0 + 8*0.2 = 1.6
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 21, 0), end: new Date(2026, 1, 16, 5, 0) },
  });
  assert(computeTaskHotHours(t) === 0, 'T6: Kruv 21-05 → hot = 0');
  assert(computeTaskColdHours(t) === 8, 'T6: Kruv 21-05 → cold = 8');
  assert(Math.abs(computeTaskEffectiveHours(t) - 1.6) < 0.01, 'T6: Kruv 21-05 → effective ≈ 1.6');
}

// ── Test 7: Effective ≥ hot hours (invariant) for Kruv shift 1 ──
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(computeTaskEffectiveHours(t) >= computeTaskHotHours(t), 'T7: effective ≥ hot (invariant)');
}

// ── Test 8: hot + cold = raw duration for Kruv ──
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  const raw = 8;
  assert(
    Math.abs(computeTaskHotHours(t) + computeTaskColdHours(t) - raw) < 0.01,
    'T8: hot + cold = raw (8h)',
  );
}

// ── Test 9: Shemesh 12h → all hot, 0 cold ──
{
  const t = makeTask({
    baseLoadWeight: 1,
    timeBlock: { start: new Date(2026, 1, 15, 6, 0), end: new Date(2026, 1, 15, 18, 0) },
  });
  assert(computeTaskHotHours(t) === 12, 'T9: Shemesh 12h → hot = 12');
  assert(computeTaskColdHours(t) === 0, 'T9: Shemesh 12h → cold = 0');
  assert(computeTaskEffectiveHours(t) === 12, 'T9: Shemesh 12h → effective = 12');
}

// ── Test 10: Aruga 4h → all hot, 0 cold ──
{
  const t = makeTask({
    baseLoadWeight: 1,
    timeBlock: { start: new Date(2026, 1, 15, 7, 0), end: new Date(2026, 1, 15, 11, 0) },
  });
  assert(computeTaskHotHours(t) === 4, 'T10: Aruga 4h → hot = 4');
  assert(computeTaskColdHours(t) === 0, 'T10: Aruga 4h → cold = 0');
  assert(computeTaskEffectiveHours(t) === 4, 'T10: Aruga 4h → effective = 4');
}

// ── Test 11: Mamtera 8h → all hot, 0 cold ──
{
  const t = makeTask({
    baseLoadWeight: 1,
    timeBlock: { start: new Date(2026, 1, 15, 14, 0), end: new Date(2026, 1, 15, 22, 0) },
  });
  assert(computeTaskHotHours(t) === 8, 'T11: Mamtera 8h → hot = 8');
  assert(computeTaskColdHours(t) === 0, 'T11: Mamtera → cold = 0');
  assert(computeTaskEffectiveHours(t) === 8, 'T11: Mamtera → effective = 8');
}

// ── Test 12: Kruv 04:00–06:00 (partially inside morning window) ──
// Window 05:00-06:30 overlap = 1h (05:00-06:00). Cold = 1h (04:00-05:00).
// Effective = 1*1.0 + 1*0.2 = 1.2
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 4, 0), end: new Date(2026, 1, 15, 6, 0) },
  });
  assert(computeTaskHotHours(t) === 1, 'T12: Kruv 04-06 → hot = 1');
  assert(computeTaskColdHours(t) === 1, 'T12: Kruv 04-06 → cold = 1');
  assert(Math.abs(computeTaskEffectiveHours(t) - 1.2) < 0.01, 'T12: Kruv 04-06 → effective ≈ 1.2');
}

// ── Test 13: Kruv exactly on hot window (05:00–06:30) ──
// Hot = 1.5, Cold = 0, Effective = 1.5
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 6, 30) },
  });
  assert(computeTaskHotHours(t) === 1.5, 'T13: Kruv exactly 05:00-06:30 → hot = 1.5');
  assert(computeTaskColdHours(t) === 0, 'T13: Kruv exactly 05:00-06:30 → cold = 0');
  assert(computeTaskEffectiveHours(t) === 1.5, 'T13: effective = 1.5');
}

// ── Test 14: Kruv 10:00–15:00 — entirely between windows, 0 hot ──
// Hot = 0, Cold = 5h, Effective = 5*0.2 = 1.0
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 10, 0), end: new Date(2026, 1, 15, 15, 0) },
  });
  assert(computeTaskHotHours(t) === 0, 'T14: Kruv 10-15 → hot = 0');
  assert(computeTaskColdHours(t) === 5, 'T14: Kruv 10-15 → cold = 5');
  assert(Math.abs(computeTaskEffectiveHours(t) - 1.0) < 0.01, 'T14: Kruv 10-15 → effective ≈ 1.0');
}

// ── Test 15: Kruv spanning both windows in one long shift (04:00–19:00, 15h) ──
// Morning window overlap: 05:00-06:30 = 1.5h. Evening window overlap: 17:00-18:30 = 1.5h.
// Hot = 3h, Cold = 12h, Effective = 3 + 12*0.2 = 5.4
{
  const t = makeTask({
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 4, 0), end: new Date(2026, 1, 15, 19, 0) },
  });
  assert(computeTaskHotHours(t) === 3, 'T15: Kruv 04-19 → hot = 3');
  assert(computeTaskColdHours(t) === 12, 'T15: Kruv 04-19 → cold = 12');
  assert(Math.abs(computeTaskEffectiveHours(t) - 5.4) < 0.01, 'T15: Kruv 04-19 → effective ≈ 5.4');
}

// ── Test 16: getTaskBaseLoadWeight returns correct values ──
{
  const lightTask = makeTask({
    isLight: true,
    baseLoadWeight: 0.5,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(getTaskBaseLoadWeight(lightTask) === 0, 'T16a: light task base weight = 0');

  const heavyNoWeight = makeTask({
    baseLoadWeight: undefined,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(getTaskBaseLoadWeight(heavyNoWeight) === 1, 'T16b: heavy no-weight defaults to 1');

  const kruvWeight = makeTask({
    baseLoadWeight: 0.2,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(getTaskBaseLoadWeight(kruvWeight) === 0.2, 'T16c: Kruv base weight = 0.2');
}

// ── Test 17: Two Kruv shifts summed — hot+cold = total raw ──
// Shift A (05:00–13:00): hot=1.5, cold=6.5
// Shift B (21:00–05:00): hot=0, cold=8
// Total: hot=1.5, cold=14.5, raw=16, effective = 1.5 + 14.5*0.2 = 4.4
{
  const a = makeTask({
    id: 'kruv-a',
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  const b = makeTask({
    id: 'kruv-b',
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 21, 0), end: new Date(2026, 1, 16, 5, 0) },
  });
  const totalHot = computeTaskHotHours(a) + computeTaskHotHours(b);
  const totalCold = computeTaskColdHours(a) + computeTaskColdHours(b);
  const totalEff = computeTaskEffectiveHours(a) + computeTaskEffectiveHours(b);
  assert(totalHot === 1.5, 'T17: 2 Kruv shifts combined hot = 1.5');
  assert(totalCold === 14.5, 'T17: 2 Kruv shifts combined cold = 14.5');
  assert(Math.abs(totalHot + totalCold - 16) < 0.01, 'T17: hot + cold = 16h raw');
  assert(Math.abs(totalEff - 4.4) < 0.01, 'T17: combined effective ≈ 4.4');
}

// ─── Choresh (HC-11) Tests ───────────────────────────────────────────────────

import { createMamteraTask } from './index';
import { checkForbiddenCertifications, checkNoConsecutiveHighLoad } from './constraints/hard-constraints';
import { getLoadWeightAtTime, isHighLoadAtBoundary } from './web/utils/load-weighting';
import {
  isNaturalRole,
  checkSeniorHardBlock,
  validateSeniorHardBlocks,
  computeLowPriorityLevelPenalty,
} from './constraints/senior-policy';
import type { SlotRequirement, Assignment } from './models/types';

console.log('\n── Forbidden Certification Constraint (HC-11) ───────────');

const mamteraTask = createMamteraTask(baseDate);

// Non-choresh participant → no violation on Mamtera
{
  const normalP: Participant = {
    id: 'tc-normal', name: 'NormalPerson', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const pMap = new Map([['tc-normal', normalP]]);
  const assigns: Assignment[] = [{
    id: 'ca-n1', taskId: mamteraTask.id, slotId: mamteraTask.slots[0].slotId,
    participantId: normalP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  const violations = checkForbiddenCertifications(mamteraTask, assigns, pMap);
  assert(violations.length === 0, 'HC-11: Non-choresh → no Mamtera violation');
}

// Choresh participant → violation on Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor', name: 'ChoreshPerson', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const pMap = new Map([['tc-chor', choreshP]]);
  const assigns: Assignment[] = [{
    id: 'ca-c1', taskId: mamteraTask.id, slotId: mamteraTask.slots[0].slotId,
    participantId: choreshP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  const violations = checkForbiddenCertifications(mamteraTask, assigns, pMap);
  assert(violations.length === 1, 'HC-11: Choresh → Mamtera violation');
  assert(violations[0].code === 'EXCLUDED_CERTIFICATION', 'HC-11: violation code = EXCLUDED_CERTIFICATION');
}

// Choresh participant on non-Mamtera task (no forbidden certs on slots) → no violation
{
  const choreshP: Participant = {
    id: 'tc-chor2', name: 'ChoreshPerson2', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Hamama, Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const pMap = new Map([['tc-chor2', choreshP]]);
  const assigns: Assignment[] = [{
    id: 'ca-c2', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
    participantId: choreshP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  const violations = checkForbiddenCertifications(hamamaTask, assigns, pMap);
  assert(violations.length === 0, 'HC-11: Choresh on Hamama → no violation (only Mamtera slots forbid it)');
}

// Per-slot granularity: forbidden on slot A, allowed on slot B
{
  const slotA: SlotRequirement = {
    slotId: 'fc-slot-a', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], forbiddenCertifications: [Certification.Horesh], label: 'Slot A (forbids Horesh)',
  };
  const slotB: SlotRequirement = {
    slotId: 'fc-slot-b', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'Slot B (no forbidden)',
  };
  const mixedTask: Task = {
    id: 'fc-mixed', name: 'Mixed Forbidden',
    timeBlock: createTimeBlockFromHours(baseDate, 9, 23),
    requiredCount: 2, slots: [slotA, slotB],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const choreshP: Participant = {
    id: 'fc-chor', name: 'ChoreshMixed', level: Level.L0,
    certifications: [Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const pMap = new Map([['fc-chor', choreshP]]);
  // Assigned to slot A (forbidden) → violation
  const assignsA: Assignment[] = [{
    id: 'fca1', taskId: mixedTask.id, slotId: 'fc-slot-a',
    participantId: choreshP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  assert(checkForbiddenCertifications(mixedTask, assignsA, pMap).length === 1,
    'HC-11: Forbidden cert on slot A → violation');
  // Assigned to slot B (not forbidden) → no violation
  const assignsB: Assignment[] = [{
    id: 'fca2', taskId: mixedTask.id, slotId: 'fc-slot-b',
    participantId: choreshP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  assert(checkForbiddenCertifications(mixedTask, assignsB, pMap).length === 0,
    'HC-11: No forbidden cert on slot B → no violation');
}

// Full validateHardConstraints catches Choresh+Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor3', name: 'ChoreshFull', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const badAssign = [{
    id: 'ca1', taskId: mamteraTask.id, slotId: mamteraTask.slots[0].slotId,
    participantId: choreshP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  }];
  const result = validateHardConstraints([mamteraTask], [choreshP], badAssign);
  assert(result.valid === false, 'HC-11: Full validation rejects Choresh+Mamtera');
  assert(result.violations.some(v => v.code === 'EXCLUDED_CERTIFICATION'), 'HC-11: Full validation has correct code');
}

// ─── No Consecutive High-Load (HC-12) Tests ──────────────────────────────────

console.log('\n── Consecutive High-Load Constraint (HC-12) ──');

// ── Load weight utility tests ────────────────────────────────────────────────

// T-HC12-1: getLoadWeightAtTime for a uniform heavy task returns 1.0
{
  const heavyBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const heavyTask = createShemeshTask(heavyBlock);
  const midTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 9, 0);
  assert(getLoadWeightAtTime(heavyTask, midTime) === 1, 'HC-12 util: uniform heavy task → weight 1.0 at midpoint');
  assert(getLoadWeightAtTime(heavyTask, heavyTask.timeBlock.start) === 1, 'HC-12 util: heavy task → weight 1.0 at start');
  // C2: With half-open [start, end), the exact end instant is outside the task
  assert(getLoadWeightAtTime(heavyTask, heavyTask.timeBlock.end) === 0, 'HC-12 util: heavy task → weight 0 at end (half-open)');
}

// T-HC12-2: getLoadWeightAtTime for Karov returns 1.0 inside hot window, 1/3 outside
{
  const karovBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const karovTask = createKarovTask(karovBlock);
  const hotTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 30);
  const coldTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 10, 0);
  assert(getLoadWeightAtTime(karovTask, hotTime) === 1, 'HC-12 util: Karov hot window → weight 1.0');
  assert(Math.abs(getLoadWeightAtTime(karovTask, coldTime) - 1 / 3) < 0.01, 'HC-12 util: Karov cold zone → weight 1/3');
}

// T-HC12-3: getLoadWeightAtTime for light task always returns 0
{
  const lightBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const lightTask = createKarovitTask(lightBlock);
  assert(getLoadWeightAtTime(lightTask, lightTask.timeBlock.start) === 0, 'HC-12 util: light task → weight 0 at start');
}

// T-HC12-4: isHighLoadAtBoundary for heavy task = true at both edges
{
  const heavyBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const heavyTask = createShemeshTask(heavyBlock);
  assert(isHighLoadAtBoundary(heavyTask, 'start') === true, 'HC-12 util: heavy task high at start');
  assert(isHighLoadAtBoundary(heavyTask, 'end') === true, 'HC-12 util: heavy task high at end');
}

// T-HC12-5: isHighLoadAtBoundary for Karov starting at 05:00 (hot window) = true at start
{
  const karovBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const karovTask = createKarovTask(karovBlock);
  assert(isHighLoadAtBoundary(karovTask, 'start') === true, 'HC-12 util: Karov 05:00 start → high load (hot window)');
  assert(isHighLoadAtBoundary(karovTask, 'end') === false, 'HC-12 util: Karov 13:00 end → low load (cold zone)');
}

// T-HC12-6: isHighLoadAtBoundary for Karov starting at 13:00 (cold) = false at start
{
  const karovBlock2 = createTimeBlockFromHours(baseDate, 13, 21);
  const karovTask2 = createKarovTask(karovBlock2);
  assert(isHighLoadAtBoundary(karovTask2, 'start') === false, 'HC-12 util: Karov 13:00 start → low load (cold zone)');
  // 21:00 is also outside hot windows → false
  assert(isHighLoadAtBoundary(karovTask2, 'end') === false, 'HC-12 util: Karov 21:00 end → low load (cold zone)');
}

// ── Constraint checker tests ─────────────────────────────────────────────────

const hcParticipant: Participant = {
  id: 'hc12-p1', name: 'HC12Tester', level: Level.L0,
  certifications: [Certification.Nitzan], group: 'A',
  availability: dayAvail, dateUnavailability: [],
};

// T-HC12-7: Two back-to-back heavy tasks → VIOLATION
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 9, 13));
  const tMap = new Map([[ taskA.id, taskA ], [ taskB.id, taskB ]]);
  const assigns = [
    { id: 'hc12-a1', taskId: taskA.id, slotId: taskA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-a2', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 1, 'HC-12: two consecutive heavy tasks → 1 violation');
  assert(v[0].code === 'CONSECUTIVE_HIGH_LOAD', 'HC-12: violation code = CONSECUTIVE_HIGH_LOAD');
}

// T-HC12-8: Heavy task then Karovit (light) → NO violation (light acts as buffer)
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createKarovitTask(createTimeBlockFromHours(baseDate, 9, 13));
  const tMap = new Map([[ taskA.id, taskA ], [ taskB.id, taskB ]]);
  const assigns = [
    { id: 'hc12-a3', taskId: taskA.id, slotId: taskA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-a4', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 0, 'HC-12: heavy then light (Karovit) → no violation');
}

// T-HC12-9: Heavy task then Karov starting in cold zone → NO violation
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 13));
  const taskB = createKarovTask(createTimeBlockFromHours(baseDate, 13, 21)); // starts cold
  const tMap = new Map([[ taskA.id, taskA ], [ taskB.id, taskB ]]);
  const assigns = [
    { id: 'hc12-a5', taskId: taskA.id, slotId: taskA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-a6', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 0, 'HC-12: heavy then Karov (cold start) → no violation');
}

// T-HC12-10: Karov ending in hot then heavy task → VIOLATION
{
  // Karov 13:00-21:00, hot window 17:00-18:30 → at 21:00 the task ends outside hot, so NO violation
  // Instead use Karov 01:00-09:00 with hot 05:00-06:30 → ends at 09:00 → cold zone, not violation
  // The hot window that matters: Karov starts at 05:00 with hot window 05:00-06:30
  // For the Karov to END in hot we need it to end inside a hot window
  // Karov 04:00-06:30 would end inside hot window 05:00-06:30
  // But easier: use the PM hot window 17:00-18:30, Karov 10:00-18:00 ends at 18:00 inside hot
  const karovA = createKarovTask(createTimeBlockFromHours(baseDate, 10, 18)); // ends at 18:00, inside hot 17:00-18:30
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 18, 22)); // heavy, starts at 18:00
  const tMap = new Map([[ karovA.id, karovA ], [ taskB.id, taskB ]]);
  const assigns = [
    { id: 'hc12-a7', taskId: karovA.id, slotId: karovA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-a8', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 1, 'HC-12: Karov ending in hot → heavy start → violation');
}

// T-HC12-11: Gap between heavy tasks (non-adjacent) → NO violation
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 10, 14)); // 1h gap
  const tMap = new Map([[ taskA.id, taskA ], [ taskB.id, taskB ]]);
  const assigns = [
    { id: 'hc12-a9', taskId: taskA.id, slotId: taskA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-a10', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 0, 'HC-12: heavy tasks with gap → no violation');
}

// T-HC12-12: validateHardConstraints detects consecutive high-load
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 9, 13));
  const assigns = [
    { id: 'hc12-fa1', taskId: taskA.id, slotId: taskA.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc12-fa2', taskId: taskB.id, slotId: taskB.slots[0].slotId, participantId: hcParticipant.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const result = validateHardConstraints([taskA, taskB], [hcParticipant], assigns);
  assert(result.valid === false, 'HC-12: validateHardConstraints rejects consecutive heavy');
  assert(result.violations.some(v => v.code === 'CONSECUTIVE_HIGH_LOAD'), 'HC-12: full validation has correct code');
}
// ─── Senior Role Policy (HC-13) Tests ─────────────────────────────────────

console.log('\n── Senior Role Policy (HC-13) ───────────────');

// Helper slots for Adanit tests
const adMainSlot: SlotRequirement = {
  slotId: 'test-ad-main', acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: [Certification.Nitzan],
  label: 'Segol Main L3/L4',
};
const adSecSlot: SlotRequirement = {
  slotId: 'test-ad-sec', acceptableLevels: [{ level: Level.L2 }],
  requiredCertifications: [Certification.Nitzan],
  label: 'Segol Secondary L2',
};
const adL0Slot: SlotRequirement = {
  slotId: 'test-ad-l0', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [Certification.Nitzan],
  label: 'Adanit L0',
};
const testAdanitBlock = createTimeBlockFromHours(baseDate, 5, 13);
const testAdanitTask: Task = {
  id: 'sr-adanit-t', name: 'Test Adanit',
  timeBlock: testAdanitBlock, requiredCount: 6,
  slots: [adMainSlot, adSecSlot, adL0Slot, adL0Slot, adL0Slot, adL0Slot],
  isLight: false, sameGroupRequired: true, blocksConsecutive: true,
};

const testKarovSlot: SlotRequirement = {
  slotId: 'test-kr-cmd', acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: [], label: 'Karov Commander',
};
const testKarovL0Slot: SlotRequirement = {
  slotId: 'test-kr-l0', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [], label: 'Karov L0',
};
const testKarovTask: Task = {
  id: 'sr-karov-t', name: 'Test Karov',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4, slots: [testKarovSlot, testKarovL0Slot],
  isLight: false, sameGroupRequired: false, blocksConsecutive: false,
};

const testKarovitSlot: SlotRequirement = {
  slotId: 'test-krt-cmd', acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: [], label: 'Karovit Commander',
};
const testKarovitL0Slot: SlotRequirement = {
  slotId: 'test-krt-l0', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [], label: 'Karovit L0',
};
const testKarovitTask: Task = {
  id: 'sr-karovit-t', name: 'Test Karovit',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4, slots: [testKarovitSlot, testKarovitL0Slot],
  isLight: true, sameGroupRequired: false, blocksConsecutive: false,
};

const testMamSlot: SlotRequirement = {
  slotId: 'test-mam-l0', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [], forbiddenCertifications: [Certification.Horesh],
  label: 'Mamtera L0',
};
const testMamTask: Task = {
  id: 'sr-mam-t', name: 'Test Mamtera',
  timeBlock: createTimeBlockFromHours(baseDate, 9, 23),
  requiredCount: 2, slots: [testMamSlot],
  isLight: false, sameGroupRequired: false, blocksConsecutive: true,
};

const testHamSlot: SlotRequirement = {
  slotId: 'test-ham-op', acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
  requiredCertifications: [Certification.Hamama], label: 'Hamama Operator',
};
const testHamTask: Task = {
  id: 'sr-ham-t', name: 'Test Hamama',
  timeBlock: createTimeBlockFromHours(baseDate, 6, 18),
  requiredCount: 1, slots: [testHamSlot],
  isLight: false, sameGroupRequired: false, blocksConsecutive: true,
};

const testShSlot: SlotRequirement = {
  slotId: 'test-sh-1', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [Certification.Nitzan], label: 'Shemesh #1',
};
const testShTask: Task = {
  id: 'sr-sh-t', name: 'Test Shemesh',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 9),
  requiredCount: 2, slots: [testShSlot],
  isLight: false, sameGroupRequired: false, blocksConsecutive: true,
};

const testArSlot: SlotRequirement = {
  slotId: 'test-ar-1', acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [], label: 'Aruga L0',
};
const testArTask: Task = {
  id: 'sr-ar-t', name: 'Test Aruga',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 7),
  requiredCount: 2, slots: [testArSlot],
  isLight: false, sameGroupRequired: false, blocksConsecutive: true,
};

const spL0: Participant = {
  id: 'sp-l0', name: 'SP-L0', level: Level.L0,
  certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
  availability: dayAvail, dateUnavailability: [],
};
const spL2: Participant = {
  id: 'sp-l2', name: 'SP-L2', level: Level.L2,
  certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
  availability: dayAvail, dateUnavailability: [],
};
const spL3: Participant = {
  id: 'sp-l3', name: 'SP-L3', level: Level.L3,
  certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
  availability: dayAvail, dateUnavailability: [],
};
const spL4: Participant = {
  id: 'sp-l4', name: 'SP-L4', level: Level.L4,
  certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
  availability: dayAvail, dateUnavailability: [],
};

// ── isNaturalRole ───────────────────────────────────────────────────────────────────

assert(isNaturalRole(Level.L0, testAdanitTask, adL0Slot), 'HC-13: L0 always natural');
assert(isNaturalRole(Level.L0, testMamTask, testMamSlot), 'HC-13: L0 in Mamtera natural');

assert(isNaturalRole(Level.L4, testAdanitTask, adMainSlot), 'HC-13: L4 in Segol Main natural');
assert(isNaturalRole(Level.L4, testKarovTask, testKarovSlot), 'HC-13: L4 in Karov natural');
assert(isNaturalRole(Level.L4, testKarovitTask, testKarovitSlot), 'HC-13: L4 in Karovit natural');
assert(!isNaturalRole(Level.L4, testAdanitTask, adSecSlot), 'HC-13: L4 NOT natural in Segol Secondary');
assert(!isNaturalRole(Level.L4, testAdanitTask, adL0Slot), 'HC-13: L4 NOT natural in L0 Adanit slot');
assert(!isNaturalRole(Level.L4, testHamTask, testHamSlot), 'HC-13: L4 NOT natural in Hamama');
assert(!isNaturalRole(Level.L4, testMamTask, testMamSlot), 'HC-13: L4 NOT natural in Mamtera');
assert(!isNaturalRole(Level.L4, testShTask, testShSlot), 'HC-13: L4 NOT natural in Shemesh');

assert(isNaturalRole(Level.L3, testAdanitTask, adMainSlot), 'HC-13: L3 in Segol Main natural');
assert(isNaturalRole(Level.L3, testKarovTask, testKarovSlot), 'HC-13: L3 in Karov natural');
assert(isNaturalRole(Level.L3, testKarovitTask, testKarovitSlot), 'HC-13: L3 in Karovit natural');
assert(!isNaturalRole(Level.L3, testAdanitTask, adSecSlot), 'HC-13: L3 NOT natural in Segol Secondary');
assert(!isNaturalRole(Level.L3, testMamTask, testMamSlot), 'HC-13: L3 NOT natural in Mamtera');

assert(isNaturalRole(Level.L2, testAdanitTask, adSecSlot), 'HC-13: L2 in Segol Secondary natural');
assert(isNaturalRole(Level.L2, testKarovTask, testKarovSlot), 'HC-13: L2 in Karov commander natural');
assert(!isNaturalRole(Level.L2, testKarovTask, testKarovL0Slot), 'HC-13: L2 NOT natural in Karov L0 slot');
assert(!isNaturalRole(Level.L2, testKarovitTask, testKarovitL0Slot), 'HC-13: L2 NOT natural in Karovit L0 slot');
assert(!isNaturalRole(Level.L3, testKarovTask, testKarovL0Slot), 'HC-13: L3 NOT natural in Karov L0 slot');
assert(!isNaturalRole(Level.L3, testKarovitTask, testKarovitL0Slot), 'HC-13: L3 NOT natural in Karovit L0 slot');
assert(!isNaturalRole(Level.L4, testKarovTask, testKarovL0Slot), 'HC-13: L4 NOT natural in Karov L0 slot');
assert(!isNaturalRole(Level.L4, testKarovitTask, testKarovitL0Slot), 'HC-13: L4 NOT natural in Karovit L0 slot');
assert(!isNaturalRole(Level.L2, testAdanitTask, adMainSlot), 'HC-13: L2 NOT natural in Segol Main');

// ── checkSeniorHardBlock (legacy stub — always returns null) ─────────────────────

assert(checkSeniorHardBlock(spL4, testAdanitTask, adMainSlot) === null, 'HC-13 stub: L4 in Segol Main → null');
assert(checkSeniorHardBlock(spL4, testMamTask, testMamSlot) === null, 'HC-13 stub: L4 in Mamtera → null (hard-block now via HC-1)');
assert(checkSeniorHardBlock(spL4, testShTask, testShSlot) === null, 'HC-13 stub: L4 in Shemesh → null (hard-block now via HC-1)');
assert(checkSeniorHardBlock(spL4, testHamTask, testHamSlot) === null, 'HC-13 stub: L4 in Hamama → null');
assert(checkSeniorHardBlock(spL3, testMamTask, testMamSlot) === null, 'HC-13 stub: L3 in Mamtera → null');
assert(checkSeniorHardBlock(spL0, testMamTask, testMamSlot) === null, 'HC-13 stub: L0 → null');

// ── validateSeniorHardBlocks (legacy stub — always returns []) ──────────────────
{
  const badAssigns: Assignment[] = [
    { id: 'sr-a1', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = validateSeniorHardBlocks([spL4], badAssigns, [testShTask]);
  assert(v.length === 0, 'validateSeniorHardBlocks stub: always returns empty (HC-1 handles level gating)');
}

// ── validateHardConstraints integration (level gating now via HC-1) ──────────────
{
  // L4 in Shemesh (L0-only slot) → blocked by HC-1 LEVEL_MISMATCH
  const assigns: Assignment[] = [
    { id: 'sr-fa1', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const r = validateHardConstraints([testShTask], [spL4], assigns);
  assert(r.valid === false, 'HC-1: full validation rejects L4 in L0-only Shemesh slot');
  assert(r.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'HC-1: full validation has LEVEL_MISMATCH code');
}
// L4 in Hamama (lowPriority) → no hard violation (soft penalty only)
{
  const assigns: Assignment[] = [
    { id: 'sr-fa2', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const r = validateHardConstraints([testHamTask], [spL4], assigns);
  assert(!r.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'L4 in Hamama (lowPriority) passes HC-1');
}

// ── computeLowPriorityLevelPenalty ────────────────────────────────────────────────────

const cfg = { ...DEFAULT_CONFIG };

// Natural assignment → zero penalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p1', taskId: testKarovTask.id, slotId: testKarovSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeLowPriorityLevelPenalty([spL3], assigns, [testKarovTask], cfg);
  assert(pen === 0, 'Low-priority penalty: natural assignment → 0');
}

// L4 in Hamama (lowPriority) → lowPriorityLevelPenalty (absolute last resort)
{
  const assigns: Assignment[] = [
    { id: 'sr-p2', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeLowPriorityLevelPenalty([spL4], assigns, [testHamTask], cfg);
  assert(pen === cfg.lowPriorityLevelPenalty, `Low-priority penalty: L4 in Hamama (lowPriority) → penalty ${cfg.lowPriorityLevelPenalty}`);
}

// L3 in Hamama → 0 (not in acceptableLevels, hard-blocked by HC-1)
{
  const assigns: Assignment[] = [
    { id: 'sr-p2b', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeLowPriorityLevelPenalty([spL3], assigns, [testHamTask], cfg);
  assert(pen === 0, 'Low-priority penalty: L3 in Hamama → 0 (not in acceptableLevels)');
}

// L2 in Hamama → 0 (not in acceptableLevels, hard-blocked by HC-1)
{
  const assigns: Assignment[] = [
    { id: 'sr-p2c', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL2.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeLowPriorityLevelPenalty([spL2], assigns, [testHamTask], cfg);
  assert(pen === 0, 'Low-priority penalty: L2 in Hamama → 0 (not in acceptableLevels)');
}

// L0 participants never penalised
{
  const assigns: Assignment[] = [
    { id: 'sr-p5', taskId: testMamTask.id, slotId: testMamSlot.slotId, participantId: spL0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeLowPriorityLevelPenalty([spL0], assigns, [testMamTask], cfg);
  assert(pen === 0, 'Senior junior-pref penalty: L0 never penalised');
}
// ── SC-10: Task Preference Penalty (with bonus) ─────────────────────────────

import { computeTaskNamePreferencePenalty } from './constraints/soft-constraints';

console.log('\n── SC-10: Task Preference Penalty ──────');

{
  // Setup: two task types — Mamtera (preferred) and Karov (neutral)
  const prefBase = new Date(2026, 1, 15);
  const prefMamtera = createMamteraTask(prefBase);
  const prefKarov = createKarovTask(createTimeBlockFromHours(prefBase, 6, 14));
  const prefKarov2 = createKarovTask(createTimeBlockFromHours(prefBase, 14, 22));
  const prefKarov3 = createKarovTask(createTimeBlockFromHours(new Date(2026, 1, 16), 6, 14));
  const taskMap = new Map([prefMamtera, prefKarov, prefKarov2, prefKarov3].map(t => [t.id, t]));

  const pWithPref: Participant = {
    id: 'sc10-p1', name: 'PrefPerson', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
    preferredTaskName: 'ממטרה',
  };

  const cfgPref = { ...DEFAULT_CONFIG, taskNamePreferencePenalty: 50, taskNameAvoidancePenalty: 80, taskNamePreferenceBonus: 25 };

  // No preferred assignments → binary penalty only (no bonus)
  {
    const assigns = new Map<string, Assignment[]>([
      ['sc10-p1', [
        { id: 'sc10-a1', taskId: prefKarov.id, slotId: prefKarov.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
      ]],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === 50, 'SC-10 bonus: 0 preferred assignments → binary penalty 50');
  }

  // 1 preferred assignment → binary removed + 1× bonus = -25
  {
    const assigns = new Map<string, Assignment[]>([
      ['sc10-p1', [
        { id: 'sc10-a2', taskId: prefMamtera.id, slotId: prefMamtera.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
      ]],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === -25, 'SC-10 bonus: 1 preferred assignment → -25 (no binary, 1× bonus)');
  }

  // 3 preferred assignments → binary removed + 3× bonus = -75
  {
    const assigns = new Map<string, Assignment[]>([
      ['sc10-p1', [
        { id: 'sc10-a3', taskId: prefMamtera.id, slotId: prefMamtera.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
        { id: 'sc10-a4', taskId: prefMamtera.id, slotId: prefMamtera.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
        { id: 'sc10-a5', taskId: prefMamtera.id, slotId: prefMamtera.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
      ]],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === -75, 'SC-10 bonus: 3 preferred assignments → -75 (stacks)');
  }

  // Bonus disabled → only binary penalty applies
  {
    const cfgNoBonus = { ...cfgPref, taskNamePreferenceBonus: 0 };
    const assigns = new Map<string, Assignment[]>([
      ['sc10-p1', [
        { id: 'sc10-a6', taskId: prefKarov.id, slotId: prefKarov.slots[0].slotId, participantId: 'sc10-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
      ]],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgNoBonus, taskMap, assigns);
    assert(pen === 50, 'SC-10 bonus: bonus=0 → only binary penalty');
  }

  // Avoidance and bonus are independent
  {
    const pBoth: Participant = {
      ...pWithPref,
      id: 'sc10-p2',
      preferredTaskName: 'ממטרה',
      lessPreferredTaskName: 'כרוב',
    };
    const assigns = new Map<string, Assignment[]>([
      ['sc10-p2', [
        { id: 'sc10-a7', taskId: prefMamtera.id, slotId: prefMamtera.slots[0].slotId, participantId: 'sc10-p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
        { id: 'sc10-a8', taskId: prefKarov.id, slotId: prefKarov.slots[0].slotId, participantId: 'sc10-p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
      ]],
    ]);
    const pen = computeTaskNamePreferencePenalty([pBoth], cfgPref, taskMap, assigns);
    // avoidance: 1× 80 = 80, binary: 0 (has preferred), bonus: -25
    assert(pen === 55, 'SC-10 bonus: avoidance (80) + bonus (-25) = 55, independent');
  }
}

// ─── One-Time Task Integration Tests ────────────────────────────────────────

console.log('\n── One-Time Task Integration ───────────');

{
  // Helper: build a minimal OneTimeTask
  function makeOneTimeTask(overrides?: Partial<OneTimeTask>): OneTimeTask {
    return {
      id: 'ot-test-1',
      name: 'Test One-Time',
      scheduledDate: new Date(2026, 1, 17), // Feb 17
      startHour: 10,
      startMinute: 0,
      durationHours: 4,
      subTeams: [],
      slots: [{
        id: 'ot-slot-1',
        label: 'Slot 1',
        acceptableLevels: [{ level: Level.L0 }, { level: Level.L2 }],
        requiredCertifications: [Certification.Nitzan],
      }],
      sameGroupRequired: false,
      isLight: false,
      blocksConsecutive: true,
      ...overrides,
    };
  }

  // Test 1: OneTimeTask has all required fields
  const ot = makeOneTimeTask();
  assert(ot.id === 'ot-test-1', 'OneTimeTask has id');
  assert(ot.scheduledDate instanceof Date, 'OneTimeTask scheduledDate is Date');
  assert(ot.startHour === 10, 'OneTimeTask startHour preserved');
  assert(ot.durationHours === 4, 'OneTimeTask durationHours preserved');

  // Test 2: Midnight-crossing one-time task — end time computation
  const midnightOt = makeOneTimeTask({
    startHour: 22,
    startMinute: 0,
    durationHours: 8,
  });
  const mStart = new Date(2026, 1, 17, midnightOt.startHour, midnightOt.startMinute);
  const mEnd = new Date(mStart.getTime() + midnightOt.durationHours * 3600000);
  assert(mEnd.getHours() === 6, 'Midnight crossing: end hour is 6');
  assert(mEnd.getDate() === 18, 'Midnight crossing: end is next day (18th)');

  // Test 3: Constraint flags carry through
  const heavyOt = makeOneTimeTask({
    blocksConsecutive: true,
    requiresCategoryBreak: true,
    isLight: false,
    sameGroupRequired: true,
    schedulingPriority: 5,
    displayCategory: 'patrol',
    togethernessRelevant: true,
    baseLoadWeight: 0.5,
  });
  assert(heavyOt.blocksConsecutive === true, 'Constraint: blocksConsecutive');
  assert(heavyOt.requiresCategoryBreak === true, 'Constraint: requiresCategoryBreak');
  assert(heavyOt.sameGroupRequired === true, 'Constraint: sameGroupRequired');
  assert(heavyOt.schedulingPriority === 5, 'Constraint: schedulingPriority');
  assert(heavyOt.displayCategory === 'patrol', 'Constraint: displayCategory');
  assert(heavyOt.baseLoadWeight === 0.5, 'Constraint: baseLoadWeight');

  // Test 4: HC-5 overlap detection — one-time task overlaps with a template-generated task
  const otTask: Task = {
    id: 'ot-overlap-1',
    name: 'D3 One-Time Overlap',
    timeBlock: {
      start: new Date(2026, 1, 17, 10, 0),
      end: new Date(2026, 1, 17, 14, 0),
    },
    requiredCount: 1,
    slots: [{
      slotId: 'ot-overlap-slot-1',
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [],
    }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  // Overlapping template task (12:00-16:00 same day)
  const tplTask: Task = {
    id: 'tpl-overlap-1',
    name: 'D3 Shemesh',
    timeBlock: {
      start: new Date(2026, 1, 17, 12, 0),
      end: new Date(2026, 1, 17, 16, 0),
    },
    requiredCount: 1,
    slots: [{
      slotId: 'tpl-overlap-slot-1',
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [],
    }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  // Overlap check
  assert(
    blocksOverlap(otTask.timeBlock, tplTask.timeBlock) === true,
    'HC-5: One-time task overlaps template task',
  );

  // Test 5: Assign same participant to both → HC-5 violation
  const overlapParticipant: Participant = {
    id: 'ot-p1',
    name: 'Overlap Test',
    level: Level.L0,
    certifications: [],
    group: 'Alpha',
    availability: [{
      start: new Date(2026, 1, 15, 5, 0),
      end: new Date(2026, 1, 22, 5, 0),
    }],
    dateUnavailability: [],
  };
  const overlapAssignments = [
    { id: 'oa1', taskId: otTask.id, slotId: otTask.slots[0].slotId, participantId: 'ot-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'oa2', taskId: tplTask.id, slotId: tplTask.slots[0].slotId, participantId: 'ot-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const overlapResult = validateHardConstraints(
    [otTask, tplTask],
    [overlapParticipant],
    overlapAssignments,
  );
  const hasHC5 = overlapResult.violations.some(v => v.code === 'DOUBLE_BOOKING');
  assert(hasHC5, 'HC-5 violation detected when same participant in overlapping one-time + template tasks');

  // Test 6: ID uniqueness — ot- prefix distinguishes from template tasks
  assert(otTask.id.startsWith('ot-'), 'One-time task ID starts with ot- prefix');
  assert(!tplTask.id.startsWith('ot-'), 'Template task ID does not start with ot-');
  assert(otTask.id !== tplTask.id, 'One-time and template task IDs are different');

  // Test 7: Light one-time task
  const lightOt = makeOneTimeTask({ isLight: true, baseLoadWeight: 0 });
  assert(lightOt.isLight === true, 'Light one-time task: isLight=true');
  assert(lightOt.baseLoadWeight === 0, 'Light one-time task: baseLoadWeight=0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEW COMPREHENSIVE TESTS — Strengthening coverage across all modules
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Time Utilities: Edge Cases & Untested Functions ────────────────────────

console.log('\n── Time Utilities: Extended ─────────────');

// blockDurationMinutes
{
  const b = createTimeBlockFromHours(baseDate, 9, 11);
  assert(blockDurationMinutes(b) === 120, 'blockDurationMinutes: 9-11 = 120min');
}
{
  const b = createTimeBlockFromHours(baseDate, 22, 6);
  assert(blockDurationMinutes(b) === 480, 'blockDurationMinutes: 22-06 midnight crossing = 480min');
}

// gapMinutes
{
  const a = createTimeBlockFromHours(baseDate, 6, 10);
  const b = createTimeBlockFromHours(baseDate, 12, 16);
  assert(gapMinutes(a, b) === 120, 'gapMinutes: 2h gap = 120min');
}
{
  const a = createTimeBlockFromHours(baseDate, 6, 10);
  const b = createTimeBlockFromHours(baseDate, 10, 14);
  assert(gapMinutes(a, b) === 0, 'gapMinutes: adjacent blocks = 0min');
}
{
  const a = createTimeBlockFromHours(baseDate, 6, 12);
  const b = createTimeBlockFromHours(baseDate, 10, 14);
  assert(gapMinutes(a, b) === 0, 'gapMinutes: overlapping blocks = 0min');
}

// sortBlocksByStart
{
  const blocks = [
    createTimeBlockFromHours(baseDate, 14, 18),
    createTimeBlockFromHours(baseDate, 6, 10),
    createTimeBlockFromHours(baseDate, 10, 14),
  ];
  const sorted = sortBlocksByStart(blocks);
  assert(sorted[0].start.getHours() === 6, 'sortBlocksByStart: first starts at 6');
  assert(sorted[1].start.getHours() === 10, 'sortBlocksByStart: second starts at 10');
  assert(sorted[2].start.getHours() === 14, 'sortBlocksByStart: third starts at 14');
  // Original array unchanged
  assert(blocks[0].start.getHours() === 14, 'sortBlocksByStart: does not mutate original');
}
{
  const sorted = sortBlocksByStart([]);
  assert(sorted.length === 0, 'sortBlocksByStart: empty array returns empty');
}

// formatBlock
{
  const b = createTimeBlockFromHours(new Date(2026, 1, 15), 9, 17);
  const formatted = formatBlock(b);
  assert(formatted.includes('2026-02-15'), 'formatBlock: includes date');
  assert(formatted.includes('09:00'), 'formatBlock: includes start time');
  assert(formatted.includes('17:00'), 'formatBlock: includes end time');
  assert(formatted.includes('→'), 'formatBlock: includes arrow separator');
}

// getTimelineBounds
{
  const blocks = [
    createTimeBlockFromHours(baseDate, 10, 14),
    createTimeBlockFromHours(baseDate, 6, 8),
    createTimeBlockFromHours(baseDate, 18, 22),
  ];
  const bounds = getTimelineBounds(blocks);
  assert(bounds !== null, 'getTimelineBounds: non-null for non-empty');
  assert(bounds!.start.getHours() === 6, 'getTimelineBounds: earliest start = 6');
  assert(bounds!.end.getHours() === 22, 'getTimelineBounds: latest end = 22');
}
{
  const bounds = getTimelineBounds([]);
  assert(bounds === null, 'getTimelineBounds: null for empty array');
}

// isDateInBlock
{
  const b = createTimeBlockFromHours(baseDate, 9, 17);
  const inside = new Date(2026, 1, 15, 12, 0);
  const before = new Date(2026, 1, 15, 8, 0);
  const atStart = new Date(2026, 1, 15, 9, 0);
  assert(isDateInBlock(inside, b) === true, 'isDateInBlock: midpoint is inside');
  assert(isDateInBlock(before, b) === false, 'isDateInBlock: before block is outside');
  assert(isDateInBlock(atStart, b) === true, 'isDateInBlock: start boundary is inside');
}

// mergeBlocks: non-overlapping blocks stay separate
{
  const blocks = [
    createTimeBlockFromHours(baseDate, 6, 8),
    createTimeBlockFromHours(baseDate, 10, 12),
    createTimeBlockFromHours(baseDate, 14, 16),
  ];
  const merged = mergeBlocks(blocks);
  assert(merged.length === 3, 'mergeBlocks: 3 non-overlapping → 3');
}

// mergeBlocks: all overlapping merge into one
{
  const blocks = [
    createTimeBlockFromHours(baseDate, 6, 12),
    createTimeBlockFromHours(baseDate, 8, 16),
    createTimeBlockFromHours(baseDate, 14, 20),
  ];
  const merged = mergeBlocks(blocks);
  assert(merged.length === 1, 'mergeBlocks: fully overlapping chain → 1');
  assert(blockDurationHours(merged[0]) === 14, 'mergeBlocks: merged 6-20 = 14h');
}

// mergeBlocks: empty input
{
  const merged = mergeBlocks([]);
  assert(merged.length === 0, 'mergeBlocks: empty → empty');
}

// createTimeBlockFromHours with explicit durationHours
{
  const b = createTimeBlockFromHours(baseDate, 22, 0, 10);
  assert(blockDurationHours(b) === 10, 'createTimeBlockFromHours: explicit duration overrides endHour');
  assert(b.end.getHours() === 8, 'createTimeBlockFromHours: explicit duration → end at 08:00');
}

// isFullyCovered: multiple windows covering task
{
  const task = createTimeBlockFromHours(baseDate, 6, 18);
  const windows = [
    { start: new Date(2026, 1, 15, 6, 0), end: new Date(2026, 1, 15, 12, 0) },
    { start: new Date(2026, 1, 15, 12, 0), end: new Date(2026, 1, 15, 18, 0) },
  ];
  // isFullyCovered requires a SINGLE window to cover the entire task
  assert(isFullyCovered(task, windows) === false, 'isFullyCovered: split windows do NOT cover (requires single window)');
}

// blocksOverlap: identical blocks
{
  const b = createTimeBlockFromHours(baseDate, 10, 14);
  assert(blocksOverlap(b, b) === true, 'blocksOverlap: identical blocks overlap');
}

// blocksOverlap: one inside another
{
  const outer = createTimeBlockFromHours(baseDate, 6, 18);
  const inner = createTimeBlockFromHours(baseDate, 10, 14);
  assert(blocksOverlap(outer, inner) === true, 'blocksOverlap: contained block overlaps');
  assert(blocksOverlap(inner, outer) === true, 'blocksOverlap: symmetric containment');
}

// ─── Hard Constraints: Individual Functions ─────────────────────────────────

console.log('\n── Hard Constraints: Individual Functions ──');

// ── HC-1: checkLevelRequirement ────────────────────────────────────────────

// Level mismatch: L0 in L2-only slot
{
  const l0P: Participant = {
    id: 'hc1-l0', name: 'HC1-L0', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s1', acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [], label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t1', name: 'HC1 Test Task',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [l2Slot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l0P, task, 'hc1-s1');
  assert(v !== null, 'HC-1: L0 in L2-only slot → violation');
  assert(v!.code === 'LEVEL_MISMATCH', 'HC-1: violation code = LEVEL_MISMATCH');
}

// Level match: L2 in L2 slot
{
  const l2P: Participant = {
    id: 'hc1-l2', name: 'HC1-L2', level: Level.L2,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s2', acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [], label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t2', name: 'HC1 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [l2Slot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l2P, task, 'hc1-s2');
  assert(v === null, 'HC-1: L2 in L2 slot → no violation');
}

// Overqualified: L4 in L2 slot (blocked by HC-1 — level not in acceptableLevels)
{
  const l4P: Participant = {
    id: 'hc1-l4', name: 'HC1-L4', level: Level.L4,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s3', acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [], label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t3', name: 'HC1 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [l2Slot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l4P, task, 'hc1-s3');
  assert(v !== null, 'HC-1: L4 not in L2-only slot acceptableLevels → violation');
  assert(v!.code === 'LEVEL_MISMATCH', 'HC-1: correct violation code for level mismatch');
}

// Nonexistent slot
{
  const pAny: Participant = {
    id: 'hc1-any', name: 'HC1-Any', level: Level.L0,
    certifications: [], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc1-t4', name: 'HC1 Test4',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkLevelRequirement(pAny, task, 'nonexistent-slot');
  assert(v !== null, 'HC-1: nonexistent slot → violation');
  assert(v!.code === 'SLOT_NOT_FOUND', 'HC-1: nonexistent slot → SLOT_NOT_FOUND');
}

// ── HC-2: checkCertificationRequirement ────────────────────────────────────

// Multiple required certs — missing one
{
  const pOneCert: Participant = {
    id: 'hc2-p1', name: 'HC2-P1', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const multiCertSlot: SlotRequirement = {
    slotId: 'hc2-s1', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [Certification.Nitzan, Certification.Hamama], label: 'Multi Cert',
  };
  const task: Task = {
    id: 'hc2-t1', name: 'HC2 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [multiCertSlot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pOneCert, task, 'hc2-s1');
  assert(v !== null, 'HC-2: missing one of two certs → violation');
  assert(v!.code === 'CERT_MISSING', 'HC-2: violation code = CERT_MISSING');
}

// All certs present
{
  const pBothCerts: Participant = {
    id: 'hc2-p2', name: 'HC2-P2', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const multiCertSlot: SlotRequirement = {
    slotId: 'hc2-s2', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [Certification.Nitzan, Certification.Hamama], label: 'Multi Cert',
  };
  const task: Task = {
    id: 'hc2-t2', name: 'HC2 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [multiCertSlot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pBothCerts, task, 'hc2-s2');
  assert(v === null, 'HC-2: all certs present → no violation');
}

// No certs required
{
  const pNoCerts: Participant = {
    id: 'hc2-p3', name: 'HC2-P3', level: Level.L0,
    certifications: [], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const noCertSlot: SlotRequirement = {
    slotId: 'hc2-s3', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'No Cert',
  };
  const task: Task = {
    id: 'hc2-t3', name: 'HC2 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [noCertSlot],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pNoCerts, task, 'hc2-s3');
  assert(v === null, 'HC-2: no certs required → no violation');
}

// ── HC-3: checkAvailability ────────────────────────────────────────────────

// Participant not available at all
{
  const noAvailP: Participant = {
    id: 'hc3-p1', name: 'HC3-NoAvail', level: Level.L0,
    certifications: [], group: 'A',
    availability: [], dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t1', name: 'HC3 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkAvailability(noAvailP, task);
  assert(v !== null, 'HC-3: no availability → violation');
  assert(v!.code === 'AVAILABILITY_VIOLATION', 'HC-3: violation code = AVAILABILITY_VIOLATION');
}

// Partial availability
{
  const partialP: Participant = {
    id: 'hc3-p2', name: 'HC3-Partial', level: Level.L0,
    certifications: [], group: 'A',
    availability: [{ start: new Date(2026, 1, 15, 8, 0), end: new Date(2026, 1, 15, 12, 0) }],
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t2', name: 'HC3 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkAvailability(partialP, task);
  assert(v !== null, 'HC-3: partial availability → violation');
}

// Full availability
{
  const fullP: Participant = {
    id: 'hc3-p3', name: 'HC3-Full', level: Level.L0,
    certifications: [], group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t3', name: 'HC3 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1, slots: [],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };
  const v = checkAvailability(fullP, task);
  assert(v === null, 'HC-3: full availability → no violation');
}

// ── HC-4: checkSameGroup ────────────────────────────────────────────────

{
  const groupATask: Task = {
    id: 'hc4-t1', name: 'HC4 GroupTask',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2, slots: [],
    isLight: false, sameGroupRequired: true, blocksConsecutive: true,
  };
  const pGroupA: Participant = {
    id: 'hc4-pa', name: 'HC4-A', level: Level.L0,
    certifications: [], group: 'Alpha',
    availability: dayAvail, dateUnavailability: [],
  };
  const pGroupB: Participant = {
    id: 'hc4-pb', name: 'HC4-B', level: Level.L0,
    certifications: [], group: 'Beta',
    availability: dayAvail, dateUnavailability: [],
  };
  // Different groups → violation
  const vDiff = checkSameGroup(groupATask, [pGroupA, pGroupB]);
  assert(vDiff.length === 1, 'HC-4: different groups → 1 violation');
  assert(vDiff[0].code === 'GROUP_MISMATCH', 'HC-4: violation code = GROUP_MISMATCH');

  // Same group → no violation
  const pGroupA2: Participant = { ...pGroupB, id: 'hc4-pa2', group: 'Alpha' };
  const vSame = checkSameGroup(groupATask, [pGroupA, pGroupA2]);
  assert(vSame.length === 0, 'HC-4: same group → no violations');

  // Non-group task → no violation regardless
  const nonGroupTask: Task = { ...groupATask, id: 'hc4-t2', sameGroupRequired: false };
  const vNonGroup = checkSameGroup(nonGroupTask, [pGroupA, pGroupB]);
  assert(vNonGroup.length === 0, 'HC-4: non-group task → no violations');

  // Empty participants → no violation
  const vEmpty = checkSameGroup(groupATask, []);
  assert(vEmpty.length === 0, 'HC-4: empty participants → no violations');
}

// ── HC-6: checkSlotsFilled ─────────────────────────────────────────────

{
  const slot1: SlotRequirement = {
    slotId: 'hc6-s1', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'Slot 1',
  };
  const slot2: SlotRequirement = {
    slotId: 'hc6-s2', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'Slot 2',
  };
  const task: Task = {
    id: 'hc6-t1', name: 'HC6 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2, slots: [slot1, slot2],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };

  // Slot unfilled
  const assigns1: Assignment[] = [
    { id: 'hc6-a1', taskId: 'hc6-t1', slotId: 'hc6-s1', participantId: 'p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v1 = checkSlotsFilled(task, assigns1);
  assert(v1.length === 1, 'HC-6: one unfilled slot → 1 violation');
  assert(v1[0].code === 'SLOT_UNFILLED', 'HC-6: violation code = SLOT_UNFILLED');

  // Slot overbooked
  const assigns2: Assignment[] = [
    { id: 'hc6-a2', taskId: 'hc6-t1', slotId: 'hc6-s1', participantId: 'p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc6-a3', taskId: 'hc6-t1', slotId: 'hc6-s1', participantId: 'p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc6-a4', taskId: 'hc6-t1', slotId: 'hc6-s2', participantId: 'p3', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v2 = checkSlotsFilled(task, assigns2);
  assert(v2.length === 1, 'HC-6: one overbooked slot → 1 violation');
  assert(v2[0].code === 'SLOT_OVERBOOKED', 'HC-6: violation code = SLOT_OVERBOOKED');

  // All filled correctly
  const assigns3: Assignment[] = [
    { id: 'hc6-a5', taskId: 'hc6-t1', slotId: 'hc6-s1', participantId: 'p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc6-a6', taskId: 'hc6-t1', slotId: 'hc6-s2', participantId: 'p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v3 = checkSlotsFilled(task, assigns3);
  assert(v3.length === 0, 'HC-6: all slots filled correctly → no violations');

  // Both slots unfilled
  const v4 = checkSlotsFilled(task, []);
  assert(v4.length === 2, 'HC-6: both slots unfilled → 2 violations');
}

// ── HC-7: checkUniqueParticipantsPerTask ─────────────────────────────────

{
  const slot1: SlotRequirement = {
    slotId: 'hc7-s1', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'Slot 1',
  };
  const slot2: SlotRequirement = {
    slotId: 'hc7-s2', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [], label: 'Slot 2',
  };
  const task: Task = {
    id: 'hc7-t1', name: 'HC7 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2, slots: [slot1, slot2],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true,
  };

  // Same participant in two slots → violation
  const assigns: Assignment[] = [
    { id: 'hc7-a1', taskId: 'hc7-t1', slotId: 'hc7-s1', participantId: 'dup-p', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc7-a2', taskId: 'hc7-t1', slotId: 'hc7-s2', participantId: 'dup-p', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = checkUniqueParticipantsPerTask(task, assigns);
  assert(v.length === 1, 'HC-7: duplicate participant → 1 violation');
  assert(v[0].code === 'DUPLICATE_IN_TASK', 'HC-7: violation code = DUPLICATE_IN_TASK');

  // Different participants → no violation
  const uniqueAssigns: Assignment[] = [
    { id: 'hc7-a3', taskId: 'hc7-t1', slotId: 'hc7-s1', participantId: 'p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc7-a4', taskId: 'hc7-t1', slotId: 'hc7-s2', participantId: 'p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v2 = checkUniqueParticipantsPerTask(task, uniqueAssigns);
  assert(v2.length === 0, 'HC-7: unique participants → no violations');
}

// ── HC-8: checkGroupFeasibility ────────────────────────────────────────────

{
  const l0Slot: SlotRequirement = {
    slotId: 'hc8-s-l0', acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [Certification.Nitzan], label: 'L0 Slot',
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc8-s-l2', acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [Certification.Nitzan], label: 'L2 Slot',
  };
  const task: Task = {
    id: 'hc8-t1', name: 'HC8 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2, slots: [l0Slot, l2Slot],
    isLight: false, sameGroupRequired: true, blocksConsecutive: true,
  };

  // Group has both L0 and L2 with certs → no violation
  const fullGroup: Participant[] = [
    { id: 'hc8-p1', name: 'L0-1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] },
    { id: 'hc8-p2', name: 'L2-1', level: Level.L2, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] },
  ];
  const v1 = checkGroupFeasibility(task, fullGroup);
  assert(v1.length === 0, 'HC-8: group has all needed levels+certs → no violations');

  // Group missing L2 → violation
  const noL2Group: Participant[] = [
    { id: 'hc8-p3', name: 'L0-2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] },
    { id: 'hc8-p4', name: 'L0-3', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] },
  ];
  const v2 = checkGroupFeasibility(task, noL2Group);
  assert(v2.length === 1, 'HC-8: group missing L2 → 1 violation');
  assert(v2[0].code === 'GROUP_INSUFFICIENT', 'HC-8: violation code = GROUP_INSUFFICIENT');

  // Non-sameGroupRequired task → no check
  const nonGroupTask: Task = { ...task, id: 'hc8-t2', sameGroupRequired: false };
  const v3 = checkGroupFeasibility(nonGroupTask, noL2Group);
  assert(v3.length === 0, 'HC-8: non-group task → no violations');

  // Group has L2 but missing Nitzan cert → violation
  const noCertGroup: Participant[] = [
    { id: 'hc8-p5', name: 'L0-c', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] },
    { id: 'hc8-p6', name: 'L2-nc', level: Level.L2, certifications: [], group: 'A', availability: dayAvail, dateUnavailability: [] },
  ];
  const v4 = checkGroupFeasibility(task, noCertGroup);
  assert(v4.length === 1, 'HC-8: group L2 missing cert → violation');
}

// ── HC-14: checkCategoryBreak ──────────────────────────────────────────────

console.log('\n── Category Break (HC-14) ──────────────');

{
  const catP: Participant = {
    id: 'hc14-p1', name: 'HC14Tester', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };

  // Two category-break tasks with only 3h gap → violation (need 5h)
  const catTask1: Task = {
    id: 'hc14-t1', name: 'Cat Task 1',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 10),
    requiredCount: 1, slots: [{ slotId: 'hc14-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true, requiresCategoryBreak: true,
  };
  const catTask2: Task = {
    id: 'hc14-t2', name: 'Cat Task 2',
    timeBlock: createTimeBlockFromHours(baseDate, 13, 17),
    requiredCount: 1, slots: [{ slotId: 'hc14-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false, sameGroupRequired: false, blocksConsecutive: true, requiresCategoryBreak: true,
  };
  const tMap14 = new Map([[ catTask1.id, catTask1 ], [ catTask2.id, catTask2 ]]);
  const assigns14: Assignment[] = [
    { id: 'hc14-a1', taskId: catTask1.id, slotId: 'hc14-s1', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc14-a2', taskId: catTask2.id, slotId: 'hc14-s2', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v1 = checkCategoryBreak(catP.id, assigns14, tMap14);
  assert(v1.length === 1, 'HC-14: 3h gap between category tasks → violation');
  assert(v1[0].code === 'CATEGORY_BREAK_VIOLATION', 'HC-14: violation code = CATEGORY_BREAK_VIOLATION');

  // 6h gap → no violation
  const catTask3: Task = {
    ...catTask2, id: 'hc14-t3',
    timeBlock: createTimeBlockFromHours(baseDate, 16, 20),
  };
  const tMap14b = new Map([[ catTask1.id, catTask1 ], [ catTask3.id, catTask3 ]]);
  const assigns14b: Assignment[] = [
    { id: 'hc14-a3', taskId: catTask1.id, slotId: 'hc14-s1', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc14-a4', taskId: catTask3.id, slotId: 'hc14-s2', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v2 = checkCategoryBreak(catP.id, assigns14b, tMap14b);
  assert(v2.length === 0, 'HC-14: 6h gap between category tasks → no violation');

  // One task without requiresCategoryBreak → no violation
  const catTask4: Task = {
    ...catTask2, id: 'hc14-t4', requiresCategoryBreak: false,
  };
  const tMap14c = new Map([[ catTask1.id, catTask1 ], [ catTask4.id, catTask4 ]]);
  const assigns14c: Assignment[] = [
    { id: 'hc14-a5', taskId: catTask1.id, slotId: 'hc14-s1', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc14-a6', taskId: catTask4.id, slotId: 'hc14-s2', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v3 = checkCategoryBreak(catP.id, assigns14c, tMap14c);
  assert(v3.length === 0, 'HC-14: one task without category flag → no violation');

  // Exactly 5h gap → no violation (equal to minimum)
  const catTask5: Task = {
    ...catTask2, id: 'hc14-t5',
    timeBlock: createTimeBlockFromHours(baseDate, 15, 19),
  };
  const tMap14d = new Map([[ catTask1.id, catTask1 ], [ catTask5.id, catTask5 ]]);
  const assigns14d: Assignment[] = [
    { id: 'hc14-a7', taskId: catTask1.id, slotId: 'hc14-s1', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'hc14-a8', taskId: catTask5.id, slotId: 'hc14-s2', participantId: catP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v4 = checkCategoryBreak(catP.id, assigns14d, tMap14d);
  assert(v4.length === 0, 'HC-14: exactly 5h gap → no violation');

  // validateHardConstraints integration with HC-14
  const r14 = validateHardConstraints([catTask1, catTask2], [catP], assigns14);
  assert(r14.violations.some(v => v.code === 'CATEGORY_BREAK_VIOLATION'), 'HC-14: full validation catches category break');
}

// ── disabledHC parameter ───────────────────────────────────────────────────

console.log('\n── disabledHC Parameter ─────────────────');

{
  // Setup: L4 in Shemesh (L0-only → blocked by HC-1) + same participant double-booked (blocked by HC-5)
  const disP: Participant = {
    id: 'dis-p1', name: 'DisabledTest', level: Level.L4,
    certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const disTask1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const disTask2 = createHamamaTask(createTimeBlockFromHours(baseDate, 8, 14));
  const disAssigns: Assignment[] = [
    { id: 'dis-a1', taskId: disTask1.id, slotId: disTask1.slots[0].slotId, participantId: disP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'dis-a2', taskId: disTask2.id, slotId: disTask2.slots[0].slotId, participantId: disP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];

  // No disabled → both violations (HC-1 LEVEL_MISMATCH + HC-5 DOUBLE_BOOKING)
  const rAll = validateHardConstraints([disTask1, disTask2], [disP], disAssigns);
  assert(rAll.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 fires when not disabled');
  assert(rAll.violations.some(v => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 fires when not disabled');

  // Disable HC-1 → only HC-5 remains
  const r1Off = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-1']));
  assert(!r1Off.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 suppressed when disabled');
  assert(r1Off.violations.some(v => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 still fires when HC-1 disabled');

  // Disable HC-5 → only HC-1 remains
  const r5Off = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-5']));
  assert(!r5Off.violations.some(v => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 suppressed when disabled');
  assert(r5Off.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 still fires when HC-5 disabled');

  // Disable both → no level or double-booking violations (other violations may remain)
  const rBothOff = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-1', 'HC-5']));
  assert(!rBothOff.violations.some(v => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 suppressed');
  assert(!rBothOff.violations.some(v => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 suppressed');

  // Disable HC-6 → unfilled slots don't produce violations
  const singleSlotTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 14));
  const emptyAssigns: Assignment[] = [];
  const r6On = validateHardConstraints([singleSlotTask], [disP], emptyAssigns);
  assert(r6On.violations.some(v => v.code === 'SLOT_UNFILLED'), 'disabledHC: HC-6 fires when not disabled');
  const r6Off = validateHardConstraints([singleSlotTask], [disP], emptyAssigns, new Set(['HC-6']));
  assert(!r6Off.violations.some(v => v.code === 'SLOT_UNFILLED'), 'disabledHC: HC-6 suppressed when disabled');
}

// ─── Validator: Extended Tests ──────────────────────────────────────────────

console.log('\n── Validator: Extended ──────────────────');

// fullValidate with both hard violations and warnings
{
  // L4 in Hamama → valid but with LOW_PRIORITY_LEVEL warning
  const valP: Participant = {
    id: 'val-l4', name: 'Val-L4', level: Level.L4,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    { id: 'val-a1', taskId: valTask.id, slotId: valTask.slots[0].slotId, participantId: valP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const fvr = fullValidate([valTask], [valP], valAssigns);
  // L4 in Hamama is allowed (no hard violation) because acceptableLevels has L4 lowPriority
  assert(fvr.warnings.some(w => w.code === 'LOW_PRIORITY_LEVEL'), 'fullValidate: L4 in Hamama → LOW_PRIORITY_LEVEL warning');
  assert(fvr.summary.includes('אזהרות'), 'fullValidate: summary mentions warnings');
}

// fullValidate: completely valid schedule → תקין summary
{
  const valP0: Participant = {
    id: 'val-p0', name: 'Val-P0', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    { id: 'val-a2', taskId: valTask.id, slotId: valTask.slots[0].slotId, participantId: valP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const fvr = fullValidate([valTask], [valP0], valAssigns);
  assert(fvr.valid === true, 'fullValidate: valid schedule reports valid=true');
  assert(fvr.violations.length === 0, 'fullValidate: no violations');
  assert(fvr.summary.includes('תקין'), 'fullValidate: summary says valid');
}

// fullValidate: invalid schedule → summary mentions violations count
{
  const valPBad: Participant = {
    id: 'val-bad', name: 'Val-Bad', level: Level.L0,
    certifications: [], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    { id: 'val-a3', taskId: valTask.id, slotId: valTask.slots[0].slotId, participantId: valPBad.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const fvr = fullValidate([valTask], [valPBad], valAssigns);
  assert(fvr.valid === false, 'fullValidate: invalid schedule reports valid=false');
  assert(fvr.violations.length > 0, 'fullValidate: has violations');
  assert(fvr.summary.includes('לא תקין'), 'fullValidate: summary says invalid');
}

// previewSwap: valid swap
{
  const swapP1: Participant = {
    id: 'swap-p1', name: 'Swap-P1', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const swapP2: Participant = {
    id: 'swap-p2', name: 'Swap-P2', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const swapTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const swapAssigns: Assignment[] = [
    { id: 'swap-a1', taskId: swapTask.id, slotId: swapTask.slots[0].slotId, participantId: swapP1.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const result = previewSwap(
    [swapTask], [swapP1, swapP2], swapAssigns,
    { assignmentId: 'swap-a1', newParticipantId: swapP2.id },
  );
  assert(result.valid === true, 'previewSwap: valid swap between two eligible participants');
}

// previewSwap: swap causing double-booking
{
  const dbP1: Participant = {
    id: 'db-p1', name: 'DB-P1', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const dbP2: Participant = {
    id: 'db-p2', name: 'DB-P2', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const dbTask1 = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const dbTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 8, 14));
  const dbAssigns: Assignment[] = [
    { id: 'db-a1', taskId: dbTask1.id, slotId: dbTask1.slots[0].slotId, participantId: dbP1.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'db-a2', taskId: dbTask2.id, slotId: dbTask2.slots[0].slotId, participantId: dbP2.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  // Swap dbTask2 to dbP1 → overlaps with dbTask1
  const result = previewSwap(
    [dbTask1, dbTask2], [dbP1, dbP2], dbAssigns,
    { assignmentId: 'db-a2', newParticipantId: dbP1.id },
  );
  assert(result.valid === false, 'previewSwap: swap causing double-booking → invalid');
  assert(result.violations.some(v => v.code === 'DOUBLE_BOOKING'), 'previewSwap: double-booking violation detected');
}

// ── isEligible / getRejectionReason ────────────────────────────────────────

console.log('\n── Eligibility & Rejection Reasons ─────');

{
  const eligP: Participant = {
    id: 'elig-p1', name: 'Elig-P1', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const eligTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const eligSlot = eligTask.slots[0];
  const tMap = new Map([[eligTask.id, eligTask]]);

  // Eligible with no existing assignments
  assert(isEligible(eligP, eligTask, eligSlot, [], tMap) === true, 'isEligible: eligible participant → true');
  assert(getRejectionReason(eligP, eligTask, eligSlot, [], tMap) === null, 'getRejectionReason: eligible → null');

  // Missing cert
  const noCertP: Participant = { ...eligP, id: 'elig-p2', certifications: [Certification.Nitzan] };
  assert(isEligible(noCertP, eligTask, eligSlot, [], tMap) === false, 'isEligible: missing cert → false');
  assert(getRejectionReason(noCertP, eligTask, eligSlot, [], tMap) === 'HC-2', 'getRejectionReason: missing cert → HC-2');

  // Already assigned to same task → HC-5 fires first (same timeblock overlaps with itself)
  const existingAssign: Assignment[] = [
    { id: 'elig-a1', taskId: eligTask.id, slotId: eligSlot.slotId, participantId: eligP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  assert(isEligible(eligP, eligTask, eligSlot, existingAssign, tMap) === false, 'isEligible: already assigned → false');
  assert(getRejectionReason(eligP, eligTask, eligSlot, existingAssign, tMap) === 'HC-5', 'getRejectionReason: already assigned (same block overlap) → HC-5');

  // Already assigned to a NON-overlapping task of same ID → would be HC-7
  // But in practice tasks have unique IDs, so HC-5 and HC-7 are correlated

  // Double-booking: existing overlapping assignment
  const otherTask = createShemeshTask(createTimeBlockFromHours(baseDate, 8, 14));
  const tMap2 = new Map([[eligTask.id, eligTask], [otherTask.id, otherTask]]);
  const overlapAssign: Assignment[] = [
    { id: 'elig-a2', taskId: otherTask.id, slotId: otherTask.slots[0].slotId, participantId: eligP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  assert(isEligible(eligP, eligTask, eligSlot, overlapAssign, tMap2) === false, 'isEligible: overlapping task → false');
  assert(getRejectionReason(eligP, eligTask, eligSlot, overlapAssign, tMap2) === 'HC-5', 'getRejectionReason: overlap → HC-5');

  // No availability
  const noAvailP: Participant = { ...eligP, id: 'elig-p3', availability: [] };
  assert(isEligible(noAvailP, eligTask, eligSlot, [], tMap) === false, 'isEligible: no availability → false');
  assert(getRejectionReason(noAvailP, eligTask, eligSlot, [], tMap) === 'HC-3', 'getRejectionReason: no availability → HC-3');
}

// ─── Rest Calculator: Extended Tests ────────────────────────────────────────

console.log('\n── Rest Calculator: Extended ────────────');

// No assignments → Infinity rest, 0 work hours
{
  const rest0 = computeParticipantRest('empty-p', [], []);
  assert(rest0.restGaps.length === 0, 'Rest: no assignments → no rest gaps');
  assert(rest0.minRestHours === Infinity, 'Rest: no assignments → min rest = Infinity');
  assert(rest0.totalWorkHours === 0, 'Rest: no assignments → 0 work hours');
  assert(rest0.nonLightAssignmentCount === 0, 'Rest: no assignments → 0 non-light count');
}

// Single assignment → no rest gaps
{
  const singleTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const singleAssign: Assignment[] = [
    { id: 'rest-s1', taskId: singleTask.id, slotId: singleTask.slots[0].slotId, participantId: 'rest-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const rest1 = computeParticipantRest('rest-p1', singleAssign, [singleTask]);
  assert(rest1.restGaps.length === 0, 'Rest: single assignment → no rest gaps');
  assert(rest1.nonLightAssignmentCount === 1, 'Rest: single assignment → count=1');
  assert(rest1.totalWorkHours === 4, 'Rest: 4h task → 4h work');
}

// Light-only assignments → 0 work hours
{
  const lightTask = createKarovitTask(createTimeBlockFromHours(baseDate, 6, 14));
  const lightAssign: Assignment[] = [
    { id: 'rest-l1', taskId: lightTask.id, slotId: lightTask.slots[0].slotId, participantId: 'rest-p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const restLight = computeParticipantRest('rest-p2', lightAssign, [lightTask]);
  assert(restLight.nonLightAssignmentCount === 0, 'Rest: light only → 0 non-light count');
  assert(restLight.totalWorkHours === 0, 'Rest: light only → 0 work hours');
  assert(restLight.totalLightHours === 8, 'Rest: light 8h → totalLightHours=8');
}

// Three tasks with varying gaps → correct min/max/avg
{
  const r3t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 8));   // 2h
  const r3t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 12, 14)); // 2h, gap=4h
  const r3t3 = createShemeshTask(createTimeBlockFromHours(baseDate, 20, 22)); // 2h, gap=6h
  const r3Assigns: Assignment[] = [
    { id: 'r3-a1', taskId: r3t1.id, slotId: r3t1.slots[0].slotId, participantId: 'rest-p3', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'r3-a2', taskId: r3t2.id, slotId: r3t2.slots[0].slotId, participantId: 'rest-p3', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'r3-a3', taskId: r3t3.id, slotId: r3t3.slots[0].slotId, participantId: 'rest-p3', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const rest3 = computeParticipantRest('rest-p3', r3Assigns, [r3t1, r3t2, r3t3]);
  assert(rest3.restGaps.length === 2, 'Rest: 3 tasks → 2 rest gaps');
  assert(rest3.minRestHours === 4, 'Rest: min rest = 4h');
  assert(rest3.maxRestHours === 6, 'Rest: max rest = 6h');
  assert(rest3.avgRestHours === 5, 'Rest: avg rest = 5h');
  assert(rest3.nonLightAssignmentCount === 3, 'Rest: 3 non-light tasks counted');
  assert(rest3.totalWorkHours === 6, 'Rest: 3×2h = 6h work');
}

// Non-blocking task (blocksConsecutive=false) doesn't create penalised rest gaps
{
  const blockingTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const nonBlockingTask = createKarovTask(createTimeBlockFromHours(baseDate, 10, 14)); // blocksConsecutive=false
  const blockingTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));
  const nbAssigns: Assignment[] = [
    { id: 'nb-a1', taskId: blockingTask.id, slotId: blockingTask.slots[0].slotId, participantId: 'rest-p4', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'nb-a2', taskId: nonBlockingTask.id, slotId: nonBlockingTask.slots[0].slotId, participantId: 'rest-p4', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'nb-a3', taskId: blockingTask2.id, slotId: blockingTask2.slots[0].slotId, participantId: 'rest-p4', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const restNb = computeParticipantRest('rest-p4', nbAssigns, [blockingTask, nonBlockingTask, blockingTask2]);
  // Karov (non-blocking) between two blocking tasks: blocking↔karov gap is NOT penalised
  // Only blocking↔blocking gaps are counted
  assert(restNb.nonLightAssignmentCount === 3, 'Rest: non-blocking still counted as work');
  // The Karov breaks the blocking chain, so we expect gaps between blocking-blocking pairs only
  // With no direct blocking→blocking adjacency, we should see limited rest gaps
  assert(restNb.restGaps.length <= 1, 'Rest: non-blocking task breaks rest gap chain');
}

// computeAllRestProfiles: covers all participants
{
  const rap1: Participant = {
    id: 'rap-1', name: 'RAP1', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const rap2: Participant = {
    id: 'rap-2', name: 'RAP2', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const rapTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const rapAssigns: Assignment[] = [
    { id: 'rap-a1', taskId: rapTask.id, slotId: rapTask.slots[0].slotId, participantId: 'rap-1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const profiles = computeAllRestProfiles([rap1, rap2], rapAssigns, [rapTask]);
  assert(profiles.size === 2, 'computeAllRestProfiles: returns profile for each participant');
  assert(profiles.get('rap-1')!.nonLightAssignmentCount === 1, 'computeAllRestProfiles: rap-1 has 1 assignment');
  assert(profiles.get('rap-2')!.nonLightAssignmentCount === 0, 'computeAllRestProfiles: rap-2 has 0 assignments');
}

// computeRestFairness: multiple participants with different rest profiles
{
  const t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 8));
  const t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 10, 12));
  const t3 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 16));
  const p1: Participant = { id: 'rf-1', name: 'RF1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const p2: Participant = { id: 'rf-2', name: 'RF2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const rfAssigns: Assignment[] = [
    { id: 'rf-a1', taskId: t1.id, slotId: t1.slots[0].slotId, participantId: 'rf-1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'rf-a2', taskId: t2.id, slotId: t2.slots[0].slotId, participantId: 'rf-1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'rf-a3', taskId: t1.id, slotId: t1.slots[1].slotId, participantId: 'rf-2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'rf-a4', taskId: t3.id, slotId: t3.slots[0].slotId, participantId: 'rf-2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const profiles = computeAllRestProfiles([p1, p2], rfAssigns, [t1, t2, t3]);
  const fairness = computeRestFairness(profiles);
  assert(fairness.globalMinRest >= 0, 'computeRestFairness: globalMinRest >= 0');
  assert(isFinite(fairness.globalMinRest), 'computeRestFairness: globalMinRest is finite');
  assert(isFinite(fairness.globalAvgRest), 'computeRestFairness: globalAvgRest is finite');
  assert(fairness.stdDevRest >= 0, 'computeRestFairness: stdDevRest >= 0');
}

// computeRestFairness: no participants with rest gaps → Infinity
{
  const emptyProfiles = new Map<string, ParticipantRestProfile>();
  const fairnessEmpty = computeRestFairness(emptyProfiles);
  assert(fairnessEmpty.globalMinRest === Infinity, 'computeRestFairness: empty → Infinity');
  assert(fairnessEmpty.stdDevRest === 0, 'computeRestFairness: empty → stdDev=0');
}

// ─── Soft Constraints: workloadImbalanceSplit ───────────────────────────────

console.log('\n── Soft Constraints: Workload Balance ──');

// Equal workload → zero penalty
{
  const wlTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const wlP1: Participant = { id: 'wl-1', name: 'WL1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const wlP2: Participant = { id: 'wl-2', name: 'WL2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  // Both assigned to identical tasks
  const wlTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const wlAssigns: Assignment[] = [
    { id: 'wl-a1', taskId: wlTask.id, slotId: wlTask.slots[0].slotId, participantId: 'wl-1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'wl-a2', taskId: wlTask2.id, slotId: wlTask2.slots[0].slotId, participantId: 'wl-2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const wlStats = workloadImbalanceSplit([wlP1, wlP2], wlAssigns, [wlTask, wlTask2]);
  assert(wlStats.l0StdDev === 0, 'SC-3: equal workload → l0StdDev=0');
  assert(wlStats.l0Penalty === 0, 'SC-3: equal workload → l0Penalty=0');
}

// Unequal workload → nonzero penalty
{
  const wlTaskBig = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 18)); // 12h
  const wlTaskSmall = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 8)); // 2h
  const wlP1: Participant = { id: 'wl2-1', name: 'WL2-1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const wlP2: Participant = { id: 'wl2-2', name: 'WL2-2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const wlAssigns: Assignment[] = [
    { id: 'wl2-a1', taskId: wlTaskBig.id, slotId: wlTaskBig.slots[0].slotId, participantId: 'wl2-1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'wl2-a2', taskId: wlTaskSmall.id, slotId: wlTaskSmall.slots[0].slotId, participantId: 'wl2-2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const wlStats = workloadImbalanceSplit([wlP1, wlP2], wlAssigns, [wlTaskBig, wlTaskSmall]);
  assert(wlStats.l0StdDev > 0, 'SC-3: unequal workload → l0StdDev > 0');
  assert(wlStats.l0Penalty > 0, 'SC-3: unequal workload → l0Penalty > 0');
  assert(wlStats.l0Avg === 7, 'SC-3: (12+2)/2 = avg 7h');
}

// Split pool: L0 and seniors balanced independently
{
  const spTask1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 14)); // 8h
  const spTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10)); // 4h
  const spL0a: Participant = { id: 'sp2-l0a', name: 'SP-L0a', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const spL0b: Participant = { id: 'sp2-l0b', name: 'SP-L0b', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const spSr: Participant = { id: 'sp2-sr', name: 'SP-Sr', level: Level.L3, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  // L0s get unequal work, senior gets none
  const spAssigns: Assignment[] = [
    { id: 'sp2-a1', taskId: spTask1.id, slotId: spTask1.slots[0].slotId, participantId: 'sp2-l0a', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'sp2-a2', taskId: spTask2.id, slotId: spTask2.slots[0].slotId, participantId: 'sp2-l0b', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const spStats = workloadImbalanceSplit([spL0a, spL0b, spSr], spAssigns, [spTask1, spTask2]);
  assert(spStats.l0StdDev > 0, 'SC-3 split: L0 pool has imbalance');
  assert(spStats.seniorStdDev === 0, 'SC-3 split: senior pool (1 person with 0h) has stdDev=0');
  assert(spStats.seniorAvg === 0, 'SC-3 split: senior avg = 0');
  assert(spStats.l0Avg === 6, 'SC-3 split: L0 avg = (8+4)/2 = 6');
}

// Light tasks → 0 effective hours (not counted in workload)
{
  const lightTask = createKarovitTask(createTimeBlockFromHours(baseDate, 6, 14)); // 8h but light
  const wlPLight: Participant = { id: 'wl-light', name: 'WL-Light', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const lightAssigns: Assignment[] = [
    { id: 'wl-la1', taskId: lightTask.id, slotId: lightTask.slots[0].slotId, participantId: 'wl-light', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const lightStats = workloadImbalanceSplit([wlPLight], lightAssigns, [lightTask]);
  assert(lightStats.l0Avg === 0, 'SC-3: light task → 0 effective hours → avg=0');
}

// ─── collectSoftWarnings ────────────────────────────────────────────────────

console.log('\n── collectSoftWarnings ─────────────────');

// No warnings for a clean schedule
{
  const cwP: Participant = {
    id: 'cw-p1', name: 'CW-P1', level: Level.L0,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const cwTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const cwAssigns: Assignment[] = [
    { id: 'cw-a1', taskId: cwTask.id, slotId: cwTask.slots[0].slotId, participantId: cwP.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const warnings = collectSoftWarnings([cwTask], [cwP], cwAssigns);
  // Should be zero or minimal warnings for a valid L0 assignment
  assert(!warnings.some(w => w.code === 'LOW_PRIORITY_LEVEL'), 'collectSoftWarnings: L0 in Hamama → no LOW_PRIORITY_LEVEL');
}

// LOW_PRIORITY_LEVEL warning for L4 in Hamama
{
  const cwP4: Participant = {
    id: 'cw-p4', name: 'CW-P4', level: Level.L4,
    certifications: [Certification.Hamama, Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const cwTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const cwAssigns: Assignment[] = [
    { id: 'cw-a2', taskId: cwTask.id, slotId: cwTask.slots[0].slotId, participantId: cwP4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const warnings = collectSoftWarnings([cwTask], [cwP4], cwAssigns);
  assert(warnings.some(w => w.code === 'LOW_PRIORITY_LEVEL'), 'collectSoftWarnings: L4 in Hamama → LOW_PRIORITY_LEVEL warning');
}

// ─── computeScheduleScore: Extended Tests ───────────────────────────────────

console.log('\n── computeScheduleScore: Extended ──────');

// Score with zero assignments → baseline
{
  const scoreP: Participant = {
    id: 'score-p1', name: 'Score-P1', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const scoreTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const score = computeScheduleScore([scoreTask], [scoreP], [], DEFAULT_CONFIG);
  assert(score.totalPenalty === 0, 'Score: empty schedule → 0 penalty');
  assert(score.l0StdDev === 0, 'Score: empty schedule → l0StdDev=0');
}

// Score with balanced assignments → low penalty, good composite
{
  const p1: Participant = { id: 'sb-p1', name: 'SB1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const p2: Participant = { id: 'sb-p2', name: 'SB2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));
  const assigns: Assignment[] = [
    { id: 'sb-a1', taskId: t1.id, slotId: t1.slots[0].slotId, participantId: 'sb-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'sb-a2', taskId: t2.id, slotId: t2.slots[0].slotId, participantId: 'sb-p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const scoreBalanced = computeScheduleScore([t1, t2], [p1, p2], assigns, DEFAULT_CONFIG);
  assert(scoreBalanced.l0StdDev === 0, 'Score: balanced 4h each → l0StdDev=0');
  assert(scoreBalanced.l0AvgEffective === 4, 'Score: balanced avg = 4h');
}

// Score with imbalanced assignments → higher penalty
{
  const p1: Participant = { id: 'si-p1', name: 'SI1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const p2: Participant = { id: 'si-p2', name: 'SI2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 14)); // 8h
  const t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18)); // 4h
  // P1 gets both tasks (12h), P2 gets nothing
  const assigns: Assignment[] = [
    { id: 'si-a1', taskId: t1.id, slotId: t1.slots[0].slotId, participantId: 'si-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'si-a2', taskId: t2.id, slotId: t2.slots[0].slotId, participantId: 'si-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const scoreImb = computeScheduleScore([t1, t2], [p1, p2], assigns, DEFAULT_CONFIG);
  assert(scoreImb.l0StdDev > 0, 'Score: imbalanced → l0StdDev > 0');
}

// Score comparison: balanced vs imbalanced → balanced has better composite
{
  const pb1: Participant = { id: 'cmp-p1', name: 'CMP1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const pb2: Participant = { id: 'cmp-p2', name: 'CMP2', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayAvail, dateUnavailability: [] };
  const ct1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const ct2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));

  const balAssigns: Assignment[] = [
    { id: 'cmp-a1', taskId: ct1.id, slotId: ct1.slots[0].slotId, participantId: 'cmp-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'cmp-a2', taskId: ct2.id, slotId: ct2.slots[0].slotId, participantId: 'cmp-p2', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const imbAssigns: Assignment[] = [
    { id: 'cmp-a3', taskId: ct1.id, slotId: ct1.slots[0].slotId, participantId: 'cmp-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'cmp-a4', taskId: ct2.id, slotId: ct2.slots[0].slotId, participantId: 'cmp-p1', status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const scoreBal = computeScheduleScore([ct1, ct2], [pb1, pb2], balAssigns, DEFAULT_CONFIG);
  const scoreImb = computeScheduleScore([ct1, ct2], [pb1, pb2], imbAssigns, DEFAULT_CONFIG);
  assert(scoreBal.compositeScore >= scoreImb.compositeScore, 'Score: balanced schedule has better (>=) composite score than imbalanced');
}

// ─── Engine: Extended Integration Tests ─────────────────────────────────────

console.log('\n── Engine: Extended Integration ─────────');

// Engine validates schedule after generation
{
  const testEngine = new SchedulingEngine({ maxIterations: 200, maxSolverTimeMs: 3000 });
  const p1: Participant = { id: 'eng-p1', name: 'Eng1', level: Level.L0, certifications: [Certification.Nitzan, Certification.Hamama], group: 'A', availability: dayWindow, dateUnavailability: [] };
  const p2: Participant = { id: 'eng-p2', name: 'Eng2', level: Level.L0, certifications: [Certification.Nitzan, Certification.Hamama], group: 'A', availability: dayWindow, dateUnavailability: [] };
  const p3: Participant = { id: 'eng-p3', name: 'Eng3', level: Level.L0, certifications: [Certification.Nitzan, Certification.Hamama], group: 'A', availability: dayWindow, dateUnavailability: [] };
  testEngine.addParticipants([p1, p2, p3]);

  const engTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  testEngine.addTask(engTask);

  const engSchedule = testEngine.generateSchedule();
  assert(engSchedule.assignments.length > 0, 'Engine: generates at least 1 assignment');

  const engValidation = testEngine.validate();
  // A schedule from the engine should pass basic validation
  // (though it may have unfilled slot warnings)
  console.log(`  Engine validation: valid=${engValidation.valid}, violations=${engValidation.violations.length}`);
}

// Engine with no participants → throws validation error
{
  const emptyEngine = new SchedulingEngine({ maxIterations: 100, maxSolverTimeMs: 1000 });
  const emptyTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  emptyEngine.addTask(emptyTask);
  let threwError = false;
  try {
    emptyEngine.generateSchedule();
  } catch (e) {
    threwError = true;
  }
  assert(threwError, 'Engine: no participants → throws validation error');
}

// Engine with no tasks → throws validation error
{
  const noTaskEngine = new SchedulingEngine({ maxIterations: 100, maxSolverTimeMs: 1000 });
  const ntP: Participant = { id: 'nt-p1', name: 'NT1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayWindow, dateUnavailability: [] };
  noTaskEngine.addParticipants([ntP]);
  let threwError = false;
  try {
    noTaskEngine.generateSchedule();
  } catch (e) {
    threwError = true;
  }
  assert(threwError, 'Engine: no tasks → throws validation error');
}

// Engine stats accuracy
{
  const statsEngine = new SchedulingEngine({ maxIterations: 100, maxSolverTimeMs: 1000 });
  const sp1: Participant = { id: 'st-p1', name: 'ST1', level: Level.L0, certifications: [Certification.Nitzan], group: 'A', availability: dayWindow, dateUnavailability: [] };
  const sp2: Participant = { id: 'st-p2', name: 'ST2', level: Level.L2, certifications: [Certification.Nitzan], group: 'A', availability: dayWindow, dateUnavailability: [] };
  statsEngine.addParticipants([sp1, sp2]);
  statsEngine.addTask(createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10)));
  statsEngine.addTask(createHamamaTask(createTimeBlockFromHours(baseDate, 10, 18)));
  const stats = statsEngine.getStats();
  assert(stats.totalTasks === 2, 'Engine stats: 2 tasks');
  assert(stats.totalParticipants === 2, 'Engine stats: 2 participants');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
}
