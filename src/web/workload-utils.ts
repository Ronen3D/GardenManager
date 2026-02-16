/**
 * Shared workload breakdown utility for web presentation code.
 *
 * De-duplicates the per-task-type accumulation pattern used in
 * tooltip, profile metrics, and sidebar computations (R1).
 */

import { Task, TaskType } from '../models/types';

export interface TaskBreakdown {
  heavyHours: number;
  heavyCount: number;
  lightHours: number;
  lightCount: number;
  /** Hours per TaskType */
  typeHours: Record<string, number>;
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
  const typeCounts: Record<string, number> = {};
  for (const tt of Object.values(TaskType)) {
    typeHours[tt] = 0;
    typeCounts[tt] = 0;
  }

  let heavyHours = 0;
  let heavyCount = 0;
  let lightHours = 0;
  let lightCount = 0;

  for (const { task } of items) {
    const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
    typeHours[task.type] = (typeHours[task.type] || 0) + hrs;
    typeCounts[task.type] = (typeCounts[task.type] || 0) + 1;
    if (task.isLight) {
      lightHours += hrs;
      lightCount++;
    } else {
      heavyHours += hrs;
      heavyCount++;
    }
  }

  return { heavyHours, heavyCount, lightHours, lightCount, typeHours, typeCounts };
}
