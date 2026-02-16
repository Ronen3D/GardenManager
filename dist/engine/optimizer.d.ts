/**
 * Optimizer - Max-Min Fairness scheduler with penalty/bonus heuristics.
 *
 * Uses a greedy constructive heuristic followed by local search (swap-based)
 * to maximize the composite score (rest fairness + penalties + bonuses).
 *
 * Algorithm:
 *  1. Greedy Phase: Assign participants to task slots respecting hard constraints,
 *     using a priority that favors participants with the most accumulated rest.
 *  2. Local Search Phase: Iteratively try swaps between assignments to improve
 *     composite score, accepting improvements only.
 */
import { Task, Assignment, Participant, SchedulerConfig, ScheduleScore } from '../models/types';
/** Reset counter (for testing) */
export declare function resetAssignmentCounter(): void;
/**
 * Greedy construction: assign participants to all task slots.
 * Returns assignments (may be partial if infeasible).
 */
export declare function greedyAssign(tasks: Task[], participants: Participant[], lockedAssignments?: Assignment[]): {
    assignments: Assignment[];
    unfilledSlots: {
        taskId: string;
        slotId: string;
    }[];
};
/**
 * Try to improve the schedule by swapping participants between assignments.
 * Only accepts improvements to composite score.
 */
export declare function localSearchOptimize(tasks: Task[], participants: Participant[], assignments: Assignment[], config: SchedulerConfig): Assignment[];
export interface OptimizationResult {
    assignments: Assignment[];
    score: ScheduleScore;
    feasible: boolean;
    unfilledSlots: {
        taskId: string;
        slotId: string;
    }[];
    iterations: number;
    durationMs: number;
}
/**
 * Full optimization pipeline: greedy + local search.
 */
export declare function optimize(tasks: Task[], participants: Participant[], config: SchedulerConfig, lockedAssignments?: Assignment[]): OptimizationResult;
//# sourceMappingURL=optimizer.d.ts.map