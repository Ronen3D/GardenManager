/**
 * Rest Calculator - Computes rest periods between non-light tasks for each participant.
 *
 * Rest Definition: Time between non-light tasks.
 * "Karovit" (Light Task) can be performed during rest periods without resetting rest.
 */
import { Task, Assignment, Participant } from '../models/types';
export interface ParticipantRestProfile {
    participantId: string;
    /** All rest gaps (hours) between consecutive non-light tasks */
    restGaps: number[];
    /** Minimum rest gap (hours) — the bottleneck */
    minRestHours: number;
    /** Maximum rest gap (hours) */
    maxRestHours: number;
    /** Average rest gap (hours) */
    avgRestHours: number;
    /** Total non-light task hours */
    totalWorkHours: number;
    /** Total light task hours (doesn't count as work) */
    totalLightHours: number;
    /** Number of non-light assignments */
    nonLightAssignmentCount: number;
}
/**
 * Compute the rest profile for a single participant.
 */
export declare function computeParticipantRest(participantId: string, assignments: Assignment[], tasks: Task[]): ParticipantRestProfile;
/**
 * Compute rest profiles for all participants.
 */
export declare function computeAllRestProfiles(participants: Participant[], assignments: Assignment[], tasks: Task[]): Map<string, ParticipantRestProfile>;
/**
 * Compute global rest fairness metrics.
 */
export declare function computeRestFairness(profiles: Map<string, ParticipantRestProfile>): {
    globalMinRest: number;
    globalAvgRest: number;
    stdDevRest: number;
};
//# sourceMappingURL=rest-calculator.d.ts.map