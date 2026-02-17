/**
 * Resource Scheduling Engine - Main Entry Point
 *
 * Re-exports all public API surface for consumers.
 */

// ─── Models ──────────────────────────────────────────────────────────────────
export {
  Level,
  Certification,
  TaskType,
  AssignmentStatus,
  ViolationSeverity,
  AdanitTeam,
  PreflightSeverity,
  DEFAULT_CONFIG,
} from './models/types';

export type {
  TimeBlock,
  AvailabilityWindow,
  DateUnavailability,
  Participant,
  SlotRequirement,
  Task,
  Assignment,
  Schedule,
  ScheduleScore,
  ConstraintViolation,
  ValidationResult,
  SchedulerConfig,
  GanttRow,
  GanttBlock,
  GanttData,
  SwapRequest,
  ReScheduleRequest,
  BlackoutPeriod,
  SlotTemplate,
  SubTeamTemplate,
  TaskTemplate,
  PreflightFinding,
  PreflightResult,
  WeekConfig,
} from './models/types';

// ─── Engine ──────────────────────────────────────────────────────────────────
export { SchedulingEngine } from './engine/scheduler';

// ─── Optimizer ───────────────────────────────────────────────────────────────
export { optimize, greedyAssign, localSearchOptimize, optimizeMultiAttempt, optimizeMultiAttemptAsync } from './engine/optimizer';
export type { OptimizationResult, MultiAttemptProgressCallback } from './engine/optimizer';

// ─── Validator ───────────────────────────────────────────────────────────────
export { fullValidate, previewSwap, getEligibleParticipantsForSlot } from './engine/validator';
export type { FullValidationResult } from './engine/validator';

// ─── Constraints ─────────────────────────────────────────────────────────────
export { validateHardConstraints } from './constraints/hard-constraints';
export { computeScheduleScore, collectSoftWarnings } from './constraints/soft-constraints';

// ─── Task Definitions ────────────────────────────────────────────────────────
export {
  createAdanitTasks,
  createHamamaTask,
  createShemeshTask,
  createMamteraTask,
  createKarovTask,
  createKarovitTask,
  createArugaTask,
  generateDailyTasks,
  generateWeeklyTasks,
} from './tasks/task-definitions';

// ─── Utilities ───────────────────────────────────────────────────────────────
export {
  createTimeBlock,
  createTimeBlockFromHours,
  blockDurationMinutes,
  blockDurationHours,
  blocksOverlap,
  isFullyCovered,
  gapMinutes,
  gapHours,
  sortBlocksByStart,
  mergeBlocks,
  formatBlock,
  getTimelineBounds,
  generateShiftBlocks,
} from './web/utils/time-utils';

export {
  computeParticipantRest,
  computeAllRestProfiles,
  computeRestFairness,
} from './web/utils/rest-calculator';
export type { ParticipantRestProfile } from './web/utils/rest-calculator';

// ─── UI Bridge ───────────────────────────────────────────────────────────────
export {
  scheduleToGantt,
  ganttToAscii,
  exportGanttJson,
  buildTaskSummary,
} from './ui/gantt-bridge';
