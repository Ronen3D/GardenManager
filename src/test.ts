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
import { checkChoreshExclusion } from './constraints/hard-constraints';

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
    certifications: [Certification.Nitzan], group: 'A',
    chopidr: true,
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
    certifications: [Certification.Nitzan, Certification.Hamama], group: 'A',
    chopidr: true,
    availability: dayAvail, dateUnavailability: [],
  };
  const violations = checkChoreshExclusion(hamamaTask, [choreshP]);
  assert(violations.length === 0, 'HC-11: Choresh on Hamama → no violation (only Mamtera forbidden)');
}

// Full validateHardConstraints catches Choresh+Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor3', name: 'ChoreshFull', level: Level.L0,
    certifications: [Certification.Nitzan], group: 'A',
    chopidr: true,
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

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('══════════════════════════════════════════\n');

if (failed > 0) {
  process.exit(1);
}
