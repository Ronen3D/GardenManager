/**
 * End-to-end validation — shift-splitting feature (final pass).
 *
 * Goes beyond the unit suite (`src/test-shift-split.ts`) by driving the REAL
 * `SchedulingEngine.generateSchedule()` / manual-swap / Rescue / Future-SOS
 * paths on a realistic, deterministic, meaningful-scale scenario, and asserting
 * user-visible behaviour:
 *
 *   S1  splitting OFF  → the heavy day's guard shift is left UNFILLED whole
 *       splitting ON   → that SAME shift is realized as two legal 2h halves,
 *                        assigned to two DIFFERENT participants, and the final
 *                        engine validation is clean (HC-12/14/15/16 all pass)
 *   S2  a manual swap that would put both halves on one person is REJECTED and
 *       rolled back (and a benign swap still succeeds — no over-blocking)
 *   S3  Rescue cannot place the sibling-holder onto the other half
 *       (and Rescue still works for an ordinary vacated slot — control)
 *   S4  Future-SOS cannot place the sibling-holder onto the other half
 *
 * Run:  npx ts-node src/validate-shift-split-e2e.ts
 */

import { validateHardConstraints } from './constraints/hard-constraints';
import { generateBatchRescuePlans } from './engine/future-sos';
import { optimizeMultiAttempt } from './engine/optimizer';
import { generateRescuePlans } from './engine/rescue';
import { SchedulingEngine } from './engine/scheduler';
import { DEFAULT_CONFIG, Level, type Participant, type Schedule, type Task } from './models/types';

// ─── Assert harness ──────────────────────────────────────────────────────────
// A0 pattern: an `assert(condition, name)` is injected by the caller
// (src/test.ts IIFE) so this suite contributes to the main tally; it also
// self-execs standalone under `require.main === module` with a local counter.

type AssertFn = (condition: boolean, name: string) => void;

// ─── Deterministic realistic fixture ─────────────────────────────────────────

const DAYS = 5;
const CONFLICT_DAY = 3; // the single heavy day where guard cannot be filled whole
const GUARD_CERT = 'MATAV'; // rare cert held ONLY by GA + GB
const REST_RULE = 'rr-guard';
const H = 3600000;

/** op-day d (1..DAYS) at wall hour h → absolute Date (dayStartHour = 5, all
 *  hours used are ≥ 6 so each maps cleanly into calendar June `d`). */
function D(d: number, h: number): Date {
  return new Date(2026, 5, d, h, 0, 0, 0);
}
const PERIOD_START = new Date(2026, 5, 1, 0, 0, 0, 0);
const FULL_WINDOW = { start: new Date(2026, 4, 31, 0, 0, 0), end: new Date(2026, 5, 7, 0, 0, 0) };
const ALL_LEVELS = [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }];

function guardTask(d: number, splittable: boolean): Task {
  return {
    id: `guard-d${d}`,
    name: `שמירה יום ${d}`,
    sourceName: 'guard',
    timeBlock: { start: D(d, 14), end: D(d, 18) },
    requiredCount: 1,
    slots: [{ slotId: `guard-d${d}-s`, acceptableLevels: ALL_LEVELS, requiredCertifications: [GUARD_CERT] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: REST_RULE,
    sleepRecovery: { triggerShifts: [1], recoveryHours: 6 },
    shiftIndex: 1,
    splittable,
  };
}
function plainTask(id: string, d: number, sh: number, eh: number, slots: number): Task {
  return {
    id,
    name: id,
    sourceName: id.replace(/-d\d+.*/, ''),
    timeBlock: { start: D(d, sh), end: D(d, eh) },
    requiredCount: slots,
    slots: Array.from({ length: slots }, (_, i) => ({
      slotId: `${id}-s${i}`,
      acceptableLevels: ALL_LEVELS,
      requiredCertifications: [],
    })),
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

function buildTasks(splittable: boolean): Task[] {
  const tasks: Task[] = [];
  for (let d = 1; d <= DAYS; d++) {
    tasks.push(guardTask(d, splittable));
    tasks.push(plainTask(`patrol-d${d}-am`, d, 6, 14, 2));
    tasks.push(plainTask(`patrol-d${d}-pm`, d, 14, 22, 2));
    tasks.push(plainTask(`kitchen-d${d}`, d, 10, 14, 2));
  }
  return tasks;
}

function certHolder(id: string, conflictWindow: { sh: number; eh: number }): Participant {
  return {
    id,
    name: id,
    level: Level.L2,
    certifications: [GUARD_CERT],
    group: 'g1',
    availability: Array.from({ length: DAYS }, (_, i) => {
      const d = i + 1;
      return d === CONFLICT_DAY
        ? { start: D(d, conflictWindow.sh), end: D(d, conflictWindow.eh) }
        : { start: D(d, 13), end: D(d, 18) };
    }),
    dateUnavailability: [],
  };
}

function buildParticipants(): Participant[] {
  // GA can only cover the FIRST half of the conflict-day guard (avail 13–16);
  // GB only the SECOND half (avail 16–19). No one else holds the guard cert,
  // so the conflict-day 14–18 guard cannot be filled whole by anyone.
  const ga = certHolder('GA', { sh: 13, eh: 16 });
  const gb = certHolder('GB', { sh: 16, eh: 19 });
  const generals: Participant[] = [];
  const lv = [Level.L0, Level.L2, Level.L3, Level.L4];
  for (let i = 1; i <= 16; i++) {
    generals.push({
      id: `g${i}`,
      name: `כללי ${i}`,
      level: lv[i % lv.length],
      certifications: [],
      group: i % 2 === 0 ? 'g1' : 'g2',
      availability: [{ start: FULL_WINDOW.start, end: FULL_WINDOW.end }],
      dateUnavailability: [],
    });
  }
  return [ga, gb, ...generals];
}

function makeEngine(splittingEnabled: boolean): SchedulingEngine {
  const restRuleMap = new Map<string, number>([[REST_RULE, 4 * H]]);
  const eng = new SchedulingEngine({ ...DEFAULT_CONFIG }, undefined, restRuleMap, 5, splittingEnabled);
  eng.setPeriod(PERIOD_START, DAYS);
  eng.addParticipants(buildParticipants());
  eng.addTasks(buildTasks(splittingEnabled));
  return eng;
}

const guardGroupId = `guard-d${CONFLICT_DAY}`; // original occurrence id
const guardSlotId = `${guardGroupId}-s`; // its single slot
const guardSplitGid = `${guardGroupId}::${guardSlotId}`; // per-slot split group id
const halfAId = `${guardSplitGid}#a`;
const halfBId = `${guardSplitGid}#b`;
function isConflictGuardUnfilled(sched: Schedule): boolean {
  // No assignment exists for the conflict-day guard occurrence (whole or per-slot halves).
  return !sched.assignments.some((a) => a.taskId === guardGroupId || a.taskId.startsWith(`${guardGroupId}::`));
}

// ─── S1 — OFF leaves it unfilled; ON splits into two legal halves ────────────

function scenarioS1(assert: AssertFn): { onSchedule: Schedule } {
  console.log('\n── S1: OFF unfilled  vs  ON split (two different people, clean) ──');

  // OFF
  const offEng = makeEngine(false);
  const off = offEng.generateSchedule();
  const offGuardAssigns = off.assignments.filter((a) => a.taskId.startsWith(guardGroupId));
  assert(isConflictGuardUnfilled(off), 'OFF: conflict-day guard occurrence is left UNFILLED (no whole, no halves)');
  assert(offGuardAssigns.length === 0, 'OFF: zero assignments on the conflict-day guard');
  assert(
    !off.tasks.some((t) => t.splitGroupId !== undefined),
    'OFF: no split tasks were created anywhere (zero-regression path)',
  );
  const offUnfilled = (off.violations ?? []).length; // info only
  console.log(`     OFF: ${off.assignments.length} assignments, feasible=${off.feasible}, violations=${offUnfilled}`);

  // ON
  const onEng = makeEngine(true);
  const on = onEng.generateSchedule();

  const halfA = on.tasks.find((t) => t.id === halfAId);
  const halfB = on.tasks.find((t) => t.id === halfBId);
  assert(!!halfA && !!halfB, 'ON: conflict-day guard occurrence was realized as two halves (#a, #b)');
  assert(
    !on.tasks.some((t) => t.id === guardGroupId),
    'ON: the single-slot occurrence has no residual — original whole guard task is gone (replaced by halves)',
  );
  assert(
    halfA?.splitGroupId === guardSplitGid && halfB?.splitGroupId === guardSplitGid,
    'ON: both halves share splitGroupId = split-SLOT pair (occurrenceId::slotId)',
  );
  assert(
    halfA?.splitOccurrenceId === guardGroupId && halfB?.splitOccurrenceId === guardGroupId,
    'ON: both halves share splitOccurrenceId = original occurrence id',
  );
  assert(
    halfA?.splitPart === 1 && halfB?.splitPart === 2 && halfA?.splitOriginalMs === 4 * H,
    'ON: splitPart 1/2 and splitOriginalMs = 4h (K) recorded',
  );

  // Other guard days must NOT have been split (only the unfillable one is).
  const otherSplit = on.tasks.filter((t) => t.splitOccurrenceId && t.splitOccurrenceId !== guardGroupId);
  assert(otherSplit.length === 0, 'ON: only the unfillable occurrence split — the other 4 guard days stay whole');

  const aAsg = on.assignments.filter((a) => a.taskId === halfAId);
  const bAsg = on.assignments.filter((a) => a.taskId === halfBId);
  assert(aAsg.length === 1 && bAsg.length === 1, 'ON: both halves are filled (one assignment each)');
  const pa = aAsg[0]?.participantId;
  const pb = bAsg[0]?.participantId;
  assert(!!pa && !!pb && pa !== pb, `ON: the two halves go to two DIFFERENT participants (${pa} ≠ ${pb})`);
  assert(
    (pa === 'GA' && pb === 'GB') || (pa === 'GB' && pb === 'GA'),
    'ON: the only feasible holders (GA first half, GB second half) were used',
  );

  const v = onEng.validate();
  const hc16 = v.violations.filter((x) => x.code === 'SPLIT_SIBLING_CONFLICT');
  const blockingHc = v.violations.filter((x) => ['HC-12', 'HC-14', 'HC-15', 'SPLIT_SIBLING_CONFLICT'].includes(x.code));
  assert(v.valid, 'ON: final engine validation is CLEAN (schedule is feasible)');
  assert(hc16.length === 0, 'ON: no HC-16 split-sibling violations');
  assert(blockingHc.length === 0, 'ON: no HC-12 / HC-14 / HC-15 violations around the split halves');
  assert(isConflictGuardUnfilled(on) === false, 'ON: the conflict-day guard is now COVERED (was unfilled in OFF)');
  console.log(
    `     ON : #a→${pa} [${halfA?.timeBlock.start.getHours()}–${halfA?.timeBlock.end.getHours()}], ` +
      `#b→${pb} [${halfB?.timeBlock.start.getHours()}–${halfB?.timeBlock.end.getHours()}], feasible=${on.feasible}`,
  );

  return { onSchedule: on };
}

// ─── S2 — manual swap cannot break HC-16 (and benign swap still works) ───────

function scenarioS2(assert: AssertFn, onEng: SchedulingEngine): void {
  console.log('\n── S2: manual swap cannot create a same-person split ──');
  const sched = onEng.getSchedule()!;
  const aAsg = sched.assignments.find((a) => a.taskId === halfAId)!;
  const bAsg = sched.assignments.find((a) => a.taskId === halfBId)!;
  const aHolder = aAsg.participantId;
  const bHolder = bAsg.participantId;

  // Try to move #a onto #b's holder → that person would own BOTH halves.
  const res = onEng.swapParticipant({ assignmentId: aAsg.id, newParticipantId: bHolder });
  assert(!res.valid, 'S2: swap putting both halves on one person is REJECTED');
  assert(
    res.violations.some((x) => x.code === 'SPLIT_SIBLING_CONFLICT'),
    'S2: rejection cites HC-16 (SPLIT_SIBLING_CONFLICT) specifically',
  );
  const aAfter = onEng.getSchedule()!.assignments.find((a) => a.id === aAsg.id)!;
  assert(aAfter.participantId === aHolder, 'S2: rejected swap was fully rolled back (#a holder unchanged)');

  // Benign control: move a patrol slot to a verified-idle general participant.
  const patrol = sched.assignments.find((a) => a.taskId === 'patrol-d1-am')!;
  const ptask = sched.tasks.find((t) => t.id === 'patrol-d1-am')!;
  const busy = new Set(
    sched.assignments
      .filter((a) => {
        const tt = sched.tasks.find((t) => t.id === a.taskId);
        return (
          tt &&
          tt.timeBlock.start.getTime() < ptask.timeBlock.end.getTime() &&
          tt.timeBlock.end.getTime() > ptask.timeBlock.start.getTime()
        );
      })
      .map((a) => a.participantId),
  );
  const idle = sched.participants.find((p) => p.id.startsWith('g') && !busy.has(p.id));
  if (idle) {
    const ok = onEng.swapParticipant({ assignmentId: patrol.id, newParticipantId: idle.id });
    assert(ok.valid, `S2 control: a benign swap (patrol → idle ${idle.id}) still SUCCEEDS (no over-blocking)`);
    // restore
    onEng.swapParticipant({ assignmentId: patrol.id, newParticipantId: patrol.participantId });
  } else {
    console.log('     (skipped benign control — no verified-idle general found)');
  }
}

// ─── S3 — Rescue cannot place the sibling-holder onto the other half ────────

function scenarioS3(assert: AssertFn, onEng: SchedulingEngine): void {
  console.log('\n── S3: Rescue respects HC-16 ──');
  const sched = onEng.getSchedule()!;
  const aAsg = sched.assignments.find((a) => a.taskId === halfAId)!;
  const bHolder = sched.assignments.find((a) => a.taskId === halfBId)!.participantId;
  const anchor = D(1, 0);

  const result = generateRescuePlans(
    sched,
    { vacatedAssignmentId: aAsg.id, taskId: aAsg.taskId, slotId: aAsg.slotId, vacatedBy: aAsg.participantId },
    anchor,
    0,
    5,
    onEng.getDisabledHC(),
    onEng.getRestRuleMap(),
    onEng.getDayStartHour(),
    onEng.getCertLabelResolver(),
    onEng.getConfig(),
    onEng.buildScoreContext(),
    onEng.getScheduleContext(),
  );

  const offending = result.plans.filter((pl) =>
    pl.swaps.some((s) => s.taskId === halfAId && s.toParticipantId === bHolder),
  );
  assert(offending.length === 0, `S3: no Rescue plan moves the #b holder (${bHolder}) into the #a slot`);
  const anyHc16 = result.plans.some((pl) => pl.violations.some((x) => x.code === 'SPLIT_SIBLING_CONFLICT'));
  assert(!anyHc16, 'S3: no Rescue plan carries a residual HC-16 violation');
  console.log(`     Rescue returned ${result.plans.length} plan(s) for the #a slot; none break HC-16`);

  // Control: an ordinary patrol slot is still rescuable (Rescue is not just
  // returning empty for everything).
  const patrolAsg = sched.assignments.find((a) => a.taskId === 'patrol-d2-am')!;
  const ctl = generateRescuePlans(
    sched,
    {
      vacatedAssignmentId: patrolAsg.id,
      taskId: patrolAsg.taskId,
      slotId: patrolAsg.slotId,
      vacatedBy: patrolAsg.participantId,
    },
    anchor,
    0,
    5,
    onEng.getDisabledHC(),
    onEng.getRestRuleMap(),
    onEng.getDayStartHour(),
    onEng.getCertLabelResolver(),
    onEng.getConfig(),
    onEng.buildScoreContext(),
    onEng.getScheduleContext(),
  );
  assert(ctl.plans.length > 0, 'S3 control: Rescue DOES find plans for an ordinary patrol slot (works generally)');
}

// ─── S4 — Future-SOS cannot place the sibling-holder onto the other half ────

function scenarioS4(assert: AssertFn, onEng: SchedulingEngine): void {
  console.log('\n── S4: Future-SOS respects HC-16 ──');
  const sched = onEng.getSchedule()!;
  const aAsg = sched.assignments.find((a) => a.taskId === halfAId)!;
  const aHolder = aAsg.participantId;
  const bHolder = sched.assignments.find((a) => a.taskId === halfBId)!.participantId;
  const anchor = D(1, 0);
  const window = { start: D(CONFLICT_DAY, 13), end: D(CONFLICT_DAY, 17) };

  // Record the Future-SOS unavailability on the snapshot (so HC-3 also makes
  // the #a holder an invalid replacement, exactly like the real flow).
  sched.scheduleUnavailability = [
    ...(sched.scheduleUnavailability ?? []),
    {
      id: 'sos-GA',
      participantId: aHolder,
      start: window.start,
      end: window.end,
      reason: 'בדיקת SOS',
      createdAt: new Date(),
      anchorAtCreation: anchor,
    },
  ];

  const res = generateBatchRescuePlans(sched, { participantId: aHolder, window }, anchor, {
    maxPlans: 5,
    disabledHC: onEng.getDisabledHC(),
    restRuleMap: onEng.getRestRuleMap(),
    certLabelResolver: onEng.getCertLabelResolver(),
    config: onEng.getConfig(),
    scoreCtx: onEng.buildScoreContext()!,
    scheduleContext: onEng.getScheduleContext(),
  });

  assert(
    res.affected.some((a) => a.assignment.id === aAsg.id),
    'S4: Future-SOS correctly identifies the #a half as an affected assignment',
  );
  const offending = res.plans.filter((pl) =>
    pl.swaps.some((s) => s.taskId === halfAId && s.toParticipantId === bHolder),
  );
  assert(offending.length === 0, `S4: no Future-SOS plan moves the #b holder (${bHolder}) into the #a slot`);
  const anyHc16 = res.plans.some((pl) => pl.violations.some((x) => x.code === 'SPLIT_SIBLING_CONFLICT'));
  assert(!anyHc16, 'S4: no Future-SOS plan carries a residual HC-16 violation');
  console.log(
    `     Future-SOS: affected=${res.affected.length}, plans=${res.plans.length}, ` +
      `#a in infeasible=${res.infeasibleAssignmentIds.includes(aAsg.id)} (expected — only GB has the cert and GB is the sibling)`,
  );
}

// ─── S5 — multi-attempt isolation (no cross-attempt input contamination) ────

function scenarioS5(assert: AssertFn): void {
  console.log('\n── S5: multi-attempt run — split works, input array never mutated ──');
  const restRuleMap = new Map<string, number>([[REST_RULE, 4 * H]]);
  const participants = buildParticipants();

  // ON, multi-attempt: an attempt that splits must NOT leak halves into the
  // shared input `tasks` array or the next attempt (the zero-contamination
  // guarantee — applyFeasibilitySplits returns a COPY, taskMap is per-attempt).
  const onTasks = buildTasks(true);
  const wholeGuardRef = onTasks.find((t) => t.id === guardGroupId)!;
  const onResult = optimizeMultiAttempt(
    onTasks,
    participants,
    { ...DEFAULT_CONFIG },
    [],
    8,
    undefined,
    undefined,
    undefined,
    restRuleMap,
    undefined,
    undefined,
    5,
  );
  assert(
    onTasks.includes(wholeGuardRef) && onTasks.length === buildTasks(true).length,
    'S5: input tasks array is UNMUTATED after a splitting multi-attempt run (same whole-guard object, same length)',
  );
  assert(
    !onTasks.some((t) => t.splitGroupId !== undefined),
    'S5: no #a/#b half ever leaked back into the shared input task array',
  );
  const rTasks = onResult.tasks ?? onTasks;
  const splitDays = new Set(rTasks.filter((t) => t.splitGroupId).map((t) => t.splitGroupId));
  assert(
    rTasks.some((t) => t.id === halfAId),
    'S5: best multi-attempt result splits the conflict-day guard',
  );
  assert(splitDays.size === 1, 'S5: best result split exactly ONE occurrence (parsimony holds under multi-attempt)');
  const v = validateHardConstraints(rTasks, participants, onResult.assignments, undefined, restRuleMap);
  assert(
    v.violations.filter((x) => x.code === 'SPLIT_SIBLING_CONFLICT').length === 0,
    'S5: multi-attempt best result has no HC-16 violation',
  );

  // OFF, multi-attempt: no split task may ever appear, in any attempt's result.
  const offTasks = buildTasks(false);
  const offResult = optimizeMultiAttempt(
    offTasks,
    participants,
    { ...DEFAULT_CONFIG },
    [],
    8,
    undefined,
    undefined,
    undefined,
    restRuleMap,
    undefined,
    undefined,
    5,
  );
  const offRTasks = offResult.tasks ?? offTasks;
  assert(
    !offRTasks.some((t) => t.splitGroupId !== undefined),
    'S5: OFF multi-attempt never produces a split (zero-regression under multi-attempt)',
  );
  console.log(`     ON best splits ${splitDays.size} occurrence; OFF best splits 0 (input arrays intact)`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function runShiftSplitE2ETests(assert: AssertFn): Promise<void> {
  console.log('\n── Shift-Split E2E: real engine paths (5 op-days · 18 participants) ──');
  const { onSchedule } = scenarioS1(assert);
  // S2–S4 reuse a single ON engine so they operate on a real generated split.
  const onEng = makeEngine(true);
  const re = onEng.generateSchedule();
  if (!re.tasks.some((t) => t.id === halfAId)) {
    assert(false, 'E2E: ON regeneration must split the conflict-day guard (precondition for S2–S4)');
  } else {
    scenarioS2(assert, onEng);
    scenarioS3(assert, onEng);
    scenarioS4(assert, onEng);
  }
  scenarioS5(assert);
  void onSchedule;
}

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const fails: string[] = [];
  const assert: AssertFn = (cond, name) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      fails.push(name);
      console.log(`  ✗ FAIL: ${name}`);
    }
  };
  runShiftSplitE2ETests(assert)
    .then(() => {
      console.log('\n═══════════════════════════════════════════════════════════════════');
      console.log(`  RESULT: ${passed + failed} checks | Passed: ${passed} | Failed: ${failed}`);
      if (failed > 0) {
        console.log('  Failing checks:');
        for (const f of fails) console.log(`   - ${f}`);
      }
      console.log('═══════════════════════════════════════════════════════════════════');
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
