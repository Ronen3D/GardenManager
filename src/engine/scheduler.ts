/**
 * Scheduling Engine - Main orchestrator class.
 *
 * Two-stage workflow:
 *  Stage 1: Data Setup — register participants and tasks.
 *  Stage 2: Optimal Generation — generate schedule, with manual overrides.
 */

import {
  Participant,
  Task,
  Assignment,
  Schedule,
  SchedulerConfig,
  DEFAULT_CONFIG,
  ValidationResult,
  ConstraintViolation,
  SwapRequest,
  ReScheduleRequest,
  AssignmentStatus,
  ViolationSeverity,
} from '../models/types';
import { validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore, collectSoftWarnings, ScoreContext } from '../constraints/soft-constraints';
import { computeAllCapacities } from '../utils/capacity';
import {
  optimize,
  optimizeMultiAttemptAsync,
  OptimizationResult,
  resetAssignmentCounter,
  MultiAttemptProgressCallback,
} from './optimizer';
import { resetSlotCounter, resetTaskCounter } from '../tasks/task-definitions';
import { PhantomContext } from './phantom';

export class SchedulingEngine {
  private participants: Map<string, Participant> = new Map();
  private tasks: Map<string, Task> = new Map();
  private currentSchedule: Schedule | null = null;
  private config: SchedulerConfig;
  private weekEnd: Date = new Date();
  private disabledHC?: Set<string>;
  private phantomContext: PhantomContext | null = null;

  constructor(config: Partial<SchedulerConfig> = {}, disabledHC?: Set<string>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.disabledHC = disabledHC;
    // Bug #12 fix: reset module-level counters so IDs start fresh
    // for each new engine instance.
    resetAssignmentCounter();
    resetSlotCounter();
    resetTaskCounter();
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
      taskMap: new Map(tasks.map(t => [t.id, t])),
      pMap: new Map(participants.map(p => [p.id, p])),
      capacities: computeAllCapacities(participants, schedStart, schedEnd),
      notWithPairs,
    };
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
    resetSlotCounter();
    resetTaskCounter();
  }

  /**
   * Set (or clear) the phantom context for cross-schedule constraint bridging.
   * When set, the optimizer seeds phantom tasks/assignments into its internal
   * indexes so HC-5, HC-12, and HC-14 are enforced across schedule boundaries.
   */
  setPhantomContext(ctx: PhantomContext | null): void {
    this.phantomContext = ctx;
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
    tasks: Task[],
    participants: Participant[],
    result: OptimizationResult,
  ): Schedule {
    // Compute week end from latest task
    let maxEnd = 0;
    for (const t of tasks) {
      const endMs = t.timeBlock.end.getTime();
      if (endMs > maxEnd) maxEnd = endMs;
    }
    this.weekEnd = maxEnd > 0 ? new Date(maxEnd) : new Date();

    // Collect all violations
    const hardValidation = validateHardConstraints(tasks, participants, result.assignments, this.disabledHC);
    const softWarnings = collectSoftWarnings(tasks, participants, result.assignments, this.config);

    const allViolations: ConstraintViolation[] = [
      ...hardValidation.violations,
      ...softWarnings,
    ];

    // Add infeasibility alerts for unfilled slots
    for (const { taskId, slotId, reason } of result.unfilledSlots) {
      const task = this.tasks.get(taskId);
      const slot = task?.slots.find((s) => s.slotId === slotId);
      allViolations.push({
        severity: ViolationSeverity.Error,
        code: 'INFEASIBLE_SLOT',
        message: reason
          ? `לא ניתן לשבץ: ${reason} (עמדה "${slot?.label ?? slotId}" במשימה "${task?.name ?? taskId}")`
          : `שבצ"ק בלתי אפשרי: לא ניתן למלא עמדה "${slot?.label ?? slotId}" במשימה "${task?.name ?? taskId}". אין משתתפים זמינים.`,
        taskId,
        slotId,
      });
    }

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
      throw new Error('לא נרשמו משימות. יש להוסיף משימות לפני יצירת שבצ\"ק.');
    }
    if (participants.length === 0) {
      throw new Error('לא נרשמו משתתפים. יש להוסיף משתתפים לפני יצירת שבצ\"ק.');
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

    const result: OptimizationResult = optimize(tasks, participants, this.config, [], this.disabledHC, 0, this.phantomContext ?? undefined);
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
   * (swap, lock, revalidate) work without re-generating.
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
      return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'טרם נוצר שבצ"ק.', taskId: '' }] };
    }
    return validateHardConstraints(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.disabledHC,
    );
  }

  /**
   * Full revalidation: re-run hard constraints, recompute soft warnings,
   * and recompute the schedule score. Updates the internal schedule state.
   *
   * Use after any manual change (swap, lock/unlock) to ensure all
   * violations and KPIs are fresh.
   */
  revalidateFull(): void {
    if (!this.currentSchedule) return;
    const { tasks, participants, assignments } = this.currentSchedule;

    const hard = validateHardConstraints(tasks, participants, assignments, this.disabledHC);
    const soft = collectSoftWarnings(tasks, participants, assignments, this.config);
    const score = computeScheduleScore(tasks, participants, assignments, this.config, this._buildScoreCtx(tasks, participants));

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
      return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' }] };
    }

    const assignment = this.currentSchedule.assignments.find(
      (a) => a.id === request.assignmentId,
    );
    if (!assignment) {
      return {
        valid: false,
        violations: [{
          severity: ViolationSeverity.Error,
          code: 'ASSIGNMENT_NOT_FOUND',
          message: `שיבוץ ${request.assignmentId} לא נמצא.`,
          taskId: '',
        }],
      };
    }

    const newParticipant = this.participants.get(request.newParticipantId);
    if (!newParticipant) {
      return {
        valid: false,
        violations: [{
          severity: ViolationSeverity.Error,
          code: 'PARTICIPANT_NOT_FOUND',
          message: `משתתף ${request.newParticipantId} לא נמצא.`,
          taskId: assignment.taskId,
        }],
      };
    }

    // Frozen assignments cannot be modified
    if (assignment.status === AssignmentStatus.Frozen) {
      return {
        valid: false,
        violations: [{
          severity: ViolationSeverity.Error,
          code: 'ASSIGNMENT_FROZEN',
          message: `שיבוץ ${request.assignmentId} קפוא ולא ניתן לשינוי.`,
          taskId: assignment.taskId,
        }],
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
      return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'אין שבצ"ק לעריכה.', taskId: '' }] };
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
      const assignment = this.currentSchedule.assignments.find(a => a.id === req.assignmentId);
      if (!assignment) {
        return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'ASSIGNMENT_NOT_FOUND', message: `שיבוץ ${req.assignmentId} לא נמצא.`, taskId: '' }] };
      }
      if (assignment.status === AssignmentStatus.Frozen) {
        return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'ASSIGNMENT_FROZEN', message: `שיבוץ ${req.assignmentId} קפוא ולא ניתן לשינוי.`, taskId: assignment.taskId }] };
      }
      if (!this.participants.has(req.newParticipantId)) {
        return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'PARTICIPANT_NOT_FOUND', message: `משתתף ${req.newParticipantId} לא נמצא.`, taskId: assignment.taskId }] };
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
   * Partial re-schedule: lock existing assignments and re-optimize only affected slots.
   * Used when a participant becomes unavailable mid-day.
   */
  partialReSchedule(request: ReScheduleRequest): Schedule {
    if (!this.currentSchedule) {
      throw new Error('אין שבצ\"ק לתזמון מחדש חלקי.');
    }

    const { lockedAssignmentIds, unavailableParticipantIds } = request;
    const unavailableSet = new Set(unavailableParticipantIds);

    // Separate locked assignments from those that need re-assignment
    const lockedAssignments: Assignment[] = [];
    const needsReassignment: Assignment[] = [];

    for (const a of this.currentSchedule.assignments) {
      if (lockedAssignmentIds.includes(a.id)) {
        // Keep locked unless the participant is unavailable
        if (unavailableSet.has(a.participantId)) {
          needsReassignment.push(a);
        } else {
          lockedAssignments.push({ ...a, status: AssignmentStatus.Locked });
        }
      } else if (unavailableSet.has(a.participantId)) {
        needsReassignment.push(a);
      } else {
        lockedAssignments.push({ ...a, status: AssignmentStatus.Locked });
      }
    }

    // Filter out unavailable participants
    const availableParticipants = this.getAllParticipants().filter(
      (p) => !unavailableSet.has(p.id),
    );

    // Re-optimize with locked assignments
    const result = optimize(
      this.currentSchedule.tasks,
      availableParticipants,
      this.config,
      lockedAssignments,
      this.disabledHC,
    );

    // Validate
    const hardValidation = validateHardConstraints(
      this.currentSchedule.tasks,
      this.getAllParticipants(),
      result.assignments,
      this.disabledHC,
    );
    const softWarnings = collectSoftWarnings(
      this.currentSchedule.tasks,
      this.getAllParticipants(),
      result.assignments,
      this.config,
    );

    const schedule: Schedule = {
      id: `schedule-${Date.now()}`,
      tasks: this.currentSchedule.tasks,
      participants: this.getAllParticipants(),
      assignments: result.assignments,
      feasible: result.feasible,
      score: result.score,
      violations: [...hardValidation.violations, ...softWarnings],
      generatedAt: new Date(),
    };

    this.currentSchedule = schedule;
    return schedule;
  }

  /**
   * Lock a specific assignment (prevent it from being changed by optimizer).
   */
  lockAssignment(assignmentId: string): boolean {
    if (!this.currentSchedule) return false;
    const assignment = this.currentSchedule.assignments.find((a) => a.id === assignmentId);
    if (!assignment) return false;
    assignment.status = AssignmentStatus.Locked;
    assignment.updatedAt = new Date();
    return true;
  }

  /**
   * Unlock a specific assignment.
   */
  unlockAssignment(assignmentId: string): boolean {
    if (!this.currentSchedule) return false;
    const assignment = this.currentSchedule.assignments.find((a) => a.id === assignmentId);
    if (!assignment) return false;
    assignment.status = AssignmentStatus.Scheduled;
    assignment.updatedAt = new Date();
    return true;
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
