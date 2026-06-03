/**
 * Resource Scheduling Engine - Core Type Definitions
 *
 * All TypeScript interfaces, enums, and type aliases for the scheduling system.
 */

import type { ContinuitySnapshot } from './continuity-schema';

// ─── Enums ───────────────────────────────────────────────────────────────────

/** Participant qualification levels */
export enum Level {
  L0 = 0,
  L2 = 2,
  L3 = 3,
  L4 = 4,
}

/** A user-manageable certification definition. */
export interface CertificationDefinition {
  /** Unique stable ID — also used as the match key in participant/slot arrays. */
  id: string;
  /** Hebrew display label (e.g. 'ניצן'). */
  label: string;
  /** Display color for badge (hex, e.g. '#16a085'). */
  color: string;
  /** When true, the definition was deleted but kept as a tombstone so orphan
   *  badges can still display the original Hebrew label and color. */
  deleted?: boolean;
}

/** Default certification definitions — the single source of initial config. */
export const DEFAULT_CERTIFICATION_DEFINITIONS: CertificationDefinition[] = [
  { id: 'Nitzan', label: 'ניצן', color: '#16a085' },
  { id: 'Hamama', label: 'חממה', color: '#c0392b' },
  { id: 'Horesh', label: 'חורש', color: '#27ae60' },
];

/** A level annotated with priority for a slot. */
export interface LevelEntry {
  level: Level;
  /** When true, this level is allowed but treated as "very low priority" —
   *  the scheduler will avoid it unless no normal-priority candidate exists. */
  lowPriority?: boolean;
}

/** Assignment status */
export enum AssignmentStatus {
  Scheduled = 'Scheduled',
  Manual = 'Manual', // Manually overridden by user
  Conflict = 'Conflict', // Hard constraint violation detected
  Frozen = 'Frozen', // Temporally locked — past the live-mode anchor
}

/** Severity for constraint violations */
export enum ViolationSeverity {
  Error = 'Error', // Hard constraint → schedule invalid
  Warning = 'Warning', // Soft constraint → penalized but allowed
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

/** A recurring schedule-day unavailability rule for a participant.
 *
 *  Addresses days by schedule-relative index (1..periodDays), not by JS
 *  weekday. The blackout spans from `startHour` on `dayIndex` to `endHour`
 *  on `endDayIndex` (defaults to `dayIndex`), where hours < the schedule's
 *  `dayStartHour` are mapped into the post-midnight tail of that same op-day.
 */
export interface DateUnavailability {
  id: string;
  /** Schedule day index where the blackout starts (1..periodDays). */
  dayIndex: number;
  /** Optional end schedule day index (1..periodDays). Absent or equal to
   *  dayIndex means a single-day rule. Must be >= dayIndex (no wrap). */
  endDayIndex?: number;
  /** Wall-clock hour (0-23) applied on the start day. Ignored when allDay. */
  startHour: number;
  /** Wall-clock hour (0-23) applied on the end day. Ignored when allDay. */
  endHour: number;
  /** If true, unavailable for the entire day range (ignores hours). */
  allDay: boolean;
  /** Optional reason / note. */
  reason?: string;
}

/** Managed participant פק"ל definition. */
export interface PakalDefinition {
  id: string;
  label: string;
  /** When true, the definition was deleted but kept as a tombstone so orphan
   *  badges can still display the original Hebrew label. */
  deleted?: boolean;
}

// ─── Participant ─────────────────────────────────────────────────────────────

export interface Participant {
  id: string;
  name: string;
  level: Level;
  certifications: string[];
  group: string;
  /** Time windows when participant is available */
  availability: AvailabilityWindow[];
  /** Recurring weekday unavailability rules */
  dateUnavailability: DateUnavailability[];
  /** IDs of participants this person prefers NOT to be paired with (soft constraint) */
  notWithIds?: string[];
  /** Explicit participant-selected פק"לים (effective חורש is derived separately). */
  pakalIds?: string[];
  /** Task name the participant prefers to be assigned to (soft preference, matched against Task.sourceName) */
  preferredTaskName?: string;
  /** Task name the participant prefers NOT to be assigned to (soft preference, matched against Task.sourceName) */
  lessPreferredTaskName?: string;
  /** Soft-balancing weight on fair-share capacity. >1 protects (less work),
   *  <1 absorbs more. Default 1.0. Range 0.3–5.0. Does NOT affect hard
   *  constraints, real durations, rest gaps, or sleep-recovery windows. */
  workloadMultiplier?: number;
}

// ─── Capacity ────────────────────────────────────────────────────────────────

/**
 * Pre-computed capacity for a participant within a schedule window.
 * Used to scale "fair share" targets proportionally to availability.
 */
export interface ParticipantCapacity {
  /** Total available hours across the entire schedule window */
  totalAvailableHours: number;
  /** Available hours per operational day (keyed by YYYY-MM-DD via operationalDateKey) */
  dailyAvailableHours: Map<string, number>;
}

// ─── Task ────────────────────────────────────────────────────────────────────

/** Slot requirement within a task (e.g., "2x Level 0" is two slots) */
export interface SlotRequirement {
  /** Unique slot ID within the task */
  slotId: string;
  /** Acceptable levels for this slot (with optional priority annotation) */
  acceptableLevels: LevelEntry[];
  /** Required certifications for this slot */
  requiredCertifications: string[];
  /** Certifications that DISQUALIFY a participant from this slot */
  forbiddenCertifications?: string[];
  /** Optional: label for display purposes */
  label?: string;
  /** Display label inherited from sub-team name (for layout column headers) */
  subTeamLabel?: string;
  /** Generic sub-team identifier for togetherness grouping */
  subTeamId?: string;
}

export interface Task {
  id: string;
  /** Human-readable name */
  name: string;
  /** Original template/definition name — used for preference matching (not day-prefixed). */
  sourceName?: string;
  /** Time block for this task instance */
  timeBlock: TimeBlock;
  /** How many participants are required */
  requiredCount: number;
  /** Detailed slot requirements */
  slots: SlotRequirement[];
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
   */
  blocksConsecutive: boolean;
  /** Scheduling priority (0 = first). Lower = scheduled earlier in greedy phase. */
  schedulingPriority?: number;
  /** Whether "not with" togetherness preferences apply to this task */
  togethernessRelevant?: boolean;
  /** HC-14: Rest rule ID — when set, enforces a minimum gap between this and other tasks sharing a rest rule. */
  restRuleId?: string;
  /** HC-15: Sleep & Recovery rule propagated from the template. When set and the task's `shiftIndex` is in the rule's `triggerShifts`, a recovery window begins at task end. */
  sleepRecovery?: SleepRecoveryRule;
  /** 1-based shift index this task instance occupies. Recurring template shifts use 1..shiftsPerDay; one-time tasks always use 1. Read by HC-15 to decide whether to trigger a recovery window. */
  shiftIndex?: number;
  /**
   * Structural grouping key for the schedule board. Tasks sharing a key
   * render as one section (side-by-side columns). Computed at generation
   * time from the originating template's time footprint (or a unique key
   * for one-time / injected tasks so they never merge). See
   * `src/shared/layout-key.ts`. Optional for backward compatibility with
   * pre-schema snapshots and CLI fixtures; layout-engine falls back to
   * `sourceName` / `name` when absent.
   */
  sectionKey?: string;
  /** Display color propagated from template (hex, e.g. '#4A90D9'). */
  color?: string;
  /**
   * True for tasks injected post-generation — not backed by a live
   * template or OneTimeTask. Snapshot-only unless the user also saved it to
   * the store. Excluded from orphan detection.
   */
  injectedPostGeneration?: boolean;
  /**
   * Shift-splitting (slot-level). When an individual SLOT of a splittable
   * occurrence is realized as two halves, both halves carry the SAME
   * `splitGroupId` — which identifies the split SLOT pair as
   * `` `${originalTaskId}::${slotId}` `` (NOT the whole occurrence) — and
   * distinct `splitPart` (1 = first half, 2 = second). One occurrence may have
   * some slots whole and others split; two split slots of the same occurrence
   * get distinct `splitGroupId`s. HC-16 keys on `splitGroupId`, so the
   * two-different-people rule applies per split slot. Absent ⇒ a normal whole
   * task (today's exact path). Serializable; split state lives entirely here,
   * so frozen snapshots need no migration.
   */
  splitGroupId?: string;
  /** 1 = first half [start,mid], 2 = second half [mid,end]. Set iff `splitGroupId`. */
  splitPart?: 1 | 2;
  /** Original (pre-split) occurrence duration in ms. K for the run-coalescer. */
  splitOriginalMs?: number;
  /**
   * Original (pre-split) occurrence `Task.id`, set on every split half. Unlike
   * `splitGroupId` (per split SLOT), this is shared by ALL halves originating
   * from the same occurrence. Used by HC-15 to exempt same-occurrence work
   * from each other's recovery windows (a person legitimately holding two
   * halves of different slots of one occurrence is doing one continuous shift).
   * Absent ⇒ not a split half.
   */
  splitOccurrenceId?: string;
  /**
   * Set only when a `sameGroupRequired` occurrence is split: the residual
   * whole-slot task and every per-split-slot half originating from that
   * occurrence carry the same `sameGroupLinkId` (= the original occurrence
   * `Task.id`). HC-8 treats all tasks sharing a `sameGroupLinkId` as ONE
   * same-group unit (union bipartite matching, processed once) so the whole
   * occurrence — whole slots and both halves of every split slot — must come
   * from a single group. Absent ⇒ ordinary per-task HC-8.
   */
  sameGroupLinkId?: string;
  /**
   * EFFECTIVE splittability for this run: set at generation to
   * `template.splittable && (AlgorithmSettings.splittingMode !== 'off')`. The
   * optimizer may realize an unfillable occurrence with this `true` as two
   * halves. Absent/false ⇒ never split (today's behavior). Half-tasks inherit
   * it.
   */
  splittable?: boolean;
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

/**
 * Schedule-scoped temporary unavailability window for a participant.
 *
 * Unlike Participant.availability / Participant.dateUnavailability (master
 * data that belongs on the participant record), this is stored on the Schedule
 * snapshot: it applies only to the loaded schedule and is used by the Future
 * SOS flow to plan a multi-slot rescue when a participant becomes unavailable
 * for a future window.
 */
export interface ScheduleUnavailability {
  id: string;
  participantId: string;
  /** Absolute start — not recurring. */
  start: Date;
  /** Absolute end — not recurring. */
  end: Date;
  /** Optional note surfaced in UI (e.g. "מילואים"). */
  reason?: string;
  /** When the entry was created. */
  createdAt: Date;
  /** Live-mode anchor at creation time (audit). */
  anchorAtCreation: Date;
  /**
   * Swap count from the Future-SOS plan applied alongside this entry.
   * Zero when the entry was recorded without a replacement plan
   * (e.g., no overlapping assignments or user opted out of all). Undefined
   * on entries created before the field was introduced.
   */
  appliedSwapCount?: number;
}

/**
 * Mid-schedule capability change: a participant has lost one or more
 * certifications for a defined window. Snapshot-scoped — does not mutate
 * Participant master data. HC-2 (required certs) and HC-11 (forbidden certs)
 * read this as an additive override, treating the listed certs as absent
 * when the task's timeBlock overlaps the window.
 *
 * The participant remains otherwise eligible: they keep assignments that
 * don't require a lost cert, and the rescue planner may relocate them into
 * other open slots to keep workload balanced.
 */
export interface CapabilityLoss {
  id: string;
  participantId: string;
  /** Cert IDs that the participant is treated as not having for this window. */
  lostCertifications: string[];
  /** Absolute window start (effective from). */
  start: Date;
  /** Absolute window end. Use a far-future date to model "permanent" loss. */
  end: Date;
  /** Optional note surfaced in UI. */
  reason?: string;
  /** When the entry was created. */
  createdAt: Date;
  /** Live-mode anchor at creation time (audit). */
  anchorAtCreation: Date;
  /**
   * Swap count from the capability-change plan applied alongside this entry.
   * Undefined on entries recorded without a replacement plan.
   */
  appliedSwapCount?: number;
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
  /** How many optimizer attempts actually ran (may be less than requested on early termination) */
  actualAttempts?: number;
  /** Algorithm settings frozen at generation time (config, disabled HCs, dayStartHour). */
  algorithmSettings: AlgorithmSettings;
  /** Absolute calendar start of operational day 1. Frozen at generation. */
  periodStart: Date;
  /** Number of operational days (1..7) this schedule covers. Frozen at generation. */
  periodDays: number;
  /** Serialized rest-rule map (derived from templates at generation; frozen thereafter). */
  restRuleSnapshot: Record<string, number>;
  /** Certification id → label map, frozen at generation. Drives cert badges/tooltips. */
  certLabelSnapshot: Record<string, string>;
  /**
   * Future-SOS unavailability windows scoped to this snapshot.
   * HC-3 checks layer these on top of participant master-data availability
   * during validation and rescue planning. Treat `undefined` as `[]`.
   * Required in engine-produced schedules; optional on the type so test
   * fixtures and manually-authored literals can omit it.
   */
  scheduleUnavailability?: ScheduleUnavailability[];
  /**
   * Mid-schedule capability changes scoped to this snapshot. HC-2 / HC-11
   * layer these on top of participant master-data certifications. Treat
   * `undefined` as `[]`.
   */
  capabilityLoss?: CapabilityLoss[];
  /**
   * Previous-schedule context that was provided as continuity input at
   * generation time. Persisted on the frozen schedule so it can be displayed
   * post-generation as a virtual "Day 0" before Day 1.
   *
   * Read-only context — never affects period totals, fairness math, or
   * violations. Optional: legacy schedules generated before this field was
   * introduced load with `undefined` and simply have no Day 0.
   */
  continuitySnapshot?: ContinuitySnapshot;
}

export interface ScheduleScore {
  /** Minimum rest period across all participants (hours) — higher is better */
  minRestHours: number;
  /** Average rest period (hours) */
  avgRestHours: number;
  /** Standard deviation of effective workload hours — lower is fairer.
   *  (Despite living among the rest metrics, this is a WORKLOAD spread, not a
   *  rest gap; it is display-only and never enters the composite score.) */
  workloadStdDev: number;
  /** Sum of penalty points (low-priority level usage, preference mismatches, etc.) */
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
  /** Sum of √gap across every gap of every participant. Per-gap rest gradient
   *  that escapes the globalMin plateau: rises with any individual gap that
   *  grows, with diminishing returns from the concave shape. */
  restPerGapBonus: number;
  /** SC-6 low-priority level penalty contribution to totalPenalty.
   *  Optional so older serialized schedules deserialize cleanly. */
  lowPriorityPenalty?: number;
  /** SC-9 "not with" pair penalty contribution to totalPenalty.
   *  Optional so older serialized schedules deserialize cleanly. */
  notWithPenalty?: number;
  /** SC-10 task-name preference penalty contribution to totalPenalty.
   *  Optional so older serialized schedules deserialize cleanly. */
  taskPrefPenalty?: number;
  /** Shift-split penalty contribution (config.splitPenalty × split-occurrence
   *  count). Run-constant in v1. Optional so older schedules deserialize. */
  splitPenalty?: number;
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
  /** Weight for the per-gap rest gradient (Σ √gap across all participants).
   *  Complements minRestWeight, which only sees the worst gap; this term
   *  rewards every individual gap with diminishing returns. Set to 0 to
   *  disable cleanly. */
  restPerGapWeight: number;
  /** Weight for L0 fairness (negative std dev) — primary */
  l0FairnessWeight: number;
  /** Weight for senior (L2-L4) fairness — secondary */
  seniorFairnessWeight: number;

  /** Max solver iterations. Fixed operational parameter — intentionally NOT
   *  exposed as a UI slider and NOT an auto-tuner dimension (the tuner only
   *  scales it down per-phase for cheaper early rounds). */
  maxIterations: number;
  /** Max solver time (ms). Fixed operational parameter — see `maxIterations`. */
  maxSolverTimeMs: number;
  /** Penalty for assigning a participant to a slot where their level is marked lowPriority */
  lowPriorityLevelPenalty: number;
  /** Weight for daily workload balance (penalises busy-day / light-day spread) */
  dailyBalanceWeight: number;
  /** Penalty per "not with" pair violation in a togethernessRelevant task */
  notWithPenalty: number;
  /** Penalty when participant is NOT assigned to their preferred task name (per participant, once) */
  taskNamePreferencePenalty: number;
  /** Penalty when participant IS assigned to their less-preferred task name (per assignment) */
  taskNameAvoidancePenalty: number;
  /** Bonus (penalty reduction) per assignment to participant's preferred task name */
  taskNamePreferenceBonus: number;
  /** Penalty per split SLOT (one `#a`/`#b` pair). A REAL in-run optimizer
   *  cost: the structural-refine pass only commits a quality split when the
   *  composite gain strictly exceeds this, and merges a split back when it no
   *  longer earns it. Higher ⇒ the system splits a fillable shift only when
   *  the fairness/rest/balance gain clearly outweighs it. Tunable (auto-tuner
   *  dimension). Feasibility splits — filling an otherwise-empty slot worth
   *  UNFILLED_SLOT_PENALTY (50000) — stay hugely net-positive at any sane
   *  value and are never discouraged. */
  splitPenalty: number;
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  minRestWeight: 8,
  // 5 chosen empirically: in the symmetric 9P / 3-slot / 6-day no-restRule
  // scenario, drops <8h gaps from ~34/99 (default minRestWeight-only baseline)
  // to ~2/99 ≈ 95% reduction. Production schedules with HC-14 active see
  // negligible behavioral change because gaps are already ≥ 5h there. Higher
  // values (≥ 10) start to noticeably trade fairness for marginal rest gains.
  restPerGapWeight: 5,
  l0FairnessWeight: 111,
  seniorFairnessWeight: 1,

  maxIterations: 100000,
  maxSolverTimeMs: 30000,
  lowPriorityLevelPenalty: 1166,
  dailyBalanceWeight: 144,
  notWithPenalty: 1929,
  taskNamePreferencePenalty: 140,
  taskNameAvoidancePenalty: 27,
  taskNamePreferenceBonus: 7,
  // In-run quality gate. A quality split must buy more composite than this to
  // be committed; small relative to UNFILLED_SLOT_PENALTY (50000) so
  // feasibility splits remain hugely net-positive. The auto-tuner explores it
  // per dataset.
  //
  // Value re-tuned 2026-05-23 from 1000 → 1 after the full tuning sweep in
  // `src/bench-split-tuning` (3,362 runs · 17 splitPenalty values · 35
  // scenarios · 60 attempts/run · paired Mulberry32 seeds · 0 HC violations).
  // The previous default of 1000 was the worst value in the entire grid —
  // it produced mean paired Δcomposite = −10.1 vs OFF because no quality
  // splits ever committed at that height. sp=1 produces mean Δcomposite =
  // +1404 across the same 35 scenarios with ~20 quality splits/run.
  // See `tmp/split-bench-report.md` for the full sweep table.
  splitPenalty: 1,
};

// ─── Algorithm Settings (user-configurable control panel) ────────────────────

/** All hard constraint codes that can be toggled */
export type HardConstraintCode =
  | 'HC-1' // Level requirement
  | 'HC-2' // Certification requirement
  | 'HC-3' // Availability check
  | 'HC-4' // Same-group (Adanit)
  | 'HC-5' // No double-booking
  | 'HC-6' // Slots filled
  | 'HC-7' // Unique participant per task
  | 'HC-8' // Adanit feasibility
  | 'HC-11' // Forbidden certification (per-slot)
  | 'HC-12' // No consecutive high-load
  | 'HC-14' // Minimum category break (5h)
  | 'HC-15' // Sleep & recovery window after late/overnight tasks
  | 'HC-16'; // Split-sibling disjointness (two halves ⇒ two different people)

/** Full algorithm settings: weights + constraint toggles */
export interface AlgorithmSettings {
  /** All SchedulerConfig weight fields */
  config: SchedulerConfig;
  /** Hard constraints that are DISABLED (unchecked by user) */
  disabledHardConstraints: HardConstraintCode[];
  /** Hour (0-23) that defines the start of an operational "day". Default 5 (05:00). */
  dayStartHour: number;
  /**
   * Per-run shift-splitting mode. Three levels of control:
   *
   * - `'off'`: no shift-splitting. Templates marked `splittable` are never
   *   split. Stage-4 feasibility recovery is disabled; `structuralRefine` is
   *   inert via its identity fast-path.
   * - `'feasibility'`: splitting runs only to make schedules valid/complete.
   *   Stage-4 may split a slot to fill it; `structuralRefine`'s MERGE arm
   *   runs to collapse no-longer-needed splits whenever doing so doesn't
   *   make the schedule worse (non-strict gate). QUALITY-SPLIT is skipped.
   *   `splitPenalty` is treated as 0 internally for every scoring path.
   * - `'quality'`: splitting runs for both feasibility and quality. All three
   *   arms (Stage-4, MERGE, QUALITY-SPLIT) are active; `config.splitPenalty`
   *   is the economic gate for quality splits and the strict MERGE gate.
   *
   * Frozen onto the schedule like `disabledHardConstraints`. Default `'quality'`.
   */
  splittingMode?: 'off' | 'feasibility' | 'quality';
}

/** Human-readable labels for hard constraints */
export const HC_LABELS: Record<HardConstraintCode, string> = {
  'HC-1': 'דרישת דרגה',
  'HC-2': 'דרישת הסמכה',
  'HC-3': 'בדיקת זמינות',
  'HC-4': 'משימה משותפת (קבוצה אחידה)',
  'HC-5': 'ללא שיבוץ כפול',
  'HC-6': 'משבצות מלאות',
  'HC-7': 'משתתף ייחודי למשימה',
  'HC-8': 'כשירות קבוצה למשימות משותפות',
  'HC-11': 'הסמכה אסורה במשבצת',
  'HC-12': 'ללא עומס רצוף',
  'HC-14': 'הפסקה מינימלית בין משימות קטגוריה',
  'HC-15': 'השלמות שינה והתאוששות',
  'HC-16': 'פיצול משמרת — חצאים לאנשים שונים',
};

/** Build the HC-14 label (generic — rest rules are now per-rule). */
export function getHC14Label(): string {
  return 'הפסקה מינימלית בין משימות קטגוריה';
}

/** All hard constraint codes in display order */
export const ALL_HC_CODES: HardConstraintCode[] = [
  'HC-1',
  'HC-2',
  'HC-3',
  'HC-4',
  'HC-5',
  'HC-6',
  'HC-7',
  'HC-8',
  'HC-11',
  'HC-12',
  'HC-14',
  'HC-15',
  'HC-16',
];

/** Factory default algorithm settings */
export const DEFAULT_ALGORITHM_SETTINGS: AlgorithmSettings = {
  config: { ...DEFAULT_CONFIG },
  disabledHardConstraints: [],
  dayStartHour: 5,
  splittingMode: 'quality',
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
  description: 'הגדרות ברירת המחדל',
  settings: {
    ...DEFAULT_ALGORITHM_SETTINGS,
    config: { ...DEFAULT_CONFIG },
    disabledHardConstraints: [],
    dayStartHour: 5,
    splittingMode: 'quality',
  },
  builtIn: true,
  createdAt: 0,
};

// ─── Schedule Snapshots ──────────────────────────────────────────────────────

/** A named, saveable snapshot of a complete Schedule (algorithm settings are embedded in schedule). */
export interface ScheduleSnapshot {
  id: string;
  name: string;
  description: string;
  /** The full schedule state at the time of the snapshot (includes frozen algorithmSettings). */
  schedule: Schedule;
  /** If true the snapshot cannot be deleted or renamed */
  builtIn?: boolean;
  /** Epoch ms — used for ordering snapshots */
  createdAt: number;
}

// ─── Participant Sets ────────────────────────────────────────────────────────

/** Serialisable snapshot of a single participant + associated constraint data */
export interface ParticipantSnapshot {
  name: string;
  level: Level;
  certifications: string[];
  group: string;
  /** Recurring weekday unavailability rules (IDs stripped for stable comparison) */
  dateUnavailability: Omit<DateUnavailability, 'id'>[];
  /** IDs of participants this person prefers NOT to be paired with */
  notWithIds?: string[];
  /** Explicit participant-selected פק"לים (effective חורש is derived separately). */
  pakalIds?: string[];
  /** Task name the participant prefers to be assigned to (soft preference, matched against Task.sourceName) */
  preferredTaskName?: string;
  /** Task name the participant prefers NOT to be assigned to (soft preference, matched against Task.sourceName) */
  lessPreferredTaskName?: string;
  /** Soft-balancing weight on fair-share capacity. >1 protects (less work),
   *  <1 absorbs more. Default 1.0. Range 0.3–5.0. */
  workloadMultiplier?: number;
}

/** A named, saveable collection of participants */
export interface ParticipantSet {
  id: string;
  name: string;
  description: string;
  /** Full participant data at the time of the snapshot */
  participants: ParticipantSnapshot[];
  /** פק"ל catalog required to render the snapshot correctly. */
  pakalCatalog?: PakalDefinition[];
  /** Certification catalog required to render the snapshot correctly. */
  certificationCatalog: CertificationDefinition[];
  /** If true the set cannot be deleted or renamed */
  builtIn?: boolean;
  /** Epoch ms — used for ordering */
  createdAt: number;
}

/** A named rest rule for HC-14 minimum-gap enforcement between tasks. */
export interface RestRule {
  id: string;
  /** User-visible name (e.g. 'הפסקת לילה'). */
  label: string;
  /** Minimum gap in hours between tasks sharing this rule. */
  durationHours: number;
  /** Soft-delete tombstone — tasks referencing a deleted rule show an orphan warning. */
  deleted?: boolean;
}

/**
 * HC-15: Sleep & Recovery rule attached to a single task (template or one-time).
 *
 * If the task instance's shift index is in `triggerShifts`, a recovery window
 * starts at the task's end timestamp and lasts `recoveryHours` whole hours.
 * During that window the assigned participant may not take any other task that
 * has effective load > 0 at any instant overlapping the window. Tasks whose
 * effective load is 0 throughout the overlapping portion remain allowed.
 *
 * Shift indices are 1-based; one-time tasks have a single shift indexed 1.
 * Stale indices that exceed the task's current shiftsPerDay are ignored at
 * evaluation time.
 */
export interface SleepRecoveryRule {
  /** 1-based shift indices that trigger recovery. Must be non-empty when the rule is enabled. */
  triggerShifts: number[];
  /** Whole hours of recovery window starting at the task's end timestamp. Must be in [1, 48]. */
  recoveryHours: number;
}

/** A named, saveable collection of task templates */
export interface TaskSet {
  id: string;
  name: string;
  description: string;
  /** Full task template data at the time of the snapshot */
  templates: TaskTemplate[];
  /** One-time task definitions included in this set. */
  oneTimeTasks: OneTimeTask[];
  /** If true the set cannot be deleted or renamed */
  builtIn?: boolean;
  /** Named rest rules for HC-14 minimum-gap enforcement. */
  restRules: RestRule[];
  /** Epoch ms — used for ordering */
  createdAt: number;
}

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
  taskName: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: AssignmentStatus;
  /** True when the underlying task contributes zero effective hours. Drives the dimmed visual style. */
  isZeroLoad: boolean;
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

// ─── Stage 0: Configuration Types ───────────────────────────────────────────

/** A single slot template inside a TaskTemplate */
export interface SlotTemplate {
  id: string;
  label: string;
  acceptableLevels: LevelEntry[];
  requiredCertifications: string[];
  /** Certifications that DISQUALIFY a participant from this slot */
  forbiddenCertifications?: string[];
}

/** Time-of-day load window with explicit weight (0..1). */
export interface LoadWindow {
  id: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  weight: number;
  /**
   * HC-12 per-window opt-in. When the parent task has `blocksConsecutive=false`,
   * a window whose interval covers a task boundary instant (start or end)
   * causes that boundary to block iff this flag is true. Ignored when the
   * task-level `blocksConsecutive=true` (which is absolute and unconditional).
   * Treated as `false` when missing.
   */
  blocksAtBoundary?: boolean;
  /** Optional comparison formula that derived `weight`. Input-layer only. */
  loadFormula?: LoadFormula;
}

/** Reference to a rate on another TaskTemplate: either its base or a specific window. */
export type LoadFormulaRateRef = { kind: 'base' } | { kind: 'window'; windowId: string };

/** One component of a comparison formula: N hours of referenced rate. */
export interface LoadFormulaComponent {
  refTemplateId: string;
  refRate: LoadFormulaRateRef;
  hours: number;
}

/** Frozen snapshot of a referenced rate at formula save time. */
export interface LoadFormulaSnapshotEntry {
  templateId: string;
  templateName: string;
  rate: { kind: 'base'; value: number } | { kind: 'window'; windowId: string; windowLabel: string; value: number };
  missing?: boolean;
  /**
   * Whether the referenced template had any hot windows at snapshot time.
   * Used to warn when the ref task *gained* hot windows after the formula was saved
   * (so the previously-unambiguous "base" now needs disambiguation).
   * Optional for backward compatibility with pre-field snapshots.
   */
  refHadLoadWindows?: boolean;
}

/**
 * Comparison-based definition of a per-hour load value (0..1).
 * Lives on TaskTemplate (for baseLoadWeight) or LoadWindow (for window.weight).
 * Never copied onto Task instances — this is an input-layer construct.
 */
export interface LoadFormula {
  /** Right-hand side: "X hours of THIS + sum(lhsExtras) = sum(components)". */
  components: LoadFormulaComponent[];
  /** Index-aligned with `components` (the RHS). */
  snapshot: LoadFormulaSnapshotEntry[];
  /** Clamped [0..1]; equals the sibling numeric field. */
  computedValue: number;
  /** ms since epoch. */
  computedAt: number;
  /**
   * How many hours of the target task the equation expresses.
   * Per-hour engine value = (rhs raw sum − lhs extras raw sum) / targetHours, clamped to [0..1].
   * Default 1.
   */
  targetHours?: number;
  /**
   * Extra LHS terms beyond the target task's X hours. Each contributes
   * `hours × rate` that is SUBTRACTED from the RHS raw sum before dividing by targetHours.
   */
  lhsExtras?: LoadFormulaComponent[];
  /** Index-aligned with `lhsExtras`. */
  lhsExtrasSnapshot?: LoadFormulaSnapshotEntry[];
}

/** A sub-team definition within a task template */
export interface SubTeamTemplate {
  id: string;
  name: string;
  slots: SlotTemplate[];
}

/** A reusable task rule/template defining how a task is configured */
export interface TaskTemplate {
  id: string;
  name: string;
  /** Duration in hours */
  durationHours: number;
  /** How many shifts per day (e.g., 3 for Adanit) */
  shiftsPerDay: number;
  /** First shift start hour */
  startHour: number;
  /** Whether all participants must be from the same group */
  sameGroupRequired: boolean;
  /** Base load weight outside hot windows (0..1). */
  baseLoadWeight?: number;
  /** Optional comparison formula that derived `baseLoadWeight`. Input-layer only. */
  loadFormula?: LoadFormula;
  /** Optional weighted windows (typically "hot" windows). */
  loadWindows?: LoadWindow[];
  /**
   * HC-12 consecutive-task blocking flag.
   * When true, this task prohibits back-to-back placement with another
   * blocksConsecutive task. Required — callers must set this explicitly.
   */
  blocksConsecutive: boolean;
  /** Sub-teams (each has its own slots). If empty, slots are top-level */
  subTeams: SubTeamTemplate[];
  /** Top-level slots (used when there are no sub-teams) */
  slots: SlotTemplate[];
  /** Scheduling priority (0 = first). If unset, computed from task constraints. */
  schedulingPriority?: number;
  /** Whether "not with" togetherness preferences apply to this task template */
  togethernessRelevant?: boolean;
  /** HC-14: Rest rule ID — when set, enforces a minimum gap between this and other tasks sharing a rest rule. */
  restRuleId?: string;
  /** HC-15: Sleep & Recovery rule. At most one per template. */
  sleepRecovery?: SleepRecoveryRule;
  /** Display color for UI rendering (hex, e.g. '#4A90D9'). Auto-assigned if unset. */
  color?: string;
  /** Display ordering within the schedule grid. Lower = earlier (rightmost in RTL). */
  displayOrder?: number;
  /**
   * Shift-splitting opt-in. When true AND the per-run
   * `AlgorithmSettings.splittingMode !== 'off'`, the optimizer may realize an
   * unfillable occurrence of this template as two equal halves worked by two
   * different participants. Independent of `blocksConsecutive`. Default false.
   */
  splittable?: boolean;
}

// ─── One-Time Task Definition ───────────────────────────────────────────────

/** A user-defined task that occurs exactly once at a specific date and time. */
export interface OneTimeTask {
  id: string;
  name: string;
  /** Calendar date this task occurs on (only year/month/day matter). */
  scheduledDate: Date;
  /** Start hour (0-23) on the scheduled date. */
  startHour: number;
  /** Start minute (0-59). Defaults to 0. */
  startMinute: number;
  /** Duration in hours. */
  durationHours: number;
  /** Sub-teams (each has its own slots). If empty, slots are top-level. */
  subTeams: SubTeamTemplate[];
  /** Top-level slots (used when there are no sub-teams). */
  slots: SlotTemplate[];
  /** Whether all participants must be from the same group. */
  sameGroupRequired: boolean;
  /** Base load weight outside hot windows (0..1). */
  baseLoadWeight?: number;
  /** Optional weighted windows (typically "hot" windows). */
  loadWindows?: LoadWindow[];
  /** HC-12 consecutive-task blocking flag. Required — callers must set explicitly. */
  blocksConsecutive: boolean;
  /** Scheduling priority (0 = first). */
  schedulingPriority?: number;
  /** Whether "not with" togetherness preferences apply. */
  togethernessRelevant?: boolean;
  /** HC-14: Rest rule ID — when set, enforces a minimum gap between this and other tasks sharing a rest rule. */
  restRuleId?: string;
  /** HC-15: Sleep & Recovery rule. At most one per one-time task. */
  sleepRecovery?: SleepRecoveryRule;
  /** Display color for UI rendering (hex, e.g. '#4A90D9'). Auto-assigned if unset. */
  color?: string;
  /** Display ordering within the schedule grid. Lower = earlier (rightmost in RTL). */
  displayOrder?: number;
  /** Custom notes / description. */
  description?: string;
  /**
   * Shift-splitting opt-in. When true AND the per-run
   * `AlgorithmSettings.splittingMode !== 'off'`, the optimizer may realize an
   * unfillable slot of this one-time task as two equal halves worked by two
   * different participants. Independent of `blocksConsecutive`. Default false.
   */
  splittable?: boolean;
}

// ─── Multi-Day Schedule Types ────────────────────────────────────────────────

/** Week-long schedule configuration */
export interface WeekConfig {
  /** Start date of the schedule window */
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

/**
 * A single split-fill operation: realize one slot of a splittable occurrence
 * as two half-tasks staffed by two different participants.
 *
 * Produced by dynamic-replacement flows (rescue / FSOS / inject / cap-change)
 * when no clean single-person fill exists and the parent task is `splittable`,
 * and by the manual-build split picker (the only flow that may pass a null
 * `originalAssignmentId` to split a still-empty slot from scratch).
 * Mirrors the identity model the optimizer's Stage-4/Phase-2 splits use:
 * applying a SplitOp replaces the parent Task in `schedule.tasks` with
 * `#a`/`#b` halves (plus a residual when other slots remain whole), removes
 * the original Assignment (when present), and inserts two new half-Assignments.
 */
export interface SplitOp {
  kind: 'split';
  /** Original occurrence id (the parent Task being split). */
  taskId: string;
  /** Original slot id being split. */
  slotId: string;
  /** Human-readable task name (for plan-step rendering). */
  taskName: string;
  /** Human-readable slot label (for plan-step rendering). */
  slotLabel: string;
  /**
   * The assignment being replaced (vacated or inject placeholder). `null`
   * when the slot was empty before the split (manual-build flow only).
   */
  originalAssignmentId: string | null;
  /** Participant the original assignment held (null for inject placeholders / empty slots). */
  originalParticipantId: string | null;
  /** Absolute timestamp of the midpoint; floor((endMs − startMs) / 2) added to start. */
  midpointMs: number;
  /** Staff for the first half (start → midpoint). */
  fillA: { participantId: string; displayName: string };
  /** Staff for the second half (midpoint → end). HC-16 requires fillA.id !== fillB.id. */
  fillB: { participantId: string; displayName: string };
  /** Set for `sameGroupRequired` parent tasks: both halves must come from this group. */
  groupLock?: string;
  /**
   * Set when the parent task has `sameGroupRequired === true`. The new halves
   * are stamped with this id so HC-8's link-union treats them as one unit
   * together with any remaining link siblings/residual. Equals the parent's
   * existing `sameGroupLinkId` when one is present, otherwise the parent
   * occurrence id.
   */
  sameGroupLinkId?: string;
}

/** A single rescue plan (one of 3 presented to the user) */
export interface RescuePlan {
  id: string;
  /** Display rank within the page (1, 2, 3) */
  rank: number;
  /** Chain of swaps required to implement this plan */
  swaps: RescueSwap[];
  /**
   * Split-fill ops required to implement this plan. Present when the planner
   * chose to realize a slot as two halves rather than re-staff it whole.
   * Plans are mono-kind (either `swaps.length>0` and `splitOps` absent, OR
   * `splitOps.length>0` and `swaps.length===0`) EXCEPT the terminal-split
   * feasibility fallback (see `terminalSplit`), which carries `swaps.length>=1`
   * AND `splitOps.length===1` — a swap chain whose terminal displaced donor is
   * backfilled by a split. The swap and split target disjoint assignment ids.
   */
  splitOps?: SplitOp[];
  /** Composite impact score (lower = less disruption).
   *  When full scoring is active this is the negated composite delta;
   *  otherwise it is the legacy workload-delta formula. */
  impactScore: number;
  /** Composite score delta: candidateComposite - baselineComposite (positive = improvement).
   *  Present only when full soft-constraint scoring is active. */
  compositeDelta?: number;
  /** Constraint violations that would exist after applying this plan */
  violations: ConstraintViolation[];
  /** When set, this plan was produced by a deep-chain fallback (depth 4+).
   *  Only populated when depth 1..3 returned zero valid plans. The UI uses
   *  this to render a "deep chain" warning banner. */
  fallbackDepth?: number;
  /** When true, this is a terminal chain-internal split plan: a swap chain plus
   *  a split of the chain's terminal displaced donor task. Produced only by the
   *  zero-valid-plans feasibility fallback (after depths 1..4 yield nothing).
   *  The UI renders a distinct "chain + split, last resort" warning. */
  terminalSplit?: boolean;
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
  /** Related one-time task ID */
  oneTimeTaskId?: string;
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

// ─── Data Transfer (Export / Import) ────────────────────────────────────────

export type ExportType = 'algorithm' | 'taskSet' | 'participantSet' | 'scheduleSnapshot' | 'fullBackup';

/** Unified envelope for every GardenManager export file. */
export interface GardenManagerExport {
  _format: 'gardenmanager-export';
  schemaVersion: 1;
  exportedAt: string;
  exportType: ExportType;
  payload:
    | AlgorithmExportPayload
    | TaskSetExportPayload
    | ParticipantSetExportPayload
    | ScheduleSnapshotExportPayload
    | FullBackupPayload;
}

export interface AlgorithmExportPayload {
  currentSettings: AlgorithmSettings;
  presets: AlgorithmPreset[];
  activePresetId: string | null;
}

export interface TaskSetExportPayload {
  taskSet: TaskSet;
}

export interface ParticipantSetExportPayload {
  participantSet: ParticipantSet;
}

export interface ScheduleSnapshotExportPayload {
  snapshot: ScheduleSnapshot;
  certificationCatalog: CertificationDefinition[];
  pakalCatalog: PakalDefinition[];
}

export interface FullBackupPayload {
  storageEntries: Record<string, string>;
}

export interface ImportValidationResult {
  ok: boolean;
  exportType?: ExportType;
  summary?: string;
  error?: string;
}

export interface ImportResult {
  ok: boolean;
  error?: string;
}
