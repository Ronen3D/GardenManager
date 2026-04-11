/**
 * Test Runner — Validates core engine functionality.
 *
 * Usage: npm test
 */

import {
  AssignmentStatus,
  blockDurationHours,
  blockDurationMinutes,
  blocksOverlap,
  computeAllRestProfiles,
  computeRestFairness,
  computeScheduleScore,
  createTimeBlock,
  createTimeBlockFromHours,
  DEFAULT_CONFIG,
  formatBlock,
  gapHours,
  gapMinutes,
  generateShiftBlocks,
  getRejectionReason,
  getTimelineBounds,
  isEligible,
  isFullyCovered,
  Level,
  mergeBlocks,
  type OneTimeTask,
  type Participant,
  type ParticipantRestProfile,
  SchedulingEngine,
  sortBlocksByStart,
  ViolationSeverity,
  validateHardConstraints,
} from './index';
import {
  type CertificationDefinition,
  DEFAULT_CERTIFICATION_DEFINITIONS,
  type Schedule,
  type SlotRequirement,
  type TimeBlock,
} from './models/types';

// ─── Local test task factories (replacing deleted task-definitions.ts) ───────

let _testSlotCounter = 0;
let _testTaskCounter = 0;
function _nextSlotId(prefix: string): string {
  return `${prefix}-slot-${++_testSlotCounter}`;
}
function _nextTaskId(prefix: string): string {
  return `${prefix}-${++_testTaskCounter}`;
}

function createHamamaTask(timeBlock: TimeBlock): Task {
  return {
    id: _nextTaskId('hamama'),
    name: 'חממה',
    sourceName: 'חממה',
    timeBlock,
    requiredCount: 1,
    slots: [
      {
        slotId: _nextSlotId('hamama'),
        acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
        requiredCertifications: ['Hamama'],
        label: 'מפעיל חממה',
      },
    ],
    isLight: false,
    baseLoadWeight: 5 / 6,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

function createShemeshTask(timeBlock: TimeBlock): Task {
  return {
    id: _nextTaskId('shemesh'),
    name: 'שמש',
    sourceName: 'שמש',
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: _nextSlotId('shemesh'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בשמש',
      },
      {
        slotId: _nextSlotId('shemesh'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בשמש',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: 'test-rest-rule',
  };
}

function createMamteraTask(baseDate: Date): Task {
  const block = createTimeBlockFromHours(baseDate, 9, 23);
  return {
    id: _nextTaskId('mamtera'),
    name: 'ממטרה',
    sourceName: 'ממטרה',
    timeBlock: block,
    requiredCount: 2,
    slots: [
      {
        slotId: _nextSlotId('mamtera'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: ['Horesh'],
        label: 'משתתף בממטרה',
      },
      {
        slotId: _nextSlotId('mamtera'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: ['Horesh'],
        label: 'משתתף בממטרה',
      },
    ],
    isLight: false,
    baseLoadWeight: 4 / 9,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

function createKarovTask(timeBlock: TimeBlock): Task {
  return {
    id: _nextTaskId('karov'),
    name: 'כרוב',
    sourceName: 'כרוב',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: _nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
        label: 'מפקד כרוב',
      },
      {
        slotId: _nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Salsala', 'Nitzan'],
        label: 'נהג כרוב',
      },
      {
        slotId: _nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בכרוב',
      },
      {
        slotId: _nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בקרוב',
      },
    ],
    isLight: false,
    baseLoadWeight: 1 / 3,
    loadWindows: [
      { id: 'karov-hot-am', startHour: 5, startMinute: 0, endHour: 6, endMinute: 30, weight: 1 },
      { id: 'karov-hot-pm', startHour: 17, startMinute: 0, endHour: 18, endMinute: 30, weight: 1 },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

function createKarovitTask(timeBlock: TimeBlock): Task {
  return {
    id: _nextTaskId('karovit'),
    name: 'כרובית',
    sourceName: 'כרובית',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: _nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
        label: 'סגל כרובית',
      },
      {
        slotId: _nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בכרובית',
      },
      {
        slotId: _nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בכרובית',
      },
      {
        slotId: _nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בכרובית',
      },
    ],
    isLight: true,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

function createArugaTask(timeBlock: TimeBlock, label: string = 'ערוגה', sourceName?: string): Task {
  return {
    id: _nextTaskId('aruga'),
    name: label,
    sourceName: sourceName ?? label,
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: _nextSlotId('aruga'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בערוגה',
      },
      {
        slotId: _nextSlotId('aruga'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בערוגה',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

function createAdanitTasks(baseDate: Date): Task[] {
  const shifts = generateShiftBlocks(
    new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 0),
    8,
    3,
  );
  return shifts.map((block, i) => {
    const slots: SlotRequirement[] = [];
    const prefix = 'adanit';
    for (let j = 0; j < 2; j++)
      slots.push({
        slotId: _nextSlotId(prefix),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בסגול א',
      });
    slots.push({
      slotId: _nextSlotId(prefix),
      acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
      requiredCertifications: ['Nitzan'],
      label: 'סגל בסגול א',
    });
    for (let j = 0; j < 2; j++)
      slots.push({
        slotId: _nextSlotId(prefix),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בסגול ב',
      });
    slots.push({
      slotId: _nextSlotId(prefix),
      acceptableLevels: [{ level: Level.L2 }],
      requiredCertifications: ['Nitzan'],
      label: "בכיר בסגול ב'",
    });
    return {
      id: _nextTaskId('adanit'),
      name: `משמרת אדנית ${i + 1}`,
      sourceName: 'אדנית',
      timeBlock: block,
      requiredCount: 6,
      slots,
      isLight: false,
      sameGroupRequired: true,
      blocksConsecutive: true,
      restRuleId: 'test-rest-rule',
    };
  });
}

import {
  checkAvailability,
  checkCertificationRequirement,
  checkGroupFeasibility,
  checkLevelRequirement,
  checkRestRules,
  checkSameGroup,
  checkSlotsFilled,
  checkUniqueParticipantsPerTask,
} from './constraints/hard-constraints';
import { collectSoftWarnings, dailyWorkloadImbalance, workloadImbalanceSplit } from './constraints/soft-constraints';
import { fullValidate, previewSwap } from './engine/validator';
import { runParticipantSetXlsxTests } from './test-participant-set-xlsx';
import { computeParticipantRest } from './web/utils/rest-calculator';
import { isDateInBlock } from './web/utils/time-utils';

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
  id: 'tp0',
  name: 'TestP0',
  level: Level.L0,
  certifications: ['Nitzan', 'Hamama'],
  group: 'TestGroup',
  availability: dayAvail,
  dateUnavailability: [],
};
const testP0b: Participant = {
  id: 'tp0b',
  name: 'TestP0b',
  level: Level.L0,
  certifications: ['Nitzan'],
  group: 'TestGroup',
  availability: dayAvail,
  dateUnavailability: [],
};

// Hamama task — requires Hamama cert
const hamamaBlock = createTimeBlockFromHours(baseDate, 6, 18);
const hamamaTask = createHamamaTask(hamamaBlock);

// Test: valid assignment
const validAssignment = [
  {
    id: 'va1',
    taskId: hamamaTask.id,
    slotId: hamamaTask.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const result1 = validateHardConstraints([hamamaTask], [testP0, testP0b], validAssignment);
assert(result1.valid === true, 'Valid Hamama assignment passes hard constraints');

// Test: missing certification
const badAssignment = [
  {
    id: 'ba1',
    taskId: hamamaTask.id,
    slotId: hamamaTask.slots[0].slotId,
    participantId: testP0b.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const result2 = validateHardConstraints([hamamaTask], [testP0, testP0b], badAssignment);
assert(result2.valid === false, 'Missing Hamama cert triggers violation');
assert(
  result2.violations.some((v) => v.code === 'CERT_MISSING'),
  'Violation code = CERT_MISSING',
);

// Test: Shemesh with L0 participants (seniors hard-blocked under strict isolation)
const shemeshBlock = createTimeBlockFromHours(baseDate, 10, 14);
const shemeshTask = createShemeshTask(shemeshBlock);
const shemeshAssignment = [
  {
    id: 'sa1',
    taskId: shemeshTask.id,
    slotId: shemeshTask.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
  {
    id: 'sa2',
    taskId: shemeshTask.id,
    slotId: shemeshTask.slots[1].slotId,
    participantId: testP0b.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const result3 = validateHardConstraints([shemeshTask], [testP0, testP0b], shemeshAssignment);
assert(result3.valid === true, 'Valid Shemesh assignment with L0 participants');

// Test: double-booking
const taskA2 = createHamamaTask(hamamaBlock);
const doubleBooking = [
  {
    id: 'db1',
    taskId: hamamaTask.id,
    slotId: hamamaTask.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
  {
    id: 'db2',
    taskId: taskA2.id,
    slotId: taskA2.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const result4 = validateHardConstraints([hamamaTask, taskA2], [testP0, testP0b], doubleBooking);
assert(result4.valid === false, 'Double-booking detected');
assert(
  result4.violations.some((v) => v.code === 'DOUBLE_BOOKING'),
  'Violation code = DOUBLE_BOOKING',
);

// Test: HC-5 sweep-line regression — short task must not mask a long overlapping task
// Counterexample: A(06-14), B(08-09), C(10-12). A↔C overlap must be caught
// even though B (between A and C in start-sorted order) doesn't overlap C.
{
  const longTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 14)); // 06:00–14:00
  const shortTask = createHamamaTask(createTimeBlockFromHours(baseDate, 8, 9)); // 08:00–09:00
  const laterTask = createHamamaTask(createTimeBlockFromHours(baseDate, 10, 12)); // 10:00–12:00

  const dbMask = [
    {
      id: 'dbm1',
      taskId: longTask.id,
      slotId: longTask.slots[0].slotId,
      participantId: testP0.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'dbm2',
      taskId: shortTask.id,
      slotId: shortTask.slots[0].slotId,
      participantId: testP0.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'dbm3',
      taskId: laterTask.id,
      slotId: laterTask.slots[0].slotId,
      participantId: testP0.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];

  const resultMask = validateHardConstraints([longTask, shortTask, laterTask], [testP0, testP0b], dbMask);
  // Should find overlaps: A↔B, A↔C, (B doesn't overlap C)
  const dbViolations = resultMask.violations.filter((v) => v.code === 'DOUBLE_BOOKING');
  assert(dbViolations.length >= 2, 'HC-5 sweep-line: detects at least 2 overlapping pairs (A↔B, A↔C)');
  // Specifically verify the A↔C pair that the old break would miss
  const foundAC = dbViolations.some((v) => v.message.includes(longTask.name) && v.message.includes(laterTask.name));
  assert(foundAC, 'HC-5 sweep-line: long↔later overlap not masked by intervening short task');
}

// ─── Soft Constraint Tests ───────────────────────────────────────────────────

console.log('\n── Soft Constraints ────────────────────');

const testP4: Participant = {
  id: 'tp4',
  name: 'TestP4',
  level: Level.L4,
  certifications: ['Hamama'],
  group: 'TestGroup',
  availability: dayAvail,
  dateUnavailability: [],
};

// Hamama L4 penalty
const l4HamamaAssignment = [
  {
    id: 'lh1',
    taskId: hamamaTask.id,
    slotId: hamamaTask.slots[0].slotId,
    participantId: testP4.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const score1 = computeScheduleScore([hamamaTask], [testP0, testP4], l4HamamaAssignment, DEFAULT_CONFIG);
assert(score1.totalPenalty > 0, 'L4 Hamama assignment incurs penalty');
assert(score1.totalPenalty >= DEFAULT_CONFIG.lowPriorityLevelPenalty, 'Penalty >= lowPriorityLevelPenalty config');

// L0 Hamama — should have 0 hamama penalty (only workload-based penalty possible)
const l0HamamaAssignment = [
  {
    id: 'lh2',
    taskId: hamamaTask.id,
    slotId: hamamaTask.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const score2 = computeScheduleScore([hamamaTask], [testP0, testP4], l0HamamaAssignment, DEFAULT_CONFIG);
assert(score2.totalPenalty < score1.totalPenalty, 'L0 Hamama has less penalty than L4');

// ─── Rest Calculator Tests ───────────────────────────────────────────────────

console.log('\n── Rest Calculator ─────────────────────');

const restTask1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
const restTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));
const restAssignments = [
  {
    id: 'ra1',
    taskId: restTask1.id,
    slotId: restTask1.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
  {
    id: 'ra2',
    taskId: restTask2.id,
    slotId: restTask2.slots[0].slotId,
    participantId: testP0.id,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  },
];
const restProfile = computeParticipantRest(testP0.id, restAssignments, [restTask1, restTask2]);
assert(restProfile.restGaps.length === 1, 'One rest gap between two tasks');
assert(restProfile.minRestHours === 4, 'Rest gap = 4h (10:00-14:00)');
assert(restProfile.nonLightAssignmentCount === 2, 'Two non-light assignments counted');

// ─── Validator Tests ─────────────────────────────────────────────────────────

console.log('\n── Validator ───────────────────────────');

const fullResult = fullValidate([hamamaTask], [testP0, testP0b], validAssignment);
assert(fullResult.valid === true, 'fullValidate: valid schedule');
assert(fullResult.summary.includes('תקין'), 'Summary mentions valid');

// Preview swap
const swapPreview = previewSwap([hamamaTask], [testP0, testP0b], validAssignment, {
  assignmentId: 'va1',
  newParticipantId: testP0b.id,
});
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
    certifications: ['Nitzan', 'Hamama', 'Salsala'],
    group: 'TeamA',
    availability: dayWindow,
    dateUnavailability: [],
  });
}
// Add L2, L3, L4
participants.push({
  id: 'pl2',
  name: 'Commander-L2',
  level: Level.L2,
  certifications: ['Nitzan'],
  group: 'TeamA',
  availability: dayWindow,
  dateUnavailability: [],
});
participants.push({
  id: 'pl3',
  name: 'Commander-L3',
  level: Level.L3,
  certifications: ['Nitzan', 'Hamama'],
  group: 'TeamA',
  availability: dayWindow,
  dateUnavailability: [],
});
participants.push({
  id: 'pl4',
  name: 'Commander-L4',
  level: Level.L4,
  certifications: ['Hamama'],
  group: 'TeamA',
  availability: dayWindow,
  dateUnavailability: [],
});

engine.addParticipants(participants);

// Create a few tasks manually (not a full day, to keep it manageable)
const tb1 = createTimeBlockFromHours(baseDate, 6, 18);
const tb2 = createTimeBlockFromHours(baseDate, 6, 10);
engine.addTask(createHamamaTask(tb1));
engine.addTask(createShemeshTask(tb2));
engine.addTask(
  createArugaTask({ start: new Date(2026, 1, 15, 6, 0), end: new Date(2026, 1, 15, 7, 30) }, 'Aruga Morning'),
);

const schedule = engine.generateSchedule();
assert(schedule.assignments.length > 0, 'Engine generates assignments');

const engineStats = engine.getStats();
assert(engineStats.totalTasks === 3, 'Stats: 3 tasks');
assert(engineStats.totalParticipants === 13, 'Stats: 13 participants');

// Validate
const validation = engine.validate();
assert(validation.valid === true, 'Engine: generated schedule passes validation');
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
    assert(typeof swapResult.valid === 'boolean', 'Engine: swap returns a valid result');
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

import type { LoadWindow, Task } from './models/types';
import {
  computeTaskColdHours,
  computeTaskEffectiveHours,
  computeTaskHotHours,
  getTaskBaseLoadWeight,
} from './web/utils/load-weighting';

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
  assert(Math.abs(computeTaskHotHours(t) + computeTaskColdHours(t) - raw) < 0.01, 'T8: hot + cold = raw (8h)');
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

import { checkForbiddenCertifications, checkNoConsecutiveHighLoad } from './constraints/hard-constraints';
import { computeLowPriorityLevelPenalty, isNaturalRole } from './constraints/senior-policy';
import type { Assignment } from './models/types';
import { getLoadWeightAtTime, isHighLoadAtBoundary } from './web/utils/load-weighting';

console.log('\n── Forbidden Certification Constraint (HC-11) ───────────');

const mamteraTask = createMamteraTask(baseDate);

// Non-choresh participant → no violation on Mamtera
{
  const normalP: Participant = {
    id: 'tc-normal',
    name: 'NormalPerson',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pMap = new Map([['tc-normal', normalP]]);
  const assigns: Assignment[] = [
    {
      id: 'ca-n1',
      taskId: mamteraTask.id,
      slotId: mamteraTask.slots[0].slotId,
      participantId: normalP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const violations = checkForbiddenCertifications(mamteraTask, assigns, pMap);
  assert(violations.length === 0, 'HC-11: Non-choresh → no Mamtera violation');
}

// Choresh participant → violation on Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor',
    name: 'ChoreshPerson',
    level: Level.L0,
    certifications: ['Nitzan', 'Horesh'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pMap = new Map([['tc-chor', choreshP]]);
  const assigns: Assignment[] = [
    {
      id: 'ca-c1',
      taskId: mamteraTask.id,
      slotId: mamteraTask.slots[0].slotId,
      participantId: choreshP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const violations = checkForbiddenCertifications(mamteraTask, assigns, pMap);
  assert(violations.length === 1, 'HC-11: Choresh → Mamtera violation');
  assert(violations[0].code === 'EXCLUDED_CERTIFICATION', 'HC-11: violation code = EXCLUDED_CERTIFICATION');
}

// Choresh participant on non-Mamtera task (no forbidden certs on slots) → no violation
{
  const choreshP: Participant = {
    id: 'tc-chor2',
    name: 'ChoreshPerson2',
    level: Level.L0,
    certifications: ['Nitzan', 'Hamama', 'Horesh'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pMap = new Map([['tc-chor2', choreshP]]);
  const assigns: Assignment[] = [
    {
      id: 'ca-c2',
      taskId: hamamaTask.id,
      slotId: hamamaTask.slots[0].slotId,
      participantId: choreshP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const violations = checkForbiddenCertifications(hamamaTask, assigns, pMap);
  assert(violations.length === 0, 'HC-11: Choresh on Hamama → no violation (only Mamtera slots forbid it)');
}

// Per-slot granularity: forbidden on slot A, allowed on slot B
{
  const slotA: SlotRequirement = {
    slotId: 'fc-slot-a',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    forbiddenCertifications: ['Horesh'],
    label: 'Slot A (forbids Horesh)',
  };
  const slotB: SlotRequirement = {
    slotId: 'fc-slot-b',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'Slot B (no forbidden)',
  };
  const mixedTask: Task = {
    id: 'fc-mixed',
    name: 'Mixed Forbidden',
    timeBlock: createTimeBlockFromHours(baseDate, 9, 23),
    requiredCount: 2,
    slots: [slotA, slotB],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const choreshP: Participant = {
    id: 'fc-chor',
    name: 'ChoreshMixed',
    level: Level.L0,
    certifications: ['Horesh'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pMap = new Map([['fc-chor', choreshP]]);
  // Assigned to slot A (forbidden) → violation
  const assignsA: Assignment[] = [
    {
      id: 'fca1',
      taskId: mixedTask.id,
      slotId: 'fc-slot-a',
      participantId: choreshP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  assert(
    checkForbiddenCertifications(mixedTask, assignsA, pMap).length === 1,
    'HC-11: Forbidden cert on slot A → violation',
  );
  // Assigned to slot B (not forbidden) → no violation
  const assignsB: Assignment[] = [
    {
      id: 'fca2',
      taskId: mixedTask.id,
      slotId: 'fc-slot-b',
      participantId: choreshP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  assert(
    checkForbiddenCertifications(mixedTask, assignsB, pMap).length === 0,
    'HC-11: No forbidden cert on slot B → no violation',
  );
}

// Full validateHardConstraints catches Choresh+Mamtera
{
  const choreshP: Participant = {
    id: 'tc-chor3',
    name: 'ChoreshFull',
    level: Level.L0,
    certifications: ['Nitzan', 'Horesh'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const badAssign = [
    {
      id: 'ca1',
      taskId: mamteraTask.id,
      slotId: mamteraTask.slots[0].slotId,
      participantId: choreshP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const result = validateHardConstraints([mamteraTask], [choreshP], badAssign);
  assert(result.valid === false, 'HC-11: Full validation rejects Choresh+Mamtera');
  assert(
    result.violations.some((v) => v.code === 'EXCLUDED_CERTIFICATION'),
    'HC-11: Full validation has correct code',
  );
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
  assert(
    getLoadWeightAtTime(heavyTask, heavyTask.timeBlock.start) === 1,
    'HC-12 util: heavy task → weight 1.0 at start',
  );
  // C2: With half-open [start, end), the exact end instant is outside the task
  assert(
    getLoadWeightAtTime(heavyTask, heavyTask.timeBlock.end) === 0,
    'HC-12 util: heavy task → weight 0 at end (half-open)',
  );
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
  id: 'hc12-p1',
  name: 'HC12Tester',
  level: Level.L0,
  certifications: ['Nitzan'],
  group: 'A',
  availability: dayAvail,
  dateUnavailability: [],
};

// T-HC12-7: Two back-to-back heavy tasks → VIOLATION
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 9, 13));
  const tMap = new Map([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);
  const assigns = [
    {
      id: 'hc12-a1',
      taskId: taskA.id,
      slotId: taskA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-a2',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 1, 'HC-12: two consecutive heavy tasks → 1 violation');
  assert(v[0].code === 'CONSECUTIVE_HIGH_LOAD', 'HC-12: violation code = CONSECUTIVE_HIGH_LOAD');
}

// T-HC12-8: Heavy task then Karovit (light) → NO violation (light acts as buffer)
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createKarovitTask(createTimeBlockFromHours(baseDate, 9, 13));
  const tMap = new Map([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);
  const assigns = [
    {
      id: 'hc12-a3',
      taskId: taskA.id,
      slotId: taskA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-a4',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 0, 'HC-12: heavy then light (Karovit) → no violation');
}

// T-HC12-9: Heavy task then Karov starting in cold zone → NO violation
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 13));
  const taskB = createKarovTask(createTimeBlockFromHours(baseDate, 13, 21)); // starts cold
  const tMap = new Map([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);
  const assigns = [
    {
      id: 'hc12-a5',
      taskId: taskA.id,
      slotId: taskA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-a6',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const tMap = new Map([
    [karovA.id, karovA],
    [taskB.id, taskB],
  ]);
  const assigns = [
    {
      id: 'hc12-a7',
      taskId: karovA.id,
      slotId: karovA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-a8',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 1, 'HC-12: Karov ending in hot → heavy start → violation');
}

// T-HC12-11: Gap between heavy tasks (non-adjacent) → NO violation
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 10, 14)); // 1h gap
  const tMap = new Map([
    [taskA.id, taskA],
    [taskB.id, taskB],
  ]);
  const assigns = [
    {
      id: 'hc12-a9',
      taskId: taskA.id,
      slotId: taskA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-a10',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = checkNoConsecutiveHighLoad(hcParticipant.id, assigns, tMap);
  assert(v.length === 0, 'HC-12: heavy tasks with gap → no violation');
}

// T-HC12-12: validateHardConstraints detects consecutive high-load
{
  const taskA = createShemeshTask(createTimeBlockFromHours(baseDate, 5, 9));
  const taskB = createShemeshTask(createTimeBlockFromHours(baseDate, 9, 13));
  const assigns = [
    {
      id: 'hc12-fa1',
      taskId: taskA.id,
      slotId: taskA.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc12-fa2',
      taskId: taskB.id,
      slotId: taskB.slots[0].slotId,
      participantId: hcParticipant.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const result = validateHardConstraints([taskA, taskB], [hcParticipant], assigns);
  assert(result.valid === false, 'HC-12: validateHardConstraints rejects consecutive heavy');
  assert(
    result.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD'),
    'HC-12: full validation has correct code',
  );
}
// ─── Senior Role Policy (HC-13) Tests ─────────────────────────────────────

console.log('\n── Senior Role Policy (HC-13) ───────────────');

// Helper slots for Adanit tests
const adMainSlot: SlotRequirement = {
  slotId: 'test-ad-main',
  acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: ['Nitzan'],
  label: 'Segol Main L3/L4',
};
const adSecSlot: SlotRequirement = {
  slotId: 'test-ad-sec',
  acceptableLevels: [{ level: Level.L2 }],
  requiredCertifications: ['Nitzan'],
  label: 'Segol Secondary L2',
};
const adL0Slot: SlotRequirement = {
  slotId: 'test-ad-l0',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: ['Nitzan'],
  label: 'Adanit L0',
};
const testAdanitBlock = createTimeBlockFromHours(baseDate, 5, 13);
const testAdanitTask: Task = {
  id: 'sr-adanit-t',
  name: 'Test Adanit',
  timeBlock: testAdanitBlock,
  requiredCount: 6,
  slots: [adMainSlot, adSecSlot, adL0Slot, adL0Slot, adL0Slot, adL0Slot],
  isLight: false,
  sameGroupRequired: true,
  blocksConsecutive: true,
};

const testKarovSlot: SlotRequirement = {
  slotId: 'test-kr-cmd',
  acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: [],
  label: 'Karov Commander',
};
const testKarovL0Slot: SlotRequirement = {
  slotId: 'test-kr-l0',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [],
  label: 'Karov L0',
};
const testKarovTask: Task = {
  id: 'sr-karov-t',
  name: 'Test Karov',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4,
  slots: [testKarovSlot, testKarovL0Slot],
  isLight: false,
  sameGroupRequired: false,
  blocksConsecutive: false,
};

const testKarovitSlot: SlotRequirement = {
  slotId: 'test-krt-cmd',
  acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
  requiredCertifications: [],
  label: 'Karovit Commander',
};
const testKarovitL0Slot: SlotRequirement = {
  slotId: 'test-krt-l0',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [],
  label: 'Karovit L0',
};
const testKarovitTask: Task = {
  id: 'sr-karovit-t',
  name: 'Test Karovit',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 13),
  requiredCount: 4,
  slots: [testKarovitSlot, testKarovitL0Slot],
  isLight: true,
  sameGroupRequired: false,
  blocksConsecutive: false,
};

const testMamSlot: SlotRequirement = {
  slotId: 'test-mam-l0',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [],
  forbiddenCertifications: ['Horesh'],
  label: 'Mamtera L0',
};
const testMamTask: Task = {
  id: 'sr-mam-t',
  name: 'Test Mamtera',
  timeBlock: createTimeBlockFromHours(baseDate, 9, 23),
  requiredCount: 2,
  slots: [testMamSlot],
  isLight: false,
  sameGroupRequired: false,
  blocksConsecutive: true,
};

const testHamSlot: SlotRequirement = {
  slotId: 'test-ham-op',
  acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
  requiredCertifications: ['Hamama'],
  label: 'Hamama Operator',
};
const testHamTask: Task = {
  id: 'sr-ham-t',
  name: 'Test Hamama',
  timeBlock: createTimeBlockFromHours(baseDate, 6, 18),
  requiredCount: 1,
  slots: [testHamSlot],
  isLight: false,
  sameGroupRequired: false,
  blocksConsecutive: true,
};

const testShSlot: SlotRequirement = {
  slotId: 'test-sh-1',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: ['Nitzan'],
  label: 'Shemesh #1',
};
const testShTask: Task = {
  id: 'sr-sh-t',
  name: 'Test Shemesh',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 9),
  requiredCount: 2,
  slots: [testShSlot],
  isLight: false,
  sameGroupRequired: false,
  blocksConsecutive: true,
};

const testArSlot: SlotRequirement = {
  slotId: 'test-ar-1',
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [],
  label: 'Aruga L0',
};
const testArTask: Task = {
  id: 'sr-ar-t',
  name: 'Test Aruga',
  timeBlock: createTimeBlockFromHours(baseDate, 5, 7),
  requiredCount: 2,
  slots: [testArSlot],
  isLight: false,
  sameGroupRequired: false,
  blocksConsecutive: true,
};

const spL0: Participant = {
  id: 'sp-l0',
  name: 'SP-L0',
  level: Level.L0,
  certifications: ['Nitzan', 'Hamama'],
  group: 'A',
  availability: dayAvail,
  dateUnavailability: [],
};
const spL2: Participant = {
  id: 'sp-l2',
  name: 'SP-L2',
  level: Level.L2,
  certifications: ['Nitzan', 'Hamama'],
  group: 'A',
  availability: dayAvail,
  dateUnavailability: [],
};
const spL3: Participant = {
  id: 'sp-l3',
  name: 'SP-L3',
  level: Level.L3,
  certifications: ['Nitzan', 'Hamama'],
  group: 'A',
  availability: dayAvail,
  dateUnavailability: [],
};
const spL4: Participant = {
  id: 'sp-l4',
  name: 'SP-L4',
  level: Level.L4,
  certifications: ['Nitzan', 'Hamama'],
  group: 'A',
  availability: dayAvail,
  dateUnavailability: [],
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

// ── isNaturalRole: level-agnostic lowPriority ────────────────────────────────────
{
  // Slot with preferred L3/L4 and lowPriority L0
  const mixedSlot: SlotRequirement = {
    slotId: 'test-mixed',
    acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }, { level: Level.L0, lowPriority: true }],
    requiredCertifications: [],
    label: 'Mixed preferred+lowPriority',
  };
  const mixedTask: Task = {
    id: 'sr-mixed-t',
    name: 'Test Mixed',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [mixedSlot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  // L3/L4 preferred → natural
  assert(isNaturalRole(Level.L3, mixedTask, mixedSlot), 'isNaturalRole: L3 preferred → natural');
  assert(isNaturalRole(Level.L4, mixedTask, mixedSlot), 'isNaturalRole: L4 preferred → natural');
  // L0 lowPriority → NOT natural (last resort, receives penalty)
  assert(!isNaturalRole(Level.L0, mixedTask, mixedSlot), 'isNaturalRole: L0 lowPriority → NOT natural');
  // L2 not listed → not natural (blocked by HC-1)
  assert(!isNaturalRole(Level.L2, mixedTask, mixedSlot), 'isNaturalRole: L2 not listed → not natural');

  // Verify penalty: L0 in lowPriority slot gets penalized
  const l0P: Participant = {
    id: 'mix-l0',
    name: 'Mix-L0',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const mixAssigns: Assignment[] = [
    {
      id: 'mix-a1',
      taskId: mixedTask.id,
      slotId: mixedSlot.slotId,
      participantId: l0P.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const mixPen = computeLowPriorityLevelPenalty([l0P], mixAssigns, [mixedTask], DEFAULT_CONFIG);
  assert(
    mixPen === DEFAULT_CONFIG.lowPriorityLevelPenalty,
    'lowPriority penalty: L0 in lowPriority slot → penalty applied',
  );

  // L3 in same slot → no penalty (natural)
  const l3P: Participant = {
    id: 'mix-l3',
    name: 'Mix-L3',
    level: Level.L3,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const mixAssigns2: Assignment[] = [
    {
      id: 'mix-a2',
      taskId: mixedTask.id,
      slotId: mixedSlot.slotId,
      participantId: l3P.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  assert(
    computeLowPriorityLevelPenalty([l3P], mixAssigns2, [mixedTask], DEFAULT_CONFIG) === 0,
    'lowPriority penalty: L3 preferred → 0',
  );
}

// ── validateHardConstraints integration (level gating now via HC-1) ──────────────
{
  // L4 in Shemesh (L0-only slot) → blocked by HC-1 LEVEL_MISMATCH
  const assigns: Assignment[] = [
    {
      id: 'sr-fa1',
      taskId: testShTask.id,
      slotId: testShSlot.slotId,
      participantId: spL4.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const r = validateHardConstraints([testShTask], [spL4], assigns);
  assert(r.valid === false, 'HC-1: full validation rejects L4 in L0-only Shemesh slot');
  assert(
    r.violations.some((v) => v.code === 'LEVEL_MISMATCH'),
    'HC-1: full validation has LEVEL_MISMATCH code',
  );
}
// L4 in Hamama (lowPriority) → no hard violation (soft penalty only)
{
  const assigns: Assignment[] = [
    {
      id: 'sr-fa2',
      taskId: testHamTask.id,
      slotId: testHamSlot.slotId,
      participantId: spL4.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const r = validateHardConstraints([testHamTask], [spL4], assigns);
  assert(!r.violations.some((v) => v.code === 'LEVEL_MISMATCH'), 'L4 in Hamama (lowPriority) passes HC-1');
}

// ── computeLowPriorityLevelPenalty ────────────────────────────────────────────────────

const cfg = { ...DEFAULT_CONFIG };

// Natural assignment → zero penalty
{
  const assigns: Assignment[] = [
    {
      id: 'sr-p1',
      taskId: testKarovTask.id,
      slotId: testKarovSlot.slotId,
      participantId: spL3.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const pen = computeLowPriorityLevelPenalty([spL3], assigns, [testKarovTask], cfg);
  assert(pen === 0, 'Low-priority penalty: natural assignment → 0');
}

// L4 in Hamama (lowPriority) → lowPriorityLevelPenalty (absolute last resort)
{
  const assigns: Assignment[] = [
    {
      id: 'sr-p2',
      taskId: testHamTask.id,
      slotId: testHamSlot.slotId,
      participantId: spL4.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const pen = computeLowPriorityLevelPenalty([spL4], assigns, [testHamTask], cfg);
  assert(
    pen === cfg.lowPriorityLevelPenalty,
    `Low-priority penalty: L4 in Hamama (lowPriority) → penalty ${cfg.lowPriorityLevelPenalty}`,
  );
}

// L3 in Hamama → 0 (not in acceptableLevels, hard-blocked by HC-1)
{
  const assigns: Assignment[] = [
    {
      id: 'sr-p2b',
      taskId: testHamTask.id,
      slotId: testHamSlot.slotId,
      participantId: spL3.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const pen = computeLowPriorityLevelPenalty([spL3], assigns, [testHamTask], cfg);
  assert(pen === 0, 'Low-priority penalty: L3 in Hamama → 0 (not in acceptableLevels)');
}

// L2 in Hamama → 0 (not in acceptableLevels, hard-blocked by HC-1)
{
  const assigns: Assignment[] = [
    {
      id: 'sr-p2c',
      taskId: testHamTask.id,
      slotId: testHamSlot.slotId,
      participantId: spL2.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const pen = computeLowPriorityLevelPenalty([spL2], assigns, [testHamTask], cfg);
  assert(pen === 0, 'Low-priority penalty: L2 in Hamama → 0 (not in acceptableLevels)');
}

// L0 participants never penalised
{
  const assigns: Assignment[] = [
    {
      id: 'sr-p5',
      taskId: testMamTask.id,
      slotId: testMamSlot.slotId,
      participantId: spL0.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const taskMap = new Map([prefMamtera, prefKarov, prefKarov2, prefKarov3].map((t) => [t.id, t]));

  const pWithPref: Participant = {
    id: 'sc10-p1',
    name: 'PrefPerson',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
    preferredTaskName: 'ממטרה',
  };

  const cfgPref = {
    ...DEFAULT_CONFIG,
    taskNamePreferencePenalty: 50,
    taskNameAvoidancePenalty: 80,
    taskNamePreferenceBonus: 25,
  };

  // No preferred assignments → binary penalty only (no bonus)
  {
    const assigns = new Map<string, Assignment[]>([
      [
        'sc10-p1',
        [
          {
            id: 'sc10-a1',
            taskId: prefKarov.id,
            slotId: prefKarov.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
        ],
      ],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === 50, 'SC-10 bonus: 0 preferred assignments → binary penalty 50');
  }

  // 1 preferred assignment → binary removed + 1× bonus = -25
  {
    const assigns = new Map<string, Assignment[]>([
      [
        'sc10-p1',
        [
          {
            id: 'sc10-a2',
            taskId: prefMamtera.id,
            slotId: prefMamtera.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
        ],
      ],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === -25, 'SC-10 bonus: 1 preferred assignment → -25 (no binary, 1× bonus)');
  }

  // 3 preferred assignments → binary removed + 3× bonus = -75
  {
    const assigns = new Map<string, Assignment[]>([
      [
        'sc10-p1',
        [
          {
            id: 'sc10-a3',
            taskId: prefMamtera.id,
            slotId: prefMamtera.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
          {
            id: 'sc10-a4',
            taskId: prefMamtera.id,
            slotId: prefMamtera.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
          {
            id: 'sc10-a5',
            taskId: prefMamtera.id,
            slotId: prefMamtera.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
        ],
      ],
    ]);
    const pen = computeTaskNamePreferencePenalty([pWithPref], cfgPref, taskMap, assigns);
    assert(pen === -75, 'SC-10 bonus: 3 preferred assignments → -75 (stacks)');
  }

  // Bonus disabled → only binary penalty applies
  {
    const cfgNoBonus = { ...cfgPref, taskNamePreferenceBonus: 0 };
    const assigns = new Map<string, Assignment[]>([
      [
        'sc10-p1',
        [
          {
            id: 'sc10-a6',
            taskId: prefKarov.id,
            slotId: prefKarov.slots[0].slotId,
            participantId: 'sc10-p1',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
        ],
      ],
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
      [
        'sc10-p2',
        [
          {
            id: 'sc10-a7',
            taskId: prefMamtera.id,
            slotId: prefMamtera.slots[0].slotId,
            participantId: 'sc10-p2',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
          {
            id: 'sc10-a8',
            taskId: prefKarov.id,
            slotId: prefKarov.slots[0].slotId,
            participantId: 'sc10-p2',
            status: AssignmentStatus.Scheduled,
            updatedAt: new Date(),
          },
        ],
      ],
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
      slots: [
        {
          id: 'ot-slot-1',
          label: 'Slot 1',
          acceptableLevels: [{ level: Level.L0 }, { level: Level.L2 }],
          requiredCertifications: ['Nitzan'],
        },
      ],
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
    restRuleId: 'test-rest-rule',
    isLight: false,
    sameGroupRequired: true,
    schedulingPriority: 5,
    displayCategory: 'patrol',
    togethernessRelevant: true,
    baseLoadWeight: 0.5,
  });
  assert(heavyOt.blocksConsecutive === true, 'Constraint: blocksConsecutive');
  assert(heavyOt.restRuleId === 'test-rest-rule', 'Constraint: restRuleId');
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
    slots: [
      {
        slotId: 'ot-overlap-slot-1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
      },
    ],
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
    slots: [
      {
        slotId: 'tpl-overlap-slot-1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  // Overlap check
  assert(blocksOverlap(otTask.timeBlock, tplTask.timeBlock) === true, 'HC-5: One-time task overlaps template task');

  // Test 5: Assign same participant to both → HC-5 violation
  const overlapParticipant: Participant = {
    id: 'ot-p1',
    name: 'Overlap Test',
    level: Level.L0,
    certifications: [],
    group: 'Alpha',
    availability: [
      {
        start: new Date(2026, 1, 15, 5, 0),
        end: new Date(2026, 1, 22, 5, 0),
      },
    ],
    dateUnavailability: [],
  };
  const overlapAssignments = [
    {
      id: 'oa1',
      taskId: otTask.id,
      slotId: otTask.slots[0].slotId,
      participantId: 'ot-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'oa2',
      taskId: tplTask.id,
      slotId: tplTask.slots[0].slotId,
      participantId: 'ot-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const overlapResult = validateHardConstraints([otTask, tplTask], [overlapParticipant], overlapAssignments);
  const hasHC5 = overlapResult.violations.some((v) => v.code === 'DOUBLE_BOOKING');
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
  assert(
    isFullyCovered(task, windows) === false,
    'isFullyCovered: split windows do NOT cover (requires single window)',
  );
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
    id: 'hc1-l0',
    name: 'HC1-L0',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s1',
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [],
    label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t1',
    name: 'HC1 Test Task',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [l2Slot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l0P, task, 'hc1-s1');
  assert(v !== null, 'HC-1: L0 in L2-only slot → violation');
  assert(v!.code === 'LEVEL_MISMATCH', 'HC-1: violation code = LEVEL_MISMATCH');
}

// Level match: L2 in L2 slot
{
  const l2P: Participant = {
    id: 'hc1-l2',
    name: 'HC1-L2',
    level: Level.L2,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s2',
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [],
    label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t2',
    name: 'HC1 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [l2Slot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l2P, task, 'hc1-s2');
  assert(v === null, 'HC-1: L2 in L2 slot → no violation');
}

// Overqualified: L4 in L2 slot (blocked by HC-1 — level not in acceptableLevels)
{
  const l4P: Participant = {
    id: 'hc1-l4',
    name: 'HC1-L4',
    level: Level.L4,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc1-s3',
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [],
    label: 'L2 Only',
  };
  const task: Task = {
    id: 'hc1-t3',
    name: 'HC1 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [l2Slot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkLevelRequirement(l4P, task, 'hc1-s3');
  assert(v !== null, 'HC-1: L4 not in L2-only slot acceptableLevels → violation');
  assert(v!.code === 'LEVEL_MISMATCH', 'HC-1: correct violation code for level mismatch');
}

// Nonexistent slot
{
  const pAny: Participant = {
    id: 'hc1-any',
    name: 'HC1-Any',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc1-t4',
    name: 'HC1 Test4',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkLevelRequirement(pAny, task, 'nonexistent-slot');
  assert(v !== null, 'HC-1: nonexistent slot → violation');
  assert(v!.code === 'SLOT_NOT_FOUND', 'HC-1: nonexistent slot → SLOT_NOT_FOUND');
}

// ── HC-2: checkCertificationRequirement ────────────────────────────────────

// Multiple required certs — missing one
{
  const pOneCert: Participant = {
    id: 'hc2-p1',
    name: 'HC2-P1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const multiCertSlot: SlotRequirement = {
    slotId: 'hc2-s1',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: ['Nitzan', 'Hamama'],
    label: 'Multi Cert',
  };
  const task: Task = {
    id: 'hc2-t1',
    name: 'HC2 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [multiCertSlot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pOneCert, task, 'hc2-s1');
  assert(v !== null, 'HC-2: missing one of two certs → violation');
  assert(v!.code === 'CERT_MISSING', 'HC-2: violation code = CERT_MISSING');
}

// All certs present
{
  const pBothCerts: Participant = {
    id: 'hc2-p2',
    name: 'HC2-P2',
    level: Level.L0,
    certifications: ['Nitzan', 'Hamama'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const multiCertSlot: SlotRequirement = {
    slotId: 'hc2-s2',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: ['Nitzan', 'Hamama'],
    label: 'Multi Cert',
  };
  const task: Task = {
    id: 'hc2-t2',
    name: 'HC2 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [multiCertSlot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pBothCerts, task, 'hc2-s2');
  assert(v === null, 'HC-2: all certs present → no violation');
}

// No certs required
{
  const pNoCerts: Participant = {
    id: 'hc2-p3',
    name: 'HC2-P3',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const noCertSlot: SlotRequirement = {
    slotId: 'hc2-s3',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'No Cert',
  };
  const task: Task = {
    id: 'hc2-t3',
    name: 'HC2 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [noCertSlot],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkCertificationRequirement(pNoCerts, task, 'hc2-s3');
  assert(v === null, 'HC-2: no certs required → no violation');
}

// ── HC-3: checkAvailability ────────────────────────────────────────────────

// Participant not available at all
{
  const noAvailP: Participant = {
    id: 'hc3-p1',
    name: 'HC3-NoAvail',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: [],
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t1',
    name: 'HC3 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkAvailability(noAvailP, task);
  assert(v !== null, 'HC-3: no availability → violation');
  assert(v!.code === 'AVAILABILITY_VIOLATION', 'HC-3: violation code = AVAILABILITY_VIOLATION');
}

// Partial availability
{
  const partialP: Participant = {
    id: 'hc3-p2',
    name: 'HC3-Partial',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: [{ start: new Date(2026, 1, 15, 8, 0), end: new Date(2026, 1, 15, 12, 0) }],
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t2',
    name: 'HC3 Test2',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkAvailability(partialP, task);
  assert(v !== null, 'HC-3: partial availability → violation');
}

// Full availability
{
  const fullP: Participant = {
    id: 'hc3-p3',
    name: 'HC3-Full',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const task: Task = {
    id: 'hc3-t3',
    name: 'HC3 Test3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const v = checkAvailability(fullP, task);
  assert(v === null, 'HC-3: full availability → no violation');
}

// ── HC-4: checkSameGroup ────────────────────────────────────────────────

{
  const groupATask: Task = {
    id: 'hc4-t1',
    name: 'HC4 GroupTask',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2,
    slots: [],
    isLight: false,
    sameGroupRequired: true,
    blocksConsecutive: true,
  };
  const pGroupA: Participant = {
    id: 'hc4-pa',
    name: 'HC4-A',
    level: Level.L0,
    certifications: [],
    group: 'Alpha',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pGroupB: Participant = {
    id: 'hc4-pb',
    name: 'HC4-B',
    level: Level.L0,
    certifications: [],
    group: 'Beta',
    availability: dayAvail,
    dateUnavailability: [],
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
    slotId: 'hc6-s1',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'Slot 1',
  };
  const slot2: SlotRequirement = {
    slotId: 'hc6-s2',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'Slot 2',
  };
  const task: Task = {
    id: 'hc6-t1',
    name: 'HC6 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2,
    slots: [slot1, slot2],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  // Slot unfilled
  const assigns1: Assignment[] = [
    {
      id: 'hc6-a1',
      taskId: 'hc6-t1',
      slotId: 'hc6-s1',
      participantId: 'p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v1 = checkSlotsFilled(task, assigns1);
  assert(v1.length === 1, 'HC-6: one unfilled slot → 1 violation');
  assert(v1[0].code === 'SLOT_UNFILLED', 'HC-6: violation code = SLOT_UNFILLED');

  // Slot overbooked
  const assigns2: Assignment[] = [
    {
      id: 'hc6-a2',
      taskId: 'hc6-t1',
      slotId: 'hc6-s1',
      participantId: 'p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc6-a3',
      taskId: 'hc6-t1',
      slotId: 'hc6-s1',
      participantId: 'p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc6-a4',
      taskId: 'hc6-t1',
      slotId: 'hc6-s2',
      participantId: 'p3',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v2 = checkSlotsFilled(task, assigns2);
  assert(v2.length === 1, 'HC-6: one overbooked slot → 1 violation');
  assert(v2[0].code === 'SLOT_OVERBOOKED', 'HC-6: violation code = SLOT_OVERBOOKED');

  // All filled correctly
  const assigns3: Assignment[] = [
    {
      id: 'hc6-a5',
      taskId: 'hc6-t1',
      slotId: 'hc6-s1',
      participantId: 'p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc6-a6',
      taskId: 'hc6-t1',
      slotId: 'hc6-s2',
      participantId: 'p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
    slotId: 'hc7-s1',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'Slot 1',
  };
  const slot2: SlotRequirement = {
    slotId: 'hc7-s2',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    label: 'Slot 2',
  };
  const task: Task = {
    id: 'hc7-t1',
    name: 'HC7 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2,
    slots: [slot1, slot2],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  // Same participant in two slots → violation
  const assigns: Assignment[] = [
    {
      id: 'hc7-a1',
      taskId: 'hc7-t1',
      slotId: 'hc7-s1',
      participantId: 'dup-p',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc7-a2',
      taskId: 'hc7-t1',
      slotId: 'hc7-s2',
      participantId: 'dup-p',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v = checkUniqueParticipantsPerTask(task, assigns);
  assert(v.length === 1, 'HC-7: duplicate participant → 1 violation');
  assert(v[0].code === 'DUPLICATE_IN_TASK', 'HC-7: violation code = DUPLICATE_IN_TASK');

  // Different participants → no violation
  const uniqueAssigns: Assignment[] = [
    {
      id: 'hc7-a3',
      taskId: 'hc7-t1',
      slotId: 'hc7-s1',
      participantId: 'p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc7-a4',
      taskId: 'hc7-t1',
      slotId: 'hc7-s2',
      participantId: 'p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v2 = checkUniqueParticipantsPerTask(task, uniqueAssigns);
  assert(v2.length === 0, 'HC-7: unique participants → no violations');
}

// ── HC-8: checkGroupFeasibility ────────────────────────────────────────────

{
  const l0Slot: SlotRequirement = {
    slotId: 'hc8-s-l0',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: ['Nitzan'],
    label: 'L0 Slot',
  };
  const l2Slot: SlotRequirement = {
    slotId: 'hc8-s-l2',
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: ['Nitzan'],
    label: 'L2 Slot',
  };
  const task: Task = {
    id: 'hc8-t1',
    name: 'HC8 Test',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2,
    slots: [l0Slot, l2Slot],
    isLight: false,
    sameGroupRequired: true,
    blocksConsecutive: true,
  };

  // Group has both L0 and L2 with certs → no violation
  const fullGroup: Participant[] = [
    {
      id: 'hc8-p1',
      name: 'L0-1',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
    {
      id: 'hc8-p2',
      name: 'L2-1',
      level: Level.L2,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
  ];
  const v1 = checkGroupFeasibility(task, fullGroup);
  assert(v1.length === 0, 'HC-8: group has all needed levels+certs → no violations');

  // Group missing L2 → violation
  const noL2Group: Participant[] = [
    {
      id: 'hc8-p3',
      name: 'L0-2',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
    {
      id: 'hc8-p4',
      name: 'L0-3',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
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
    {
      id: 'hc8-p5',
      name: 'L0-c',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
    {
      id: 'hc8-p6',
      name: 'L2-nc',
      level: Level.L2,
      certifications: [],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
  ];
  const v4 = checkGroupFeasibility(task, noCertGroup);
  assert(v4.length === 1, 'HC-8: group L2 missing cert → violation');
}

// ── HC-14: checkRestRules ──────────────────────────────────────────────────

console.log('\n── Category Break (HC-14) ──────────────');

{
  const catP: Participant = {
    id: 'hc14-p1',
    name: 'HC14Tester',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };

  // Two category-break tasks with only 3h gap → violation (need 5h)
  const catTask1: Task = {
    id: 'hc14-t1',
    name: 'Cat Task 1',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 10),
    requiredCount: 1,
    slots: [{ slotId: 'hc14-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: 'test-rest-rule',
  };
  const catTask2: Task = {
    id: 'hc14-t2',
    name: 'Cat Task 2',
    timeBlock: createTimeBlockFromHours(baseDate, 13, 17),
    requiredCount: 1,
    slots: [{ slotId: 'hc14-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: 'test-rest-rule',
  };
  const tMap14 = new Map([
    [catTask1.id, catTask1],
    [catTask2.id, catTask2],
  ]);
  const assigns14: Assignment[] = [
    {
      id: 'hc14-a1',
      taskId: catTask1.id,
      slotId: 'hc14-s1',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc14-a2',
      taskId: catTask2.id,
      slotId: 'hc14-s2',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  // Rest rule map: 'test-rest-rule' → 5 hours
  const restRuleMap14 = new Map([['test-rest-rule', 5 * 3600000]]);

  const v1 = checkRestRules(catP.id, assigns14, tMap14, restRuleMap14);
  assert(v1.length === 1, 'HC-14: 3h gap between rest-rule tasks → violation');
  assert(v1[0].code === 'CATEGORY_BREAK_VIOLATION', 'HC-14: violation code = CATEGORY_BREAK_VIOLATION');

  // 6h gap → no violation
  const catTask3: Task = {
    ...catTask2,
    id: 'hc14-t3',
    timeBlock: createTimeBlockFromHours(baseDate, 16, 20),
  };
  const tMap14b = new Map([
    [catTask1.id, catTask1],
    [catTask3.id, catTask3],
  ]);
  const assigns14b: Assignment[] = [
    {
      id: 'hc14-a3',
      taskId: catTask1.id,
      slotId: 'hc14-s1',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc14-a4',
      taskId: catTask3.id,
      slotId: 'hc14-s2',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v2 = checkRestRules(catP.id, assigns14b, tMap14b, restRuleMap14);
  assert(v2.length === 0, 'HC-14: 6h gap between rest-rule tasks → no violation');

  // One task without restRuleId → no violation
  const catTask4: Task = {
    ...catTask2,
    id: 'hc14-t4',
    restRuleId: undefined,
  };
  const tMap14c = new Map([
    [catTask1.id, catTask1],
    [catTask4.id, catTask4],
  ]);
  const assigns14c: Assignment[] = [
    {
      id: 'hc14-a5',
      taskId: catTask1.id,
      slotId: 'hc14-s1',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc14-a6',
      taskId: catTask4.id,
      slotId: 'hc14-s2',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v3 = checkRestRules(catP.id, assigns14c, tMap14c, restRuleMap14);
  assert(v3.length === 0, 'HC-14: one task without rest rule → no violation');

  // Exactly 5h gap → no violation (equal to minimum)
  const catTask5: Task = {
    ...catTask2,
    id: 'hc14-t5',
    timeBlock: createTimeBlockFromHours(baseDate, 15, 19),
  };
  const tMap14d = new Map([
    [catTask1.id, catTask1],
    [catTask5.id, catTask5],
  ]);
  const assigns14d: Assignment[] = [
    {
      id: 'hc14-a7',
      taskId: catTask1.id,
      slotId: 'hc14-s1',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'hc14-a8',
      taskId: catTask5.id,
      slotId: 'hc14-s2',
      participantId: catP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const v4 = checkRestRules(catP.id, assigns14d, tMap14d, restRuleMap14);
  assert(v4.length === 0, 'HC-14: exactly 5h gap → no violation');

  // validateHardConstraints integration with HC-14
  const r14 = validateHardConstraints([catTask1, catTask2], [catP], assigns14, undefined, restRuleMap14);
  assert(
    r14.violations.some((v) => v.code === 'CATEGORY_BREAK_VIOLATION'),
    'HC-14: full validation catches rest rule violation',
  );
}

// ── disabledHC parameter ───────────────────────────────────────────────────

console.log('\n── disabledHC Parameter ─────────────────');

{
  // Setup: L4 in Shemesh (L0-only → blocked by HC-1) + same participant double-booked (blocked by HC-5)
  const disP: Participant = {
    id: 'dis-p1',
    name: 'DisabledTest',
    level: Level.L4,
    certifications: ['Nitzan', 'Hamama'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const disTask1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const disTask2 = createHamamaTask(createTimeBlockFromHours(baseDate, 8, 14));
  const disAssigns: Assignment[] = [
    {
      id: 'dis-a1',
      taskId: disTask1.id,
      slotId: disTask1.slots[0].slotId,
      participantId: disP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'dis-a2',
      taskId: disTask2.id,
      slotId: disTask2.slots[0].slotId,
      participantId: disP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];

  // No disabled → both violations (HC-1 LEVEL_MISMATCH + HC-5 DOUBLE_BOOKING)
  const rAll = validateHardConstraints([disTask1, disTask2], [disP], disAssigns);
  assert(
    rAll.violations.some((v) => v.code === 'LEVEL_MISMATCH'),
    'disabledHC: HC-1 fires when not disabled',
  );
  assert(
    rAll.violations.some((v) => v.code === 'DOUBLE_BOOKING'),
    'disabledHC: HC-5 fires when not disabled',
  );

  // Disable HC-1 → only HC-5 remains
  const r1Off = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-1']));
  assert(!r1Off.violations.some((v) => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 suppressed when disabled');
  assert(
    r1Off.violations.some((v) => v.code === 'DOUBLE_BOOKING'),
    'disabledHC: HC-5 still fires when HC-1 disabled',
  );

  // Disable HC-5 → only HC-1 remains
  const r5Off = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-5']));
  assert(!r5Off.violations.some((v) => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 suppressed when disabled');
  assert(
    r5Off.violations.some((v) => v.code === 'LEVEL_MISMATCH'),
    'disabledHC: HC-1 still fires when HC-5 disabled',
  );

  // Disable both → no level or double-booking violations (other violations may remain)
  const rBothOff = validateHardConstraints([disTask1, disTask2], [disP], disAssigns, new Set(['HC-1', 'HC-5']));
  assert(!rBothOff.violations.some((v) => v.code === 'DOUBLE_BOOKING'), 'disabledHC: HC-5 suppressed');
  assert(!rBothOff.violations.some((v) => v.code === 'LEVEL_MISMATCH'), 'disabledHC: HC-1 suppressed');

  // Disable HC-6 → unfilled slots don't produce violations
  const singleSlotTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 14));
  const emptyAssigns: Assignment[] = [];
  const r6On = validateHardConstraints([singleSlotTask], [disP], emptyAssigns);
  assert(
    r6On.violations.some((v) => v.code === 'SLOT_UNFILLED'),
    'disabledHC: HC-6 fires when not disabled',
  );
  const r6Off = validateHardConstraints([singleSlotTask], [disP], emptyAssigns, new Set(['HC-6']));
  assert(!r6Off.violations.some((v) => v.code === 'SLOT_UNFILLED'), 'disabledHC: HC-6 suppressed when disabled');
}

// ─── Validator: Extended Tests ──────────────────────────────────────────────

console.log('\n── Validator: Extended ──────────────────');

// fullValidate with both hard violations and warnings
{
  // L4 in Hamama → valid but with LOW_PRIORITY_LEVEL warning
  const valP: Participant = {
    id: 'val-l4',
    name: 'Val-L4',
    level: Level.L4,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    {
      id: 'val-a1',
      taskId: valTask.id,
      slotId: valTask.slots[0].slotId,
      participantId: valP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const fvr = fullValidate([valTask], [valP], valAssigns);
  // L4 in Hamama is allowed (no hard violation) because acceptableLevels has L4 lowPriority
  assert(
    fvr.warnings.some((w) => w.code === 'LOW_PRIORITY_LEVEL'),
    'fullValidate: L4 in Hamama → LOW_PRIORITY_LEVEL warning',
  );
  assert(fvr.summary.includes('אזהרות'), 'fullValidate: summary mentions warnings');
}

// fullValidate: completely valid schedule → תקין summary
{
  const valP0: Participant = {
    id: 'val-p0',
    name: 'Val-P0',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    {
      id: 'val-a2',
      taskId: valTask.id,
      slotId: valTask.slots[0].slotId,
      participantId: valP0.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const fvr = fullValidate([valTask], [valP0], valAssigns);
  assert(fvr.valid === true, 'fullValidate: valid schedule reports valid=true');
  assert(fvr.violations.length === 0, 'fullValidate: no violations');
  assert(fvr.summary.includes('תקין'), 'fullValidate: summary says valid');
}

// fullValidate: invalid schedule → summary mentions violations count
{
  const valPBad: Participant = {
    id: 'val-bad',
    name: 'Val-Bad',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const valTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const valAssigns: Assignment[] = [
    {
      id: 'val-a3',
      taskId: valTask.id,
      slotId: valTask.slots[0].slotId,
      participantId: valPBad.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const fvr = fullValidate([valTask], [valPBad], valAssigns);
  assert(fvr.valid === false, 'fullValidate: invalid schedule reports valid=false');
  assert(fvr.violations.length > 0, 'fullValidate: has violations');
  assert(fvr.summary.includes('לא תקין'), 'fullValidate: summary says invalid');
}

// previewSwap: valid swap
{
  const swapP1: Participant = {
    id: 'swap-p1',
    name: 'Swap-P1',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const swapP2: Participant = {
    id: 'swap-p2',
    name: 'Swap-P2',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const swapTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const swapAssigns: Assignment[] = [
    {
      id: 'swap-a1',
      taskId: swapTask.id,
      slotId: swapTask.slots[0].slotId,
      participantId: swapP1.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const result = previewSwap([swapTask], [swapP1, swapP2], swapAssigns, {
    assignmentId: 'swap-a1',
    newParticipantId: swapP2.id,
  });
  assert(result.valid === true, 'previewSwap: valid swap between two eligible participants');
}

// previewSwap: swap causing double-booking
{
  const dbP1: Participant = {
    id: 'db-p1',
    name: 'DB-P1',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const dbP2: Participant = {
    id: 'db-p2',
    name: 'DB-P2',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const dbTask1 = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const dbTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 8, 14));
  const dbAssigns: Assignment[] = [
    {
      id: 'db-a1',
      taskId: dbTask1.id,
      slotId: dbTask1.slots[0].slotId,
      participantId: dbP1.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'db-a2',
      taskId: dbTask2.id,
      slotId: dbTask2.slots[0].slotId,
      participantId: dbP2.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  // Swap dbTask2 to dbP1 → overlaps with dbTask1
  const result = previewSwap([dbTask1, dbTask2], [dbP1, dbP2], dbAssigns, {
    assignmentId: 'db-a2',
    newParticipantId: dbP1.id,
  });
  assert(result.valid === false, 'previewSwap: swap causing double-booking → invalid');
  assert(
    result.violations.some((v) => v.code === 'DOUBLE_BOOKING'),
    'previewSwap: double-booking violation detected',
  );
}

// ── isEligible / getRejectionReason ────────────────────────────────────────

console.log('\n── Eligibility & Rejection Reasons ─────');

{
  const eligP: Participant = {
    id: 'elig-p1',
    name: 'Elig-P1',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const eligTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const eligSlot = eligTask.slots[0];
  const tMap = new Map([[eligTask.id, eligTask]]);

  // Eligible with no existing assignments
  assert(isEligible(eligP, eligTask, eligSlot, [], tMap) === true, 'isEligible: eligible participant → true');
  assert(getRejectionReason(eligP, eligTask, eligSlot, [], tMap) === null, 'getRejectionReason: eligible → null');

  // Missing cert
  const noCertP: Participant = { ...eligP, id: 'elig-p2', certifications: ['Nitzan'] };
  assert(isEligible(noCertP, eligTask, eligSlot, [], tMap) === false, 'isEligible: missing cert → false');
  assert(
    getRejectionReason(noCertP, eligTask, eligSlot, [], tMap) === 'HC-2',
    'getRejectionReason: missing cert → HC-2',
  );

  // Already assigned to same task → HC-5 fires first (same timeblock overlaps with itself)
  const existingAssign: Assignment[] = [
    {
      id: 'elig-a1',
      taskId: eligTask.id,
      slotId: eligSlot.slotId,
      participantId: eligP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  assert(isEligible(eligP, eligTask, eligSlot, existingAssign, tMap) === false, 'isEligible: already assigned → false');
  assert(
    getRejectionReason(eligP, eligTask, eligSlot, existingAssign, tMap) === 'HC-5',
    'getRejectionReason: already assigned (same block overlap) → HC-5',
  );

  // Already assigned to a NON-overlapping task of same ID → would be HC-7
  // But in practice tasks have unique IDs, so HC-5 and HC-7 are correlated

  // Double-booking: existing overlapping assignment
  const otherTask = createShemeshTask(createTimeBlockFromHours(baseDate, 8, 14));
  const tMap2 = new Map([
    [eligTask.id, eligTask],
    [otherTask.id, otherTask],
  ]);
  const overlapAssign: Assignment[] = [
    {
      id: 'elig-a2',
      taskId: otherTask.id,
      slotId: otherTask.slots[0].slotId,
      participantId: eligP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  assert(isEligible(eligP, eligTask, eligSlot, overlapAssign, tMap2) === false, 'isEligible: overlapping task → false');
  assert(
    getRejectionReason(eligP, eligTask, eligSlot, overlapAssign, tMap2) === 'HC-5',
    'getRejectionReason: overlap → HC-5',
  );

  // No availability
  const noAvailP: Participant = { ...eligP, id: 'elig-p3', availability: [] };
  assert(isEligible(noAvailP, eligTask, eligSlot, [], tMap) === false, 'isEligible: no availability → false');
  assert(
    getRejectionReason(noAvailP, eligTask, eligSlot, [], tMap) === 'HC-3',
    'getRejectionReason: no availability → HC-3',
  );
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
    {
      id: 'rest-s1',
      taskId: singleTask.id,
      slotId: singleTask.slots[0].slotId,
      participantId: 'rest-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
    {
      id: 'rest-l1',
      taskId: lightTask.id,
      slotId: lightTask.slots[0].slotId,
      participantId: 'rest-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const restLight = computeParticipantRest('rest-p2', lightAssign, [lightTask]);
  assert(restLight.nonLightAssignmentCount === 0, 'Rest: light only → 0 non-light count');
  assert(restLight.totalWorkHours === 0, 'Rest: light only → 0 work hours');
  assert(restLight.totalLightHours === 8, 'Rest: light 8h → totalLightHours=8');
}

// Three tasks with varying gaps → correct min/max/avg
{
  const r3t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 8)); // 2h
  const r3t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 12, 14)); // 2h, gap=4h
  const r3t3 = createShemeshTask(createTimeBlockFromHours(baseDate, 20, 22)); // 2h, gap=6h
  const r3Assigns: Assignment[] = [
    {
      id: 'r3-a1',
      taskId: r3t1.id,
      slotId: r3t1.slots[0].slotId,
      participantId: 'rest-p3',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'r3-a2',
      taskId: r3t2.id,
      slotId: r3t2.slots[0].slotId,
      participantId: 'rest-p3',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'r3-a3',
      taskId: r3t3.id,
      slotId: r3t3.slots[0].slotId,
      participantId: 'rest-p3',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
    {
      id: 'nb-a1',
      taskId: blockingTask.id,
      slotId: blockingTask.slots[0].slotId,
      participantId: 'rest-p4',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'nb-a2',
      taskId: nonBlockingTask.id,
      slotId: nonBlockingTask.slots[0].slotId,
      participantId: 'rest-p4',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'nb-a3',
      taskId: blockingTask2.id,
      slotId: blockingTask2.slots[0].slotId,
      participantId: 'rest-p4',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
    id: 'rap-1',
    name: 'RAP1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const rap2: Participant = {
    id: 'rap-2',
    name: 'RAP2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const rapTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const rapAssigns: Assignment[] = [
    {
      id: 'rap-a1',
      taskId: rapTask.id,
      slotId: rapTask.slots[0].slotId,
      participantId: 'rap-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const p1: Participant = {
    id: 'rf-1',
    name: 'RF1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'rf-2',
    name: 'RF2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const rfAssigns: Assignment[] = [
    {
      id: 'rf-a1',
      taskId: t1.id,
      slotId: t1.slots[0].slotId,
      participantId: 'rf-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'rf-a2',
      taskId: t2.id,
      slotId: t2.slots[0].slotId,
      participantId: 'rf-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'rf-a3',
      taskId: t1.id,
      slotId: t1.slots[1].slotId,
      participantId: 'rf-2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'rf-a4',
      taskId: t3.id,
      slotId: t3.slots[0].slotId,
      participantId: 'rf-2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const wlP1: Participant = {
    id: 'wl-1',
    name: 'WL1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const wlP2: Participant = {
    id: 'wl-2',
    name: 'WL2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  // Both assigned to identical tasks
  const wlTask2 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const wlAssigns: Assignment[] = [
    {
      id: 'wl-a1',
      taskId: wlTask.id,
      slotId: wlTask.slots[0].slotId,
      participantId: 'wl-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'wl-a2',
      taskId: wlTask2.id,
      slotId: wlTask2.slots[0].slotId,
      participantId: 'wl-2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const wlStats = workloadImbalanceSplit([wlP1, wlP2], wlAssigns, [wlTask, wlTask2]);
  assert(wlStats.l0StdDev === 0, 'SC-3: equal workload → l0StdDev=0');
  assert(wlStats.l0Penalty === 0, 'SC-3: equal workload → l0Penalty=0');
}

// Unequal workload → nonzero penalty
{
  const wlTaskBig = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 18)); // 12h
  const wlTaskSmall = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 8)); // 2h
  const wlP1: Participant = {
    id: 'wl2-1',
    name: 'WL2-1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const wlP2: Participant = {
    id: 'wl2-2',
    name: 'WL2-2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const wlAssigns: Assignment[] = [
    {
      id: 'wl2-a1',
      taskId: wlTaskBig.id,
      slotId: wlTaskBig.slots[0].slotId,
      participantId: 'wl2-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'wl2-a2',
      taskId: wlTaskSmall.id,
      slotId: wlTaskSmall.slots[0].slotId,
      participantId: 'wl2-2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const spL0a: Participant = {
    id: 'sp2-l0a',
    name: 'SP-L0a',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const spL0b: Participant = {
    id: 'sp2-l0b',
    name: 'SP-L0b',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const spSr: Participant = {
    id: 'sp2-sr',
    name: 'SP-Sr',
    level: Level.L3,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  // L0s get unequal work, senior gets none
  const spAssigns: Assignment[] = [
    {
      id: 'sp2-a1',
      taskId: spTask1.id,
      slotId: spTask1.slots[0].slotId,
      participantId: 'sp2-l0a',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'sp2-a2',
      taskId: spTask2.id,
      slotId: spTask2.slots[0].slotId,
      participantId: 'sp2-l0b',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
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
  const wlPLight: Participant = {
    id: 'wl-light',
    name: 'WL-Light',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const lightAssigns: Assignment[] = [
    {
      id: 'wl-la1',
      taskId: lightTask.id,
      slotId: lightTask.slots[0].slotId,
      participantId: 'wl-light',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const lightStats = workloadImbalanceSplit([wlPLight], lightAssigns, [lightTask]);
  assert(lightStats.l0Avg === 0, 'SC-3: light task → 0 effective hours → avg=0');
}

// ─── collectSoftWarnings ────────────────────────────────────────────────────

console.log('\n── collectSoftWarnings ─────────────────');

// No warnings for a clean schedule
{
  const cwP: Participant = {
    id: 'cw-p1',
    name: 'CW-P1',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const cwTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const cwAssigns: Assignment[] = [
    {
      id: 'cw-a1',
      taskId: cwTask.id,
      slotId: cwTask.slots[0].slotId,
      participantId: cwP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const warnings = collectSoftWarnings([cwTask], [cwP], cwAssigns);
  // Should be zero or minimal warnings for a valid L0 assignment
  assert(
    !warnings.some((w) => w.code === 'LOW_PRIORITY_LEVEL'),
    'collectSoftWarnings: L0 in Hamama → no LOW_PRIORITY_LEVEL',
  );
}

// LOW_PRIORITY_LEVEL warning for L4 in Hamama
{
  const cwP4: Participant = {
    id: 'cw-p4',
    name: 'CW-P4',
    level: Level.L4,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const cwTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const cwAssigns: Assignment[] = [
    {
      id: 'cw-a2',
      taskId: cwTask.id,
      slotId: cwTask.slots[0].slotId,
      participantId: cwP4.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const warnings = collectSoftWarnings([cwTask], [cwP4], cwAssigns);
  assert(
    warnings.some((w) => w.code === 'LOW_PRIORITY_LEVEL'),
    'collectSoftWarnings: L4 in Hamama → LOW_PRIORITY_LEVEL warning',
  );
}

// ─── computeScheduleScore: Extended Tests ───────────────────────────────────

console.log('\n── computeScheduleScore: Extended ──────');

// Score with zero assignments → baseline
{
  const scoreP: Participant = {
    id: 'score-p1',
    name: 'Score-P1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const scoreTask = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const score = computeScheduleScore([scoreTask], [scoreP], [], DEFAULT_CONFIG);
  assert(score.totalPenalty === 0, 'Score: empty schedule → 0 penalty');
  assert(score.l0StdDev === 0, 'Score: empty schedule → l0StdDev=0');
}

// Score with balanced assignments → low penalty, good composite
{
  const p1: Participant = {
    id: 'sb-p1',
    name: 'SB1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'sb-p2',
    name: 'SB2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));
  const assigns: Assignment[] = [
    {
      id: 'sb-a1',
      taskId: t1.id,
      slotId: t1.slots[0].slotId,
      participantId: 'sb-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'sb-a2',
      taskId: t2.id,
      slotId: t2.slots[0].slotId,
      participantId: 'sb-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const scoreBalanced = computeScheduleScore([t1, t2], [p1, p2], assigns, DEFAULT_CONFIG);
  assert(scoreBalanced.l0StdDev === 0, 'Score: balanced 4h each → l0StdDev=0');
  assert(scoreBalanced.l0AvgEffective === 4, 'Score: balanced avg = 4h');
}

// Score with imbalanced assignments → higher penalty
{
  const p1: Participant = {
    id: 'si-p1',
    name: 'SI1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'si-p2',
    name: 'SI2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const t1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 14)); // 8h
  const t2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18)); // 4h
  // P1 gets both tasks (12h), P2 gets nothing
  const assigns: Assignment[] = [
    {
      id: 'si-a1',
      taskId: t1.id,
      slotId: t1.slots[0].slotId,
      participantId: 'si-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'si-a2',
      taskId: t2.id,
      slotId: t2.slots[0].slotId,
      participantId: 'si-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const scoreImb = computeScheduleScore([t1, t2], [p1, p2], assigns, DEFAULT_CONFIG);
  assert(scoreImb.l0StdDev > 0, 'Score: imbalanced → l0StdDev > 0');
}

// Score comparison: balanced vs imbalanced → balanced has better composite
{
  const pb1: Participant = {
    id: 'cmp-p1',
    name: 'CMP1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pb2: Participant = {
    id: 'cmp-p2',
    name: 'CMP2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const ct1 = createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10));
  const ct2 = createShemeshTask(createTimeBlockFromHours(baseDate, 14, 18));

  const balAssigns: Assignment[] = [
    {
      id: 'cmp-a1',
      taskId: ct1.id,
      slotId: ct1.slots[0].slotId,
      participantId: 'cmp-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'cmp-a2',
      taskId: ct2.id,
      slotId: ct2.slots[0].slotId,
      participantId: 'cmp-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const imbAssigns: Assignment[] = [
    {
      id: 'cmp-a3',
      taskId: ct1.id,
      slotId: ct1.slots[0].slotId,
      participantId: 'cmp-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'cmp-a4',
      taskId: ct2.id,
      slotId: ct2.slots[0].slotId,
      participantId: 'cmp-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const scoreBal = computeScheduleScore([ct1, ct2], [pb1, pb2], balAssigns, DEFAULT_CONFIG);
  const scoreImb = computeScheduleScore([ct1, ct2], [pb1, pb2], imbAssigns, DEFAULT_CONFIG);
  assert(
    scoreBal.compositeScore >= scoreImb.compositeScore,
    'Score: balanced schedule has better (>=) composite score than imbalanced',
  );
}

// ─── Engine: Extended Integration Tests ─────────────────────────────────────

console.log('\n── Engine: Extended Integration ─────────');

// Engine validates schedule after generation
{
  const testEngine = new SchedulingEngine({ maxIterations: 200, maxSolverTimeMs: 3000 });
  const p1: Participant = {
    id: 'eng-p1',
    name: 'Eng1',
    level: Level.L0,
    certifications: ['Nitzan', 'Hamama'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'eng-p2',
    name: 'Eng2',
    level: Level.L0,
    certifications: ['Nitzan', 'Hamama'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
  const p3: Participant = {
    id: 'eng-p3',
    name: 'Eng3',
    level: Level.L0,
    certifications: ['Nitzan', 'Hamama'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
  testEngine.addParticipants([p1, p2, p3]);

  const engTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  testEngine.addTask(engTask);

  const engSchedule = testEngine.generateSchedule();
  assert(engSchedule.assignments.length > 0, 'Engine: generates at least 1 assignment');

  const engValidation = testEngine.validate();
  assert(engValidation.valid === true, 'Engine: single-task schedule passes validation');
  assert(engValidation.violations.length === 0, 'Engine: single-task schedule has no violations');
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
  const ntP: Participant = {
    id: 'nt-p1',
    name: 'NT1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
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
  const sp1: Participant = {
    id: 'st-p1',
    name: 'ST1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
  const sp2: Participant = {
    id: 'st-p2',
    name: 'ST2',
    level: Level.L2,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };
  statsEngine.addParticipants([sp1, sp2]);
  statsEngine.addTask(createShemeshTask(createTimeBlockFromHours(baseDate, 6, 10)));
  statsEngine.addTask(createHamamaTask(createTimeBlockFromHours(baseDate, 10, 18)));
  const stats = statsEngine.getStats();
  assert(stats.totalTasks === 2, 'Engine stats: 2 tasks');
  assert(stats.totalParticipants === 2, 'Engine stats: 2 participants');
}

// ─── Dynamic Certifications ──────────────────────────────────────────────────

console.log('\n── Dynamic Certifications ──────────────────');

{
  // Verify default definitions
  assert(DEFAULT_CERTIFICATION_DEFINITIONS.length === 4, 'Defaults: 4 certifications');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[0].id === 'Nitzan', 'Defaults: first is Nitzan');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[0].label === 'ניצן', 'Defaults: Nitzan label is Hebrew');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[0].color === '#16a085', 'Defaults: Nitzan color is teal');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[1].id === 'Salsala', 'Defaults: second is Salsala');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[2].id === 'Hamama', 'Defaults: third is Hamama');
  assert(DEFAULT_CERTIFICATION_DEFINITIONS[3].id === 'Horesh', 'Defaults: fourth is Horesh');

  // Verify IDs match old enum string values (engine compatibility)
  const ids = DEFAULT_CERTIFICATION_DEFINITIONS.map((d) => d.id);
  assert(ids.includes('Nitzan'), 'Compat: Nitzan ID matches legacy enum');
  assert(ids.includes('Salsala'), 'Compat: Salsala ID matches legacy enum');
  assert(ids.includes('Hamama'), 'Compat: Hamama ID matches legacy enum');
  assert(ids.includes('Horesh'), 'Compat: Horesh ID matches legacy enum');

  // Verify all have valid hex colors
  for (const def of DEFAULT_CERTIFICATION_DEFINITIONS) {
    assert(/^#[0-9a-fA-F]{6}$/.test(def.color), `Defaults: ${def.id} has valid hex color`);
  }

  // Verify CertificationDefinition shape
  const def: CertificationDefinition = DEFAULT_CERTIFICATION_DEFINITIONS[0];
  assert(typeof def.id === 'string', 'Shape: id is string');
  assert(typeof def.label === 'string', 'Shape: label is string');
  assert(typeof def.color === 'string', 'Shape: color is string');
  assert(def.id.length > 0, 'Shape: id is non-empty');
  assert(def.label.length > 0, 'Shape: label is non-empty');
}

// HC-2 with string-based certifications (dynamic certs)
{
  const baseDate = new Date(2025, 0, 6);
  const tb = createTimeBlockFromHours(baseDate, 8, 16);

  // Task requiring a custom (non-default) cert ID
  const customCertTask: Task = {
    id: 'custom-cert-task',
    name: 'CustomCertTask',
    timeBlock: tb,
    requiredCount: 1,
    slots: [
      {
        slotId: 'cc-s1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['CustomCert123'],
        label: 'slot',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };

  // Participant WITH the custom cert
  const pWith: Participant = {
    id: 'cc-p1',
    name: 'HasCustom',
    level: Level.L0,
    certifications: ['CustomCert123'],
    group: 'A',
    availability: [
      {
        start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0),
        end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0),
      },
    ],
    dateUnavailability: [],
  };

  // Participant WITHOUT the custom cert
  const pWithout: Participant = {
    id: 'cc-p2',
    name: 'NoCustom',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: [
      {
        start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0),
        end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0),
      },
    ],
    dateUnavailability: [],
  };

  const taskMap = new Map([[customCertTask.id, customCertTask]]);

  // HC-2: participant with correct custom cert → eligible
  const eligWith = isEligible(pWith, customCertTask, customCertTask.slots[0], [], taskMap);
  assert(eligWith === true, 'HC-2 dynamic: participant with custom cert is eligible');

  // HC-2: participant without custom cert → not eligible
  const eligWithout = isEligible(pWithout, customCertTask, customCertTask.slots[0], [], taskMap);
  assert(eligWithout === false, 'HC-2 dynamic: participant without custom cert is not eligible');

  // HC-2: rejection reason is cert missing
  const reason = getRejectionReason(pWithout, customCertTask, customCertTask.slots[0], [], taskMap);
  assert(reason === 'HC-2', 'HC-2 dynamic: rejection reason is HC-2');
}

// HC-11 with string-based forbidden certifications (dynamic certs)
{
  const baseDate = new Date(2025, 0, 6);
  const tb = createTimeBlockFromHours(baseDate, 8, 16);
  const dayWindow = [
    {
      start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0),
      end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0),
    },
  ];

  // Task with forbidden custom cert
  const forbiddenTask: Task = {
    id: 'fc-task',
    name: 'ForbiddenCustom',
    timeBlock: tb,
    requiredCount: 1,
    slots: [
      {
        slotId: 'fc-s1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: ['DangerousCert'],
        label: 'slot',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };

  // Participant WITH the forbidden cert
  const pForbidden: Participant = {
    id: 'fc-p1',
    name: 'HasDangerous',
    level: Level.L0,
    certifications: ['Nitzan', 'DangerousCert'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };

  // Participant WITHOUT the forbidden cert
  const pClean: Participant = {
    id: 'fc-p2',
    name: 'NoDangerous',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };

  const taskMap = new Map([[forbiddenTask.id, forbiddenTask]]);

  const eligForbidden = isEligible(pForbidden, forbiddenTask, forbiddenTask.slots[0], [], taskMap);
  assert(eligForbidden === false, 'HC-11 dynamic: participant with forbidden custom cert is not eligible');

  const reasonForbidden = getRejectionReason(pForbidden, forbiddenTask, forbiddenTask.slots[0], [], taskMap);
  assert(reasonForbidden === 'HC-11', 'HC-11 dynamic: rejection reason is HC-11');

  const eligClean = isEligible(pClean, forbiddenTask, forbiddenTask.slots[0], [], taskMap);
  assert(eligClean === true, 'HC-11 dynamic: participant without forbidden cert is eligible');
}

// Multi-cert requirement (AND logic) with dynamic cert IDs
{
  const baseDate = new Date(2025, 0, 6);
  const tb = createTimeBlockFromHours(baseDate, 8, 16);
  const dayWindow = [
    {
      start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0),
      end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0),
    },
  ];

  const multiCertTask: Task = {
    id: 'mc-task',
    name: 'MultiCert',
    timeBlock: tb,
    requiredCount: 1,
    slots: [
      {
        slotId: 'mc-s1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['CertA', 'CertB', 'CertC'],
        label: 'slot',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };

  const pAll: Participant = {
    id: 'mc-p1',
    name: 'HasAll',
    level: Level.L0,
    certifications: ['CertA', 'CertB', 'CertC'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };

  const pPartial: Participant = {
    id: 'mc-p2',
    name: 'HasPartial',
    level: Level.L0,
    certifications: ['CertA', 'CertC'],
    group: 'A', // missing CertB
    availability: dayWindow,
    dateUnavailability: [],
  };

  const pNone: Participant = {
    id: 'mc-p3',
    name: 'HasNone',
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };

  const taskMap = new Map([[multiCertTask.id, multiCertTask]]);
  assert(
    isEligible(pAll, multiCertTask, multiCertTask.slots[0], [], taskMap) === true,
    'Multi-cert: all certs → eligible',
  );
  assert(
    isEligible(pPartial, multiCertTask, multiCertTask.slots[0], [], taskMap) === false,
    'Multi-cert: partial certs → not eligible',
  );
  assert(
    isEligible(pNone, multiCertTask, multiCertTask.slots[0], [], taskMap) === false,
    'Multi-cert: no certs → not eligible',
  );
}

// Cert strings work in full validation pipeline
{
  const baseDate = new Date(2025, 0, 6);
  const tb = createTimeBlockFromHours(baseDate, 8, 16);
  const dayWindow = [
    {
      start: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0),
      end: new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0),
    },
  ];

  const task: Task = {
    id: 'val-task',
    name: 'ValidatorTest',
    timeBlock: tb,
    requiredCount: 1,
    slots: [
      {
        slotId: 'val-s1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['DynCert'],
        label: 'slot',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };

  const p: Participant = {
    id: 'val-p1',
    name: 'P1',
    level: Level.L0,
    certifications: ['WrongCert'],
    group: 'A',
    availability: dayWindow,
    dateUnavailability: [],
  };

  const result = validateHardConstraints(
    [task],
    [p],
    [
      {
        id: 'val-a1',
        taskId: 'val-task',
        slotId: 'val-s1',
        participantId: 'val-p1',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
    ],
    new Set(),
  );
  const certViolation = result.violations.find((v) => v.code === 'CERT_MISSING');
  assert(certViolation !== undefined, 'Validator: CERT_MISSING for wrong dynamic cert');
  assert(certViolation!.message.length > 0, 'Validator: violation message is non-empty');
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPORAL ENGINE (Live Mode) Tests
// ═══════════════════════════════════════════════════════════════════════════════

import {
  freezeAssignments,
  getAnchorDayIndex,
  getFutureWindow,
  isDayFrozen,
  isDayPartiallyFrozen,
  isFutureTask,
  isInProgressTask,
  isModifiableAssignment,
  isPastTask,
  unfreezeAll,
} from './engine/temporal';

console.log('\n── Temporal Engine (Live Mode) ──────────');

{
  const tBase = new Date(2026, 1, 15);
  const pastTask: Task = {
    id: 'temp-past',
    name: 'Past Task',
    timeBlock: createTimeBlockFromHours(tBase, 6, 10),
    requiredCount: 1,
    slots: [{ slotId: 'tp-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const futureTask: Task = {
    id: 'temp-future',
    name: 'Future Task',
    timeBlock: createTimeBlockFromHours(tBase, 18, 22),
    requiredCount: 1,
    slots: [{ slotId: 'tp-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const inProgressTask: Task = {
    id: 'temp-inprog',
    name: 'In Progress Task',
    timeBlock: createTimeBlockFromHours(tBase, 10, 18),
    requiredCount: 1,
    slots: [{ slotId: 'tp-s3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  // Anchor at 14:00 — pastTask ended at 10:00, inProgressTask started at 10:00, futureTask at 18:00
  const anchor = new Date(2026, 1, 15, 14, 0);

  // ── Core predicates ──
  assert(isPastTask(pastTask, anchor) === true, 'Temporal: past task (06-10) is past at anchor 14:00');
  assert(isPastTask(futureTask, anchor) === false, 'Temporal: future task is not past');
  assert(isPastTask(inProgressTask, anchor) === false, 'Temporal: in-progress task is not past');

  assert(isFutureTask(futureTask, anchor) === true, 'Temporal: future task (18-22) is future at anchor 14:00');
  assert(isFutureTask(pastTask, anchor) === false, 'Temporal: past task is not future');
  assert(isFutureTask(inProgressTask, anchor) === false, 'Temporal: in-progress task is not future');

  assert(isInProgressTask(inProgressTask, anchor) === true, 'Temporal: in-progress task (10-18) at anchor 14:00');
  assert(isInProgressTask(pastTask, anchor) === false, 'Temporal: past task is not in-progress');
  assert(isInProgressTask(futureTask, anchor) === false, 'Temporal: future task is not in-progress');

  // ── Edge case: anchor exactly at task boundaries ──
  const atStart = new Date(2026, 1, 15, 10, 0);
  assert(isFutureTask(inProgressTask, atStart) === true, 'Temporal: task at anchor start is future (start >= anchor)');
  assert(isPastTask(pastTask, atStart) === true, 'Temporal: task ending at anchor is past (end <= anchor)');

  // ── isModifiableAssignment ──
  const taskMap = new Map<string, Task>([
    [pastTask.id, pastTask],
    [futureTask.id, futureTask],
    [inProgressTask.id, inProgressTask],
  ]);

  const futureAssign: Assignment = {
    id: 'ta-1',
    taskId: futureTask.id,
    slotId: 'tp-s2',
    participantId: 'p1',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const pastAssign: Assignment = {
    id: 'ta-2',
    taskId: pastTask.id,
    slotId: 'tp-s1',
    participantId: 'p1',
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
  const lockedAssign: Assignment = {
    id: 'ta-3',
    taskId: futureTask.id,
    slotId: 'tp-s2',
    participantId: 'p1',
    status: AssignmentStatus.Locked,
    updatedAt: new Date(),
  };
  const frozenAssign: Assignment = {
    id: 'ta-4',
    taskId: futureTask.id,
    slotId: 'tp-s2',
    participantId: 'p1',
    status: AssignmentStatus.Frozen,
    updatedAt: new Date(),
  };

  assert(
    isModifiableAssignment(futureAssign, taskMap, anchor) === true,
    'Temporal: scheduled future assignment is modifiable',
  );
  assert(isModifiableAssignment(pastAssign, taskMap, anchor) === false, 'Temporal: past assignment is NOT modifiable');
  assert(
    isModifiableAssignment(lockedAssign, taskMap, anchor) === false,
    'Temporal: locked future assignment is NOT modifiable',
  );
  assert(
    isModifiableAssignment(frozenAssign, taskMap, anchor) === false,
    'Temporal: frozen future assignment is NOT modifiable',
  );

  // ── freezeAssignments ──
  const schedule: Schedule = {
    id: 'temp-schedule',
    tasks: [pastTask, futureTask, inProgressTask],
    participants: [],
    assignments: [
      {
        id: 'fa-1',
        taskId: pastTask.id,
        slotId: 'tp-s1',
        participantId: 'p1',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
      {
        id: 'fa-2',
        taskId: futureTask.id,
        slotId: 'tp-s2',
        participantId: 'p2',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
      {
        id: 'fa-3',
        taskId: inProgressTask.id,
        slotId: 'tp-s3',
        participantId: 'p3',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
    ],
    score: null as any,
    violations: [],
    feasible: true,
    generatedAt: new Date(),
  };

  const changed = freezeAssignments(schedule, anchor);
  assert(changed === 2, 'Temporal: freezeAssignments freezes past + in-progress (2 changed)');
  assert(schedule.assignments[0].status === AssignmentStatus.Frozen, 'Temporal: past assignment is now Frozen');
  assert(schedule.assignments[1].status === AssignmentStatus.Scheduled, 'Temporal: future assignment stays Scheduled');
  assert(schedule.assignments[2].status === AssignmentStatus.Frozen, 'Temporal: in-progress assignment is now Frozen');

  // ── unfreezeAll ──
  const unfrozen = unfreezeAll(schedule);
  assert(unfrozen === 2, 'Temporal: unfreezeAll unfreezes 2 assignments');
  assert(
    schedule.assignments[0].status === AssignmentStatus.Scheduled,
    'Temporal: unfrozen assignment restored to Scheduled',
  );
  assert(
    schedule.assignments[2].status === AssignmentStatus.Scheduled,
    'Temporal: unfrozen in-progress restored to Scheduled',
  );

  // ── getFutureWindow ──
  const futureWindow = getFutureWindow(tBase, 7, anchor, 5);
  assert(futureWindow.start.getTime() === anchor.getTime(), 'Temporal: futureWindow starts at anchor');
  assert(futureWindow.end.getDate() === 22, 'Temporal: futureWindow ends 7 days after schedule start');

  // ── getAnchorDayIndex ──
  assert(getAnchorDayIndex(tBase, 7, anchor, 5) === 1, 'Temporal: anchor 14:00 on day 1 → index 1');
  const day2Anchor = new Date(2026, 1, 16, 10, 0);
  assert(getAnchorDayIndex(tBase, 7, day2Anchor, 5) === 2, 'Temporal: anchor on day 2 → index 2');
  const beforeSchedule = new Date(2026, 1, 14, 23, 0);
  assert(getAnchorDayIndex(tBase, 7, beforeSchedule, 5) === 0, 'Temporal: anchor before schedule → index 0');

  // ── isDayFrozen / isDayPartiallyFrozen ──
  // anchor at 14:00 on day 1: day 1 is partially frozen, no days fully frozen
  assert(isDayFrozen(1, tBase, anchor, 5) === false, 'Temporal: day 1 not fully frozen (anchor mid-day)');
  assert(isDayPartiallyFrozen(1, tBase, anchor, 5) === true, 'Temporal: day 1 partially frozen');
  assert(isDayPartiallyFrozen(2, tBase, anchor, 5) === false, 'Temporal: day 2 not partially frozen');

  // Anchor far in the future: day 1 fully frozen
  const farAnchor = new Date(2026, 1, 17, 10, 0);
  assert(isDayFrozen(1, tBase, farAnchor, 5) === true, 'Temporal: day 1 fully frozen when anchor is on day 3');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Date Utilities (operationalDateKey, calendarDateKey)
// ═══════════════════════════════════════════════════════════════════════════════

import { calendarDateKey, operationalDateKey } from './utils/date-utils';

console.log('\n── Date Utilities: operationalDateKey ──');

{
  // Normal daytime: 15:00 on Feb 15 → belongs to Feb 15
  const afternoon = new Date(2026, 1, 15, 15, 0);
  assert(operationalDateKey(afternoon, 5) === '2026-02-15', 'opDateKey: 15:00 → same calendar day');

  // Early morning before dayStartHour: 03:00 on Feb 16 → belongs to Feb 15 operational day
  const earlyMorning = new Date(2026, 1, 16, 3, 0);
  assert(operationalDateKey(earlyMorning, 5) === '2026-02-15', 'opDateKey: 03:00 → previous day (before dayStart=5)');

  // Exactly at dayStartHour: 05:00 → belongs to current day
  const atStart = new Date(2026, 1, 16, 5, 0);
  assert(operationalDateKey(atStart, 5) === '2026-02-16', 'opDateKey: exactly 05:00 → current day');

  // Different dayStartHour: 06:00 start, 05:30 → previous day
  const earlyWithDiff = new Date(2026, 1, 16, 5, 30);
  assert(operationalDateKey(earlyWithDiff, 6) === '2026-02-15', 'opDateKey: 05:30 with dayStart=6 → previous day');

  // Calendar date key — always midnight boundary
  assert(
    calendarDateKey(earlyMorning) === '2026-02-16',
    'calendarDateKey: 03:00 on Feb 16 → 2026-02-16 (midnight boundary)',
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// HC-3: dateUnavailability (never tested before)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── HC-3: dateUnavailability ─────────────');

{
  // baseDate is Feb 15, 2026 = Sunday (getDay()=0)
  // Participant unavailable all day on Sundays
  const duP: Participant = {
    id: 'du-p1',
    name: 'DateUnavail',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [{ id: 'du-u1', dayOfWeek: 0, startHour: 0, endHour: 0, allDay: true }],
  };
  const duTask: Task = {
    id: 'du-t1',
    name: 'DU Task',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [{ slotId: 'du-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  // Check eligibility — dateUnavailability must block this participant
  const tMap = new Map([[duTask.id, duTask]]);
  const eligible = isEligible(duP, duTask, duTask.slots[0], [], tMap);
  assert(eligible === false, 'HC-3: dateUnavailability blocks isEligible on matching day');

  // Also verify via validateHardConstraints
  const duAssigns: Assignment[] = [
    {
      id: 'du-a1',
      taskId: duTask.id,
      slotId: 'du-s1',
      participantId: duP.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const duResult = validateHardConstraints([duTask], [duP], duAssigns);
  const hasDateViolation = duResult.violations.some((v) => v.code === 'AVAILABILITY_VIOLATION');
  assert(hasDateViolation, 'HC-3: dateUnavailability produces AVAILABILITY_VIOLATION in validateHardConstraints');

  // Participant available on a different day (Monday=1) → should be eligible
  const monTask: Task = {
    ...duTask,
    id: 'du-t2',
    timeBlock: createTimeBlockFromHours(new Date(2026, 1, 16), 6, 14), // Monday Feb 16
  };
  const tMap2 = new Map([[monTask.id, monTask]]);
  const monAvail: Participant = {
    ...duP,
    id: 'du-p2',
    availability: [{ start: new Date(2026, 1, 16, 0, 0), end: new Date(2026, 1, 17, 12, 0) }],
  };
  const eligMon = isEligible(monAvail, monTask, monTask.slots[0], [], tMap2);
  assert(eligMon === true, 'HC-3: dateUnavailability on Sunday does not block Monday');

  // Partial-day unavailability: unavailable Sunday 10:00–14:00
  const partialP: Participant = {
    ...duP,
    id: 'du-p3',
    dateUnavailability: [{ id: 'du-u2', dayOfWeek: 0, startHour: 10, endHour: 14, allDay: false }],
  };
  // Task 06:00–14:00 overlaps with 10:00–14:00 → blocked
  const eligPartialOverlap = isEligible(partialP, duTask, duTask.slots[0], [], tMap);
  assert(eligPartialOverlap === false, 'HC-3: partial-day unavailability blocks overlapping task');

  // Task 06:00–10:00 does NOT overlap with 10:00–14:00 (endpoint-exclusive) → eligible
  const earlyTask: Task = {
    ...duTask,
    id: 'du-t3',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 10),
  };
  const tMap3 = new Map([[earlyTask.id, earlyTask]]);
  const eligEarly = isEligible(partialP, earlyTask, earlyTask.slots[0], [], tMap3);
  assert(eligEarly === true, 'HC-3: task ending at unavailability start is not blocked');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SC-2: computeNotWithPenalty (togetherness constraint)
// ═══════════════════════════════════════════════════════════════════════════════

import { computeNotWithPenalty } from './constraints/soft-constraints';

console.log('\n── SC-2: computeNotWithPenalty ──────────');

{
  // Two participants who should NOT be together, assigned to same task with togethernessRelevant
  const nwTask: Task = {
    id: 'nw-t1',
    name: 'NotWith Task',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 2,
    slots: [
      { slotId: 'nw-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      { slotId: 'nw-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    togethernessRelevant: true,
  };
  const nwAssigns: Assignment[] = [
    {
      id: 'nw-a1',
      taskId: nwTask.id,
      slotId: 'nw-s1',
      participantId: 'nw-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'nw-a2',
      taskId: nwTask.id,
      slotId: 'nw-s2',
      participantId: 'nw-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const taskMap = new Map([[nwTask.id, nwTask]]);
  const assignsByTask = new Map([[nwTask.id, nwAssigns]]);
  const notWithPairs = new Map([['nw-p1', new Set(['nw-p2'])]]);
  const nwCfg = { ...DEFAULT_CONFIG, notWithPenalty: 100 };

  const pen = computeNotWithPenalty(nwAssigns, nwCfg, taskMap, assignsByTask, notWithPairs);
  assert(pen === 100, 'SC-2: notWith pair in same togetherness task → penalty 100');

  // Same pair but task is NOT togethernessRelevant → 0 penalty
  const nwTask2: Task = { ...nwTask, id: 'nw-t2', togethernessRelevant: false };
  const taskMap2 = new Map([[nwTask2.id, nwTask2]]);
  const nwAssigns2 = nwAssigns.map((a) => ({ ...a, taskId: nwTask2.id }));
  const assignsByTask2 = new Map([[nwTask2.id, nwAssigns2]]);
  const pen2 = computeNotWithPenalty(nwAssigns2, nwCfg, taskMap2, assignsByTask2, notWithPairs);
  assert(pen2 === 0, 'SC-2: notWith pair in non-togetherness task → 0 penalty');

  // No notWith pairs → 0 penalty regardless
  const emptyPairs = new Map<string, Set<string>>();
  const pen3 = computeNotWithPenalty(nwAssigns, nwCfg, taskMap, assignsByTask, emptyPairs);
  assert(pen3 === 0, 'SC-2: no notWith pairs → 0 penalty');

  // notWithPenalty disabled (0) → 0 penalty
  const nwCfgOff = { ...DEFAULT_CONFIG, notWithPenalty: 0 };
  const pen4 = computeNotWithPenalty(nwAssigns, nwCfgOff, taskMap, assignsByTask, notWithPairs);
  assert(pen4 === 0, 'SC-2: notWithPenalty=0 → 0 penalty');
}

// ═══════════════════════════════════════════════════════════════════════════════
// getEligibleParticipantsForSlot (validator export)
// ═══════════════════════════════════════════════════════════════════════════════

import { getEligibleParticipantsForSlot } from './engine/validator';

console.log('\n── getEligibleParticipantsForSlot ───────');

{
  const eligTask = createHamamaTask(createTimeBlockFromHours(baseDate, 6, 18));
  const slot = eligTask.slots[0];
  const tasks = [eligTask];

  const pEligible: Participant = {
    id: 'ges-p1',
    name: 'Eligible',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pNoCert: Participant = {
    id: 'ges-p2',
    name: 'NoCert',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const pWrongLevel: Participant = {
    id: 'ges-p3',
    name: 'WrongLevel',
    level: Level.L3,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };

  // No existing assignments
  const eligible = getEligibleParticipantsForSlot(eligTask, slot.slotId, [pEligible, pNoCert, pWrongLevel], [], tasks);
  assert(eligible.length === 1, 'getEligible: only 1 of 3 participants eligible for Hamama slot');
  assert(eligible[0].id === 'ges-p1', 'getEligible: correct participant returned');

  // With existing overlapping assignment → eligible participant filtered out
  const overlapTask = createShemeshTask(createTimeBlockFromHours(baseDate, 8, 14));
  const tasksWithOverlap = [eligTask, overlapTask];
  const existingAssign: Assignment[] = [
    {
      id: 'ges-a1',
      taskId: overlapTask.id,
      slotId: overlapTask.slots[0].slotId,
      participantId: 'ges-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const eligible2 = getEligibleParticipantsForSlot(
    eligTask,
    slot.slotId,
    [pEligible, pNoCert],
    existingAssign,
    tasksWithOverlap,
  );
  assert(eligible2.length === 0, 'getEligible: overlapping assignment filters out eligible participant');
}

// ═══════════════════════════════════════════════════════════════════════════════
// dailyWorkloadImbalance (per-day std-dev)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── dailyWorkloadImbalance ───────────────');

{
  const day1 = new Date(2026, 1, 15);
  const day2 = new Date(2026, 1, 16);
  // Person assigned heavy on day 1 (8h) but nothing on day 2
  const t1 = createShemeshTask(createTimeBlockFromHours(day1, 6, 14)); // 8h day 1
  const t2 = createShemeshTask(createTimeBlockFromHours(day2, 6, 14)); // 8h day 2

  const p1: Participant = {
    id: 'dwl-p1',
    name: 'DWL1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'dwl-p2',
    name: 'DWL2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail,
    dateUnavailability: [],
  };

  // Balanced: p1 on day1, p2 on day2
  const balAssigns: Assignment[] = [
    {
      id: 'dwl-a1',
      taskId: t1.id,
      slotId: t1.slots[0].slotId,
      participantId: 'dwl-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'dwl-a2',
      taskId: t2.id,
      slotId: t2.slots[0].slotId,
      participantId: 'dwl-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const balResult = dailyWorkloadImbalance([p1, p2], balAssigns, [t1, t2]);
  assert(balResult.dailyPerParticipantStdDev >= 0, 'dailyImbalance: balanced → per-participant stdDev >= 0');

  // Both tasks assigned to same person → unbalanced across days for that person
  const imbAssigns: Assignment[] = [
    {
      id: 'dwl-a3',
      taskId: t1.id,
      slotId: t1.slots[0].slotId,
      participantId: 'dwl-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'dwl-a4',
      taskId: t2.id,
      slotId: t2.slots[0].slotId,
      participantId: 'dwl-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];
  const imbResult = dailyWorkloadImbalance([p1, p2], imbAssigns, [t1, t2]);
  // p1: 8h on each day (balanced per day), but p2: 0h both days
  // The global std-dev should reflect that days have different loads from different participants
  assert(imbResult.dailyGlobalStdDev >= 0, 'dailyImbalance: imbalanced → globalStdDev >= 0');

  // Single day → no daily imbalance possible
  const singleDay = dailyWorkloadImbalance([p1], balAssigns.slice(0, 1), [t1]);
  assert(singleDay.dailyPerParticipantStdDev === 0, 'dailyImbalance: single day → per-participant stdDev = 0');
  assert(singleDay.dailyGlobalStdDev === 0, 'dailyImbalance: single day → global stdDev = 0');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phantom Context (buildPhantomContext, mergePhantomRules)
// ═══════════════════════════════════════════════════════════════════════════════

import { buildPhantomContext, mergePhantomRules } from './engine/phantom';
import type { ContinuitySnapshot } from './models/continuity-schema';

console.log('\n── Phantom Context ─────────────────────');

{
  // Build a valid ContinuitySnapshot with 2 participants, one matching the new schedule
  const snapshot: ContinuitySnapshot = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex: 1,
    dayWindow: { start: '2026-02-15T05:00:00', end: '2026-02-16T05:00:00' },
    participants: [
      {
        name: 'Alice',
        level: 0,
        certifications: ['Nitzan'],
        group: 'A',
        assignments: [
          {
            sourceName: 'חממה',
            taskName: 'חממה D1',
            timeBlock: { start: '2026-02-15T06:00:00', end: '2026-02-15T14:00:00' },
            blocksConsecutive: true,
            isLight: false,
            baseLoadWeight: 1,
            restRuleId: 'rest-A',
            restRuleDurationHours: 5,
          },
          {
            sourceName: 'ממטרה',
            taskName: 'ממטרה D1',
            timeBlock: { start: '2026-02-15T20:00:00', end: '2026-02-16T04:00:00' },
            blocksConsecutive: true,
            isLight: false,
            baseLoadWeight: 1,
            restRuleId: 'rest-A',
            restRuleDurationHours: 5,
          },
        ],
      },
      {
        name: 'UnknownPerson',
        level: 0,
        certifications: [],
        group: 'B',
        assignments: [
          {
            sourceName: 'x',
            taskName: 'x',
            timeBlock: { start: '2026-02-15T06:00:00', end: '2026-02-15T14:00:00' },
            blocksConsecutive: false,
            isLight: true,
            baseLoadWeight: 0.3,
          },
        ],
      },
    ],
  };

  const newParticipants: Participant[] = [
    {
      id: 'ph-alice',
      name: 'Alice',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
    {
      id: 'ph-bob',
      name: 'Bob',
      level: Level.L0,
      certifications: ['Nitzan'],
      group: 'A',
      availability: dayAvail,
      dateUnavailability: [],
    },
  ];

  const ctx = buildPhantomContext(snapshot, newParticipants);

  // Only Alice matches → 2 phantom tasks (her 2 assignments); UnknownPerson ignored
  assert(ctx.phantomTasks.length === 2, 'phantom: matched participant produces phantom tasks');
  assert(ctx.phantomAssignments.length === 2, 'phantom: one phantom assignment per phantom task');
  assert(ctx.phantomTaskIds.size === 2, 'phantom: phantomTaskIds tracks all phantom tasks');

  // Phantom assignments link to new participant ID
  assert(
    ctx.phantomAssignments.every((a) => a.participantId === 'ph-alice'),
    'phantom: assignments map to matched participant ID',
  );

  // Rest rules: both assignments have restRuleId='rest-A' → only 1 unique rule stored
  assert(ctx.phantomRestRules.size === 1, 'phantom: duplicate restRuleId stored only once');
  assert(ctx.phantomRestRules.get('rest-A') === 5 * 3600000, 'phantom: rest rule duration converted to ms');

  // Phantom task fields
  const pTask = ctx.phantomTasks[0];
  assert(pTask.requiredCount === 0, 'phantom: phantom tasks have requiredCount=0');
  assert(pTask.slots.length === 0, 'phantom: phantom tasks have empty slots');
  assert(pTask.blocksConsecutive === true, 'phantom: blocksConsecutive propagated from snapshot');

  // Empty snapshot → empty context
  const emptySnap: ContinuitySnapshot = {
    schemaVersion: 1,
    exportedAt: '',
    dayIndex: 1,
    dayWindow: { start: '', end: '' },
    participants: [],
  };
  const emptyCtx = buildPhantomContext(emptySnap, newParticipants);
  assert(emptyCtx.phantomTasks.length === 0, 'phantom: empty snapshot → empty context');
}

// mergePhantomRules
{
  const base = new Map<string, number>([['rule-1', 10000]]);
  const phantomRules = new Map<string, number>([
    ['rule-1', 99999],
    ['rule-2', 20000],
  ]);
  const ctx = {
    phantomTasks: [],
    phantomAssignments: [],
    phantomTaskIds: new Set<string>(),
    phantomRestRules: phantomRules,
  };

  const merged = mergePhantomRules(base, ctx);
  assert(merged.get('rule-1') === 10000, 'mergePhantom: base rules take precedence');
  assert(merged.get('rule-2') === 20000, 'mergePhantom: phantom rules fill gaps');
  assert(merged.size === 2, 'mergePhantom: merged map has all unique rules');

  // Empty phantom rules → returns same base map reference
  const emptyPh = {
    phantomTasks: [],
    phantomAssignments: [],
    phantomTaskIds: new Set<string>(),
    phantomRestRules: new Map<string, number>(),
  };
  const same = mergePhantomRules(base, emptyPh);
  assert(same === base, 'mergePhantom: empty phantom → returns same base map');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rescue Plans (generateRescuePlans)
// ═══════════════════════════════════════════════════════════════════════════════

import { generateRescuePlans } from './engine/rescue';
import type { RescueRequest, ScheduleScore } from './models/types';

console.log('\n── Rescue Plans ────────────────────────');

{
  // Set up a future anchor so tasks are modifiable
  const rescueBase = new Date(2026, 5, 1); // June 1, 2026
  const anchor = new Date(2026, 4, 30); // anchor in the past → tasks are future
  const rescueBlock = createTimeBlockFromHours(rescueBase, 6, 14);
  const rescueBlock2 = createTimeBlockFromHours(rescueBase, 18, 22); // non-overlapping

  // Task with 2 slots (L0, Nitzan)
  const rTask: Task = {
    id: 'rsc-t1',
    name: 'Rescue Task',
    timeBlock: rescueBlock,
    requiredCount: 2,
    slots: [
      { slotId: 'rsc-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'A' },
      { slotId: 'rsc-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'B' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  // Second task (for testing depth-2 chains)
  const rTask2: Task = {
    id: 'rsc-t2',
    name: 'Other Task',
    timeBlock: rescueBlock2,
    requiredCount: 1,
    slots: [
      { slotId: 'rsc-s3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'C' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  const rescueAvail = [{ start: new Date(2026, 4, 29), end: new Date(2026, 5, 3) }];
  const rP1: Participant = {
    id: 'rsc-p1',
    name: 'R1',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: rescueAvail,
    dateUnavailability: [],
  };
  const rP2: Participant = {
    id: 'rsc-p2',
    name: 'R2',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: rescueAvail,
    dateUnavailability: [],
  };
  const rP3: Participant = {
    id: 'rsc-p3',
    name: 'R3',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: rescueAvail,
    dateUnavailability: [],
  };

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
  };

  // Current assignments: p1→slot1, p2→slot2
  const rAssigns: Assignment[] = [
    {
      id: 'rsc-a1',
      taskId: 'rsc-t1',
      slotId: 'rsc-s1',
      participantId: 'rsc-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'rsc-a2',
      taskId: 'rsc-t1',
      slotId: 'rsc-s2',
      participantId: 'rsc-p2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'rsc-a3',
      taskId: 'rsc-t2',
      slotId: 'rsc-s3',
      participantId: 'rsc-p3',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];

  const schedule: Schedule = {
    id: 'rsc-sched',
    tasks: [rTask, rTask2],
    participants: [rP1, rP2, rP3],
    assignments: rAssigns,
    feasible: true,
    score: dummyScore,
    violations: [],
    generatedAt: new Date(),
  };

  // Vacate p1's slot → p3 is the only eligible replacement (p2 already in the task → HC-7)
  const request: RescueRequest = {
    vacatedAssignmentId: 'rsc-a1',
    taskId: 'rsc-t1',
    slotId: 'rsc-s1',
    vacatedBy: 'rsc-p1',
  };

  const result = generateRescuePlans(schedule, request, anchor);
  assert(result.plans.length > 0, 'rescue: generates at least one plan for valid vacancy');
  assert(result.page === 0, 'rescue: default page is 0');

  // Depth-1 plan should have exactly 1 swap
  const depth1Plan = result.plans.find((p) => p.swaps.length === 1);
  assert(depth1Plan !== undefined, 'rescue: produces a depth-1 (single swap) plan');
  assert(
    depth1Plan!.swaps[0].toParticipantId === 'rsc-p3',
    'rescue: depth-1 replaces with the only eligible participant',
  );

  // Plans are sorted by impactScore ascending
  if (result.plans.length >= 2) {
    assert(result.plans[0].impactScore <= result.plans[1].impactScore, 'rescue: plans sorted by impactScore ascending');
  }

  // Vacated assignment not found → empty plans
  const badRequest: RescueRequest = {
    vacatedAssignmentId: 'nonexistent',
    taskId: 'rsc-t1',
    slotId: 'rsc-s1',
    vacatedBy: 'rsc-p1',
  };
  const emptyResult = generateRescuePlans(schedule, badRequest, anchor);
  assert(emptyResult.plans.length === 0, 'rescue: nonexistent assignment → empty plans');

  // Task in the past → empty plans
  const futureAnchor = new Date(2026, 6, 1); // anchor AFTER task
  const pastResult = generateRescuePlans(schedule, request, futureAnchor);
  assert(pastResult.plans.length === 0, 'rescue: past task → empty plans');

  // No eligible participants → empty plans
  const noEligSched: Schedule = {
    ...schedule,
    // p1 vacated, p2 already in task (HC-7), p3 lacks cert
    participants: [rP1, rP2, { ...rP3, certifications: [] }],
  };
  const noEligResult = generateRescuePlans(noEligSched, request, anchor);
  assert(noEligResult.plans.length === 0, 'rescue: no eligible participants → empty plans');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Optimizer (greedyAssign, optimize — invariant-based)
// ═══════════════════════════════════════════════════════════════════════════════

import { greedyAssign, optimize, optimizeMultiAttempt } from './engine/optimizer';
import type { SchedulerConfig } from './models/types';

console.log('\n── Optimizer ───────────────────────────');

{
  // ── Shared test fixtures ──

  const optBase = new Date(2026, 3, 1); // April 1, 2026
  const optWindow = [{ start: new Date(2026, 2, 31), end: new Date(2026, 3, 3) }];
  const fastConfig: SchedulerConfig = { ...DEFAULT_CONFIG, maxIterations: 500, maxSolverTimeMs: 2000 };

  // Simple non-overlapping tasks
  const optBlock1 = createTimeBlockFromHours(optBase, 6, 14); // 06:00–14:00
  const optBlock2 = createTimeBlockFromHours(optBase, 14, 22); // 14:00–22:00

  const optT1: Task = {
    id: 'opt-t1',
    name: 'T1',
    timeBlock: optBlock1,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'A' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const optT2: Task = {
    id: 'opt-t2',
    name: 'T2',
    timeBlock: optBlock2,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'B' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };

  const mkParticipant = (id: string, name: string, level: Level, certs: string[], group: string): Participant => ({
    id,
    name,
    level,
    certifications: certs,
    group,
    availability: optWindow,
    dateUnavailability: [],
  });

  const optP1 = mkParticipant('opt-p1', 'P1', Level.L0, ['Nitzan'], 'A');
  const optP2 = mkParticipant('opt-p2', 'P2', Level.L0, ['Nitzan'], 'A');
  const optP3 = mkParticipant('opt-p3', 'P3', Level.L0, ['Nitzan'], 'A');

  // ── greedyAssign: basic feasibility ──

  const greedy = greedyAssign([optT1, optT2], [optP1, optP2, optP3]);
  assert(greedy.unfilledSlots.length === 0, 'greedy: all slots filled with sufficient participants');
  assert(greedy.assignments.length === 2, 'greedy: one assignment per slot');

  // ── greedyAssign: HC-7 no duplicate per task ──

  const multiSlotTask: Task = {
    id: 'opt-ms',
    name: 'MultiSlot',
    timeBlock: optBlock1,
    requiredCount: 2,
    slots: [
      { slotId: 'opt-ms-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'X' },
      { slotId: 'opt-ms-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'Y' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const msGreedy = greedyAssign([multiSlotTask], [optP1, optP2, optP3]);
  const msTaskAssigns = msGreedy.assignments.filter((a) => a.taskId === 'opt-ms');
  const msParticipants = msTaskAssigns.map((a) => a.participantId);
  assert(
    new Set(msParticipants).size === msParticipants.length,
    'greedy: HC-7 no participant appears twice in same task',
  );

  // ── greedyAssign: HC-5 no double-booking ──

  const overlapBlock = createTimeBlockFromHours(optBase, 10, 18); // overlaps with optBlock1
  const overlapTask: Task = {
    id: 'opt-ol',
    name: 'Overlap',
    timeBlock: overlapBlock,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-ol-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'Z' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const olGreedy = greedyAssign([optT1, overlapTask], [optP1, optP2]);
  // Both tasks should be filled (2 participants, 2 non-overlapping-for-each tasks)
  assert(olGreedy.unfilledSlots.length === 0, 'greedy: HC-5 can fill overlapping tasks with distinct participants');
  // No participant should be in both overlapping tasks
  const t1Pid = olGreedy.assignments.find((a) => a.taskId === 'opt-t1')?.participantId;
  const olPid = olGreedy.assignments.find((a) => a.taskId === 'opt-ol')?.participantId;
  assert(t1Pid !== olPid, 'greedy: HC-5 no participant double-booked in overlapping tasks');

  // ── greedyAssign: certification gating (HC-2) ──

  const certTask: Task = {
    id: 'opt-cert',
    name: 'CertTask',
    timeBlock: optBlock2,
    requiredCount: 1,
    slots: [
      {
        slotId: 'opt-cert-s1',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Hamama'],
        label: 'H',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  // Only Nitzan-certified participants → can't fill Hamama slot
  const certGreedy = greedyAssign([certTask], [optP1, optP2]);
  assert(certGreedy.unfilledSlots.length === 1, 'greedy: HC-2 unfills slot when no participant has required cert');

  // ── greedyAssign: level gating (HC-1) ──

  const l2Task: Task = {
    id: 'opt-l2',
    name: 'L2Task',
    timeBlock: optBlock1,
    requiredCount: 1,
    slots: [{ slotId: 'opt-l2-s1', acceptableLevels: [{ level: Level.L2 }], requiredCertifications: [], label: 'L' }],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const l2Greedy = greedyAssign([l2Task], [optP1, optP2]); // only L0 participants
  assert(l2Greedy.unfilledSlots.length === 1, 'greedy: HC-1 unfills slot when no participant has required level');

  // ── greedyAssign: same-group integrity (HC-4) ──

  const sgTask: Task = {
    id: 'opt-sg',
    name: 'SGTask',
    timeBlock: optBlock1,
    requiredCount: 2,
    slots: [
      { slotId: 'opt-sg-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: '1' },
      { slotId: 'opt-sg-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: '2' },
    ],
    isLight: false,
    sameGroupRequired: true,
    blocksConsecutive: true,
  };
  const sgPa = mkParticipant('opt-sg-a1', 'SGA1', Level.L0, [], 'Alpha');
  const sgPa2 = mkParticipant('opt-sg-a2', 'SGA2', Level.L0, [], 'Alpha');
  const sgPb = mkParticipant('opt-sg-b1', 'SGB1', Level.L0, [], 'Beta');
  const sgGreedy = greedyAssign([sgTask], [sgPa, sgPa2, sgPb]);
  const sgAssigned = sgGreedy.assignments.filter((a) => a.taskId === 'opt-sg');
  if (sgAssigned.length === 2) {
    const groups = sgAssigned.map((a) => [sgPa, sgPa2, sgPb].find((p) => p.id === a.participantId)!.group);
    assert(new Set(groups).size === 1, 'greedy: HC-4 same-group task assigns from one group only');
  } else {
    assert(false, 'greedy: HC-4 same-group task should fill both slots');
  }

  // ── greedyAssign: locked assignments preserved ──

  const locked: Assignment[] = [
    {
      id: 'opt-lock1',
      taskId: 'opt-t1',
      slotId: 'opt-s1',
      participantId: 'opt-p1',
      status: AssignmentStatus.Locked,
      updatedAt: new Date(),
    },
  ];
  const lockGreedy = greedyAssign([optT1, optT2], [optP1, optP2, optP3], locked);
  const lockKept = lockGreedy.assignments.find((a) => a.id === 'opt-lock1');
  assert(lockKept !== undefined, 'greedy: locked assignment present in output');
  assert(lockKept!.participantId === 'opt-p1', 'greedy: locked assignment participant unchanged');
  assert(lockKept!.slotId === 'opt-s1', 'greedy: locked assignment slot unchanged');

  // ── optimize: constraint closure ──

  console.log('\n── Optimizer: optimize() ────────────────');

  const optResult = optimize([optT1, optT2], [optP1, optP2, optP3], fastConfig);
  assert(optResult.feasible === true, 'optimize: feasible with sufficient participants');
  assert(optResult.unfilledSlots.length === 0, 'optimize: no unfilled slots');

  // Re-validate output against hard constraints (THE key invariant)
  const reValidation = validateHardConstraints([optT1, optT2], [optP1, optP2, optP3], optResult.assignments);
  assert(reValidation.valid === true, 'optimize: output passes independent hard constraint re-validation');

  // Verify no double-booking in output
  const optByParticipant = new Map<string, Task[]>();
  for (const a of optResult.assignments) {
    const task = [optT1, optT2].find((t) => t.id === a.taskId)!;
    const list = optByParticipant.get(a.participantId) || [];
    list.push(task);
    optByParticipant.set(a.participantId, list);
  }
  let noOverlap = true;
  for (const [, tasks] of optByParticipant) {
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        if (blocksOverlap(tasks[i].timeBlock, tasks[j].timeBlock)) noOverlap = false;
      }
    }
  }
  assert(noOverlap, 'optimize: HC-5 no participant double-booked in output');

  // Score fields populated
  assert(typeof optResult.score.compositeScore === 'number', 'optimize: compositeScore is a number');
  assert(typeof optResult.score.totalPenalty === 'number', 'optimize: totalPenalty is a number');
  assert(optResult.durationMs >= 0, 'optimize: durationMs is non-negative');

  // ── optimize: infeasible scenario ──

  const infeasible = optimize(
    [optT1, { ...optT1, id: 'opt-t1-dup', slots: [{ ...optT1.slots[0], slotId: 'opt-dup-s1' }] }],
    [optP1], // 1 participant, 2 overlapping tasks
    fastConfig,
  );
  assert(infeasible.feasible === false, 'optimize: infeasible when 1 participant cannot fill overlapping tasks');
  assert(infeasible.unfilledSlots.length > 0, 'optimize: reports unfilled slots on infeasible input');

  // ── optimize: empty input ──

  const emptyOpt = optimize([], [], fastConfig);
  assert(emptyOpt.feasible === true, 'optimize: empty input is trivially feasible');
  assert(emptyOpt.assignments.length === 0, 'optimize: empty input produces no assignments');

  // ── optimize: locked preservation through full pipeline ──

  const optLocked: Assignment[] = [
    {
      id: 'opt-pipe-lock',
      taskId: 'opt-t1',
      slotId: 'opt-s1',
      participantId: 'opt-p1',
      status: AssignmentStatus.Locked,
      updatedAt: new Date(),
    },
  ];
  const lockResult = optimize([optT1, optT2], [optP1, optP2, optP3], fastConfig, optLocked);
  const pipeLockedFound = lockResult.assignments.find((a) => a.id === 'opt-pipe-lock');
  assert(pipeLockedFound !== undefined, 'optimize: locked assignment survives full pipeline');
  assert(pipeLockedFound!.participantId === 'opt-p1', 'optimize: locked assignment participant not reassigned');

  // ── optimize: score consistency (re-scoring produces same result) ──

  const rescored = computeScheduleScore([optT1, optT2], [optP1, optP2, optP3], optResult.assignments, fastConfig);
  assert(
    Math.abs(rescored.compositeScore - optResult.score.compositeScore) < 0.01,
    'optimize: re-scoring output produces same compositeScore',
  );

  // ── optimize: feasibility definition ──

  // feasible === true means both: no HC violations AND no unfilled slots
  if (optResult.feasible) {
    const fVal = validateHardConstraints([optT1, optT2], [optP1, optP2, optP3], optResult.assignments);
    assert(
      fVal.valid === true && optResult.unfilledSlots.length === 0,
      'optimize: feasible=true ⟺ no HC violations AND zero unfilled',
    );
  }

  // ── optimize: multi-attempt is at least as good as single ──

  console.log('\n── Optimizer: multi-attempt ─────────────');

  const multiResult = optimizeMultiAttempt([optT1, optT2], [optP1, optP2, optP3], fastConfig, [], 3);
  assert(multiResult.feasible === true, 'multiAttempt: feasible on solvable input');
  assert(
    multiResult.unfilledSlots.length <= optResult.unfilledSlots.length,
    'multiAttempt: unfilled slots ≤ single attempt',
  );
  assert(multiResult.actualAttempts >= 1, 'multiAttempt: ran at least 1 attempt');

  // Re-validate multi-attempt output
  const multiVal = validateHardConstraints([optT1, optT2], [optP1, optP2, optP3], multiResult.assignments);
  assert(multiVal.valid === true, 'multiAttempt: output passes hard constraint re-validation');

  // ── optimize: certification-gated slot with mixed participants ──

  const hamamaP = mkParticipant('opt-ham', 'HamP', Level.L0, ['Nitzan', 'Hamama'], 'A');
  const hTask: Task = {
    id: 'opt-ht',
    name: 'HT',
    timeBlock: optBlock1,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-ht-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Hamama'], label: 'H' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const hResult = optimize([hTask], [optP1, hamamaP], fastConfig); // p1 has no Hamama
  assert(hResult.feasible === true, 'optimize: fills cert-gated slot with certified participant');
  const hAssign = hResult.assignments.find((a) => a.taskId === 'opt-ht');
  assert(hAssign?.participantId === 'opt-ham', 'optimize: cert-gated slot assigned to only eligible participant');

  // ── optimize: HC-12 consecutive blocking enforced ──

  const consBlock1 = createTimeBlockFromHours(optBase, 6, 14);
  const consBlock2 = createTimeBlockFromHours(optBase, 14, 22); // back-to-back
  const consT1: Task = {
    id: 'opt-cons1',
    name: 'Cons1',
    timeBlock: consBlock1,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-cons1-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'C1' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const consT2: Task = {
    id: 'opt-cons2',
    name: 'Cons2',
    timeBlock: consBlock2,
    requiredCount: 1,
    slots: [
      { slotId: 'opt-cons2-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'C2' },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
  const consP1 = mkParticipant('opt-cons-p1', 'CP1', Level.L0, [], 'A');
  const consP2 = mkParticipant('opt-cons-p2', 'CP2', Level.L0, [], 'A');
  const consResult = optimize([consT1, consT2], [consP1, consP2], fastConfig);
  // With 2 participants and 2 back-to-back blocking tasks, each gets one
  assert(consResult.feasible === true, 'optimize: HC-12 solvable with enough participants');
  const consReVal = validateHardConstraints([consT1, consT2], [consP1, consP2], consResult.assignments);
  assert(consReVal.valid === true, 'optimize: HC-12 output passes re-validation');
  // The two tasks should be assigned to different participants
  const cons1Pid = consResult.assignments.find((a) => a.taskId === 'opt-cons1')?.participantId;
  const cons2Pid = consResult.assignments.find((a) => a.taskId === 'opt-cons2')?.participantId;
  assert(cons1Pid !== cons2Pid, 'optimize: HC-12 assigns back-to-back blocking tasks to different participants');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Swap Picker support: previewSwap / previewSwapChain / getCandidatesWithEligibility
// ═══════════════════════════════════════════════════════════════════════════════

import { getCandidatesWithEligibility } from './engine/validator';

console.log('\n── engine.previewSwap / previewSwapChain ───');

{
  // Build a tiny schedule: 2 Shemesh slots, 4 eligible L0 participants.
  const swapEngine = new SchedulingEngine({ maxIterations: 100, maxSolverTimeMs: 1000 });
  const dayAvail2: TimeBlock[] = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];
  const mkP = (id: string): Participant => ({
    id,
    name: id,
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail2,
    dateUnavailability: [],
  });
  const swapPs = [mkP('sw-p1'), mkP('sw-p2'), mkP('sw-p3'), mkP('sw-p4')];
  swapEngine.addParticipants(swapPs);
  swapEngine.addTask(createShemeshTask(createTimeBlockFromHours(new Date(2026, 1, 15), 6, 14)));
  const swapSchedule = swapEngine.generateSchedule();

  assert(swapSchedule.assignments.length >= 2, 'preview setup: schedule has assignments');

  const firstA = swapSchedule.assignments[0];
  const outgoingPid = firstA.participantId;
  const outgoingStatus = firstA.status;
  const outgoingUpdatedAt = firstA.updatedAt;
  const freeP = swapPs.find((p) => !swapSchedule.assignments.some((a) => a.participantId === p.id));
  assert(freeP !== undefined, 'preview setup: at least one unassigned participant');

  // 1) Valid preview: swap out → free participant → must leave engine untouched
  if (freeP) {
    const validPreview = swapEngine.previewSwap({ assignmentId: firstA.id, newParticipantId: freeP.id });
    assert(validPreview.valid === true, 'previewSwap: valid swap reports valid=true');
    assert(
      validPreview.simulatedAssignments.some((a) => a.id === firstA.id && a.participantId === freeP.id),
      'previewSwap: simulatedAssignments reflects post-swap state',
    );
    assert(validPreview.affectedParticipantIds.includes(outgoingPid), 'previewSwap: outgoing pid in affected');
    assert(validPreview.affectedParticipantIds.includes(freeP.id), 'previewSwap: incoming pid in affected');

    // Engine-side assignment object must be fully rolled back
    const liveFirstA = swapEngine.getSchedule()?.assignments.find((a) => a.id === firstA.id);
    assert(liveFirstA?.participantId === outgoingPid, 'previewSwap: participantId rolled back');
    assert(liveFirstA?.status === outgoingStatus, 'previewSwap: status rolled back');
    assert(
      liveFirstA?.updatedAt.getTime() === outgoingUpdatedAt.getTime(),
      'previewSwap: updatedAt rolled back to exact original timestamp',
    );
  }

  // 2) Invalid preview (nonexistent participant) still rolls back
  const invalidPreview = swapEngine.previewSwap({ assignmentId: firstA.id, newParticipantId: 'does-not-exist' });
  assert(invalidPreview.valid === false, 'previewSwap: unknown participant → invalid');
  const liveFirstA2 = swapEngine.getSchedule()?.assignments.find((a) => a.id === firstA.id);
  assert(liveFirstA2?.participantId === outgoingPid, 'previewSwap: rollback on invalid request');
  assert(
    liveFirstA2?.updatedAt.getTime() === outgoingUpdatedAt.getTime(),
    'previewSwap: updatedAt preserved on invalid request',
  );

  // 3) previewSwapChain: circular two-assignment swap (A↔B)
  if (swapSchedule.assignments.length >= 2) {
    const [aOne, aTwo] = swapSchedule.assignments;
    const chainPreview = swapEngine.previewSwapChain([
      { assignmentId: aOne.id, newParticipantId: aTwo.participantId },
      { assignmentId: aTwo.id, newParticipantId: aOne.participantId },
    ]);
    assert(chainPreview.valid === true, 'previewSwapChain: circular A↔B swap is valid');
    // Post-chain state in snapshot: the two assignments should have swapped participants
    const simA1 = chainPreview.simulatedAssignments.find((a) => a.id === aOne.id);
    const simA2 = chainPreview.simulatedAssignments.find((a) => a.id === aTwo.id);
    assert(
      simA1?.participantId === aTwo.participantId && simA2?.participantId === aOne.participantId,
      'previewSwapChain: simulated state shows swapped participants',
    );
    // Engine state unchanged
    const liveA1 = swapEngine.getSchedule()?.assignments.find((a) => a.id === aOne.id);
    const liveA2 = swapEngine.getSchedule()?.assignments.find((a) => a.id === aTwo.id);
    assert(
      liveA1?.participantId === aOne.participantId && liveA2?.participantId === aTwo.participantId,
      'previewSwapChain: engine state byte-identical after preview',
    );
  }
}

console.log('\n── getCandidatesWithEligibility ────────');

{
  // Pool of 4 participants, varying cert/level. Use the same Hamama task shape
  // (requires Hamama cert, L0 or L4-lowPriority).
  const candTask = createHamamaTask(createTimeBlockFromHours(new Date(2026, 1, 15), 6, 14));
  const candSlot = candTask.slots[0];
  const dayAvail3: TimeBlock[] = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];

  const pGood: Participant = {
    id: 'cand-good',
    name: 'Good',
    level: Level.L0,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail3,
    dateUnavailability: [],
  };
  const pNoCert: Participant = {
    id: 'cand-nocert',
    name: 'NoCert',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvail3,
    dateUnavailability: [],
  };
  const pWrongLevel: Participant = {
    id: 'cand-wronglevel',
    name: 'WrongLevel',
    level: Level.L3,
    certifications: ['Hamama', 'Nitzan'],
    group: 'A',
    availability: dayAvail3,
    dateUnavailability: [],
  };

  const pool = [pGood, pNoCert, pWrongLevel];
  const candidates = getCandidatesWithEligibility(candTask, candSlot.slotId, pool, [], [candTask]);

  assert(candidates.length === 3, 'getCandidatesWithEligibility: one entry per participant');
  assert(
    candidates.every((c) => (c.eligible ? c.rejectionCode === null : c.rejectionCode !== null)),
    'getCandidatesWithEligibility: eligible ⇔ rejectionCode === null',
  );

  // Parity with getEligibleParticipantsForSlot for the eligible subset
  const eligibleSubset = candidates
    .filter((c) => c.eligible)
    .map((c) => c.participant.id)
    .sort();
  const eligibleParity = getEligibleParticipantsForSlot(candTask, candSlot.slotId, pool, [], [candTask])
    .map((p) => p.id)
    .sort();
  assert(
    JSON.stringify(eligibleSubset) === JSON.stringify(eligibleParity),
    'getCandidatesWithEligibility: eligible subset matches getEligibleParticipantsForSlot',
  );

  // Ineligibles come with a Hebrew reason string
  const rejects = candidates.filter((c) => !c.eligible);
  assert(rejects.length === 2, 'getCandidatesWithEligibility: 2 ineligible');
  assert(
    rejects.every((c) => typeof c.reason === 'string' && c.reason.length > 0),
    'getCandidatesWithEligibility: rejection reasons populated',
  );
}

// Regression: swap-picker Bug 1 — a participant already sitting in a DIFFERENT
// slot of the same task must be flagged ineligible for this slot (HC-5/HC-7),
// otherwise previewSwap downstream returns invalid and the picker surfaces
// unusable candidates. Earlier logic excluded the whole task from a
// participant's assignment set, masking these collisions.
{
  const regTask = createShemeshTask(createTimeBlockFromHours(new Date(2026, 1, 15), 6, 14));
  const [slotA, slotB] = regTask.slots;
  const dayAvailReg: TimeBlock[] = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];
  const pAlreadyIn: Participant = {
    id: 'reg-already-in',
    name: 'AlreadyIn',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvailReg,
    dateUnavailability: [],
  };
  const pFree: Participant = {
    id: 'reg-free',
    name: 'Free',
    level: Level.L0,
    certifications: ['Nitzan'],
    group: 'A',
    availability: dayAvailReg,
    dateUnavailability: [],
  };
  // pAlreadyIn is currently assigned to slotA of the same task.
  const existing: Assignment[] = [
    {
      id: 'reg-a-1',
      taskId: regTask.id,
      slotId: slotA.slotId,
      participantId: pAlreadyIn.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(2026, 1, 15, 6, 0),
    },
  ];

  // Query candidates for slotB. pAlreadyIn must NOT be eligible because
  // accepting slotB would put them in two slots of the same task (HC-7) and
  // double-book them at an overlapping time (HC-5).
  const regCandidates = getCandidatesWithEligibility(regTask, slotB.slotId, [pAlreadyIn, pFree], existing, [regTask]);
  const alreadyInEntry = regCandidates.find((c) => c.participant.id === pAlreadyIn.id);
  const freeEntry = regCandidates.find((c) => c.participant.id === pFree.id);

  assert(alreadyInEntry !== undefined, 'Bug1 regression: candidate list includes already-in participant');
  assert(
    alreadyInEntry?.eligible === false,
    'Bug1 regression: participant in another slot of same task is ineligible',
  );
  assert(
    alreadyInEntry?.rejectionCode === 'HC-5' || alreadyInEntry?.rejectionCode === 'HC-7',
    'Bug1 regression: rejection code is HC-5 (double-book) or HC-7 (duplicate-in-task)',
  );
  assert(freeEntry?.eligible === true, 'Bug1 regression: truly free participant remains eligible');

  // And the filtered variant agrees.
  const regEligible = getEligibleParticipantsForSlot(regTask, slotB.slotId, [pAlreadyIn, pFree], existing, [regTask]);
  assert(
    regEligible.length === 1 && regEligible[0].id === pFree.id,
    'Bug1 regression: getEligibleParticipantsForSlot excludes the already-in participant',
  );
}

// ─── Async test blocks + Summary ─────────────────────────────────────────────

(async () => {
  await runParticipantSetXlsxTests(assert);

  console.log('\n══════════════════════════════════════════');
  console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log('══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
})();
