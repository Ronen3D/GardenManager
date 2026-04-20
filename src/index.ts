/*
 *   ___  ___  __   __  ___  ___  ___   __  _  _     __  __  __   __   __   ___  ___  __
 *  / __||   \ \ \ / / | __|| _ \/ __| |  \| |/ |   |  \/  ||  \ |  \ \  \ | __|| __||  \
 * | (_ || |) | \ V /  | _| |   /\__ \ | |    <    | |\/| || |) || |) | __ \| _| | _| | |_|
 *  \___||___/   |_|   |___||_|_\|___/ |_|\__|_|   |_|  |_||___/ |___/ |__/ |___|  \___/|__|
 *
 *        ___
 *       (o o)    <-- No helmet! Face to the wind!
 *      [|   |]
 *      [ | | ]  ⚔
 *       /   \
 *      /     \
 *
 *   "Scheduling tasks since the dawn of garden time."
 */

/**
 * Resource Scheduling Engine - Main Entry Point
 *
 * Re-exports all public API surface for consumers.
 */

// ─── Constraints ─────────────────────────────────────────────────────────────
export { validateHardConstraints } from './constraints/hard-constraints';
export {
  computeLowPriorityLevelPenalty,
  isNaturalRole,
} from './constraints/senior-policy';
export { collectSoftWarnings, computeScheduleScore } from './constraints/soft-constraints';
export type { MultiAttemptProgressCallback, OptimizationResult } from './engine/optimizer';
// ─── Optimizer ───────────────────────────────────────────────────────────────
export {
  greedyAssign,
  localSearchOptimize,
  optimize,
  optimizeMultiAttempt,
  optimizeMultiAttemptAsync,
} from './engine/optimizer';
// ─── Rescue Engine (Live Mode) ───────────────────────────────────────────────
export { generateRescuePlans } from './engine/rescue';
// ─── Engine ──────────────────────────────────────────────────────────────────
export { SchedulingEngine } from './engine/scheduler';
// ─── Temporal Engine (Live Mode) ─────────────────────────────────────────────
export {
  freezeAssignments,
  getAnchorDayIndex,
  getFutureWindow,
  isDayFrozen,
  isDayPartiallyFrozen,
  isFutureTask,
  isInProgressTask,
  isModifiableAssignment,
  isPastTask,
  unfreezeAll,
} from './engine/temporal';
export type { FullValidationResult, RejectionCode } from './engine/validator';
// ─── Validator ───────────────────────────────────────────────────────────────
export {
  fullValidate,
  getEligibleParticipantsForSlot,
  getRejectionReason,
  isEligible,
  previewSwap,
} from './engine/validator';
export type {
  AlgorithmSettings,
  Assignment,
  AvailabilityWindow,
  CertificationDefinition,
  ConstraintViolation,
  DateUnavailability,
  GanttBlock,
  GanttData,
  GanttRow,
  LiveModeState,
  OneTimeTask,
  Participant,
  ParticipantCapacity,
  PreflightFinding,
  PreflightResult,
  ReScheduleRequest,
  RescuePlan,
  RescueRequest,
  RescueResult,
  RescueSwap,
  Schedule,
  SchedulerConfig,
  ScheduleScore,
  ScheduleSnapshot,
  SlotRequirement,
  SlotTemplate,
  SubTeamTemplate,
  SwapRequest,
  Task,
  TaskTemplate,
  TimeBlock,
  ValidationResult,
  WeekConfig,
} from './models/types';
// ─── Models ──────────────────────────────────────────────────────────────────
export {
  AssignmentStatus,
  DEFAULT_CERTIFICATION_DEFINITIONS,
  DEFAULT_CONFIG,
  Level,
  PreflightSeverity,
  ViolationSeverity,
} from './models/types';
// ─── UI Bridge ───────────────────────────────────────────────────────────────
export {
  buildTaskSummary,
  exportGanttJson,
  ganttToAscii,
  scheduleToGantt,
} from './ui/gantt-bridge';
export {
  computeAllCapacities,
  computeParticipantCapacity,
} from './utils/capacity';
export type { ParticipantRestProfile } from './shared/utils/rest-calculator';
export {
  computeAllRestProfiles,
  computeParticipantRest,
  computeRestFairness,
} from './shared/utils/rest-calculator';
// ─── Utilities ───────────────────────────────────────────────────────────────
export {
  blockDurationHours,
  blockDurationMinutes,
  blocksOverlap,
  createTimeBlock,
  createTimeBlockFromHours,
  formatBlock,
  gapHours,
  gapMinutes,
  generateShiftBlocks,
  getTimelineBounds,
  isFullyCovered,
  mergeBlocks,
  sortBlocksByStart,
} from './shared/utils/time-utils';
