"use strict";
/**
 * Resource Scheduling Engine - Core Type Definitions
 *
 * All TypeScript interfaces, enums, and type aliases for the scheduling system.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG = exports.AdanitTeam = exports.ViolationSeverity = exports.AssignmentStatus = exports.TaskType = exports.Certification = exports.Level = void 0;
// ─── Enums ───────────────────────────────────────────────────────────────────
/** Participant qualification levels */
var Level;
(function (Level) {
    Level[Level["L0"] = 0] = "L0";
    Level[Level["L1"] = 1] = "L1";
    Level[Level["L2"] = 2] = "L2";
    Level[Level["L3"] = 3] = "L3";
    Level[Level["L4"] = 4] = "L4";
})(Level || (exports.Level = Level = {}));
/** Certification types a participant can hold */
var Certification;
(function (Certification) {
    Certification["Nitzan"] = "Nitzan";
    Certification["Salsala"] = "Salsala";
    Certification["Hamama"] = "Hamama";
})(Certification || (exports.Certification = Certification = {}));
/** Task type identifiers */
var TaskType;
(function (TaskType) {
    TaskType["Adanit"] = "Adanit";
    TaskType["Hamama"] = "Hamama";
    TaskType["Shemesh"] = "Shemesh";
    TaskType["Mamtera"] = "Mamtera";
    TaskType["Karov"] = "Karov";
    TaskType["Karovit"] = "Karovit";
    TaskType["Aruga"] = "Aruga";
})(TaskType || (exports.TaskType = TaskType = {}));
/** Assignment status */
var AssignmentStatus;
(function (AssignmentStatus) {
    AssignmentStatus["Scheduled"] = "Scheduled";
    AssignmentStatus["Locked"] = "Locked";
    AssignmentStatus["Manual"] = "Manual";
    AssignmentStatus["Conflict"] = "Conflict";
})(AssignmentStatus || (exports.AssignmentStatus = AssignmentStatus = {}));
/** Severity for constraint violations */
var ViolationSeverity;
(function (ViolationSeverity) {
    ViolationSeverity["Error"] = "Error";
    ViolationSeverity["Warning"] = "Warning";
})(ViolationSeverity || (exports.ViolationSeverity = ViolationSeverity = {}));
/** Adanit team designation */
var AdanitTeam;
(function (AdanitTeam) {
    AdanitTeam["SegolMain"] = "SegolMain";
    AdanitTeam["SegolSecondary"] = "SegolSecondary";
})(AdanitTeam || (exports.AdanitTeam = AdanitTeam = {}));
exports.DEFAULT_CONFIG = {
    minRestWeight: 10,
    fairnessWeight: 5,
    penaltyWeight: 8,
    bonusWeight: 3,
    hamamaL3Penalty: 50,
    hamamaL4Penalty: 200,
    shemeshSameGroupBonus: 10,
    maxIterations: 5000,
    maxSolverTimeMs: 30000,
};
//# sourceMappingURL=types.js.map