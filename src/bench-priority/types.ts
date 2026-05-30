/**
 * Core types for the priority-ordering benchmark.
 *
 * The bench is structured around three orthogonal concepts:
 *  - **Fixture**: a synthetic or real (participants, tasks, config) tuple.
 *    Each fixture is tagged with the design phase whose mechanisms target
 *    it. The bench runner iterates seeds × fixtures × variants.
 *  - **Variant**: a configuration of the ordering layer being evaluated.
 *    Currently `baseline` (legacy tiered) and `D1+D3` (shipped default).
 *  - **Anchor**: a tiny hand-crafted fixture that pins a specific ordering
 *    relation (invariant) or named pathology. Each anchor runs against every
 *    variant; anchors are independent of the seed-based fixture runs.
 *
 * Per-variant expected outcomes on pathology anchors are part of the
 * acceptance contract — the bench asserts both "expected to pass" AND
 * "expected to still fail" so an unexpected-passing anchor surfaces as a
 * phase failure (likely a bench bug or unintended side effect).
 */

import type {
  AlgorithmSettings,
  Participant,
  SchedulerConfig,
  SleepRecoveryRule,
  Task,
} from '../models/types';

// ─── Fixture ─────────────────────────────────────────────────────────────────

/**
 * Phase tag declaring which design phase's mechanisms a fixture was
 * built to stress. `'D4'` is preserved as a historical value: the D4
 * continuous-priority redesign was evaluated end-to-end (default and
 * tuned coefficients) and didn't pass acceptance, so the corresponding
 * fixtures remain in the bench as regression sentinels for any future
 * ordering change that re-targets them.
 */
export type FixturePhaseTarget = 'baseline' | 'D1' | 'D3' | 'D1+D3' | 'D4' | 'future';

export interface FixtureInstance {
  participants: Participant[];
  tasks: Task[];
  config: SchedulerConfig;
  /** Optional rest-rule duration map (id → hours). Default empty. */
  restRuleMap?: Map<string, number>;
  /** Operational-day boundary. Default 5 (05:00). */
  dayStartHour: number;
  /** Anchor date the tasks were built relative to. */
  baseDate: Date;
  /** Number of operational days the fixture covers. */
  periodDays: number;
  /** Sleep-recovery rules referenced by tasks (for legacy/compat). */
  sleepRecoveryRules?: SleepRecoveryRule[];
}

export interface FixtureSpec {
  /** Stable identifier — used as report column key and in result aggregation. */
  id: string;
  /** Short human description (one line). */
  description: string;
  /** Design phase whose mechanisms target this fixture. Drives acceptance criteria. */
  targetingPhase: FixturePhaseTarget;
  /**
   * Deterministic generator. Given the same `seed`, MUST return byte-identical
   * (participants, tasks, config). Seeds drive cross-variant paired comparison
   * — if the fixture is non-deterministic, the paired-Δ statistic is invalid.
   */
  generate(seed: number): FixtureInstance;
}

// ─── Variant ─────────────────────────────────────────────────────────────────

export type AnchorOutcome = 'pass' | 'fail';

export interface VariantSpec {
  /** Stable identifier — used as report column key. */
  id: string;
  /** Short human description. */
  description: string;
  /**
   * Apply variant-specific configuration. Mutates the inputs IN PLACE if
   * needed (e.g. install a bench hook); MUST return a cleanup function to
   * restore original state. The runner wraps every run in setup/cleanup.
   *
   * For Phase 1, baseline has nothing to apply; cleanup is a no-op.
   * Phase 2/3 variants will install priority-formula overrides here.
   */
  install(settings: AlgorithmSettings): () => void;
}

// ─── Anchor ──────────────────────────────────────────────────────────────────

export type AnchorGroup = 'invariant' | 'pathology';

export interface AnchorResult {
  /** Pass or fail. */
  outcome: AnchorOutcome;
  /** When `fail`, a short human description of what was observed. */
  detail?: string;
  /**
   * Quantitative observations the assertion made — used by the report to
   * track HOW the anchor fails (e.g. "priority gap was 0, expected ≥ 2").
   * Free-form key/value pairs.
   */
  observations?: Record<string, number | string>;
}

export interface AnchorSpec {
  /** Stable identifier — `I-*` for invariants, `P-*` for pathologies. */
  id: string;
  /** Anchor group; drives which-variant-must-pass expectations. */
  group: AnchorGroup;
  /** Short human description (one line) — used in the report. */
  description: string;
  /**
   * Expected outcome per variant id. The bench runner asserts the observed
   * outcome matches the expectation. Variants not listed default to:
   *  - invariant anchors: 'pass' (must always work)
   *  - pathology anchors: ABSENT — caller must declare per variant
   */
  expectedOutcome: Record<string, AnchorOutcome>;
  /**
   * Run the anchor's assertion against the active variant. Variants install
   * themselves before this is called; the anchor sees the active ordering
   * layer transparently. Returns the observed outcome plus structured detail.
   */
  evaluate(): AnchorResult;
}

// ─── Run records ─────────────────────────────────────────────────────────────

export interface SingleRunRecord {
  fixtureId: string;
  variantId: string;
  seed: number;
  // Engine outputs
  feasible: boolean;
  compositeScore: number;
  unfilledSlotCount: number;
  hcViolationCount: number;
  greedyUnfilledCount: number;
  greedyFillRate: number;
  preSACompositeScore: number;
  postSACompositeScore: number;
  finalCompositeScore: number;
  attemptOfBest: number;
  actualAttempts: number;
  // Timing
  runtimeMs: number;
  greedyMs: number;
  saMs: number;
  polishMs: number;
}

export interface AnchorRecord {
  anchorId: string;
  variantId: string;
  observed: AnchorOutcome;
  expected: AnchorOutcome;
  matchesExpectation: boolean;
  detail?: string;
  observations?: Record<string, number | string>;
}

export interface BenchResults {
  /** Per (fixture, variant, seed) run records. */
  runs: SingleRunRecord[];
  /** Per (anchor, variant) records. */
  anchors: AnchorRecord[];
  /** Wall-clock start of the bench. */
  startedAt: Date;
  /** Wall-clock end. */
  finishedAt: Date;
  /** Total bench duration in ms. */
  durationMs: number;
  /** Fixtures registered at run time. */
  fixtureIds: string[];
  /** Variants registered at run time. */
  variantIds: string[];
  /** Seeds used for the seed-based fixture sweep. */
  seeds: number[];
  /** Multi-attempt count passed to optimizeMultiAttempt. */
  attemptsPerRun: number;
}
