/**
 * Swimlane View — pure data helpers.
 *
 * Composes the existing schedule/availability primitives into the per-lane
 * data shape the renderer needs. Stateless: every function takes its inputs
 * as parameters and reads only from the provided Schedule + Participant
 * (frozen-snapshot semantics — no `store.*` reads, no engine reach-through).
 */

import type { DateUnavailability, Participant, Schedule, Task } from '../models/types';
import { hourInOpDay } from '../shared/utils/time-utils';
import { getDayWindow, taskIntersectsDay } from './schedule-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DayWindow {
  start: Date;
  end: Date;
}

/** A clipped-to-day-window absolute time band, in epoch ms. */
export interface Band {
  startMs: number;
  endMs: number;
}

// ─── Position math ───────────────────────────────────────────────────────────

/**
 * Map an absolute timestamp to a 0..1 fraction within a day window.
 * Clamps out-of-window values to [0, 1] so cross-day tasks render flush
 * to the lane edges.
 */
export function positionFraction(timestampMs: number, win: DayWindow): number {
  const total = win.end.getTime() - win.start.getTime();
  if (total <= 0) return 0;
  const f = (timestampMs - win.start.getTime()) / total;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/** Clip a [start, end] band to a day window. Returns null if no overlap. */
export function clipBandToDay(startMs: number, endMs: number, win: DayWindow): Band | null {
  const wStart = win.start.getTime();
  const wEnd = win.end.getTime();
  const s = Math.max(startMs, wStart);
  const e = Math.min(endMs, wEnd);
  if (e <= s) return null;
  return { startMs: s, endMs: e };
}

// ─── Per-participant task lookup ────────────────────────────────────────────

/**
 * All tasks the participant is assigned to that intersect the given day window.
 * Sorted by start time ascending — render order on the lane.
 */
export function getParticipantTasksForDay(schedule: Schedule, participantId: string, dayIndex: number): Task[] {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;

  const taskIds = new Set<string>();
  for (const a of schedule.assignments) {
    if (a.participantId === participantId) taskIds.add(a.taskId);
  }
  if (taskIds.size === 0) return [];

  const out: Task[] = [];
  for (const t of schedule.tasks) {
    if (!taskIds.has(t.id)) continue;
    if (taskIntersectsDay(t, dayIndex, dsh, base)) out.push(t);
  }
  out.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());
  return out;
}

// ─── Unavailability bands ───────────────────────────────────────────────────

/**
 * Compute the union of unavailability bands for a participant on a given
 * operational day, clipped to the day window. Sources merged:
 *
 *   1. `participant.dateUnavailability` rules whose [dayIndex, endDayIndex]
 *      range covers the displayed day. Time math mirrors
 *      `isBlockedByDateUnavailability` (same `hourInOpDay` helper, same
 *      same-day wrap behavior for partial-hour rules).
 *   2. `schedule.scheduleUnavailability` entries (Future-SOS windows scoped
 *      to this snapshot) for this participant.
 *
 * Bands are NOT merged/deduplicated — overlapping bands paint the same
 * pixels twice, which is harmless visually. Empty list when fully available.
 */
export function getUnavailabilityBandsForDay(participant: Participant, schedule: Schedule, dayIndex: number): Band[] {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const win = getDayWindow(dayIndex, dsh, base);
  const bands: Band[] = [];

  // 1) DateUnavailability rules.
  for (const rule of participant.dateUnavailability ?? []) {
    if (!Number.isInteger(rule.dayIndex)) continue;
    const startIdx = Math.max(1, rule.dayIndex);
    const endIdx = Math.min(schedule.periodDays, rule.endDayIndex ?? rule.dayIndex);
    if (endIdx < startIdx) continue;
    if (dayIndex < startIdx || dayIndex > endIdx) continue;

    let blockStartMs: number;
    let blockEndMs: number;
    if (rule.allDay) {
      blockStartMs = new Date(base.getFullYear(), base.getMonth(), base.getDate() + startIdx - 1, dsh, 0).getTime();
      blockEndMs = new Date(base.getFullYear(), base.getMonth(), base.getDate() + endIdx, dsh, 0).getTime();
    } else {
      blockStartMs = hourInOpDay(base, dsh, startIdx, rule.startHour);
      blockEndMs = hourInOpDay(base, dsh, endIdx, rule.endHour);
      if (blockEndMs <= blockStartMs) {
        blockEndMs = blockEndMs + 24 * 3600 * 1000;
      }
    }
    const clipped = clipBandToDay(blockStartMs, blockEndMs, win);
    if (clipped) bands.push(clipped);
  }

  // 2) Schedule-scoped unavailability (Future-SOS).
  for (const su of schedule.scheduleUnavailability ?? []) {
    if (su.participantId !== participant.id) continue;
    const clipped = clipBandToDay(su.start.getTime(), su.end.getTime(), win);
    if (clipped) bands.push(clipped);
  }

  return bands;
}

/**
 * Convenience: total covered ms within the day. Used to detect "fully out
 * today" without merging bands (we approximate by summing min(coverage,
 * windowMs) — exact merging is not needed because `dateUnavailability` rules
 * for a single day rarely overlap, and a "mostly out" lane reads the same as
 * "fully out" visually). The full-out chip is only shown when coverage ≥ 99%
 * of the day window.
 */
export function isAllDayUnavailable(bands: Band[], win: DayWindow): boolean {
  if (bands.length === 0) return false;
  const total = win.end.getTime() - win.start.getTime();
  if (total <= 0) return false;
  let covered = 0;
  for (const b of bands) covered += b.endMs - b.startMs;
  return covered >= total * 0.99;
}

// ─── Day-totals (delegated; thin wrapper for renderer ergonomics) ───────────

/**
 * Sum of raw clock hours (clipped to the displayed day) the participant is
 * assigned. Mirrors `computePerDayHours` from schedule-utils — using a local
 * helper avoids the renderer building the Map for every participant just to
 * read one cell.
 */
export function totalAssignedHoursForDay(schedule: Schedule, participantId: string, dayIndex: number): number {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const win = getDayWindow(dayIndex, dsh, base);
  const winStart = win.start.getTime();
  const winEnd = win.end.getTime();

  // Walk assignments → tasks once; avoids materializing a taskMap when there
  // are few assignments per participant.
  const taskById = new Map<string, Task>();
  for (const t of schedule.tasks) taskById.set(t.id, t);

  let hours = 0;
  for (const a of schedule.assignments) {
    if (a.participantId !== participantId) continue;
    const task = taskById.get(a.taskId);
    if (!task) continue;
    const s = Math.max(task.timeBlock.start.getTime(), winStart);
    const e = Math.min(task.timeBlock.end.getTime(), winEnd);
    if (e > s) hours += (e - s) / 3600000;
  }
  return hours;
}
