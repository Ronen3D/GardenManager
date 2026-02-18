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
  TaskType,
  AssignmentStatus,
  ViolationSeverity,
  createTimeBlock,
  createTimeBlockFromHours,
  blockDurationHours,
  blocksOverlap,
  isFullyCovered,
  gapHours,
  generateShiftBlocks,
  mergeBlocks,
  createHamamaTask,
  createShemeshTask,
  createKarovTask,
  createArugaTask,
  createKarovitTask,
  validateHardConstraints,
  computeScheduleScore,
  DEFAULT_CONFIG,
} from './index';
import { fullValidate, previewSwap } from './engine/validator';
import { computeParticipantRest } from './web/utils/rest-calculator';

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

// Test: level mismatch — Shemesh needs Nitzan, but also test level requirements
const testP3: Participant = {
  id: 'tp3', name: 'TestP3', level: Level.L3,
  certifications: [Certification.Nitzan],
  group: 'TestGroup', availability: dayAvail, dateUnavailability: [],
};

const shemeshBlock = createTimeBlockFromHours(baseDate, 10, 14);
const shemeshTask = createShemeshTask(shemeshBlock);
const shemeshAssignment = [
  {
    id: 'sa1', taskId: shemeshTask.id, slotId: shemeshTask.slots[0].slotId,
    participantId: testP0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
  {
    id: 'sa2', taskId: shemeshTask.id, slotId: shemeshTask.slots[1].slotId,
    participantId: testP3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date(),
  },
];
const result3 = validateHardConstraints(
  [shemeshTask],
  [testP0, testP0b, testP3],
  shemeshAssignment,
);
assert(result3.valid === true, 'Valid Shemesh assignment with Nitzan-certified participants');

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
  [testP0, testP0b, testP3],
  doubleBooking,
);
assert(result4.valid === false, 'Double-booking detected');
assert(result4.violations.some((v) => v.code === 'DOUBLE_BOOKING'), 'Violation code = DOUBLE_BOOKING');

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
assert(score1.totalPenalty >= DEFAULT_CONFIG.hamamaL4Penalty, 'Penalty >= hamamaL4Penalty config');

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
assert(fullResult.summary.includes('valid'), 'Summary mentions valid');

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
    type: TaskType.Adanit,
    name: 'Test Task',
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
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
    type: TaskType.Karovit,
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
    type: TaskType.Adanit,
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
    type: TaskType.Hamama,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  assert(computeTaskEffectiveHours(t) >= computeTaskHotHours(t), 'T7: effective ≥ hot (invariant)');
}

// ── Test 8: hot + cold = raw duration for Kruv ──
{
  const t = makeTask({
    type: TaskType.Karov,
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
    type: TaskType.Shemesh,
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
    type: TaskType.Aruga,
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
    type: TaskType.Mamtera,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
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
    type: TaskType.Karov,
    baseLoadWeight: 0.2,
    loadWindows: KRUV_WINDOWS,
    timeBlock: { start: new Date(2026, 1, 15, 5, 0), end: new Date(2026, 1, 15, 13, 0) },
  });
  const b = makeTask({
    id: 'kruv-b',
    type: TaskType.Karov,
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
import { checkChoreshExclusion, checkNoConsecutiveHighLoad } from './constraints/hard-constraints';
import { getLoadWeightAtTime, isHighLoadAtBoundary } from './web/utils/load-weighting';
import {
  isNaturalRole,
  checkSeniorHardBlock,
  validateSeniorHardBlocks,
  computeSeniorOutOfRolePenalty,
} from './constraints/senior-policy';
import { AdanitTeam } from './models/types';
import type { SlotRequirement, Assignment } from './models/types';

console.log('\n── Choresh Constraint (HC-11) ───────────');

const mamteraTask = createMamteraTask(baseDate);

// Non-choresh participant → no violation on Mamtera
{
  const normalP: Participant = {
    id: 'tc-normal', name: 'NormalPerson', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const violations = checkChoreshExclusion(mamteraTask, [normalP]);
  assert(violations.length === 0, 'HC-11: Non-choresh → no Mamtera violation');
}

// Choresh participant → violation on Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor', name: 'ChoreshPerson', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const violations = checkChoreshExclusion(mamteraTask, [choreshP]);
  assert(violations.length === 1, 'HC-11: Choresh → Mamtera violation');
  assert(violations[0].code === 'CHORESH_FORBIDDEN_MAMTERA', 'HC-11: violation code = CHORESH_FORBIDDEN_MAMTERA');
}

// Choresh participant on non-Mamtera task → no violation
{
  const choreshP: Participant = {
    id: 'tc-chor2', name: 'ChoreshPerson2', level: Level.L0,
    certifications: [Certification.Nitzan, Certification.Hamama, Certification.Horesh], group: 'A',
    availability: dayAvail, dateUnavailability: [],
  };
  const violations = checkChoreshExclusion(hamamaTask, [choreshP]);
  assert(violations.length === 0, 'HC-11: Choresh on Hamama → no violation (only Mamtera forbidden)');
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
  assert(result.violations.some(v => v.code === 'CHORESH_FORBIDDEN_MAMTERA'), 'HC-11: Full validation has correct code');
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
  assert(getLoadWeightAtTime(heavyTask, heavyTask.timeBlock.end) === 1, 'HC-12 util: heavy task → weight 1.0 at end');
}

// T-HC12-2: getLoadWeightAtTime for Karov returns 1.0 inside hot window, 0.2 outside
{
  const karovBlock = createTimeBlockFromHours(baseDate, 5, 13);
  const karovTask = createKarovTask(karovBlock);
  const hotTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 30);
  const coldTime = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 10, 0);
  assert(getLoadWeightAtTime(karovTask, hotTime) === 1, 'HC-12 util: Karov hot window → weight 1.0');
  assert(Math.abs(getLoadWeightAtTime(karovTask, coldTime) - 0.2) < 0.01, 'HC-12 util: Karov cold zone → weight 0.2');
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
  slotId: 'test-ad-main', acceptableLevels: [Level.L3, Level.L4],
  requiredCertifications: [Certification.Nitzan], adanitTeam: AdanitTeam.SegolMain,
  label: 'Segol Main L3/L4',
};
const adSecSlot: SlotRequirement = {
  slotId: 'test-ad-sec', acceptableLevels: [Level.L2, Level.L3, Level.L4],
  requiredCertifications: [Certification.Nitzan], adanitTeam: AdanitTeam.SegolSecondary,
  label: 'Segol Secondary L2+',
};
const adL0Slot: SlotRequirement = {
  slotId: 'test-ad-l0', acceptableLevels: [Level.L0],
  requiredCertifications: [Certification.Nitzan],
  label: 'Adanit L0',
};
const testAdanitBlock = createTimeBlockFromHours(baseDate, 5, 13);
const testAdanitTask: Task = {
  id: 'sr-adanit-t', type: TaskType.Adanit, name: 'Test Adanit',
  timeBlock: testAdanitBlock, requiredCount: 6,
  slots: [adMainSlot, adSecSlot, adL0Slot, adL0Slot, adL0Slot, adL0Slot],
  isLight: false, sameGroupRequired: true,
};

const testKarovSlot: SlotRequirement = {
  slotId: 'test-kr-cmd', acceptableLevels: [Level.L2, Level.L3, Level.L4],
  requiredCertifications: [], label: 'Karov Commander',
};
const testKarovTask: Task = {
  id: 'sr-karov-t', type: TaskType.Karov, name: 'Test Karov',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4, slots: [testKarovSlot],
  isLight: false, sameGroupRequired: false,
};

const testKarovitSlot: SlotRequirement = {
  slotId: 'test-krt-cmd', acceptableLevels: [Level.L2, Level.L3, Level.L4],
  requiredCertifications: [], label: 'Karovit Commander',
};
const testKarovitTask: Task = {
  id: 'sr-karovit-t', type: TaskType.Karovit, name: 'Test Karovit',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4, slots: [testKarovitSlot],
  isLight: true, sameGroupRequired: false,
};

const testMamSlot: SlotRequirement = {
  slotId: 'test-mam-l0', acceptableLevels: [Level.L0],
  requiredCertifications: [], label: 'Mamtera L0',
};
const testMamTask: Task = {
  id: 'sr-mam-t', type: TaskType.Mamtera, name: 'Test Mamtera',
  timeBlock: createTimeBlockFromHours(baseDate, 9, 23),
  requiredCount: 2, slots: [testMamSlot],
  isLight: false, sameGroupRequired: false,
};

const testHamSlot: SlotRequirement = {
  slotId: 'test-ham-op', acceptableLevels: [Level.L0, Level.L3],
  requiredCertifications: [Certification.Hamama], label: 'Hamama Operator',
};
const testHamTask: Task = {
  id: 'sr-ham-t', type: TaskType.Hamama, name: 'Test Hamama',
  timeBlock: createTimeBlockFromHours(baseDate, 6, 18),
  requiredCount: 1, slots: [testHamSlot],
  isLight: false, sameGroupRequired: false,
};

const testShSlot: SlotRequirement = {
  slotId: 'test-sh-1', acceptableLevels: [Level.L0, Level.L2, Level.L3],
  requiredCertifications: [Certification.Nitzan], label: 'Shemesh #1',
};
const testShTask: Task = {
  id: 'sr-sh-t', type: TaskType.Shemesh, name: 'Test Shemesh',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 9),
  requiredCount: 2, slots: [testShSlot],
  isLight: false, sameGroupRequired: false,
};

const testArSlot: SlotRequirement = {
  slotId: 'test-ar-1', acceptableLevels: [Level.L0],
  requiredCertifications: [], label: 'Aruga L0',
};
const testArTask: Task = {
  id: 'sr-ar-t', type: TaskType.Aruga, name: 'Test Aruga',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 7),
  requiredCount: 2, slots: [testArSlot],
  isLight: false, sameGroupRequired: false,
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

assert(isNaturalRole(Level.L3, testAdanitTask, adSecSlot), 'HC-13: L3 in Segol Secondary natural');
assert(isNaturalRole(Level.L3, testKarovTask, testKarovSlot), 'HC-13: L3 in Karov natural');
assert(isNaturalRole(Level.L3, testKarovitTask, testKarovitSlot), 'HC-13: L3 in Karovit natural');
assert(!isNaturalRole(Level.L3, testAdanitTask, adMainSlot), 'HC-13: L3 NOT natural in Segol Main');
assert(!isNaturalRole(Level.L3, testMamTask, testMamSlot), 'HC-13: L3 NOT natural in Mamtera');

assert(isNaturalRole(Level.L2, testAdanitTask, adSecSlot), 'HC-13: L2 in Segol Secondary natural');
assert(isNaturalRole(Level.L2, testKarovTask, testKarovSlot), 'HC-13: L2 in Karov natural');
assert(!isNaturalRole(Level.L2, testAdanitTask, adMainSlot), 'HC-13: L2 NOT natural in Segol Main');

// ── checkSeniorHardBlock ────────────────────────────────────────────────────────────

assert(checkSeniorHardBlock(spL4, testAdanitTask, adMainSlot) === null, 'HC-13: L4 in Segol Main → no violation');
assert(checkSeniorHardBlock(spL4, testKarovTask, testKarovSlot) === null, 'HC-13: L4 in Karov → no violation');
assert(checkSeniorHardBlock(spL4, testKarovitTask, testKarovitSlot) === null, 'HC-13: L4 in Karovit → no violation');
assert(checkSeniorHardBlock(spL4, testHamTask, testHamSlot) === null, 'HC-13: L4 in Hamama → no hard violation (soft only)');
assert(checkSeniorHardBlock(spL4, testMamTask, testMamSlot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L4 in Mamtera → VIOLATION');
assert(checkSeniorHardBlock(spL4, testShTask, testShSlot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L4 in Shemesh → VIOLATION');
assert(checkSeniorHardBlock(spL4, testArTask, testArSlot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L4 in Aruga → VIOLATION');
assert(checkSeniorHardBlock(spL4, testAdanitTask, adSecSlot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L4 in Segol Secondary → VIOLATION');
assert(checkSeniorHardBlock(spL4, testAdanitTask, adL0Slot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L4 in L0 Adanit slot → VIOLATION');

assert(checkSeniorHardBlock(spL3, testMamTask, testMamSlot)?.code === 'SENIOR_HARD_BLOCK', 'HC-13: L3 in Mamtera → VIOLATION');
assert(checkSeniorHardBlock(spL3, testAdanitTask, adSecSlot) === null, 'HC-13: L3 in Segol Secondary → no violation');
assert(checkSeniorHardBlock(spL3, testShTask, testShSlot) === null, 'HC-13: L3 in Shemesh → no hard violation (soft penalty)');
assert(checkSeniorHardBlock(spL3, testHamTask, testHamSlot) === null, 'HC-13: L3 in Hamama → no hard violation');

assert(checkSeniorHardBlock(spL2, testMamTask, testMamSlot) === null, 'HC-13: L2 in Mamtera → no hard violation');
assert(checkSeniorHardBlock(spL2, testShTask, testShSlot) === null, 'HC-13: L2 in Shemesh → no hard violation');
assert(checkSeniorHardBlock(spL2, testHamTask, testHamSlot) === null, 'HC-13: L2 in Hamama → no hard violation');
assert(checkSeniorHardBlock(spL0, testMamTask, testMamSlot) === null, 'HC-13: L0 never blocked');
assert(checkSeniorHardBlock(spL0, testShTask, testShSlot) === null, 'HC-13: L0 never blocked (Shemesh)');

// ── validateSeniorHardBlocks (aggregate) ────────────────────────────────────────
{
  const badAssigns: Assignment[] = [
    { id: 'sr-a1', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = validateSeniorHardBlocks([spL4], badAssigns, [testShTask]);
  assert(v.length === 1, 'HC-13: validateSeniorHardBlocks catches L4 in Shemesh');
  assert(v[0].code === 'SENIOR_HARD_BLOCK', 'HC-13: correct violation code');
}
{
  const goodAssigns: Assignment[] = [
    { id: 'sr-a2', taskId: testAdanitTask.id, slotId: adMainSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'sr-a3', taskId: testAdanitTask.id, slotId: adSecSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
    { id: 'sr-a4', taskId: testKarovTask.id, slotId: testKarovSlot.slotId, participantId: spL2.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const v = validateSeniorHardBlocks([spL4, spL3, spL2], goodAssigns, [testAdanitTask, testKarovTask]);
  assert(v.length === 0, 'HC-13: natural assignments → no violations');
}

// ── validateHardConstraints integration ───────────────────────────────────────────
{
  const assigns: Assignment[] = [
    { id: 'sr-fa1', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const r = validateHardConstraints([testShTask], [spL4], assigns);
  assert(r.valid === false, 'HC-13: full validation rejects L4 in Shemesh');
  assert(r.violations.some(v => v.code === 'SENIOR_HARD_BLOCK'), 'HC-13: full validation has SENIOR_HARD_BLOCK code');
}
// L4 in Hamama should NOT produce a SENIOR_HARD_BLOCK (only soft penalty)
{
  const assigns: Assignment[] = [
    { id: 'sr-fa2', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const r = validateHardConstraints([testHamTask], [spL4], assigns);
  assert(!r.violations.some(v => v.code === 'SENIOR_HARD_BLOCK'), 'HC-13: L4 in Hamama no hard violation in full validation');
}

// ── computeSeniorOutOfRolePenalty ─────────────────────────────────────────────────

const cfg = { ...DEFAULT_CONFIG };

// Natural assignment → zero penalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p1', taskId: testKarovTask.id, slotId: testKarovSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL3], assigns, [testKarovTask], 0, cfg);
  assert(pen === 0, 'HC-13 soft: natural assignment → 0 penalty');
}

// L4 in Hamama → l4HamamaPenalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p2', taskId: testHamTask.id, slotId: testHamSlot.slotId, participantId: spL4.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL4], assigns, [testHamTask], 0, cfg);
  assert(pen === cfg.l4HamamaPenalty, `HC-13 soft: L4 Hamama → penalty ${cfg.l4HamamaPenalty}`);
}

// L3 in Shemesh → seniorOutOfRolePenalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p3', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL3], assigns, [testShTask], 0, cfg);
  assert(pen === cfg.seniorOutOfRolePenalty, `HC-13 soft: L3 Shemesh → penalty ${cfg.seniorOutOfRolePenalty}`);
}

// L2 in L0 Adanit slot → seniorOutOfRolePenalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p4', taskId: testAdanitTask.id, slotId: adL0Slot.slotId, participantId: spL2.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL2], assigns, [testAdanitTask], 0, cfg);
  assert(pen === cfg.seniorOutOfRolePenalty, `HC-13 soft: L2 in L0 Adanit slot → penalty ${cfg.seniorOutOfRolePenalty}`);
}

// L0 participants never penalised
{
  const assigns: Assignment[] = [
    { id: 'sr-p5', taskId: testMamTask.id, slotId: testMamSlot.slotId, participantId: spL0.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL0], assigns, [testMamTask], 0, cfg);
  assert(pen === 0, 'HC-13 soft: L0 never penalised');
}

// Overload escape valve: penalty reduced when L0 is overloaded
{
  const assigns: Assignment[] = [
    { id: 'sr-p6', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const overloadAvg = cfg.l0OverloadThresholdHours + 10;
  const pen = computeSeniorOutOfRolePenalty([spL3], assigns, [testShTask], overloadAvg, cfg);
  const expected = cfg.seniorOutOfRolePenalty * cfg.l0OverloadPenaltyMultiplier;
  assert(Math.abs(pen - expected) < 0.01, `HC-13 soft: overload → penalty reduced to ${expected}`);
}

// Below threshold → full penalty
{
  const assigns: Assignment[] = [
    { id: 'sr-p7', taskId: testShTask.id, slotId: testShSlot.slotId, participantId: spL3.id, status: AssignmentStatus.Scheduled, updatedAt: new Date() },
  ];
  const pen = computeSeniorOutOfRolePenalty([spL3], assigns, [testShTask], cfg.l0OverloadThresholdHours - 1, cfg);
  assert(pen === cfg.seniorOutOfRolePenalty, 'HC-13 soft: below threshold → full penalty');
}
// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
}
