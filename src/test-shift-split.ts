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

import { checkNoConsecutiveHighLoad, checkRestRules, checkSplitSiblingDisjoint } from './constraints/hard-constraints';
import { checkSleepRecovery, checkSleepRecoveryForPlacement, getRecoveryWindow } from './constraints/sleep-recovery';
import { countSplitOccurrences } from './constraints/soft-constraints';
import {
  applyFeasibilitySplits,
  type FeasibilitySplitCtx,
  isSwapFeasible,
  makeSplitHalf,
  type UnfilledSlot,
} from './engine/optimizer';
import { isEligible } from './engine/validator';
import { type Assignment, AssignmentStatus, Level, type Participant, type Task, type TimeBlock } from './models/types';
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
  // makeSplitHalf shape.
  const T0 = splitTask('T0', 0, 4, true);
  const ha = makeSplitHalf(T0, 1, BASE, BASE + 2 * H);
  const hb = makeSplitHalf(T0, 2, BASE + 2 * H, BASE + 4 * H);
  assert(ha.id === 'T0#a' && hb.id === 'T0#b', 'half ids #a/#b');
  assert(ha.splitGroupId === 'T0' && hb.splitGroupId === 'T0', 'halves share splitGroupId = occurrence id');
  assert(ha.splitPart === 1 && hb.splitPart === 2, 'splitPart 1/2');
  assert(ha.splitOriginalMs === 4 * H, 'splitOriginalMs = original occurrence span');
  assert(dur(ha) === 2 * H && dur(hb) === 2 * H, 'each half is 2h');
  assert(ha.slots[0].slotId !== T0.slots[0].slotId, 'half slot id suffixed (unique within half)');
  assert(ha.sourceName === 'guard' && ha.blocksConsecutive === true, 'half inherits source/blocks');

  // A. Feasibility split: nobody covers full 4h, but P1 covers ½, P2 covers ½.
  const TA = splitTask('TA', 0, 4, true);
  const ctxA = ctxFor(TA, [part('P1', -1, 2), part('P2', 2, 5)], true);
  const outA = applyFeasibilitySplits(ctxA);
  assert(outA !== ctxA.tasks, 'A: task list replaced (split committed)');
  assert(outA.length === 2 && outA.every((t) => t.splitGroupId === 'TA'), 'A: TA → two halves');
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
  assert(ctxD.taskMap.get('TD') === TD && !ctxD.taskMap.has('TD#a'), 'D: original task restored in taskMap');
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
  const Ga = makeSplitHalf(parent, 1, BASE, BASE + 2 * H); // 0h–2h
  const Gb = makeSplitHalf(parent, 2, BASE + 2 * H, BASE + 4 * H); // 2h–4h

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
