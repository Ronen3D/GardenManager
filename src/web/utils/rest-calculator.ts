/**
 * Rest Calculator - Computes rest periods between load-bearing tasks.
 *
 * Rest Definition: time between consecutive load-bearing tasks where BOTH have
 * blocksConsecutive=true. This mirrors HC-12's logic — tasks that are allowed
 * to be placed back-to-back (e.g. Karov with blocksConsecutive=false) do not
 * generate rest-gap penalties.
 *
 * Zero-load tasks (computeTaskEffectiveHours(task) === 0, e.g. Karovit-style)
 * are excluded entirely — they do not count as work, do not participate in
 * rest-gap computation.
 */

import type { Assignment, Participant, Task, TimeBlock } from '../../models/types';
import { computeTaskEffectiveHours } from './load-weighting';
import { gapHours } from './time-utils';

/** A load-bearing time block tagged with its HC-12 blocking flag. */
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
  /** Total load-bearing task hours */
  totalWorkHours: number;
  /** Number of load-bearing assignments */
  loadBearingAssignmentCount: number;
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
 * Get all load-bearing tagged blocks assigned to a participant, sorted by start.
 * Zero-effective-hours tasks are excluded. Each entry carries the task's
 * blocksConsecutive flag for rest-gap filtering.
 */
function getLoadBearingBlocks(
  participantId: string,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): TaggedBlock[] {
  const blocks: TaggedBlock[] = [];
  for (const a of assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    if (computeTaskEffectiveHours(task) === 0) continue;
    blocks.push({ block: task.timeBlock, blocksConsecutive: task.blocksConsecutive });
  }
  return blocks.sort((a, b) => a.block.start.getTime() - b.block.start.getTime());
}

/**
 * Compute rest gaps between consecutive load-bearing task blocks.
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
  const loadBearingBlocks = getLoadBearingBlocks(participantId, assignments, taskMap);

  const restGaps = computeRestGaps(loadBearingBlocks);

  const totalWorkHours = loadBearingBlocks.reduce((sum, tb) => {
    return sum + (tb.block.end.getTime() - tb.block.start.getTime()) / (1000 * 60 * 60);
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
    loadBearingAssignmentCount: loadBearingBlocks.length,
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
  const loadBearingBlocks: TaggedBlock[] = [];
  let totalWorkHours = 0;

  for (const a of pAssignments) {
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    if (computeTaskEffectiveHours(task) === 0) continue;
    const hours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / (1000 * 60 * 60);
    loadBearingBlocks.push({ block: task.timeBlock, blocksConsecutive: task.blocksConsecutive });
    totalWorkHours += hours;
  }

  // Sort by start time (in-place — loadBearingBlocks is a local array)
  loadBearingBlocks.sort((a, b) => a.block.start.getTime() - b.block.start.getTime());

  const restGaps = computeRestGaps(loadBearingBlocks);

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
    loadBearingAssignmentCount: loadBearingBlocks.length,
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
