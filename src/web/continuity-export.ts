/**
 * Continuity Export — builds a ContinuitySnapshot JSON for a given day
 * of an existing schedule.  The snapshot captures each participant's
 * assignments with all constraint-relevant task properties so that a
 * future schedule can enforce HC-5, HC-12, and HC-14 across the boundary.
 */

import { Schedule, Task } from '../models/types';
import {
  ContinuitySnapshot,
  ContinuityParticipant,
  ContinuityAssignment,
  ContinuityLoadWindow,
} from '../models/continuity-schema';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a ContinuitySnapshot for a single day of a schedule.
 *
 * @param schedule        The generated schedule
 * @param dayIndex        1-based day index
 * @param scheduleBaseDate The schedule's start date (midnight of day 1)
 * @param dayStartHour    Hour that defines the start of a "day" (default 5)
 */
export function exportDaySnapshot(
  schedule: Schedule,
  dayIndex: number,
  scheduleBaseDate: Date,
  dayStartHour: number = 5,
): ContinuitySnapshot {
  // Compute day window — same formula as getDayWindow() in app.ts
  const dayStart = new Date(
    scheduleBaseDate.getFullYear(),
    scheduleBaseDate.getMonth(),
    scheduleBaseDate.getDate() + dayIndex - 1,
    dayStartHour, 0,
  );
  const dayEnd = new Date(
    scheduleBaseDate.getFullYear(),
    scheduleBaseDate.getMonth(),
    scheduleBaseDate.getDate() + dayIndex,
    dayStartHour, 0,
  );

  // Find tasks that intersect this day window
  const dayTasks = schedule.tasks.filter(t =>
    t.timeBlock.start.getTime() < dayEnd.getTime() &&
    t.timeBlock.end.getTime() > dayStart.getTime(),
  );

  // Build participant map
  const pMap = new Map(schedule.participants.map(p => [p.id, p]));

  // Group assignments by participant for tasks on this day
  const dayTaskIds = new Set(dayTasks.map(t => t.id));
  const taskMap = new Map(dayTasks.map(t => [t.id, t]));

  const participantAssignments = new Map<string, ContinuityAssignment[]>();

  for (const a of schedule.assignments) {
    if (!dayTaskIds.has(a.taskId)) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;

    let list = participantAssignments.get(a.participantId);
    if (!list) {
      list = [];
      participantAssignments.set(a.participantId, list);
    }
    list.push(taskToContinuityAssignment(task));
  }

  // Build participant entries — only those with assignments on this day
  const participants: ContinuityParticipant[] = [];
  for (const [pid, assignments] of participantAssignments) {
    const p = pMap.get(pid);
    if (!p) continue;
    participants.push({
      name: p.name,
      level: p.level as number,
      certifications: p.certifications.map(c => String(c)),
      group: p.group,
      assignments,
    });
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex,
    dayWindow: {
      start: dayStart.toISOString(),
      end: dayEnd.toISOString(),
    },
    participants,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function taskToContinuityAssignment(task: Task): ContinuityAssignment {
  const loadWindows: ContinuityLoadWindow[] | undefined = task.loadWindows?.map(lw => ({
    id: lw.id,
    startHour: lw.startHour,
    startMinute: lw.startMinute,
    endHour: lw.endHour,
    endMinute: lw.endMinute,
    weight: lw.weight,
  }));

  return {
    taskType: String(task.type),
    taskName: task.name,
    timeBlock: {
      start: task.timeBlock.start.toISOString(),
      end: task.timeBlock.end.toISOString(),
    },
    blocksConsecutive: task.blocksConsecutive,
    requiresCategoryBreak: task.requiresCategoryBreak ?? false,
    isLight: task.isLight,
    baseLoadWeight: task.baseLoadWeight,
    loadWindows: loadWindows?.length ? loadWindows : undefined,
  };
}
