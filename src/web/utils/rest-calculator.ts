/**
 * Rest Calculator - Computes rest periods between non-light tasks for each participant.
 *
 * Rest Definition: Time between non-light tasks.
 * "Karovit" (Light Task) can be performed during rest periods without resetting rest.
 */

import { Task, Assignment, Participant, TimeBlock } from '../../models/types';
import { gapHours, sortBlocksByStart } from './time-utils';

export interface ParticipantRestProfile {
  participantId: string;
  /** All rest gaps (hours) between consecutive non-light tasks */
  restGaps: number[];
  /** Minimum rest gap (hours) — the bottleneck */
  minRestHours: number;
  /** Maximum rest gap (hours) */
  maxRestHours: number;
  /** Average rest gap (hours) */
  avgRestHours: number;
  /** Total non-light task hours */
  totalWorkHours: number;
  /** Total light task hours (doesn't count as work) */
  totalLightHours: number;
  /** Number of non-light assignments */
  nonLightAssignmentCount: number;
}

/**
 * Build a lookup map: taskId → Task
 */
function buildTaskMap(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) {
    map.set(t.id, t);
  }
  return map;
}

/**
 * Get all non-light TimeBlocks assigned to a participant, sorted by start.
 */
function getNonLightBlocks(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): TimeBlock[] {
  const blocks: TimeBlock[] = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task || task.isLight) continue;
    blocks.push(task.timeBlock);
  }
  return sortBlocksByStart(blocks);
}

/**
 * Get all light TimeBlocks assigned to a participant.
 */
function getLightBlocks(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): TimeBlock[] {
  const blocks: TimeBlock[] = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task || !task.isLight) continue;
    blocks.push(task.timeBlock);
  }
  return sortBlocksByStart(blocks);
}

/**
 * Compute rest gaps between consecutive non-light task blocks.
 */
function computeRestGaps(sortedNonLightBlocks: TimeBlock[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sortedNonLightBlocks.length; i++) {
    const gap = gapHours(sortedNonLightBlocks[i - 1], sortedNonLightBlocks[i]);
    gaps.push(gap);
  }
  return gaps;
}

/**
 * Compute the rest profile for a single participant.
 */
export function computeParticipantRest(
  participantId: string,
  assignments: Assignment[],
  tasks: Task[],
): ParticipantRestProfile {
  const taskMap = buildTaskMap(tasks);
  const nonLightBlocks = getNonLightBlocks(participantId, assignments, taskMap);
  const lightBlocks = getLightBlocks(participantId, assignments, taskMap);

  const restGaps = computeRestGaps(nonLightBlocks);

  const totalWorkHours = nonLightBlocks.reduce((sum, b) => {
    return sum + (b.end.getTime() - b.start.getTime()) / (1000 * 60 * 60);
  }, 0);

  const totalLightHours = lightBlocks.reduce((sum, b) => {
    return sum + (b.end.getTime() - b.start.getTime()) / (1000 * 60 * 60);
  }, 0);

  const minRest = restGaps.length > 0 ? Math.min(...restGaps) : Infinity;
  const maxRest = restGaps.length > 0 ? Math.max(...restGaps) : Infinity;
  const avgRest =
    restGaps.length > 0
      ? restGaps.reduce((a, b) => a + b, 0) / restGaps.length
      : Infinity;

  return {
    participantId,
    restGaps,
    minRestHours: minRest,
    maxRestHours: maxRest,
    avgRestHours: avgRest,
    totalWorkHours,
    totalLightHours,
    nonLightAssignmentCount: nonLightBlocks.length,
  };
}

/**
 * Compute rest profiles for all participants.
 */
export function computeAllRestProfiles(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): Map<string, ParticipantRestProfile> {
  const profiles = new Map<string, ParticipantRestProfile>();
  for (const p of participants) {
    profiles.set(p.id, computeParticipantRest(p.id, assignments, tasks));
  }
  return profiles;
}

/**
 * Compute global rest fairness metrics.
 */
export function computeRestFairness(profiles: Map<string, ParticipantRestProfile>): {
  globalMinRest: number;
  globalAvgRest: number;
  stdDevRest: number;
} {
  // Only consider participants with at least 2 non-light assignments (they have rest gaps)
  const minRests: number[] = [];
  for (const p of profiles.values()) {
    if (p.restGaps.length > 0 && isFinite(p.minRestHours)) {
      minRests.push(p.minRestHours);
    }
  }

  if (minRests.length === 0) {
    return { globalMinRest: Infinity, globalAvgRest: Infinity, stdDevRest: 0 };
  }

  const globalMin = Math.min(...minRests);
  const avg = minRests.reduce((a, b) => a + b, 0) / minRests.length;
  const variance =
    minRests.reduce((sum, v) => sum + (v - avg) ** 2, 0) / minRests.length;
  const stdDev = Math.sqrt(variance);

  return {
    globalMinRest: globalMin,
    globalAvgRest: avg,
    stdDevRest: stdDev,
  };
}
