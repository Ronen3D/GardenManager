/**
 * WP3 — Constraints & validator extra coverage (C3.1–C3.4).
 * Group A (pure src/, no src/web). Runs under tsconfig.json via `npm test`;
 * also self-runnable: `npx ts-node src/test-validator-extra.ts`.
 *
 * Covers:
 *  - C3.1 (P0) `previewSwap` vs globally-disabled hard constraints (behavior
 *    pinned for independent review — see the C3.1 block).
 *  - C3.2 (P1) `disabledHC` round-trip suppression for HC-2/3/4/7/8/11/12.
 *  - C3.3 (P1) `collectSoftWarnings` SC-7 GROUP_MISMATCH + SC-10 family.
 *  - C3.4 (P1) SC-9 `computeNotWithPenalty` sub-team partitioning.
 */

import { computeNotWithPenalty } from './constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  type AvailabilityWindow,
  collectSoftWarnings,
  type Participant,
  DEFAULT_CONFIG,
  Level,
  previewSwap,
  type SwapRequest,
  type Task,
  validateHardConstraints,
  ViolationSeverity,
} from './index';

type AssertFn = (condition: boolean, name: string) => void;

// ─── Builders ────────────────────────────────────────────────────────────────

const BASE = new Date(2026, 4, 17); // op-day anchor; calendar irrelevant
const WIDE: AvailabilityWindow[] = [
  { start: new Date(2026, 4, 17, 0, 0), end: new Date(2026, 4, 27, 0, 0) },
];

function mkP(
  id: string,
  level: Level = Level.L0,
  certs: string[] = [],
  group = 'A',
  extra: Partial<Participant> = {},
): Participant {
  return {
    id,
    name: id,
    level,
    certifications: certs,
    group,
    availability: WIDE,
    dateUnavailability: [],
    ...extra,
  };
}

function tb(startH: number, endH: number) {
  return {
    start: new Date(2026, 4, 18, startH, 0),
    end: new Date(2026, 4, 18, endH, 0),
  };
}

function mkA(id: string, taskId: string, slotId: string, participantId: string): Assignment {
  return {
    id,
    taskId,
    slotId,
    participantId,
    status: AssignmentStatus.Scheduled,
    updatedAt: BASE,
  };
}

// ════════════════════════════════════════════════════════════════════════════
export async function runValidatorExtraTests(assert: AssertFn): Promise<void> {
  // ──────────────────────────────────────────────────────────────────────────
  // C3.1 (P0) — REVIEW: previewSwap vs the globally-disabled hard-constraint set
  //
  // Open question under independent review: when a hard constraint is in the
  // frozen `disabledHardConstraints` set, should a manual-swap *preview*
  // (`previewSwap`) report a swap that only that constraint would reject as
  // valid, matching the committed engine path? This block exercises the
  // current behavior and pins it; the hypothesized alternative behavior is
  // recorded as a commented-out assertion below and is intentionally NOT
  // asserted pending that investigation.
  // ──────────────────────────────────────────────────────────────────────────
  {
    const t1: Task = {
      id: 'c31-t1',
      name: 'heavy-A',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [{ slotId: 'c31-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: true,
    };
    const t2: Task = {
      id: 'c31-t2',
      name: 'heavy-B',
      timeBlock: tb(10, 14), // starts exactly when t1 ends → consecutive
      requiredCount: 1,
      slots: [{ slotId: 'c31-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: true,
    };
    const pA = mkP('c31-pA');
    const pB = mkP('c31-pB');
    const tasks = [t1, t2];
    const participants = [pA, pB];
    // Current (valid) schedule: pA on t1, pB on t2.
    const assignments = [mkA('c31-a1', t1.id, 'c31-s1', pA.id), mkA('c31-a2', t2.id, 'c31-s2', pB.id)];
    // Swap: put pA (already on t1) into t2's slot → back-to-back blocking tasks.
    const swap: SwapRequest = { assignmentId: 'c31-a2', newParticipantId: pA.id };

    // Sanity: with no constraint disabled the swap IS rejected by HC-12.
    const baseline = previewSwap(tasks, participants, assignments, swap);
    const baselineHasHc12 = baseline.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD');
    assert(
      !baseline.valid && baselineHasHc12,
      'C3.1.a — sanity: the swap triggers HC-12 (CONSECUTIVE_HIGH_LOAD) in previewSwap',
    );

    // The validation layer CAN suppress HC-12 when the disabled set is passed.
    // We reproduce previewSwap's post-swap assignment set and validate directly.
    const postSwap = assignments.map((a) =>
      a.id === swap.assignmentId ? { ...a, participantId: swap.newParticipantId } : { ...a },
    );
    const directDisabled = validateHardConstraints(tasks, participants, postSwap, new Set(['HC-12']));
    assert(
      directDisabled.valid && !directDisabled.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD'),
      'C3.1.b — validateHardConstraints honors disabled HC-12 on the post-swap set (suppression works at the validation layer)',
    );

    // Current behavior pinned (PASS): the `previewSwap` signature exposes no
    // parameter for the globally-disabled set, so even with HC-12 nominally
    // disabled the preview still reports the swap invalid with HC-12. This
    // assertion records the current behavior; if a change makes previewSwap
    // honor the disabled set this assert flips, which is the signal to restore
    // the commented-out assertion below.
    const bugPreview = previewSwap(tasks, participants, assignments, swap);
    assert(
      !bugPreview.valid && bugPreview.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD'),
      'C3.1.c — current behavior: previewSwap reports the swap invalid with HC-12 even though HC-12 is nominally disabled (no disabledHC param exists)',
    );

    // REVIEW (open question, intentionally NOT asserted pending independent
    // investigation): if `previewSwap` should honor the frozen disabled set,
    // the expected behavior would be `bugPreview.valid === true` when HC-12 is
    // globally disabled. Restore this assertion if/when that is decided correct.
    // assert(bugPreview.valid, 'C3.1 — previewSwap reports the swap VALID when HC-12 is globally disabled');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // C3.2 (P1) — disabledHC round-trip suppression in validateHardConstraints.
  // For each code: violation present at baseline, suppressed once disabled.
  // (HC-1/5/6/14/15 already covered in src/test.ts — not duplicated here.)
  // ──────────────────────────────────────────────────────────────────────────

  // HC-2 → CERT_MISSING
  {
    const task: Task = {
      id: 'c32-2-t',
      name: 'cert-task',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [{ slotId: 'c32-2-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'] }],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    const p = mkP('c32-2-p'); // no certs
    const a = [mkA('c32-2-a', task.id, 'c32-2-s', p.id)];
    const base = validateHardConstraints([task], [p], a);
    assert(base.violations.some((v) => v.code === 'CERT_MISSING'), 'C3.2 HC-2.a — CERT_MISSING reported at baseline');
    const gated = validateHardConstraints([task], [p], a, new Set(['HC-2']));
    assert(
      !gated.violations.some((v) => v.code === 'CERT_MISSING'),
      'C3.2 HC-2.b — disabled HC-2 suppresses CERT_MISSING',
    );
  }

  // HC-3 → AVAILABILITY_VIOLATION
  {
    const task: Task = {
      id: 'c32-3-t',
      name: 'avail-task',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [{ slotId: 'c32-3-s', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    // Availability does NOT cover 06:00–10:00.
    const p = mkP('c32-3-p', Level.L0, [], 'A', {
      availability: [{ start: new Date(2026, 4, 18, 12, 0), end: new Date(2026, 4, 18, 20, 0) }],
    });
    const a = [mkA('c32-3-a', task.id, 'c32-3-s', p.id)];
    const base = validateHardConstraints([task], [p], a);
    assert(
      base.violations.some((v) => v.code === 'AVAILABILITY_VIOLATION'),
      'C3.2 HC-3.a — AVAILABILITY_VIOLATION reported at baseline',
    );
    const gated = validateHardConstraints([task], [p], a, new Set(['HC-3']));
    assert(
      !gated.violations.some((v) => v.code === 'AVAILABILITY_VIOLATION'),
      'C3.2 HC-3.b — disabled HC-3 suppresses AVAILABILITY_VIOLATION',
    );
  }

  // HC-4 → GROUP_MISMATCH (HC-8 disabled in both runs to isolate the HC-4 toggle)
  {
    const task: Task = {
      id: 'c32-4-t',
      name: 'group-task',
      timeBlock: tb(6, 10),
      requiredCount: 2,
      slots: [
        { slotId: 'c32-4-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        { slotId: 'c32-4-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      ],
      sameGroupRequired: true,
      blocksConsecutive: false,
    };
    const pA = mkP('c32-4-pA', Level.L0, [], 'GroupA');
    const pB = mkP('c32-4-pB', Level.L0, [], 'GroupB');
    const a = [mkA('c32-4-a1', task.id, 'c32-4-s1', pA.id), mkA('c32-4-a2', task.id, 'c32-4-s2', pB.id)];
    const base = validateHardConstraints([task], [pA, pB], a, new Set(['HC-8']));
    assert(
      base.violations.some((v) => v.code === 'GROUP_MISMATCH'),
      'C3.2 HC-4.a — GROUP_MISMATCH reported at baseline (HC-8 isolated out)',
    );
    const gated = validateHardConstraints([task], [pA, pB], a, new Set(['HC-8', 'HC-4']));
    assert(
      !gated.violations.some((v) => v.code === 'GROUP_MISMATCH'),
      'C3.2 HC-4.b — disabled HC-4 suppresses GROUP_MISMATCH',
    );
  }

  // HC-7 → DUPLICATE_IN_TASK (HC-5 disabled in both runs to isolate the HC-7 toggle)
  {
    const task: Task = {
      id: 'c32-7-t',
      name: 'dup-task',
      timeBlock: tb(6, 10),
      requiredCount: 2,
      slots: [
        { slotId: 'c32-7-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        { slotId: 'c32-7-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      ],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    const p = mkP('c32-7-p');
    const a = [mkA('c32-7-a1', task.id, 'c32-7-s1', p.id), mkA('c32-7-a2', task.id, 'c32-7-s2', p.id)];
    const base = validateHardConstraints([task], [p], a, new Set(['HC-5']));
    assert(
      base.violations.some((v) => v.code === 'DUPLICATE_IN_TASK'),
      'C3.2 HC-7.a — DUPLICATE_IN_TASK reported at baseline (HC-5 isolated out)',
    );
    const gated = validateHardConstraints([task], [p], a, new Set(['HC-5', 'HC-7']));
    assert(
      !gated.violations.some((v) => v.code === 'DUPLICATE_IN_TASK'),
      'C3.2 HC-7.b — disabled HC-7 suppresses DUPLICATE_IN_TASK',
    );
  }

  // HC-8 → GROUP_INSUFFICIENT (sameGroupRequired group too small to fill all slots)
  {
    const task: Task = {
      id: 'c32-8-t',
      name: 'feasibility-task',
      timeBlock: tb(6, 10),
      requiredCount: 2,
      slots: [
        { slotId: 'c32-8-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        { slotId: 'c32-8-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      ],
      sameGroupRequired: true,
      blocksConsecutive: false,
    };
    // Only one member in the assigned group, but the task needs two slots.
    const p1 = mkP('c32-8-p1', Level.L0, [], 'OnlyGroup');
    const a = [mkA('c32-8-a1', task.id, 'c32-8-s1', p1.id)];
    const base = validateHardConstraints([task], [p1], a);
    assert(
      base.violations.some((v) => v.code === 'GROUP_INSUFFICIENT'),
      'C3.2 HC-8.a — GROUP_INSUFFICIENT reported at baseline',
    );
    const gated = validateHardConstraints([task], [p1], a, new Set(['HC-8']));
    assert(
      !gated.violations.some((v) => v.code === 'GROUP_INSUFFICIENT'),
      'C3.2 HC-8.b — disabled HC-8 suppresses GROUP_INSUFFICIENT',
    );
  }

  // HC-11 → EXCLUDED_CERTIFICATION
  {
    const task: Task = {
      id: 'c32-11-t',
      name: 'forbidden-task',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [
        {
          slotId: 'c32-11-s',
          acceptableLevels: [{ level: Level.L0 }],
          requiredCertifications: [],
          forbiddenCertifications: ['Horesh'],
        },
      ],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    const p = mkP('c32-11-p', Level.L0, ['Horesh']);
    const a = [mkA('c32-11-a', task.id, 'c32-11-s', p.id)];
    const base = validateHardConstraints([task], [p], a);
    assert(
      base.violations.some((v) => v.code === 'EXCLUDED_CERTIFICATION'),
      'C3.2 HC-11.a — EXCLUDED_CERTIFICATION reported at baseline',
    );
    const gated = validateHardConstraints([task], [p], a, new Set(['HC-11']));
    assert(
      !gated.violations.some((v) => v.code === 'EXCLUDED_CERTIFICATION'),
      'C3.2 HC-11.b — disabled HC-11 suppresses EXCLUDED_CERTIFICATION',
    );
  }

  // HC-12 → CONSECUTIVE_HIGH_LOAD
  {
    const t1: Task = {
      id: 'c32-12-t1',
      name: 'consec-A',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [{ slotId: 'c32-12-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: true,
    };
    const t2: Task = {
      id: 'c32-12-t2',
      name: 'consec-B',
      timeBlock: tb(10, 14),
      requiredCount: 1,
      slots: [{ slotId: 'c32-12-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: true,
    };
    const p = mkP('c32-12-p');
    const a = [mkA('c32-12-a1', t1.id, 'c32-12-s1', p.id), mkA('c32-12-a2', t2.id, 'c32-12-s2', p.id)];
    const base = validateHardConstraints([t1, t2], [p], a);
    assert(
      base.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD'),
      'C3.2 HC-12.a — CONSECUTIVE_HIGH_LOAD reported at baseline',
    );
    const gated = validateHardConstraints([t1, t2], [p], a, new Set(['HC-12']));
    assert(
      !gated.violations.some((v) => v.code === 'CONSECUTIVE_HIGH_LOAD'),
      'C3.2 HC-12.b — disabled HC-12 suppresses CONSECUTIVE_HIGH_LOAD',
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // C3.3 (P1) — collectSoftWarnings emits SC-7 GROUP_MISMATCH + the SC-10
  // family (LESS_PREFERRED_ASSIGNMENT / PREFERRED_NAME_UNAVAILABLE /
  // PREFERRED_NOT_SATISFIED). These render as mobile schedule chips/tooltips.
  // (LOW_PRIORITY_LEVEL is already covered elsewhere — not duplicated.)
  // ──────────────────────────────────────────────────────────────────────────
  {
    const taskH: Task = {
      id: 'c33-tH',
      name: 'Hamama',
      sourceName: 'HamamaSrc',
      timeBlock: tb(6, 10),
      requiredCount: 1,
      slots: [{ slotId: 'c33-h1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    const taskX: Task = {
      id: 'c33-tX',
      name: 'Xanadu',
      sourceName: 'XanaduSrc',
      timeBlock: tb(12, 16),
      requiredCount: 1,
      slots: [{ slotId: 'c33-x1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
      sameGroupRequired: false,
      blocksConsecutive: false,
    };
    const taskG: Task = {
      id: 'c33-tG',
      name: 'Geffen',
      sourceName: 'GeffenSrc',
      timeBlock: tb(18, 22),
      requiredCount: 2,
      slots: [
        { slotId: 'c33-g1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        { slotId: 'c33-g2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
      ],
      sameGroupRequired: true,
      blocksConsecutive: false,
    };
    const pLess = mkP('c33-pLess', Level.L0, [], 'A', { lessPreferredTaskName: 'HamamaSrc' });
    const pGhost = mkP('c33-pGhost', Level.L0, [], 'A', { preferredTaskName: 'NoSuchSrc' });
    const pPref = mkP('c33-pPref', Level.L0, [], 'A', { preferredTaskName: 'HamamaSrc' });
    const pGrpA = mkP('c33-pGrpA', Level.L0, [], 'GroupA');
    const pGrpB = mkP('c33-pGrpB', Level.L0, [], 'GroupB');
    const participants = [pLess, pGhost, pPref, pGrpA, pGrpB];
    const tasks = [taskH, taskX, taskG];
    const assignments = [
      mkA('c33-aH', taskH.id, 'c33-h1', pLess.id),
      mkA('c33-aX', taskX.id, 'c33-x1', pPref.id),
      mkA('c33-aG1', taskG.id, 'c33-g1', pGrpA.id),
      mkA('c33-aG2', taskG.id, 'c33-g2', pGrpB.id),
    ];

    const warnings = collectSoftWarnings(tasks, participants, assignments);

    const sc7 = warnings.filter((w) => w.code === 'GROUP_MISMATCH');
    assert(
      sc7.length === 1 && sc7[0].taskId === taskG.id && sc7[0].severity === ViolationSeverity.Warning,
      'C3.3.a — SC-7 GROUP_MISMATCH emitted once for the mixed-group sameGroupRequired task (Warning severity)',
    );

    const lessPref = warnings.filter(
      (w) => w.code === 'LESS_PREFERRED_ASSIGNMENT' && w.participantId === pLess.id,
    );
    assert(
      lessPref.length === 1 && lessPref[0].taskId === taskH.id,
      'C3.3.b — SC-10 LESS_PREFERRED_ASSIGNMENT emitted for participant assigned to their less-preferred task name',
    );

    const nameUnavail = warnings.filter(
      (w) => w.code === 'PREFERRED_NAME_UNAVAILABLE' && w.participantId === pGhost.id,
    );
    assert(
      nameUnavail.length === 1,
      'C3.3.c — SC-10 PREFERRED_NAME_UNAVAILABLE emitted when preferredTaskName is absent from the schedule',
    );

    const notSatisfied = warnings.filter(
      (w) => w.code === 'PREFERRED_NOT_SATISFIED' && w.participantId === pPref.id,
    );
    assert(
      notSatisfied.length === 1,
      'C3.3.d — SC-10 PREFERRED_NOT_SATISFIED emitted when an existing preferredTaskName is never assigned',
    );

    // Negative: pPref must NOT also produce PREFERRED_NAME_UNAVAILABLE (its
    // preferred name DOES exist in the schedule) — guards the branch ordering.
    assert(
      !warnings.some((w) => w.code === 'PREFERRED_NAME_UNAVAILABLE' && w.participantId === pPref.id),
      'C3.3.e — participant whose preferredTaskName exists does NOT get PREFERRED_NAME_UNAVAILABLE',
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // C3.4 (P1) — SC-9 computeNotWithPenalty sub-team partitioning.
  // A not-with pair in DIFFERENT subTeamId of the same togethernessRelevant
  // task is NOT penalised; in the SAME sub-team (or both no subTeamId) it IS.
  // ──────────────────────────────────────────────────────────────────────────
  {
    const pX = mkP('c34-pX');
    const pY = mkP('c34-pY');
    const notWithPairs = new Map<string, Set<string>>([
      [pX.id, new Set([pY.id])],
      [pY.id, new Set([pX.id])],
    ]);

    const buildMaps = (task: Task, assigns: Assignment[]) => {
      const taskMap = new Map<string, Task>([[task.id, task]]);
      const byTask = new Map<string, Assignment[]>([[task.id, assigns]]);
      return { taskMap, byTask };
    };

    // Scenario A — DIFFERENT sub-teams → NOT penalised.
    {
      const task: Task = {
        id: 'c34-tA',
        name: 'split-task',
        timeBlock: tb(6, 10),
        requiredCount: 2,
        slots: [
          {
            slotId: 'c34-A-s1',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: [],
            subTeamId: 'st1',
          },
          {
            slotId: 'c34-A-s2',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: [],
            subTeamId: 'st2',
          },
        ],
        sameGroupRequired: false,
        blocksConsecutive: false,
        togethernessRelevant: true,
      };
      const assigns = [mkA('c34-A-a1', task.id, 'c34-A-s1', pX.id), mkA('c34-A-a2', task.id, 'c34-A-s2', pY.id)];
      const { taskMap, byTask } = buildMaps(task, assigns);
      const penalty = computeNotWithPenalty(assigns, DEFAULT_CONFIG, taskMap, byTask, notWithPairs);
      assert(penalty === 0, 'C3.4.a — not-with pair split across DIFFERENT sub-teams incurs zero SC-9 penalty');
    }

    // Scenario B — SAME sub-team → penalised once.
    {
      const task: Task = {
        id: 'c34-tB',
        name: 'shared-task',
        timeBlock: tb(6, 10),
        requiredCount: 2,
        slots: [
          {
            slotId: 'c34-B-s1',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: [],
            subTeamId: 'st1',
          },
          {
            slotId: 'c34-B-s2',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: [],
            subTeamId: 'st1',
          },
        ],
        sameGroupRequired: false,
        blocksConsecutive: false,
        togethernessRelevant: true,
      };
      const assigns = [mkA('c34-B-a1', task.id, 'c34-B-s1', pX.id), mkA('c34-B-a2', task.id, 'c34-B-s2', pY.id)];
      const { taskMap, byTask } = buildMaps(task, assigns);
      const penalty = computeNotWithPenalty(assigns, DEFAULT_CONFIG, taskMap, byTask, notWithPairs);
      assert(
        penalty === DEFAULT_CONFIG.notWithPenalty,
        'C3.4.b — not-with pair in the SAME sub-team incurs exactly one SC-9 notWithPenalty',
      );
    }

    // Scenario C — no subTeamId on either slot → single '__all__' group → penalised.
    {
      const task: Task = {
        id: 'c34-tC',
        name: 'flat-task',
        timeBlock: tb(6, 10),
        requiredCount: 2,
        slots: [
          { slotId: 'c34-C-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
          { slotId: 'c34-C-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        ],
        sameGroupRequired: false,
        blocksConsecutive: false,
        togethernessRelevant: true,
      };
      const assigns = [mkA('c34-C-a1', task.id, 'c34-C-s1', pX.id), mkA('c34-C-a2', task.id, 'c34-C-s2', pY.id)];
      const { taskMap, byTask } = buildMaps(task, assigns);
      const penalty = computeNotWithPenalty(assigns, DEFAULT_CONFIG, taskMap, byTask, notWithPairs);
      assert(
        penalty === DEFAULT_CONFIG.notWithPenalty,
        'C3.4.c — not-with pair in slots without subTeamId share the "__all__" group and ARE penalised',
      );
    }

    // Scenario D — task NOT togethernessRelevant → never penalised.
    {
      const task: Task = {
        id: 'c34-tD',
        name: 'irrelevant-task',
        timeBlock: tb(6, 10),
        requiredCount: 2,
        slots: [
          { slotId: 'c34-D-s1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
          { slotId: 'c34-D-s2', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] },
        ],
        sameGroupRequired: false,
        blocksConsecutive: false,
        togethernessRelevant: false,
      };
      const assigns = [mkA('c34-D-a1', task.id, 'c34-D-s1', pX.id), mkA('c34-D-a2', task.id, 'c34-D-s2', pY.id)];
      const { taskMap, byTask } = buildMaps(task, assigns);
      const penalty = computeNotWithPenalty(assigns, DEFAULT_CONFIG, taskMap, byTask, notWithPairs);
      assert(penalty === 0, 'C3.4.d — non-togethernessRelevant task never incurs SC-9 penalty');
    }
  }
}

// ─── Standalone self-exec (keeps `npx ts-node src/test-validator-extra.ts`) ───
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
  runValidatorExtraTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
