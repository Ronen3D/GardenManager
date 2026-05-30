/**
 * Shared helpers for anchor fixtures.
 *
 * Anchors are tiny hand-crafted fixtures that pin a specific ordering
 * relation. They observe the OUTPUT of `computeStructuralPriority` and/or
 * `sortTasksByDifficulty` — they do NOT run the full optimizer (with one
 * exception: I-deterministic-under-seed needs `optimizeMultiAttempt`).
 *
 * The helpers below build the small participant + task sets each anchor
 * needs, plus a `priorityOf(task, ctx)` shorthand that uses the same
 * fallback rules as `sortTasksByDifficulty` (explicit `schedulingPriority`
 * if set, otherwise compute via the tiered formula).
 */

import {
  buildSchedulingContext,
  computeStructuralPriority,
  type SchedulingContext,
  sortTasksByDifficulty,
} from '../../engine/optimizer';
import { Level, type Participant, type Task } from '../../models/types';
import {
  DEFAULT_BASE_DATE,
  makeParticipant,
  makeSlot,
  makeTask,
  resetIdCounters,
} from '../fixtures/shared';

/**
 * Tier × 10 + sub display value used by anchors' "priority observations".
 * Direction: smaller priorityOf = sorts earlier.
 */
export function priorityOf(task: Task, ctx?: SchedulingContext): number {
  if (task.schedulingPriority !== undefined) return task.schedulingPriority;
  return computeStructuralPriority(task, ctx);
}

/**
 * Sort the given task list via the active formula and return a `rank`
 * map (task.id → sort-position index). Anchors use this to compare
 * ordering relations in a mode-agnostic way.
 *
 * Use `sortAndRank` for pass/fail decisions; use `priorityOf` for
 * observation/reporting values.
 */
export function sortAndRank(tasks: Task[], ctx?: SchedulingContext, jitter = 0): { sorted: Task[]; rank: Map<string, number> } {
  const sorted = sortTasksByDifficulty(tasks, jitter, ctx);
  const rank = new Map<string, number>();
  sorted.forEach((t, i) => rank.set(t.id, i));
  return { sorted, rank };
}

/** Build a `SchedulingContext` for a small (participants, tasks) anchor
 *  fixture. */
export function ctxFor(tasks: Task[], participants: Participant[]): SchedulingContext {
  return buildSchedulingContext(tasks, participants);
}

/** Tiny pool — N L0 participants in one group, all with the given certs.
 *  Used as a baseline pool for several anchors. */
export function tinyL0Pool(opts: { count: number; group?: string; certs?: string[]; idPrefix?: string }): Participant[] {
  const group = opts.group ?? 'ק1';
  const certs = opts.certs ?? ['Nitzan'];
  const prefix = opts.idPrefix ?? 'p';
  const out: Participant[] = [];
  for (let i = 0; i < opts.count; i++) {
    out.push(
      makeParticipant({
        id: `${prefix}${i + 1}`,
        name: `${prefix.toUpperCase()}${i + 1}`,
        level: Level.L0,
        certs,
        group,
      }),
    );
  }
  return out;
}

/** Reset the shared fixture id counters before constructing an anchor's
 *  participants/tasks. Call this at the start of every anchor's evaluate(). */
export function resetAnchorCounters(): void {
  resetIdCounters();
}

/** Build a simple no-cert L0 task at the given day/hour. */
export function simpleL0Task(opts: { name: string; dayIndex: number; startHour: number; slotCount?: number; durationHours?: number }): Task {
  return makeTask({
    name: opts.name,
    sourceName: opts.name,
    baseDate: DEFAULT_BASE_DATE,
    dayIndex: opts.dayIndex,
    startHour: opts.startHour,
    durationHours: opts.durationHours ?? 4,
    slots: Array.from({ length: opts.slotCount ?? 1 }, () =>
      makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
    ),
  });
}
