/**
 * Phantom Context — converts a ContinuitySnapshot into synthetic Task and
 * Assignment objects that the optimizer seeds into its constraint-checking
 * indexes (taskMap, assignmentsByParticipant) so HC-5, HC-12, and HC-14
 * are enforced across schedule boundaries.
 *
 * Phantom tasks/assignments are NEVER added to the output Schedule — they
 * exist only in the optimizer's internal indexes during generation.
 */

import {
  Task,
  Assignment,
  Participant,
  AssignmentStatus,
} from '../models/types';
import {
  ContinuitySnapshot,
  ContinuityParticipant,
  ContinuityAssignment,
} from '../models/continuity-schema';

// ─── Public Types ───────────────────────────────────────────────────────────

export interface PhantomContext {
  /** Synthetic Task objects for constraint resolution via taskMap. */
  phantomTasks: Task[];
  /** Synthetic Assignment objects for per-participant indexes. */
  phantomAssignments: Assignment[];
  /** Set of phantom task IDs for easy identification/filtering. */
  phantomTaskIds: Set<string>;
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build a PhantomContext from a parsed ContinuitySnapshot and the new
 * schedule's participant list.
 *
 * Matching is by exact participant name.  Participants in the snapshot
 * but absent from `participants` are silently ignored.
 */
export function buildPhantomContext(
  snapshot: ContinuitySnapshot,
  participants: Participant[],
): PhantomContext {
  const phantomTasks: Task[] = [];
  const phantomAssignments: Assignment[] = [];
  const phantomTaskIds = new Set<string>();

  // Build name → new-participant lookup
  const byName = new Map<string, Participant>();
  for (const p of participants) {
    byName.set(p.name, p);
  }

  let idx = 0;

  for (const cp of snapshot.participants) {
    const matched = byName.get(cp.name);
    if (!matched) continue; // participant not in new schedule

    for (const ca of cp.assignments) {
      const taskId = `phantom-${idx}`;
      const asgnId = `phantom-asgn-${idx}`;
      idx++;

      const task = continuityAssignmentToTask(taskId, ca);
      phantomTasks.push(task);
      phantomTaskIds.add(taskId);

      phantomAssignments.push({
        id: asgnId,
        taskId,
        slotId: 'phantom-slot',
        participantId: matched.id,
        status: AssignmentStatus.Locked,
        updatedAt: new Date(),
      });
    }
  }

  return { phantomTasks, phantomAssignments, phantomTaskIds };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Convert a ContinuityAssignment into a minimal Task with constraint-relevant fields. */
function continuityAssignmentToTask(taskId: string, ca: ContinuityAssignment): Task {
  return {
    id: taskId,
    name: ca.taskName,
    sourceName: ca.sourceName,
    timeBlock: {
      start: new Date(ca.timeBlock.start),
      end: new Date(ca.timeBlock.end),
    },
    requiredCount: 0,
    slots: [],
    isLight: ca.isLight,
    baseLoadWeight: ca.baseLoadWeight,
    loadWindows: ca.loadWindows?.map(lw => ({
      id: lw.id,
      startHour: lw.startHour,
      startMinute: lw.startMinute,
      endHour: lw.endHour,
      endMinute: lw.endMinute,
      weight: lw.weight,
    })),
    sameGroupRequired: false,
    blocksConsecutive: ca.blocksConsecutive,
    requiresCategoryBreak: ca.requiresCategoryBreak,
    color: ca.color || '#95A5A6',
  };
}
