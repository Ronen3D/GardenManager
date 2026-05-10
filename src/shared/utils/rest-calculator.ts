/**
 * Rest Calculator - Computes rest periods between blocking load-bearing tasks.
 *
 * Rest Definition: time between *successive blocking tasks* (blocksConsecutive=true)
 * in the participant's timeline. Non-blocking load-bearing tasks (e.g. Karov)
 * sitting between two blocking tasks do NOT remove the blocking pair from the
 * signal — the gap is measured from one blocking task's end to the next
 * blocking task's start, regardless of what happens in between. This avoids a
 * scoring blind spot where a non-blocking task slipped between two blocking
 * tasks would hide the participant's tightest rest gap from the optimizer.
 *
 * The measured gap is therefore an *upper bound* on idle time when a
 * non-blocking task is interleaved; workload std-dev (SC-3) and daily balance
 * (SC-8) cover the "but they were doing Karov in between" axis separately.
 *
 * Zero-load tasks (computeTaskEffectiveHours(task) === 0, e.g. Karovit-style)
 * are excluded entirely — they do not count as work, do not participate in
 * rest-gap computation.
 *
 * Note: the rest-gap signal is driven by the task-level static
 * `blocksConsecutive` flag only. The per-window HC-12 boundary opt-in
 * (`LoadWindow.blocksAtBoundary`) is intentionally NOT consulted here —
 * it is a hard-constraint boundary trigger, not a workload-fairness signal.
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
  /** Rest gaps (hours) between successive blocking tasks (non-blocking tasks in between are skipped, not erased) */
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
  /** Σ √gap across this participant's gaps. Concave per-gap reward used by the
   *  scheduler's distribution-aware rest signal: every gap counts independently,
   *  short gaps weigh more than long ones (diminishing returns). */
  restPerGapBonus: number;
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
 * Compute rest gaps between successive blocking task blocks.
 *
 * Filters down to blocking tasks first, then computes gaps between consecutive
 * blocking pairs. A non-blocking task interleaved between two blocking tasks
 * does NOT erase the blocking-to-blocking gap — that pair stays in the signal
 * so the optimizer can keep maximising the tightest blocking rest gap.
 */
function computeRestGaps(sortedBlocks: TaggedBlock[]): number[] {
  const blocking: TaggedBlock[] = [];
  for (const b of sortedBlocks) {
    if (b.blocksConsecutive) blocking.push(b);
  }
  const gaps: number[] = [];
  for (let i = 1; i < blocking.length; i++) {
    gaps.push(gapHours(blocking[i - 1].block, blocking[i].block));
  }
  return gaps;
}

function summarizeRestGaps(restGaps: number[]): {
  minRest: number;
  maxRest: number;
  avgRest: number;
  restPerGapBonus: number;
} {
  if (restGaps.length === 0) {
    return {
      minRest: Infinity,
      maxRest: Infinity,
      avgRest: Infinity,
      restPerGapBonus: 0,
    };
  }

  let minRest = Infinity;
  let maxRest = -Infinity;
  let sumRest = 0;
  let restPerGapBonus = 0;
  for (const gap of restGaps) {
    minRest = Math.min(minRest, gap);
    maxRest = Math.max(maxRest, gap);
    sumRest += gap;
    restPerGapBonus += Math.sqrt(Math.max(0, gap));
  }

  return {
    minRest,
    maxRest,
    avgRest: sumRest / restGaps.length,
    restPerGapBonus,
  };
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

  const restSummary = summarizeRestGaps(restGaps);

  return {
    participantId,
    restGaps,
    minRestHours: restSummary.minRest,
    maxRestHours: restSummary.maxRest,
    avgRestHours: restSummary.avgRest,
    totalWorkHours,
    loadBearingAssignmentCount: loadBearingBlocks.length,
    restPerGapBonus: restSummary.restPerGapBonus,
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
  phantomTaskIds?: Set<string>,
): ParticipantRestProfile {
  const loadBearingBlocks: TaggedBlock[] = [];
  let totalWorkHours = 0;

  for (const a of pAssignments) {
    if (phantomTaskIds?.has(a.taskId)) continue;
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

  const restSummary = summarizeRestGaps(restGaps);

  return {
    participantId,
    restGaps,
    minRestHours: restSummary.minRest,
    maxRestHours: restSummary.maxRest,
    avgRestHours: restSummary.avgRest,
    totalWorkHours,
    loadBearingAssignmentCount: loadBearingBlocks.length,
    restPerGapBonus: restSummary.restPerGapBonus,
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
  phantomTaskIds?: Set<string>,
): Map<string, ParticipantRestProfile> {
  const profiles = new Map<string, ParticipantRestProfile>();
  if (prebuiltTaskMap && assignmentsByParticipant) {
    for (const p of participants) {
      const pAssignments = assignmentsByParticipant.get(p.id) || [];
      profiles.set(p.id, computeRestFromAssignments(p.id, pAssignments, prebuiltTaskMap, phantomTaskIds));
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
  let globalMin = Infinity;
  let sumRest = 0;
  let restCount = 0;
  for (const p of profiles.values()) {
    const minRest = p.minRestHours;
    if (p.restGaps.length > 0 && Number.isFinite(minRest)) {
      globalMin = Math.min(globalMin, minRest);
      sumRest += minRest;
      restCount++;
    }
  }

  if (restCount === 0) {
    return { globalMinRest: Infinity, globalAvgRest: Infinity, stdDevRest: 0 };
  }

  const avg = sumRest / restCount;
  let varianceSum = 0;
  for (const p of profiles.values()) {
    const minRest = p.minRestHours;
    if (p.restGaps.length > 0 && Number.isFinite(minRest)) {
      varianceSum += (minRest - avg) ** 2;
    }
  }
  const variance = varianceSum / restCount;
  const stdDev = Math.sqrt(variance);

  return {
    globalMinRest: globalMin,
    globalAvgRest: avg,
    stdDevRest: stdDev,
  };
}
