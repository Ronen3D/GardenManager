/**
 * Invariant anchors — contracts the current baseline already satisfies
 * and every future variant must keep satisfying. Pure regression tests.
 *
 * Five invariants:
 *  - I-rare-cert-shared
 *  - I-sameGroup-always-first
 *  - I-explicit-override-wins
 *  - I-priority-zero-not-jittered
 *  - I-deterministic-under-seed
 *
 * Each anchor's `evaluate()` runs against whatever variant is active —
 * the bench runner installs the variant before calling. For Phase 1 only
 * `baseline` exists; the same anchor implementations will validate
 * D1/D3/D1+D3/D4 once those variants are added.
 */

import { withSeededRandom } from '../../bench-split-tuning/seeded-rng';
import { optimizeMultiAttempt, sortTasksByDifficulty } from '../../engine/optimizer';
import { Level, type Participant, type Task } from '../../models/types';
import {
  DEFAULT_BASE_DATE,
  defaultBenchConfig,
  makeParticipant,
  makeSlot,
  makeTask,
  wideAvailability,
} from '../fixtures/shared';
import type { AnchorResult, AnchorSpec } from '../types';
import { ALL_VARIANTS } from '../variants';
import { ctxFor, priorityOf, resetAnchorCounters, simpleL0Task, tinyL0Pool } from './shared';

// Each invariant anchor is expected to PASS for every variant.
const ALL_VARIANTS_PASS = Object.fromEntries(ALL_VARIANTS.map((v) => [v.id, 'pass' as const]));

// ─── I-rare-cert-shared ──────────────────────────────────────────────────────
//
// Rare cert held by one person. T1 requires the cert; T2 doesn't but
// accepts the same person. T1 must sort before T2 — otherwise greedy can
// claim the cert-holder for T2 and leave T1 unfillable.

export const I_RARE_CERT_SHARED: AnchorSpec = {
  id: 'I-rare-cert-shared',
  group: 'invariant',
  description:
    "Rare cert: T1 (cert-required) must sort before T2 (no cert) when T1's only holder is also eligible for T2.",
  expectedOutcome: ALL_VARIANTS_PASS,
  evaluate(): AnchorResult {
    resetAnchorCounters();
    // 8 L0+Nitzan participants in one group. One participant ALSO holds the rare cert 'Rare'.
    const participants: Participant[] = tinyL0Pool({ count: 8, certs: ['Nitzan'] });
    participants[0] = { ...participants[0], certifications: [...participants[0].certifications, 'Rare'] };

    // T1: 1 slot requiring rare cert (cert rarity 1 - 1/8 = 0.875 > 0.7 → S2 fires → tier −1)
    const t1 = makeTask({
      name: 'T1-rare-cert',
      sourceName: 'T1',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 3,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['Rare'] })],
    });
    // T2: 1 slot no cert
    const t2 = simpleL0Task({ name: 'T2-no-cert', dayIndex: 1, startHour: 11, slotCount: 1, durationHours: 3 });
    const tasks: Task[] = [t1, t2];
    const ctx = ctxFor(tasks, participants);

    const sorted = sortTasksByDifficulty(tasks, 0, ctx);
    const t1Idx = sorted.findIndex((t) => t.id === t1.id);
    const t2Idx = sorted.findIndex((t) => t.id === t2.id);
    const p1 = priorityOf(t1, ctx);
    const p2 = priorityOf(t2, ctx);

    if (t1Idx < t2Idx) {
      return { outcome: 'pass', observations: { t1Priority: p1, t2Priority: p2 } };
    }
    return {
      outcome: 'fail',
      detail: `T1 sorts at index ${t1Idx}; T2 at ${t2Idx}. T1 should be first.`,
      observations: { t1Priority: p1, t2Priority: p2, t1Index: t1Idx, t2Index: t2Idx },
    };
  },
};

// ─── I-sameGroup-always-first ────────────────────────────────────────────────
//
// Every sameGroupRequired task must sort before every non-sameGroup task.

export const I_SAMEGROUP_ALWAYS_FIRST: AnchorSpec = {
  id: 'I-sameGroup-always-first',
  group: 'invariant',
  description: 'Every sameGroupRequired task must sort before every non-sameGroup task (HC-4 dispatch contract).',
  expectedOutcome: ALL_VARIANTS_PASS,
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });

    // Build a mix: 3 sameGroup tasks, 3 non-sameGroup tasks.
    const sg1 = makeTask({
      name: 'SG-1',
      sourceName: 'SG',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 4,
      sameGroupRequired: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const sg2 = makeTask({
      name: 'SG-2',
      sourceName: 'SG',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 12,
      durationHours: 4,
      sameGroupRequired: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const sg3 = makeTask({
      name: 'SG-3',
      sourceName: 'SG',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 18,
      durationHours: 4,
      sameGroupRequired: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const ns1 = simpleL0Task({ name: 'NS-1', dayIndex: 1, startHour: 8, slotCount: 1, durationHours: 3 });
    const ns2 = simpleL0Task({ name: 'NS-2', dayIndex: 1, startHour: 14, slotCount: 1, durationHours: 3 });
    const ns3 = simpleL0Task({ name: 'NS-3', dayIndex: 1, startHour: 20, slotCount: 1, durationHours: 3 });
    const tasks = [ns1, sg1, ns2, sg2, ns3, sg3]; // interleaved
    const ctx = ctxFor(tasks, participants);

    const sorted = sortTasksByDifficulty(tasks, 0, ctx);
    const sgIds = new Set([sg1.id, sg2.id, sg3.id]);
    const nsIds = new Set([ns1.id, ns2.id, ns3.id]);

    // Every sameGroup task must come before every non-sameGroup task.
    let lastSgIdx = -1;
    let firstNsIdx = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      if (sgIds.has(sorted[i].id)) lastSgIdx = i;
      if (nsIds.has(sorted[i].id) && firstNsIdx === sorted.length) firstNsIdx = i;
    }
    if (lastSgIdx < firstNsIdx) {
      return { outcome: 'pass', observations: { lastSgIdx, firstNsIdx } };
    }
    return {
      outcome: 'fail',
      detail: `Some non-sameGroup task sorts before a sameGroup task. lastSgIdx=${lastSgIdx}, firstNsIdx=${firstNsIdx}.`,
      observations: { lastSgIdx, firstNsIdx, sortedIds: sorted.map((t) => t.id).join(',') },
    };
  },
};

// ─── I-explicit-override-wins ────────────────────────────────────────────────
//
// A task with `task.schedulingPriority` set sorts strictly by its override.
// Specifically: a task with `schedulingPriority = 0` sorts before any task
// whose computed (formula) priority is > 0.

export const I_EXPLICIT_OVERRIDE_WINS: AnchorSpec = {
  id: 'I-explicit-override-wins',
  group: 'invariant',
  description: 'task.schedulingPriority = 0 sorts before any task whose computed priority > 0, regardless of formula.',
  expectedOutcome: ALL_VARIANTS_PASS,
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });

    // Normal task (no override) — will land in tier 3 or 4
    const normal = simpleL0Task({ name: 'normal', dayIndex: 1, startHour: 6, slotCount: 1, durationHours: 3 });
    // Override task — schedulingPriority = 0 (highest priority)
    const overridden = makeTask({
      name: 'overridden',
      sourceName: 'overridden',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 18,
      durationHours: 3,
      schedulingPriority: 0,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const tasks = [normal, overridden]; // normal first in input
    const ctx = ctxFor(tasks, participants);

    const sorted = sortTasksByDifficulty(tasks, 0, ctx);
    const overrideIdx = sorted.findIndex((t) => t.id === overridden.id);
    const normalIdx = sorted.findIndex((t) => t.id === normal.id);
    const normalPriority = priorityOf(normal, ctx);

    if (overrideIdx < normalIdx && normalPriority > 0) {
      return { outcome: 'pass', observations: { overrideIdx, normalIdx, normalPriority } };
    }
    return {
      outcome: 'fail',
      detail: `Override task at index ${overrideIdx}; normal at ${normalIdx}; normal priority=${normalPriority}.`,
      observations: { overrideIdx, normalIdx, normalPriority },
    };
  },
};

// ─── I-priority-zero-not-jittered ────────────────────────────────────────────
//
// Under any non-zero jitter, priority-0 tasks remain at the front of the
// sort order. Verifies the `base > 0` guard in `sortTasksByDifficulty`.

export const I_PRIORITY_ZERO_NOT_JITTERED: AnchorSpec = {
  id: 'I-priority-zero-not-jittered',
  group: 'invariant',
  description: 'Under jitter > 0, every priority-0 task remains at the front of the sort order.',
  expectedOutcome: ALL_VARIANTS_PASS,
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });

    // 2 sameGroup (priority-0) tasks + 4 normal non-sameGroup tasks
    const sg1 = makeTask({
      name: 'SG-1',
      sourceName: 'SG',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 6,
      durationHours: 4,
      sameGroupRequired: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const sg2 = makeTask({
      name: 'SG-2',
      sourceName: 'SG',
      baseDate: DEFAULT_BASE_DATE,
      dayIndex: 1,
      startHour: 18,
      durationHours: 4,
      sameGroupRequired: true,
      slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
    });
    const ns1 = simpleL0Task({ name: 'NS-1', dayIndex: 1, startHour: 8, slotCount: 1, durationHours: 3 });
    const ns2 = simpleL0Task({ name: 'NS-2', dayIndex: 1, startHour: 12, slotCount: 1, durationHours: 3 });
    const ns3 = simpleL0Task({ name: 'NS-3', dayIndex: 1, startHour: 16, slotCount: 1, durationHours: 3 });
    const ns4 = simpleL0Task({ name: 'NS-4', dayIndex: 1, startHour: 20, slotCount: 1, durationHours: 3 });
    const tasks = [ns1, sg1, ns2, ns3, sg2, ns4];
    const ctx = ctxFor(tasks, participants);
    const sgIds = new Set([sg1.id, sg2.id]);

    // Run 200 jitter trials; assert sameGroup (priority-0-equivalent)
    // tasks always lead. Mode-agnostic: in both tiered and continuous
    // formulas, sameGroup tasks are the structural-first tier and must
    // never be jittered past non-sameGroup tasks.
    const VIOLATIONS_THRESHOLD = 0;
    let violations = 0;
    for (let trial = 0; trial < 200; trial++) {
      const sorted = sortTasksByDifficulty(tasks, 0.3, ctx);
      const firstNonSg = sorted.findIndex((t) => !sgIds.has(t.id));
      // Every task before firstNonSg should be sameGroup.
      for (let i = 0; i < firstNonSg; i++) {
        if (!sgIds.has(sorted[i].id)) {
          violations++;
          break;
        }
      }
      // Every sameGroup task must be in the prefix (none after firstNonSg).
      for (let i = firstNonSg; i < sorted.length; i++) {
        if (sgIds.has(sorted[i].id)) {
          violations++;
          break;
        }
      }
    }
    if (violations <= VIOLATIONS_THRESHOLD) {
      return { outcome: 'pass', observations: { violations, trials: 200 } };
    }
    return {
      outcome: 'fail',
      detail: `${violations} / 200 jitter trials placed a priority-0 task out of the leading block.`,
      observations: { violations, trials: 200 },
    };
  },
};

// ─── I-deterministic-under-seed ──────────────────────────────────────────────
//
// `optimizeMultiAttempt` wrapped in `withSeededRandom(SEED, ...)` must produce
// identical results across invocations. Verifies the seeded RNG contract.

const SMALL_ATTEMPTS = 8;
const SEED_A = 42;

export const I_DETERMINISTIC_UNDER_SEED: AnchorSpec = {
  id: 'I-deterministic-under-seed',
  group: 'invariant',
  description: 'optimizeMultiAttempt under withSeededRandom(SEED) produces identical results across runs.',
  expectedOutcome: ALL_VARIANTS_PASS,
  evaluate(): AnchorResult {
    resetAnchorCounters();
    const participants = tinyL0Pool({ count: 8, certs: ['Nitzan'] });
    // Need wider availability for a multi-day fixture
    const wide = wideAvailability(DEFAULT_BASE_DATE, 3);
    const adjustedParticipants = participants.map((p) => ({ ...p, availability: wide }));

    const tasks: Task[] = [
      simpleL0Task({ name: 'a', dayIndex: 1, startHour: 6, slotCount: 2, durationHours: 4 }),
      simpleL0Task({ name: 'b', dayIndex: 1, startHour: 12, slotCount: 2, durationHours: 4 }),
      simpleL0Task({ name: 'c', dayIndex: 2, startHour: 6, slotCount: 2, durationHours: 4 }),
    ];

    const config = defaultBenchConfig();

    const run1 = withSeededRandom(SEED_A, () =>
      optimizeMultiAttempt(tasks, adjustedParticipants, config, [], SMALL_ATTEMPTS),
    );
    const run2 = withSeededRandom(SEED_A, () =>
      optimizeMultiAttempt(tasks, adjustedParticipants, config, [], SMALL_ATTEMPTS),
    );

    if (
      run1.score.compositeScore === run2.score.compositeScore &&
      run1.unfilledSlots.length === run2.unfilledSlots.length &&
      run1.assignments.length === run2.assignments.length
    ) {
      // Deep-compare assignments (sorted by slot to neutralize trivial order
      // changes if any exist in the result).
      const key = (a: { taskId: string; slotId: string; participantId: string }) =>
        `${a.taskId}|${a.slotId}|${a.participantId}`;
      const s1 = run1.assignments.map(key).sort().join('\n');
      const s2 = run2.assignments.map(key).sort().join('\n');
      if (s1 === s2) {
        return {
          outcome: 'pass',
          observations: {
            compositeScore: run1.score.compositeScore,
            attemptOfBest: run1.attemptOfBest ?? 0,
          },
        };
      }
      return {
        outcome: 'fail',
        detail: 'Composite score and counts match but assignment SET differs.',
        observations: { compositeScore1: run1.score.compositeScore, compositeScore2: run2.score.compositeScore },
      };
    }
    return {
      outcome: 'fail',
      detail: `Mismatched results: composite ${run1.score.compositeScore} vs ${run2.score.compositeScore}, unfilled ${run1.unfilledSlots.length} vs ${run2.unfilledSlots.length}.`,
      observations: {
        composite1: run1.score.compositeScore,
        composite2: run2.score.compositeScore,
        unfilled1: run1.unfilledSlots.length,
        unfilled2: run2.unfilledSlots.length,
      },
    };
  },
};

export const ALL_INVARIANT_ANCHORS: readonly AnchorSpec[] = [
  I_RARE_CERT_SHARED,
  I_SAMEGROUP_ALWAYS_FIRST,
  I_EXPLICIT_OVERRIDE_WINS,
  I_PRIORITY_ZERO_NOT_JITTERED,
  I_DETERMINISTIC_UNDER_SEED,
];
