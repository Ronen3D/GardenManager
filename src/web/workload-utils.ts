/**
 * Shared workload breakdown utility for web presentation code.
 *
 * De-duplicates the per-task-type accumulation pattern used in
 * tooltip, profile metrics, and sidebar computations (R1).
 */

import { Task, Participant, Assignment, ParticipantCapacity } from '../models/types';
import { computeTaskEffectiveHours, computeTaskHotHours, computeTaskColdHours } from './utils/load-weighting';

export interface TaskBreakdown {
  heavyHours: number;
  heavyCount: number;
  effectiveHeavyHours: number;
  /** Hours at 100% load: heavy tasks + hot-window overlap */
  hotHours: number;
  /** Hours at reduced load: hours outside hot windows */
  coldHours: number;
  lightHours: number;
  lightCount: number;
  /** Hours per source (template name) */
  sourceHours: Record<string, number>;
  /** Effective weighted hours per source */
  sourceEffectiveHours: Record<string, number>;
  /** Assignment count per source */
  sourceCounts: Record<string, number>;
  /** Color per source (first color seen) */
  sourceColors: Record<string, string>;
}

/**
 * Compute a full workload breakdown from a list of matched tasks.
 *
 * Accepts any iterable of objects with a `task` property (e.g. the
 * `{ assignment, task }` tuples used by tab-profile, or a plain
 * `{ task }` wrapper created from a filtered assignment loop).
 */
export function computeTaskBreakdown(
  items: Iterable<{ task: Task }>,
): TaskBreakdown {
  const sourceHours: Record<string, number> = {};
  const sourceEffectiveHours: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const sourceColors: Record<string, string> = {};

  let heavyHours = 0;
  let heavyCount = 0;
  let effectiveHeavyHours = 0;
  let hotHours = 0;
  let coldHours = 0;
  let lightHours = 0;
  let lightCount = 0;

  for (const { task } of items) {
    const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
    const effectiveHrs = computeTaskEffectiveHours(task);
    const hotHrs = computeTaskHotHours(task);
    const coldHrs = computeTaskColdHours(task);
    const key = task.sourceName || task.name;
    sourceHours[key] = (sourceHours[key] || 0) + hrs;
    sourceEffectiveHours[key] = (sourceEffectiveHours[key] || 0) + effectiveHrs;
    sourceCounts[key] = (sourceCounts[key] || 0) + 1;
    if (!sourceColors[key]) sourceColors[key] = task.color || '#7f8c8d';
    if (task.isLight) {
      lightHours += hrs;
      lightCount++;
    } else {
      heavyHours += hrs;
      effectiveHeavyHours += effectiveHrs;
      hotHours += hotHrs;
      coldHours += coldHrs;
      heavyCount++;
    }
  }

  return {
    heavyHours,
    heavyCount,
    effectiveHeavyHours,
    hotHours,
    coldHours,
    lightHours,
    lightCount,
    sourceHours,
    sourceEffectiveHours,
    sourceCounts,
    sourceColors,
  };
}

export interface WeeklyWorkload {
  totalHours: number;
  effectiveHours: number;
  hotHours: number;
  coldHours: number;
  nonLightCount: number;
  /** Total available hours within the schedule window (undefined if capacities not provided) */
  availableHours?: number;
  /** Effective hours as a ratio of available hours: effectiveHours / availableHours (undefined if capacities not provided) */
  loadRatio?: number;
}

export function computeWeeklyWorkloads(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  capacities?: Map<string, ParticipantCapacity>,
): Map<string, WeeklyWorkload> {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const result = new Map<string, WeeklyWorkload>();

  for (const p of participants) {
    let totalHours = 0;
    let effectiveHours = 0;
    let hotHours = 0;
    let coldHours = 0;
    let nonLightCount = 0;

    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task || task.isLight) continue;
      const hours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
      totalHours += hours;
      effectiveHours += computeTaskEffectiveHours(task);
      hotHours += computeTaskHotHours(task);
      coldHours += computeTaskColdHours(task);
      nonLightCount++;
    }

    const cap = capacities?.get(p.id);
    const availableHours = cap?.totalAvailableHours;
    const loadRatio = availableHours && availableHours > 0
      ? effectiveHours / availableHours
      : undefined;

    result.set(p.id, { totalHours, effectiveHours, hotHours, coldHours, nonLightCount, availableHours, loadRatio });
  }

  return result;
}
