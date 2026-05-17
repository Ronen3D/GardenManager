/**
 * Rescue / Future-SOS / Inject / point-of-no-return coverage-gap tests (WP2):
 *  - C2.1 inject displace-and-backfill into a NON-EMPTY schedule (multi-plan API)
 *  - C2.2 point-of-no-return: swapParticipantChain / previewSwapChain reject a
 *         Frozen assignment; invalid mid-chain rolls back atomically
 *  - C2.3 rescue / Future-SOS / inject never swap a frozen/past donor
 *  - C2.4 freeze/unfreeze restores preFreezeStatus for a Manual assignment
 *
 * Group A (pure src/, no src/web import). Wired into `npm test` via
 * `runRescueExtraTests`. Standalone: `npx ts-node src/test-rescue-extra.ts`.
 */

import {
  type Assignment,
  AssignmentStatus,
  createTimeBlockFromHours,
  DEFAULT_CONFIG,
  freezeAssignments,
  isModifiableAssignment,
  Level,
  type Participant,
  type RescueRequest,
  type Schedule,
  type ScheduleScore,
  SchedulingEngine,
  type SwapRequest,
  type Task,
  unfreezeAll,
} from './index';
import { generateBatchRescuePlans } from './engine/future-sos';
import { type InjectedTaskSpec, searchInjectionPlans } from './engine/inject';
import { generateRescuePlans } from './engine/rescue';
import type { ScoreContext } from './constraints/soft-constraints';
import { computeAllCapacities } from './utils/capacity';

type AssertFn = (condition: boolean, name: string) => void;

// ─── Shared fixtures ────────────────────────────────────────────────────────

const base = new Date(2026, 5, 1); // 2026-06-01
const earlyAnchor = new Date(2026, 4, 20); // before period → all tasks future
const avail = [{ start: new Date(2026, 4, 28), end: new Date(2026, 5, 12) }];

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
  restPerGapBonus: 0,
};

function mkP(id: string, certs: string[] = [], group = 'G', level: Level = Level.L0): Participant {
  return { id, name: id, level, certifications: certs, group, availability: avail, dateUnavailability: [] };
}

function mkSchedule(tasks: Task[], participants: Participant[], assignments: Assignment[]): Schedule {
  return {
    id: 'rx-sched',
    tasks,
    participants,
    assignments,
    feasible: true,
    score: { ...dummyScore },
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: { config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], dayStartHour: 5 },
    periodStart: base,
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
  };
}

function buildScoreCtx(tasks: Task[], participants: Participant[]): ScoreContext {
  let s = tasks[0]?.timeBlock.start ?? new Date();
  let e = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < s) s = t.timeBlock.start;
    if (t.timeBlock.end > e) e = t.timeBlock.end;
  }
  return {
    taskMap: new Map(tasks.map((t) => [t.id, t])),
    pMap: new Map(participants.map((p) => [p.id, p])),
    capacities: computeAllCapacities(participants, s, e, 5),
    notWithPairs: new Map(),
    dayStartHour: 5,
  };
}

function snapshotAssignments(s: Schedule): string {
  return JSON.stringify(
    s.assignments
      .map((a) => ({
        id: a.id,
        t: a.taskId,
        slot: a.slotId,
        p: a.participantId,
        st: a.status,
        u: a.updatedAt instanceof Date ? a.updatedAt.getTime() : a.updatedAt,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
  );
}

function mkTask(id: string, start: Date, end: Date, certs: string[] = [], blocks = false): Task {
  return {
    id,
    name: id,
    timeBlock: { start, end },
    requiredCount: 1,
    slots: [
      {
        slotId: `${id}-s1`,
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: certs,
        label: 'A',
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: blocks,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// C2.1 — inject displace-and-backfill into a NON-EMPTY schedule
// ════════════════════════════════════════════════════════════════════════════

function runC21(assert: AssertFn): void {
  function buildEnv() {
    // T_old occupies P1 (the only 'special'-cert holder) at day-1 06:00–10:00.
    const oldBlock = createTimeBlockFromHours(new Date(2026, 5, 1), 6, 10);
    const tOld = mkTask('t-old', oldBlock.start, oldBlock.end);
    const p1 = mkP('c21-p1', ['special']);
    const p2 = mkP('c21-p2', []); // no 'special' → can backfill t-old, NOT the inject slot
    const aOld: Assignment = {
      id: 'a-old',
      taskId: 't-old',
      slotId: 't-old-s1',
      participantId: 'c21-p1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched = mkSchedule([tOld], [p1, p2], [aOld]);
    const engine = new SchedulingEngine({}, undefined, undefined, 5);
    engine.addParticipants(sched.participants);
    engine.importSchedule(sched);
    return { sched, engine };
  }

  // Injected task overlaps t-old's window; its only slot needs 'special'.
  const spec: InjectedTaskSpec = {
    name: 'C21-Inject',
    dayIndex: 1,
    startHour: 6,
    startMinute: 0,
    durationHours: 4, // 06:00–10:00 — overlaps t-old
    subTeams: [],
    slots: [
      { id: 'c21-islot', label: 'IS', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['special'] },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 1,
  };

  // ── apply() path: chain must displace P1 from t-old and backfill with P2 ──
  {
    const { sched, engine } = buildEnv();
    const { result, error } = searchInjectionPlans(engine, spec, { anchor: new Date(2026, 4, 20, 0, 0) });
    assert(!error && result !== null, 'C2.1: searchInjectionPlans returns a result on a non-empty schedule');
    if (!result) return;

    assert(result.plans.length > 0, `C2.1: at least one plan produced (got ${result.plans.length})`);
    assert(Array.isArray(result.unsolvableSlotIds), 'C2.1: unsolvableSlotIds is an array');
    assert(result.unsolvableSlotIds.length === 0, 'C2.1: the inject slot is solvable via displace-and-backfill');
    assert(typeof result.timedOut === 'boolean' && result.timedOut === false, 'C2.1: timedOut populated (false)');

    const top = result.plans[0];
    assert(top.filledCount === 1 && top.isPartial === false, 'C2.1: top plan fully fills the inject slot');
    assert(
      top.fallbackDepthUsed === undefined,
      `C2.1: fallbackDepthUsed unset for a depth-2 displace chain (got ${String(top.fallbackDepthUsed)})`,
    );

    // Before apply: t-old still held by P1.
    const aOldBefore = sched.assignments.find((a) => a.id === 'a-old')!;
    assert(aOldBefore.participantId === 'c21-p1', 'C2.1: pre-apply — t-old held by P1');
    const injTaskId = result.task.id;
    assert(
      !sched.assignments.some((a) => a.taskId === injTaskId && !a.participantId.startsWith('__inject_placeholder__')),
      'C2.1: pre-apply — no real assignment on the injected task yet',
    );

    const report = result.apply(top.id);
    assert(report !== null && report.fullyStaffed === true, 'C2.1: apply() returns a fully-staffed report');

    // After apply: t-old backfilled with P2, P1 moved onto the injected task.
    const aOldAfter = sched.assignments.find((a) => a.id === 'a-old')!;
    assert(
      aOldAfter.participantId === 'c21-p2',
      `C2.1: t-old assignment (id a-old) backfilled to P2 (got ${aOldAfter.participantId})`,
    );
    const injAssigns = sched.assignments.filter((a) => a.taskId === injTaskId);
    assert(
      injAssigns.length === 1 && injAssigns[0].participantId === 'c21-p1',
      'C2.1: injected task now staffed by the displaced incumbent P1',
    );

    // rollback restores the pre-injection state exactly.
    report!.rollback();
    assert(
      !sched.assignments.some((a) => a.taskId === injTaskId),
      'C2.1: rollback removes the injected task assignments',
    );
    assert(!sched.tasks.some((t) => t.id === injTaskId), 'C2.1: rollback removes the injected task');
    const aOldRolled = sched.assignments.find((a) => a.id === 'a-old')!;
    assert(aOldRolled.participantId === 'c21-p1', 'C2.1: rollback restores t-old to P1');
  }

  // ── cancel() path: nothing is applied or left behind ──
  {
    const { sched, engine } = buildEnv();
    const before = snapshotAssignments(sched);
    const { result } = searchInjectionPlans(engine, spec, { anchor: new Date(2026, 4, 20, 0, 0) });
    assert(result !== null, 'C2.1: cancel-path search returns a result');
    if (result) {
      result.cancel();
      assert(!sched.tasks.some((t) => t.id === result.task.id), 'C2.1: cancel() removes the injected task');
      assert(
        snapshotAssignments(sched) === before,
        'C2.1: cancel() leaves the pre-existing assignments byte-identical',
      );
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C2.2 — point-of-no-return at the commit/preview path
// ════════════════════════════════════════════════════════════════════════════

function runC22(assert: AssertFn): void {
  // ── Frozen assignment is rejected by both commit and preview paths ──
  {
    const tBlock = createTimeBlockFromHours(new Date(2026, 5, 3), 6, 14);
    const t = mkTask('c22-t', tBlock.start, tBlock.end);
    const pX = mkP('c22-pX');
    const pY = mkP('c22-pY');
    const aFrozen: Assignment = {
      id: 'a-frozen',
      taskId: 'c22-t',
      slotId: 'c22-t-s1',
      participantId: 'c22-pX',
      status: AssignmentStatus.Frozen,
      updatedAt: new Date(),
    };
    const sched = mkSchedule([t], [pX, pY], [aFrozen]);
    const engine = new SchedulingEngine({}, undefined, undefined, 5);
    engine.addParticipants(sched.participants);
    engine.importSchedule(sched);

    const before = snapshotAssignments(sched);
    const req: SwapRequest = { assignmentId: 'a-frozen', newParticipantId: 'c22-pY' };

    const chainRes = engine.swapParticipantChain([req]);
    assert(chainRes.valid === false, 'C2.2: swapParticipantChain rejects a Frozen assignment');
    assert(
      chainRes.violations.some((v) => v.code === 'ASSIGNMENT_FROZEN'),
      'C2.2: swapParticipantChain rejection code is ASSIGNMENT_FROZEN',
    );
    assert(snapshotAssignments(sched) === before, 'C2.2: engine state byte-identical after rejected Frozen chain');

    const preview = engine.previewSwapChain([req]);
    assert(preview.valid === false, 'C2.2: previewSwapChain rejects a Frozen assignment');
    assert(
      preview.violations.some((v) => v.code === 'ASSIGNMENT_FROZEN'),
      'C2.2: previewSwapChain rejection code is ASSIGNMENT_FROZEN',
    );
    assert(preview.simulatedAssignments.length === 0, 'C2.2: rejected preview returns no simulated assignments');

    const previewSingle = engine.previewSwap(req);
    assert(
      previewSingle.valid === false && previewSingle.violations.some((v) => v.code === 'ASSIGNMENT_FROZEN'),
      'C2.2: previewSwap (single) also rejects the Frozen assignment',
    );
    assert(snapshotAssignments(sched) === before, 'C2.2: engine state byte-identical after rejected Frozen preview');
  }

  // ── Invalid mid-chain → full atomic rollback (engine byte-identical) ──
  {
    const blk = createTimeBlockFromHours(new Date(2026, 5, 3), 6, 14); // A & B overlap (same block)
    const tA = mkTask('c22-A', blk.start, blk.end);
    const tB = mkTask('c22-B', blk.start, blk.end);
    const p1 = mkP('c22-1', [], 'G', Level.L0);
    const p2 = mkP('c22-2', [], 'G', Level.L0);
    const p3 = mkP('c22-3', [], 'G', Level.L2); // L2 → ineligible for the L0-only A slot
    const aA: Assignment = {
      id: 'aA',
      taskId: 'c22-A',
      slotId: 'c22-A-s1',
      participantId: 'c22-1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(1000),
    };
    const aB: Assignment = {
      id: 'aB',
      taskId: 'c22-B',
      slotId: 'c22-B-s1',
      participantId: 'c22-2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(2000),
    };
    const sched = mkSchedule([tA, tB], [p1, p2, p3], [aA, aB]);
    const engine = new SchedulingEngine({}, undefined, undefined, 5);
    engine.addParticipants(sched.participants);
    engine.importSchedule(sched);

    const before = snapshotAssignments(sched);
    // Chain: aA → p3 (HC-1: L2 in L0-only slot) AND aB → p1. Final state invalid.
    const chain: SwapRequest[] = [
      { assignmentId: 'aA', newParticipantId: 'c22-3' },
      { assignmentId: 'aB', newParticipantId: 'c22-1' },
    ];
    const res = engine.swapParticipantChain(chain);
    assert(res.valid === false, 'C2.2: invalid mid-chain → swapParticipantChain returns invalid');
    assert(
      res.violations.some((v) => v.code === 'LEVEL_MISMATCH'),
      `C2.2: rejection is the engineered HC-1 level violation (got ${res.violations.map((v) => v.code).join(',')})`,
    );
    assert(
      snapshotAssignments(sched) === before,
      'C2.2: atomic rollback — every assignment (id/participant/status/updatedAt) restored byte-identical',
    );

    // Positive control: a valid 2-way trade commits and mutates state.
    const blk2 = createTimeBlockFromHours(new Date(2026, 5, 4), 12, 16);
    const blk1 = createTimeBlockFromHours(new Date(2026, 5, 4), 6, 10); // non-overlapping with blk2
    const tC = mkTask('c22-C', blk1.start, blk1.end);
    const tD = mkTask('c22-D', blk2.start, blk2.end);
    const q1 = mkP('c22-q1');
    const q2 = mkP('c22-q2');
    const aC: Assignment = {
      id: 'aC',
      taskId: 'c22-C',
      slotId: 'c22-C-s1',
      participantId: 'c22-q1',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const aD: Assignment = {
      id: 'aD',
      taskId: 'c22-D',
      slotId: 'c22-D-s1',
      participantId: 'c22-q2',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const sched2 = mkSchedule([tC, tD], [q1, q2], [aC, aD]);
    const engine2 = new SchedulingEngine({}, undefined, undefined, 5);
    engine2.addParticipants(sched2.participants);
    engine2.importSchedule(sched2);
    const okRes = engine2.swapParticipantChain([
      { assignmentId: 'aC', newParticipantId: 'c22-q2' },
      { assignmentId: 'aD', newParticipantId: 'c22-q1' },
    ]);
    assert(okRes.valid === true, 'C2.2: a valid 2-way chain commits');
    assert(
      sched2.assignments.find((a) => a.id === 'aC')!.participantId === 'c22-q2' &&
        sched2.assignments.find((a) => a.id === 'aD')!.participantId === 'c22-q1',
      'C2.2: committed chain actually swapped the two participants',
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C2.3 — rescue / Future-SOS / inject never swap a frozen/past donor
// ════════════════════════════════════════════════════════════════════════════

function runC23(assert: AssertFn): void {
  const anchor = new Date(2026, 5, 2, 5, 0); // June-2 05:00 → day-1 past, day-2+ future

  function everySwapModifiable(
    swaps: { assignmentId: string }[],
    byId: Map<string, Assignment>,
    taskMap: Map<string, Task>,
  ): boolean {
    return swaps.every((sw) => {
      const a = byId.get(sw.assignmentId);
      if (!a) return false; // a swap must reference a real schedule assignment
      return isModifiableAssignment(a, taskMap, anchor);
    });
  }

  // Shared roster: pRare on a FROZEN future task FT2 overlapping FT (tempting
  // but forbidden donor); pRare2 free with 'rare' (the legitimate fill).
  function buildRescueEnv(includeFreeRare: boolean) {
    const ptBlk = createTimeBlockFromHours(new Date(2026, 5, 1), 6, 14); // day-1 past
    const ftBlk = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14); // day-2 future
    const ft = mkTask('c23-FT', ftBlk.start, ftBlk.end, ['rare']);
    const ft2 = mkTask('c23-FT2', ftBlk.start, ftBlk.end, []); // same time as FT
    const pt = mkTask('c23-PT', ptBlk.start, ptBlk.end, ['rare']); // past

    const pVac = mkP('c23-pVac', ['rare']);
    const pRare = mkP('c23-pRare', ['rare']);
    const pRare2 = mkP('c23-pRare2', ['rare']);
    const pPast = mkP('c23-pPast', ['rare']);

    const aVac: Assignment = {
      id: 'c23-aVac',
      taskId: 'c23-FT',
      slotId: 'c23-FT-s1',
      participantId: 'c23-pVac',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    // Frozen future donor — must never be displaced.
    const aFT2: Assignment = {
      id: 'c23-aFT2',
      taskId: 'c23-FT2',
      slotId: 'c23-FT2-s1',
      participantId: 'c23-pRare',
      status: AssignmentStatus.Frozen,
      updatedAt: new Date(),
    };
    // Past donor — non-modifiable by time.
    const aPast: Assignment = {
      id: 'c23-aPast',
      taskId: 'c23-PT',
      slotId: 'c23-PT-s1',
      participantId: 'c23-pPast',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const participants = includeFreeRare
      ? [pVac, pRare, pRare2, pPast]
      : [pVac, pRare, pPast];
    const sched = mkSchedule([ft, ft2, pt], participants, [aVac, aFT2, aPast]);
    return sched;
  }

  // ── 3a: a free 'rare' holder exists → rescue fills FT without touching the
  //        frozen aFT2 or the past aPast donor. ──
  {
    const sched = buildRescueEnv(true);
    const taskMap = new Map(sched.tasks.map((t) => [t.id, t]));
    const byId = new Map(sched.assignments.map((a) => [a.id, a]));
    const req: RescueRequest = {
      vacatedAssignmentId: 'c23-aVac',
      taskId: 'c23-FT',
      slotId: 'c23-FT-s1',
      vacatedBy: 'c23-pVac',
    };
    const res = generateRescuePlans(
      sched,
      req,
      anchor,
      0,
      undefined,
      undefined,
      undefined,
      5,
      undefined,
      { ...DEFAULT_CONFIG },
      buildScoreCtx(sched.tasks, sched.participants),
    );
    assert(res.plans.length > 0, 'C2.3-rescue: a plan exists when a free cert-holder is available');
    const allMod = res.plans.every((p) => everySwapModifiable(p.swaps, byId, taskMap));
    assert(allMod, 'C2.3-rescue: every swap in every plan references a modifiable assignment');
    const touchesForbidden = res.plans.some((p) =>
      p.swaps.some((sw) => sw.assignmentId === 'c23-aFT2' || sw.assignmentId === 'c23-aPast'),
    );
    assert(!touchesForbidden, 'C2.3-rescue: no plan displaces the frozen (aFT2) or past (aPast) donor');
  }

  // ── 3b: ONLY the frozen-donor route exists → rescue must return 0 plans
  //        rather than displace a frozen donor.
  //        Roster is exactly {pVac (vacated, excluded), pRare}. pRare is the
  //        sole remaining 'rare' holder and is FROZEN on aFT2, which overlaps
  //        FT — so the only conceivable fill requires displacing a frozen
  //        donor, which rescue must refuse. ──
  {
    const ftBlk = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 14); // day-2 future
    const ft = mkTask('c23b-FT', ftBlk.start, ftBlk.end, ['rare']);
    const ft2 = mkTask('c23b-FT2', ftBlk.start, ftBlk.end, []); // same time as FT
    const pVac = mkP('c23b-pVac', ['rare']);
    const pRare = mkP('c23b-pRare', ['rare']);
    const aVac: Assignment = {
      id: 'c23b-aVac',
      taskId: 'c23b-FT',
      slotId: 'c23b-FT-s1',
      participantId: 'c23b-pVac',
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    };
    const aFT2: Assignment = {
      id: 'c23b-aFT2',
      taskId: 'c23b-FT2',
      slotId: 'c23b-FT2-s1',
      participantId: 'c23b-pRare',
      status: AssignmentStatus.Frozen,
      updatedAt: new Date(),
    };
    const sched = mkSchedule([ft, ft2], [pVac, pRare], [aVac, aFT2]);
    const req: RescueRequest = {
      vacatedAssignmentId: 'c23b-aVac',
      taskId: 'c23b-FT',
      slotId: 'c23b-FT-s1',
      vacatedBy: 'c23b-pVac',
    };
    const res = generateRescuePlans(
      sched,
      req,
      anchor,
      0,
      undefined,
      undefined,
      undefined,
      5,
      undefined,
      { ...DEFAULT_CONFIG },
      buildScoreCtx(sched.tasks, sched.participants),
    );
    assert(
      res.plans.length === 0,
      `C2.3-rescue: returns 0 plans rather than displacing a frozen donor (got ${res.plans.length})`,
    );
  }

  // ── 3c: Future-SOS (shared chain primitive) — every swap modifiable ──
  {
    const sched = buildRescueEnv(true);
    const taskMap = new Map(sched.tasks.map((t) => [t.id, t]));
    const byId = new Map(sched.assignments.map((a) => [a.id, a]));
    // Focal = pVac, window covers FT (day-2). FSOS must rescue aVac like above.
    const window = { start: new Date(2026, 5, 2, 0, 0), end: new Date(2026, 5, 3, 0, 0) };
    const res = generateBatchRescuePlans(
      sched,
      { participantId: 'c23-pVac', window },
      anchor,
      { config: { ...DEFAULT_CONFIG }, scoreCtx: buildScoreCtx(sched.tasks, sched.participants), maxPlans: 3 },
    );
    // Whether or not a plan is found, NONE may include a non-modifiable swap.
    const allMod = res.plans.every((p) => everySwapModifiable(p.swaps, byId, taskMap));
    assert(allMod, 'C2.3-fsos: every swap in every Future-SOS plan references a modifiable assignment');
    const touchesForbidden = res.plans.some((p) =>
      p.swaps.some((sw) => sw.assignmentId === 'c23-aFT2' || sw.assignmentId === 'c23-aPast'),
    );
    assert(!touchesForbidden, 'C2.3-fsos: no Future-SOS plan displaces the frozen or past donor');
  }

  // ── 3d: inject — chosen plans never chain through a frozen/past assignment ──
  {
    // Non-empty schedule: P1 (only 'special' holder) is FROZEN on t-old which
    // overlaps the inject window. The frozen donor must never be displaced.
    const oldBlk = createTimeBlockFromHours(new Date(2026, 5, 2), 6, 10); // day-2 future
    const tOld = mkTask('c23-iold', oldBlk.start, oldBlk.end);
    const p1 = mkP('c23-ip1', ['special']);
    const p2 = mkP('c23-ip2', []);
    const aOldFrozen: Assignment = {
      id: 'c23-iaOld',
      taskId: 'c23-iold',
      slotId: 'c23-iold-s1',
      participantId: 'c23-ip1',
      status: AssignmentStatus.Frozen,
      updatedAt: new Date(),
    };
    const sched = mkSchedule([tOld], [p1, p2], [aOldFrozen]);
    const engine = new SchedulingEngine({}, undefined, undefined, 5);
    engine.addParticipants(sched.participants);
    engine.importSchedule(sched);

    const spec: InjectedTaskSpec = {
      name: 'C23-Inject',
      dayIndex: 2,
      startHour: 6,
      startMinute: 0,
      durationHours: 4, // overlaps t-old (06:00–10:00 day-2)
      subTeams: [],
      slots: [
        {
          id: 'c23-islot',
          label: 'IS',
          acceptableLevels: [{ level: Level.L0 }],
          requiredCertifications: ['special'],
        },
      ],
      sameGroupRequired: false,
      blocksConsecutive: false,
      baseLoadWeight: 1,
    };
    const { result } = searchInjectionPlans(engine, spec, { anchor });
    assert(result !== null, 'C2.3-inject: searchInjectionPlans returns a result');
    if (result) {
      const taskMap = new Map(sched.tasks.map((t) => [t.id, t]));
      const byId = new Map(sched.assignments.map((a) => [a.id, a]));
      let frozenDonorTouched = false;
      for (const plan of result.plans) {
        for (const oc of plan.outcomes) {
          for (const step of oc.swapChain ?? []) {
            const a = byId.get(step.assignmentId);
            // Steps may reference the injected task's own (future, modifiable)
            // placeholder/new assignment, which is not in our pre-existing
            // `byId`. Only pre-existing schedule assignments are checked.
            if (a && !isModifiableAssignment(a, taskMap, anchor)) frozenDonorTouched = true;
            if (step.assignmentId === 'c23-iaOld') frozenDonorTouched = true;
          }
        }
      }
      assert(
        !frozenDonorTouched,
        'C2.3-inject: no inject plan chains through the frozen t-old donor (only-special-holder)',
      );
      // The frozen donor blocks the only candidate → the slot is unsolvable,
      // which is the correct safe outcome (never a frozen-donor displacement).
      assert(
        result.unsolvableSlotIds.length === 1,
        'C2.3-inject: inject slot left unsolvable rather than displacing a frozen donor',
      );
      result.cancel();
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// C2.4 — freeze/unfreeze must restore preFreezeStatus for a Manual assignment
// ════════════════════════════════════════════════════════════════════════════

function runC24(assert: AssertFn): void {
  // Task is on day-3 (June-3 06:00–14:00). Assignment status = Manual.
  const tBlk = createTimeBlockFromHours(new Date(2026, 5, 3), 6, 14);
  const t = mkTask('c24-t', tBlk.start, tBlk.end);
  const pM = mkP('c24-pM');

  function freshSchedule(): Schedule {
    const aManual: Assignment = {
      id: 'c24-aM',
      taskId: 'c24-t',
      slotId: 'c24-t-s1',
      participantId: 'c24-pM',
      status: AssignmentStatus.Manual,
      updatedAt: new Date(),
    };
    return mkSchedule([t], [pM], [aManual]);
  }

  // ── Path 1: anchor advance (freeze) → anchor retreat (unfreeze via freezeAssignments) ──
  {
    const sched = freshSchedule();
    const aM = () => sched.assignments.find((a) => a.id === 'c24-aM')!;

    // Anchor before the task → still future, untouched.
    freezeAssignments(sched, new Date(2026, 5, 3, 0, 0));
    assert(aM().status === AssignmentStatus.Manual, 'C2.4: Manual stays Manual while task is still future');

    // Advance anchor past the task end → freeze it.
    freezeAssignments(sched, new Date(2026, 5, 3, 23, 0));
    assert(aM().status === AssignmentStatus.Frozen, 'C2.4: assignment freezes when anchor passes the task');
    assert(aM().preFreezeStatus === AssignmentStatus.Manual, 'C2.4: preFreezeStatus snapshots the Manual status');

    // Move anchor back before the task → must restore Manual, NOT Scheduled.
    freezeAssignments(sched, new Date(2026, 5, 3, 0, 0));
    assert(
      aM().status === AssignmentStatus.Manual,
      `C2.4: freeze-then-unfreeze restores Manual (got ${aM().status})`,
    );
    assert(aM().preFreezeStatus === undefined, 'C2.4: preFreezeStatus cleared after restore');
  }

  // ── Path 2: explicit unfreezeAll() must also restore Manual ──
  {
    const sched = freshSchedule();
    const aM = () => sched.assignments.find((a) => a.id === 'c24-aM')!;
    freezeAssignments(sched, new Date(2026, 5, 3, 23, 0)); // freeze (preFreezeStatus = Manual)
    assert(aM().status === AssignmentStatus.Frozen, 'C2.4: pre-condition — assignment is Frozen');
    const n = unfreezeAll(sched);
    assert(n === 1, 'C2.4: unfreezeAll reports one assignment changed');
    assert(
      aM().status === AssignmentStatus.Manual,
      `C2.4: unfreezeAll restores Manual not Scheduled (got ${aM().status})`,
    );
  }
}

// ─── Public runner ──────────────────────────────────────────────────────────

export async function runRescueExtraTests(assert: AssertFn): Promise<void> {
  console.log('\n── Rescue Extra: C2.1 inject displace-and-backfill ──');
  runC21(assert);
  console.log('\n── Rescue Extra: C2.2 point-of-no-return ──');
  runC22(assert);
  console.log('\n── Rescue Extra: C2.3 no frozen/past donor swaps ──');
  runC23(assert);
  console.log('\n── Rescue Extra: C2.4 freeze/unfreeze Manual ──');
  runC24(assert);
}

// ─── Standalone self-exec ───────────────────────────────────────────────────

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
  runRescueExtraTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
