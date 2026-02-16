/**
 * Hard Constraint Validators
 *
 * If any hard constraint is violated, the schedule is INVALID.
 * Returns ConstraintViolation[] with severity=Error.
 */
import { Task, Assignment, Participant, ConstraintViolation, ValidationResult } from '../models/types';
/**
 * HC-1: Level requirement — participant's level must match slot's acceptableLevels.
 */
export declare function checkLevelRequirement(participant: Participant, task: Task, slotId: string): ConstraintViolation | null;
/**
 * HC-2: Certification requirement — participant must hold all required certs.
 */
export declare function checkCertificationRequirement(participant: Participant, task: Task, slotId: string): ConstraintViolation | null;
/**
 * HC-3: Availability — participant must be available for entire task duration.
 */
export declare function checkAvailability(participant: Participant, task: Task): ConstraintViolation | null;
/**
 * HC-4: Same group constraint (Adanit) — all participants in task must share one group.
 */
export declare function checkSameGroup(task: Task, assignedParticipants: Participant[]): ConstraintViolation[];
/**
 * HC-5: No double-booking — a participant cannot be assigned to two overlapping
 * non-light tasks at the same time. Light tasks (Karovit) can overlap with anything.
 */
export declare function checkNoDoubleBooking(participantId: string, assignments: Assignment[], taskMap: Map<string, Task>): ConstraintViolation[];
/**
 * HC-6: Slot fill — every slot in a task must be assigned exactly one participant.
 */
export declare function checkSlotsFilled(task: Task, assignments: Assignment[]): ConstraintViolation[];
/**
 * HC-7: Unique participant per task — no participant assigned twice to the same task.
 */
export declare function checkUniqueParticipantsPerTask(task: Task, assignments: Assignment[]): ConstraintViolation[];
/**
 * HC-8: Adanit group feasibility — the assigned group must have enough participants
 * at the required levels.
 */
export declare function checkAdanitGroupFeasibility(task: Task, groupParticipants: Participant[]): ConstraintViolation[];
/**
 * Run ALL hard constraint checks against a complete schedule.
 * Returns aggregated violations — if any exist, the schedule is infeasible.
 */
export declare function validateHardConstraints(tasks: Task[], participants: Participant[], assignments: Assignment[]): ValidationResult;
//# sourceMappingURL=hard-constraints.d.ts.map