/**
 * Soft Constraint Scorers
 *
 * These produce numeric scores (penalties / bonuses) that guide
 * the optimizer toward better schedules without making them invalid.
 */

import {
  Task,
  Assignment,
  Participant,
  TaskType,
  Level,
  SchedulerConfig,
  ScheduleScore,
  ConstraintViolation,
  ViolationSeverity,
} from '../models/types';
import {
  computeAllRestProfiles,
  computeRestFairness,
  ParticipantRestProfile,
} from '../web/utils/rest-calculator';

// ─── Individual Penalty Functions ────────────────────────────────────────────

/**
 * SC-1: Hamama penalty — penalise assigning L3/L4 to Hamama.
 * Best: L0 (0 penalty), Acceptable: L3 (high), Avoid: L4 (extreme).
 */
export function hamamaPenalty(
  task: Task,
  participant: Participant,
  config: SchedulerConfig,
): number {
  if (task.type !== TaskType.Hamama) return 0;
  if (participant.level === Level.L3) return config.hamamaL3Penalty;
  if (participant.level === Level.L4) return config.hamamaL4Penalty;
  return 0;
}

/**
 * SC-2: Shemesh same-group bonus — REMOVED.
 * Shemesh now freely mixes participants from any group (no group constraint).
 * Kept as a no-op for API compatibility.
 */
export function shemeshGroupBonus(
  _task: Task,
  _assignedParticipants: Participant[],
  _config: SchedulerConfig,
): number {
  return 0;
}

/**
 * SC-3: Workload balance — penalize uneven distribution of non-light assignments.
 * Returns a penalty proportional to the standard deviation of assignment counts.
 */
export function workloadImbalancePenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): number {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const counts: number[] = participants.map((p) => {
    return assignments.filter((a) => {
      const task = taskMap.get(a.taskId);
      return a.participantId === p.id && task && !task.isLight;
    }).length;
  });

  if (counts.length === 0) return 0;
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((sum, c) => sum + (c - avg) ** 2, 0) / counts.length;
  return Math.sqrt(variance) * 2; // Scaled penalty
}

/**
 * SC-4: Per-level workload fairness for multi-day schedules.
 * Participants at the same level should work roughly the same number of hours.
 * Returns a penalty for cross-level imbalance within each level group.
 */
export function levelWorkloadFairnessPenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): number {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // Group participants by level
  const byLevel = new Map<number, Participant[]>();
  for (const p of participants) {
    const arr = byLevel.get(p.level) || [];
    arr.push(p);
    byLevel.set(p.level, arr);
  }

  let totalPenalty = 0;

  for (const [_level, levelParticipants] of byLevel) {
    if (levelParticipants.length <= 1) continue;

    const hours = levelParticipants.map((p) => {
      let h = 0;
      for (const a of assignments) {
        if (a.participantId !== p.id) continue;
        const task = taskMap.get(a.taskId);
        if (!task || task.isLight) continue;
        h += (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
      }
      return h;
    });

    const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
    if (avg === 0) continue;
    const variance = hours.reduce((sum, h) => sum + (h - avg) ** 2, 0) / hours.length;
    totalPenalty += Math.sqrt(variance);
  }

  return totalPenalty;
}

/**
 * SC-5: Back-to-back shift penalty — penalise 0-minute gaps between
 * consecutive assignments for the same participant.
 *
 * This is a SOFT constraint only: the optimizer will prefer schedules
 * with breathing room between shifts, but will never leave a slot
 * unassigned just to create a gap. L1 participants are excluded
 * because their hard 8-8-8-16 cycle already enforces rest.
 */
export function backToBackPenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  penaltyPerPair: number,
): number {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  let penalty = 0;

  for (const p of participants) {
    // L1 excluded — hard cycle constraints handle their rest
    if (p.level === Level.L1) continue;

    // Gather this participant's non-light tasks sorted by start
    const pTasks: Task[] = [];
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (task && !task.isLight) pTasks.push(task);
    }
    if (pTasks.length < 2) continue;

    pTasks.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());

    for (let i = 0; i < pTasks.length - 1; i++) {
      const gapMs = pTasks[i + 1].timeBlock.start.getTime() - pTasks[i].timeBlock.end.getTime();
      if (gapMs <= 0) {
        // Zero or negative gap (overlap should not happen after HC, but guard anyway)
        penalty += penaltyPerPair;
      }
    }
  }

  return penalty;
}

// ─── Soft Constraint Warnings ────────────────────────────────────────────────

/**
 * Generate warnings (non-fatal) for soft constraint issues.
 */
export function collectSoftWarnings(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
): ConstraintViolation[] {
  const warnings: ConstraintViolation[] = [];
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);
  const tMap = new Map<string, Task>();
  for (const t of tasks) tMap.set(t.id, t);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);

    // Hamama L3 warning (L4 is now a hard constraint — HC-10)
    if (task.type === TaskType.Hamama) {
      for (const p of assignedPs) {
        if (p.level === Level.L3) {
          warnings.push({
            severity: ViolationSeverity.Warning,
            code: 'HAMAMA_L3',
            message: `${p.name} (L3) assigned to Hamama — high penalty. Prefer L0.`,
            taskId: task.id,
            participantId: p.id,
          });
        }
        // L4 no longer a warning — it's a hard violation (HC-10 L4_FORBIDDEN)
      }
    }

    // (Shemesh group constraint removed — free mixing allowed)
  }

  // SC-5: Back-to-back warnings (zero gap between consecutive assignments)
  const btbTaskMap = new Map<string, Task>();
  for (const t of tasks) btbTaskMap.set(t.id, t);
  for (const p of participants) {
    if (p.level === Level.L1) continue; // Hard cycle handles L1 rest
    const pTasks: Task[] = [];
    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = btbTaskMap.get(a.taskId);
      if (task && !task.isLight) pTasks.push(task);
    }
    if (pTasks.length < 2) continue;
    pTasks.sort((x, y) => x.timeBlock.start.getTime() - y.timeBlock.start.getTime());
    for (let i = 0; i < pTasks.length - 1; i++) {
      const gapMs = pTasks[i + 1].timeBlock.start.getTime() - pTasks[i].timeBlock.end.getTime();
      if (gapMs <= 0) {
        warnings.push({
          severity: ViolationSeverity.Warning,
          code: 'BACK_TO_BACK',
          message: `${p.name} has back-to-back shifts: "${pTasks[i].name}" ends at ${pTasks[i].timeBlock.end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} and "${pTasks[i + 1].name}" starts immediately.`,
          taskId: pTasks[i + 1].id,
          participantId: p.id,
        });
      }
    }
  }

  return warnings;
}

// ─── Composite Score Calculation ─────────────────────────────────────────────

/**
 * Compute the full ScheduleScore for a set of assignments.
 */
export function computeScheduleScore(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
): ScheduleScore {
  // Rest fairness
  const profiles = computeAllRestProfiles(participants, assignments, tasks);
  const fairness = computeRestFairness(profiles);

  // Penalties
  let totalPenalty = 0;
  let totalBonus = 0;

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  for (const task of tasks) {
    const taskAssignments = assignments.filter((a) => a.taskId === task.id);
    const assignedPs = taskAssignments
      .map((a) => pMap.get(a.participantId))
      .filter((p): p is Participant => !!p);

    // Hamama penalties
    for (const p of assignedPs) {
      totalPenalty += hamamaPenalty(task, p, config);
    }

    // Shemesh bonus
    totalBonus += shemeshGroupBonus(task, assignedPs, config);
  }

  // Workload imbalance
  totalPenalty += workloadImbalancePenalty(participants, assignments, tasks);

  // Level-specific workload fairness (SC-4)
  totalPenalty += levelWorkloadFairnessPenalty(participants, assignments, tasks);

  // Back-to-back shift penalty (SC-5)
  totalPenalty += backToBackPenalty(participants, assignments, tasks, config.backToBackPenalty);

  // Composite score
  const minRest = isFinite(fairness.globalMinRest) ? fairness.globalMinRest : 0;
  const avgRest = isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest : 0;
  const stdDev = fairness.stdDevRest;

  const compositeScore =
    config.minRestWeight * minRest -
    config.fairnessWeight * stdDev -
    config.penaltyWeight * totalPenalty +
    config.bonusWeight * totalBonus;

  return {
    minRestHours: minRest,
    avgRestHours: avgRest,
    restStdDev: stdDev,
    totalPenalty,
    totalBonus,
    compositeScore,
  };
}
