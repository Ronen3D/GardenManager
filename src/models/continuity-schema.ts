/**
 * Continuity Schema — JSON snapshot types for cross-schedule constraint bridging.
 *
 * When generating a new schedule, the user may provide a snapshot from the
 * previous schedule's final day.  The system converts this into "phantom"
 * assignments so that HC-5 (double-booking), HC-12 (consecutive high-load),
 * and HC-14 (rest-rule minimum gap) are enforced across the boundary.
 */

// ─── Snapshot Envelope ──────────────────────────────────────────────────────

export interface ContinuitySnapshot {
  /** Schema version for forward-compatibility checks. */
  schemaVersion: 1;
  /** ISO-8601 timestamp when the snapshot was exported. */
  exportedAt: string;
  /** 1-based day index within the original schedule. */
  dayIndex: number;
  /** Day window boundaries (ISO-8601). */
  dayWindow: {
    start: string;
    end: string;
  };
  /** Participants who had at least one assignment on this day. */
  participants: ContinuityParticipant[];
}

// ─── Per-Participant Data ───────────────────────────────────────────────────

export interface ContinuityParticipant {
  /** Display name — used as the matching key (IDs are transient). */
  name: string;
  /** Level enum numeric value (0, 2, 3, 4). */
  level: number;
  /** Certification enum string values. */
  certifications: string[];
  /** Group name. */
  group: string;
  /** Assignments for this participant on the exported day. */
  assignments: ContinuityAssignment[];
}

// ─── Per-Assignment Data ────────────────────────────────────────────────────

export interface ContinuityAssignment {
  /** Template source name (task identity). */
  sourceName: string;
  /** Human-readable task name. */
  taskName: string;
  /** Absolute time block (ISO-8601). Not clipped to day window. */
  timeBlock: {
    start: string;
    end: string;
  };
  /** HC-12: does this task block consecutive placement? */
  blocksConsecutive: boolean;
  /** HC-14: rest rule ID (if any) for minimum-gap enforcement. */
  restRuleId?: string;
  /** HC-14: snapshotted rule duration in hours (for cross-schedule phantom resolution). */
  restRuleDurationHours?: number;
  /** Is this a light task (Karovit)? */
  isLight: boolean;
  /** Base load weight outside hot windows (0..1). */
  baseLoadWeight?: number;
  /** Display color (hex). */
  color?: string;
  /** Weighted load windows within the task — needed by isHighLoadAtBoundary(). */
  loadWindows?: ContinuityLoadWindow[];
}

// ─── Load Window ────────────────────────────────────────────────────────────

export interface ContinuityLoadWindow {
  id: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  weight: number;
}
