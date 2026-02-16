/**
 * Resource Scheduling Engine - Core Type Definitions
 *
 * All TypeScript interfaces, enums, and type aliases for the scheduling system.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Participant qualification levels */
export enum Level {
  L0 = 0,
  L1 = 1,
  L2 = 2,
  L3 = 3,
  L4 = 4,
}

/** Certification types a participant can hold */
export enum Certification {
  Nitzan = 'Nitzan',
  Salsala = 'Salsala',
  Hamama = 'Hamama',
}

/** Task type identifiers */
export enum TaskType {
  Adanit = 'Adanit',
  Hamama = 'Hamama',
  Shemesh = 'Shemesh',
  Mamtera = 'Mamtera',
  Karov = 'Karov',
  Karovit = 'Karovit',
  Aruga = 'Aruga',
}

/** Assignment status */
export enum AssignmentStatus {
  Scheduled = 'Scheduled',
  Locked = 'Locked',     // Locked by user or partial re-schedule
  Manual = 'Manual',     // Manually overridden by user
  Conflict = 'Conflict', // Hard constraint violation detected
}

/** Severity for constraint violations */
export enum ViolationSeverity {
  Error = 'Error',     // Hard constraint → schedule invalid
  Warning = 'Warning', // Soft constraint → penalized but allowed
}

/** Adanit team designation */
export enum AdanitTeam {
  SegolMain = 'SegolMain',
  SegolSecondary = 'SegolSecondary',
}

// ─── Time ────────────────────────────────────────────────────────────────────

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

/** A recurring or one-off unavailability rule for a participant */
export interface DateUnavailability {
  id: string;
  /** Day of week (0=Sunday … 6=Saturday). If set, recurring weekly. */
  dayOfWeek?: number;
  /** Specific calendar date 'YYYY-MM-DD'. If set, applies to that date only. */
  specificDate?: string;
  /** Start hour (0-23). Ignored when allDay is true. */
  startHour: number;
  /** End hour (0-23). Ignored when allDay is true. */
  endHour: number;
  /** If true, unavailable for the entire day. */
  allDay: boolean;
  /** Optional reason / note. */
  reason?: string;
}

// ─── Participant ─────────────────────────────────────────────────────────────

export interface Participant {
  id: string;
  name: string;
  level: Level;
  certifications: Certification[];
  group: string;
  /** Time windows when participant is available */
  availability: AvailabilityWindow[];
  /** Date-specific unavailability rules (recurring or one-off) */
  dateUnavailability: DateUnavailability[];
}

// ─── Task ────────────────────────────────────────────────────────────────────

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

// ─── Assignment ──────────────────────────────────────────────────────────────

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

// ─── Schedule ────────────────────────────────────────────────────────────────

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

// ─── Constraint Violations ───────────────────────────────────────────────────

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

// ─── Validation Result ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  violations: ConstraintViolation[];
}

// ─── Engine Configuration ────────────────────────────────────────────────────

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
  /** Penalty per zero-gap (back-to-back) assignment pair — soft only */
  backToBackPenalty: number;
  /** Max solver iterations */
  maxIterations: number;
  /** Max time for solver in ms */
  maxSolverTimeMs: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  minRestWeight: 15,
  fairnessWeight: 8,
  penaltyWeight: 4,
  bonusWeight: 3,
  hamamaL3Penalty: 50,
  hamamaL4Penalty: 200,
  shemeshSameGroupBonus: 10,
  backToBackPenalty: 3,
  maxIterations: 10000,
  maxSolverTimeMs: 30000,
};

// ─── Gantt UI Bridge Types ───────────────────────────────────────────────────

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

// ─── Override / Swap Request ─────────────────────────────────────────────────

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

// ─── Stage 0: Configuration Types ───────────────────────────────────────────

/** A blackout window when a participant is NOT available */
export interface BlackoutPeriod {
  id: string;
  start: Date;
  end: Date;
  reason?: string;
}

/** A single slot template inside a TaskTemplate */
export interface SlotTemplate {
  id: string;
  label: string;
  acceptableLevels: Level[];
  requiredCertifications: Certification[];
  adanitTeam?: AdanitTeam;
}

/** A sub-team definition within a task template */
export interface SubTeamTemplate {
  id: string;
  name: string;
  slots: SlotTemplate[];
}

/** A reusable task rule/template defining how a task type is configured */
export interface TaskTemplate {
  id: string;
  name: string;
  taskType: TaskType | string;
  /** Duration in hours */
  durationHours: number;
  /** How many shifts per day (e.g., 3 for Adanit) */
  shiftsPerDay: number;
  /** First shift start hour */
  startHour: number;
  /** Whether all participants must be from the same group */
  sameGroupRequired: boolean;
  /** Whether this is a light task */
  isLight: boolean;
  /** Sub-teams (each has its own slots). If empty, slots are top-level */
  subTeams: SubTeamTemplate[];
  /** Top-level slots (used when there are no sub-teams) */
  slots: SlotTemplate[];
  /** Custom notes / description */
  description?: string;
}

// ─── L1 Adanit Cycle Types ───────────────────────────────────────────────────

/** Phase within the L1 Adanit 8-8-8-16 cycle */
export enum L1CyclePhase {
  /** Working an 8h Adanit shift */
  Work1 = 'Work1',
  /** 8h mandatory rest after first work block */
  Rest8 = 'Rest8',
  /** Working the second 8h Adanit shift */
  Work2 = 'Work2',
  /** 16h mandatory rest after second work block */
  Rest16 = 'Rest16',
}

/**
 * Tracks where an L1 participant is in their Adanit duty cycle.
 * Cycle: 8h Work → 8h Rest → 8h Work → 16h Rest → repeat (40h total period)
 */
export interface L1CycleState {
  participantId: string;
  /** Current phase */
  phase: L1CyclePhase;
  /** When this phase started */
  phaseStart: Date;
  /** When this phase ends */
  phaseEnd: Date;
  /** Which stagger group (0-based); determines initial offset */
  staggerIndex: number;
}

// ─── Multi-Day Schedule Types ────────────────────────────────────────────────

/** Week-long schedule configuration */
export interface WeekConfig {
  /** Start date of the 7-day window */
  startDate: Date;
  /** Number of days (default 7) */
  numDays: number;
}

/** Severity levels for preflight checks */
export enum PreflightSeverity {
  Critical = 'Critical',
  Warning = 'Warning',
  Info = 'Info',
}

/** A single preflight validation finding */
export interface PreflightFinding {
  severity: PreflightSeverity;
  code: string;
  message: string;
  /** Related template ID */
  templateId?: string;
  /** Related slot or sub-team */
  slotId?: string;
}

/** Result of the preflight check */
export interface PreflightResult {
  canGenerate: boolean;
  findings: PreflightFinding[];
  utilizationSummary: {
    totalRequiredSlots: number;
    totalAvailableParticipantHours: number;
    totalRequiredHours: number;
    utilizationPercent: number;
  };
}
