/**
 * Shared workload breakdown utility for web presentation code.
 *
 * De-duplicates the per-task-type accumulation pattern used in
 * tooltip, profile metrics, and sidebar computations (R1).
 */

import { Task, TaskType, Participant, Assignment } from '../models/types';
import { computeTaskEffectiveHours, computeTaskHotHours, computeTaskColdHours } from './utils/load-weighting';

export interface TaskBreakdown {
  heavyHours: number;
  heavyCount: number;
  effectiveHeavyHours: number;
  /** Hours at 100% load: all non-Kruv heavy + Kruv hot-window overlap */
  hotHours: number;
  /** Hours at reduced load: Kruv hours outside hot windows */
  coldHours: number;
  lightHours: number;
  lightCount: number;
  /** Hours per TaskType */
  typeHours: Record<string, number>;
  /** Effective weighted hours per TaskType */
  typeEffectiveHours: Record<string, number>;
  /** Assignment count per TaskType */
  typeCounts: Record<string, number>;
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
  const typeHours: Record<string, number> = {};
  const typeEffectiveHours: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  for (const tt of Object.values(TaskType)) {
    typeHours[tt] = 0;
    typeEffectiveHours[tt] = 0;
    typeCounts[tt] = 0;
  }

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
    typeHours[task.type] = (typeHours[task.type] || 0) + hrs;
    typeEffectiveHours[task.type] = (typeEffectiveHours[task.type] || 0) + effectiveHrs;
    typeCounts[task.type] = (typeCounts[task.type] || 0) + 1;
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
    typeHours,
    typeEffectiveHours,
    typeCounts,
  };
}

export function computeWeeklyWorkloads(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): Map<string, { totalHours: number; effectiveHours: number; hotHours: number; coldHours: number; nonLightCount: number }> {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const result = new Map<string, { totalHours: number; effectiveHours: number; hotHours: number; coldHours: number; nonLightCount: number }>();

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

    result.set(p.id, { totalHours, effectiveHours, hotHours, coldHours, nonLightCount });
  }

  return result;
}
