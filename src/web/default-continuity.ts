/**
 * Default Day 0 ContinuitySnapshot — seeded on first launch (empty
 * localStorage) so HC-5/HC-12/HC-14 cross-boundary phantom enforcement
 * is exercised out of the box. See `src/engine/phantom.ts` for how this
 * snapshot is consumed during schedule generation.
 *
 * ⚠️ REGENERATE THIS FILE WHENEVER `seedDefaultParticipants()` OR
 *    `seedDefaultTaskTemplates()` IN `src/web/config-store.ts` CHANGES.
 *
 *    The participant `name` field is the matching key against the seeded
 *    participants — if any name in this file is missing from the seed
 *    (rename, removal), that phantom assignment is silently dropped and
 *    HC-12/HC-14 enforcement weakens without warning.
 *
 *    Same for task templates: if `אדנית` or `חממה` are renamed/removed,
 *    the phantom `sourceName` references will mismatch the new templates.
 *
 *    Regeneration is manual: edit `CANONICAL_DEFAULT_CONTINUITY` below to
 *    reflect the new participants/templates, then update CLAUDE.md if the
 *    semantics of the demo snapshot changed.
 */

import type { ContinuitySnapshot } from '../models/continuity-schema';

// ─── Canonical-form snapshot ────────────────────────────────────────────────
//
// Time fields are stored as ms offsets from `scheduleDate.getTime()`.  At
// seed time, `buildDefaultContinuityJson()` converts each offset into an
// absolute ISO string anchored at the active schedule date.  This keeps
// the snapshot timezone-independent and avoids stale calendar dates as
// the user changes their schedule period.
//
// Layout convention (assuming `dayStartHour = 5`):
//   - Day 1 op-day starts at scheduleDate + 5h (= 05:00 calendar day 1)
//   - Day 0 op-day starts at scheduleDate - 19h
//   - Day 0 op-day ends   at scheduleDate + 5h

interface CanonicalAssignment {
  sourceName: string;
  taskName: string;
  /** ms offset of timeBlock.start from `scheduleDate`. */
  startOffsetMs: number;
  /** ms offset of timeBlock.end   from `scheduleDate`. */
  endOffsetMs: number;
  blocksConsecutive: boolean;
  baseLoadWeight?: number;
  /** When true, runtime substitutes the active default rest rule id. */
  hasDefaultRestRule?: boolean;
  /** Required when `hasDefaultRestRule` is true. */
  restRuleDurationHours?: number;
  color?: string;
}

interface CanonicalParticipant {
  name: string;
  level: number;
  certifications: string[];
  group: string;
  assignments: CanonicalAssignment[];
}

interface CanonicalSnapshot {
  /** dayWindow.start offset (ms from scheduleDate). */
  dayWindowStartOffsetMs: number;
  /** dayWindow.end   offset (ms from scheduleDate). */
  dayWindowEndOffsetMs: number;
  participants: CanonicalParticipant[];
}

const HOUR_MS = 3600000;

// ─── Hand-crafted Day 0 snapshot ────────────────────────────────────────────
//
// Demonstrates cross-schedule constraint enforcement on first launch:
//
//   • 3 participants from קבוצה 1 worked אדנית shift 3 (night) yesterday,
//     ending exactly at Day 1 op-day start (05:00).  HC-12 (blocksConsecutive)
//     and HC-14 (5h rest rule) prevent them from any Day-1 morning rest-rule
//     or blocksConsecutive task.
//
//   • 1 participant from קבוצה 2 worked חממה shift 2 (18:00 → 06:00) yesterday.
//     The end at 06:00 (calendar Day 1) overlaps with any Day-1 task starting
//     at 05:00, so HC-5 (no double-booking) blocks them from morning slots.
//
// All names below MUST exist in seedDefaultParticipants().  Levels and
// certifications are duplicated here for snapshot independence.

const CANONICAL_DEFAULT_CONTINUITY: CanonicalSnapshot = {
  dayWindowStartOffsetMs: -19 * HOUR_MS, //  Day 0 op-day start (scheduleDate - 19h)
  dayWindowEndOffsetMs: 5 * HOUR_MS, //      Day 0 op-day end / Day 1 op-day start
  participants: [
    // ── קבוצה 1 — אדנית shift 3, סגול ראשי ────────────────────────────────
    {
      name: 'נועה אברהמי',
      level: 3,
      certifications: ['Nitzan', 'Hamama'],
      group: 'קבוצה 1',
      assignments: [
        {
          sourceName: 'אדנית',
          taskName: 'אדנית D0 (משמרת 3)',
          startOffsetMs: -3 * HOUR_MS, //  21:00 day 0
          endOffsetMs: 5 * HOUR_MS, //     05:00 day 1
          blocksConsecutive: true,
          baseLoadWeight: 1,
          hasDefaultRestRule: true,
          restRuleDurationHours: 5,
          color: '#4A90D9',
        },
      ],
    },
    {
      name: 'עידו כהן',
      level: 0,
      certifications: ['Nitzan'],
      group: 'קבוצה 1',
      assignments: [
        {
          sourceName: 'אדנית',
          taskName: 'אדנית D0 (משמרת 3)',
          startOffsetMs: -3 * HOUR_MS,
          endOffsetMs: 5 * HOUR_MS,
          blocksConsecutive: true,
          baseLoadWeight: 1,
          hasDefaultRestRule: true,
          restRuleDurationHours: 5,
          color: '#4A90D9',
        },
      ],
    },
    {
      name: 'מיכל אשכנזי',
      level: 0,
      certifications: ['Nitzan', 'Hamama'],
      group: 'קבוצה 1',
      assignments: [
        {
          sourceName: 'אדנית',
          taskName: 'אדנית D0 (משמרת 3)',
          startOffsetMs: -3 * HOUR_MS,
          endOffsetMs: 5 * HOUR_MS,
          blocksConsecutive: true,
          baseLoadWeight: 1,
          hasDefaultRestRule: true,
          restRuleDurationHours: 5,
          color: '#4A90D9',
        },
      ],
    },
    // ── קבוצה 2 — חממה shift 2 (night) ────────────────────────────────────
    {
      name: 'גיא מור',
      level: 0,
      certifications: ['Nitzan', 'Hamama'],
      group: 'קבוצה 2',
      assignments: [
        {
          sourceName: 'חממה',
          taskName: 'חממה D0 (משמרת 2)',
          startOffsetMs: -6 * HOUR_MS, // 18:00 day 0
          endOffsetMs: 6 * HOUR_MS, //    06:00 day 1
          blocksConsecutive: true,
          baseLoadWeight: 5 / 6,
          color: '#E74C3C',
        },
      ],
    },
  ],
};

// ─── Public helper ──────────────────────────────────────────────────────────

/**
 * Build a JSON-serialised ContinuitySnapshot for the current `scheduleDate`,
 * with the default rest rule's id substituted into rest-rule-bearing
 * assignments so HC-14 pairs against the new schedule's rule.
 *
 * Returned string is suitable for assignment to the app-level
 * `_continuityJson` buffer; it parses cleanly via `parseContinuitySnapshot`.
 */
export function buildDefaultContinuityJson(scheduleDate: Date, defaultRestRuleId: string): string {
  const base = scheduleDate.getTime();
  const snap: ContinuitySnapshot = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex: 1,
    dayWindow: {
      start: new Date(base + CANONICAL_DEFAULT_CONTINUITY.dayWindowStartOffsetMs).toISOString(),
      end: new Date(base + CANONICAL_DEFAULT_CONTINUITY.dayWindowEndOffsetMs).toISOString(),
    },
    participants: CANONICAL_DEFAULT_CONTINUITY.participants.map((cp) => ({
      name: cp.name,
      level: cp.level,
      certifications: [...cp.certifications],
      group: cp.group,
      assignments: cp.assignments.map((ca) => ({
        sourceName: ca.sourceName,
        taskName: ca.taskName,
        timeBlock: {
          start: new Date(base + ca.startOffsetMs).toISOString(),
          end: new Date(base + ca.endOffsetMs).toISOString(),
        },
        blocksConsecutive: ca.blocksConsecutive,
        baseLoadWeight: ca.baseLoadWeight,
        restRuleId: ca.hasDefaultRestRule ? defaultRestRuleId : undefined,
        restRuleDurationHours: ca.hasDefaultRestRule ? ca.restRuleDurationHours : undefined,
        color: ca.color,
      })),
    })),
  };
  return JSON.stringify(snap, null, 2);
}
