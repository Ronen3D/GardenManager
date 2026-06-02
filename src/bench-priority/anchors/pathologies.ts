/**
 * Pathology anchors — named harms the baseline is EXPECTED TO FAIL.
 *
 * Each pathology anchor documents one of the 13 binarization-of-continuous
 * problems identified in the research review, in the form of a specific
 * ordering relation the current formula gets wrong. Baseline failure is
 * asserted explicitly: the bench runner records both "expected to fail
 * for baseline" AND "expected to pass for D1+D3" as separate assertions,
 * and mismatches in either direction are phase failures.
 *
 * Five pathologies:
 *  - P-universal-cert-tier  (D1 target — fixed by D1+D3)
 *  - P-saturated-pool       (D3 target — fixed by D1+D3)
 *  - P-adjacency-isolation  (no shipped fix — kept as known unfixed
 *                            pathology for future ordering changes)
 *  - P-restRule-density     (no shipped fix — same)
 *  - P-hamama-realistic     (D1+D3 target — fixed by D1+D3)
 */

import { Level, type Participant, type Task } from '../../models/types';
import { DEFAULT_BASE_DATE, makeParticipant, makeSlot, makeTask } from '../fixtures/shared';
import type { AnchorOutcome, AnchorResult, AnchorSpec } from '../types';
import { ALL_VARIANTS } from '../variants';
import { ctxFor, priorityOf, resetAnchorCounters, tinyL0Pool } from './shared';

// Helper: build an expectedOutcome map where ALL variants are expected
// to fail (default). Individual anchors override per-variant entries
// when a specific variant is known to resolve that pathology.
function baselineExpectedFails(): Record<string, AnchorOutcome> {
  return Object.fromEntries(ALL_VARIANTS.map((v) => [v.id, 'fail' as const]));
}

// Variants that resolve a given pathology. P-adjacency-isolation and
// P-restRule-density currently have NO resolving variant — they document
// known unfixed pathologies of the tiered formula. A future ordering
// change that targets them would append its variant id to a new constant
// here.
const PHASE_2_RESOLVES = ['D1+D3'] as const;

// ─── P-universal-cert-tier ───────────────────────────────────────────────────
//
// L0 + universal-cert task must NOT outrank equally-shaped L0-only task.
// Today: hasCerts=true forces the cert-required task into Tier 2; the no-cert
// task is Tier 4. The cert-required task sorts 10 priority units earlier,
// even though the cert is held by 100% of L0s. Baseline FAILS.

export const P_UNIVERSAL_CERT_TIER: AnchorSpec = {
  id: 'P-universal-cert-tier',
  group: 'pathology',
  description:
    'L0+universal-cert task must NOT outrank equally-shaped L0-only task. Baseline fails: hasCerts → Tier 2 regardless of cert holders fraction.',
  expectedOutcome: {
    ...baselineExpectedFails(),
    ...Object.fromEntries(PHASE_2_RESOLVES.map((id) => [id, 'pass' as const])),
  },
  evaluate(): AnchorResult {
    resetAnchorCounters();
    // 8 L0 participants, all with the cert 'NitzanU' (100% holders).
    const participants: Participant[] = tinyL0Pool({ count: 8, certs: ['NitzanU'] });

    // Task A: L0 + NitzanU (universal cert → 0 actual pool reduction)
    const tA = makeTask({
      name: 'A-univ-cert',
      sourceName: 'A',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 3,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['NitzanU'] })],
    });
    // Task B: L0 no cert
    const tB = makeTask({
      name: 'B-no-cert',
      sourceName: 'B',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 11,
      durationHours: 3,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const tasks = [tA, tB];
    const ctx = ctxFor(tasks, participants);

    const pA = priorityOf(tA, ctx);
    const pB = priorityOf(tB, ctx);

    // The relation that SHOULD hold: A's priority NOT lower than B's
    // (lower = earlier). Concretely: pA >= pB (equivalent or B is earlier).
    const passes = pA >= pB;
    return {
      outcome: passes ? 'pass' : 'fail',
      detail: passes
        ? undefined
        : `Universal-cert task A (priority ${pA}) outranks no-cert task B (priority ${pB}) — Tier 2 trap.`,
      observations: { aPriority: pA, bPriority: pB, gap: pB - pA },
    };
  },
};

// ─── P-saturated-pool ────────────────────────────────────────────────────────
//
// Two tasks: one with eligible-count 12, one with 30. The current S1 sub-priority
// clamps both to 9 → identical priority. Their priorities must differ by ≥ 1.

export const P_SATURATED_POOL: AnchorSpec = {
  id: 'P-saturated-pool',
  group: 'pathology',
  description:
    'Two tasks with eligible pools 12 and 30 must have priorities differing by ≥1 unit. Baseline fails: subMin clamp at 9 collapses both to 9.',
  expectedOutcome: {
    ...baselineExpectedFails(),
    ...Object.fromEntries(PHASE_2_RESOLVES.map((id) => [id, 'pass' as const])),
  },
  evaluate(): AnchorResult {
    resetAnchorCounters();
    // 30 L0+Nitzan participants. 12 of them also hold 'Rare' cert.
    const participants: Participant[] = [];
    for (let i = 0; i < 30; i++) {
      const hasRare = i < 12;
      participants.push(
        makeParticipant({
          id: `p${i + 1}`,
          name: `P${i + 1}`,
          level: Level.L0,
          certs: hasRare ? ['Nitzan', 'Rare'] : ['Nitzan'],
          group: 'ק1',
        }),
      );
    }

    // T-tight: needs L0 + Rare cert → pool = 12
    const tTight = makeTask({
      name: 'T-tight',
      sourceName: 'T-tight',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 3,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Rare'] })],
    });
    // T-wide: needs L0 + Nitzan → pool = 30
    const tWide = makeTask({
      name: 'T-wide',
      sourceName: 'T-wide',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 11,
      durationHours: 3,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'] })],
    });
    const tasks = [tTight, tWide];
    const ctx = ctxFor(tasks, participants);

    const pTight = priorityOf(tTight, ctx);
    const pWide = priorityOf(tWide, ctx);

    // Relation: priorities must differ by at least 1.
    const gap = Math.abs(pWide - pTight);
    const passes = gap >= 1;
    return {
      outcome: passes ? 'pass' : 'fail',
      detail: passes
        ? undefined
        : `12-candidate pool and 30-candidate pool collapse to identical priority ${pTight}. SubMin clamp at 9.`,
      observations: { tightPriority: pTight, widePriority: pWide, gap },
    };
  },
};

// ─── P-adjacency-isolation ───────────────────────────────────────────────────
//
// Isolated blocksConsecutive task and one with 4 boundary-overlapping
// tasks must have different priorities. Today: both contribute the same
// `+1` to stickiness.

export const P_ADJACENCY_ISOLATION: AnchorSpec = {
  id: 'P-adjacency-isolation',
  group: 'pathology',
  description:
    'Isolated blocksConsecutive task and one with 4 boundary-overlapping tasks must have different priorities. Baseline fails: stickiness `+1` is uniform.',
  expectedOutcome: {
    ...baselineExpectedFails(),
    // No shipped variant resolves this anchor — kept as known unfixed
    // pathology of the tiered formula.
  },
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });

    // Task X: isolated blocksConsecutive (no other tasks adjacent)
    const tIso = makeTask({
      name: 'Iso-blocks',
      sourceName: 'Iso',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 14,
      durationHours: 2,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    // Task Y: blocksConsecutive surrounded by 4 adjacent tasks
    const tDense = makeTask({
      name: 'Dense-blocks',
      sourceName: 'Dense',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 10,
      durationHours: 4,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    // 4 tasks adjacent to tDense's boundaries (none adjacent to tIso)
    const adj1 = makeTask({
      name: 'Adj-1',
      sourceName: 'Adj',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 6,
      durationHours: 4,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const adj2 = makeTask({
      name: 'Adj-2',
      sourceName: 'Adj',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 14,
      durationHours: 4,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const adj3 = makeTask({
      name: 'Adj-3',
      sourceName: 'Adj',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 9,
      durationHours: 1,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const adj4 = makeTask({
      name: 'Adj-4',
      sourceName: 'Adj',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 18,
      durationHours: 2,
      blocksConsecutive: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const tasks = [tIso, tDense, adj1, adj2, adj3, adj4];
    const ctx = ctxFor(tasks, participants);

    const pIso = priorityOf(tIso, ctx);
    const pDense = priorityOf(tDense, ctx);

    // Relation: pIso and pDense must differ (Dense should sort earlier).
    const passes = pIso !== pDense;
    return {
      outcome: passes ? 'pass' : 'fail',
      detail: passes ? undefined : `Isolated and dense blocksConsecutive tasks have identical priority ${pIso}.`,
      observations: { isoPriority: pIso, densePriority: pDense, gap: pIso - pDense },
    };
  },
};

// ─── P-restRule-density ──────────────────────────────────────────────────────
//
// 2-task restRule_X vs 4-task restRule_Y, all else equal. The 4-task rule
// is meaningfully tighter (more places the participant can get rest-gap-blocked).
// Today: both tasks get `+1` stickiness from `restRuleId` presence.

export const P_RESTRULE_DENSITY: AnchorSpec = {
  id: 'P-restRule-density',
  group: 'pathology',
  description:
    'A task on a rule shared by 4 tasks must rank higher than one on a rule shared by 2 tasks. Baseline fails: restRuleId stickiness is binary.',
  expectedOutcome: {
    ...baselineExpectedFails(),
    // No shipped variant resolves this anchor — kept as known unfixed
    // pathology of the tiered formula.
  },
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });

    // Rule X — shared by 4 tasks. Rule Y — shared by 2 tasks.
    const RR_X = 'rr-X';
    const RR_Y = 'rr-Y';
    const x1 = makeTask({
      name: 'X-1',
      sourceName: 'X',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 3,
      restRuleId: RR_X,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const x2 = makeTask({
      name: 'X-2',
      sourceName: 'X',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 11,
      durationHours: 3,
      restRuleId: RR_X,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const x3 = makeTask({
      name: 'X-3',
      sourceName: 'X',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 16,
      durationHours: 3,
      restRuleId: RR_X,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const x4 = makeTask({
      name: 'X-4',
      sourceName: 'X',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 21,
      durationHours: 3,
      restRuleId: RR_X,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const y1 = makeTask({
      name: 'Y-1',
      sourceName: 'Y',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 6,
      durationHours: 3,
      restRuleId: RR_Y,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const y2 = makeTask({
      name: 'Y-2',
      sourceName: 'Y',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 2,
      startHour: 16,
      durationHours: 3,
      restRuleId: RR_Y,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const tasks = [x1, x2, x3, x4, y1, y2];
    const ctx = ctxFor(tasks, participants);

    const pX = priorityOf(x1, ctx);
    const pY = priorityOf(y1, ctx);

    // Relation: X-tasks should rank STRICTLY earlier (lower priority value) than Y-tasks.
    const passes = pX < pY;
    return {
      outcome: passes ? 'pass' : 'fail',
      detail: passes ? undefined : `4-task rule X priority ${pX} not strictly lower than 2-task rule Y priority ${pY}.`,
      observations: { xPriority: pX, yPriority: pY, gap: pY - pX },
    };
  },
};

// ─── P-hamama-realistic ──────────────────────────────────────────────────────
//
// Using the realistic Hamama-vs-Shemesh setup: Hamama has a non-lowPrio
// pool of ~8 (L0+Hamama), Shemesh has a non-lowPrio pool of ~32 (L0+Nitzan
// where Nitzan is universal). Their priorities must differ by ≥ 2 units —
// today they both collide at priority 19.

export const P_HAMAMA_REALISTIC: AnchorSpec = {
  id: 'P-hamama-realistic',
  group: 'pathology',
  description:
    'Realistic Hamama-vs-Shemesh setup: priorities must differ by ≥2 units. Baseline fails: both collide at priority 19.',
  expectedOutcome: {
    ...baselineExpectedFails(),
    ...Object.fromEntries(PHASE_2_RESOLVES.map((id) => [id, 'pass' as const])),
  },
  evaluate(): AnchorResult {
    resetAnchorCounters();
    // 40 L0 participants. ALL have Nitzan (universal). 8 also have Hamama.
    const participants: Participant[] = [];
    for (let i = 0; i < 40; i++) {
      const hasHamama = i < 8;
      participants.push(
        makeParticipant({
          id: `p${i + 1}`,
          name: `P${i + 1}`,
          level: Level.L0,
          certs: hasHamama ? ['Nitzan', 'Hamama'] : ['Nitzan'],
          group: `ק${(i % 4) + 1}`,
        }),
      );
    }
    // Add 4 L4 participants who hold Hamama — the lowPriority fallback for Hamama tasks.
    for (let i = 0; i < 4; i++) {
      participants.push(
        makeParticipant({
          id: `l4-${i + 1}`,
          name: `L4-${i + 1}`,
          level: Level.L4,
          certs: ['Nitzan', 'Hamama'],
          group: `ק${(i % 4) + 1}`,
        }),
      );
    }

    // Hamama task — L0 + Hamama, lowPriority L4. blocksConsecutive + sleepRecovery (sticky).
    const hamama = makeTask({
      name: 'Hamama',
      sourceName: 'Hamama',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 12,
      blocksConsecutive: true,
      slots: [
        makeSlot({
          acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
          requiredCertifications: ['Hamama'],
        }),
      ],
    });

    // Shemesh task — L0 + Nitzan (universal). blocksConsecutive + restRule (sticky).
    const shemesh = makeTask({
      name: 'Shemesh',
      sourceName: 'Shemesh',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 14,
      durationHours: 4,
      blocksConsecutive: true,
      restRuleId: 'rr-shemesh',
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'] })],
    });

    const tasks = [hamama, shemesh];
    const ctx = ctxFor(tasks, participants);

    const pHamama = priorityOf(hamama, ctx);
    const pShemesh = priorityOf(shemesh, ctx);

    const gap = Math.abs(pHamama - pShemesh);
    const passes = gap >= 2 && pHamama < pShemesh;
    return {
      outcome: passes ? 'pass' : 'fail',
      detail: passes
        ? undefined
        : `Hamama priority ${pHamama} vs Shemesh ${pShemesh} — gap ${gap}, expected ≥ 2 with Hamama first.`,
      observations: { hamamaPriority: pHamama, shemeshPriority: pShemesh, gap },
    };
  },
};

export const ALL_PATHOLOGY_ANCHORS: readonly AnchorSpec[] = [
  P_UNIVERSAL_CERT_TIER,
  P_SATURATED_POOL,
  P_ADJACENCY_ISOLATION,
  P_RESTRULE_DENSITY,
  P_HAMAMA_REALISTIC,
];
