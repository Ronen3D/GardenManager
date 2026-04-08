/**
 * Rest Calculator - Computes rest periods between blocking tasks for each participant.
 *
 * Rest Definition: Time between consecutive non-light tasks where BOTH have
 * blocksConsecutive=true. This mirrors HC-12's logic — tasks that are allowed
 * to be placed back-to-back (e.g. Karov with blocksConsecutive=false) do not
 * generate rest-gap penalties.
 *
 * "Karovit" (Light Task) is excluded entirely (doesn't count as work).
 * "Karov" (non-light but blocksConsecutive=false) counts toward work hours
 * but its gaps with adjacent tasks are not penalised by minRestWeight.
 */

import type { Assignment, Participant, Task, TimeBlock } from '../../models/types';
import { gapHours, sortBlocksByStart } from './time-utils';

/** A non-light time block tagged with its HC-12 blocking flag. */
interface TaggedBlock {
  block: TimeBlock;
  blocksConsecutive: boolean;
}

export interface ParticipantRestProfile {
  participantId: string;
  /** Rest gaps (hours) between consecutive dual-blocking task pairs */
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
 * Get all non-light tagged blocks assigned to a participant, sorted by start.
 * Each entry carries the task's blocksConsecutive flag for rest-gap filtering.
 */
function getNonLightBlocks(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task || task.isLight) continue;
    blocks.push({ block: task.timeBlock, blocksConsecutive: task.blocksConsecutive });
  }
  return blocks.sort((a, b) => a.block.start.getTime() - b.block.start.getTime());
}

/**
 * Get all light TimeBlocks assigned to a participant.
 */
function getLightBlocks(participantId: string, assignments: Assignment[], taskMap: Map<string, Task>): TimeBlock[] {
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
 * Only gaps where BOTH the preceding and following tasks have
 * blocksConsecutive=true are included — mirroring HC-12's rule.
 */
function computeRestGaps(sortedBlocks: TaggedBlock[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sortedBlocks.length; i++) {
    const prev = sortedBlocks[i - 1];
    const curr = sortedBlocks[i];
    // Only penalise gaps between two blocking tasks
    if (!prev.blocksConsecutive || !curr.blocksConsecutive) continue;
    const gap = gapHours(prev.block, curr.block);
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

  const totalWorkHours = nonLightBlocks.reduce((sum, tb) => {
    return sum + (tb.block.end.getTime() - tb.block.start.getTime()) / (1000 * 60 * 60);
  }, 0);

  const totalLightHours = lightBlocks.reduce((sum, b) => {
    return sum + (b.end.getTime() - b.start.getTime()) / (1000 * 60 * 60);
  }, 0);

  const minRest = restGaps.length > 0 ? Math.min(...restGaps) : Infinity;
  const maxRest = restGaps.length > 0 ? Math.max(...restGaps) : Infinity;
  const avgRest = restGaps.length > 0 ? restGaps.reduce((a, b) => a + b, 0) / restGaps.length : Infinity;

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
 * Internal: compute rest profile from pre-filtered participant assignments.
 * Avoids re-building the task map and re-scanning all assignments.
 */
export function computeRestFromAssignments(
  participantId: string,
  pAssignments: Assignment[],
  taskMap: Map<string, Task>,
): ParticipantRestProfile {
  const nonLightBlocks: TaggedBlock[] = [];
  let totalWorkHours = 0;
  let totalLightHours = 0;

  for (const a of pAssignments) {
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    const hours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / (1000 * 60 * 60);
    if (task.isLight) {
      totalLightHours += hours;
    } else {
      nonLightBlocks.push({ block: task.timeBlock, blocksConsecutive: task.blocksConsecutive });
      totalWorkHours += hours;
    }
  }

  // Sort by start time (in-place — nonLightBlocks is a local array)
  nonLightBlocks.sort((a, b) => a.block.start.getTime() - b.block.start.getTime());

  const restGaps = computeRestGaps(nonLightBlocks);

  const minRest = restGaps.length > 0 ? Math.min(...restGaps) : Infinity;
  const maxRest = restGaps.length > 0 ? Math.max(...restGaps) : Infinity;
  const avgRest = restGaps.length > 0 ? restGaps.reduce((a, b) => a + b, 0) / restGaps.length : Infinity;

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
 *
 * Accepts optional pre-built data structures to avoid redundant work when
 * called from a hot loop (e.g. the optimizer's scoring function).
 */
export function computeAllRestProfiles(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  prebuiltTaskMap?: Map<string, Task>,
  assignmentsByParticipant?: Map<string, Assignment[]>,
): Map<string, ParticipantRestProfile> {
  const profiles = new Map<string, ParticipantRestProfile>();
  if (prebuiltTaskMap && assignmentsByParticipant) {
    for (const p of participants) {
      const pAssignments = assignmentsByParticipant.get(p.id) || [];
      profiles.set(p.id, computeRestFromAssignments(p.id, pAssignments, prebuiltTaskMap));
    }
  } else {
    for (const p of participants) {
      profiles.set(p.id, computeParticipantRest(p.id, assignments, tasks));
    }
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
  const variance = minRests.reduce((sum, v) => sum + (v - avg) ** 2, 0) / minRests.length;
  const stdDev = Math.sqrt(variance);

  return {
    globalMinRest: globalMin,
    globalAvgRest: avg,
    stdDevRest: stdDev,
  };
}
