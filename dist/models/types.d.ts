/**
 * Resource Scheduling Engine - Core Type Definitions
 *
 * All TypeScript interfaces, enums, and type aliases for the scheduling system.
 */
/** Participant qualification levels */
export declare enum Level {
    L0 = 0,
    L1 = 1,
    L2 = 2,
    L3 = 3,
    L4 = 4
}
/** Certification types a participant can hold */
export declare enum Certification {
    Nitzan = "Nitzan",
    Salsala = "Salsala",
    Hamama = "Hamama"
}
/** Task type identifiers */
export declare enum TaskType {
    Adanit = "Adanit",
    Hamama = "Hamama",
    Shemesh = "Shemesh",
    Mamtera = "Mamtera",
    Karov = "Karov",
    Karovit = "Karovit",
    Aruga = "Aruga"
}
/** Assignment status */
export declare enum AssignmentStatus {
    Scheduled = "Scheduled",
    Locked = "Locked",// Locked by user or partial re-schedule
    Manual = "Manual",// Manually overridden by user
    Conflict = "Conflict"
}
/** Severity for constraint violations */
export declare enum ViolationSeverity {
    Error = "Error",// Hard constraint → schedule invalid
    Warning = "Warning"
}
/** Adanit team designation */
export declare enum AdanitTeam {
    SegolMain = "SegolMain",
    SegolSecondary = "SegolSecondary"
}
/** A continuous time block (supports midnight crossing) */
export interface TimeBlock {
    /** ISO-8601 start datetime */
    start: Date;
    /** ISO-8601 end datetime (may be next day) */
    end: Date;
}
/** Availability window for a participant */
export interface AvailabilityWindow {
    start: Date;
    end: Date;
}
export interface Participant {
    id: string;
    name: string;
    level: Level;
    certifications: Certification[];
    group: string;
    /** Time windows when participant is available */
    availability: AvailabilityWindow[];
}
/** Slot requirement within a task (e.g., "2x Level 0" is two slots) */
export interface SlotRequirement {
    /** Unique slot ID within the task */
    slotId: string;
    /** Acceptable levels for this slot */
    acceptableLevels: Level[];
    /** Required certifications for this slot */
    requiredCertifications: Certification[];
    /** Optional: Adanit team designation */
    adanitTeam?: AdanitTeam;
    /** Optional: label for display purposes */
    label?: string;
}
export interface Task {
    id: string;
    type: TaskType;
    /** Human-readable name */
    name: string;
    /** Time block for this task instance */
    timeBlock: TimeBlock;
    /** How many participants are required */
    requiredCount: number;
    /** Detailed slot requirements */
    slots: SlotRequirement[];
    /** Whether this task is "light" (Karovit) — doesn't break rest */
    isLight: boolean;
    /** Group constraint: all participants must be from same group */
    sameGroupRequired: boolean;
    /** Optional: preferred group (soft constraint) */
    preferredGroup?: string;
}
export interface Assignment {
    /** Unique assignment ID */
    id: string;
    taskId: string;
    slotId: string;
    participantId: string;
    status: AssignmentStatus;
    /** Timestamp of last modification */
    updatedAt: Date;
}
export interface Schedule {
    id: string;
    /** All tasks in this scheduling window */
    tasks: Task[];
    /** All participants in the pool */
    participants: Participant[];
    /** Generated assignments */
    assignments: Assignment[];
    /** Overall feasibility flag */
    feasible: boolean;
    /** Score metrics */
    score: ScheduleScore;
    /** Constraint violations found */
    violations: ConstraintViolation[];
    /** Timestamp of generation */
    generatedAt: Date;
}
export interface ScheduleScore {
    /** Minimum rest period across all participants (hours) — higher is better */
    minRestHours: number;
    /** Average rest period (hours) */
    avgRestHours: number;
    /** Standard deviation of rest periods — lower is fairer */
    restStdDev: number;
    /** Sum of penalty points (Hamama level misuse, etc.) */
    totalPenalty: number;
    /** Sum of bonus points (same-group Shemesh, etc.) */
    totalBonus: number;
    /** Composite objective: maximize this */
    compositeScore: number;
}
export interface ConstraintViolation {
    severity: ViolationSeverity;
    taskId: string;
    slotId?: string;
    participantId?: string;
    /** Machine-readable constraint code */
    code: string;
    /** Human-readable message */
    message: string;
}
export interface ValidationResult {
    valid: boolean;
    violations: ConstraintViolation[];
}
export interface SchedulerConfig {
    /** Weight for min-rest in composite score */
    minRestWeight: number;
    /** Weight for rest fairness (negative std dev) */
    fairnessWeight: number;
    /** Weight for penalty deduction */
    penaltyWeight: number;
    /** Weight for bonus addition */
    bonusWeight: number;
    /** Hamama Level 3 penalty points */
    hamamaL3Penalty: number;
    /** Hamama Level 4 penalty points */
    hamamaL4Penalty: number;
    /** Bonus for Shemesh same-group assignment */
    shemeshSameGroupBonus: number;
    /** Max solver iterations */
    maxIterations: number;
    /** Max time for solver in ms */
    maxSolverTimeMs: number;
}
export declare const DEFAULT_CONFIG: SchedulerConfig;
export interface GanttRow {
    participantId: string;
    participantName: string;
    group: string;
    level: Level;
    blocks: GanttBlock[];
}
export interface GanttBlock {
    assignmentId: string;
    taskId: string;
    taskType: TaskType;
    taskName: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    status: AssignmentStatus;
    isLight: boolean;
    /** CSS color suggestion */
    color: string;
}
export interface GanttData {
    rows: GanttRow[];
    timelineStartMs: number;
    timelineEndMs: number;
    /** Minutes per pixel suggestion */
    scaleMinPerPx: number;
}
export interface SwapRequest {
    assignmentId: string;
    newParticipantId: string;
}
export interface ReScheduleRequest {
    /** IDs of assignments to keep locked */
    lockedAssignmentIds: string[];
    /** IDs of participants that became unavailable */
    unavailableParticipantIds: string[];
}
//# sourceMappingURL=types.d.ts.map