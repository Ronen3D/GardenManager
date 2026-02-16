/**
 * L1 Adanit Duty Cycle Tracker
 *
 * Enforces the strict 8-8-8-16 rotation for L1 participants in Adanit:
 *   8h Work → 8h Rest → 8h Work → 16h Rest → repeat
 *
 * Total cycle period = 40 hours.
 *
 * Stagger logic: L1 participants are divided into stagger groups so that
 * not all L1s start their cycle on the same shift. The stagger offset
 * distributes starts across the 40h cycle period.
 */

import { addHours, isBefore, isAfter, isEqual } from 'date-fns';
import {
  L1CyclePhase,
  L1CycleState,
  Participant,
  Task,
  TimeBlock,
  Assignment,
} from '../models/types';

/** Full cycle period in hours */
export const CYCLE_PERIOD_HOURS = 40;
/** Phase durations in hours */
export const PHASE_DURATIONS: Record<L1CyclePhase, number> = {
  [L1CyclePhase.Work1]: 8,
  [L1CyclePhase.Rest8]: 8,
  [L1CyclePhase.Work2]: 8,
  [L1CyclePhase.Rest16]: 16,
};

/** Ordered phases in the cycle */
const PHASE_ORDER: L1CyclePhase[] = [
  L1CyclePhase.Work1,
  L1CyclePhase.Rest8,
  L1CyclePhase.Work2,
  L1CyclePhase.Rest16,
];

/**
 * Get the next phase after the given one.
 */
export function nextPhase(phase: L1CyclePhase): L1CyclePhase {
  const idx = PHASE_ORDER.indexOf(phase);
  return PHASE_ORDER[(idx + 1) % PHASE_ORDER.length];
}

/**
 * Initialize L1 cycle states for all L1 participants assigned to Adanit.
 * Staggers their start times so they don't all begin on the same shift.
 *
 * @param l1Participants - All L1-level participants
 * @param weekStart - Start of the 7-day window (e.g., Day 1 05:00)
 * @returns Map of participantId → L1CycleState
 */
export function initializeL1Cycles(
  l1Participants: Participant[],
  weekStart: Date,
): Map<string, L1CycleState> {
  const states = new Map<string, L1CycleState>();

  // Stagger: distribute L1s across different starting phases/times
  // With 40h cycle and 8h shifts:
  // Group 0: starts Work1 at T+0
  // Group 1: starts Work1 at T+8 (offset by one shift)
  // Group 2: starts Work1 at T+16
  // Group 3: starts Work1 at T+24
  // Group 4: starts Work1 at T+32
  // This gives us 5 stagger slots within a 40h cycle

  const staggerSlots = Math.floor(CYCLE_PERIOD_HOURS / 8); // 5

  l1Participants.forEach((p, idx) => {
    const staggerIndex = idx % staggerSlots;
    const offsetHours = staggerIndex * 8;
    const phaseStart = addHours(weekStart, offsetHours);
    const phaseEnd = addHours(phaseStart, PHASE_DURATIONS[L1CyclePhase.Work1]);

    states.set(p.id, {
      participantId: p.id,
      phase: L1CyclePhase.Work1,
      phaseStart,
      phaseEnd,
      staggerIndex,
    });
  });

  return states;
}

/**
 * Get the full cycle timeline for an L1 participant over a 7-day window.
 * Returns an array of all phases with their time boundaries.
 */
export function getFullCycleTimeline(
  state: L1CycleState,
  weekEnd: Date,
): Array<{ phase: L1CyclePhase; start: Date; end: Date }> {
  const timeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }> = [];

  // Compute from the beginning of the cycle period
  const staggerOffset = state.staggerIndex * 8;
  // Walk backwards to find the true cycle start before or at weekStart
  let cursor = addHours(state.phaseStart, -staggerOffset);

  // Start from the initial cycle position
  let currentPhase = L1CyclePhase.Work1;
  let phaseStart = cursor;

  while (isBefore(phaseStart, weekEnd)) {
    const duration = PHASE_DURATIONS[currentPhase];
    const phaseEnd = addHours(phaseStart, duration);

    timeline.push({ phase: currentPhase, start: phaseStart, end: phaseEnd });

    currentPhase = nextPhase(currentPhase);
    phaseStart = phaseEnd;
  }

  return timeline;
}

/**
 * Check if an L1 participant is in a work phase at a given time,
 * based on their cycle state.
 */
export function isInWorkPhase(
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
  time: Date,
): boolean {
  for (const entry of cycleTimeline) {
    if (
      (entry.phase === L1CyclePhase.Work1 || entry.phase === L1CyclePhase.Work2) &&
      (isEqual(time, entry.start) || isAfter(time, entry.start)) &&
      isBefore(time, entry.end)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an L1 participant is in a rest phase at a given time.
 */
export function isInRestPhase(
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
  time: Date,
): { inRest: boolean; restEndsAt?: Date } {
  for (const entry of cycleTimeline) {
    if (
      (entry.phase === L1CyclePhase.Rest8 || entry.phase === L1CyclePhase.Rest16) &&
      (isEqual(time, entry.start) || isAfter(time, entry.start)) &&
      isBefore(time, entry.end)
    ) {
      return { inRest: true, restEndsAt: entry.end };
    }
  }
  return { inRest: false };
}

/**
 * Check if an Adanit task's time block aligns with a work phase
 * in the L1 participant's cycle.
 * The task must be fully contained within a work phase.
 */
export function isTaskAlignedWithCycle(
  taskBlock: TimeBlock,
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
): boolean {
  for (const entry of cycleTimeline) {
    if (entry.phase === L1CyclePhase.Work1 || entry.phase === L1CyclePhase.Work2) {
      const startsWithin =
        (isEqual(taskBlock.start, entry.start) || isAfter(taskBlock.start, entry.start)) &&
        (isBefore(taskBlock.start, entry.end));
      const endsWithin =
        (isAfter(taskBlock.end, entry.start)) &&
        (isEqual(taskBlock.end, entry.end) || isBefore(taskBlock.end, entry.end));
      if (startsWithin && endsWithin) return true;
    }
  }
  return false;
}

/**
 * Get the work windows for an L1 participant within a time range.
 * Returns the TimeBlocks where the participant should be working Adanit.
 */
export function getWorkWindows(
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
  rangeStart: Date,
  rangeEnd: Date,
): TimeBlock[] {
  const windows: TimeBlock[] = [];
  for (const entry of cycleTimeline) {
    if (entry.phase === L1CyclePhase.Work1 || entry.phase === L1CyclePhase.Work2) {
      // Clip to range
      const start = isAfter(entry.start, rangeStart) ? entry.start : rangeStart;
      const end = isBefore(entry.end, rangeEnd) ? entry.end : rangeEnd;
      if (isBefore(start, end)) {
        windows.push({ start, end });
      }
    }
  }
  return windows;
}

/**
 * Get the rest windows for an L1 participant within a time range.
 */
export function getRestWindows(
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
  rangeStart: Date,
  rangeEnd: Date,
): Array<{ start: Date; end: Date; type: 'rest8' | 'rest16' }> {
  const windows: Array<{ start: Date; end: Date; type: 'rest8' | 'rest16' }> = [];
  for (const entry of cycleTimeline) {
    if (entry.phase === L1CyclePhase.Rest8 || entry.phase === L1CyclePhase.Rest16) {
      const start = isAfter(entry.start, rangeStart) ? entry.start : rangeStart;
      const end = isBefore(entry.end, rangeEnd) ? entry.end : rangeEnd;
      if (isBefore(start, end)) {
        windows.push({
          start,
          end,
          type: entry.phase === L1CyclePhase.Rest8 ? 'rest8' : 'rest16',
        });
      }
    }
  }
  return windows;
}

/** Minimum hours of zero-assignment gap required before an L1 can start an Adanit shift. */
export const ADANIT_PRE_GAP_HOURS = 8;

/**
 * Check whether an L1 participant has at least ADANIT_PRE_GAP_HOURS of free time
 * (zero assignments) immediately before a proposed Adanit task.
 *
 * @param adanitStart - Start time of the proposed Adanit shift
 * @param existingAssignments - All current assignments for this participant
 * @param taskMap - Map of taskId → Task for looking up time blocks
 * @returns true if the pre-gap is satisfied (safe to assign)
 */
export function hasAdanitPreGap(
  adanitStart: Date,
  existingAssignments: Array<{ taskId: string }>,
  taskMap: Map<string, { timeBlock: { start: Date; end: Date }; isLight: boolean }>,
): boolean {
  const gapStart = new Date(adanitStart.getTime() - ADANIT_PRE_GAP_HOURS * 3600000);
  // Check if any non-light assignment ends within the pre-gap window
  for (const a of existingAssignments) {
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    // Any task (including light) that overlaps the pre-gap window disqualifies
    if (task.timeBlock.end.getTime() > gapStart.getTime() &&
        task.timeBlock.start.getTime() < adanitStart.getTime()) {
      return false;
    }
  }
  return true;
}

/**
 * For a given L1 participant's cycle timeline, find the next upcoming work phase
 * start time after a given point.
 *
 * Used by the optimizer to check whether assigning a general task now would
 * violate the pre-gap requirement for an upcoming Adanit work phase.
 */
export function getNextWorkPhaseStart(
  cycleTimeline: Array<{ phase: L1CyclePhase; start: Date; end: Date }>,
  afterTime: Date,
): Date | null {
  for (const entry of cycleTimeline) {
    if ((entry.phase === L1CyclePhase.Work1 || entry.phase === L1CyclePhase.Work2) &&
        entry.start.getTime() > afterTime.getTime()) {
      return entry.start;
    }
  }
  return null;
}

/**
 * Compute workload statistics for all participants over a 7-day window.
 */
export function computeWeeklyWorkloads(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): Map<string, { totalHours: number; nonLightCount: number }> {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const result = new Map<string, { totalHours: number; nonLightCount: number }>();

  for (const p of participants) {
    let totalHours = 0;
    let nonLightCount = 0;

    for (const a of assignments) {
      if (a.participantId !== p.id) continue;
      const task = taskMap.get(a.taskId);
      if (!task) continue;

      // Light tasks (Karovit) contribute 0 hours to workload — treated as "Active Rest"
      if (!task.isLight) {
        const hours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
        totalHours += hours;
        nonLightCount++;
      }
    }

    result.set(p.id, { totalHours, nonLightCount });
  }

  return result;
}
