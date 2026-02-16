/**
 * Scheduling Engine - Main orchestrator class.
 *
 * Two-stage workflow:
 *  Stage 1: Data Setup — register participants and tasks.
 *  Stage 2: Optimal Generation — generate schedule, with manual overrides.
 */
import { Participant, Task, Schedule, SchedulerConfig, ValidationResult, SwapRequest, ReScheduleRequest } from '../models/types';
export declare class SchedulingEngine {
    private participants;
    private tasks;
    private currentSchedule;
    private config;
    constructor(config?: Partial<SchedulerConfig>);
    /**
     * Add or update a participant.
     */
    addParticipant(participant: Participant): void;
    /**
     * Add multiple participants.
     */
    addParticipants(participants: Participant[]): void;
    /**
     * Remove a participant by ID.
     */
    removeParticipant(id: string): boolean;
    /**
     * Get a participant by ID.
     */
    getParticipant(id: string): Participant | undefined;
    /**
     * Get all participants.
     */
    getAllParticipants(): Participant[];
    /**
     * Add or update a task.
     */
    addTask(task: Task): void;
    /**
     * Add multiple tasks.
     */
    addTasks(tasks: Task[]): void;
    /**
     * Remove a task by ID.
     */
    removeTask(id: string): boolean;
    /**
     * Get a task by ID.
     */
    getTask(id: string): Task | undefined;
    /**
     * Get all tasks.
     */
    getAllTasks(): Task[];
    /**
     * Clear all data (reset to initial state).
     */
    reset(): void;
    /**
     * Generate an optimized schedule from the current participants and tasks.
     * This is the main entry point for schedule creation.
     */
    generateSchedule(): Schedule;
    /**
     * Get the current schedule (if generated).
     */
    getSchedule(): Schedule | null;
    /**
     * Validate the current schedule's hard constraints.
     * Call after every manual change.
     */
    validate(): ValidationResult;
    /**
     * Swap a participant in an existing assignment (manual override).
     * Runs validate() after the swap and returns the result.
     */
    swapParticipant(request: SwapRequest): ValidationResult;
    /**
     * Partial re-schedule: lock existing assignments and re-optimize only affected slots.
     * Used when a participant becomes unavailable mid-day.
     */
    partialReSchedule(request: ReScheduleRequest): Schedule;
    /**
     * Lock a specific assignment (prevent it from being changed by optimizer).
     */
    lockAssignment(assignmentId: string): boolean;
    /**
     * Unlock a specific assignment.
     */
    unlockAssignment(assignmentId: string): boolean;
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
    };
}
//# sourceMappingURL=scheduler.d.ts.map