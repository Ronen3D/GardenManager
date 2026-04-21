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
  type Assignment,
  AssignmentStatus,
  type ConstraintViolation,
  DEFAULT_CONFIG,
  type HardConstraintCode,
  type Participant,
  type ReScheduleRequest,
  type Schedule,
  type SchedulerConfig,
  type SleepRecoveryRule,
  type SwapRequest,
  type Task,
  type ValidationResult,
  ViolationSeverity,
} from '../models/types';
import { computeAllCapacities } from '../utils/capacity';
import { describeSlotBidi } from '../utils/date-utils';
import {
  type MultiAttemptProgressCallback,
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

/** Freeze HC-15 rules onto the schedule snapshot, keyed by task id. */
function buildSleepRecoverySnapshot(tasks: Task[]): Record<string, SleepRecoveryRule> {
  const snap: Record<string, SleepRecoveryRule> = {};
  for (const t of tasks) {
    if (t.sleepRecovery) snap[t.id] = { ...t.sleepRecovery };
  }
  return snap;
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
  private _periodStart?: Date;
  private _periodDays?: number;
  private _certLabelSnapshot: Record<string, string> = {};
  certLabelResolver: (certId: string) => string = (id) => this._certLabelSnapshot[id] ?? id;

  constructor(
    config: Partial<SchedulerConfig> = {},
    disabledHC?: Set<string>,
    restRuleMap?: Map<string, number>,
    dayStartHour: number = 5,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.disabledHC = disabledHC;
    this.restRuleMap = restRuleMap;
    this.dayStartHour = dayStartHour;
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

  /** Frozen rest-rule map (ruleId → minimum gap hours) captured at engine construction. */
  getRestRuleMap(): Map<string, number> | undefined {
    return this.restRuleMap;
  }

  /** Frozen scheduler config captured at engine construction. */
  getConfig(): SchedulerConfig {
    return this.config;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 1: Data Setup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add or update a participant.
   */
  addParticipant(participant: Participant): void {
    this.participants.set(participant.id, participant);
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
    resetAssignmentCounter();
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
  private _commitOptimizationResult(tasks: Task[], participants: Participant[], result: OptimizationResult): Schedule {
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
    );
    const softWarnings = collectSoftWarnings(tasks, participants, result.assignments, this.config);

    const allViolations: ConstraintViolation[] = [...hardValidation.violations, ...softWarnings];

    // Add infeasibility alerts for unfilled slots
    for (const { taskId, slotId, reason } of result.unfilledSlots) {
      const task = this.tasks.get(taskId);
      const slot = task?.slots.find((s) => s.slotId === slotId);
      const slotDesc = task ? describeSlotBidi(slot?.label, task.timeBlock) : slotId;
      allViolations.push({
        severity: ViolationSeverity.Error,
        code: 'INFEASIBLE_SLOT',
        message: reason
          ? `${task?.name ?? taskId}, ${slotDesc} \u200F\u2014 ${reason}`
          : `${task?.name ?? taskId}, ${slotDesc} \u200F\u2014 אין משתתפים זמינים`,
        taskId,
        slotId,
      });
    }

    const { periodStart, periodDays } = this._resolvePeriod(tasks);
    const schedule: Schedule = {
      id: `schedule-${Date.now()}`,
      tasks,
      participants,
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
      },
      periodStart,
      periodDays,
      restRuleSnapshot: Object.fromEntries(this.restRuleMap ?? new Map()),
      sleepRecoverySnapshot: buildSleepRecoverySnapshot(tasks),
      certLabelSnapshot: { ...this._certLabelSnapshot },
      scheduleUnavailability: [],
    };

    this.currentSchedule = schedule;
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

    const result: OptimizationResult = optimize(
      tasks,
      participants,
      this.config,
      [],
      this.disabledHC,
      0,
      this.phantomContext ?? undefined,
      this.restRuleMap,
      this.dayStartHour,
    );
    return this._commitOptimizationResult(tasks, participants, result);
  }

  /**
   * Async multi-attempt schedule generation.
   * Runs `attempts` optimization passes with shuffled participant order,
   * yielding to the event loop between each so the UI can show progress.
   * Only the best result is committed to the engine state.
   *
   * @param attempts Number of optimization attempts (default: 2000)
   * @param onProgress Callback fired after each attempt for progress UI
   */
  async generateScheduleAsync(
    attempts: number = 2000,
    onProgress?: MultiAttemptProgressCallback,
    abortSignal?: AbortSignal,
  ): Promise<Schedule> {
    const tasks = this.getAllTasks();
    const participants = this.getAllParticipants();
    this._validateInputs(tasks, participants);

    const result = await optimizeMultiAttemptAsync(
      tasks,
      participants,
      this.config,
      [],
      attempts,
      onProgress,
      this.disabledHC,
      this.phantomContext ?? undefined,
      this.restRuleMap,
      this.dayStartHour,
      this.certLabelResolver,
      abortSignal,
    );

    return this._commitOptimizationResult(tasks, participants, result);
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
    );
    const soft = collectSoftWarnings(tasks, participants, assignments, this.config);
    const score = computeScheduleScore(
      tasks,
      participants,
      assignments,
      this.config,
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

    // Success: update score and metadata
    this.currentSchedule.score = computeScheduleScore(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.config,
      this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants),
    );
    this.currentSchedule.feasible = true;
    this.currentSchedule.violations = [
      ...validation.violations,
      ...collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        this.config,
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

    // Success: update score and metadata
    this.currentSchedule.score = computeScheduleScore(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.config,
      this._buildScoreCtx(this.currentSchedule.tasks, this.currentSchedule.participants),
    );
    this.currentSchedule.feasible = true;
    this.currentSchedule.violations = [
      ...validation.violations,
      ...collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        this.config,
      ),
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
    const baselineSoft = collectSoftWarnings(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.config,
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
        this.config,
      );
      const postScore = computeScheduleScore(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        this.config,
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
   * Partial re-schedule: pin existing assignments and re-optimize only affected slots.
   * Used when a participant becomes unavailable mid-day.
   */
  partialReSchedule(request: ReScheduleRequest): Schedule {
    if (!this.currentSchedule) {
      throw new Error('אין שבצ"ק לתזמון מחדש חלקי.');
    }

    const { pinnedAssignmentIds, unavailableParticipantIds } = request;
    const unavailableSet = new Set(unavailableParticipantIds);

    // Separate pinned assignments from those that need re-assignment
    const pinnedAssignments: Assignment[] = [];
    const needsReassignment: Assignment[] = [];

    for (const a of this.currentSchedule.assignments) {
      if (pinnedAssignmentIds.includes(a.id)) {
        // Keep pinned unless the participant is unavailable
        if (unavailableSet.has(a.participantId)) {
          needsReassignment.push(a);
        } else {
          pinnedAssignments.push({ ...a });
        }
      } else if (unavailableSet.has(a.participantId)) {
        needsReassignment.push(a);
      } else {
        pinnedAssignments.push({ ...a });
      }
    }

    // Filter out unavailable participants
    const availableParticipants = this.getAllParticipants().filter((p) => !unavailableSet.has(p.id));

    // Re-optimize with pinned assignments
    const result = optimize(
      this.currentSchedule.tasks,
      availableParticipants,
      this.config,
      pinnedAssignments,
      this.disabledHC,
      0,
      undefined,
      this.restRuleMap,
      this.dayStartHour,
    );

    // Validate
    const hardValidation = validateHardConstraints(
      this.currentSchedule.tasks,
      this.getAllParticipants(),
      result.assignments,
      this.disabledHC,
      this.restRuleMap,
      this.certLabelResolver,
    );
    const softWarnings = collectSoftWarnings(
      this.currentSchedule.tasks,
      this.getAllParticipants(),
      result.assignments,
      this.config,
    );

    const prev = this.currentSchedule;
    const fallback = this._resolvePeriod(prev.tasks);
    const periodStart = prev.periodStart
      ? new Date(prev.periodStart.getTime())
      : fallback.periodStart;
    const periodDays = prev.periodDays ?? fallback.periodDays;
    const schedule: Schedule = {
      id: `schedule-${Date.now()}`,
      tasks: this.currentSchedule.tasks,
      participants: this.getAllParticipants(),
      assignments: result.assignments,
      feasible: result.feasible,
      score: result.score,
      violations: [...hardValidation.violations, ...softWarnings],
      generatedAt: new Date(),
      algorithmSettings: {
        config: { ...this.config },
        disabledHardConstraints: [...((this.disabledHC ?? new Set()) as Set<HardConstraintCode>)],
        dayStartHour: this.dayStartHour,
      },
      periodStart,
      periodDays,
      restRuleSnapshot: Object.fromEntries(this.restRuleMap ?? new Map()),
      sleepRecoverySnapshot: buildSleepRecoverySnapshot(this.currentSchedule.tasks),
      certLabelSnapshot: { ...this._certLabelSnapshot },
      scheduleUnavailability: this.currentSchedule.scheduleUnavailability ?? [],
    };

    this.currentSchedule = schedule;
    return schedule;
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
