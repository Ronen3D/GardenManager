/**
 * Resource Scheduling Engine - Core Type Definitions
 *
 * All TypeScript interfaces, enums, and type aliases for the scheduling system.
 */

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Participant qualification levels */
export enum Level {
  L0 = 0,
  L2 = 2,
  L3 = 3,
  L4 = 4,
}

/** Certification types a participant can hold */
export enum Certification {
  Nitzan = 'Nitzan',
  Salsala = 'Salsala',
  Hamama = 'Hamama',
  Horesh = 'Horesh',
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
  Frozen = 'Frozen',     // Temporally locked — past the live-mode anchor
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

// ─── Capacity ────────────────────────────────────────────────────────────────

/**
 * Pre-computed capacity for a participant within a schedule window.
 * Used to scale "fair share" targets proportionally to availability.
 */
export interface ParticipantCapacity {
  /** Total available hours across the entire schedule window */
  totalAvailableHours: number;
  /** Available hours per calendar day (keyed by YYYY-MM-DD dateKey) */
  dailyAvailableHours: Map<string, number>;
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
  /** Base load weight applied outside explicit load windows (0..1). */
  baseLoadWeight?: number;
  /** Optional weighted load windows within the task's timeline. */
  loadWindows?: LoadWindow[];
  /** Group constraint: all participants must be from same group */
  sameGroupRequired: boolean;
  /**
   * HC-12 consecutive-task blocking flag.
   * When true, this task prohibits back-to-back placement with another
   * task that also has blocksConsecutive=true (regardless of load weight).
   * All tasks except Karov and Karovit default to true.
   */
  blocksConsecutive: boolean;
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
  /** Status before temporal freezing (so we can restore on unfreeze) */
  preFreezeStatus?: AssignmentStatus;
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
  /** Standard deviation of effective load hours — lower is fairer */
  restStdDev: number;
  /** Sum of penalty points (Hamama level misuse, etc.) */
  totalPenalty: number;
  /** Composite objective: maximize this */
  compositeScore: number;

  // ── Split-pool fairness metrics ──

  /** L0 effective-load std-dev (primary fairness target) */
  l0StdDev: number;
  /** L0 average effective hours */
  l0AvgEffective: number;
  /** Senior (L2-L4) effective-load std-dev */
  seniorStdDev: number;
  /** Senior (L2-L4) average effective hours */
  seniorAvgEffective: number;
  /** Avg of each participant's daily-load std-dev (per-person day spread) */
  dailyPerParticipantStdDev: number;
  /** Std-dev of total hours per calendar day (global day spread) */
  dailyGlobalStdDev: number;
  /** Penalty for disrupting existing assignments (rescue mode only) */
  disruptionPenalty?: number;
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
  /** Weight for L0 fairness (negative std dev) — primary */
  l0FairnessWeight: number;
  /** Weight for senior (L2-L4) fairness — secondary */
  seniorFairnessWeight: number;

  /** Max solver iterations */
  maxIterations: number;
  /** Max time for solver in ms */
  maxSolverTimeMs: number;
  /** Penalty for ANY senior (L2/L3/L4) assigned to Hamama — absolute last resort */
  seniorHamamaPenalty: number;
  /** Weight for daily workload balance (penalises busy-day / light-day spread) */
  dailyBalanceWeight: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  minRestWeight: 10,
  l0FairnessWeight: 40,
  seniorFairnessWeight: 6,

  maxIterations: 10000,
  maxSolverTimeMs: 30000,
  seniorHamamaPenalty: 10000,
  dailyBalanceWeight: 90,
};

// ─── Algorithm Settings (user-configurable control panel) ────────────────────

/** All hard constraint codes that can be toggled */
export type HardConstraintCode =
  | 'HC-1'   // Level requirement
  | 'HC-2'   // Certification requirement
  | 'HC-3'   // Availability check
  | 'HC-4'   // Same-group (Adanit)
  | 'HC-5'   // No double-booking
  | 'HC-6'   // Slots filled
  | 'HC-7'   // Unique participant per task
  | 'HC-8'   // Adanit feasibility
  | 'HC-11'  // Choresh exclusion
  | 'HC-12'  // No consecutive high-load
  | 'HC-13'; // Senior hard blocks

/** All soft warning codes that can be toggled */
export type SoftWarningCode =
  | 'HAMAMA_SENIOR'
  | 'GROUP_MISMATCH';

/** Full algorithm settings: weights + constraint toggles */
export interface AlgorithmSettings {
  /** All SchedulerConfig weight fields */
  config: SchedulerConfig;
  /** Hard constraints that are DISABLED (unchecked by user) */
  disabledHardConstraints: HardConstraintCode[];
  /** Soft warnings that are DISABLED (unchecked by user) */
  disabledSoftWarnings: SoftWarningCode[];
}

/** Human-readable labels for hard constraints */
export const HC_LABELS: Record<HardConstraintCode, string> = {
  'HC-1': 'דרישת דרגה',
  'HC-2': 'דרישת הסמכה',
  'HC-3': 'בדיקת זמינות',
  'HC-4': 'אותה קבוצה (אדנית)',
  'HC-5': 'ללא שיבוץ כפול',
  'HC-6': 'משבצות מלאות',
  'HC-7': 'משתתף ייחודי למשימה',
  'HC-8': 'היתכנות קבוצת אדנית',
  'HC-11': 'הרחקת חורש מממטרה',
  'HC-12': 'ללא עומס רצוף',
  'HC-13': 'חסימות בכירים',
};

/** Human-readable labels for soft warnings */
export const SW_LABELS: Record<SoftWarningCode, string> = {
  'HAMAMA_SENIOR': 'אזהרת בכירים בחממה',
  'GROUP_MISMATCH': 'אזהרת אי-התאמת קבוצה',
};

/** All hard constraint codes in display order */
export const ALL_HC_CODES: HardConstraintCode[] = [
  'HC-1', 'HC-2', 'HC-3', 'HC-4', 'HC-5', 'HC-6', 'HC-7', 'HC-8', 'HC-11', 'HC-12', 'HC-13',
];

/** All soft warning codes in display order */
export const ALL_SW_CODES: SoftWarningCode[] = [
  'HAMAMA_SENIOR', 'GROUP_MISMATCH',
];

/** Factory default algorithm settings */
export const DEFAULT_ALGORITHM_SETTINGS: AlgorithmSettings = {
  config: { ...DEFAULT_CONFIG },
  disabledHardConstraints: [],
  disabledSoftWarnings: [],
};

// ─── Algorithm Presets ───────────────────────────────────────────────────────

/** A named, saveable snapshot of AlgorithmSettings */
export interface AlgorithmPreset {
  id: string;
  name: string;
  description: string;
  settings: AlgorithmSettings;
  /** If true the preset cannot be deleted or renamed */
  builtIn?: boolean;
  /** Epoch ms — used for ordering user-created presets */
  createdAt: number;
}

/** The built-in factory-default preset */
export const DEFAULT_PRESET: AlgorithmPreset = {
  id: 'preset-default',
  name: 'ברירת מחדל',
  description: 'הגדרות מקוריות',
  settings: { ...DEFAULT_ALGORITHM_SETTINGS, config: { ...DEFAULT_CONFIG }, disabledHardConstraints: [], disabledSoftWarnings: [] },
  builtIn: true,
  createdAt: 0,
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

/** Time-of-day load window with explicit weight (0..1). */
export interface LoadWindow {
  id: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  weight: number;
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
  /** Evening shift start hour (Aruga dual-shift tasks). Defaults to 17. */
  eveningStartHour?: number;
  /** Whether all participants must be from the same group */
  sameGroupRequired: boolean;
  /** Whether this is a light task */
  isLight: boolean;
  /** Base load weight outside hot windows (0..1). */
  baseLoadWeight?: number;
  /** Optional weighted windows (typically "hot" windows). */
  loadWindows?: LoadWindow[];
  /**
   * HC-12 consecutive-task blocking flag.
   * When true, this task prohibits back-to-back placement with another
   * blocksConsecutive task. Defaults to true for heavy tasks, false for light.
   */
  blocksConsecutive?: boolean;
  /** Sub-teams (each has its own slots). If empty, slots are top-level */
  subTeams: SubTeamTemplate[];
  /** Top-level slots (used when there are no sub-teams) */
  slots: SlotTemplate[];
  /** Custom notes / description */
  description?: string;
}

// ─── Multi-Day Schedule Types ────────────────────────────────────────────────

/** Week-long schedule configuration */
export interface WeekConfig {
  /** Start date of the 7-day window */
  startDate: Date;
  /** Number of days (default 7) */
  numDays: number;
}

// ─── Live Mode Types ─────────────────────────────────────────────────────────

/** State of the live-mode temporal anchor */
export interface LiveModeState {
  /** Whether live mode is enabled */
  enabled: boolean;
  /** The temporal anchor point (everything before this is frozen) */
  currentTimestamp: Date;
}

/** A single swap within a rescue plan */
export interface RescueSwap {
  /** The assignment being changed */
  assignmentId: string;
  /** The participant being moved out (null if the slot was vacated) */
  fromParticipantId: string | null;
  /** The participant being moved in */
  toParticipantId: string;
  /** Task ID for this swap's assignment */
  taskId: string;
  /** Human-readable task name */
  taskName: string;
  /** Human-readable slot label */
  slotLabel: string;
}

/** A single rescue plan (one of 3 presented to the user) */
export interface RescuePlan {
  id: string;
  /** Display rank within the page (1, 2, 3) */
  rank: number;
  /** Chain of swaps required to implement this plan */
  swaps: RescueSwap[];
  /** Composite impact score (lower = less disruption) */
  impactScore: number;
  /** Change in daily workload std-dev for the affected day */
  dailyLoadDelta: number;
  /** Change in weekly workload std-dev */
  weeklyLoadDelta: number;
  /** Constraint violations that would exist after applying this plan */
  violations: ConstraintViolation[];
}

/** Request to generate rescue plans for a vacated assignment */
export interface RescueRequest {
  /** The assignment that was vacated */
  vacatedAssignmentId: string;
  /** Task containing the vacated slot */
  taskId: string;
  /** Slot that was vacated */
  slotId: string;
  /** Participant who vacated the slot */
  vacatedBy: string;
}

/** Result of rescue plan generation (paginated) */
export interface RescueResult {
  /** The original request */
  request: RescueRequest;
  /** Up to 3 plans for this page */
  plans: RescuePlan[];
  /** Whether more plans exist beyond this page */
  hasMore: boolean;
  /** Current page number (0-based) */
  page: number;
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
