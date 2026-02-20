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
import { computeScheduleScore, collectSoftWarnings } from '../constraints/soft-constraints';
import {
  optimize,
  optimizeMultiAttemptAsync,
  OptimizationResult,
  resetAssignmentCounter,
  MultiAttemptProgressCallback,
} from './optimizer';
import { resetSlotCounter, resetTaskCounter } from '../tasks/task-definitions';

export class SchedulingEngine {
  private participants: Map<string, Participant> = new Map();
  private tasks: Map<string, Task> = new Map();
  private currentSchedule: Schedule | null = null;
  private config: SchedulerConfig;
  private weekEnd: Date = new Date();
  private disabledHC?: Set<string>;
  private disabledSW?: Set<string>;

  constructor(config: Partial<SchedulerConfig> = {}, disabledHC?: Set<string>, disabledSW?: Set<string>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.disabledHC = disabledHC;
    this.disabledSW = disabledSW;
    // Bug #12 fix: reset module-level counters so IDs start fresh
    // for each new engine instance.
    resetAssignmentCounter();
    resetSlotCounter();
    resetTaskCounter();
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Stage 2: Schedule Generation & Optimization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate an optimized schedule from the current participants and tasks.
   * This is the main entry point for schedule creation.
   */
  generateSchedule(): Schedule {
    const tasks = this.getAllTasks();
    const participants = this.getAllParticipants();

    if (tasks.length === 0) {
      throw new Error('No tasks registered. Add tasks before generating a schedule.');
    }
    if (participants.length === 0) {
      throw new Error('No participants registered. Add participants before generating a schedule.');
    }

    const result: OptimizationResult = optimize(tasks, participants, this.config, [], this.disabledHC);
    // Compute week end from tasks
    const sortedByEnd = [...tasks].sort(
      (a, b) => b.timeBlock.end.getTime() - a.timeBlock.end.getTime(),
    );
    this.weekEnd = sortedByEnd.length > 0 ? sortedByEnd[0].timeBlock.end : new Date();

    const hardValidation = validateHardConstraints(tasks, participants, result.assignments, this.disabledHC);
    const softWarnings = collectSoftWarnings(tasks, participants, result.assignments, this.disabledSW);

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
          ? `Infeasible: ${reason} (slot "${slot?.label ?? slotId}" in "${task?.name ?? taskId}")`
          : `Infeasible Schedule: Cannot fill slot "${slot?.label ?? slotId}" in task "${task?.name ?? taskId}". No eligible participants available.`,
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
    };

    this.currentSchedule = schedule;
    return schedule;
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

    if (tasks.length === 0) {
      throw new Error('No tasks registered. Add tasks before generating a schedule.');
    }
    if (participants.length === 0) {
      throw new Error('No participants registered. Add participants before generating a schedule.');
    }

    const result = await optimizeMultiAttemptAsync(
      tasks,
      participants,
      this.config,
      [],
      attempts,
      onProgress,
      this.disabledHC,
    );

    const sortedByEnd = [...tasks].sort(
      (a, b) => b.timeBlock.end.getTime() - a.timeBlock.end.getTime(),
    );
    this.weekEnd = sortedByEnd.length > 0 ? sortedByEnd[0].timeBlock.end : new Date();

    // Collect all violations
    const hardValidation = validateHardConstraints(tasks, participants, result.assignments, this.disabledHC);
    const softWarnings = collectSoftWarnings(tasks, participants, result.assignments, this.disabledSW);

    const allViolations: ConstraintViolation[] = [
      ...hardValidation.violations,
      ...softWarnings,
    ];

    for (const { taskId, slotId, reason } of result.unfilledSlots) {
      const task = this.tasks.get(taskId);
      const slot = task?.slots.find((s) => s.slotId === slotId);
      allViolations.push({
        severity: ViolationSeverity.Error,
        code: 'INFEASIBLE_SLOT',
        message: reason
          ? `Infeasible: ${reason} (slot "${slot?.label ?? slotId}" in "${task?.name ?? taskId}")`
          : `Infeasible Schedule: Cannot fill slot "${slot?.label ?? slotId}" in task "${task?.name ?? taskId}". No eligible participants available.`,
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
    };

    this.currentSchedule = schedule;
    return schedule;
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
    return this.weekEnd;
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
      return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'No schedule has been generated yet.', taskId: '' }] };
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
    const soft = collectSoftWarnings(tasks, participants, assignments, this.disabledSW);
    const score = computeScheduleScore(tasks, participants, assignments, this.config, undefined, this.disabledSW);

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
      return { valid: false, violations: [{ severity: ViolationSeverity.Error, code: 'NO_SCHEDULE', message: 'No schedule exists to modify.', taskId: '' }] };
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
          message: `Assignment ${request.assignmentId} not found.`,
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
          message: `Participant ${request.newParticipantId} not found.`,
          taskId: assignment.taskId,
        }],
      };
    }

    // Perform the swap
    assignment.participantId = request.newParticipantId;
    assignment.status = AssignmentStatus.Manual;
    assignment.updatedAt = new Date();

    // Re-validate
    const validation = this.validate();

    // Update score
    this.currentSchedule.score = computeScheduleScore(
      this.currentSchedule.tasks,
      this.currentSchedule.participants,
      this.currentSchedule.assignments,
      this.config,
      undefined,
      this.disabledSW,
    );
    this.currentSchedule.feasible = validation.valid;
    this.currentSchedule.violations = [
      ...validation.violations,
      ...collectSoftWarnings(
        this.currentSchedule.tasks,
        this.currentSchedule.participants,
        this.currentSchedule.assignments,
        this.disabledSW,
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
      throw new Error('No schedule exists to partially re-schedule.');
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
      this.disabledSW,
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
