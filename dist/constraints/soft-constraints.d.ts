/**
 * Soft Constraint Scorers
 *
 * These produce numeric scores (penalties / bonuses) that guide
 * the optimizer toward better schedules without making them invalid.
 */
import { Task, Assignment, Participant, SchedulerConfig, ScheduleScore, ConstraintViolation } from '../models/types';
/**
 * SC-1: Hamama penalty — penalise assigning L3/L4 to Hamama.
 * Best: L0 (0 penalty), Acceptable: L3 (high), Avoid: L4 (extreme).
 */
export declare function hamamaPenalty(task: Task, participant: Participant, config: SchedulerConfig): number;
/**
 * SC-2: Shemesh same-group bonus — reward when both Shemesh participants share a group.
 */
export declare function shemeshGroupBonus(task: Task, assignedParticipants: Participant[], config: SchedulerConfig): number;
/**
 * SC-3: Workload balance — penalize uneven distribution of non-light assignments.
 * Returns a penalty proportional to the standard deviation of assignment counts.
 */
export declare function workloadImbalancePenalty(participants: Participant[], assignments: Assignment[], tasks: Task[]): number;
/**
 * Generate warnings (non-fatal) for soft constraint issues.
 */
export declare function collectSoftWarnings(tasks: Task[], participants: Participant[], assignments: Assignment[]): ConstraintViolation[];
/**
 * Compute the full ScheduleScore for a set of assignments.
 */
export declare function computeScheduleScore(tasks: Task[], participants: Participant[], assignments: Assignment[], config: SchedulerConfig): ScheduleScore;
//# sourceMappingURL=soft-constraints.d.ts.map