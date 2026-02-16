/**
 * Validator - Standalone validation module for real-time constraint checking.
 *
 * Used after every manual override to verify schedule integrity.
 */
import { Task, Assignment, Participant, ValidationResult, ConstraintViolation, SwapRequest } from '../models/types';
export interface FullValidationResult extends ValidationResult {
    /** Soft constraint warnings (non-fatal) */
    warnings: ConstraintViolation[];
    /** Summary for UI display */
    summary: string;
}
/**
 * Run a full validation (hard + soft) on a schedule.
 */
export declare function fullValidate(tasks: Task[], participants: Participant[], assignments: Assignment[]): FullValidationResult;
/**
 * Preview a swap without committing it — returns what violations would occur.
 */
export declare function previewSwap(tasks: Task[], participants: Participant[], assignments: Assignment[], swap: SwapRequest): FullValidationResult;
/**
 * Identify which participants could validly fill a specific slot.
 * Useful for UI dropdown population.
 */
export declare function getEligibleParticipantsForSlot(task: Task, slotId: string, participants: Participant[], currentAssignments: Assignment[], tasks: Task[]): Participant[];
//# sourceMappingURL=validator.d.ts.map