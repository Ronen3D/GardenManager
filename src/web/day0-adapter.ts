/**
 * Day 0 adapter — turn a schedule's `continuitySnapshot` into a synthetic
 * `Schedule` shape so the existing swimlane / grid renderers, profile agenda
 * card, PDF page, and Excel sheet can render it unchanged.
 *
 * Read-only: the synthetic schedule's tasks/assignments/participants exist
 * only for display. Day 0 is never aggregated into period totals or fairness.
 */

import type { Assignment, Participant, Schedule, Task } from '../models/types';
import { AssignmentStatus, Level } from '../models/types';
import type { ContinuityAssignment, ContinuityParticipant } from '../models/continuity-schema';
import { getDayWindow } from './schedule-utils';

// ─── Foreign-participant marker ─────────────────────────────────────────────

/**
 * Custom property added to synthetic Day-0 participants whose name does NOT
 * appear in the current schedule's participant list. Used by renderers to
 * show an "אינו בשבצ"ק הנוכחי" badge.
 */
export const DAY0_FOREIGN_FLAG = '__day0Foreign' as const;

export type Day0Participant = Participant & { [DAY0_FOREIGN_FLAG]?: boolean };

export function isDay0Foreign(p: Participant | null | undefined): boolean {
  if (!p) return false;
  return (p as Day0Participant)[DAY0_FOREIGN_FLAG] === true;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Build a synthetic `Schedule` whose `tasks`/`assignments`/`participants`
 * come from the parent schedule's continuity snapshot. Reuses the parent's
 * frozen `algorithmSettings`, `periodStart`, `certLabelSnapshot` so the
 * existing renderers compute day windows, certifications, and live-mode
 * checks identically.
 *
 * Returns `null` when no continuity is attached.
 */
export function buildDay0Schedule(parent: Schedule): Schedule | null {
  const snap = parent.continuitySnapshot;
  if (!snap) return null;

  // Build name → existing-participant lookup so matched names get their real
  // Participant record (and id), preserving group/level/cert continuity with
  // the rest of the UI (profile clicks, swimlane grouping, color stripes).
  const byName = new Map<string, Participant>();
  for (const p of parent.participants) byName.set(p.name, p);

  const participants: Day0Participant[] = [];
  const tasks: Task[] = [];
  const assignments: Assignment[] = [];
  let idx = 0;

  for (const cp of snap.participants) {
    const matched = byName.get(cp.name);
    const synthetic: Day0Participant = matched ? matched : foreignParticipant(cp);
    participants.push(synthetic);

    for (const ca of cp.assignments) {
      const taskId = `day0-t-${idx}`;
      const asgnId = `day0-a-${idx}`;
      idx++;
      tasks.push(continuityAssignmentToDisplayTask(taskId, ca));
      assignments.push({
        id: asgnId,
        taskId,
        slotId: 'day0-slot',
        participantId: synthetic.id,
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      });
    }
  }

  return {
    id: `${parent.id}-day0`,
    tasks,
    participants,
    assignments,
    feasible: true,
    score: parent.score,
    violations: [],
    generatedAt: parent.generatedAt,
    algorithmSettings: parent.algorithmSettings,
    periodStart: parent.periodStart,
    periodDays: parent.periodDays,
    restRuleSnapshot: parent.restRuleSnapshot,
    certLabelSnapshot: parent.certLabelSnapshot,
    scheduleUnavailability: [],
    capabilityLoss: [],
  };
}

/**
 * Sum of clipped clock hours a single participant spent on Day 0 (the prior
 * 24h window). Counts only tasks attributed to this participant in the
 * snapshot. Used by the workload sparkline as a leading "0" cell — never
 * folded into period totals.
 *
 * Matches by the participant's `name` against the snapshot (the same key
 * the engine and adapter use). Returns 0 when there's no continuity, no
 * matching name, or no overlap with the Day 0 window.
 */
export function getDay0HoursForParticipant(schedule: Schedule, participantId: string): number {
  const snap = schedule.continuitySnapshot;
  if (!snap) return 0;
  const p = schedule.participants.find((q) => q.id === participantId);
  if (!p) return 0;

  const cp = snap.participants.find((q) => q.name === p.name);
  if (!cp) return 0;

  const dsh = schedule.algorithmSettings.dayStartHour;
  const win = getDayWindow(0, dsh, schedule.periodStart);
  const winStart = win.start.getTime();
  const winEnd = win.end.getTime();

  let total = 0;
  for (const ca of cp.assignments) {
    const tStart = new Date(ca.timeBlock.start).getTime();
    const tEnd = new Date(ca.timeBlock.end).getTime();
    const overlapStart = Math.max(tStart, winStart);
    const overlapEnd = Math.min(tEnd, winEnd);
    if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 3600000;
  }
  return total;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function continuityAssignmentToDisplayTask(taskId: string, ca: ContinuityAssignment): Task {
  return {
    id: taskId,
    name: ca.taskName,
    sourceName: ca.sourceName,
    timeBlock: {
      start: new Date(ca.timeBlock.start),
      end: new Date(ca.timeBlock.end),
    },
    requiredCount: 1,
    slots: [
      {
        slotId: 'day0-slot',
        acceptableLevels: [],
        requiredCertifications: [],
      },
    ],
    baseLoadWeight: ca.baseLoadWeight,
    loadWindows: ca.loadWindows?.map((lw) => ({
      id: lw.id,
      startHour: lw.startHour,
      startMinute: lw.startMinute,
      endHour: lw.endHour,
      endMinute: lw.endMinute,
      weight: lw.weight,
      blocksAtBoundary: lw.blocksAtBoundary,
    })),
    sameGroupRequired: false,
    blocksConsecutive: ca.blocksConsecutive,
    restRuleId: ca.restRuleId,
    color: ca.color || '#95A5A6',
  };
}

function foreignParticipant(cp: ContinuityParticipant): Day0Participant {
  const safeId = `day0-p-${cp.name.replace(/\s+/g, '_')}`;
  const lvl = numberToLevel(cp.level);
  return {
    id: safeId,
    name: cp.name,
    level: lvl,
    certifications: [...cp.certifications],
    group: cp.group,
    availability: [],
    dateUnavailability: [],
    [DAY0_FOREIGN_FLAG]: true,
  };
}

function numberToLevel(n: number): Level {
  if (n === Level.L4) return Level.L4;
  if (n === Level.L3) return Level.L3;
  if (n === Level.L2) return Level.L2;
  return Level.L0;
}
