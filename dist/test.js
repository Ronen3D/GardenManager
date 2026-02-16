"use strict";
/**
 * Test Runner — Validates core engine functionality.
 *
 * Usage: npm test
 */
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("./index");
const validator_1 = require("./engine/validator");
const rest_calculator_1 = require("./utils/rest-calculator");
let passed = 0;
let failed = 0;
function assert(condition, name) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    }
    else {
        failed++;
        console.log(`  ✗ FAIL: ${name}`);
    }
}
// ─── Time Utilities Tests ────────────────────────────────────────────────────
console.log('\n── Time Utilities ──────────────────────');
// Test midnight crossing
const midnightBlock = (0, index_1.createTimeBlock)(new Date(2026, 1, 15, 21, 0), new Date(2026, 1, 15, 5, 0));
assert(midnightBlock.end > midnightBlock.start, 'Midnight crossing auto-adjusts end date');
assert((0, index_1.blockDurationHours)(midnightBlock) === 8, 'Midnight block duration = 8h');
// Test timeblock from hours
const block1 = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 9, 17);
assert((0, index_1.blockDurationHours)(block1) === 8, 'createTimeBlockFromHours: 9-17 = 8h');
const block2 = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 22, 6);
assert((0, index_1.blockDurationHours)(block2) === 8, 'createTimeBlockFromHours: 22-06 midnight crossing = 8h');
// Test overlap
const blockA = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 6, 14);
const blockB = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 10, 18);
const blockC = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 14, 22);
assert((0, index_1.blocksOverlap)(blockA, blockB) === true, 'Overlapping blocks detected');
assert((0, index_1.blocksOverlap)(blockA, blockC) === false, 'Adjacent blocks do not overlap');
// Test gap
assert((0, index_1.gapHours)(blockA, blockC) === 0, 'Gap between adjacent blocks = 0');
const blockD = (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 20, 4);
assert((0, index_1.gapHours)(blockC, blockD) === 0, 'No gap for consecutive/adjacent blocks');
// Test availability coverage
const fullDayAvail = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 0, 0) }];
assert((0, index_1.isFullyCovered)(blockA, fullDayAvail) === true, 'Full day covers 6-14 task');
const partialAvail = [{ start: new Date(2026, 1, 15, 8, 0), end: new Date(2026, 1, 15, 12, 0) }];
assert((0, index_1.isFullyCovered)(blockA, partialAvail) === false, 'Partial availability does not cover 6-14 task');
// Test shift generation
const shifts = (0, index_1.generateShiftBlocks)(new Date(2026, 1, 15, 6, 0), 8, 3);
assert(shifts.length === 3, 'Generate 3 shifts');
assert((0, index_1.blockDurationHours)(shifts[0]) === 8, 'Each shift is 8h');
assert(shifts[2].end.getHours() === 6, 'Third shift ends at 06:00');
// Test merge blocks
const overlapping = [
    (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 6, 10),
    (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 8, 14),
    (0, index_1.createTimeBlockFromHours)(new Date(2026, 1, 15), 18, 22),
];
const merged = (0, index_1.mergeBlocks)(overlapping);
assert(merged.length === 2, 'Merge overlapping blocks: 3 → 2');
assert((0, index_1.blockDurationHours)(merged[0]) === 8, 'Merged block 6-14 = 8h');
// ─── Hard Constraint Tests ───────────────────────────────────────────────────
console.log('\n── Hard Constraints ────────────────────');
const baseDate = new Date(2026, 1, 15);
const dayAvail = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];
const testP0 = {
    id: 'tp0', name: 'TestP0', level: index_1.Level.L0,
    certifications: [index_1.Certification.Nitzan, index_1.Certification.Hamama],
    group: 'TestGroup', availability: dayAvail,
};
const testP0b = {
    id: 'tp0b', name: 'TestP0b', level: index_1.Level.L0,
    certifications: [index_1.Certification.Nitzan],
    group: 'TestGroup', availability: dayAvail,
};
// Hamama task — requires Hamama cert
const hamamaBlock = (0, index_1.createTimeBlockFromHours)(baseDate, 6, 18);
const hamamaTask = (0, index_1.createHamamaTask)(hamamaBlock);
// Test: valid assignment
const validAssignment = [{
        id: 'va1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    }];
const result1 = (0, index_1.validateHardConstraints)([hamamaTask], [testP0, testP0b], validAssignment);
assert(result1.valid === true, 'Valid Hamama assignment passes hard constraints');
// Test: missing certification
const badAssignment = [{
        id: 'ba1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
        participantId: testP0b.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    }];
const result2 = (0, index_1.validateHardConstraints)([hamamaTask], [testP0, testP0b], badAssignment);
assert(result2.valid === false, 'Missing Hamama cert triggers violation');
assert(result2.violations.some((v) => v.code === 'CERT_MISSING'), 'Violation code = CERT_MISSING');
// Test: level mismatch — Shemesh needs Nitzan, but also test level requirements
const testP3 = {
    id: 'tp3', name: 'TestP3', level: index_1.Level.L3,
    certifications: [index_1.Certification.Nitzan],
    group: 'TestGroup', availability: dayAvail,
};
const shemeshBlock = (0, index_1.createTimeBlockFromHours)(baseDate, 10, 14);
const shemeshTask = (0, index_1.createShemeshTask)(shemeshBlock);
const shemeshAssignment = [
    {
        id: 'sa1', taskId: shemeshTask.id, slotId: shemeshTask.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
    {
        id: 'sa2', taskId: shemeshTask.id, slotId: shemeshTask.slots[1].slotId,
        participantId: testP3.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
];
const result3 = (0, index_1.validateHardConstraints)([shemeshTask], [testP0, testP0b, testP3], shemeshAssignment);
assert(result3.valid === true, 'Valid Shemesh assignment with Nitzan-certified participants');
// Test: double-booking
const taskA2 = (0, index_1.createHamamaTask)(hamamaBlock);
const doubleBooking = [
    {
        id: 'db1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
    {
        id: 'db2', taskId: taskA2.id, slotId: taskA2.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
];
const result4 = (0, index_1.validateHardConstraints)([hamamaTask, taskA2], [testP0, testP0b, testP3], doubleBooking);
assert(result4.valid === false, 'Double-booking detected');
assert(result4.violations.some((v) => v.code === 'DOUBLE_BOOKING'), 'Violation code = DOUBLE_BOOKING');
// ─── Soft Constraint Tests ───────────────────────────────────────────────────
console.log('\n── Soft Constraints ────────────────────');
const testP4 = {
    id: 'tp4', name: 'TestP4', level: index_1.Level.L4,
    certifications: [index_1.Certification.Hamama],
    group: 'TestGroup', availability: dayAvail,
};
// Hamama L4 penalty
const l4HamamaAssignment = [{
        id: 'lh1', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
        participantId: testP4.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    }];
const score1 = (0, index_1.computeScheduleScore)([hamamaTask], [testP0, testP4], l4HamamaAssignment, index_1.DEFAULT_CONFIG);
assert(score1.totalPenalty > 0, 'L4 Hamama assignment incurs penalty');
assert(score1.totalPenalty >= index_1.DEFAULT_CONFIG.hamamaL4Penalty, 'Penalty >= hamamaL4Penalty config');
// L0 Hamama — should have 0 hamama penalty (only workload-based penalty possible)
const l0HamamaAssignment = [{
        id: 'lh2', taskId: hamamaTask.id, slotId: hamamaTask.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    }];
const score2 = (0, index_1.computeScheduleScore)([hamamaTask], [testP0, testP4], l0HamamaAssignment, index_1.DEFAULT_CONFIG);
assert(score2.totalPenalty < score1.totalPenalty, 'L0 Hamama has less penalty than L4');
// ─── Rest Calculator Tests ───────────────────────────────────────────────────
console.log('\n── Rest Calculator ─────────────────────');
const restTask1 = (0, index_1.createShemeshTask)((0, index_1.createTimeBlockFromHours)(baseDate, 6, 10));
const restTask2 = (0, index_1.createShemeshTask)((0, index_1.createTimeBlockFromHours)(baseDate, 14, 18));
const restAssignments = [
    {
        id: 'ra1', taskId: restTask1.id, slotId: restTask1.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
    {
        id: 'ra2', taskId: restTask2.id, slotId: restTask2.slots[0].slotId,
        participantId: testP0.id, status: index_1.AssignmentStatus.Scheduled, updatedAt: new Date(),
    },
];
const restProfile = (0, rest_calculator_1.computeParticipantRest)(testP0.id, restAssignments, [restTask1, restTask2]);
assert(restProfile.restGaps.length === 1, 'One rest gap between two tasks');
assert(restProfile.minRestHours === 4, 'Rest gap = 4h (10:00-14:00)');
assert(restProfile.nonLightAssignmentCount === 2, 'Two non-light assignments counted');
// ─── Validator Tests ─────────────────────────────────────────────────────────
console.log('\n── Validator ───────────────────────────');
const fullResult = (0, validator_1.fullValidate)([hamamaTask], [testP0, testP0b], validAssignment);
assert(fullResult.valid === true, 'fullValidate: valid schedule');
assert(fullResult.summary.includes('valid'), 'Summary mentions valid');
// Preview swap
const swapPreview = (0, validator_1.previewSwap)([hamamaTask], [testP0, testP0b], validAssignment, { assignmentId: 'va1', newParticipantId: testP0b.id });
assert(swapPreview.valid === false, 'Preview swap: missing cert detected');
// ─── Full Engine Integration Test ────────────────────────────────────────────
console.log('\n── Full Engine Integration ─────────────');
const engine = new index_1.SchedulingEngine({ maxIterations: 500, maxSolverTimeMs: 5000 });
// Create minimal scenario
const dayWindow = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 16, 12, 0) }];
const participants = [];
// 10 L0 participants
for (let i = 0; i < 10; i++) {
    participants.push({
        id: `p${i}`,
        name: `Person-${i}`,
        level: index_1.Level.L0,
        certifications: [index_1.Certification.Nitzan, index_1.Certification.Hamama, index_1.Certification.Salsala],
        group: 'TeamA',
        availability: dayWindow,
    });
}
// Add L1, L2, L3, L4
participants.push({
    id: 'pl1', name: 'Commander-L1', level: index_1.Level.L1,
    certifications: [index_1.Certification.Nitzan], group: 'TeamA', availability: dayWindow,
});
participants.push({
    id: 'pl2', name: 'Commander-L2', level: index_1.Level.L2,
    certifications: [index_1.Certification.Nitzan], group: 'TeamA', availability: dayWindow,
});
participants.push({
    id: 'pl3', name: 'Commander-L3', level: index_1.Level.L3,
    certifications: [index_1.Certification.Nitzan, index_1.Certification.Hamama], group: 'TeamA', availability: dayWindow,
});
participants.push({
    id: 'pl4', name: 'Commander-L4', level: index_1.Level.L4,
    certifications: [index_1.Certification.Hamama], group: 'TeamA', availability: dayWindow,
});
engine.addParticipants(participants);
// Create a few tasks manually (not a full day, to keep it manageable)
const tb1 = (0, index_1.createTimeBlockFromHours)(baseDate, 6, 18);
const tb2 = (0, index_1.createTimeBlockFromHours)(baseDate, 6, 10);
engine.addTask((0, index_1.createHamamaTask)(tb1));
engine.addTask((0, index_1.createShemeshTask)(tb2));
engine.addTask((0, index_1.createArugaTask)({ start: new Date(2026, 1, 15, 6, 0), end: new Date(2026, 1, 15, 7, 30) }, 'Aruga Morning'));
const schedule = engine.generateSchedule();
assert(schedule.assignments.length > 0, 'Engine generates assignments');
const engineStats = engine.getStats();
assert(engineStats.totalTasks === 3, 'Stats: 3 tasks');
assert(engineStats.totalParticipants === 14, 'Stats: 14 participants');
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
// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log(`  Tests: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('══════════════════════════════════════════\n');
if (failed > 0) {
    process.exit(1);
}
//# sourceMappingURL=test.js.map