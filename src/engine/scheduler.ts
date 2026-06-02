/**
 * Scheduling Engine - Main orchestrator class.
 *
 * Two-stage workflow:
 *  Stage 1: Data Setup — register participants and tasks.
 *  Stage 2: Optimal Generation — generate schedule, with manual overrides.
 */

import { validateHardConstraints } from '../constraints/hard-constraints';
import { collectSoftWarnings, computeScheduleScore, type ScoreContext } from '../constraints/soft-constraints';
import {
  type AlgorithmSettings,
  type Assignment,
  AssignmentStatus,
  type ConstraintViolation,
  DEFAULT_CONFIG,
  type HardConstraintCode,
  type Participant,
  type Schedule,
  type SchedulerConfig,
  type SplitOp,
  type SwapRequest,
  type Task,
  type ValidationResult,
  ViolationSeverity,
} from '../models/types';
import type { ScheduleContext } from '../shared/utils/time-utils';
import { computeAllCapacities } from '../utils/capacity';
import { describeTaskInstance } from '../utils/date-utils';
import { getEffectiveConfig } from './effective-config';
import {
  type MultiAttemptProgressCallback,
  makeSplitHalf,
  type OptimizationResult,
  optimize,
  optimizeMultiAttemptAsync,
  resetAssignmentCounter,
} from './optimizer';
import { mergePhantomRules, type PhantomContext } from './phantom';

/**
 * Result of a non-mutating swap preview: mirrors `ValidationResult` but
 * additionally carries soft-warning deltas, score delta, a snapshot of
 * the simulated post-swap assignments, and the participants affected by
 * the swap (source + destination).
 */
export interface SwapPreview {
  valid: boolean;
  violations: ConstraintViolation[];
  /** Soft warnings present AFTER the swap but not before. */
  addedSoftWarnings: ConstraintViolation[];
  /** Soft warnings present BEFORE the swap but not after. */
  removedSoftWarnings: ConstraintViolation[];
  /** (newScore - oldScore). Negative = improvement (lower penalty). */
  scoreDelta: number;
  /** IDs of participants whose schedule changed (outgoing + incoming + chain). */
  affectedParticipantIds: string[];
  /** Deep-cloned post-swap assignment snapshot. Engine state itself is rolled back. */
  simulatedAssignments: Assignment[];
}

/** Stable key for diffing soft warnings between pre- and post-swap states. */
function softWarningKey(w: ConstraintViolation): string {
  return `${w.code}|${w.taskId}|${w.slotId ?? ''}|${w.participantId ?? ''}|${w.message}`;
}

export class SchedulingEngine {
  private participants: Map<string, Participant> = new Map();
  private tasks: Map<string, Task> = new Map();
  private currentSchedule: Schedule | null = null;
  private config: SchedulerConfig;
  private weekEnd: Date = new Date();
  private disabledHC?: Set<string>;
  private phantomContext: PhantomContext | null = null;
  private restRuleMap?: Map<string, number>;
  private dayStartHour: number;
  /** Per-run shift-splitting mode (frozen onto the schedule). */
  private splittingMode: AlgorithmSettings['splittingMode'];
  private _periodStart?: Date;
  private _periodDays?: number;
  private _certLabelSnapshot: Record<string, string> = {};
  certLabelResolver: (certId: string) => string = (id) => this._certLabelSnapshot[id] ?? id;
  /**
   * Last raw `OptimizationResult` committed by the optimizer. Used as the
   * seed for `continueOptimizationAsync`. Cleared by `reset()` and by
   * `invalidateContinuation()` (called from non-optimizer schedule mutations
   * — rescue, Future-SOS, inject, manual swap — that would invalidate the
   * seed's `assignments` snapshot).
   */
  private _lastOptimizationResult: OptimizationResult | null = null;

  constructor(
    config: Partial<SchedulerConfig> = {},
    disabledHC?: Set<string>,
    restRuleMap?: Map<string, number>,
    dayStartHour: number = 5,
    splittingMode: AlgorithmSettings['splittingMode'] = 'off',
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.disabledHC = disabledHC;
    this.restRuleMap = restRuleMap;
    this.dayStartHour = dayStartHour;
    this.splittingMode = splittingMode;
    // Reset assignment counter so IDs start fresh for each new engine instance.
    resetAssignmentCounter();
  }

  /** Operational day boundary hour currently used by this engine instance. */
  getDayStartHour(): number {
    return this.dayStartHour;
  }

  /** Frozen set of disabled hard-constraint codes captured at engine construction. */
  getDisabledHC(): Set<string> | undefined {
    return this.disabledHC;
  }

  /** Frozen per-run shift-splitting mode captured at engine construction. */
  getSplittingMode(): AlgorithmSettings['splittingMode'] {
    return this.splittingMode;
  }

  /** Frozen rest-rule map (ruleId → minimum gap hours) captured at engine construction. */
  getRestRuleMap(): Map<string, number> | undefined {
    return this.restRuleMap;
  }

  /** Frozen scheduler config (user-stored values) captured at engine construction. */
  getConfig(): SchedulerConfig {
    return this.config;
  }

  /**
   * The config the engine actually uses for scoring. In `feasibility` mode
   * `splitPenalty` is substituted with 0; otherwise this returns the raw
   * config. Engine-internal scoring paths and external callers that score
   * a schedule produced by this engine (rescue, future-sos, inject) should
   * use this rather than `getConfig()`.
   */
  getEffectiveConfig(): SchedulerConfig {
    return getEffectiveConfig(this.config, this.splittingMode);
  }

  /** Frozen cert-id → label resolver backed by the construction-time snapshot. */
  getCertLabelResolver(): (certId: string) => string {
    return this.certLabelResolver;
  }

  /**
   * Install the frozen cert-id → label snapshot. Called once at engine
   * construction (from live config) or on reload (from the schedule's
   * embedded `certLabelSnapshot`). The resolver reads from this map on
   * every call, so it never consults the live store post-generation.
   */
  setCertLabelSnapshot(snapshot: Record<string, string>): void {
    this._certLabelSnapshot = { ...snapshot };
  }

  /** Current cert-label snapshot — used by the finalizer to embed it into the Schedule. */
  getCertLabelSnapshot(): Record<string, string> {
    return this._certLabelSnapshot;
  }

  /**
   * Update the operational day boundary hour. Derived state (capacities,
   * score context) is rebuilt on demand, so no further bookkeeping is
   * needed beyond updating the cached value — callers should follow this
   * with `revalidateFull()` to refresh the schedule's score/warnings.
   */
  setDayStartHour(hour: number): void {
    this.dayStartHour = hour;
  }

  /**
   * Record the schedule period (absolute start of operational day 1 and
   * number of days) so the finalized Schedule embeds a frozen period.
   * Callers must invoke this before `solve()` / async equivalents.
   * When unset (e.g. legacy tests), the period is derived from task time
   * blocks at finalization time.
   */
  setPeriod(periodStart: Date, periodDays: number): void {
    this._periodStart = new Date(periodStart.getTime());
    this._periodDays = periodDays;
  }

  /**
   * Resolve the frozen period fields to embed in the Schedule. Falls back
   * to task-time-block derivation when `setPeriod` was not called — this
   * keeps the back-compat path alive for test fixtures and CLI demos.
   */
  private _resolvePeriod(tasks: Task[]): { periodStart: Date; periodDays: number } {
    if (this._periodStart && this._periodDays !== undefined) {
      return { periodStart: new Date(this._periodStart.getTime()), periodDays: this._periodDays };
    }
    if (tasks.length === 0) {
      return { periodStart: new Date(), periodDays: 1 };
    }
    let minStart = tasks[0].timeBlock.start;
    let maxEnd = tasks[0].timeBlock.end;
    for (const t of tasks) {
      if (t.timeBlock.start < minStart) minStart = t.timeBlock.start;
      if (t.timeBlock.end > maxEnd) maxEnd = t.timeBlock.end;
    }
    const periodStart = new Date(
      minStart.getFullYear(),
      minStart.getMonth(),
      minStart.getDate() - (minStart.getHours() < this.dayStartHour ? 1 : 0),
    );
    const spanMs = maxEnd.getTime() - periodStart.getTime();
    const periodDays = Math.max(1, Math.ceil(spanMs / (24 * 3600 * 1000)));
    return { periodStart, periodDays };
  }

  /** Build a ScoreContext with pre-computed capacities for proportional scoring */
  private _buildScoreCtx(tasks: Task[], participants: Participant[]): ScoreContext {
    let schedStart = tasks[0]?.timeBlock.start ?? new Date();
    let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
    for (const t of tasks) {
      if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
      if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
    }
    const notWithPairs = new Map<string, Set<string>>();
    for (const p of participants) {
      if (p.notWithIds && p.notWithIds.length > 0) {
        notWithPairs.set(p.id, new Set(p.notWithIds));
      }
    }
    return {
      taskMap: new Map(tasks.map((t) => [t.id, t])),
      pMap: new Map(participants.map((p) => [p.id, p])),
      capacities: computeAllCapacities(participants, schedStart, schedEnd, this.dayStartHour),
      notWithPairs,
      dayStartHour: this.dayStartHour,
    };
  }

  /** Public ScoreContext for external consumers (e.g., rescue scoring). */
  buildScoreContext(): ScoreContext | undefined {
    if (!this.currentSchedule) return undefined;
    return this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants);
  }

  /**
   * Build a `ScheduleContext` so HC-3 can evaluate weekly `dateUnavailability`
   * rules in operational-day semantics (see `ScheduleContext`). Uses the
   * frozen period when set, otherwise derives it from task time blocks.
   */
  private _scheduleContext(tasks: Task[]): ScheduleContext {
    const { periodStart, periodDays } = this._resolvePeriod(tasks);
    return { baseDate: periodStart, scheduleDays: periodDays, dayStartHour: this.dayStartHour };
  }

  /**
   * Public accessor: build a `ScheduleContext` from the current schedule.
   * Consumers outside the engine (rescue/inject UI paths, swap previews)
   * use this to parameterise HC-3 evaluation consistently.
   */
  getScheduleContext(): ScheduleContext | undefined {
    if (!this.currentSchedule) return undefined;
    return {
      baseDate: new Date(this.currentSchedule.periodStart.getTime()),
      scheduleDays: this.currentSchedule.periodDays,
      dayStartHour: this.dayStartHour,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 1: Data Setup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add or update a participant. The engine deep-clones on entry so its
   * internal Map owns its data — subsequent mutations to the caller's
   * `Participant` object do not propagate. This is what makes the engine
   * safe to keep around past a generation, even if upstream code mutates
   * the live store while a schedule is still displayed.
   */
  addParticipant(participant: Participant): void {
    this.participants.set(participant.id, structuredClone(participant));
  }

  /**
   * Add multiple participants.
   */
  addParticipants(participants: Participant[]): void {
    for (const p of participants) this.addParticipant(p);
  }

  /**
   * Remove a participant by ID.
   */
  removeParticipant(id: string): boolean {
    return this.participants.delete(id);
  }

  /**
   * Get a participant by ID.
   */
  getParticipant(id: string): Participant | undefined {
    return this.participants.get(id);
  }

  /**
   * Get all participants.
   */
  getAllParticipants(): Participant[] {
    return [...this.participants.values()];
  }

  /**
   * Add or update a task.
   */
  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  /**
   * Add multiple tasks.
   */
  addTasks(tasks: Task[]): void {
    for (const t of tasks) this.addTask(t);
  }

  /**
   * Remove a task by ID.
   */
  removeTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  /**
   * Get a task by ID.
   */
  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /**
   * Clear all data (reset to initial state).
   */
  reset(): void {
    this.participants.clear();
    this.tasks.clear();
    this.currentSchedule = null;
    this._lastOptimizationResult = null;
    resetAssignmentCounter();
  }

  /**
   * True iff a prior optimization result is cached and can seed
   * `continueOptimizationAsync`. The web app gates the continuation modal on
   * this so the user is never offered a continuation against a stale seed
   * (e.g. one whose assignments have been mutated by rescue / SOS / inject /
   * manual swap, which all call `invalidateContinuation()`).
   */
  hasOptimizationResultForContinuation(): boolean {
    return this._lastOptimizationResult !== null;
  }

  /**
   * Drop the cached optimization result so continuation is no longer
   * offered. Call from any code path that mutates `currentSchedule` outside
   * of `_commitOptimizationResult` (rescue, Future-SOS, inject, manual swap).
   * Idempotent.
   */
  invalidateContinuation(): void {
    this._lastOptimizationResult = null;
  }

  /**
   * Set (or clear) the phantom context for cross-schedule constraint bridging.
   * When set, the optimizer seeds phantom tasks/assignments into its internal
   * indexes so HC-5, HC-12, and HC-14 are enforced across schedule boundaries.
   */
  setPhantomContext(ctx: PhantomContext | null): void {
    this.phantomContext = ctx;
    // Merge snapshotted rest rule durations from phantom context so HC-14
    // can resolve cross-schedule gaps for rule IDs not in the current set.
    if (ctx && this.restRuleMap) {
      this.restRuleMap = mergePhantomRules(this.restRuleMap, ctx);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 2: Schedule Generation & Optimization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Shared post-optimization logic: validates, collects violations,
   * builds the Schedule object, and commits it to engine state.
   * Eliminates duplication between generateSchedule / generateScheduleAsync.
   */
  private _commitOptimizationResult(
    inputTasks: Task[],
    participants: Participant[],
    result: OptimizationResult,
  ): Schedule {
    // The optimizer may have realized a different task set (feasibility split
    // replacing an occurrence with two halves). Everything below — week-end,
    // validation, soft warnings, period resolution, and the FROZEN
    // `schedule.tasks` — must use the realized list so they all agree.
    // Identical reference to `inputTasks` when nothing was split.
    const tasks = result.tasks ?? inputTasks;
    // Compute week end from latest task
    let maxEnd = 0;
    for (const t of tasks) {
      const endMs = t.timeBlock.end.getTime();
      if (endMs > maxEnd) maxEnd = endMs;
    }
    this.weekEnd = maxEnd > 0 ? new Date(maxEnd) : new Date();

    // Collect all violations
    const hardValidation = validateHardConstraints(
      tasks,
      participants,
      result.assignments,
      this.disabledHC,
      this.restRuleMap,
      this.certLabelResolver,
      undefined,
      this._scheduleContext(tasks),
    );
    const softWarnings = collectSoftWarnings(tasks, participants, result.assignments, this.config);

    // Build key set from optimizer's unfilled-slots list; these will receive the
    // richer INFEASIBLE_SLOT violation below, so suppress the bare SLOT_UNFILLED
    // that HC-6 emits for the same (taskId, slotId) — otherwise each empty slot
    // is reported twice in the violations panel.
    const infeasibleKey = (taskId: string, slotId: string) => `${taskId}|${slotId}`;
    const infeasibleSlotKeys = new Set(result.unfilledSlots.map((uf) => infeasibleKey(uf.taskId, uf.slotId)));
    const dedupedHard = hardValidation.violations.filter((v) => {
      if (v.code === 'SLOT_UNFILLED' && v.taskId && v.slotId) {
        return !infeasibleSlotKeys.has(infeasibleKey(v.taskId, v.slotId));
      }
      return true;
    });

    const allViolations: ConstraintViolation[] = [...dedupedHard, ...softWarnings];

    // Add infeasibility alerts for unfilled slots
    for (const { taskId, slotId, reason } of result.unfilledSlots) {
      const task = this.tasks.get(taskId);
      const where = task ? describeTaskInstance(task) : taskId;
      allViolations.push({
        severity: ViolationSeverity.Error,
        code: 'INFEASIBLE_SLOT',
        message: reason ? `${where} \u200F\u2014 ${reason}` : `${where} \u200F\u2014 אין משתתפים זמינים`,
        taskId,
        slotId,
      });
    }

    const { periodStart, periodDays } = this._resolvePeriod(tasks);
    // Deep-clone participants here so the Schedule is genuinely frozen against
    // subsequent live-store edits (level, group, certs, workloadMultiplier, …).
    // Until this clone existed, the freeze relied on the JSON round-trip
    // through localStorage to detach the schedule's participant graph from
    // store.participants — a fragile, side-effect-driven invariant. Cloning
    // at the generation site makes the freeze synchronous and explicit.
    const schedule: Schedule = {
      id: `schedule-${Date.now()}`,
      tasks,
      participants: participants.map((p) => structuredClone(p)),
      assignments: result.assignments,
      feasible: result.feasible,
      score: result.score,
      violations: allViolations,
      generatedAt: new Date(),
      actualAttempts: result.actualAttempts,
      algorithmSettings: {
        config: { ...this.config },
        disabledHardConstraints: [...((this.disabledHC ?? new Set()) as Set<HardConstraintCode>)],
        dayStartHour: this.dayStartHour,
        splittingMode: this.splittingMode,
      },
      periodStart,
      periodDays,
      restRuleSnapshot: Object.fromEntries(this.restRuleMap ?? new Map()),
      certLabelSnapshot: { ...this._certLabelSnapshot },
      scheduleUnavailability: [],
      capabilityLoss: [],
    };

    this.currentSchedule = schedule;
    this._lastOptimizationResult = result;
    return schedule;
  }

  /**
   * Validate inputs shared by both sync and async generation paths.
   * Throws with a Hebrew error message if tasks or participants are missing.
   */
  private _validateInputs(tasks: Task[], participants: Participant[]): void {
    if (tasks.length === 0) {
      throw new Error('לא נרשמו משימות. יש להוסיף משימות לפני יצירת שבצ"ק.');
    }
    if (participants.length === 0) {
      throw new Error('לא נרשמו משתתפים. יש להוסיף משתתפים לפני יצירת שבצ"ק.');
    }
  }

  /**
   * Generate an optimized schedule from the current participants and tasks.
   * This is the main entry point for schedule creation.
   */
  generateSchedule(): Schedule {
    const tasks = this.getAllTasks();
    const participants = this.getAllParticipants();
    this._validateInputs(tasks, participants);

    const effectiveConfig = this.getEffectiveConfig();
    const qualitySplitEnabled = this.splittingMode === 'quality';
    const result: OptimizationResult = optimize(
      tasks,
      participants,
      effectiveConfig,
      [],
      this.disabledHC,
      0,
      this.phantomContext ?? undefined,
      this.restRuleMap,
      this.dayStartHour,
      this.certLabelResolver,
      undefined,
      undefined,
      undefined,
      this._scheduleContext(tasks),
      undefined,
      qualitySplitEnabled,
    );
    return this._commitOptimizationResult(tasks, participants, result);
  }

  /**
   * Async multi-attempt schedule generation.
   * Runs `attempts` optimization passes with shuffled participant order,
   * yielding to the event loop between each so the UI can show progress.
   * Only the best result is committed to the engine state.
   *
   * @param attempts Number of optimization attempts. REQUIRED — no engine-
   *   level default. The web app's effective default lives in
   *   `src/web/ui-helpers.ts` (`FALLBACK_DEFAULT_ATTEMPTS`, currently 60),
   *   overridable per-user via localStorage `gardenmanager_default_attempts`.
   *   Tests/CLI pass their own explicit values.
   * @param onProgress Callback fired after each attempt for progress UI
   */
  async generateScheduleAsync(
    attempts: number,
    onProgress?: MultiAttemptProgressCallback,
    abortSignal?: AbortSignal,
    stopSignal?: AbortSignal,
  ): Promise<Schedule> {
    const tasks = this.getAllTasks();
    const participants = this.getAllParticipants();
    this._validateInputs(tasks, participants);

    const effectiveConfig = this.getEffectiveConfig();
    const qualitySplitEnabled = this.splittingMode === 'quality';
    const result = await optimizeMultiAttemptAsync(
      tasks,
      participants,
      effectiveConfig,
      [],
      attempts,
      onProgress,
      this.disabledHC,
      this.phantomContext ?? undefined,
      this.restRuleMap,
      this.dayStartHour,
      this.certLabelResolver,
      abortSignal,
      this._scheduleContext(tasks),
      stopSignal,
      undefined,
      qualitySplitEnabled,
    );

    return this._commitOptimizationResult(tasks, participants, result);
  }

  /**
   * Continue searching from a prior committed schedule.
   *
   * Seeds the optimizer with `_lastOptimizationResult` so any attempt must
   * strictly improve on it (per `isBetterResult`) to replace the committed
   * schedule. On no improvement, the optimizer returns the same reference it
   * was seeded with — we detect this with `===` and leave `currentSchedule`
   * untouched. The cumulative attempt count is updated either way.
   *
   * Pre-conditions: `_lastOptimizationResult` is non-null (caller should
   * check via `hasOptimizationResultForContinuation()`).
   *
   * The progress callback receives a cumulative `attempt` / `totalAttempts`
   * — `attempt` is the (originalAttempts + optimizer-local i), `totalAttempts`
   * is (originalAttempts + additionalAttempts). This lets the UI keep showing
   * a single monotone counter across the original run and the continuation.
   */
  async continueOptimizationAsync(
    additionalAttempts: number,
    onProgress?: MultiAttemptProgressCallback,
    abortSignal?: AbortSignal,
    stopSignal?: AbortSignal,
  ): Promise<Schedule> {
    const seed = this._lastOptimizationResult;
    if (!seed) {
      throw new Error('No prior optimization result to continue from. Call generateScheduleAsync first.');
    }
    if (!Number.isFinite(additionalAttempts) || additionalAttempts <= 0) {
      throw new Error('additionalAttempts must be a positive number.');
    }

    const tasks = this.getAllTasks();
    const participants = this.getAllParticipants();
    this._validateInputs(tasks, participants);

    // Continue from the seed's REALIZED task set: if the prior committed
    // schedule split an occurrence, `seed.assignments` reference half-task
    // ids absent from a freshly re-derived whole-task list. Basing the
    // continuation on `seed.tasks` keeps the seed coherent. Identical
    // reference to `tasks` when nothing was split.
    const baseTasks = seed.tasks ?? tasks;

    // Snapshot the cumulative attempt count BEFORE the call. We read this
    // from `currentSchedule`, not from `seed.actualAttempts`, because the
    // optimizer will mutate `seed.actualAttempts` to the call-local count
    // at the end of this call (it has no way to distinguish a seed from a
    // freshly-produced best).
    const originalAttempts = this.currentSchedule?.actualAttempts ?? seed.actualAttempts ?? 0;
    const totalAttemptsForUI = originalAttempts + additionalAttempts;

    // Wrap the progress callback so the UI sees cumulative indices. The
    // optimizer itself only knows about its own call-local i.
    const wrappedProgress: MultiAttemptProgressCallback | undefined = onProgress
      ? (info) =>
          onProgress({
            ...info,
            attempt: originalAttempts + info.attempt,
            totalAttempts: totalAttemptsForUI,
          })
      : undefined;

    const effectiveConfig = this.getEffectiveConfig();
    const qualitySplitEnabled = this.splittingMode === 'quality';
    const result = await optimizeMultiAttemptAsync(
      baseTasks,
      participants,
      effectiveConfig,
      [],
      additionalAttempts,
      wrappedProgress,
      this.disabledHC,
      this.phantomContext ?? undefined,
      this.restRuleMap,
      this.dayStartHour,
      this.certLabelResolver,
      abortSignal,
      this._scheduleContext(baseTasks),
      stopSignal,
      { seedBest: seed, continuation: true },
      qualitySplitEnabled,
    );

    const continuationAttemptsCompleted = result.actualAttempts ?? 0;
    const cumulativeAttempts = originalAttempts + continuationAttemptsCompleted;

    if (result === seed) {
      // No improvement during continuation — leave the committed schedule
      // untouched except for the cumulative attempt count, which the UI uses
      // to report "X attempts run in total."
      if (this.currentSchedule) {
        this.currentSchedule.actualAttempts = cumulativeAttempts;
      }
      return this.currentSchedule!;
    }

    // Strict improvement: stamp the cumulative count on the new result, then
    // commit. _commitOptimizationResult re-builds the Schedule from `result`
    // and updates `_lastOptimizationResult`.
    result.actualAttempts = cumulativeAttempts;
    return this._commitOptimizationResult(baseTasks, participants, result);
  }

  /**
   * Get the current schedule (if generated).
   */
  getSchedule(): Schedule | null {
    return this.currentSchedule;
  }

  /**
   * Import a previously saved schedule so real-time adjustments
   * (swap, revalidate) work without re-generating.
   *
   * The participants and tasks must have been added via addParticipants/addTasks
   * before calling this method.
   */
  importSchedule(schedule: Schedule): void {
    this.currentSchedule = schedule;
    // The imported schedule may have been mutated since generation, or may
    // come from localStorage (no in-memory optimizer result). Either way the
    // continuation seed is unavailable for this schedule.
    this._lastOptimizationResult = null;
  }

  /**
   * Get the scheduling window end date.
   */
  getWeekEnd(): Date {
    return new Date(this.weekEnd.getTime());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Real-time Adjustments
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate the current schedule's hard constraints.
   * Call after every manual change.
   */
  validate(): ValidationResult {
    if (!this.currentSchedule) {
      return {
        valid: false,
        violations: [
          { severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'טרם נוצר שבצ"ק.', taskId: '' },
        ],
      };
    }
    return validateHardConstraints(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.disabledHC,
      this.restRuleMap,
      this.certLabelResolver,
      this.currentSchedule.scheduleUnavailability ?? [],
      this.getScheduleContext(),
      this.currentSchedule.capabilityLoss,
    );
  }

  /**
   * Full revalidation: re-run hard constraints, recompute soft warnings,
   * and recompute the schedule score. Updates the internal schedule state.
   *
   * Use after any manual change (swap) to ensure all
   * violations and KPIs are fresh.
   */
  revalidateFull(): void {
    if (!this.currentSchedule) return;
    const { tasks, participants, assignments } = this.currentSchedule;

    const hard = validateHardConstraints(
      tasks,
      participants,
      assignments,
      this.disabledHC,
      this.restRuleMap,
      this.certLabelResolver,
      this.currentSchedule.scheduleUnavailability ?? [],
      this.getScheduleContext(),
      this.currentSchedule.capabilityLoss,
    );
    const effectiveConfig = this.getEffectiveConfig();
    const soft = collectSoftWarnings(tasks, participants, assignments, effectiveConfig);
    const score = computeScheduleScore(
      tasks,
      participants,
      assignments,
      effectiveConfig,
      this._buildScoreCtx(tasks, participants),
    );

    this.currentSchedule = {
      ...this.currentSchedule,
      violations: [...hard.violations, ...soft],
      feasible: hard.valid,
      score,
    };
  }

  /**
   * Swap a participant in an existing assignment (manual override).
   * Runs validate() after the swap and returns the result.
   */
  swapParticipant(request: SwapRequest): ValidationResult {
    if (!this.currentSchedule) {
      return {
        valid: false,
        violations: [
          { severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' },
        ],
      };
    }

    const assignment = this.currentSchedule.assignments.find((a) => a.id === request.assignmentId);
    if (!assignment) {
      return {
        valid: false,
        violations: [
          {
            severity: ViolationSeverity.Error,
            code: 'ASSIGNMENT_NOT_FOUND',
            message: `שיבוץ ${request.assignmentId} לא נמצא.`,
            taskId: '',
          },
        ],
      };
    }

    const newParticipant = this.participants.get(request.newParticipantId);
    if (!newParticipant) {
      return {
        valid: false,
        violations: [
          {
            severity: ViolationSeverity.Error,
            code: 'PARTICIPANT_NOT_FOUND',
            message: `משתתף ${request.newParticipantId} לא נמצא.`,
            taskId: assignment.taskId,
          },
        ],
      };
    }

    // Frozen assignments cannot be modified
    if (assignment.status === AssignmentStatus.Frozen) {
      return {
        valid: false,
        violations: [
          {
            severity: ViolationSeverity.Error,
            code: 'ASSIGNMENT_FROZEN',
            message: `שיבוץ ${request.assignmentId} קפוא ולא ניתן לשינוי.`,
            taskId: assignment.taskId,
          },
        ],
      };
    }

    // Perform the swap
    const previousId = assignment.participantId;
    const previousStatus = assignment.status;
    const previousUpdatedAt = assignment.updatedAt;

    assignment.participantId = request.newParticipantId;
    assignment.status = AssignmentStatus.Manual;
    assignment.updatedAt = new Date();

    // Re-validate
    const validation = this.validate();

    if (!validation.valid) {
      // Rollback — don't touch schedule metadata since state is restored
      assignment.participantId = previousId;
      assignment.status = previousStatus;
      assignment.updatedAt = previousUpdatedAt;
      return validation;
    }

    // Swap committed — the prior optimization result's assignments snapshot
    // is now stale, so continuation can no longer use it as a seed.
    this._lastOptimizationResult = null;

    // Success: update score and metadata
    const swapEffCfg = this.getEffectiveConfig();
    this.currentSchedule.score = computeScheduleScore(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      swapEffCfg,
      this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants),
    );
    this.currentSchedule.feasible = true;
    this.currentSchedule.violations = [
      ...validation.violations,
      ...collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        swapEffCfg,
      ),
    ];

    return validation;
  }

  /**
   * Atomically apply a chain of swaps (used by rescue plans).
   *
   * Unlike calling swapParticipant() sequentially, this method applies ALL
   * mutations before validating, avoiding false HC-5/HC-7 violations in
   * intermediate states (e.g., when a participant is temporarily in two
   * overlapping slots mid-chain).
   */
  swapParticipantChain(requests: SwapRequest[]): ValidationResult {
    if (!this.currentSchedule) {
      return {
        valid: false,
        violations: [
          { severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' },
        ],
      };
    }

    if (requests.length === 0) {
      return { valid: true, violations: [] };
    }

    // Resolve all assignments and save their previous state upfront
    const targets: Array<{
      assignment: Assignment;
      prevParticipantId: string;
      prevStatus: AssignmentStatus;
      prevUpdatedAt: Date;
      newParticipantId: string;
    }> = [];

    for (const req of requests) {
      const assignment = this.currentSchedule.assignments.find((a) => a.id === req.assignmentId);
      if (!assignment) {
        return {
          valid: false,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'ASSIGNMENT_NOT_FOUND',
              message: `שיבוץ ${req.assignmentId} לא נמצא.`,
              taskId: '',
            },
          ],
        };
      }
      if (assignment.status === AssignmentStatus.Frozen) {
        return {
          valid: false,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'ASSIGNMENT_FROZEN',
              message: `שיבוץ ${req.assignmentId} קפוא ולא ניתן לשינוי.`,
              taskId: assignment.taskId,
            },
          ],
        };
      }
      if (!this.participants.has(req.newParticipantId)) {
        return {
          valid: false,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'PARTICIPANT_NOT_FOUND',
              message: `משתתף ${req.newParticipantId} לא נמצא.`,
              taskId: assignment.taskId,
            },
          ],
        };
      }
      targets.push({
        assignment,
        prevParticipantId: assignment.participantId,
        prevStatus: assignment.status,
        prevUpdatedAt: assignment.updatedAt,
        newParticipantId: req.newParticipantId,
      });
    }

    // Apply all mutations
    const now = new Date();
    for (const t of targets) {
      t.assignment.participantId = t.newParticipantId;
      t.assignment.status = AssignmentStatus.Manual;
      t.assignment.updatedAt = now;
    }

    // Validate once on the final state
    const validation = this.validate();

    if (!validation.valid) {
      // Rollback all mutations
      for (const t of targets) {
        t.assignment.participantId = t.prevParticipantId;
        t.assignment.status = t.prevStatus;
        t.assignment.updatedAt = t.prevUpdatedAt;
      }
      return validation;
    }

    // Chain committed — the prior optimization result's assignments snapshot
    // is now stale, so continuation can no longer use it as a seed.
    this._lastOptimizationResult = null;

    // Success: update score and metadata
    const chainEffCfg = this.getEffectiveConfig();
    this.currentSchedule.score = computeScheduleScore(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      chainEffCfg,
      this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants),
    );
    this.currentSchedule.feasible = true;
    this.currentSchedule.violations = [
      ...validation.violations,
      ...collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        chainEffCfg,
      ),
    ];

    return validation;
  }

  /**
   * Apply a dynamic-replacement plan that may include both `SwapRequest`s
   * (mutating assignment participantIds) and `SplitOp`s (realizing a slot
   * as two `#a`/`#b` half-tasks). All mutations are applied first, then
   * `validateHardConstraints` runs once on the final state. On HC failure,
   * every mutation rolls back atomically — `schedule.tasks` and
   * `schedule.assignments` revert to pre-apply identity.
   *
   * Used by rescue / Future-SOS / inject / capability-change when their
   * planner chose a split-fill candidate. The plain swap-chain path is
   * still available via `swapParticipantChain` for unchanged callers.
   */
  applyPlanOps(plan: { swaps?: SwapRequest[]; splitOps?: SplitOp[] }): ValidationResult {
    if (!this.currentSchedule) {
      return {
        valid: false,
        violations: [
          { severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' },
        ],
      };
    }

    const swapReqs = plan.swaps ?? [];
    const splitOps = plan.splitOps ?? [];

    if (swapReqs.length === 0 && splitOps.length === 0) {
      return { valid: true, violations: [] };
    }

    const sched = this.currentSchedule;

    // Rollback state for split-ops, captured in apply order. Roll back in
    // reverse so a partially-applied batch fully reverts. `originalAssignment`
    // and `originalAssignmentIndex` are null when the op split a still-empty
    // slot (manual-build flow) — rollback skips the assignment reinsert.
    type SplitUndo = {
      originalTask: Task;
      originalTaskIndex: number;
      insertedTaskIds: string[];
      originalAssignment: Assignment | null;
      originalAssignmentIndex: number | null;
      insertedAssignmentIds: string[];
    };
    const splitUndo: SplitUndo[] = [];

    // Rollback state for swaps (same shape as swapParticipantChain).
    type SwapUndo = {
      assignment: Assignment;
      prevParticipantId: string;
      prevStatus: AssignmentStatus;
      prevUpdatedAt: Date;
    };
    const swapUndo: SwapUndo[] = [];

    const rollback = (): void => {
      // Reverse swap mutations.
      for (const u of swapUndo) {
        u.assignment.participantId = u.prevParticipantId;
        u.assignment.status = u.prevStatus;
        u.assignment.updatedAt = u.prevUpdatedAt;
      }
      // Reverse split mutations in reverse order. Use splice() throughout
      // to preserve array-reference identity for any outside holders.
      for (let i = splitUndo.length - 1; i >= 0; i--) {
        const u = splitUndo[i];
        for (const id of u.insertedAssignmentIds) {
          const aIdx = sched.assignments.findIndex((a) => a.id === id);
          if (aIdx !== -1) sched.assignments.splice(aIdx, 1);
        }
        if (u.originalAssignment !== null && u.originalAssignmentIndex !== null) {
          sched.assignments.splice(u.originalAssignmentIndex, 0, u.originalAssignment);
        }
        for (const id of u.insertedTaskIds) {
          const tIdx = sched.tasks.findIndex((t) => t.id === id);
          if (tIdx !== -1) sched.tasks.splice(tIdx, 1);
        }
        sched.tasks.splice(u.originalTaskIndex, 0, u.originalTask);
      }
    };

    const fail = (code: string, message: string, taskId = ''): ValidationResult => {
      rollback();
      return {
        valid: false,
        violations: [{ severity: ViolationSeverity.Error, code, message, taskId }],
      };
    };

    // ── Apply split-ops ────────────────────────────────────────────────────
    for (const op of splitOps) {
      if (op.fillA.participantId === op.fillB.participantId) {
        return fail('SPLIT_SAME_PARTICIPANT', `פיצול ${op.slotLabel}: שני החצאים שובצו לאותו אדם.`, op.taskId);
      }

      const tIdx = sched.tasks.findIndex((t) => t.id === op.taskId);
      if (tIdx === -1) {
        return fail('TASK_NOT_FOUND', `המשימה ${op.taskId} לא נמצאה לפיצול.`, op.taskId);
      }
      const T = sched.tasks[tIdx];
      if (!T.splittable) {
        return fail('TASK_NOT_SPLITTABLE', `המשימה "${T.name}" אינה ניתנת לפיצול.`, T.id);
      }
      if (T.splitGroupId !== undefined) {
        return fail('TASK_ALREADY_SPLIT', `המשימה "${T.name}" כבר מפוצלת — אי-אפשר לפצל חצי.`, T.id);
      }

      const slot = T.slots.find((s) => s.slotId === op.slotId);
      if (!slot) {
        return fail('SLOT_NOT_FOUND', `המשבצת ${op.slotId} לא נמצאה במשימה "${T.name}".`, T.id);
      }

      // Empty-slot split (manual-build): `originalAssignmentId === null`.
      // We still need to verify the targeted slot is actually empty — if it
      // *is* assigned, applying would orphan that assignment.
      let aIdx: number;
      let originalAssignment: Assignment | null;
      if (op.originalAssignmentId === null) {
        const existing = sched.assignments.find((a) => a.taskId === T.id && a.slotId === op.slotId);
        if (existing) {
          return fail('SPLIT_SLOT_NOT_EMPTY', `המשבצת ${op.slotLabel} משובצת כבר — לא ניתן לפצל כמשבצת ריקה.`, T.id);
        }
        aIdx = -1;
        originalAssignment = null;
      } else {
        aIdx = sched.assignments.findIndex((a) => a.id === op.originalAssignmentId);
        if (aIdx === -1) {
          return fail('ASSIGNMENT_NOT_FOUND', `שיבוץ ${op.originalAssignmentId} לא נמצא.`, T.id);
        }
        originalAssignment = sched.assignments[aIdx];
        if (originalAssignment.status === AssignmentStatus.Frozen) {
          return fail('ASSIGNMENT_FROZEN', `שיבוץ ${op.originalAssignmentId} קפוא ולא ניתן לפיצול.`, T.id);
        }
      }

      if (!this.participants.has(op.fillA.participantId)) {
        return fail('PARTICIPANT_NOT_FOUND', `משתתף ${op.fillA.participantId} לא נמצא.`, T.id);
      }
      if (!this.participants.has(op.fillB.participantId)) {
        return fail('PARTICIPANT_NOT_FOUND', `משתתף ${op.fillB.participantId} לא נמצא.`, T.id);
      }

      const startMs = T.timeBlock.start.getTime();
      const endMs = T.timeBlock.end.getTime();
      const midMs = op.midpointMs;
      if (!(midMs > startMs && midMs < endMs)) {
        return fail('SPLIT_MIDPOINT_INVALID', `נקודת הפיצול של "${T.name}" אינה חוקית.`, T.id);
      }

      const halfA = makeSplitHalf(T, 1, startMs, midMs, slot);
      const halfB = makeSplitHalf(T, 2, midMs, endMs, slot);

      // Determine surviving slots (the slots NOT being split). When the
      // parent is `sameGroupRequired`, stamp `sameGroupLinkId = T.id` on the
      // residual so HC-8's link-union sees residual + halves as one unit —
      // mirrors `splitSameGroup`'s residual at optimizer.ts:1373. Without
      // this, `makeSplitHalf` stamps the halves but the residual stays
      // unlinked, letting cross-group HC-8 violations on the residual pass.
      const survivingSlots = T.slots.filter((s) => s.slotId !== op.slotId);
      const replacementTasks: Task[] = [];
      if (survivingSlots.length > 0) {
        const Tr: Task = {
          ...T,
          slots: survivingSlots,
          requiredCount: survivingSlots.length,
          sameGroupLinkId: T.sameGroupRequired ? (T.sameGroupLinkId ?? T.id) : T.sameGroupLinkId,
        };
        replacementTasks.push(Tr);
      }
      replacementTasks.push(halfA, halfB);

      // Synthetic assignment-id base. For the dynamic-replacement flows we
      // append `#a`/`#b` to the original assignment id (preserves traceability);
      // for manual empty-slot splits there is no original, so derive a base
      // from the task+slot plus a wall-clock+random suffix (matches the
      // `manual-${Date.now()}-${rand}` pattern used by `executeManualAssignment`).
      const asgBase =
        op.originalAssignmentId ?? `split-${T.id}-${op.slotId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const now = new Date();
      const newAsgA: Assignment = {
        id: `${asgBase}#a`,
        taskId: halfA.id,
        slotId: halfA.slots[0].slotId,
        participantId: op.fillA.participantId,
        status: AssignmentStatus.Manual,
        updatedAt: now,
      };
      const newAsgB: Assignment = {
        id: `${asgBase}#b`,
        taskId: halfB.id,
        slotId: halfB.slots[0].slotId,
        participantId: op.fillB.participantId,
        status: AssignmentStatus.Manual,
        updatedAt: now,
      };

      // Guard: synthetic ids must not collide with existing ones.
      if (sched.assignments.some((a) => a.id === newAsgA.id || a.id === newAsgB.id)) {
        return fail(
          'SPLIT_ASSIGNMENT_ID_COLLISION',
          `שיבוצי הפיצול של ${asgBase} כבר קיימים — בטל את הפיצול הקודם תחילה.`,
          T.id,
        );
      }

      // Splice schedule.tasks: replace T with replacementTasks.
      sched.tasks.splice(tIdx, 1, ...replacementTasks);
      // Splice schedule.assignments: remove originalAssignment (when present), push half assignments.
      if (aIdx !== -1) {
        sched.assignments.splice(aIdx, 1);
      }
      sched.assignments.push(newAsgA, newAsgB);

      splitUndo.push({
        originalTask: T,
        originalTaskIndex: tIdx,
        insertedTaskIds: replacementTasks.map((t) => t.id),
        originalAssignment,
        originalAssignmentIndex: originalAssignment !== null ? aIdx : null,
        insertedAssignmentIds: [newAsgA.id, newAsgB.id],
      });
    }

    // ── Apply swaps (mirrors swapParticipantChain) ─────────────────────────
    for (const req of swapReqs) {
      const assignment = sched.assignments.find((a) => a.id === req.assignmentId);
      if (!assignment) {
        return fail('ASSIGNMENT_NOT_FOUND', `שיבוץ ${req.assignmentId} לא נמצא.`);
      }
      if (assignment.status === AssignmentStatus.Frozen) {
        return fail('ASSIGNMENT_FROZEN', `שיבוץ ${req.assignmentId} קפוא ולא ניתן לשינוי.`, assignment.taskId);
      }
      if (!this.participants.has(req.newParticipantId)) {
        return fail('PARTICIPANT_NOT_FOUND', `משתתף ${req.newParticipantId} לא נמצא.`, assignment.taskId);
      }
      swapUndo.push({
        assignment,
        prevParticipantId: assignment.participantId,
        prevStatus: assignment.status,
        prevUpdatedAt: assignment.updatedAt,
      });
    }

    const nowSwaps = new Date();
    for (let i = 0; i < swapReqs.length; i++) {
      const u = swapUndo[i];
      u.assignment.participantId = swapReqs[i].newParticipantId;
      u.assignment.status = AssignmentStatus.Manual;
      u.assignment.updatedAt = nowSwaps;
    }

    // ── Validate the final state ───────────────────────────────────────────
    const validation = this.validate();
    if (!validation.valid) {
      rollback();
      return validation;
    }

    // ── Commit ──────────────────────────────────────────────────────────────
    this._lastOptimizationResult = null;

    const effCfg = this.getEffectiveConfig();
    sched.score = computeScheduleScore(
      sched.tasks,
      sched.participants,
      sched.assignments,
      effCfg,
      this._buildScoreCtx(sched.tasks, sched.participants),
    );
    sched.feasible = true;
    sched.violations = [
      ...validation.violations,
      ...collectSoftWarnings(sched.tasks, sched.participants, sched.assignments, effCfg),
    ];

    return validation;
  }

  /**
   * Preview a single swap without committing it. Mutates briefly to run
   * validation + soft warning collection + score computation, then always
   * rolls back — regardless of whether the swap would be valid.
   *
   * The returned `simulatedAssignments` is a deep-cloned snapshot of the
   * post-swap state, letting the UI compute workload deltas without
   * re-mutating the engine.
   */
  previewSwap(request: SwapRequest): SwapPreview {
    return this.previewSwapChain([request]);
  }

  /**
   * Preview an atomic chain swap (two-way trade or multi-step chain)
   * without committing. Mirrors `swapParticipantChain` but always rolls
   * back and returns a `SwapPreview` with score/warning deltas and a
   * snapshot of the simulated post-swap state.
   */
  previewSwapChain(requests: SwapRequest[]): SwapPreview {
    const emptyPreview: SwapPreview = {
      valid: false,
      violations: [],
      addedSoftWarnings: [],
      removedSoftWarnings: [],
      scoreDelta: 0,
      affectedParticipantIds: [],
      simulatedAssignments: [],
    };

    if (!this.currentSchedule) {
      return {
        ...emptyPreview,
        violations: [
          { severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' },
        ],
      };
    }
    if (requests.length === 0) {
      return {
        ...emptyPreview,
        valid: true,
        simulatedAssignments: this.currentSchedule.assignments.map((a) => ({ ...a })),
      };
    }

    // Resolve targets + save previous state (mirrors swapParticipantChain)
    const targets: Array<{
      assignment: Assignment;
      prevParticipantId: string;
      prevStatus: AssignmentStatus;
      prevUpdatedAt: Date;
      newParticipantId: string;
    }> = [];
    const affected = new Set<string>();

    for (const req of requests) {
      const assignment = this.currentSchedule.assignments.find((a) => a.id === req.assignmentId);
      if (!assignment) {
        return {
          ...emptyPreview,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'ASSIGNMENT_NOT_FOUND',
              message: `שיבוץ ${req.assignmentId} לא נמצא.`,
              taskId: '',
            },
          ],
        };
      }
      if (assignment.status === AssignmentStatus.Frozen) {
        return {
          ...emptyPreview,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'ASSIGNMENT_FROZEN',
              message: `שיבוץ ${req.assignmentId} קפוא ולא ניתן לשינוי.`,
              taskId: assignment.taskId,
            },
          ],
        };
      }
      if (!this.participants.has(req.newParticipantId)) {
        return {
          ...emptyPreview,
          violations: [
            {
              severity: ViolationSeverity.Error,
              code: 'PARTICIPANT_NOT_FOUND',
              message: `משתתף ${req.newParticipantId} לא נמצא.`,
              taskId: assignment.taskId,
            },
          ],
        };
      }
      affected.add(assignment.participantId);
      affected.add(req.newParticipantId);
      targets.push({
        assignment,
        prevParticipantId: assignment.participantId,
        prevStatus: assignment.status,
        prevUpdatedAt: assignment.updatedAt,
        newParticipantId: req.newParticipantId,
      });
    }

    // Capture baseline soft warnings BEFORE mutating
    const previewEffCfg = this.getEffectiveConfig();
    const baselineSoft = collectSoftWarnings(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      previewEffCfg,
    );
    const baselineComposite = this.currentSchedule.score?.compositeScore ?? 0;

    // Apply all mutations
    const now = new Date();
    for (const t of targets) {
      t.assignment.participantId = t.newParticipantId;
      t.assignment.status = AssignmentStatus.Manual;
      t.assignment.updatedAt = now;
    }

    let preview: SwapPreview;
    try {
      const validation = this.validate();
      const postSoft = collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        previewEffCfg,
      );
      const postScore = computeScheduleScore(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        previewEffCfg,
        this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants),
      );

      const baselineKeys = new Set(baselineSoft.map(softWarningKey));
      const postKeys = new Set(postSoft.map(softWarningKey));
      const addedSoftWarnings = postSoft.filter((w) => !baselineKeys.has(softWarningKey(w)));
      const removedSoftWarnings = baselineSoft.filter((w) => !postKeys.has(softWarningKey(w)));

      // Deep-clone assignments as the simulated snapshot
      const simulatedAssignments: Assignment[] = this.currentSchedule.assignments.map((a) => ({
        ...a,
        updatedAt: new Date(a.updatedAt.getTime()),
      }));

      preview = {
        valid: validation.valid,
        violations: validation.violations,
        addedSoftWarnings,
        removedSoftWarnings,
        scoreDelta: postScore.compositeScore - baselineComposite,
        affectedParticipantIds: [...affected],
        simulatedAssignments,
      };
    } finally {
      // ALWAYS roll back — even on valid previews. Commit is a separate
      // step via `swapParticipant` / `swapParticipantChain`.
      for (const t of targets) {
        t.assignment.participantId = t.prevParticipantId;
        t.assignment.status = t.prevStatus;
        t.assignment.updatedAt = t.prevUpdatedAt;
      }
    }

    return preview;
  }

  /**
   * Get schedule statistics summary.
   */
  getStats(): {
    totalTasks: number;
    totalParticipants: number;
    totalAssignments: number;
    feasible: boolean;
    hardViolations: number;
    softWarnings: number;
    score: Schedule['score'] | null;
  } {
    const s = this.currentSchedule;
    return {
      totalTasks: this.tasks.size,
      totalParticipants: this.participants.size,
      totalAssignments: s?.assignments.length ?? 0,
      feasible: s?.feasible ?? false,
      hardViolations: s?.violations.filter((v) => v.severity === ViolationSeverity.Error).length ?? 0,
      softWarnings: s?.violations.filter((v) => v.severity === ViolationSeverity.Warning).length ?? 0,
      score: s?.score ?? null,
    };
  }
}
