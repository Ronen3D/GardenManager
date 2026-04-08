/**
 * Phantom Context — converts a ContinuitySnapshot into synthetic Task and
 * Assignment objects that the optimizer seeds into its constraint-checking
 * indexes (taskMap, assignmentsByParticipant) so HC-5, HC-12, and HC-14
 * are enforced across schedule boundaries.  Phantom rest rule durations
 * are collected so HC-14 can resolve cross-schedule rule thresholds.
 *
 * Phantom tasks/assignments are NEVER added to the output Schedule — they
 * exist only in the optimizer's internal indexes during generation.
 */

import { type ContinuityAssignment, ContinuityParticipant, type ContinuitySnapshot } from '../models/continuity-schema';
import { type Assignment, AssignmentStatus, type Participant, type Task } from '../models/types';

// ─── Public Types ───────────────────────────────────────────────────────────

export interface PhantomContext {
  /** Synthetic Task objects for constraint resolution via taskMap. */
  phantomTasks: Task[];
  /** Synthetic Assignment objects for per-participant indexes. */
  phantomAssignments: Assignment[];
  /** Set of phantom task IDs for easy identification/filtering. */
  phantomTaskIds: Set<string>;
  /** Snapshotted rest rule durations from the previous schedule (ruleId → durationMs). */
  phantomRestRules: Map<string, number>;
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build a PhantomContext from a parsed ContinuitySnapshot and the new
 * schedule's participant list.
 *
 * Matching is by exact participant name.  Participants in the snapshot
 * but absent from `participants` are silently ignored.
 */
export function buildPhantomContext(snapshot: ContinuitySnapshot, participants: Participant[]): PhantomContext {
  const phantomTasks: Task[] = [];
  const phantomAssignments: Assignment[] = [];
  const phantomTaskIds = new Set<string>();
  const phantomRestRules = new Map<string, number>();

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

      // Collect snapshotted rest rule durations for cross-schedule HC-14
      if (ca.restRuleId && ca.restRuleDurationHours != null && !phantomRestRules.has(ca.restRuleId)) {
        phantomRestRules.set(ca.restRuleId, ca.restRuleDurationHours * 3600000);
      }

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

  return { phantomTasks, phantomAssignments, phantomTaskIds, phantomRestRules };
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
    loadWindows: ca.loadWindows?.map((lw) => ({
      id: lw.id,
      startHour: lw.startHour,
      startMinute: lw.startMinute,
      endHour: lw.endHour,
      endMinute: lw.endMinute,
      weight: lw.weight,
    })),
    sameGroupRequired: false,
    blocksConsecutive: ca.blocksConsecutive,
    restRuleId: ca.restRuleId,
    color: ca.color || '#95A5A6',
  };
}

/**
 * Merge snapshotted rest rule durations from phantom context into the
 * active rest rule map.  Only adds entries for rule IDs that are NOT
 * already present — the current schedule's rules take precedence.
 */
export function mergePhantomRules(baseMap: Map<string, number>, context: PhantomContext): Map<string, number> {
  if (context.phantomRestRules.size === 0) return baseMap;
  const merged = new Map(baseMap);
  for (const [ruleId, durationMs] of context.phantomRestRules) {
    if (!merged.has(ruleId)) merged.set(ruleId, durationMs);
  }
  return merged;
}
