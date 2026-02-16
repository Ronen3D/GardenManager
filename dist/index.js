"use strict";
/**
 * Resource Scheduling Engine - Main Entry Point
 *
 * Re-exports all public API surface for consumers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskSummary = exports.exportGanttJson = exports.ganttToAscii = exports.scheduleToGantt = exports.computeRestFairness = exports.computeAllRestProfiles = exports.computeParticipantRest = exports.generateShiftBlocks = exports.getTimelineBounds = exports.formatBlock = exports.mergeBlocks = exports.sortBlocksByStart = exports.gapHours = exports.gapMinutes = exports.isFullyCovered = exports.blocksOverlap = exports.blockDurationHours = exports.blockDurationMinutes = exports.createTimeBlockFromHours = exports.createTimeBlock = exports.generateDailyTasks = exports.createArugaTask = exports.createKarovitTask = exports.createKarovTask = exports.createMamteraTask = exports.createShemeshTask = exports.createHamamaTask = exports.createAdanitTasks = exports.collectSoftWarnings = exports.computeScheduleScore = exports.validateHardConstraints = exports.getEligibleParticipantsForSlot = exports.previewSwap = exports.fullValidate = exports.localSearchOptimize = exports.greedyAssign = exports.optimize = exports.SchedulingEngine = exports.DEFAULT_CONFIG = exports.AdanitTeam = exports.ViolationSeverity = exports.AssignmentStatus = exports.TaskType = exports.Certification = exports.Level = void 0;
// ─── Models ──────────────────────────────────────────────────────────────────
var types_1 = require("./models/types");
Object.defineProperty(exports, "Level", { enumerable: true, get: function () { return types_1.Level; } });
Object.defineProperty(exports, "Certification", { enumerable: true, get: function () { return types_1.Certification; } });
Object.defineProperty(exports, "TaskType", { enumerable: true, get: function () { return types_1.TaskType; } });
Object.defineProperty(exports, "AssignmentStatus", { enumerable: true, get: function () { return types_1.AssignmentStatus; } });
Object.defineProperty(exports, "ViolationSeverity", { enumerable: true, get: function () { return types_1.ViolationSeverity; } });
Object.defineProperty(exports, "AdanitTeam", { enumerable: true, get: function () { return types_1.AdanitTeam; } });
Object.defineProperty(exports, "DEFAULT_CONFIG", { enumerable: true, get: function () { return types_1.DEFAULT_CONFIG; } });
// ─── Engine ──────────────────────────────────────────────────────────────────
var scheduler_1 = require("./engine/scheduler");
Object.defineProperty(exports, "SchedulingEngine", { enumerable: true, get: function () { return scheduler_1.SchedulingEngine; } });
// ─── Optimizer ───────────────────────────────────────────────────────────────
var optimizer_1 = require("./engine/optimizer");
Object.defineProperty(exports, "optimize", { enumerable: true, get: function () { return optimizer_1.optimize; } });
Object.defineProperty(exports, "greedyAssign", { enumerable: true, get: function () { return optimizer_1.greedyAssign; } });
Object.defineProperty(exports, "localSearchOptimize", { enumerable: true, get: function () { return optimizer_1.localSearchOptimize; } });
// ─── Validator ───────────────────────────────────────────────────────────────
var validator_1 = require("./engine/validator");
Object.defineProperty(exports, "fullValidate", { enumerable: true, get: function () { return validator_1.fullValidate; } });
Object.defineProperty(exports, "previewSwap", { enumerable: true, get: function () { return validator_1.previewSwap; } });
Object.defineProperty(exports, "getEligibleParticipantsForSlot", { enumerable: true, get: function () { return validator_1.getEligibleParticipantsForSlot; } });
// ─── Constraints ─────────────────────────────────────────────────────────────
var hard_constraints_1 = require("./constraints/hard-constraints");
Object.defineProperty(exports, "validateHardConstraints", { enumerable: true, get: function () { return hard_constraints_1.validateHardConstraints; } });
var soft_constraints_1 = require("./constraints/soft-constraints");
Object.defineProperty(exports, "computeScheduleScore", { enumerable: true, get: function () { return soft_constraints_1.computeScheduleScore; } });
Object.defineProperty(exports, "collectSoftWarnings", { enumerable: true, get: function () { return soft_constraints_1.collectSoftWarnings; } });
// ─── Task Definitions ────────────────────────────────────────────────────────
var task_definitions_1 = require("./tasks/task-definitions");
Object.defineProperty(exports, "createAdanitTasks", { enumerable: true, get: function () { return task_definitions_1.createAdanitTasks; } });
Object.defineProperty(exports, "createHamamaTask", { enumerable: true, get: function () { return task_definitions_1.createHamamaTask; } });
Object.defineProperty(exports, "createShemeshTask", { enumerable: true, get: function () { return task_definitions_1.createShemeshTask; } });
Object.defineProperty(exports, "createMamteraTask", { enumerable: true, get: function () { return task_definitions_1.createMamteraTask; } });
Object.defineProperty(exports, "createKarovTask", { enumerable: true, get: function () { return task_definitions_1.createKarovTask; } });
Object.defineProperty(exports, "createKarovitTask", { enumerable: true, get: function () { return task_definitions_1.createKarovitTask; } });
Object.defineProperty(exports, "createArugaTask", { enumerable: true, get: function () { return task_definitions_1.createArugaTask; } });
Object.defineProperty(exports, "generateDailyTasks", { enumerable: true, get: function () { return task_definitions_1.generateDailyTasks; } });
// ─── Utilities ───────────────────────────────────────────────────────────────
var time_utils_1 = require("./utils/time-utils");
Object.defineProperty(exports, "createTimeBlock", { enumerable: true, get: function () { return time_utils_1.createTimeBlock; } });
Object.defineProperty(exports, "createTimeBlockFromHours", { enumerable: true, get: function () { return time_utils_1.createTimeBlockFromHours; } });
Object.defineProperty(exports, "blockDurationMinutes", { enumerable: true, get: function () { return time_utils_1.blockDurationMinutes; } });
Object.defineProperty(exports, "blockDurationHours", { enumerable: true, get: function () { return time_utils_1.blockDurationHours; } });
Object.defineProperty(exports, "blocksOverlap", { enumerable: true, get: function () { return time_utils_1.blocksOverlap; } });
Object.defineProperty(exports, "isFullyCovered", { enumerable: true, get: function () { return time_utils_1.isFullyCovered; } });
Object.defineProperty(exports, "gapMinutes", { enumerable: true, get: function () { return time_utils_1.gapMinutes; } });
Object.defineProperty(exports, "gapHours", { enumerable: true, get: function () { return time_utils_1.gapHours; } });
Object.defineProperty(exports, "sortBlocksByStart", { enumerable: true, get: function () { return time_utils_1.sortBlocksByStart; } });
Object.defineProperty(exports, "mergeBlocks", { enumerable: true, get: function () { return time_utils_1.mergeBlocks; } });
Object.defineProperty(exports, "formatBlock", { enumerable: true, get: function () { return time_utils_1.formatBlock; } });
Object.defineProperty(exports, "getTimelineBounds", { enumerable: true, get: function () { return time_utils_1.getTimelineBounds; } });
Object.defineProperty(exports, "generateShiftBlocks", { enumerable: true, get: function () { return time_utils_1.generateShiftBlocks; } });
var rest_calculator_1 = require("./utils/rest-calculator");
Object.defineProperty(exports, "computeParticipantRest", { enumerable: true, get: function () { return rest_calculator_1.computeParticipantRest; } });
Object.defineProperty(exports, "computeAllRestProfiles", { enumerable: true, get: function () { return rest_calculator_1.computeAllRestProfiles; } });
Object.defineProperty(exports, "computeRestFairness", { enumerable: true, get: function () { return rest_calculator_1.computeRestFairness; } });
// ─── UI Bridge ───────────────────────────────────────────────────────────────
var gantt_bridge_1 = require("./ui/gantt-bridge");
Object.defineProperty(exports, "scheduleToGantt", { enumerable: true, get: function () { return gantt_bridge_1.scheduleToGantt; } });
Object.defineProperty(exports, "ganttToAscii", { enumerable: true, get: function () { return gantt_bridge_1.ganttToAscii; } });
Object.defineProperty(exports, "exportGanttJson", { enumerable: true, get: function () { return gantt_bridge_1.exportGanttJson; } });
Object.defineProperty(exports, "buildTaskSummary", { enumerable: true, get: function () { return gantt_bridge_1.buildTaskSummary; } });
//# sourceMappingURL=index.js.map