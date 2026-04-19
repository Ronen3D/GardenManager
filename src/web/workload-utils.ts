/**
 * Shared workload breakdown utility for web presentation code.
 *
 * De-duplicates the per-task-type accumulation pattern used in
 * tooltip, profile metrics, and sidebar computations (R1).
 */

import type { Assignment, Participant, ParticipantCapacity, Task } from '../models/types';
import { computeTaskColdHours, computeTaskEffectiveHours, computeTaskHotHours } from './utils/load-weighting';

export interface TaskBreakdown {
  /** Total raw duration hours across load-bearing tasks */
  heavyHours: number;
  /** Count of load-bearing task assignments */
  heavyCount: number;
  /** Weighted effective hours across load-bearing tasks */
  effectiveHeavyHours: number;
  /** Hours at 100% load: hot-window overlap */
  hotHours: number;
  /** Hours at reduced load: hours outside hot windows */
  coldHours: number;
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
 * Zero-effective-hours tasks are excluded from load-bearing totals but
 * still contribute to per-source counts and colors (so they remain
 * visible in the breakdown table).
 */
export function computeTaskBreakdown(items: Iterable<{ task: Task }>): TaskBreakdown {
  const sourceHours: Record<string, number> = {};
  const sourceEffectiveHours: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const sourceColors: Record<string, string> = {};

  let heavyHours = 0;
  let heavyCount = 0;
  let effectiveHeavyHours = 0;
  let hotHours = 0;
  let coldHours = 0;

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
    if (effectiveHrs > 0) {
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
  loadBearingCount: number;
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
    let loadBearingCount = 0;

    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;
      const eff = computeTaskEffectiveHours(task);
      if (eff === 0) continue;
      const hours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
      totalHours += hours;
      effectiveHours += eff;
      hotHours += computeTaskHotHours(task);
      coldHours += computeTaskColdHours(task);
      loadBearingCount++;
    }

    const cap = capacities?.get(p.id);
    const availableHours = cap?.totalAvailableHours;
    const loadRatio = availableHours && availableHours > 0 ? effectiveHours / availableHours : undefined;

    result.set(p.id, { totalHours, effectiveHours, hotHours, coldHours, loadBearingCount, availableHours, loadRatio });
  }

  return result;
}
