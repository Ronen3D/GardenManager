/**
 * TEST-AGENT-D: Shared utilities coverage tests.
 *
 * Targets logic in:
 *   - src/shared/utils/time-utils.ts
 *   - src/shared/utils/load-formula.ts
 *   - src/shared/utils/load-weighting.ts (lightly — most cases covered in src/test.ts)
 *   - src/shared/utils/rest-calculator.ts (op-day boundary gap — not covered in src/test.ts)
 *   - src/utils/date-utils.ts (operationalDateKey vs calendarDateKey divergence)
 *
 * Run: npx ts-node src/test-shared-utils-coverage.ts
 */

import {
  type Assignment,
  AssignmentStatus,
  type DateUnavailability,
  type LoadFormulaComponent,
  type Task,
  type TaskTemplate,
  type TimeBlock,
} from './models/types';
import { buildSnapshot, computeFormulaValue, normalizeTargetHours, rawFormulaSum } from './shared/utils/load-formula';
import { computeRestFromAssignments } from './shared/utils/rest-calculator';
import { hourInOpDay, isBlockedByDateUnavailability, type ScheduleContext } from './shared/utils/time-utils';
import { calendarDateKey, operationalDateKey } from './utils/date-utils';

// ─── Local assert ───────────────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
const _failures: string[] = [];
function assert(cond: any, msg: string): void {
  if (cond) {
    _passed++;
    console.log(`  PASS  ${msg}`);
  } else {
    _failed++;
    _failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

const BASE = new Date(2026, 1, 15); // Sun, Feb 15, 2026 — used as op-Day-1 base

function tb(start: Date, end: Date): TimeBlock {
  return { start, end };
}

function blockingTask(id: string, start: Date, end: Date): Task {
  return {
    id,
    name: id,
    timeBlock: tb(start, end),
    requiredCount: 1,
    slots: [
      {
        slotId: `${id}-s1`,
        acceptableLevels: [],
        requiredCertifications: [],
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: true,
    // baseLoadWeight defaults to 1 → load-bearing
  };
}

function assn(id: string, taskId: string, participantId: string): Assignment {
  return {
    id,
    taskId,
    slotId: `${taskId}-s1`,
    participantId,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. hourInOpDay — direct boundary tests
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── hourInOpDay: direct boundary tests ──────────────────');

{
  // baseDate = Feb 15 2026
  // dayStartHour=5, dayIndex=1 (op-Day-1 spans Feb 15 05:00 → Feb 16 05:00)
  // hour 10 (>= 5) → calendar day = base + (1-1) = Feb 15
  const r1 = new Date(hourInOpDay(BASE, 5, 1, 10));
  assert(
    r1.getFullYear() === 2026 && r1.getMonth() === 1 && r1.getDate() === 15 && r1.getHours() === 10,
    'hourInOpDay: dsh=5 dayIndex=1 hour=10 → Feb 15 10:00 (daytime portion of op-Day-1)',
  );

  // hour 3 (< 5) → POST-midnight tail → calendar day = base + 1 = Feb 16
  const r2 = new Date(hourInOpDay(BASE, 5, 1, 3));
  assert(
    r2.getFullYear() === 2026 && r2.getMonth() === 1 && r2.getDate() === 16 && r2.getHours() === 3,
    'hourInOpDay: dsh=5 dayIndex=1 hour=3 → Feb 16 03:00 (post-midnight tail of op-Day-1, NOT prev op-day)',
  );

  // hour 5 exactly == dayStartHour → daytime portion (>= comparison)
  const r3 = new Date(hourInOpDay(BASE, 5, 1, 5));
  assert(
    r3.getDate() === 15 && r3.getHours() === 5,
    'hourInOpDay: dsh=5 dayIndex=1 hour=5 → Feb 15 05:00 (op-day start, not tail)',
  );

  // hour 4 (just below) → tail
  const r4 = new Date(hourInOpDay(BASE, 5, 1, 4));
  assert(
    r4.getDate() === 16 && r4.getHours() === 4,
    'hourInOpDay: dsh=5 dayIndex=1 hour=4 → Feb 16 04:00 (tail, exactly one tick below boundary)',
  );

  // hour 23 with dsh=22 → daytime portion (23 >= 22) → base+0 = Feb 15
  const r5 = new Date(hourInOpDay(BASE, 22, 1, 23));
  assert(
    r5.getDate() === 15 && r5.getHours() === 23,
    'hourInOpDay: dsh=22 dayIndex=1 hour=23 → Feb 15 23:00 (op-day daytime is 22:00–23:59)',
  );

  // hour 0 with dsh=22 → tail → base+1 = Feb 16
  const r6 = new Date(hourInOpDay(BASE, 22, 1, 0));
  assert(
    r6.getDate() === 16 && r6.getHours() === 0,
    'hourInOpDay: dsh=22 dayIndex=1 hour=0 → Feb 16 00:00 (op-Day-1 tail starts at midnight)',
  );

  // dayStartHour=0 — every hour 0..23 is >= 0, so always on base+(idx-1), no tail
  const r7 = new Date(hourInOpDay(BASE, 0, 1, 0));
  assert(
    r7.getDate() === 15 && r7.getHours() === 0,
    'hourInOpDay: dsh=0 dayIndex=1 hour=0 → Feb 15 00:00 (no tail when dsh=0)',
  );
  const r8 = new Date(hourInOpDay(BASE, 0, 1, 23));
  assert(
    r8.getDate() === 15 && r8.getHours() === 23,
    'hourInOpDay: dsh=0 dayIndex=1 hour=23 → Feb 15 23:00 (no tail when dsh=0)',
  );

  // Day index > 1: dsh=5, dayIndex=3, hour=4 → tail of op-Day-3 → base+3 = Feb 18
  const r9 = new Date(hourInOpDay(BASE, 5, 3, 4));
  assert(
    r9.getDate() === 18 && r9.getHours() === 4,
    'hourInOpDay: dsh=5 dayIndex=3 hour=4 → Feb 18 04:00 (tail of op-Day-3, base+3)',
  );
  // dayIndex=3, hour=10 → daytime → base+(3-1) = Feb 17
  const r10 = new Date(hourInOpDay(BASE, 5, 3, 10));
  assert(
    r10.getDate() === 17 && r10.getHours() === 10,
    'hourInOpDay: dsh=5 dayIndex=3 hour=10 → Feb 17 10:00 (daytime, base+2)',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. operationalDateKey vs calendarDateKey divergence
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── operationalDateKey vs calendarDateKey ───────────────');

{
  // 02:00 on Feb 16 with dsh=5 → still op-day Feb 15 (tail)
  // calendarDateKey says Feb 16, operationalDateKey says Feb 15
  const tailTime = new Date(2026, 1, 16, 2, 0);
  const opKey = operationalDateKey(tailTime, 5);
  const calKey = calendarDateKey(tailTime);
  assert(opKey === '2026-02-15', `operationalDateKey: tail-time → op-day Feb 15 (got ${opKey})`);
  assert(calKey === '2026-02-16', `calendarDateKey: tail-time → cal Feb 16 (got ${calKey})`);
  assert(
    opKey !== calKey,
    'operationalDateKey and calendarDateKey diverge for tail-of-op-day timestamp (engine vs UI semantics)',
  );

  // 05:00 exactly: op-day key starts here → both = Feb 16 (no tail at exact boundary)
  const atBoundary = new Date(2026, 1, 16, 5, 0);
  assert(
    operationalDateKey(atBoundary, 5) === '2026-02-16',
    'operationalDateKey: timestamp exactly at dayStartHour belongs to its own op-day',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. isBlockedByDateUnavailability — endDayIndex < dayIndex (no-wrap rule)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── isBlockedByDateUnavailability: range edge cases ─────');

{
  const ctx7d: ScheduleContext = { baseDate: BASE, scheduleDays: 7, dayStartHour: 5 };

  // Rule with endDayIndex < dayIndex: malformed, must NOT block any task.
  // The doc says "Must be >= dayIndex (no wrap)", and the code has
  //   if (endIdx < startIdx) continue;
  const reversed: DateUnavailability[] = [
    { id: 'rev', dayIndex: 5, endDayIndex: 3, startHour: 0, endHour: 0, allDay: true },
  ];
  const taskOnDay4: TimeBlock = {
    start: new Date(2026, 1, 18, 10, 0), // op-Day-4 daytime
    end: new Date(2026, 1, 18, 14, 0),
  };
  assert(
    isBlockedByDateUnavailability(taskOnDay4, reversed, ctx7d) === false,
    'edge: endDayIndex < dayIndex → rule is silently dropped (no-wrap), does not block Day 4',
  );
  // And does not block Day 5 either (the supposed start)
  const taskOnDay5: TimeBlock = {
    start: new Date(2026, 1, 19, 10, 0),
    end: new Date(2026, 1, 19, 14, 0),
  };
  assert(
    isBlockedByDateUnavailability(taskOnDay5, reversed, ctx7d) === false,
    'edge: endDayIndex < dayIndex rule does not even fire on its own startDay',
  );

  // Rule with dayIndex == endDayIndex (explicit single-day) behaves the same as omitting endDayIndex
  const sameDay: DateUnavailability[] = [
    { id: 'sd', dayIndex: 3, endDayIndex: 3, startHour: 9, endHour: 12, allDay: false },
  ];
  const taskDay3InRange: TimeBlock = {
    start: new Date(2026, 1, 17, 10, 0),
    end: new Date(2026, 1, 17, 11, 0),
  };
  const taskDay3OutOfRange: TimeBlock = {
    start: new Date(2026, 1, 17, 13, 0),
    end: new Date(2026, 1, 17, 14, 0),
  };
  assert(
    isBlockedByDateUnavailability(taskDay3InRange, sameDay, ctx7d) === true,
    'edge: dayIndex == endDayIndex single-day partial rule blocks an overlapping task',
  );
  assert(
    isBlockedByDateUnavailability(taskDay3OutOfRange, sameDay, ctx7d) === false,
    'edge: dayIndex == endDayIndex single-day partial rule does not block a non-overlapping task',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Rest calculator: gap that crosses calendar midnight (op-day boundary)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── rest-calculator: op-day boundary gap ────────────────');

{
  // Two blocking tasks on the SAME op-day (dsh=5):
  //   Task A: Feb 15 21:00 → Feb 15 23:00 (2h, ends late evening)
  //   Task B: Feb 16 03:00 → Feb 16 05:00 (2h, starts in op-Day-1 tail)
  // Gap = 4 hours of wall-clock time, even though they straddle calendar midnight.
  // Rest calculator must compute this from raw timestamps, NOT bucket by calendar day.
  const tA = blockingTask('rcA', new Date(2026, 1, 15, 21, 0), new Date(2026, 1, 15, 23, 0));
  const tB = blockingTask('rcB', new Date(2026, 1, 16, 3, 0), new Date(2026, 1, 16, 5, 0));
  const taskMap = new Map<string, Task>([
    [tA.id, tA],
    [tB.id, tB],
  ]);
  const assigns: Assignment[] = [assn('rc-a1', tA.id, 'rc-p'), assn('rc-a2', tB.id, 'rc-p')];
  const profile = computeRestFromAssignments('rc-p', assigns, taskMap);
  assert(profile.restGaps.length === 1, 'rest: midnight-crossing pair produces exactly 1 rest gap');
  assert(
    Math.abs(profile.restGaps[0] - 4) < 1e-9,
    `rest: gap across calendar midnight = 4h wall-clock (got ${profile.restGaps[0]})`,
  );
  assert(
    Math.abs(profile.totalWorkHours - 4) < 1e-9,
    'rest: totalWorkHours = 2h + 2h = 4h regardless of calendar split',
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. load-formula: rawFormulaSum / computeFormulaValue / normalizeTargetHours
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── load-formula: basic + edge cases ────────────────────');

{
  // Set up two reference templates:
  //   tplBase: baseLoadWeight = 0.5, no windows
  //   tplWindow: baseLoadWeight = 0.2, hot window with id 'w1' weight=1.0
  const tplBase: TaskTemplate = {
    id: 'ref-base',
    name: 'RefBase',
    durationHours: 8,
    shiftsPerDay: 1,
    startHour: 6,
    sameGroupRequired: false,
    baseLoadWeight: 0.5,
    slots: [],
    subTeams: [],
    blocksConsecutive: true,
  };
  const tplWindow: TaskTemplate = {
    id: 'ref-win',
    name: 'RefWin',
    durationHours: 8,
    shiftsPerDay: 1,
    startHour: 6,
    sameGroupRequired: false,
    baseLoadWeight: 0.2,
    loadWindows: [{ id: 'w1', startHour: 10, startMinute: 0, endHour: 14, endMinute: 0, weight: 1.0 }],
    slots: [],
    subTeams: [],
    blocksConsecutive: true,
  };
  const templates = new Map<string, TaskTemplate>([
    [tplBase.id, tplBase],
    [tplWindow.id, tplWindow],
  ]);

  // (a) Empty components → rawFormulaSum=0, computeFormulaValue=0 (NOT NaN)
  const emptySnap = buildSnapshot([], templates);
  assert(rawFormulaSum([], emptySnap) === 0, 'load: empty components → rawFormulaSum = 0');
  const emptyVal = computeFormulaValue([], emptySnap);
  assert(emptyVal === 0, `load: empty components → computeFormulaValue = 0 not NaN (got ${emptyVal})`);
  assert(Number.isFinite(emptyVal), 'load: empty computeFormulaValue is finite (no division-by-zero NaN)');

  // (b) Single base component: 4 hours × 0.5 = 2.0 raw
  const comps1: LoadFormulaComponent[] = [{ refTemplateId: tplBase.id, refRate: { kind: 'base' }, hours: 4 }];
  const snap1 = buildSnapshot(comps1, templates);
  assert(snap1.length === 1 && !snap1[0].missing, 'load: snapshot built for valid base ref');
  assert(snap1[0].rate.value === 0.5, `load: snapshot value = base weight 0.5 (got ${snap1[0].rate.value})`);
  assert(rawFormulaSum(comps1, snap1) === 2.0, 'load: 4h × 0.5 = 2.0 raw');
  // Per-hour value = rhsRaw / targetHours (default 1) clamped to [0..1] → 2.0 → 1.0 (clamped)
  assert(computeFormulaValue(comps1, snap1) === 1.0, 'load: rhs 2.0 / 1h target → 1.0 (clamped from 2.0)');
  // With targetHours=4 → 2.0/4 = 0.5
  assert(Math.abs(computeFormulaValue(comps1, snap1, 4) - 0.5) < 1e-9, 'load: rhs 2.0 / 4h target → 0.5');

  // (c) Window component: 2h × 1.0 = 2.0 raw, with targetHours=2 → 1.0
  const comps2: LoadFormulaComponent[] = [
    { refTemplateId: tplWindow.id, refRate: { kind: 'window', windowId: 'w1' }, hours: 2 },
  ];
  const snap2 = buildSnapshot(comps2, templates);
  assert(
    snap2[0].rate.kind === 'window' && (snap2[0].rate as any).value === 1.0,
    'load: window snapshot resolves to window weight 1.0',
  );
  assert(rawFormulaSum(comps2, snap2) === 2.0, 'load: 2h × 1.0 (window) = 2.0 raw');

  // (d) lhsExtras subtraction: rhs - lhs / targetHours
  // rhs: 4h base (0.5) = 2.0
  // lhs: 1h window (1.0) = 1.0
  // (2.0 - 1.0) / 1 → 1.0
  const lhsExtras: LoadFormulaComponent[] = [
    { refTemplateId: tplWindow.id, refRate: { kind: 'window', windowId: 'w1' }, hours: 1 },
  ];
  const lhsSnap = buildSnapshot(lhsExtras, templates);
  const valWithLhs = computeFormulaValue(comps1, snap1, 1, lhsExtras, lhsSnap);
  assert(Math.abs(valWithLhs - 1.0) < 1e-9, `load: (rhs 2.0 − lhs 1.0) / 1h target → 1.0 (got ${valWithLhs})`);
  // With targetHours=2 → (2.0 − 1.0) / 2 = 0.5
  const valWithLhs2 = computeFormulaValue(comps1, snap1, 2, lhsExtras, lhsSnap);
  assert(Math.abs(valWithLhs2 - 0.5) < 1e-9, `load: (rhs 2.0 − lhs 1.0) / 2h target → 0.5 (got ${valWithLhs2})`);

  // (e) Result clamping: negative result clamps to 0 (not NaN, not negative)
  // rhs: 1h base (0.5) = 0.5
  // lhs: 4h window (1.0) = 4.0
  // (0.5 − 4.0) / 1 = −3.5 → clamps to 0
  const compsSmall: LoadFormulaComponent[] = [{ refTemplateId: tplBase.id, refRate: { kind: 'base' }, hours: 1 }];
  const snapSmall = buildSnapshot(compsSmall, templates);
  const lhsBig: LoadFormulaComponent[] = [
    { refTemplateId: tplWindow.id, refRate: { kind: 'window', windowId: 'w1' }, hours: 4 },
  ];
  const lhsBigSnap = buildSnapshot(lhsBig, templates);
  const negResult = computeFormulaValue(compsSmall, snapSmall, 1, lhsBig, lhsBigSnap);
  assert(negResult === 0, `load: negative-result formula clamps to 0 (got ${negResult})`);

  // (f) normalizeTargetHours: NaN/undefined/0/-3 → 1 ; positive → as-is
  assert(normalizeTargetHours(undefined) === 1, 'normalizeTargetHours: undefined → 1');
  assert(normalizeTargetHours(NaN) === 1, 'normalizeTargetHours: NaN → 1');
  assert(normalizeTargetHours(0) === 1, 'normalizeTargetHours: 0 → 1');
  assert(normalizeTargetHours(-3) === 1, 'normalizeTargetHours: negative → 1');
  assert(normalizeTargetHours(2.5) === 2.5, 'normalizeTargetHours: positive passes through');
  assert(
    normalizeTargetHours(Infinity) === 1,
    'normalizeTargetHours: Infinity is not finite → normalized to 1 (avoids div-by-Infinity → 0)',
  );

  // (g) Missing-template snapshot: rhs ignored in rawFormulaSum (no NaN contamination)
  const compsMissing: LoadFormulaComponent[] = [
    { refTemplateId: 'does-not-exist', refRate: { kind: 'base' }, hours: 5 },
    { refTemplateId: tplBase.id, refRate: { kind: 'base' }, hours: 2 },
  ];
  const snapMissing = buildSnapshot(compsMissing, templates);
  assert(snapMissing[0].missing === true, 'load: missing-template snapshot entry is flagged');
  // Sum should ignore missing entry: 2h × 0.5 = 1.0 (NOT 5×0 + 1.0 NaN-laced)
  const rawWithMissing = rawFormulaSum(compsMissing, snapMissing);
  assert(
    rawWithMissing === 1.0 && Number.isFinite(rawWithMissing),
    `load: missing-ref components are skipped without contaminating sum (got ${rawWithMissing})`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n──────────────────────────────────────────');
console.log(`Total: ${_passed + _failed}   Passed: ${_passed}   Failed: ${_failed}`);
if (_failed > 0) {
  console.log('\nFailures:');
  for (const f of _failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
