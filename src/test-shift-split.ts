/**
 * Shift-splitting tests (plan Part 4).
 *
 * Stage 3 coverage: the shared run-coalescing primitive
 * (src/shared/utils/run-coalesce.ts) — identity-when-no-splits (the
 * zero-regression guarantee) and the legal-run / over-K / note-6 / note-9
 * semantics that HC-12 / HC-14 / SC-6 depend on.
 *
 * Run: npx ts-node src/test-shift-split.ts
 */

import {
  checkNoConsecutiveHighLoad,
  checkRestRules,
  checkSplitSiblingDisjoint,
  validateHardConstraints,
} from './constraints/hard-constraints';
import { computeLowPriorityLevelPenalty } from './constraints/senior-policy';
import { checkSleepRecovery, checkSleepRecoveryForPlacement, getRecoveryWindow } from './constraints/sleep-recovery';
import {
  computeNotWithPenalty,
  computeScheduleScore,
  computeTaskNamePreferencePenalty,
  countSplitOccurrences,
} from './constraints/soft-constraints';
import {
  applyFeasibilitySplits,
  type FeasibilitySplitCtx,
  isSwapFeasible,
  makeSplitHalf,
  optimizeMultiAttemptAsync,
  structuralRefine,
  type UnfilledSlot,
} from './engine/optimizer';
import { getCandidatesWithEligibility, isEligible } from './engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Schedule,
  type SchedulerConfig,
  type ScheduleScore,
  SchedulingEngine,
  type Task,
  type TimeBlock,
} from './index';
import type { SplitOp } from './models/types';
import { fragmentShare } from './shared/utils/load-weighting';
import { coalesceTaskRuns, hasAnySplit } from './shared/utils/run-coalesce';

type AssertFn = (condition: boolean, name: string) => void;

const H = 3600000;
const BASE = new Date(2026, 0, 1, 5, 0, 0, 0).getTime();
function tb(startH: number, endH: number): TimeBlock {
  return { start: new Date(BASE + startH * H), end: new Date(BASE + endH * H) };
}

interface MkOpts {
  source?: string;
  blocks?: boolean;
  restRuleId?: string;
  splitGroupId?: string;
  splitPart?: 1 | 2;
  splitOriginalMs?: number;
}
function mk(id: string, startH: number, endH: number, o: MkOpts = {}): Task {
  return {
    id,
    name: id,
    sourceName: o.source ?? 'guard',
    timeBlock: tb(startH, endH),
    requiredCount: 1,
    slots: [{ slotId: `${id}-s`, acceptableLevels: [], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: o.blocks ?? true,
    restRuleId: o.restRuleId,
    splitGroupId: o.splitGroupId,
    splitPart: o.splitPart,
    splitOriginalMs: o.splitOriginalMs,
  };
}
/** Two halves of one occurrence `g`, split at its midpoint. */
function halves(g: string, startH: number, fullH: number, o: MkOpts = {}): [Task, Task] {
  const midH = startH + fullH / 2;
  const common = { ...o, splitOriginalMs: fullH * H, source: o.source ?? 'guard' };
  return [
    mk(`${g}#a`, startH, midH, { ...common, splitGroupId: g, splitPart: 1 }),
    mk(`${g}#b`, midH, startH + fullH, { ...common, splitGroupId: g, splitPart: 2 }),
  ];
}
const dur = (t: Task) => t.timeBlock.end.getTime() - t.timeBlock.start.getTime();

function runCoalesce(assert: AssertFn): void {
  // 1. Identity: no split anywhere → SAME array reference, zero allocation.
  const whole = [mk('w1', 0, 4), mk('w2', 4, 8, { source: 'other' })];
  assert(coalesceTaskRuns(whole) === whole, 'no-split list returns same reference (identity)');
  assert(!hasAnySplit(whole), 'hasAnySplit false for whole-only list');

  // 2. Single element → same reference (length < 2 short-circuit).
  const one = [mk('w1', 0, 4)];
  assert(coalesceTaskRuns(one) === one, 'single-element list returns same reference');

  // 3. Both halves of ONE occurrence (same person) → ONE synthetic block ==
  //    the original unsplit occurrence (D16 defense-in-depth).
  const [a1, a2] = halves('A', 0, 4);
  const r3 = coalesceTaskRuns([a1, a2]);
  assert(r3.length === 1, 'both halves of one occurrence → 1 coalesced block');
  assert(dur(r3[0]) === 4 * H, 'coalesced block spans the full 4h occurrence');
  assert(r3[0].timeBlock.start.getTime() === BASE, 'merged block starts at occurrence start');
  assert(r3[0].id !== a1.id && r3[0].id !== a2.id, 'merged block gets a distinct run id');
  assert(r3[0].blocksConsecutive === true && r3[0].sourceName === 'guard', 'merged inherits source/blocks');

  // 4. note 6 — cross-occurrence run (½ of A then ½ of adjacent B), 2h+2h=K=4h
  //    → ONE 4h block (HC-12 stays silent → legal continuous run allowed).
  const [, a2b] = halves('A', 0, 4);
  const [b1] = halves('B', 4, 4); // B occupies 4h..8h; b1 = 4h..6h
  const r4 = coalesceTaskRuns([a2b, b1]);
  assert(r4.length === 1, 'note 6: ½A + ½B (= K) → 1 block');
  assert(dur(r4[0]) === 4 * H, 'note 6 merged run is exactly K (4h)');

  // 5. Over-K — ½A + ½B + ½C (6h > K=4h) → [K-run] + leftover ½C, contiguous
  //    (so HC-12 fires for blocksConsecutive ⇒ run cap; note 9 for non-blocking).
  const [, a2c] = halves('A', 0, 4);
  const [b1c, b2c] = halves('B', 4, 4);
  const r5 = coalesceTaskRuns([a2c, b1c, b2c]);
  assert(r5.length === 2, 'over-K chain → 2 blocks (K-run + leftover half)');
  assert(dur(r5[0]) === 4 * H, 'over-K: first block capped at K (4h)');
  assert(
    r5[1].timeBlock.start.getTime() === r5[0].timeBlock.end.getTime(),
    'over-K: leftover half is contiguous with the K-run (HC-12 will see adjacency)',
  );

  // 6. A real gap breaks the run (not a continuous run).
  const [, gapA2] = halves('A', 0, 4); // 2h..4h
  const [gapB1] = halves('B', 5, 4); // 5h..7h  (1h gap after A2)
  const r6 = coalesceTaskRuns([gapA2, gapB1]);
  assert(r6.length === 2, 'gap > 0 → halves not merged');
  assert(r6[0] === gapA2 && r6[1] === gapB1, 'un-merged tasks pass through by reference');

  // 7. Different source → not merged even if contiguous.
  const [, sa2] = halves('A', 0, 4, { source: 'guard' });
  const [sb1] = halves('B', 4, 4, { source: 'patrol' });
  assert(coalesceTaskRuns([sa2, sb1]).length === 2, 'different sourceName → not merged');

  // 8. Whole adjacent same-source tasks NEVER merge (no HC-12 regression),
  //    even when an unrelated split task is present in the list.
  const [hA] = halves('A', 0, 4, { source: 'guard' });
  const wx1 = mk('wx1', 4, 12, { source: 'wide' });
  const wx2 = mk('wx2', 12, 20, { source: 'wide' });
  const r8 = coalesceTaskRuns([hA, wx1, wx2]);
  assert(r8.length === 3, 'two adjacent whole same-source tasks are not coalesced');
  assert(r8[1] === wx1 && r8[2] === wx2, 'whole tasks pass through by reference');

  // 9. restRuleId inherited onto the merged run (HC-14 sees one rest-unit).
  const [, ra2] = halves('A', 0, 4, { restRuleId: 'rr1' });
  const [rb1] = halves('B', 4, 4, { restRuleId: 'rr1' });
  const r9 = coalesceTaskRuns([ra2, rb1]);
  assert(r9.length === 1 && r9[0].restRuleId === 'rr1', 'merged run inherits restRuleId');
}

// ─── Stage 4: feasibility split ──────────────────────────────────────────────

function splitTask(id: string, startH: number, endH: number, splittable: boolean): Task {
  return {
    id,
    name: id,
    sourceName: 'guard',
    timeBlock: tb(startH, endH),
    requiredCount: 1,
    slots: [{ slotId: `${id}-s`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
    splittable,
  };
}
function part(id: string, availStartH: number, availEndH: number): Participant {
  return {
    id,
    name: id,
    level: Level.L0,
    certifications: [],
    group: 'g1',
    availability: [{ start: new Date(BASE + availStartH * H), end: new Date(BASE + availEndH * H) }],
    dateUnavailability: [],
  };
}
function ctxFor(T: Task, participants: Participant[], unfilled: boolean): FeasibilitySplitCtx {
  const unfilledSlots: UnfilledSlot[] = unfilled
    ? [{ taskId: T.id, slotId: T.slots[0].slotId, reason: 'test', hcCodes: [] }]
    : [];
  return {
    tasks: [T],
    taskMap: new Map([[T.id, T]]),
    participants,
    assignments: [],
    assignmentsByParticipant: new Map(),
    workload: new Map(),
    dailyWorkload: new Map(),
    unfilledSlots,
    dayStartHour: 5,
  };
}

function runFeasibilitySplit(assert: AssertFn): void {
  // makeSplitHalf shape (slot-level: one slot per half, slot-qualified ids).
  const T0 = splitTask('T0', 0, 4, true);
  const s0 = T0.slots[0];
  const ha = makeSplitHalf(T0, 1, BASE, BASE + 2 * H, s0);
  const hb = makeSplitHalf(T0, 2, BASE + 2 * H, BASE + 4 * H, s0);
  assert(ha.id === 'T0::T0-s#a' && hb.id === 'T0::T0-s#b', 'half ids slot-qualified #a/#b');
  assert(
    ha.splitGroupId === 'T0::T0-s' && hb.splitGroupId === 'T0::T0-s',
    'halves share splitGroupId = split-SLOT pair (taskId::slotId)',
  );
  assert(
    ha.splitOccurrenceId === 'T0' && hb.splitOccurrenceId === 'T0',
    'halves share splitOccurrenceId = original occurrence id',
  );
  assert(ha.splitPart === 1 && hb.splitPart === 2, 'splitPart 1/2');
  assert(ha.splitOriginalMs === 4 * H, 'splitOriginalMs = original occurrence span');
  assert(dur(ha) === 2 * H && dur(hb) === 2 * H, 'each half is 2h');
  assert(ha.slots.length === 1 && hb.slots.length === 1, 'each half carries exactly its one slot');
  assert(ha.slots[0].slotId !== s0.slotId, 'half slot id suffixed (unique within half)');
  assert(ha.sourceName === 'guard' && ha.blocksConsecutive === true, 'half inherits source/blocks');

  // A. Feasibility split: nobody covers full 4h, but P1 covers ½, P2 covers ½.
  const TA = splitTask('TA', 0, 4, true);
  const ctxA = ctxFor(TA, [part('P1', -1, 2), part('P2', 2, 5)], true);
  const outA = applyFeasibilitySplits(ctxA);
  assert(outA !== ctxA.tasks, 'A: task list replaced (split committed)');
  assert(
    outA.length === 2 && outA.every((t) => t.splitGroupId === 'TA::TA-s'),
    'A: single-slot TA → residual dropped, two per-slot halves',
  );
  assert(ctxA.assignments.length === 2, 'A: both half-slots filled');
  const aPids = new Set(ctxA.assignments.map((x) => x.participantId));
  assert(aPids.size === 2, 'A: two DIFFERENT participants (P1, P2)');
  assert(ctxA.unfilledSlots.length === 0, 'A: original unfilled entry cleared');

  // B. Not splittable → exact no-op (same ref, nothing changed).
  const TB = splitTask('TB', 0, 4, false);
  const ctxB = ctxFor(TB, [part('P1', -1, 2), part('P2', 2, 5)], true);
  const outB = applyFeasibilitySplits(ctxB);
  assert(outB === ctxB.tasks, 'B: not splittable → same task array reference');
  assert(ctxB.assignments.length === 0 && ctxB.unfilledSlots.length === 1, 'B: untouched');

  // C. No unfilled slots → immediate no-op.
  const TC = splitTask('TC', 0, 4, true);
  const ctxC = ctxFor(TC, [part('P1', -1, 5)], false);
  assert(applyFeasibilitySplits(ctxC) === ctxC.tasks, 'C: nothing unfilled → same ref');

  // D. Split infeasible (only one eligible person, needed for both halves) →
  //    full revert: same ref, T restored, no assignments, unfilled intact.
  const TD = splitTask('TD', 0, 4, true);
  const ctxD = ctxFor(TD, [part('P1', -1, 2)], true); // P1 covers only first half
  const outD = applyFeasibilitySplits(ctxD);
  assert(outD === ctxD.tasks, 'D: infeasible split → same task array reference (reverted)');
  assert(ctxD.taskMap.get('TD') === TD && !ctxD.taskMap.has('TD::TD-s#a'), 'D: original task restored in taskMap');
  assert(ctxD.assignments.length === 0, 'D: no leftover half assignments after revert');
  assert(ctxD.unfilledSlots.length === 1, "D: original unfilled entry preserved (today's behavior)");

  // E. Two-different-people enforced even when both could do the whole shift.
  const TE = splitTask('TE', 0, 4, true);
  const ctxE = ctxFor(TE, [part('P1', -1, 5), part('P2', -1, 5)], true);
  applyFeasibilitySplits(ctxE);
  assert(ctxE.assignments.length === 2, 'E: both halves filled');
  assert(
    ctxE.assignments[0].participantId !== ctxE.assignments[1].participantId,
    'E: the two halves go to different participants',
  );
}

// ─── Stage 5: HC-16 split-sibling disjointness ───────────────────────────────

function asg(taskId: string, pid: string): Assignment {
  return {
    id: `as-${taskId}-${pid}`,
    taskId,
    slotId: `${taskId}-s`,
    participantId: pid,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(BASE),
  };
}

function runHc16(assert: AssertFn): void {
  const [a1, a2] = halves('G', 0, 4); // G#a, G#b — splitGroupId 'G'
  const [h1] = halves('H', 4, 4); // H#a — splitGroupId 'H'
  const whole = mk('W1', 0, 4); // no splitGroupId
  const tm = new Map<string, Task>([
    [a1.id, a1],
    [a2.id, a2],
    [h1.id, h1],
    [whole.id, whole],
  ]);

  // Same participant holds BOTH halves of occurrence G → violation.
  const v1 = checkSplitSiblingDisjoint('P1', [asg(a1.id, 'P1'), asg(a2.id, 'P1')], tm, 'P1');
  assert(v1.length === 1 && v1[0].code === 'SPLIT_SIBLING_CONFLICT', 'HC-16: one person, both halves → violation');

  // Holds only one half → no violation.
  assert(checkSplitSiblingDisjoint('P1', [asg(a1.id, 'P1')], tm, 'P1').length === 0, 'HC-16: single half → ok');

  // Holds halves of DIFFERENT occurrences (G#a + H#a) → no violation.
  assert(
    checkSplitSiblingDisjoint('P1', [asg(a1.id, 'P1'), asg(h1.id, 'P1')], tm, 'P1').length === 0,
    'HC-16: different split groups → ok',
  );

  // Two different people, one half each → no violation (the legal split).
  assert(
    checkSplitSiblingDisjoint('P1', [asg(a1.id, 'P1'), asg(a2.id, 'P2')], tm, 'P1').length === 0,
    'HC-16: split across two people → ok',
  );

  // Whole (non-split) tasks never trigger HC-16, even if doubled up.
  assert(
    checkSplitSiblingDisjoint('P1', [asg(whole.id, 'P1'), asg(whole.id, 'P1')], tm, 'P1').length === 0,
    'HC-16: non-split tasks never trigger (zero regression)',
  );
}

// ─── Follow-up: per-placement coalescing (consistency with aggregate) ────────

interface GOpts {
  gid?: string;
  part?: 1 | 2;
  fullH?: number;
  rr?: string;
}
/** Guard-like task with a valid L0 slot; slotId matches `asg()` (`${id}-s`). */
function gTask(id: string, startH: number, endH: number, o: GOpts = {}): Task {
  return {
    id,
    name: id,
    sourceName: 'guard',
    timeBlock: tb(startH, endH),
    requiredCount: 1,
    slots: [{ slotId: `${id}-s`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: o.rr,
    splitGroupId: o.gid,
    splitPart: o.part,
    splitOriginalMs: o.fullH !== undefined ? o.fullH * H : undefined,
  };
}

function runPerPlacementCoalescing(assert: AssertFn): void {
  const RR = new Map<string, number>([['rr', 5 * H]]);
  const P = part('P', -1, 14); // available all day

  // 1. note-6: P already holds ½A=[2,4]; candidate ½B=[4,6] of the ADJACENT
  //    occurrence (same source, same rest rule, contiguous, total = K = 4h).
  //    This is a LEGAL continuous run — the aggregate validator allows it, so
  //    the per-placement gate MUST allow it too, or the splitting feature
  //    leaves fillable slots empty in exactly the case it exists for.
  const aB = gTask('A#b', 2, 4, { gid: 'A', part: 2, fullH: 4, rr: 'rr' });
  const bA = gTask('B#a', 4, 6, { gid: 'B', part: 1, fullH: 4, rr: 'rr' });
  const tm1 = new Map<string, Task>([
    [aB.id, aB],
    [bA.id, bA],
  ]);
  const held = [asg(aB.id, 'P')];
  const eligible = isEligible(P, bA, bA.slots[0], held, tm1, { restRuleMap: RR });
  assert(eligible, 'note-6 legal run (½A+½B = K) is ACCEPTED by per-placement (feature works)');
  // Consistency: the aggregate must reach the same verdict on the same set.
  const both = [asg(aB.id, 'P'), asg(bA.id, 'P')];
  assert(
    checkNoConsecutiveHighLoad('P', both, tm1).length === 0,
    'note-6: aggregate HC-12 also clean → per-placement ≡ aggregate',
  );
  assert(
    checkRestRules('P', both, tm1, RR).length === 0,
    'note-6: aggregate HC-14 also clean → per-placement ≡ aggregate',
  );

  // 2. Over-K: P holds the legal 4h run (½A+½B); candidate ½C=[6,8] would make
  //    it 6h > K. Per-placement MUST reject (run cap), matching the aggregate.
  const cA = gTask('C#a', 6, 8, { gid: 'C', part: 1, fullH: 4, rr: 'rr' });
  const tm2 = new Map<string, Task>([
    [aB.id, aB],
    [bA.id, bA],
    [cA.id, cA],
  ]);
  const heldRun = [asg(aB.id, 'P'), asg(bA.id, 'P')];
  assert(
    !isEligible(P, cA, cA.slots[0], heldRun, tm2, { restRuleMap: RR }),
    'over-K (½A+½B+½C = 6h > K) is REJECTED by per-placement (run cap holds)',
  );
  assert(
    checkNoConsecutiveHighLoad('P', [...heldRun, asg(cA.id, 'P')], tm2).length > 0,
    'over-K: aggregate HC-12 also rejects → consistent',
  );

  // 3. Zero-regression: two adjacent NON-split whole guard tasks still reject
  //    via the original fast pairwise path (splitsInvolved = false).
  const w1 = gTask('W1', 0, 4);
  const w2 = gTask('W2', 4, 8);
  const tm3 = new Map<string, Task>([
    [w1.id, w1],
    [w2.id, w2],
  ]);
  assert(
    !isEligible(P, w2, w2.slots[0], [asg(w1.id, 'P')], tm3, { restRuleMap: RR }),
    'non-split adjacent blocking tasks still rejected (fast path unchanged)',
  );
}

// ─── Follow-up: HC-16 enforced in the SA pairwise-swap gate ──────────────────

function runSwapFeasHc16(assert: AssertFn): void {
  const aa = gTask('Z#a', 0, 2, { gid: 'Z', part: 1, fullH: 4 });
  const ab = gTask('Z#b', 2, 4, { gid: 'Z', part: 2, fullH: 4 });
  const u = gTask('U', 10, 12);
  const taskMap = new Map<string, Task>([
    [aa.id, aa],
    [ab.id, ab],
    [u.id, u],
  ]);
  const P1 = part('P1', -1, 14);
  const P2 = part('P2', -1, 14);
  const pMap = new Map<string, Participant>([
    ['P1', P1],
    ['P2', P2],
  ]);

  // Model the POST-swap world the caller hands to isSwapFeasible: swapping
  // Z#b (was P2) with U (was P1) lands BOTH halves of Z on P1.
  const aZa: Assignment = asg(aa.id, 'P1');
  const aZb: Assignment = asg(ab.id, 'P1'); // post-swap owner
  const aU: Assignment = asg(u.id, 'P2'); // post-swap owner
  const candidate = [aZa, aZb, aU];
  const byParticipant = new Map<string, Assignment[]>([
    ['P1', [aZa, aZb]],
    ['P2', [aU]],
  ]);
  const byTask = new Map<string, Assignment[]>([
    [aa.id, [aZa]],
    [ab.id, [aZb]],
    [u.id, [aU]],
  ]);
  // idxI = Z#b (now P1), idxJ = U (now P2).
  assert(
    !isSwapFeasible(candidate, 1, 2, taskMap, pMap, byParticipant, byTask),
    'isSwapFeasible REJECTS a swap that puts both halves of one occurrence on one person (HC-16) — SA cannot return an invalid schedule',
  );

  // Control: a benign swap (no sibling conflict) is still feasible.
  const bZa: Assignment = asg(aa.id, 'P2');
  const bU: Assignment = asg(u.id, 'P1');
  const candidate2 = [bZa, bU];
  const bp2 = new Map<string, Assignment[]>([
    ['P1', [bU]],
    ['P2', [bZa]],
  ]);
  const bt2 = new Map<string, Assignment[]>([
    [aa.id, [bZa]],
    [u.id, [bU]],
  ]);
  assert(
    isSwapFeasible(candidate2, 0, 1, taskMap, pMap, bp2, bt2),
    'isSwapFeasible still ACCEPTS a benign swap (HC-16 does not over-reject)',
  );
}

// ─── Hardening: HC-15 sleep & recovery on split halves ──────────────────────

/**
 * A split half must independently trigger HC-15 from its OWN end (D17), be
 * exempt from its sibling's recovery window (D18), and still bite for any
 * unrelated loaded task placed inside that window. The late half (#b) ends at
 * the original occurrence end so its window is identical to the unsplit
 * whole's — splitting is never *less* restrictive than not splitting.
 */
function runHc15Splits(assert: AssertFn): void {
  // Parent guard occurrence 0h–4h with a recovery rule on shift 1.
  const parent: Task = {
    id: 'GR',
    name: 'GR',
    sourceName: 'guard',
    timeBlock: tb(0, 4),
    requiredCount: 1,
    slots: [{ slotId: 'GR-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false, // isolate HC-15 from HC-12
    baseLoadWeight: 1,
    sleepRecovery: { triggerShifts: [1], recoveryHours: 6 },
    shiftIndex: 1,
    splittable: true,
  };
  const Ga = makeSplitHalf(parent, 1, BASE, BASE + 2 * H, parent.slots[0]); // 0h–2h
  const Gb = makeSplitHalf(parent, 2, BASE + 2 * H, BASE + 4 * H, parent.slots[0]); // 2h–4h

  // The rule (and its triggerShifts array) is deep-copied, not shared.
  assert(
    !!Ga.sleepRecovery && Ga.sleepRecovery !== parent.sleepRecovery,
    'HC-15: half carries a distinct sleepRecovery copy (no shared ref)',
  );
  assert(
    Ga.sleepRecovery?.triggerShifts !== parent.sleepRecovery?.triggerShifts,
    'HC-15: triggerShifts array is deep-copied per half',
  );
  assert(Ga.shiftIndex === 1 && Gb.shiftIndex === 1, 'HC-15: shiftIndex inherited onto both halves (rule still fires)');

  // Each half independently triggers a recovery window from ITS OWN end.
  const wA = getRecoveryWindow(Ga);
  const wB = getRecoveryWindow(Gb);
  const wWhole = getRecoveryWindow(parent);
  assert(
    !!wA && wA.start.getTime() === BASE + 2 * H && wA.end.getTime() === BASE + 8 * H,
    'HC-15: #a recovery window = [its own end, +6h) = [2h, 8h)',
  );
  assert(
    !!wB && wB.start.getTime() === BASE + 4 * H && wB.end.getTime() === BASE + 10 * H,
    'HC-15: #b recovery window = [its own end, +6h) = [4h, 10h)',
  );
  assert(
    !!wWhole && wWhole.start.getTime() === wB?.start.getTime() && wWhole.end.getTime() === wB?.end.getTime(),
    'HC-15: late half (#b) window identical to the unsplit whole (split never less restrictive)',
  );

  // An unrelated loaded task inside #a's recovery window is rejected for the
  // #a holder. interfere=[3h,4h] ⊂ [2h,8h); not adjacent to Ga and not
  // overlapping it, so ONLY HC-15 can be the cause of rejection.
  const interfere: Task = {
    id: 'X',
    name: 'X',
    sourceName: 'patrol',
    timeBlock: tb(3, 4),
    requiredCount: 1,
    slots: [{ slotId: 'X-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
  };
  const tm = new Map<string, Task>([
    [Ga.id, Ga],
    [Gb.id, Gb],
    [interfere.id, interfere],
  ]);
  assert(
    checkSleepRecoveryForPlacement(interfere, [asg(Ga.id, 'P')], tm),
    'HC-15: a loaded task inside the split half’s recovery window is flagged (still enforced)',
  );
  const P = part('P', -1, 14);
  assert(
    !isEligible(P, interfere, interfere.slots[0], [asg(Ga.id, 'P')], tm),
    'HC-15: per-placement isEligible rejects that placement (chokepoint coverage for split halves)',
  );

  // Sibling exemption (D18): #b is never recovery-flagged by #a (and v.v.) for
  // the same person, so the two halves of one occurrence never self-violate.
  assert(
    !checkSleepRecoveryForPlacement(Gb, [asg(Ga.id, 'P')], tm),
    'HC-15: sibling half is exempt from the other half’s recovery window (D18)',
  );
  assert(
    checkSleepRecovery('P', [asg(Ga.id, 'P'), asg(Gb.id, 'P')], tm, 'P').length === 0,
    'HC-15: aggregate raises no sleep-recovery violation between two siblings (D18)',
  );
}

// ─── Hardening: multiple splittable occurrences in one schedule ──────────────

/**
 * Two independent splittable occurrences left unfilled by greedy both split,
 * each into two DIFFERENT participants, with no cross-contamination and a
 * clean split-sibling check. `countSplitOccurrences` counts each occurrence
 * exactly once (via `splitPart === 1`) — the same signal `splitPenalty` uses,
 * so the penalty scales per occurrence, not per half.
 */
function runMultiSplit(assert: AssertFn): void {
  const T1 = splitTask('T1', 0, 4, true);
  const T2 = splitTask('T2', 6, 10, true);
  const participants = [
    part('P1', -1, 2), // T1#a [0,2]
    part('P2', 2, 5), // T1#b [2,4]
    part('P3', 5, 8), // T2#a [6,8]
    part('P4', 8, 11), // T2#b [8,10]
  ];
  const taskMap = new Map<string, Task>([
    [T1.id, T1],
    [T2.id, T2],
  ]);
  const ctx: FeasibilitySplitCtx = {
    tasks: [T1, T2],
    taskMap,
    participants,
    assignments: [],
    assignmentsByParticipant: new Map(),
    workload: new Map(),
    dailyWorkload: new Map(),
    unfilledSlots: [
      { taskId: T1.id, slotId: T1.slots[0].slotId, reason: 'test', hcCodes: [] },
      { taskId: T2.id, slotId: T2.slots[0].slotId, reason: 'test', hcCodes: [] },
    ],
    dayStartHour: 5,
  };
  const out = applyFeasibilitySplits(ctx);

  assert(out.length === 4, 'multi-split: both occurrences split → 4 half-tasks');
  assert(
    countSplitOccurrences(out) === 2,
    'multi-split: countSplitOccurrences = 2 (one per occurrence; splitPenalty scales per occurrence not per half)',
  );
  assert(ctx.assignments.length === 4, 'multi-split: all four half-slots filled');
  assert(ctx.unfilledSlots.length === 0, 'multi-split: both original unfilled entries cleared');

  // Each occurrence's two halves go to two different people; nobody holds two
  // siblings (HC-16 invariant across multiple independent splits).
  const outMap = new Map(out.map((t) => [t.id, t]));
  for (const pid of ['P1', 'P2', 'P3', 'P4']) {
    const held = ctx.assignments.filter((a) => a.participantId === pid);
    assert(
      checkSplitSiblingDisjoint(pid, held, outMap, pid).length === 0,
      `multi-split: ${pid} holds no two split siblings`,
    );
  }
  const g1 = ctx.assignments.filter((a) => a.taskId.startsWith('T1'));
  const g2 = ctx.assignments.filter((a) => a.taskId.startsWith('T2'));
  assert(
    g1.length === 2 && g1[0].participantId !== g1[1].participantId,
    'multi-split: occurrence T1 split across two different participants',
  );
  assert(
    g2.length === 2 && g2[0].participantId !== g2[1].participantId,
    'multi-split: occurrence T2 split across two different participants',
  );
}

// ─── Hardening: split helps one task but the half still pressures elsewhere ──

/**
 * Splitting only coalesces SAME-source runs. A split half abutting an
 * adjacent DIFFERENT-source heavy task (or a different-source split half)
 * must STILL be rejected by HC-12 — the run-coalescer must not create a hole
 * where splitting one task silently legalises back-to-back heavy work with
 * an unrelated one. Same-source continuation stays allowed (note-6 contrast).
 */
function runHc12CrossSource(assert: AssertFn): void {
  const heavy = (id: string, sH: number, eH: number, src: string, gid?: string): Task => ({
    id,
    name: id,
    sourceName: src,
    timeBlock: tb(sH, eH),
    requiredCount: 1,
    slots: [{ slotId: `${id}-s`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: true,
    splitGroupId: gid,
    splitPart: gid ? 2 : undefined,
    splitOriginalMs: gid ? 4 * H : undefined,
  });
  const P = part('P', -1, 14);

  // Late guard half [2h,4h]; a DIFFERENT-source heavy WHOLE task starts the
  // instant it ends → not coalesced (different source) → HC-12 must fire.
  const gB = heavy('G#b', 2, 4, 'guard', 'G');
  const pat = heavy('PAT', 4, 8, 'patrol');
  const tmA = new Map<string, Task>([
    [gB.id, gB],
    [pat.id, pat],
  ]);
  assert(
    !isEligible(P, pat, pat.slots[0], [asg(gB.id, 'P')], tmA),
    'cross-source: split half then adjacent different-source heavy whole → HC-12 still rejects',
  );
  assert(
    !isEligible(P, gB, gB.slots[0], [asg(pat.id, 'P')], tmA),
    'cross-source: reverse order (whole then abutting split half) → HC-12 still rejects',
  );
  assert(
    checkNoConsecutiveHighLoad('P', [asg(gB.id, 'P'), asg(pat.id, 'P')], tmA).length > 0,
    'cross-source: aggregate HC-12 agrees (per-placement ≡ aggregate, no coalesce hole)',
  );

  // Two DIFFERENT-source split halves back-to-back → still rejected (splitting
  // patrol does not legalise it abutting a split guard half).
  const qA = heavy('Q#a', 4, 6, 'patrol', 'Q');
  const tmB = new Map<string, Task>([
    [gB.id, gB],
    [qA.id, qA],
  ]);
  assert(
    !isEligible(P, qA, qA.slots[0], [asg(gB.id, 'P')], tmB),
    'cross-source: split guard half then split patrol half (different sources) → HC-12 still rejects',
  );

  // Contrast / no over-rejection: SAME-source next-occurrence half continues
  // the legal ≤K run and is correctly ALLOWED (note-6).
  const g2A = heavy('G2#a', 4, 6, 'guard', 'G2');
  const tmC = new Map<string, Task>([
    [gB.id, gB],
    [g2A.id, g2A],
  ]);
  assert(
    isEligible(P, g2A, g2A.slots[0], [asg(gB.id, 'P')], tmC),
    'cross-source contrast: same-source contiguous ≤K half is still ACCEPTED (no over-rejection)',
  );
}

// ─── Slot-level splitting (multi-slot occurrences) ───────────────────────────

/** Multi-slot task: nSlots L0 slots, ids `${id}-s{i}`. */
function mkMulti(
  id: string,
  startH: number,
  endH: number,
  nSlots: number,
  o: { splittable?: boolean; sameGroup?: boolean } = {},
): Task {
  return {
    id,
    name: id,
    sourceName: 'guard',
    timeBlock: tb(startH, endH),
    requiredCount: nSlots,
    slots: Array.from({ length: nSlots }, (_, i) => ({
      slotId: `${id}-s${i}`,
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [],
    })),
    sameGroupRequired: o.sameGroup ?? false,
    blocksConsecutive: false,
    splittable: o.splittable ?? true,
  };
}
/** Participant with one availability window and an explicit group. */
function partG(id: string, aS: number, aE: number, group: string): Participant {
  return {
    id,
    name: id,
    level: Level.L0,
    certifications: [],
    group,
    availability: [{ start: new Date(BASE + aS * H), end: new Date(BASE + aE * H) }],
    dateUnavailability: [],
  };
}
function baseCtx(
  tasks: Task[],
  participants: Participant[],
  unfilled: Array<[string, string]>,
  preAssigned: Assignment[] = [],
): FeasibilitySplitCtx {
  const abp = new Map<string, Assignment[]>();
  for (const a of preAssigned) {
    const l = abp.get(a.participantId) ?? [];
    l.push(a);
    abp.set(a.participantId, l);
  }
  return {
    tasks: [...tasks],
    taskMap: new Map(tasks.map((t) => [t.id, t] as const)),
    participants,
    assignments: [...preAssigned],
    assignmentsByParticipant: abp,
    workload: new Map(),
    dailyWorkload: new Map(),
    unfilledSlots: unfilled.map(([taskId, slotId]) => ({ taskId, slotId, reason: 'test', hcCodes: [] })),
    dayStartHour: 5,
  };
}

/** (a)+(c)+(h): one slot stays whole (one person) while another slot of the
 *  SAME occurrence splits between two different people. */
function runSlotLevelMixed(assert: AssertFn): void {
  const T = mkMulti('M', 0, 4, 2); // slots M-s0, M-s1
  const P0 = part('P0', -1, 5); // can cover the WHOLE 4h slot
  const P1 = part('P1', -1, 2); // first half only
  const P2 = part('P2', 2, 5); // second half only
  const pre = asg('M', 'P0');
  pre.slotId = 'M-s0'; // s0 pre-filled whole; s1 left unfilled → must split
  const ctx = baseCtx([T], [P0, P1, P2], [['M', 'M-s1']], [pre]);
  const out = applyFeasibilitySplits(ctx);

  const resid = out.find((t) => t.id === 'M');
  assert(
    !!resid && resid.slots.length === 1 && resid.slots[0].slotId === 'M-s0',
    '(a) residual keeps the whole slot s0 (occurrence id unchanged)',
  );
  assert(
    resid?.splitGroupId === undefined && resid?.splitOccurrenceId === undefined,
    '(a) residual carries NO split metadata (it is a normal whole task)',
  );
  const ha = out.find((t) => t.id === 'M::M-s1#a');
  const hb = out.find((t) => t.id === 'M::M-s1#b');
  assert(
    ha?.splitGroupId === 'M::M-s1' && hb?.splitGroupId === 'M::M-s1',
    '(a) only slot s1 was split into a per-slot half pair',
  );
  assert(
    ha?.splitOccurrenceId === 'M' && hb?.splitOccurrenceId === 'M',
    '(a) halves keep splitOccurrenceId = M (ties them to the residual)',
  );
  assert(out.length === 3, '(a) occurrence → [residual, s1#a, s1#b]');

  const mAsg = ctx.assignments.find((x) => x.taskId === 'M');
  assert(
    mAsg?.participantId === 'P0' && mAsg?.slotId === 'M-s0',
    '(a) the whole-slot assignment is untouched (P0 still on M/M-s0)',
  );
  const pa = ctx.assignments.find((a) => a.taskId === 'M::M-s1#a')?.participantId;
  const pb = ctx.assignments.find((a) => a.taskId === 'M::M-s1#b')?.participantId;
  assert(
    !!pa && !!pb && pa !== pb && pa !== 'P0' && pb !== 'P0',
    '(c) split slot covered by two DIFFERENT people, neither is the whole-slot holder',
  );

  const om = new Map(out.map((t) => [t.id, t] as const));
  for (const pid of ['P0', pa!, pb!]) {
    assert(
      checkSplitSiblingDisjoint(pid, ctx.assignments, om, pid).length === 0,
      `(h) ${pid} holds no two split siblings`,
    );
  }
  const v = validateHardConstraints(out, [P0, P1, P2], ctx.assignments, undefined, new Map());
  const bad = v.violations.filter((x) => ['HC-5', 'HC-7', 'SPLIT_SIBLING_CONFLICT'].includes(x.code));
  assert(bad.length === 0, '(c)/(h) full validate: no HC-5 (whole vs halves disjoint), HC-7, or HC-16');
}

/** (b)+(e): two slots of one occurrence split independently (distinct
 *  per-slot splitGroupIds, no cross-slot people exclusion); all slots split
 *  ⇒ residual dropped; countSplitOccurrences counts split SLOTS. */
function runSlotLevelMultiSplit(assert: AssertFn): void {
  const T = mkMulti('N', 0, 4, 2); // N-s0, N-s1, both unfilled
  const A0 = part('A0', -1, 2);
  const B0 = part('B0', 2, 5);
  const A1 = part('A1', -1, 2);
  const B1 = part('B1', 2, 5);
  const ctx = baseCtx(
    [T],
    [A0, B0, A1, B1],
    [
      ['N', 'N-s0'],
      ['N', 'N-s1'],
    ],
  );
  const out = applyFeasibilitySplits(ctx);
  assert(!out.some((t) => t.id === 'N'), '(e) every slot split ⇒ residual dropped (no whole task left)');
  assert(
    out.length === 4 && out.every((t) => t.splitOccurrenceId === 'N'),
    '(b) occurrence → 4 half-tasks (two independent split slots)',
  );
  const gids = new Set(out.map((t) => t.splitGroupId));
  assert(
    gids.has('N::N-s0') && gids.has('N::N-s1') && gids.size === 2,
    '(b) two DISTINCT per-slot splitGroupIds (slots split independently)',
  );
  assert(ctx.assignments.length === 4, '(b) all four half-slots filled');
  assert(
    countSplitOccurrences(out) === 2,
    '(e) countSplitOccurrences = number of split SLOTS (2) — splitPenalty scales per split slot',
  );
  const om = new Map(out.map((t) => [t.id, t] as const));
  for (const p of [A0, B0, A1, B1]) {
    assert(
      checkSplitSiblingDisjoint(p.id, ctx.assignments, om, p.id).length === 0,
      `(b) ${p.id} holds no two halves of the SAME split slot`,
    );
  }
}

/** (d): one person legitimately holds s0#a + s1#b of the SAME occurrence — a
 *  continuous run HC-16 allows (different split slots). HC-15 must NOT
 *  recovery-flag it (splitOccurrenceId exemption) and aggregate HC-12 must be
 *  clean (run-coalescer + the step-7 delegation). */
function runHc15CrossSlotSameOccurrence(assert: AssertFn): void {
  const parent: Task = {
    id: 'OCC',
    name: 'OCC',
    sourceName: 'guard',
    timeBlock: tb(0, 4),
    requiredCount: 2,
    slots: [
      { slotId: 'OCC-s0', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      { slotId: 'OCC-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
    ],
    sameGroupRequired: false,
    blocksConsecutive: true, // would fire HC-12 if not coalesced
    baseLoadWeight: 1,
    sleepRecovery: { triggerShifts: [1], recoveryHours: 6 },
    shiftIndex: 1,
    splittable: true,
  };
  const s0a = makeSplitHalf(parent, 1, BASE, BASE + 2 * H, parent.slots[0]); // [0,2]
  const s1b = makeSplitHalf(parent, 2, BASE + 2 * H, BASE + 4 * H, parent.slots[1]); // [2,4]
  assert(
    s0a.splitGroupId !== s1b.splitGroupId,
    '(d) different split slots ⇒ different splitGroupId (HC-16 does not bind them)',
  );
  assert(
    s0a.splitOccurrenceId === 'OCC' && s1b.splitOccurrenceId === 'OCC',
    '(d) same occurrence ⇒ shared splitOccurrenceId',
  );
  const tm = new Map<string, Task>([
    [s0a.id, s0a],
    [s1b.id, s1b],
  ]);
  const ha = asg(s0a.id, 'P');
  ha.slotId = s0a.slots[0].slotId;
  const hb = asg(s1b.id, 'P');
  hb.slotId = s1b.slots[0].slotId;
  const held = [ha, hb];
  assert(
    checkSleepRecovery('P', held, tm, 'P').length === 0,
    '(d) HC-15 clean: same-occurrence continuous run is exempt (splitOccurrenceId)',
  );
  assert(
    checkNoConsecutiveHighLoad('P', held, tm).length === 0,
    '(d) aggregate HC-12 clean: contiguous ≤K same-occurrence run coalesces to one block',
  );
  assert(
    coalesceTaskRuns([s0a, s1b]).length === 1,
    '(d) the two same-occurrence halves coalesce into one full-occurrence block',
  );
}

/** (i): strict same-group split — residual whole slot + both halves of the
 *  split slot must all come from ONE group; a mixed-group realization is
 *  rejected (HC-4 link-union → GROUP_MISMATCH); the all-slots-split variant
 *  (no residual anchor) is still validated exactly once. */
function runSameGroupStrictSplit(assert: AssertFn): void {
  const T = mkMulti('SG', 0, 4, 2, { sameGroup: true });
  const M1 = partG('M1', -1, 5, 'g1'); // whole-capable
  const M2 = partG('M2', -1, 2, 'g1'); // 1st half
  const M3 = partG('M3', 2, 5, 'g1'); // 2nd half
  const G2X = partG('G2X', 100, 101, 'g2'); // never available in [0,4]
  const ctx = baseCtx(
    [T],
    [M1, M2, M3, G2X],
    [
      ['SG', 'SG-s0'],
      ['SG', 'SG-s1'],
    ],
  );
  const out = applyFeasibilitySplits(ctx);

  const resid = out.find((t) => t.id === 'SG');
  const splitHalves = out.filter((t) => t.splitOccurrenceId === 'SG');
  assert(splitHalves.length === 2, '(i) exactly one slot was split (1 half pair)');
  assert(
    !!resid && resid.slots.length === 1 && resid.sameGroupLinkId === 'SG',
    '(i) residual whole slot carries sameGroupLinkId = occurrence id',
  );
  assert(
    splitHalves.every((t) => t.sameGroupLinkId === 'SG'),
    '(i) both halves carry the same sameGroupLinkId',
  );
  const grpOf = (pid: string) => [M1, M2, M3, G2X].find((p) => p.id === pid)!.group;
  const groups = new Set(ctx.assignments.map((a) => grpOf(a.participantId)));
  assert(
    ctx.assignments.length === 3 && groups.size === 1 && groups.has('g1'),
    '(i) all three coverers (whole + both halves) are from the SAME group g1',
  );
  const vOk = validateHardConstraints(out, [M1, M2, M3, G2X], ctx.assignments, undefined, new Map());
  assert(
    vOk.violations.filter((x) => x.code === 'GROUP_INSUFFICIENT' || x.code === 'GROUP_MISMATCH').length === 0,
    '(i) HC-8/HC-4 link-union accept the strict one-group split',
  );

  // Mixed-group realization is rejected by the HC-4 link-union.
  const Z = partG('Z', -1, 5, 'gZ');
  const cross = ctx.assignments.map((a) => ({ ...a }));
  const crossA = cross.find((a) => a.taskId.endsWith('#a'))!;
  crossA.participantId = 'Z';
  const vBad = validateHardConstraints(out, [M1, M2, M3, G2X, Z], cross, undefined, new Map());
  assert(
    vBad.violations.some((x) => x.code === 'GROUP_MISMATCH'),
    '(i) HC-4 link-union REJECTS a mixed-group realization of a split occurrence',
  );

  // All-slots-split variant: no member covers the slot whole ⇒ residual
  // dropped; HC-8/HC-4 still validate the link exactly once (no anchor).
  const T2 = mkMulti('SG2', 0, 4, 1, { sameGroup: true });
  const N2 = partG('N2', -1, 2, 'h1');
  const N3 = partG('N3', 2, 5, 'h1');
  const c2 = baseCtx([T2], [N2, N3], [['SG2', 'SG2-s0']]);
  const o2 = applyFeasibilitySplits(c2);
  assert(
    !o2.some((t) => t.id === 'SG2') && o2.length === 2,
    '(i) all-slots-split ⇒ residual dropped, only the half pair remains',
  );
  assert(
    o2.every((t) => t.sameGroupLinkId === 'SG2'),
    '(i) halves still carry sameGroupLinkId with no residual anchor',
  );
  const v2 = validateHardConstraints(o2, [N2, N3], c2.assignments, undefined, new Map());
  assert(
    v2.violations.filter((x) => x.code === 'GROUP_INSUFFICIENT' || x.code === 'GROUP_MISMATCH').length === 0,
    '(i) HC-8/HC-4 link processed once even when the residual is absent',
  );
}

// ─── Review regressions: optimizer/precheck ≡ final validator ───────────────

const l0Slot = (sid: string) => ({
  slotId: sid,
  acceptableLevels: [{ level: Level.L0 }],
  requiredCertifications: [] as string[],
});
/** A split sameGroupRequired occurrence O: residual `Tr` (whole slot O-s0) +
 *  half pair for slot O-s1, all sharing `sameGroupLinkId='O'`. */
function splitSameGroupOccurrence(): { Tr: Task; Sa: Task; Sb: Task } {
  const common = {
    name: 'O',
    sourceName: 'O',
    sameGroupRequired: true,
    blocksConsecutive: false,
  };
  const Tr: Task = {
    ...common,
    id: 'O',
    timeBlock: tb(0, 4),
    requiredCount: 1,
    slots: [l0Slot('O-s0')],
    sameGroupLinkId: 'O',
  };
  const Sa: Task = {
    ...common,
    id: 'O::O-s1#a',
    name: 'O (1/2)',
    timeBlock: tb(0, 2),
    requiredCount: 1,
    slots: [l0Slot('O-s1#a')],
    splitGroupId: 'O::O-s1',
    splitPart: 1,
    splitOriginalMs: 4 * H,
    splitOccurrenceId: 'O',
    sameGroupLinkId: 'O',
  };
  const Sb: Task = {
    ...Sa,
    id: 'O::O-s1#b',
    name: 'O (2/2)',
    timeBlock: tb(2, 4),
    slots: [l0Slot('O-s1#b')],
    splitPart: 2,
  };
  return { Tr, Sa, Sb };
}
function asgS(taskId: string, slotId: string, pid: string): Assignment {
  return {
    id: `as-${taskId}-${pid}`,
    taskId,
    slotId,
    participantId: pid,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(BASE),
  };
}

/** (k) Bug A — SA `isSwapFeasible` HC-4 must be LINK-aware: a swap that puts a
 *  wrong-group participant onto any fragment of a split sameGroupRequired
 *  occurrence must be rejected (else SA emits a schedule the link-aware final
 *  validator flags GROUP_MISMATCH — optimizer ≢ final). */
function runSameGroupSplitSwapGate(assert: AssertFn): void {
  const { Tr, Sa, Sb } = splitSameGroupOccurrence();
  const U: Task = {
    id: 'U',
    name: 'U',
    sourceName: 'U',
    timeBlock: tb(10, 12),
    requiredCount: 1,
    slots: [l0Slot('U-s')],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskMap = new Map<string, Task>([Tr, Sa, Sb, U].map((t) => [t.id, t] as const));
  const A = partG('A', -1, 14, 'g1');
  const B = partG('B', -1, 14, 'g1');
  const C = partG('C', -1, 14, 'g1');
  const Z = partG('Z', -1, 14, 'g2');
  const pMap = new Map<string, Participant>([A, B, C, Z].map((p) => [p.id, p] as const));

  // Post-swap world: B (was on Sa) ↔ Z (was on U) ⇒ Z(g2) now on the split
  // same-group fragment Sa; the link unit O spans groups {g1, g2}.
  const aA = asgS('O', 'O-s0', 'A');
  const aSa = asgS('O::O-s1#a', 'O-s1#a', 'Z'); // post-swap owner
  const aC = asgS('O::O-s1#b', 'O-s1#b', 'C');
  const aU = asgS('U', 'U-s', 'B'); // post-swap owner
  const candidate = [aA, aSa, aC, aU];
  const byParticipant = new Map<string, Assignment[]>([
    ['A', [aA]],
    ['Z', [aSa]],
    ['C', [aC]],
    ['B', [aU]],
  ]);
  const byTask = new Map<string, Assignment[]>([
    ['O', [aA]],
    ['O::O-s1#a', [aSa]],
    ['O::O-s1#b', [aC]],
    ['U', [aU]],
  ]);
  // idxI = Sa (now Z), idxJ = U (now B).
  assert(
    !isSwapFeasible(candidate, 1, 3, taskMap, pMap, byParticipant, byTask),
    '(k) SA isSwapFeasible REJECTS a cross-group swap onto a split same-group fragment (link-aware HC-4)',
  );
  // Final validator agrees → optimizer ≡ final (the property the fix restores).
  const v = validateHardConstraints([Tr, Sa, Sb, U], [A, B, C, Z], candidate, undefined, new Map());
  assert(
    v.violations.some((x) => x.code === 'GROUP_MISMATCH'),
    '(k) final validateHardConstraints also flags GROUP_MISMATCH on that state (consistency)',
  );

  // Control: a GROUP-PRESERVING swap — replace the residual O-s0 holder A(g1)
  // with another g1 member D (D was on an unrelated task V). The link O stays
  // all-g1, so the link-aware HC-4 must NOT over-reject it.
  const V: Task = {
    id: 'V',
    name: 'V',
    sourceName: 'V',
    timeBlock: tb(6, 8),
    requiredCount: 1,
    slots: [l0Slot('V-s')],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const taskMap2 = new Map<string, Task>([Tr, Sa, Sb, V].map((t) => [t.id, t] as const));
  const D = partG('D', -1, 14, 'g1');
  const pMap2 = new Map<string, Participant>([A, B, C, D].map((p) => [p.id, p] as const));
  const cO = asgS('O', 'O-s0', 'D'); // post-swap: D(g1) now on residual O-s0
  const cSa = asgS('O::O-s1#a', 'O-s1#a', 'B');
  const cSb = asgS('O::O-s1#b', 'O-s1#b', 'C');
  const cV = asgS('V', 'V-s', 'A'); // post-swap: A now on V
  const cand2 = [cO, cSa, cSb, cV];
  const bp2 = new Map<string, Assignment[]>([
    ['D', [cO]],
    ['B', [cSa]],
    ['C', [cSb]],
    ['A', [cV]],
  ]);
  const bt2 = new Map<string, Assignment[]>([
    ['O', [cO]],
    ['O::O-s1#a', [cSa]],
    ['O::O-s1#b', [cSb]],
    ['V', [cV]],
  ]);
  // Swap O-s0 (now D) ↔ V (now A): the link unit O = {D,B,C} all g1.
  assert(
    isSwapFeasible(cand2, 0, 3, taskMap2, pMap2, bp2, bt2),
    '(k) control: a group-preserving swap on a split same-group link is still ACCEPTED (no over-rejection)',
  );
}

/** (l) Bug B — `checkSleepRecoveryForPlacement` Direction 2 must apply the
 *  same `splitOccurrenceId` exemption as Direction 1 / the aggregate, so a
 *  legitimate same-occurrence continuous run is HC-15-clean regardless of
 *  placement order (per-placement ≡ aggregate). */
function runHc15Dir2SameOccurrence(assert: AssertFn): void {
  const parent: Task = {
    id: 'OCC',
    name: 'OCC',
    sourceName: 'guard',
    timeBlock: tb(0, 4),
    requiredCount: 2,
    slots: [l0Slot('OCC-s0'), l0Slot('OCC-s1')],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
    sleepRecovery: { triggerShifts: [1], recoveryHours: 6 },
    shiftIndex: 1,
    splittable: true,
  };
  const s0a = makeSplitHalf(parent, 1, BASE, BASE + 2 * H, parent.slots[0]); // [0,2]
  const s1b = makeSplitHalf(parent, 2, BASE + 2 * H, BASE + 4 * H, parent.slots[1]); // [2,4]
  const tm = new Map<string, Task>([
    [s0a.id, s0a],
    [s1b.id, s1b],
  ]);
  const hold1b = [asgS(s1b.id, s1b.slots[0].slotId, 'P')];
  const hold0a = [asgS(s0a.id, s0a.slots[0].slotId, 'P')];
  // Direction 2 (candidate triggers ownWindow, existing is the loaded task):
  // placing s0a while already holding the later s1b of the SAME occurrence.
  assert(
    checkSleepRecoveryForPlacement(s0a, hold1b, tm) === false,
    '(l) HC-15 Direction-2 exempt: place s0#a while holding same-occurrence s1#b → NOT flagged',
  );
  // Direction 1 (existing triggers, candidate is the loaded task): the
  // mirror order — already clean before, must remain clean.
  assert(
    checkSleepRecoveryForPlacement(s1b, hold0a, tm) === false,
    '(l) HC-15 Direction-1 exempt: place s1#b while holding same-occurrence s0#a → NOT flagged',
  );
  // Per-placement now ≡ aggregate (which was already clean).
  assert(
    checkSleepRecovery('P', [asgS(s0a.id, s0a.slots[0].slotId, 'P'), asgS(s1b.id, s1b.slots[0].slotId, 'P')], tm, 'P')
      .length === 0,
    '(l) aggregate HC-15 clean for the same-occurrence run (per-placement ≡ aggregate)',
  );
  // s0a/s1b are L0, P always-available, non-blocking, no cert/rest rule, and
  // HC-5/7/16 don't bind a same-occurrence cross-slot pair ⇒ HC-15 is the
  // ONLY possible blocker, so `isEligible === true` proves it's exempt.
  const P = partG('P', -1, 14, 'g1');
  assert(
    isEligible(P, s0a, s0a.slots[0], hold1b, tm) === true && isEligible(P, s1b, s1b.slots[0], hold0a, tm) === true,
    '(l) isEligible HC-15 clean in BOTH placement orders for the same-occurrence run',
  );
  // Negative control: an UNRELATED loaded task inside s0#a's recovery window
  // (different occurrence, no splitOccurrenceId) must STILL be rejected by
  // Direction 2 — the exemption must not over-broaden.
  const interfere: Task = {
    id: 'X',
    name: 'X',
    sourceName: 'patrol',
    timeBlock: tb(3, 4),
    requiredCount: 1,
    slots: [l0Slot('X-s')],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
  };
  const tm2 = new Map<string, Task>([
    [s0a.id, s0a],
    [interfere.id, interfere],
  ]);
  assert(
    checkSleepRecoveryForPlacement(s0a, [asgS(interfere.id, 'X-s', 'P')], tm2) === true,
    '(l) negative control: Direction-2 still flags an unrelated loaded task in the recovery window',
  );
}

/** (m) Bug A (per-placement side) — `getCandidatesWithEligibility` must be
 *  LINK-aware for a split sameGroupRequired occurrence: a wrong-group
 *  candidate for an unfilled fragment slot is greyed with HC-4 (so the swap
 *  picker / rescue enumeration agree with the final validator). */
function runPerPlacementHc4Link(assert: AssertFn): void {
  const { Tr, Sa, Sb } = splitSameGroupOccurrence();
  const A = partG('A', -1, 14, 'g1');
  const B = partG('B', -1, 14, 'g1');
  const G1c = partG('G1c', -1, 14, 'g1');
  const G2 = partG('G2', -1, 14, 'g2');
  // Tr/O-s0 and Sa/O-s1#a filled by g1; Sb/O-s1#b UNFILLED.
  const current = [asgS('O', 'O-s0', 'A'), asgS('O::O-s1#a', 'O-s1#a', 'B')];
  const rows = getCandidatesWithEligibility(Sb, 'O-s1#b', [A, B, G1c, G2], current, [Tr, Sa, Sb]);
  const g2row = rows.find((r) => r.participant.id === 'G2');
  const g1row = rows.find((r) => r.participant.id === 'G1c');
  assert(
    g2row?.eligible === false && g2row?.rejectionCode === 'HC-4',
    '(m) wrong-group candidate for a split same-group fragment is greyed HC-4 (link-aware precheck)',
  );
  assert(g1row?.eligible === true, '(m) a same-group candidate remains eligible (no over-rejection)');

  // Zero-regression control: a NORMAL (non-same-group) task is unaffected by
  // the link logic — any-group candidate stays eligible.
  const plain: Task = {
    id: 'PL',
    name: 'PL',
    sourceName: 'PL',
    timeBlock: tb(0, 4),
    requiredCount: 1,
    slots: [l0Slot('PL-s')],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const prows = getCandidatesWithEligibility(plain, 'PL-s', [A, G2], [], [plain]);
  assert(
    prows.find((r) => r.participant.id === 'G2')?.eligible === true,
    '(m) control: non-same-group task — link logic inert, any-group candidate eligible',
  );
}

/** (j): the HC-12 aggregate fix is byte-identical for non-split schedules
 *  (zero regression) — adjacent blocking whole tasks still flagged, a gap
 *  still clears. */
function runHc12AggFixIsolation(assert: AssertFn): void {
  const w1 = gTask('AW1', 0, 4);
  const w2 = gTask('AW2', 4, 8);
  const p = part('P', -1, 14);
  const vio = validateHardConstraints([w1, w2], [p], [asg(w1.id, 'P'), asg(w2.id, 'P')], undefined, new Map());
  assert(
    vio.violations.some((x) => x.code === 'CONSECUTIVE_HIGH_LOAD'),
    '(j) non-split adjacent blocking tasks still flagged by aggregate HC-12 (zero regression)',
  );
  const w3 = gTask('AW3', 6, 10);
  const vio2 = validateHardConstraints([w1, w3], [p], [asg(w1.id, 'P'), asg(w3.id, 'P')], undefined, new Map());
  assert(
    !vio2.violations.some((x) => x.code === 'CONSECUTIVE_HIGH_LOAD'),
    '(j) non-adjacent tasks → no aggregate HC-12 (unchanged behavior)',
  );
}

// ── Phase 2: scoring honesty + structural refine (quality split / merge) ─────
function runPhase2(assert: AssertFn): void {
  const approx = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const asg = (taskId: string, slotId: string, pid: string): Assignment => ({
    id: `a-${taskId}-${slotId}-${pid}`,
    taskId,
    slotId,
    participantId: pid,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(BASE),
  });
  // Task with explicit L0 slots (mk defaults to acceptableLevels:[]).
  const l0Task = (id: string, sH: number, eH: number, nSlots = 1, splittable = false): Task => ({
    id,
    name: id,
    sourceName: 'guard',
    timeBlock: tb(sH, eH),
    requiredCount: nSlots,
    slots: Array.from({ length: nSlots }, (_, i) => ({
      slotId: `${id}-s${i}`,
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [],
    })),
    sameGroupRequired: false,
    blocksConsecutive: false,
    splittable,
  });

  // (a) fragmentShare — identity for non-split, time-proportional for halves.
  {
    const T = l0Task('FS', 0, 12);
    const Sa = makeSplitHalf(T, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), T.slots[0]);
    const Sb = makeSplitHalf(T, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), T.slots[0]);
    assert(fragmentShare(T) === 1, '(p2) fragmentShare = 1 for a non-split task (identity)');
    assert(
      approx(fragmentShare(Sa), 0.5) && approx(fragmentShare(Sb), 0.5),
      '(p2) fragmentShare = 0.5 for each equal half; halves sum to 1',
    );
  }

  // (b) SC-9 not-with — byte-identical when not split, 0 across one split slot,
  //     overlap-proportional across overlapping fragments of one occurrence.
  {
    const cfg: SchedulerConfig = { ...DEFAULT_CONFIG };
    // The app always stores not-with symmetrically (the UI syncs both
    // directions); the shared kernel keeps the legacy directional detection
    // so non-split scoring stays byte-identical, and aggregate ≡ Σ twin holds
    // by construction regardless.
    const nw = new Map([
      ['p1', new Set(['p2'])],
      ['p2', new Set(['p1'])],
    ]);
    // Non-split: one occurrence, two slots, p1 & p2 co-present full span.
    const W: Task = { ...l0Task('W', 0, 12, 2), togethernessRelevant: true };
    const wAsg = [asg('W', 'W-s0', 'p1'), asg('W', 'W-s1', 'p2')];
    const nonSplit = computeNotWithPenalty(wAsg, cfg, new Map([['W', W]]), new Map([['W', wAsg]]), nw);
    assert(approx(nonSplit, cfg.notWithPenalty), '(p2) SC-9 non-split pair = full notWithPenalty (byte-identical)');

    // Same split SLOT: #a [0,6] / #b [6,12] — disjoint ⇒ never co-present ⇒ 0.
    const T: Task = { ...l0Task('OCC', 0, 12, 1), togethernessRelevant: true };
    const Sa = makeSplitHalf(T, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), T.slots[0]);
    const Sb = makeSplitHalf(T, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), T.slots[0]);
    const sAsg = [asg(Sa.id, Sa.slots[0].slotId, 'p1'), asg(Sb.id, Sb.slots[0].slotId, 'p2')];
    const sameSlot = computeNotWithPenalty(
      sAsg,
      cfg,
      new Map([
        [Sa.id, Sa],
        [Sb.id, Sb],
      ]),
      new Map([
        [Sa.id, [sAsg[0]]],
        [Sb.id, [sAsg[1]]],
      ]),
      nw,
    );
    assert(sameSlot === 0, '(p2) SC-9 not-with pair split across one slot #a/#b = 0 (never co-present)');

    // Overlapping fragments of ONE occurrence: residual slot [0,12] + #a [0,6]
    // ⇒ overlap 6h of 12h ⇒ half the penalty.
    const R: Task = { ...l0Task('OCC2', 0, 12, 1), togethernessRelevant: true };
    const Ta: Task = { ...l0Task('OCC2', 0, 12, 1), togethernessRelevant: true };
    const A = makeSplitHalf(Ta, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), Ta.slots[0]);
    const oAsg = [asg('OCC2', 'OCC2-s0', 'p2'), asg(A.id, A.slots[0].slotId, 'p1')];
    const prop = computeNotWithPenalty(
      oAsg,
      cfg,
      new Map<string, Task>([
        ['OCC2', R],
        [A.id, A],
      ]),
      new Map([
        ['OCC2', [oAsg[0]]],
        [A.id, [oAsg[1]]],
      ]),
      nw,
    );
    assert(
      approx(prop, cfg.notWithPenalty * 0.5),
      '(p2) SC-9 overlap-proportional across one occurrence (½ overlap ⇒ ½ penalty)',
    );
  }

  // (c) SC-6 low-priority — fragment-scaled.
  {
    const cfg: SchedulerConfig = { ...DEFAULT_CONFIG };
    const lpTask = (id: string): Task => ({
      ...l0Task(id, 0, 12, 1),
      slots: [
        { slotId: `${id}-s0`, acceptableLevels: [{ level: Level.L0, lowPriority: true }], requiredCertifications: [] },
      ],
    });
    const p1 = part('p1', 0, 24);
    const p2 = part('p2', 0, 24);
    const Tw = lpTask('LPW');
    const whole = computeLowPriorityLevelPenalty([p1], [asg('LPW', 'LPW-s0', 'p1')], [Tw], cfg);
    assert(approx(whole, cfg.lowPriorityLevelPenalty), '(p2) SC-6 whole lowPriority = full penalty (byte-identical)');
    const Tt = lpTask('LPS');
    const Sa = makeSplitHalf(Tt, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), Tt.slots[0]);
    const Sb = makeSplitHalf(Tt, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), Tt.slots[0]);
    const half = computeLowPriorityLevelPenalty([p1], [asg(Sa.id, Sa.slots[0].slotId, 'p1')], [Sa], cfg);
    assert(approx(half, cfg.lowPriorityLevelPenalty * 0.5), '(p2) SC-6 one lowPriority half = ½ penalty');
    const both = computeLowPriorityLevelPenalty(
      [p1, p2],
      [asg(Sa.id, Sa.slots[0].slotId, 'p1'), asg(Sb.id, Sb.slots[0].slotId, 'p2')],
      [Sa, Sb],
      cfg,
    );
    assert(
      approx(both, cfg.lowPriorityLevelPenalty),
      '(p2) SC-6 both lowPriority halves of one slot = exactly one whole penalty (no double-charge)',
    );
  }

  // (d) SC-10 task preference — avoidance & bonus fragment-scaled, binary kept.
  {
    const cfg: SchedulerConfig = { ...DEFAULT_CONFIG };
    const avoider: Participant = { ...part('av', 0, 24), lessPreferredTaskName: 'guard' };
    const fan: Participant = { ...part('fan', 0, 24), preferredTaskName: 'guard' };
    const Tw = l0Task('PW', 0, 12, 1);
    const wholeAvoid = computeTaskNamePreferencePenalty(
      [avoider],
      cfg,
      new Map([['PW', Tw]]),
      new Map([['av', [asg('PW', 'PW-s0', 'av')]]]),
    );
    assert(approx(wholeAvoid, cfg.taskNameAvoidancePenalty), '(p2) SC-10 whole avoidance = full (byte-identical)');
    const Tt = l0Task('PS', 0, 12, 1);
    const Sa = makeSplitHalf(Tt, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), Tt.slots[0]);
    const halfAvoid = computeTaskNamePreferencePenalty(
      [avoider],
      cfg,
      new Map([[Sa.id, Sa]]),
      new Map([['av', [asg(Sa.id, Sa.slots[0].slotId, 'av')]]]),
    );
    assert(approx(halfAvoid, cfg.taskNameAvoidancePenalty * 0.5), '(p2) SC-10 half avoidance = ½ (no double-charge)');
    // Fan on a single half: bonus is ½, and the binary "got their preferred"
    // is still satisfied (no +taskNamePreferencePenalty miss).
    const halfFan = computeTaskNamePreferencePenalty(
      [fan],
      cfg,
      new Map([[Sa.id, Sa]]),
      new Map([['fan', [asg(Sa.id, Sa.slots[0].slotId, 'fan')]]]),
    );
    assert(
      approx(halfFan, -cfg.taskNamePreferenceBonus * 0.5),
      '(p2) SC-10 half preferred = ½ bonus AND binary preference satisfied (no miss penalty)',
    );
  }

  // (e) structuralRefine — identity fast path (no splittable, no split).
  {
    const T = l0Task('NS', 0, 12, 1, /*splittable*/ false);
    const best = [asg('NS', 'NS-s0', 'p1')];
    const tasks = [T];
    const ps = [part('p1', 0, 24)];
    const r = structuralRefine(
      best,
      tasks,
      ps,
      { ...DEFAULT_CONFIG },
      new Set(),
      new Map(ps.map((p) => [p.id, p])),
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    assert(
      r.changed === false && r.tasks === tasks && r.assignments === best,
      '(p2) structuralRefine identity fast path: same refs, changed=false',
    );
  }

  // (f) structuralRefine — quality split: penalty IS the gate (commit at 0, reject when huge).
  {
    const ps = [part('p1', 0, 24), part('p2', 0, 24), part('p3', 0, 24)];
    const pMap = new Map(ps.map((p) => [p.id, p]));
    const mkScenario = () => {
      const T = l0Task('Q', 0, 12, 1, true);
      return { tasks: [T], best: [asg('Q', 'Q-s0', 'p1')] };
    };
    const s1 = mkScenario();
    const commit = structuralRefine(
      s1.best,
      s1.tasks,
      ps,
      { ...DEFAULT_CONFIG, splitPenalty: 0 },
      new Set(),
      pMap,
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    const halves = commit.tasks.filter((t) => t.splitGroupId !== undefined);
    assert(
      commit.changed === true && halves.length === 2 && !commit.tasks.some((t) => t.id === 'Q'),
      '(p2) structuralRefine commits a quality split when it strictly improves (splitPenalty 0)',
    );
    assert(
      new Set(commit.assignments.filter((a) => a.taskId.startsWith('Q::')).map((a) => a.participantId)).size === 2,
      '(p2) the two halves go to two DIFFERENT people (HC-16 honoured at selection)',
    );
    const s2 = mkScenario();
    const reject = structuralRefine(
      s2.best,
      s2.tasks,
      ps,
      { ...DEFAULT_CONFIG, splitPenalty: 1e9 },
      new Set(),
      pMap,
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    assert(
      reject.changed === false && reject.tasks === s2.tasks,
      '(p2) structuralRefine REJECTS the same split when splitPenalty is prohibitive (penalty is the gate)',
    );
  }

  // (g) structuralRefine — merge a degenerate split back when penalty no longer earned.
  {
    const ps = [part('p1', 0, 24), part('p2', 0, 24)];
    const pMap = new Map(ps.map((p) => [p.id, p]));
    const T = l0Task('M', 0, 12, 1, true);
    const Sa = makeSplitHalf(T, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), T.slots[0]);
    const Sb = makeSplitHalf(T, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), T.slots[0]);
    const best = [asg(Sa.id, Sa.slots[0].slotId, 'p1'), asg(Sb.id, Sb.slots[0].slotId, 'p2')];
    const r = structuralRefine(
      best,
      [Sa, Sb],
      ps,
      { ...DEFAULT_CONFIG, splitPenalty: 1e9 },
      new Set(),
      pMap,
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    assert(
      r.changed === true && r.tasks.length === 1 && r.tasks[0].id === 'M' && r.tasks[0].splitGroupId === undefined,
      '(p2) structuralRefine MERGES a degenerate split back into the whole occurrence when the penalty is no longer earned',
    );
    assert(
      r.assignments.filter((a) => a.taskId === 'M').length === 1 && !r.assignments.some((a) => a.taskId.includes('#')),
      '(p2) merge leaves exactly one whole assignment and no #a/#b fragments',
    );
  }

  // (h) structuralRefine — merge self-guard: never create an unfilled slot.
  {
    const ps = [part('p1', 0, 24), part('p2', 0, 24)]; // all L0
    const pMap = new Map(ps.map((p) => [p.id, p]));
    // Whole slot requires L4 — nobody eligible ⇒ merge must be skipped (the
    // soft composite can't see an unfilled slot, so the guard is structural).
    const T: Task = {
      ...l0Task('U', 0, 12, 1, true),
      slots: [{ slotId: 'U-s0', acceptableLevels: [{ level: Level.L4 }], requiredCertifications: [] }],
    };
    const Sa = makeSplitHalf(T, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), T.slots[0]);
    const Sb = makeSplitHalf(T, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), T.slots[0]);
    const best = [asg(Sa.id, Sa.slots[0].slotId, 'p1'), asg(Sb.id, Sb.slots[0].slotId, 'p2')];
    const r = structuralRefine(
      best,
      [Sa, Sb],
      ps,
      { ...DEFAULT_CONFIG, splitPenalty: 1e9 },
      new Set(),
      pMap,
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    assert(
      r.changed === false,
      '(p2) structuralRefine does NOT merge when the whole slot has no eligible participant (no hidden unfilled slot)',
    );
  }

  // (i) structuralRefine — a pinned occurrence is never split.
  {
    const ps = [part('p1', 0, 24), part('p2', 0, 24), part('p3', 0, 24)];
    const pMap = new Map(ps.map((p) => [p.id, p]));
    const T = l0Task('PIN', 0, 12, 1, true);
    const a = asg('PIN', 'PIN-s0', 'p1');
    const r = structuralRefine(
      [a],
      [T],
      ps,
      { ...DEFAULT_CONFIG, splitPenalty: 0 },
      new Set([a.id]),
      pMap,
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );
    assert(r.changed === false, '(p2) structuralRefine never splits a pinned/Manual/Frozen occurrence');
  }

  // (j) structuralRefine — cross-task HC is enforced during staffing.
  // Regression guard for the bug where pickEligible passed a single-task
  // taskMap, so checkEligibility could not resolve a candidate's OTHER
  // assignments ⇒ HC-5/12/14/15 silently skipped. Q[0,12] is splittable;
  // only p2 is available for the #a half [0,6] (p1/p3 unavailable then).
  // With a conflicting BLK[0,6] on p2 the only #a candidate is double-booked,
  // so the split MUST be refused; remove BLK and the same split commits —
  // proving the refusal was the HC-5 check, not an unrelated block.
  {
    const ps = [part('p1', 6, 24), part('p2', 0, 24), part('p3', 6, 24)];
    const pMap = new Map(ps.map((p) => [p.id, p]));
    const refine = (tasks: Task[], best: Assignment[]) =>
      structuralRefine(
        best,
        tasks,
        ps,
        { ...DEFAULT_CONFIG, splitPenalty: 0 },
        new Set(),
        pMap,
        undefined,
        undefined,
        undefined,
        5,
        new Map(),
        new Map(),
        undefined,
        true,
      );
    const Q = l0Task('Q', 0, 12, 1, true);
    const BLK = l0Task('BLK', 0, 6, 1, false);
    const withConflict = refine([Q, BLK], [asg('Q', 'Q-s0', 'p1'), asg('BLK', 'BLK-s0', 'p2')]);
    assert(
      withConflict.changed === false && !withConflict.tasks.some((t) => t.splitGroupId !== undefined),
      '(p2) quality split REFUSED when the only eligible half-staffing would double-book (HC-5 enforced via full taskMap)',
    );
    const noConflict = refine([Q], [asg('Q', 'Q-s0', 'p1')]);
    const halves = noConflict.tasks.filter((t) => t.splitGroupId !== undefined);
    assert(
      noConflict.changed === true && halves.length === 2,
      '(p2) the SAME split commits once the HC-5 conflict is removed (control — refusal was the HC check)',
    );
    assert(
      validateHardConstraints(noConflict.tasks, ps, noConflict.assignments, undefined).violations.length === 0,
      '(p2) the committed split is HC-valid (no double-booking / cross-task violation)',
    );
  }
}

// ── Phase 2: same-group MERGE (sgm) ──────────────────────────────────────────
function runPhase2SameGroupMerge(assert: AssertFn): void {
  const asg = (taskId: string, slotId: string, pid: string): Assignment => ({
    id: `a-${taskId}-${slotId}-${pid}`,
    taskId,
    slotId,
    participantId: pid,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(BASE),
  });
  // structuralRefine boilerplate (matches runPhase2's calling convention).
  const refine = (tasks: Task[], best: Assignment[], ps: Participant[], splitPenalty: number) =>
    structuralRefine(
      best,
      tasks,
      ps,
      { ...DEFAULT_CONFIG, splitPenalty },
      new Set(),
      new Map(ps.map((p) => [p.id, p])),
      undefined,
      undefined,
      undefined,
      5,
      new Map(),
      new Map(),
      undefined,
      true,
    );

  // (sgm-1) Same-group MERGE collapses a stale Stage-4 split; the merged
  // whole slot's incumbent comes from the link's surviving group.
  {
    const { Tr, Sa, Sb } = splitSameGroupOccurrence();
    const ps = [
      partG('g1a', 0, 24, 'g1'),
      partG('g1b', 0, 24, 'g1'),
      partG('g1c', 0, 24, 'g1'),
      partG('g2a', 0, 24, 'g2'),
    ];
    const best = [asg('O', 'O-s0', 'g1a'), asg(Sa.id, 'O-s1#a', 'g1b'), asg(Sb.id, 'O-s1#b', 'g1c')];
    const r = refine([Tr, Sa, Sb], best, ps, /*splitPenalty*/ 1e9);
    const merged = r.tasks.find((t) => t.id === 'O');
    const halves = r.tasks.filter((t) => t.splitGroupId !== undefined);
    assert(
      r.changed === true &&
        halves.length === 0 &&
        !!merged &&
        merged.slots.length === 2 &&
        merged.sameGroupLinkId === 'O',
      '(sgm-1) same-group MERGE collapses Stage-4 split back into the 2-slot residual (linkId preserved)',
    );
    const s1Asg = r.assignments.find((a) => a.taskId === 'O' && a.slotId === 'O-s1');
    assert(
      !!s1Asg && ['g1a', 'g1b', 'g1c'].includes(s1Asg.participantId) && s1Asg.participantId !== 'g2a',
      '(sgm-1) merged whole slot stays inside the link group (requiredGroup filter is load-bearing)',
    );
    assert(
      validateHardConstraints(r.tasks, ps, r.assignments, undefined).violations.length === 0,
      '(sgm-1) post-merge schedule is HC-valid (HC-8 link-aware passes)',
    );
  }

  // (sgm-2) No-residual mixed-split MERGE stamps `sameGroupLinkId` on the
  // fresh whole task so still-split sibling slots remain link-coordinated.
  // Setup: occurrence O has two splittable slots, both currently split, no
  // residual. Only ONE slot can merge — the other has no g1 member with
  // whole-window availability — so the per-occurrence `touched` guard would
  // be irrelevant if linkId weren't stamped, but HC-8 demands the merged
  // whole task be in the link unit.
  const mkHalf = (
    occId: string,
    baseSlotId: string,
    part: 1 | 2,
    startH: number,
    endH: number,
    fullH: number,
  ): Task => ({
    id: `${occId}::${baseSlotId}#${part === 1 ? 'a' : 'b'}`,
    name: `${occId} (${part}/2)`,
    sourceName: occId,
    timeBlock: tb(startH, endH),
    requiredCount: 1,
    slots: [
      {
        slotId: `${baseSlotId}#${part === 1 ? 'a' : 'b'}`,
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
      },
    ],
    sameGroupRequired: true,
    blocksConsecutive: false,
    splittable: true,
    splitGroupId: `${occId}::${baseSlotId}`,
    splitPart: part,
    splitOriginalMs: fullH * H,
    splitOccurrenceId: occId,
    sameGroupLinkId: occId,
  });
  {
    // O has slots s0 and s1, each [0,4] (concurrent). Both split into halves.
    // Slot s0: g1a/g1b are whole-window available ⇒ MERGE can collapse it.
    // Slot s1: no g1 member is whole-window available besides g1a/g1b, but
    // they would be busy on s0 (overlapping time ⇒ HC-5 would forbid double
    // booking). Since MERGE only processes ONE slot pair per occurrence per
    // run (`touched` guard), this naturally stays mixed.
    const Sa0 = mkHalf('O', 'O-s0', 1, 0, 2, 4);
    const Sb0 = mkHalf('O', 'O-s0', 2, 2, 4, 4);
    const Sa1 = mkHalf('O', 'O-s1', 1, 0, 2, 4);
    const Sb1 = mkHalf('O', 'O-s1', 2, 2, 4, 4);
    const ps = [
      partG('g1a', 0, 24, 'g1'),
      partG('g1b', 0, 24, 'g1'),
      partG('g1c', 0, 2, 'g1'),
      partG('g1d', 2, 4, 'g1'),
    ];
    const best = [
      asg(Sa0.id, Sa0.slots[0].slotId, 'g1a'),
      asg(Sb0.id, Sb0.slots[0].slotId, 'g1b'),
      asg(Sa1.id, Sa1.slots[0].slotId, 'g1c'),
      asg(Sb1.id, Sb1.slots[0].slotId, 'g1d'),
    ];
    const r = refine([Sa0, Sb0, Sa1, Sb1], best, ps, /*splitPenalty*/ 1e9);
    const wholeO = r.tasks.find((t) => t.id === 'O');
    const stillSplit = r.tasks.filter((t) => t.splitGroupId !== undefined);
    assert(
      r.changed === true && !!wholeO,
      '(sgm-2) MERGE commits on one slot pair, creating a fresh whole task (no-residual branch)',
    );
    assert(
      !!wholeO && wholeO.sameGroupLinkId === 'O',
      '(sgm-2) mixed-split fresh whole task carries sameGroupLinkId=occId (link survives)',
    );
    assert(
      stillSplit.length === 2 && stillSplit.every((t) => t.sameGroupLinkId === 'O'),
      '(sgm-2) the un-merged slot pair remains split AND keeps its linkId — HC-8 still groups all three tasks',
    );
    assert(
      validateHardConstraints(r.tasks, ps, r.assignments, undefined).violations.length === 0,
      '(sgm-2) mixed post-merge state is HC-valid',
    );
  }

  // (sgm-3) MERGE refused when no link-group candidate exists for the whole
  // slot. Halves are individually coverable (Stage-4 was justified), but no
  // g1 member spans the whole window ⇒ pickEligible returns null ⇒ skip.
  {
    const { Tr, Sa, Sb } = splitSameGroupOccurrence();
    // Slot O-s0 of Tr is [0,4]; halves of O-s1 are [0,2] / [2,4]. Use g1
    // members that can cover the split halves but NOT the whole O-s1 [0,4].
    const ps = [
      partG('g1a', 0, 24, 'g1'), // covers Tr's whole O-s0 [0,4]
      partG('g1b', 0, 2, 'g1'), // only #a of O-s1
      partG('g1c', 2, 4, 'g1'), // only #b of O-s1
    ];
    const best = [asg('O', 'O-s0', 'g1a'), asg(Sa.id, 'O-s1#a', 'g1b'), asg(Sb.id, 'O-s1#b', 'g1c')];
    const r = refine([Tr, Sa, Sb], best, ps, /*splitPenalty*/ 1e9);
    assert(
      r.changed === false && r.tasks.filter((t) => t.splitGroupId !== undefined).length === 2,
      '(sgm-3) MERGE refused when no link-group member can cover the reconstructed whole slot',
    );
  }

  // (sgm-4) MERGE refused when only OUT-OF-GROUP candidates are eligible for
  // the whole slot. This is the load-bearing assertion for the requiredGroup
  // gate: a wrong-group participant available for the whole window must not
  // sneak into the merged slot.
  {
    const { Tr, Sa, Sb } = splitSameGroupOccurrence();
    const ps = [
      partG('g1a', 0, 24, 'g1'), // covers Tr's O-s0 [0,4]
      partG('g1b', 0, 2, 'g1'), // only #a
      partG('g1c', 2, 4, 'g1'), // only #b
      partG('g2x', 0, 24, 'g2'), // out-of-group; would qualify without the filter
    ];
    const best = [asg('O', 'O-s0', 'g1a'), asg(Sa.id, 'O-s1#a', 'g1b'), asg(Sb.id, 'O-s1#b', 'g1c')];
    const r = refine([Tr, Sa, Sb], best, ps, /*splitPenalty*/ 1e9);
    assert(
      r.changed === false &&
        !r.assignments.some((a) => a.participantId === 'g2x') &&
        r.tasks.filter((t) => t.splitGroupId !== undefined).length === 2,
      '(sgm-4) requiredGroup filter blocks an out-of-group candidate from merging into the link unit',
    );
  }

  // (sgm-5) Non-same-group MERGE byte-identical: the new requiredGroup path
  // is inert when sameGroupLinkId is undefined. Mirrors the existing (g)
  // case to prove zero regression on the non-same-group path.
  {
    const ps = [partG('p1', 0, 24, 'g1'), partG('p2', 0, 24, 'g2')]; // different groups; doesn't matter for non-link
    const Tns = {
      id: 'M',
      name: 'M',
      sourceName: 'guard',
      timeBlock: tb(0, 12),
      requiredCount: 1,
      slots: [{ slotId: 'M-s0', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: false,
      splittable: true,
    } as Task;
    const Ma = makeSplitHalf(Tns, 1, tb(0, 12).start.getTime(), tb(6, 6).start.getTime(), Tns.slots[0]);
    const Mb = makeSplitHalf(Tns, 2, tb(6, 6).start.getTime(), tb(0, 12).end.getTime(), Tns.slots[0]);
    const best = [asg(Ma.id, Ma.slots[0].slotId, 'p1'), asg(Mb.id, Mb.slots[0].slotId, 'p2')];
    const r = refine([Ma, Mb], best, ps, /*splitPenalty*/ 1e9);
    assert(
      r.changed === true &&
        r.tasks.length === 1 &&
        r.tasks[0].id === 'M' &&
        r.tasks[0].splitGroupId === undefined &&
        r.tasks[0].sameGroupLinkId === undefined,
      '(sgm-5) non-same-group MERGE still commits unchanged (no group filter applied, linkId stays undefined)',
    );
  }
}

/**
 * Bug #1 regression: `enumerateSplitFillsForSlot`'s trial scoring used to pass
 * `ctx.scoreCtx` directly to `computeScheduleScore`. Because that scoreCtx was
 * built over the PRE-split task set, its `taskMap` did NOT contain the new
 * `#a`/`#b` half-task ids; per-assignment soft-score loops then hit
 * `if (!task) continue` and skipped the halves' contribution entirely. With
 * unequal-load participants this changes the SC-3 / SC-8 fairness stddev term,
 * so the trial score from a stale ctx diverges from a fresh-ctx score. The fix
 * (rescue-primitives.ts) rebuilds a trial-specific ScoreContext that overrides
 * `taskMap` from the trial tasks. This test triggers the divergence directly
 * via `computeScheduleScore` to lock the fix in place.
 */
function runDynamicSplitTrialScoring(assert: AssertFn): void {
  const p1: Participant = {
    id: 'P1',
    name: 'A',
    group: 'g1',
    level: Level.L3,
    certifications: [],
    notWithIds: [],
    workloadMultiplier: 1,
    availability: [],
    dateUnavailability: [],
  };
  const p2: Participant = {
    id: 'P2',
    name: 'B',
    group: 'g1',
    level: Level.L3,
    certifications: [],
    notWithIds: [],
    workloadMultiplier: 1,
    availability: [],
    dateUnavailability: [],
  };
  // P3 is unassigned. With 3 seniors, the +1h shift from skipping halves vs.
  // counting them produces a different SC-3 std-dev (asymmetric ⇒ variance
  // shifts), so the stale vs fresh composite scores diverge.
  const p3: Participant = {
    id: 'P3',
    name: 'C',
    group: 'g1',
    level: Level.L3,
    certifications: [],
    notWithIds: [],
    workloadMultiplier: 1,
    availability: [],
    dateUnavailability: [],
  };
  const participants = [p1, p2, p3];

  // Two tasks: T_other (whole-only, already assigned to P1) introduces load
  // asymmetry; T_split (the trial subject) becomes halfA + halfB. With
  // halves COUNTED (fresh ctx), P1 has T_other(2h) + halfA(1h) = 3h and P2
  // has halfB(1h) — asymmetric SC-3 std-dev. With halves SKIPPED (stale
  // ctx), P1 has T_other(2h) and P2 has 0h — a different, larger std-dev.
  const tOther: Task = {
    id: 'T_other',
    name: 'T_other',
    sourceName: 'other',
    timeBlock: tb(6, 8),
    requiredCount: 1,
    slots: [
      { slotId: 'T_other-s', acceptableLevels: [{ level: Level.L3, lowPriority: false }], requiredCertifications: [] },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
  const tSplit: Task = {
    id: 'T_split',
    name: 'T_split',
    sourceName: 'guard',
    timeBlock: tb(0, 2),
    requiredCount: 1,
    slots: [
      { slotId: 'T_split-s', acceptableLevels: [{ level: Level.L3, lowPriority: false }], requiredCertifications: [] },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
    splittable: true,
  };
  const halfA = makeSplitHalf(
    tSplit,
    1,
    tSplit.timeBlock.start.getTime(),
    tSplit.timeBlock.start.getTime() + H,
    tSplit.slots[0],
  );
  const halfB = makeSplitHalf(
    tSplit,
    2,
    tSplit.timeBlock.start.getTime() + H,
    tSplit.timeBlock.end.getTime(),
    tSplit.slots[0],
  );

  const cfg: SchedulerConfig = { ...DEFAULT_CONFIG, splitPenalty: 0 };

  // Stale ctx: taskMap holds the PRE-split task set (T_other + T_split).
  const stalePreSplitTaskMap = new Map<string, Task>([
    [tOther.id, tOther],
    [tSplit.id, tSplit],
  ]);
  const staleCtx = {
    taskMap: stalePreSplitTaskMap,
    pMap: new Map(participants.map((p) => [p.id, p])),
    dayStartHour: 5,
  };

  const trialTasks: Task[] = [tOther, halfA, halfB];
  const trialAsgs: Assignment[] = [
    {
      id: 'asg-other',
      taskId: tOther.id,
      slotId: tOther.slots[0].slotId,
      participantId: 'P1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'asg-A',
      taskId: halfA.id,
      slotId: halfA.slots[0].slotId,
      participantId: 'P1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
    {
      id: 'asg-B',
      taskId: halfB.id,
      slotId: halfB.slots[0].slotId,
      participantId: 'P2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    },
  ];

  const stale = computeScheduleScore(trialTasks, participants, trialAsgs, cfg, staleCtx);
  const fresh = computeScheduleScore(trialTasks, participants, trialAsgs, cfg, undefined);

  // The stale-ctx scorer's per-assignment loops can't find the half-tasks in
  // its taskMap, so it omits their hours from the fairness std-dev. Fresh ctx
  // includes them. The composite scores must differ.
  assert(
    Math.abs(stale.compositeScore - fresh.compositeScore) > 1e-6,
    'Bug #1 repro: stale ctx.taskMap excludes split halves from SC-3 fairness; fresh-ctx score must differ',
  );

  // Now demonstrate the FIX: rebuilding taskMap from trial tasks (what
  // rescue-primitives.ts:enumerateSplitFillsForSlot now does) must recover
  // the fresh-ctx score byte-for-byte.
  const fixedCtx = {
    ...staleCtx,
    taskMap: new Map(trialTasks.map((t) => [t.id, t])),
    assignmentsByParticipant: undefined,
    assignmentsByTask: undefined,
  };
  const fixed = computeScheduleScore(trialTasks, participants, trialAsgs, cfg, fixedCtx);
  assert(
    Math.abs(fixed.compositeScore - fresh.compositeScore) < 1e-6,
    'Bug #1 fix: overriding ctx.taskMap with trial tasks restores correct fairness scoring',
  );
}

/**
 * Bug #2 regression: every dynamic-flow residual-construction site builds the
 * residual as `{ ...T, slots: survivingSlots, requiredCount: ... }`. For an
 * unsplit `T` that is `sameGroupRequired` (typical), `T.sameGroupLinkId` is
 * undefined and the spread inherits undefined onto the residual. Meanwhile
 * `makeSplitHalf` stamps `sameGroupLinkId: T.id` on the new halves. The result:
 * residual is NOT in the HC-8 link-union (residual.sameGroupLinkId is
 * undefined, halves carry T.id), so `sameGroupUnitTaskIds(residual, ...)`
 * returns `[residual.id]` instead of `[residual.id, halfA.id, halfB.id]` — and
 * cross-group HC-8 violations on the residual+halves combination silently
 * pass aggregate validation. Optimizer's own `splitSameGroup` correctly stamps
 * `sameGroupLinkId: T.id` on its residual (optimizer.ts:1373); dynamic-flow
 * paths must do the same.
 */
function runDynamicSplitResidualLinkId(assert: AssertFn): void {
  // Construct a sameGroupRequired parent task with 2 slots.
  const T: Task = {
    id: 'T',
    name: 'T',
    sourceName: 'guard',
    timeBlock: tb(0, 4),
    requiredCount: 2,
    slots: [
      { slotId: 's1', acceptableLevels: [], requiredCertifications: [] },
      { slotId: 's2', acceptableLevels: [], requiredCertifications: [] },
    ],
    sameGroupRequired: true,
    blocksConsecutive: false,
    splittable: true,
  };

  // Simulate the residual-construction that the BUGGED dynamic-flow code path
  // produces today (spread-only — no explicit sameGroupLinkId).
  const buggedResidual: Task = { ...T, slots: T.slots.filter((s) => s.slotId !== 's1'), requiredCount: 1 };

  // makeSplitHalf correctly stamps sameGroupLinkId = T.id on halves.
  const halfA = makeSplitHalf(T, 1, T.timeBlock.start.getTime(), T.timeBlock.start.getTime() + 2 * H, T.slots[0]);
  const halfB = makeSplitHalf(T, 2, T.timeBlock.start.getTime() + 2 * H, T.timeBlock.end.getTime(), T.slots[0]);

  const { sameGroupUnitTaskIds } = require('./constraints/hard-constraints');
  const buggedUnit = sameGroupUnitTaskIds(buggedResidual, [buggedResidual, halfA, halfB]);
  // BUG: residual's sameGroupLinkId is undefined so the link-union returns
  // only [residual.id] — the halves are excluded even though they belong to
  // the same occurrence.
  assert(
    buggedUnit.length === 1 && buggedUnit[0] === buggedResidual.id,
    'Bug #2 repro: bugged residual (no sameGroupLinkId) is alone in its HC-8 link-union (halves excluded)',
  );

  // FIXED residual stamps sameGroupLinkId = T.id when the parent is
  // sameGroupRequired (matches optimizer.ts:splitSameGroup pattern).
  const fixedResidual: Task = {
    ...T,
    slots: T.slots.filter((s) => s.slotId !== 's1'),
    requiredCount: 1,
    sameGroupLinkId: T.id,
  };
  const fixedUnit = sameGroupUnitTaskIds(fixedResidual, [fixedResidual, halfA, halfB]);
  assert(
    fixedUnit.length === 3 &&
      fixedUnit.includes(fixedResidual.id) &&
      fixedUnit.includes(halfA.id) &&
      fixedUnit.includes(halfB.id),
    'Bug #2 fix: stamping sameGroupLinkId=T.id on residual reunites the HC-8 link-union (residual + 2 halves)',
  );

  // Sanity: non-sameGroupRequired T must NOT stamp sameGroupLinkId on the
  // residual (would falsely promote it into a non-existent link unit).
  const Tns: Task = { ...T, sameGroupRequired: false };
  const nsResidual: Task = {
    ...Tns,
    slots: Tns.slots.filter((s) => s.slotId !== 's1'),
    requiredCount: 1,
    // Intentional: no sameGroupLinkId stamp because sameGroupRequired === false.
  };
  assert(
    nsResidual.sameGroupLinkId === undefined,
    'Bug #2 fix invariant: non-sameGroupRequired residual must not carry sameGroupLinkId',
  );
}

// ─── Manual-build applyPlanOps split coverage ───────────────────────────────

/**
 * End-to-end tests for `engine.applyPlanOps({ splitOps: [...] })`, the
 * single apply path that the manual-build split picker uses. Covers both the
 * historical filled-slot path (used by rescue / FSOS / cap-change) and the
 * new nullable-`originalAssignmentId` empty-slot path (manual-build only),
 * plus all pre-validation guards, the final-validate rollback contract, and
 * the `sameGroupRequired` link-union stamp on the residual.
 *
 * Closes a long-standing test gap: no prior coverage exercised `applyPlanOps`
 * directly — every dynamic-flow test went through `searchInjectionPlans` /
 * `generateRescuePlans` higher up the stack.
 */
function runManualSplitApply(assert: AssertFn): void {
  const dummyScore: ScheduleScore = {
    minRestHours: 0,
    avgRestHours: 0,
    workloadStdDev: 0,
    totalPenalty: 0,
    compositeScore: 0,
    l0StdDev: 0,
    l0AvgEffective: 0,
    seniorStdDev: 0,
    seniorAvgEffective: 0,
    dailyPerParticipantStdDev: 0,
    dailyGlobalStdDev: 0,
    restPerGapBonus: 0,
  };
  const wideAvail = [{ start: new Date(BASE - H), end: new Date(BASE + 48 * H) }];
  function mkPart(id: string, group = 'G', level: Level = Level.L0): Participant {
    return {
      id,
      name: id,
      level,
      certifications: [],
      group,
      availability: wideAvail,
      dateUnavailability: [],
    };
  }
  function mkSched(tasks: Task[], parts: Participant[], asgs: Assignment[]): Schedule {
    return {
      id: 'ms-sched',
      tasks,
      participants: parts,
      assignments: asgs,
      feasible: true,
      score: { ...dummyScore },
      violations: [],
      generatedAt: new Date(),
      algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5 },
      periodStart: new Date(BASE),
      periodDays: 2,
      restRuleSnapshot: {},
      certLabelSnapshot: {},
    };
  }
  function freshEngine(sched: Schedule): SchedulingEngine {
    const eng = new SchedulingEngine({}, undefined, undefined, 5);
    eng.addParticipants(sched.participants);
    eng.importSchedule(sched);
    return eng;
  }
  function midOf(T: Task): number {
    const s = T.timeBlock.start.getTime();
    const e = T.timeBlock.end.getTime();
    return s + Math.floor((e - s) / 2);
  }
  function buildSplitOp(
    T: Task,
    slotIdx: number,
    fillAId: string,
    fillBId: string,
    originalAsg: Assignment | null,
    opts: { groupLock?: string; sameGroupLinkId?: string } = {},
  ): SplitOp {
    const slot = T.slots[slotIdx];
    return {
      kind: 'split',
      taskId: T.id,
      slotId: slot.slotId,
      taskName: T.name,
      slotLabel: slot.label ?? slot.slotId,
      originalAssignmentId: originalAsg?.id ?? null,
      originalParticipantId: originalAsg?.participantId ?? null,
      midpointMs: midOf(T),
      fillA: { participantId: fillAId, displayName: fillAId },
      fillB: { participantId: fillBId, displayName: fillBId },
      groupLock: opts.groupLock,
      sameGroupLinkId: opts.sameGroupLinkId,
    };
  }

  // ─── Case 1: filled-slot split happy path ────────────────────────────────
  {
    const T = splitTask('msT1', 0, 4, true);
    const pA = mkPart('m1-incumbent');
    const pB = mkPart('m1-relief');
    const aOrig: Assignment = {
      id: 'm1-orig',
      taskId: T.id,
      slotId: T.slots[0].slotId,
      participantId: pA.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched = mkSched([T], [pA, pB], [aOrig]);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pB.id, aOrig);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(res.valid, 'Case 1: filled-slot manual split → valid');
    assert(!sched.assignments.some((a) => a.id === aOrig.id), 'Case 1: original assignment removed');
    const halves = sched.assignments.filter((a) => a.id.startsWith(aOrig.id));
    assert(halves.length === 2, `Case 1: two half assignments created (got ${halves.length})`);
    assert(
      halves.every((a) => a.status === AssignmentStatus.Manual),
      'Case 1: half assignments are Manual status',
    );
    const tasksAfter = sched.tasks.map((t) => t.id).sort();
    assert(
      tasksAfter.includes(`${T.id}::${T.slots[0].slotId}#a`) && tasksAfter.includes(`${T.id}::${T.slots[0].slotId}#b`),
      'Case 1: schedule.tasks now contains both halves',
    );
    assert(!tasksAfter.includes(T.id), 'Case 1: single-slot parent task removed (no residual)');
  }

  // ─── Case 2: empty-slot manual split happy path ──────────────────────────
  {
    const T = splitTask('msT2', 0, 4, true);
    const pA = mkPart('m2-a');
    const pB = mkPart('m2-b');
    const sched = mkSched([T], [pA, pB], []);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pB.id, null);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(res.valid, 'Case 2: empty-slot manual split → valid');
    const newAsgs = sched.assignments;
    assert(newAsgs.length === 2, `Case 2: exactly 2 new assignments created (got ${newAsgs.length})`);
    assert(
      newAsgs.every((a) => /#[ab]$/.test(a.id)),
      `Case 2: synthetic ids end in #a/#b (got ${newAsgs.map((a) => a.id).join(',')})`,
    );
    assert(
      newAsgs.every((a) => a.id.startsWith('split-')),
      'Case 2: synthetic id base uses the manual-split prefix',
    );
  }

  // ─── Case 3: empty-slot guard rejects when slot is actually assigned ─────
  {
    const T = splitTask('msT3', 0, 4, true);
    const pA = mkPart('m3-incumbent');
    const pB = mkPart('m3-relief');
    const pC = mkPart('m3-third');
    const aOrig: Assignment = {
      id: 'm3-orig',
      taskId: T.id,
      slotId: T.slots[0].slotId,
      participantId: pA.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched = mkSched([T], [pA, pB, pC], [aOrig]);
    const eng = freshEngine(sched);
    const tasksBefore = sched.tasks.length;
    const asgsBefore = sched.assignments.length;
    const op = buildSplitOp(T, 0, pB.id, pC.id, null);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 3: empty-slot op against an assigned slot → invalid');
    assert(
      res.violations[0]?.code === 'SPLIT_SLOT_NOT_EMPTY',
      `Case 3: violation code is SPLIT_SLOT_NOT_EMPTY (got ${res.violations[0]?.code})`,
    );
    assert(
      sched.tasks.length === tasksBefore && sched.assignments.length === asgsBefore,
      'Case 3: schedule unchanged after rejection',
    );
  }

  // ─── Case 4: TASK_NOT_SPLITTABLE rejection ───────────────────────────────
  {
    const T = splitTask('msT4', 0, 4, false);
    const pA = mkPart('m4-a');
    const pB = mkPart('m4-b');
    const sched = mkSched([T], [pA, pB], []);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pB.id, null);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 4: non-splittable task rejected');
    assert(
      res.violations[0]?.code === 'TASK_NOT_SPLITTABLE',
      `Case 4: code = TASK_NOT_SPLITTABLE (got ${res.violations[0]?.code})`,
    );
  }

  // ─── Case 5: TASK_ALREADY_SPLIT rejection (target a half) ────────────────
  {
    const T = splitTask('msT5', 0, 4, true);
    const halfA = makeSplitHalf(T, 1, T.timeBlock.start.getTime(), midOf(T), T.slots[0]);
    const pA = mkPart('m5-a');
    const pB = mkPart('m5-b');
    const sched = mkSched([halfA], [pA, pB], []);
    const eng = freshEngine(sched);
    // Build op against the half-task directly (taskId === halfA.id).
    const op: SplitOp = {
      kind: 'split',
      taskId: halfA.id,
      slotId: halfA.slots[0].slotId,
      taskName: halfA.name,
      slotLabel: halfA.slots[0].slotId,
      originalAssignmentId: null,
      originalParticipantId: null,
      midpointMs: halfA.timeBlock.start.getTime() + 30 * 60 * 1000,
      fillA: { participantId: pA.id, displayName: pA.id },
      fillB: { participantId: pB.id, displayName: pB.id },
    };
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 5: split-of-half rejected');
    assert(
      res.violations[0]?.code === 'TASK_ALREADY_SPLIT',
      `Case 5: code = TASK_ALREADY_SPLIT (got ${res.violations[0]?.code})`,
    );
  }

  // ─── Case 6: SPLIT_SAME_PARTICIPANT pre-check ────────────────────────────
  {
    const T = splitTask('msT6', 0, 4, true);
    const pA = mkPart('m6-a');
    const sched = mkSched([T], [pA], []);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pA.id, null);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 6: same-participant-both-halves rejected');
    assert(
      res.violations[0]?.code === 'SPLIT_SAME_PARTICIPANT',
      `Case 6: code = SPLIT_SAME_PARTICIPANT (got ${res.violations[0]?.code})`,
    );
  }

  // ─── Case 7: HC-16 final-validate rejection + atomic rollback ────────────
  // Both halves of one split SLOT must go to different people. The pre-check
  // at line 1110 catches a SplitOp where fillA===fillB; HC-16's final-validate
  // catches the same condition after mutation as a defense-in-depth layer.
  // Here we use the SPLIT_SAME_PARTICIPANT path as the canonical pre-check
  // proof and additionally verify rollback restores the schedule exactly.
  {
    const T = splitTask('msT7', 0, 4, true);
    const pA = mkPart('m7-incumbent');
    const aOrig: Assignment = {
      id: 'm7-orig',
      taskId: T.id,
      slotId: T.slots[0].slotId,
      participantId: pA.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched = mkSched([T], [pA], [aOrig]);
    const eng = freshEngine(sched);
    const tasksBefore = sched.tasks.slice();
    const asgsBefore = sched.assignments.slice();
    const op = buildSplitOp(T, 0, pA.id, pA.id, aOrig);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 7: invalid op → rollback');
    assert(
      sched.tasks.length === tasksBefore.length && sched.tasks.every((t, i) => t === tasksBefore[i]),
      'Case 7: schedule.tasks references identical after rollback',
    );
    assert(
      sched.assignments.length === asgsBefore.length && sched.assignments.every((a, i) => a === asgsBefore[i]),
      'Case 7: schedule.assignments references identical after rollback',
    );
  }

  // ─── Case 8: sameGroupRequired split — link-union + groupLock ────────────
  {
    const T0 = splitTask('msT8', 0, 4, true);
    const T: Task = { ...T0, sameGroupRequired: true };
    const pA = mkPart('m8-a', 'GROUP_X');
    const pB = mkPart('m8-b', 'GROUP_X');
    const sched = mkSched([T], [pA, pB], []);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pB.id, null, {
      groupLock: 'GROUP_X',
      sameGroupLinkId: T.id,
    });
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(res.valid, 'Case 8: same-group split with matching group → valid');
    const halves = sched.tasks.filter((t) => t.splitGroupId !== undefined);
    assert(halves.length === 2, 'Case 8: both halves present');
    assert(
      halves.every((t) => t.sameGroupLinkId === T.id),
      'Case 8: halves carry sameGroupLinkId === parent occurrence id (via makeSplitHalf)',
    );
  }

  // ─── Case 9: sameGroupRequired cross-group rejection via HC-8 ───────────
  {
    const T0 = splitTask('msT9', 0, 4, true);
    const T: Task = { ...T0, sameGroupRequired: true };
    const pA = mkPart('m9-a', 'GROUP_X');
    const pB = mkPart('m9-b', 'GROUP_Y');
    const sched = mkSched([T], [pA, pB], []);
    const eng = freshEngine(sched);
    const tasksBefore = sched.tasks.length;
    const op = buildSplitOp(T, 0, pA.id, pB.id, null, {
      groupLock: 'GROUP_X',
      sameGroupLinkId: T.id,
    });
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(!res.valid, 'Case 9: cross-group split rejected by final validate');
    assert(sched.tasks.length === tasksBefore, 'Case 9: rollback restored task count');
  }

  // ─── Case 10: multi-slot task — residual keeps surviving slot ────────────
  {
    const T: Task = {
      id: 'msT10',
      name: 'msT10',
      sourceName: 'guard',
      timeBlock: tb(0, 4),
      requiredCount: 2,
      slots: [
        { slotId: 's1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        { slotId: 's2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      ],
      sameGroupRequired: false,
      blocksConsecutive: true,
      splittable: true,
    };
    const pA = mkPart('m10-a');
    const pB = mkPart('m10-b');
    const pC = mkPart('m10-c');
    const aS2: Assignment = {
      id: 'm10-s2-asg',
      taskId: T.id,
      slotId: 's2',
      participantId: pC.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched = mkSched([T], [pA, pB, pC], [aS2]);
    const eng = freshEngine(sched);
    const op = buildSplitOp(T, 0, pA.id, pB.id, null);
    const res = eng.applyPlanOps({ splitOps: [op] });
    assert(res.valid, 'Case 10: split one slot of multi-slot task → valid');
    const residual = sched.tasks.find((t) => t.id === T.id);
    assert(residual !== undefined, 'Case 10: residual present (other slots remain whole)');
    assert(
      residual !== undefined && residual.slots.length === 1 && residual.slots[0].slotId === 's2',
      'Case 10: residual keeps only the un-split slot',
    );
    // The s2 assignment must still exist untouched.
    assert(
      sched.assignments.some((a) => a.id === aS2.id),
      'Case 10: residual slot assignment preserved',
    );
  }

  // ─── Case 11: RE-SPLIT of a sameGroupRequired residual keeps the HC-8 ─────
  // link-union intact. Regression for the claim "re-splitting a same-group
  // residual stamps halves with sameGroupLinkId=T.id while the residual keeps
  // origOccId, fracturing the link-union and letting a cross-group assignment
  // pass". It cannot: a residual's id IS the occurrence id, so makeSplitHalf
  // (stamps T.id) and the residual stamp (T.sameGroupLinkId ?? T.id) both
  // resolve to that one id on a re-split. The discriminating proof is the A/B
  // pair below — identical except the s2 fillers' group: A (GROUP_X) is valid,
  // B (GROUP_Y) MUST be rejected. B would wrongly pass iff the new s2-halves
  // and the residual+s1-halves fell into separate, internally-consistent units.
  {
    const mkOccSched = () => {
      const T: Task = {
        id: 'msT11',
        name: 'msT11',
        sourceName: 'guard',
        timeBlock: tb(0, 4),
        requiredCount: 3,
        slots: [
          { slotId: 's1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
          { slotId: 's2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
          { slotId: 's3', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        ],
        sameGroupRequired: true,
        blocksConsecutive: false,
        splittable: true,
      };
      const parts = [
        mkPart('x11-a', 'GROUP_X'),
        mkPart('x11-b', 'GROUP_X'),
        mkPart('x11-c', 'GROUP_X'),
        mkPart('x11-d', 'GROUP_X'),
        mkPart('x11-e', 'GROUP_X'),
        mkPart('y11-a', 'GROUP_Y'),
        mkPart('y11-b', 'GROUP_Y'),
      ];
      const mk = (id: string, slotId: string, pid: string): Assignment => ({
        id,
        taskId: T.id,
        slotId,
        participantId: pid,
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      });
      const aS1 = mk('a11-s1', 's1', 'x11-a');
      const aS2 = mk('a11-s2', 's2', 'x11-b');
      const aS3 = mk('a11-s3', 's3', 'x11-c');
      const sched = mkSched([T], parts, [aS1, aS2, aS3]);
      const eng = freshEngine(sched);
      // First split: realize slot s1 as two GROUP_X halves (Xa keeps #a, Xd takes #b).
      const first = eng.applyPlanOps({
        splitOps: [buildSplitOp(T, 0, 'x11-a', 'x11-d', aS1, { groupLock: 'GROUP_X', sameGroupLinkId: T.id })],
      });
      return { T, sched, eng, aS2, first };
    };

    // Sub-case A: same-group re-split of the residual's s2 → valid, union intact.
    {
      const { T, sched, eng, aS2, first } = mkOccSched();
      assert(first.valid, 'Case 11A: first split (s1) of same-group occurrence → valid');
      const residual = sched.tasks.find((t) => t.id === T.id);
      assert(
        residual !== undefined && residual.slots.length === 2,
        'Case 11A: residual carries the two un-split slots after first split',
      );
      const s2Idx = residual ? residual.slots.findIndex((s) => s.slotId === 's2') : -1;
      const resA = eng.applyPlanOps({
        splitOps: [
          buildSplitOp(residual as Task, s2Idx, 'x11-b', 'x11-e', aS2, { groupLock: 'GROUP_X', sameGroupLinkId: T.id }),
        ],
      });
      assert(resA.valid, 'Case 11A: re-split of same-group residual (GROUP_X) → valid');
      const linked = sched.tasks.filter((t) => t.sameGroupLinkId === T.id);
      assert(
        linked.length === 5,
        `Case 11A: all 5 fragments (residual + 4 halves) share sameGroupLinkId === occId (got ${linked.length})`,
      );
      const residual2 = sched.tasks.find((t) => t.id === T.id);
      assert(
        residual2 !== undefined &&
          residual2.slots.length === 1 &&
          residual2.slots[0].slotId === 's3' &&
          residual2.sameGroupLinkId === T.id,
        'Case 11A: second residual keeps only whole slot s3 and preserves the occurrence link id',
      );
    }

    // Sub-case B (discriminator): cross-group re-split of the residual must be
    // REJECTED. Same setup as A; only the s2 fillers' group differs (GROUP_Y).
    {
      const { T, sched, eng, aS2 } = mkOccSched();
      const residual = sched.tasks.find((t) => t.id === T.id) as Task;
      const tasksBefore = sched.tasks.length;
      const s2Idx = residual.slots.findIndex((s) => s.slotId === 's2');
      const resB = eng.applyPlanOps({
        splitOps: [
          buildSplitOp(residual, s2Idx, 'y11-a', 'y11-b', aS2, { groupLock: 'GROUP_Y', sameGroupLinkId: T.id }),
        ],
      });
      assert(
        !resB.valid,
        'Case 11B: cross-group re-split of same-group residual → REJECTED (link-union enforced as one unit)',
      );
      assert(
        sched.tasks.length === tasksBefore,
        'Case 11B: rollback restored task set after rejected cross-group re-split',
      );
    }
  }
}

// ─── Top-K structural deferral: multi-attempt selection + continuation + early-stop ──
// Guards the production deferral path (optimizeMultiAttemptAsync, quality mode):
// the per-attempt structural refinement is deferred and only the top-K finalists
// are refined via refineDeferredResult. Invariant-based, so non-flaky regardless
// of SA randomness:
//   - a fresh run is HC-valid;
//   - continuation NEVER yields a worse composite than its (refined) seed;
//   - continuation returns the seed BY REFERENCE when it cannot improve (so the
//     scheduler's `result === seed` no-improvement check still holds), else it is
//     strictly better and still HC-valid;
//   - early-stop (an already-aborted stopSignal) resolves with a finite-score
//     result (the buffer-so-far is refined before resolving, never left raw).
async function runTopKDeferral(assert: AssertFn): Promise<void> {
  // Splittable fixture: 6 non-touching 8h tasks (gaps satisfy blocksConsecutive)
  // and 4 idle-capable L0s — enough imbalance for quality refinement to act on,
  // but the assertions hold whether or not a split actually commits.
  const tasks: Task[] = [
    splitTask('TK1', 6, 14, true),
    splitTask('TK2', 16, 24, true),
    splitTask('TK3', 30, 38, true),
    splitTask('TK4', 40, 48, true),
    splitTask('TK5', 54, 62, true),
    splitTask('TK6', 64, 72, true),
  ];
  const participants: Participant[] = [part('tkp1', 0, 96), part('tkp2', 0, 96), part('tkp3', 0, 96), part('tkp4', 0, 96)];
  const cfg: SchedulerConfig = { ...DEFAULT_CONFIG, maxIterations: 300, maxSolverTimeMs: 2000 };
  const nonHc6 = (asgs: Assignment[], ts: Task[]): string[] =>
    validateHardConstraints(ts, participants, asgs)
      .violations.filter((vv) => vv.code !== 'HC-6')
      .map((vv) => vv.code);

  // Fresh multi-attempt run — quality mode ⇒ deferral active.
  const r1 = await optimizeMultiAttemptAsync(
    tasks, participants, cfg, [], 8,
    undefined, undefined, undefined, undefined, 5, undefined, undefined, undefined, undefined, undefined, true,
  );
  assert(Number.isFinite(r1.score.compositeScore), 'top-K deferral: fresh run has finite composite');
  const v1 = nonHc6(r1.assignments, r1.tasks ?? tasks);
  assert(v1.length === 0, `top-K deferral: fresh run HC-valid (non-HC-6) (got [${v1.join(',')}])`);

  // Continuation from the (already-refined) seed, on its realized task set.
  const baseTasks = r1.tasks ?? tasks;
  const r2 = await optimizeMultiAttemptAsync(
    baseTasks, participants, cfg, [], 8,
    undefined, undefined, undefined, undefined, 5, undefined, undefined, undefined, undefined,
    { seedBest: r1, continuation: true }, true,
  );
  assert(
    r2.score.compositeScore >= r1.score.compositeScore - 1e-6,
    `top-K deferral: continuation never worse than seed (${r2.score.compositeScore.toFixed(2)} >= ${r1.score.compositeScore.toFixed(2)})`,
  );
  assert(
    r2 === r1 || r2.score.compositeScore > r1.score.compositeScore,
    'top-K deferral: continuation returns seed by reference when unbeaten, else strictly better',
  );
  const v2 = nonHc6(r2.assignments, r2.tasks ?? baseTasks);
  assert(v2.length === 0, `top-K deferral: continuation result HC-valid (non-HC-6) (got [${v2.join(',')}])`);

  // Early-stop: an already-aborted stopSignal must resolve (refining the
  // buffer-so-far), never hang and never return a raw unrefined best.
  const stop = new AbortController();
  stop.abort();
  const r3 = await optimizeMultiAttemptAsync(
    tasks, participants, cfg, [], 8,
    undefined, undefined, undefined, undefined, 5, undefined, undefined, undefined, stop.signal, undefined, true,
  );
  assert(Number.isFinite(r3.score.compositeScore), 'top-K deferral: early-stop resolves with finite-score result');
}

export async function runShiftSplitTests(assert: AssertFn): Promise<void> {
  console.log('\n── Shift-Split: run-coalesce primitive ──');
  runCoalesce(assert);
  console.log('── Shift-Split: feasibility split ──');
  runFeasibilitySplit(assert);
  console.log('── Shift-Split: HC-16 split-sibling disjointness ──');
  runHc16(assert);
  console.log('── Shift-Split: per-placement coalescing ≡ aggregate ──');
  runPerPlacementCoalescing(assert);
  console.log('── Shift-Split: HC-16 in SA swap gate ──');
  runSwapFeasHc16(assert);
  console.log('── Shift-Split: HC-15 sleep & recovery on split halves ──');
  runHc15Splits(assert);
  console.log('── Shift-Split: multiple splittable occurrences ──');
  runMultiSplit(assert);
  console.log('── Shift-Split: cross-source HC-12 (no coalesce hole) ──');
  runHc12CrossSource(assert);
  console.log('── Shift-Split: slot-level — whole + split coexist (a/c/h) ──');
  runSlotLevelMixed(assert);
  console.log('── Shift-Split: slot-level — independent multi-slot split (b/e) ──');
  runSlotLevelMultiSplit(assert);
  console.log('── Shift-Split: HC-15/HC-12 cross-slot same-occurrence run (d) ──');
  runHc15CrossSlotSameOccurrence(assert);
  console.log('── Shift-Split: strict same-group split (i) ──');
  runSameGroupStrictSplit(assert);
  console.log('── Shift-Split: HC-12 aggregate fix isolation (j) ──');
  runHc12AggFixIsolation(assert);
  console.log('── Shift-Split: SA same-group split swap gate — link-aware HC-4 (k) ──');
  runSameGroupSplitSwapGate(assert);
  console.log('── Shift-Split: HC-15 Direction-2 same-occurrence exemption (l) ──');
  runHc15Dir2SameOccurrence(assert);
  console.log('── Shift-Split: per-placement HC-4 link-aware (m) ──');
  runPerPlacementHc4Link(assert);
  console.log('── Shift-Split: Phase 2 — scoring honesty + quality split/merge (p2) ──');
  runPhase2(assert);
  console.log('── Shift-Split: Phase 2 — same-group MERGE (sgm) ──');
  runPhase2SameGroupMerge(assert);
  console.log('── Shift-Split: dynamic-flow trial scoring (Bug #1 regression) ──');
  runDynamicSplitTrialScoring(assert);
  console.log('── Shift-Split: dynamic-flow residual sameGroupLinkId (Bug #2 regression) ──');
  runDynamicSplitResidualLinkId(assert);
  console.log('── Shift-Split: manual-build applyPlanOps coverage ──');
  runManualSplitApply(assert);
  console.log('── Shift-Split: top-K structural deferral (multi-attempt + continuation + early-stop) ──');
  await runTopKDeferral(assert);
}

if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const assert: AssertFn = (cond, name) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ FAIL: ${name}`);
    }
  };
  runShiftSplitTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
