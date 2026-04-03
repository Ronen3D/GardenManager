/**
 * Demo Script — Runs the full scheduling pipeline with sample data.
 *
 * Usage: npm run demo
 */

import {
  SchedulingEngine,
  Participant,
  Level,
  Certification,
  ViolationSeverity,
} from './index';
import { generateDailyTasks } from './tasks/cli-task-factory';
import { scheduleToGantt, ganttToAscii, buildTaskSummary } from './ui/gantt-bridge';
import { computeAllRestProfiles, computeRestFairness } from './web/utils/rest-calculator';

// ─── Sample Participants ─────────────────────────────────────────────────────

const BASE_DATE = new Date(2026, 1, 15); // Feb 15, 2026
const DAY_START = new Date(2026, 1, 15, 0, 0);
const DAY_END = new Date(2026, 1, 16, 12, 0); // Extend to cover overnight tasks

/** Helper to create a participant with full-day availability */
function createP(
  id: string,
  name: string,
  level: Level,
  certs: Certification[],
  group: string,
): Participant {
  return {
    id,
    name,
    level,
    certifications: certs,
    group,
    availability: [{ start: DAY_START, end: DAY_END }],
    dateUnavailability: [],
  };
}

// Group Alpha (8+ members for Adanit)
const groupAlpha: Participant[] = [
  createP('a1', 'Alpha-01', Level.L0, [Certification.Nitzan], 'Alpha'),
  createP('a2', 'Alpha-02', Level.L0, [Certification.Salsala], 'Alpha'),
  createP('a3', 'Alpha-03', Level.L0, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a4', 'Alpha-04', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a5', 'Alpha-05', Level.L0, [Certification.Horesh], 'Alpha'),
  createP('a6', 'Alpha-06', Level.L2, [Certification.Nitzan], 'Alpha'),
  createP('a7', 'Alpha-07', Level.L3, [Certification.Nitzan, Certification.Hamama], 'Alpha'),
  createP('a8', 'Alpha-08', Level.L4, [Certification.Hamama], 'Alpha'),
];

// Group Beta
const groupBeta: Participant[] = [
  createP('b1', 'Beta-01', Level.L0, [Certification.Nitzan], 'Beta'),
  createP('b2', 'Beta-02', Level.L0, [Certification.Salsala, Certification.Nitzan], 'Beta'),
  createP('b3', 'Beta-03', Level.L0, [Certification.Hamama], 'Beta'),
  createP('b4', 'Beta-04', Level.L0, [Certification.Horesh], 'Beta'),
  createP('b5', 'Beta-05', Level.L0, [], 'Beta'),
  createP('b6', 'Beta-06', Level.L2, [], 'Beta'),
  createP('b7', 'Beta-07', Level.L3, [Certification.Hamama], 'Beta'),
  createP('b8', 'Beta-08', Level.L4, [], 'Beta'),
];

// Group Gamma (extra pool)
const groupGamma: Participant[] = [
  createP('g1', 'Gamma-01', Level.L0, [Certification.Nitzan, Certification.Salsala], 'Gamma'),
  createP('g2', 'Gamma-02', Level.L0, [Certification.Hamama], 'Gamma'),
  createP('g3', 'Gamma-03', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g4', 'Gamma-04', Level.L0, [Certification.Horesh], 'Gamma'),
  createP('g5', 'Gamma-05', Level.L0, [], 'Gamma'),
  createP('g6', 'Gamma-06', Level.L2, [Certification.Nitzan], 'Gamma'),
  createP('g7', 'Gamma-07', Level.L3, [Certification.Nitzan], 'Gamma'),
  createP('g8', 'Gamma-08', Level.L4, [Certification.Hamama], 'Gamma'),
];

const allParticipants = [...groupAlpha, ...groupBeta, ...groupGamma];

// ─── Run Demo ────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║         RESOURCE SCHEDULING ENGINE — DEMO                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log();

// Stage 1: Setup
const engine = new SchedulingEngine({
  maxIterations: 2000,
  maxSolverTimeMs: 10000,
});

engine.addParticipants(allParticipants);
console.log(`✓ Registered ${allParticipants.length} participants across 3 groups\n`);

const tasks = generateDailyTasks(BASE_DATE);
engine.addTasks(tasks);
console.log(`✓ Generated ${tasks.length} tasks for ${BASE_DATE.toDateString()}\n`);

// Stage 2: Generate Schedule
console.log('Generating optimized schedule...\n');
const startTime = Date.now();
const schedule = engine.generateSchedule();
const elapsed = Date.now() - startTime;

console.log(`✓ Schedule generated in ${elapsed}ms`);
console.log(`  Feasible: ${schedule.feasible ? 'YES' : '*** NO ***'}`);
console.log(`  Assignments: ${schedule.assignments.length}`);
console.log();

// Score
console.log('── Score ─────────────────────────────────');
console.log(`  Min Rest:     ${schedule.score.minRestHours.toFixed(1)}h`);
console.log(`  Avg Rest:     ${schedule.score.avgRestHours.toFixed(1)}h`);
console.log(`  Rest StdDev:  ${schedule.score.restStdDev.toFixed(2)}`);
console.log(`  Penalty:      ${schedule.score.totalPenalty.toFixed(1)}`);
console.log(`  Composite:    ${schedule.score.compositeScore.toFixed(1)}`);
console.log();

// Violations
const hardViolations = schedule.violations.filter((v) => v.severity === ViolationSeverity.Error);
const warnings = schedule.violations.filter((v) => v.severity === ViolationSeverity.Warning);

if (hardViolations.length > 0) {
  console.log(`── Hard Violations (${hardViolations.length}) ────────────`);
  for (const v of hardViolations) {
    console.log(`  ✗ [${v.code}] ${v.message}`);
  }
  console.log();
}

if (warnings.length > 0) {
  console.log(`── Warnings (${warnings.length}) ──────────────────────`);
  for (const w of warnings) {
    console.log(`  ⚠ [${w.code}] ${w.message}`);
  }
  console.log();
}

// Task Summary
console.log(buildTaskSummary(schedule));
console.log();

// Rest Profiles
const profiles = computeAllRestProfiles(schedule.participants, schedule.assignments, schedule.tasks);
const fairness = computeRestFairness(profiles);

console.log('── Rest Fairness ─────────────────────────');
console.log(`  Global Min Rest: ${isFinite(fairness.globalMinRest) ? fairness.globalMinRest.toFixed(1) + 'h' : 'N/A'}`);
console.log(`  Global Avg Rest: ${isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest.toFixed(1) + 'h' : 'N/A'}`);
console.log(`  Std Deviation:   ${fairness.stdDevRest.toFixed(2)}`);
console.log();

// Gantt
const ganttData = scheduleToGantt(schedule);
console.log(ganttToAscii(ganttData, 100));
console.log();

// Demo: Manual Swap
console.log('── Manual Swap Demo ──────────────────────');
if (schedule.assignments.length >= 2) {
  const firstAssignment = schedule.assignments[0];
  const task = schedule.tasks.find((t) => t.id === firstAssignment.taskId);
  const originalParticipant = schedule.participants.find((p) => p.id === firstAssignment.participantId);

  // Find a different participant to swap in
  const swapCandidate = schedule.participants.find(
    (p) => p.id !== firstAssignment.participantId && p.group === originalParticipant?.group,
  );

  if (swapCandidate && originalParticipant) {
    console.log(`  Swapping ${originalParticipant.name} → ${swapCandidate.name} in ${task?.name}`);
    const swapResult = engine.swapParticipant({
      assignmentId: firstAssignment.id,
      newParticipantId: swapCandidate.id,
    });
    console.log(`  Swap valid: ${swapResult.valid}`);
    if (!swapResult.valid) {
      for (const v of swapResult.violations) {
        console.log(`    ✗ [${v.code}] ${v.message}`);
      }
    }
  }
}
console.log();

// Stats
const stats = engine.getStats();
console.log('── Final Stats ───────────────────────────');
console.log(`  Tasks:       ${stats.totalTasks}`);
console.log(`  Participants: ${stats.totalParticipants}`);
console.log(`  Assignments: ${stats.totalAssignments}`);
console.log(`  Feasible:    ${stats.feasible}`);
console.log(`  Hard Errors: ${stats.hardViolations}`);
console.log(`  Warnings:    ${stats.softWarnings}`);
console.log();
console.log('Done.');
