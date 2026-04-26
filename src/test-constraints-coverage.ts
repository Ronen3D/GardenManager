/**
 * Targeted constraint-coverage tests written by Agent B
 * (constraints lane: hard-constraints / soft-constraints / senior-policy /
 *  sleep-recovery, plus the validator constraint-evaluation glue).
 *
 * These tests fill gaps left open by `src/test.ts` — they do not duplicate
 * existing coverage. Run with: `npx ts-node src/test-constraints-coverage.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { computeLowPriorityLevelPenalty, isNaturalRole } from './constraints/senior-policy';
import { collectSoftWarnings, computeScheduleScore } from './constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  type ConstraintViolation,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Task,
  ViolationSeverity,
  validateHardConstraints,
} from './index';

// ─── Local assert helper (mirrors src/test.ts pattern) ───────────────────────

let passed = 0;
let failed = 0;
const failureMessages: string[] = [];

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS — ${msg}`);
  } else {
    failed++;
    failureMessages.push(msg);
    console.log(`  FAIL — ${msg}`);
  }
}

function section(label: string): void {
  console.log(`\n── ${label} ───────────`);
}

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const BASE_DATE = new Date(2026, 1, 15); // Sun Feb 15 2026
const wideAvail = [{ start: new Date(2026, 1, 15, 0, 0), end: new Date(2026, 1, 25, 0, 0) }];

function mkP(id: string, level: Level, certs: string[] = [], group = 'A'): Participant {
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

// ════════════════════════════════════════════════════════════════════════════
// T1: Disabled-HC gate — HC-15 must produce zero violations when disabled.
// ════════════════════════════════════════════════════════════════════════════
section('T1: HC-15 disabled-HC gate');
{
  // Trigger task ends at 02:00 inside the configured 22:00..06:00 range with
  // 5h recovery window. A second loaded task starts at 04:00 same op-day —
  // would normally fire HC-15, but with HC-15 disabled the validator must
  // emit zero SLEEP_RECOVERY_VIOLATION entries.
  const trigger: Task = {
    id: 't1-trig',
    name: 'trigger',
    timeBlock: { start: new Date(2026, 1, 15, 22, 0), end: new Date(2026, 1, 16, 2, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't1-trig-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
    sleepRecovery: { rangeStartHour: 22, rangeEndHour: 6, recoveryHours: 5 },
  };
  const loaded: Task = {
    id: 't1-loaded',
    name: 'loaded',
    timeBlock: { start: new Date(2026, 1, 16, 4, 0), end: new Date(2026, 1, 16, 8, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't1-loaded-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
  };
  const p = mkP('t1-p', Level.L0);
  const assigns: Assignment[] = [
    mkAssignment('t1-a1', trigger.id, 't1-trig-s', p.id),
    mkAssignment('t1-a2', loaded.id, 't1-loaded-s', p.id),
  ];

  // Sanity: HC-15 fires when not disabled.
  const baseline = validateHardConstraints([trigger, loaded], [p], assigns);
  assert(
    baseline.violations.some((v) => v.code === 'SLEEP_RECOVERY_VIOLATION'),
    'T1.a — HC-15 fires baseline (sanity check)',
  );

  // Gate: disable HC-15 — no SLEEP_RECOVERY_VIOLATION should appear.
  const gated = validateHardConstraints([trigger, loaded], [p], assigns, new Set(['HC-15']));
  assert(
    !gated.violations.some((v) => v.code === 'SLEEP_RECOVERY_VIOLATION'),
    'T1.b — disabledHC HC-15 suppresses SLEEP_RECOVERY_VIOLATION',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T2: Disabled HC-3 gate — extraUnavailability is also bypassed.
// ════════════════════════════════════════════════════════════════════════════
section('T2: HC-3 disabled gate also suppresses extraUnavailability');
{
  const p = mkP('t2-p', Level.L0);
  const task: Task = {
    id: 't2-t',
    name: 'task',
    timeBlock: { start: new Date(2026, 1, 16, 8, 0), end: new Date(2026, 1, 16, 12, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't2-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const a = mkAssignment('t2-a', task.id, 't2-s', p.id);
  const extra = [{ participantId: p.id, start: new Date(2026, 1, 16, 7, 0), end: new Date(2026, 1, 16, 13, 0) }];

  // Sanity: HC-3 fires from extraUnavailability when not disabled.
  const baseline = validateHardConstraints([task], [p], [a], undefined, undefined, undefined, extra);
  assert(
    baseline.violations.some((v) => v.code === 'AVAILABILITY_VIOLATION'),
    'T2.a — extraUnavailability fires HC-3 baseline (sanity)',
  );

  // Gate: HC-3 disabled — must suppress.
  const gated = validateHardConstraints([task], [p], [a], new Set(['HC-3']), undefined, undefined, extra);
  assert(
    !gated.violations.some((v) => v.code === 'AVAILABILITY_VIOLATION'),
    'T2.b — disabledHC HC-3 suppresses extraUnavailability layer',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T3: HC-15 recovery is wall-clock — not op-day-bounded.
//
// A trigger task ending at 04:00 (inside 22..06 range, but within the same
// op-day if dayStartHour=5) produces a recovery window from 04:00 to 09:00.
// A loaded task at 06:00 lives in the SAME op-day as the trigger (06:00 is
// past dayStartHour=5, so calendar-day-2 06:00 is op-day-2). Wall-clock
// semantics must still block it because the absolute time falls inside
// [04:00, 09:00).
// ════════════════════════════════════════════════════════════════════════════
section('T3: HC-15 recovery window is wall-clock');
{
  const p = mkP('t3-p', Level.L0);
  const trigger: Task = {
    id: 't3-trig',
    name: 'trigger',
    timeBlock: { start: new Date(2026, 1, 16, 0, 0), end: new Date(2026, 1, 16, 4, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't3-trig-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
    sleepRecovery: { rangeStartHour: 22, rangeEndHour: 6, recoveryHours: 5 },
  };
  const loaded: Task = {
    id: 't3-loaded',
    name: 'loaded',
    timeBlock: { start: new Date(2026, 1, 16, 6, 0), end: new Date(2026, 1, 16, 10, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't3-loaded-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
  };
  const assigns: Assignment[] = [
    mkAssignment('t3-a1', trigger.id, 't3-trig-s', p.id),
    mkAssignment('t3-a2', loaded.id, 't3-loaded-s', p.id),
  ];
  const r = validateHardConstraints([trigger, loaded], [p], assigns);
  assert(
    r.violations.some((v) => v.code === 'SLEEP_RECOVERY_VIOLATION'),
    'T3 — recovery [04:00..09:00) is wall-clock; loaded task at 06:00 (same op-day) is blocked',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T4: HC-15 — `isLight` (zero-load) candidate is allowed inside the window.
//
// Same as T3 but the second task has baseLoadWeight=0 (e.g., a meeting).
// The recovery rule only blocks tasks with effective load > 0 in the overlap.
// ════════════════════════════════════════════════════════════════════════════
section('T4: HC-15 allows zero-load task in recovery window');
{
  const p = mkP('t4-p', Level.L0);
  const trigger: Task = {
    id: 't4-trig',
    name: 'trigger',
    timeBlock: { start: new Date(2026, 1, 16, 0, 0), end: new Date(2026, 1, 16, 4, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't4-trig-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
    sleepRecovery: { rangeStartHour: 22, rangeEndHour: 6, recoveryHours: 5 },
  };
  const zeroLoad: Task = {
    id: 't4-zero',
    name: 'zero-load',
    timeBlock: { start: new Date(2026, 1, 16, 6, 0), end: new Date(2026, 1, 16, 10, 0) },
    requiredCount: 1,
    slots: [{ slotId: 't4-zero-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 0,
  };
  const assigns: Assignment[] = [
    mkAssignment('t4-a1', trigger.id, 't4-trig-s', p.id),
    mkAssignment('t4-a2', zeroLoad.id, 't4-zero-s', p.id),
  ];
  const r = validateHardConstraints([trigger, zeroLoad], [p], assigns);
  assert(
    !r.violations.some((v) => v.code === 'SLEEP_RECOVERY_VIOLATION'),
    'T4 — zero-load (isLight) candidate inside recovery window does NOT fire HC-15',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T5: SC-7 (group mismatch) is warning-only — not a hard constraint.
//
// Build a sameGroupRequired task with two participants from different groups,
// then disable HC-4 (so the hard constraint doesn't fire). collectSoftWarnings
// must return a Warning-severity GROUP_MISMATCH; validateHardConstraints with
// HC-4 disabled must NOT mark the schedule invalid based on group mismatch.
// ════════════════════════════════════════════════════════════════════════════
section('T5: SC-7 is warning-only (no hard violation when HC-4 is disabled)');
{
  const pA = mkP('t5-pA', Level.L0, [], 'GroupA');
  const pB = mkP('t5-pB', Level.L0, [], 'GroupB');
  const task: Task = {
    id: 't5-t',
    name: 'group-task',
    timeBlock: { start: new Date(2026, 1, 16, 6, 0), end: new Date(2026, 1, 16, 10, 0) },
    requiredCount: 2,
    slots: [
      { slotId: 't5-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      { slotId: 't5-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
    ],
    sameGroupRequired: true,
    blocksConsecutive: false,
  };
  const assigns: Assignment[] = [
    mkAssignment('t5-a1', task.id, 't5-s1', pA.id),
    mkAssignment('t5-a2', task.id, 't5-s2', pB.id),
  ];

  // Hard validation with HC-4 disabled: no GROUP_MISMATCH error severity.
  const hard = validateHardConstraints([task], [pA, pB], assigns, new Set(['HC-4', 'HC-8']));
  const errLevelGroupMismatch = hard.violations.filter(
    (v) => v.code === 'GROUP_MISMATCH' && v.severity === ViolationSeverity.Error,
  );
  assert(
    errLevelGroupMismatch.length === 0,
    'T5.a — with HC-4 disabled, no Error-severity GROUP_MISMATCH from validateHardConstraints',
  );

  // Soft warnings layer surfaces GROUP_MISMATCH as Warning severity (SC-7).
  const warnings = collectSoftWarnings([task], [pA, pB], assigns);
  const sc7 = warnings.filter((w) => w.code === 'GROUP_MISMATCH');
  assert(sc7.length === 1, 'T5.b — collectSoftWarnings emits exactly one GROUP_MISMATCH warning');
  assert(
    sc7[0].severity === ViolationSeverity.Warning,
    'T5.c — SC-7 GROUP_MISMATCH warning severity is Warning (not Error)',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T6: Senior policy — natural-role classification + zero penalty when slot
//     is non-lowPriority for the participant's level.
// ════════════════════════════════════════════════════════════════════════════
section('T6: Senior policy — natural role + zero penalty in non-lowPriority slot');
{
  const seniorTask: Task = {
    id: 't6-t',
    name: 'senior-task',
    timeBlock: { start: new Date(2026, 1, 16, 6, 0), end: new Date(2026, 1, 16, 10, 0) },
    requiredCount: 1,
    slots: [
      { slotId: 't6-natural', acceptableLevels: [{ level: Level.L4 }], requiredCertifications: [] },
      {
        slotId: 't6-lowprio',
        acceptableLevels: [{ level: Level.L4, lowPriority: true }, { level: Level.L0 }],
        requiredCertifications: [],
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const seniorNaturalSlot = seniorTask.slots[0];
  const seniorLowPrioSlot = seniorTask.slots[1];

  assert(
    isNaturalRole(Level.L4, seniorTask, seniorNaturalSlot) === true,
    'T6.a — senior at normal-priority slot → isNaturalRole=true',
  );
  assert(
    isNaturalRole(Level.L4, seniorTask, seniorLowPrioSlot) === false,
    'T6.b — senior at lowPriority slot → isNaturalRole=false',
  );

  // Penalty: senior in NATURAL slot → zero penalty
  const senior = mkP('t6-senior', Level.L4);
  const assignsNatural: Assignment[] = [mkAssignment('t6-an', seniorTask.id, 't6-natural', senior.id)];
  const naturalPenalty = computeLowPriorityLevelPenalty([senior], assignsNatural, [seniorTask], DEFAULT_CONFIG);
  assert(naturalPenalty === 0, 'T6.c — senior in natural-role slot incurs zero lowPriorityLevelPenalty');

  // Penalty: senior in LOW-PRIORITY slot → exactly one lowPriorityLevelPenalty.
  const assignsLowPrio: Assignment[] = [mkAssignment('t6-al', seniorTask.id, 't6-lowprio', senior.id)];
  const lowPrioPenalty = computeLowPriorityLevelPenalty([senior], assignsLowPrio, [seniorTask], DEFAULT_CONFIG);
  assert(
    lowPrioPenalty === DEFAULT_CONFIG.lowPriorityLevelPenalty,
    'T6.d — senior in lowPriority slot incurs exactly one lowPriorityLevelPenalty',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T7: Removed-constraints regression — HC-9 / HC-10 / HC-13 / SC-1/SC-2/SC-4/SC-5
//     must not be exported from the constraint files.
// ════════════════════════════════════════════════════════════════════════════
section('T7: Removed constraints not exported from constraint files');
{
  const hardSrc = fs.readFileSync(path.join(__dirname, 'constraints', 'hard-constraints.ts'), 'utf8');
  const softSrc = fs.readFileSync(path.join(__dirname, 'constraints', 'soft-constraints.ts'), 'utf8');
  const seniorSrc = fs.readFileSync(path.join(__dirname, 'constraints', 'senior-policy.ts'), 'utf8');

  const removedCodes = ['HC-9', 'HC-10', 'HC-13'];
  for (const code of removedCodes) {
    const pattern = new RegExp(`\\b${code.replace('-', '\\-')}\\b`);
    assert(!pattern.test(hardSrc), `T7.${code}.h — "${code}" is not referenced in hard-constraints.ts`);
    assert(!pattern.test(softSrc), `T7.${code}.s — "${code}" is not referenced in soft-constraints.ts`);
    assert(!pattern.test(seniorSrc), `T7.${code}.p — "${code}" is not referenced in senior-policy.ts`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// T8: forbiddenCertifications precedence — must reject regardless of
//     positive-cert match. Validator path (HC-11).
// ════════════════════════════════════════════════════════════════════════════
section('T8: forbiddenCertifications takes precedence in validator');
{
  const pHorshHolder = mkP('t8-p', Level.L0, ['Nitzan', 'Horesh']);
  const task: Task = {
    id: 't8-t',
    name: 'forbidden-test',
    timeBlock: { start: new Date(2026, 1, 16, 6, 0), end: new Date(2026, 1, 16, 10, 0) },
    requiredCount: 1,
    slots: [
      {
        slotId: 't8-s',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        forbiddenCertifications: ['Horesh'],
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const a = mkAssignment('t8-a', task.id, 't8-s', pHorshHolder.id);
  const r = validateHardConstraints([task], [pHorshHolder], [a]);
  assert(
    r.violations.some((v) => v.code === 'EXCLUDED_CERTIFICATION'),
    'T8 — participant with forbidden cert is rejected (HC-11) even when required cert is held',
  );
}

// ════════════════════════════════════════════════════════════════════════════
// T9: HC-15 disabled in disabledHardConstraints — the per-placement primitive
//     `validateHardConstraints` integration must align with the gate. Already
//     covered in T1; here we additionally verify zero-load ALSO clean when
//     disabled (it's already clean baseline so this just pins the semantics
//     under disable). Skipping — duplicate of T1 + T4.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// T10: HC-2 missing certification at validator level — covered in src/test.ts
// directly via checkCertificationRequirement. Skipping.
// ════════════════════════════════════════════════════════════════════════════

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════');
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFAILURES:');
  for (const m of failureMessages) console.log(`  - ${m}`);
  process.exit(1);
} else {
  console.log('All targeted constraint-coverage tests passed.');
}
