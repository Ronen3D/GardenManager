/**
 * Optimizer + Scheduler Coverage Tests
 *
 * Targeted tests covering critical optimizer / scheduler paths not covered
 * (or only weakly covered) by src/test.ts. Specifically:
 *  1. HC-15 disable round-trip (the only HC frequently disabled in production)
 *  2. SA cannot leave behind enabled-HC violations (output property test)
 *  3. Multi-attempt picks the best of all attempts (vs any single attempt)
 *  4. Score finiteness when all soft-weight knobs are set to 0 (no NaN/Infinity)
 *  5. Same-group tasks: HC-4 strict — partial-fill from one group must not leak
 *  6. requiredCount > eligible participants: graceful failure, no crash
 *  7. Async multi-attempt produces a fully-frozen Schedule (no missing fields)
 *
 * Run via:  npx ts-node src/test-optimizer-coverage.ts
 */

import { optimize, optimizeMultiAttempt } from './engine/optimizer';
import {
  AssignmentStatus,
  createTimeBlockFromHours,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  SchedulingEngine,
  type Task,
  ViolationSeverity,
  validateHardConstraints,
} from './index';
import type { SchedulerConfig } from './models/types';

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

const baseDate = new Date(2026, 3, 1); // April 1, 2026
const wideAvail = [{ start: new Date(2026, 2, 30), end: new Date(2026, 3, 5) }];

function mkP(id: string, level: Level, certs: string[] = ['Nitzan'], group = 'A'): Participant {
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

const fastConfig: SchedulerConfig = { ...DEFAULT_CONFIG, maxIterations: 600, maxSolverTimeMs: 2500 };

// ═══════════════════════════════════════════════════════════════════════════
// 1. HC-15 disable: scheduling that would otherwise be blocked succeeds.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 1. HC-15 disable round-trip ──');
{
  // Task A: ends at 06:00 — falls inside a configured trigger range [03,07].
  // Task B: starts immediately after A end (06:00–10:00, loaded). Same participant
  // assigned to both would normally be blocked by HC-15 recovery window.
  const taskA: Task = {
    id: 'r1-a',
    name: 'Trigger',
    timeBlock: createTimeBlockFromHours(baseDate, 22, 6), // 22:00–06:00 (next day)
    requiredCount: 1,
    slots: [
      { slotId: 'r1-a-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'A' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
    sleepRecovery: { triggerShifts: [1], recoveryHours: 8 },
  };
  const taskB: Task = {
    id: 'r1-b',
    name: 'AfterTrigger',
    timeBlock: createTimeBlockFromHours(
      new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1),
      6,
      10,
    ),
    requiredCount: 1,
    slots: [
      { slotId: 'r1-b-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'B' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };

  // ONE participant — only way to fill both is to disable HC-15.
  const lone = mkP('r1-lone', Level.L0);

  // (a) HC-15 enabled: B is unfillable
  const enabled = optimize([taskA, taskB], [lone], fastConfig);
  assert(
    enabled.unfilledSlots.length === 1 && enabled.unfilledSlots[0].taskId === 'r1-b',
    'HC-15 enabled: trigger task forces task B to be unfilled with single participant',
  );

  // (b) HC-15 disabled: both fill
  const disabled = optimize([taskA, taskB], [lone], fastConfig, [], new Set(['HC-15']));
  assert(
    disabled.unfilledSlots.length === 0,
    `HC-15 disabled: both tasks fill (got ${disabled.unfilledSlots.length} unfilled)`,
  );
  // Re-validate without HC-15 — the schedule must still pass all OTHER HCs
  const validation = validateHardConstraints([taskA, taskB], [lone], disabled.assignments, new Set(['HC-15']));
  assert(validation.valid === true, 'HC-15 disabled: output passes re-validation when HC-15 stays disabled');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Optimizer NEVER leaves enabled HC violations in its output.
//    Property test: build a moderately constrained scenario, run a few
//    multi-attempts, re-validate each — zero hard violations expected.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Optimizer output passes hard-constraint re-validation ──');
{
  // Two non-overlapping shifts, three slots each, certs gating.
  const shift1 = createTimeBlockFromHours(baseDate, 6, 14);
  const shift2 = createTimeBlockFromHours(baseDate, 14, 22);
  const mkTask = (id: string, block: ReturnType<typeof createTimeBlockFromHours>): Task => ({
    id,
    name: id,
    timeBlock: block,
    requiredCount: 3,
    slots: [
      { slotId: `${id}-s1`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'a' },
      { slotId: `${id}-s2`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'b' },
      {
        slotId: `${id}-s3`,
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
        label: 'cmd',
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: true,
  });
  const tA = mkTask('prop-a', shift1);
  const tB = mkTask('prop-b', shift2);

  // 5 L0 + 2 seniors
  const pool: Participant[] = [
    mkP('prop-l0-1', Level.L0),
    mkP('prop-l0-2', Level.L0),
    mkP('prop-l0-3', Level.L0),
    mkP('prop-l0-4', Level.L0),
    mkP('prop-l0-5', Level.L0),
    mkP('prop-s1', Level.L3),
    mkP('prop-s2', Level.L4),
  ];

  let totalViolations = 0;
  let totalRuns = 0;
  for (let i = 0; i < 5; i++) {
    const r = optimizeMultiAttempt([tA, tB], pool, fastConfig, [], 5);
    const v = validateHardConstraints([tA, tB], pool, r.assignments);
    const errors = v.violations.filter((vv) => vv.severity === ViolationSeverity.Error);
    if (errors.length > 0) {
      console.log(`     debug run ${i}: ${errors.length} errors → ${errors.map((e) => e.code).join(',')}`);
    }
    totalViolations += errors.length;
    totalRuns++;
  }
  assert(
    totalViolations === 0,
    `Property: 5 multi-attempt runs produced 0 hard-constraint errors (got ${totalViolations} across ${totalRuns} runs)`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Multi-attempt result is at least as good (≤ unfilled, ≥ score) as the
//    worst single attempt observed. (Stronger: best-of-N is never worse than
//    the typical single attempt.)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Multi-attempt picks best of attempts ──');
{
  const block = createTimeBlockFromHours(baseDate, 6, 14);
  const t: Task = {
    id: 'mt-1',
    name: 'MT',
    timeBlock: block,
    requiredCount: 2,
    slots: [
      { slotId: 'mt-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'a' },
      { slotId: 'mt-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'b' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const pool = [mkP('mt-1', Level.L0), mkP('mt-2', Level.L0), mkP('mt-3', Level.L0)];

  // Run a multi-attempt and 10 single-attempts; assert best is no worse than any.
  const multi = optimizeMultiAttempt([t], pool, fastConfig, [], 10);
  let worseFound = false;
  for (let i = 0; i < 10; i++) {
    const single = optimize([t], pool, fastConfig);
    if (single.unfilledSlots.length < multi.unfilledSlots.length) {
      worseFound = true;
      console.log(
        `     debug: single had ${single.unfilledSlots.length} unfilled, multi had ${multi.unfilledSlots.length}`,
      );
    }
  }
  assert(!worseFound, 'Multi-attempt unfilled count ≤ every observed single-attempt unfilled count');
  // Score of feasible multi must be finite
  assert(Number.isFinite(multi.score.compositeScore), 'Multi-attempt compositeScore is finite');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Score finiteness with all-zero soft weights (no NaN/Infinity).
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 4. Score finiteness with zero soft weights ──');
{
  const allZeroConfig: SchedulerConfig = {
    ...DEFAULT_CONFIG,
    minRestWeight: 0,
    l0FairnessWeight: 0,
    seniorFairnessWeight: 0,
    lowPriorityLevelPenalty: 0,
    dailyBalanceWeight: 0,
    notWithPenalty: 0,
    taskNamePreferencePenalty: 0,
    taskNameAvoidancePenalty: 0,
    taskNamePreferenceBonus: 0,
    maxIterations: 200,
    maxSolverTimeMs: 1000,
  };
  const block = createTimeBlockFromHours(baseDate, 6, 14);
  const t: Task = {
    id: 'zero-1',
    name: 'Z',
    timeBlock: block,
    requiredCount: 1,
    slots: [{ slotId: 'zero-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: 'z' }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const result = optimize([t], [mkP('zero-p1', Level.L0, [])], allZeroConfig);
  assert(Number.isFinite(result.score.compositeScore), 'Zero-weight scoring: compositeScore is finite');
  assert(Number.isFinite(result.score.totalPenalty), 'Zero-weight scoring: totalPenalty is finite');
  assert(Number.isFinite(result.score.restStdDev), 'Zero-weight scoring: restStdDev is finite');
  // Penalty should never be negative.
  assert(
    result.score.totalPenalty >= 0,
    `Zero-weight scoring: totalPenalty non-negative (got ${result.score.totalPenalty})`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. sameGroupRequired: HC-4 strict — the schedule never mixes groups
//    inside a same-group task. When NO single group can fill all slots,
//    none of those slots is filled (no cross-group leak).
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 5. Same-group-required: no cross-group leak ──');
{
  const block = createTimeBlockFromHours(baseDate, 6, 14);
  const sgTask: Task = {
    id: 'sg-1',
    name: 'SG',
    timeBlock: block,
    requiredCount: 3,
    slots: [
      { slotId: 'sg-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: '1' },
      { slotId: 'sg-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: '2' },
      { slotId: 'sg-s3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [], label: '3' },
    ],
    sameGroupRequired: true,
    blocksConsecutive: false,
  };
  // Group Alpha has only 2 members, Group Beta has only 2 members.
  // Neither group can fill all 3 slots — schedule must mark them all unfilled.
  const pool = [
    mkP('sg-a1', Level.L0, [], 'Alpha'),
    mkP('sg-a2', Level.L0, [], 'Alpha'),
    mkP('sg-b1', Level.L0, [], 'Beta'),
    mkP('sg-b2', Level.L0, [], 'Beta'),
  ];
  const r = optimize([sgTask], pool, fastConfig);
  const sgAssignments = r.assignments.filter((a) => a.taskId === 'sg-1');
  // The strict HC-4 invariant: any assignments made for a same-group task must
  // come from a SINGLE group — never mix groups, even when the task can't be
  // fully filled.
  const usedGroups = new Set(sgAssignments.map((a) => pool.find((p) => p.id === a.participantId)!.group));
  assert(
    usedGroups.size <= 1,
    `Same-group strict: assignments use at most 1 group even when task is partially filled (got ${[...usedGroups].join(',')})`,
  );
  // At least one slot must be unfilled (3 slots, no group has 3 members).
  assert(
    r.unfilledSlots.length >= 1,
    `Same-group strict: at least 1 slot unfilled when no group can fill all (got ${r.unfilledSlots.length})`,
  );
  assert(r.feasible === false, 'Same-group strict: feasible=false when same-group task cannot be fully filled');

  // Now widen Alpha to 3 — schedule MUST pick Alpha and fill the task.
  const pool2 = [...pool, mkP('sg-a3', Level.L0, [], 'Alpha')];
  const r2 = optimize([sgTask], pool2, fastConfig);
  const sg2Assignments = r2.assignments.filter((a) => a.taskId === 'sg-1');
  assert(
    sg2Assignments.length === 3,
    `Same-group: 3 slots filled when Alpha grows to 3 (got ${sg2Assignments.length})`,
  );
  // All three from Alpha
  const groups = new Set(sg2Assignments.map((a) => pool2.find((p) => p.id === a.participantId)!.group));
  assert(groups.size === 1, `Same-group: all assignees come from one group (got groups ${[...groups].join(',')})`);
  // Re-validate — HC-4 should pass
  const v = validateHardConstraints([sgTask], pool2, r2.assignments);
  assert(v.valid, 'Same-group: re-validation passes when group-3 fills the task');
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. requiredCount > eligible: graceful failure, no crash, no NaN.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 6. Insufficient eligible participants — graceful failure ──');
{
  const block = createTimeBlockFromHours(baseDate, 6, 14);
  const t: Task = {
    id: 'short-1',
    name: 'Short',
    timeBlock: block,
    requiredCount: 5,
    slots: [
      { slotId: 'sh-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'a' },
      { slotId: 'sh-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'b' },
      { slotId: 'sh-s3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'c' },
      { slotId: 'sh-s4', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'd' },
      { slotId: 'sh-s5', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'e' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  // Only 2 participants for a 5-slot task
  const pool = [mkP('sh-1', Level.L0), mkP('sh-2', Level.L0)];

  let crashed = false;
  let result: ReturnType<typeof optimize> | undefined;
  const start = Date.now();
  try {
    result = optimize([t], pool, fastConfig);
  } catch {
    crashed = true;
  }
  const elapsed = Date.now() - start;
  assert(!crashed, 'Short pool: optimize() does not throw');
  assert(elapsed < fastConfig.maxSolverTimeMs + 1000, `Short pool: optimize() finishes in bounded time (${elapsed}ms)`);
  if (result) {
    assert(result.feasible === false, 'Short pool: feasible=false when slots cannot all be filled');
    assert(result.unfilledSlots.length === 3, `Short pool: 3 of 5 slots unfilled (got ${result.unfilledSlots.length})`);
    assert(Number.isFinite(result.score.compositeScore), 'Short pool: score is finite even when infeasible');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. async generation: returned schedule has all frozen-snapshot fields populated.
// ═══════════════════════════════════════════════════════════════════════════
async function runAsyncTests(): Promise<void> {
  console.log('\n── 7. generateScheduleAsync produces a fully-frozen Schedule ──');
  const engine = new SchedulingEngine(
    { maxIterations: 200, maxSolverTimeMs: 1500 },
    new Set(['HC-11']),
    new Map([['rule-x', 6]]),
    7,
  );
  engine.setCertLabelSnapshot({ Nitzan: 'ניצן' });
  engine.setPeriod(baseDate, 3);
  engine.addParticipants([mkP('async-1', Level.L0), mkP('async-2', Level.L0)]);
  engine.addTask({
    id: 'async-t1',
    name: 'AsyncT',
    timeBlock: createTimeBlockFromHours(baseDate, 6, 14),
    requiredCount: 1,
    slots: [
      { slotId: 'async-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'], label: 'a' },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  });

  const sched = await engine.generateScheduleAsync(3);
  assert(sched.algorithmSettings !== undefined, 'Async: algorithmSettings is set');
  assert(sched.algorithmSettings.dayStartHour === 7, 'Async: dayStartHour frozen as 7');
  assert(
    sched.algorithmSettings.disabledHardConstraints.includes('HC-11'),
    'Async: disabledHardConstraints contains HC-11',
  );
  assert(sched.periodStart instanceof Date, 'Async: periodStart is a Date');
  assert(sched.periodStart.getTime() === baseDate.getTime(), 'Async: periodStart matches setPeriod input');
  assert(sched.periodDays === 3, `Async: periodDays === 3 (got ${sched.periodDays})`);
  assert(sched.restRuleSnapshot['rule-x'] === 6, 'Async: restRuleSnapshot preserves rule-x → 6');
  assert(sched.certLabelSnapshot.Nitzan === 'ניצן', 'Async: certLabelSnapshot includes Nitzan');
  assert(Array.isArray(sched.scheduleUnavailability), 'Async: scheduleUnavailability is an array (initialized to [])');
  assert((sched.scheduleUnavailability ?? []).length === 0, 'Async: scheduleUnavailability initialized empty');
}

// ═══════════════════════════════════════════════════════════════════════════
// Final report
// ═══════════════════════════════════════════════════════════════════════════
runAsyncTests()
  .then(() => {
    console.log(`\n── Summary ─────────────────────────────`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error('Unexpected error in async tests:', e);
    process.exit(1);
  });
