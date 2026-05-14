/**
 * Default Day 0 ContinuitySnapshot — seeded on first launch (empty
 * localStorage) so HC-5/HC-12/HC-14 cross-boundary phantom enforcement
 * is exercised out of the box across the entire default roster.  See
 * `src/engine/phantom.ts` for how the snapshot is consumed during
 * schedule generation, and `src/web/day0-adapter.ts` for the Day-0 view.
 *
 * ⚠️ REGENERATE THIS FILE WHENEVER `seedDefaultParticipants()` OR
 *    `seedDefaultTaskTemplates()` IN `src/web/config-store.ts` CHANGES.
 *
 *    The participant `name` field is the matching key against the seeded
 *    roster — a rename / removal in the seed silently drops the
 *    corresponding phantom inside `buildPhantomContext`, weakening
 *    cross-boundary enforcement without warning.  Same for `sourceName`:
 *    each entry in `DEFAULT_TASK_INSTANCES` must point at a real template
 *    in `seedDefaultTaskTemplates`.
 *
 *    The persistence test `I12: Default Day 0 continuity matches seed`
 *    (in `src/test-persistence.ts`) fails loudly when names drift in
 *    either direction — every seed name must appear in `DEFAULT_PARTICIPANT_PLAN`,
 *    every plan name + sourceName must resolve against the live seed,
 *    and level / certifications / group must match exactly.
 *
 *    Regeneration is manual: edit `DEFAULT_TASK_INSTANCES` (per task-shift
 *    time windows) and `DEFAULT_PARTICIPANT_PLAN` (per-group rosters with
 *    assigned `taskKeys`) to mirror the new seed.
 */

import type { ContinuityAssignment, ContinuityParticipant, ContinuitySnapshot } from '../models/continuity-schema';

// ─── Time anchor ────────────────────────────────────────────────────────────
//
// Time fields are stored as ms offsets from `scheduleDate.getTime()`.  At
// seed time, `buildDefaultContinuityJson()` converts each offset into an
// absolute ISO string anchored at the active schedule date — that keeps
// the snapshot timezone-independent and self-aligning when the user picks
// a new schedule period.
//
// Layout convention (assuming `dayStartHour = 5`):
//   - Day 1 op-day starts at scheduleDate + 5h   (= 05:00 calendar day 1)
//   - Day 0 op-day starts at scheduleDate − 19h  (= 05:00 calendar day 0)
//   - Day 0 op-day ends   at scheduleDate + 5h

const HOUR_MS = 3600000;

const DAY_WINDOW_START_OFFSET_MS = -19 * HOUR_MS;
const DAY_WINDOW_END_OFFSET_MS = 5 * HOUR_MS;

// ─── Task instance specs ────────────────────────────────────────────────────
//
// One entry per (template × shift) used on Day 0.  Hours and properties
// match the default seed in `seedDefaultTaskTemplates()`.  When
// `hasDefaultRestRule: true`, `buildDefaultContinuityJson` injects the
// active default rest-rule id at runtime — the snapshot stays decoupled
// from the rule's transient uid.

interface TaskInstanceSpec {
  readonly sourceName: string;
  readonly taskName: string;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly blocksConsecutive: boolean;
  readonly baseLoadWeight: number;
  readonly hasDefaultRestRule: boolean;
  readonly restRuleDurationHours?: number;
  readonly color: string;
}

export const DEFAULT_TASK_INSTANCES = {
  // אדנית — 8h × 3 shifts, startHour 5; shift 3 (21→05) is the cross-boundary
  // night shift that exercises HC-12 and HC-14 against Day 1 morning slots.
  'אדנית-sh1': {
    sourceName: 'אדנית',
    taskName: 'אדנית D0 (משמרת 1)',
    startOffsetMs: -19 * HOUR_MS,
    endOffsetMs: -11 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#4A90D9',
  },
  'אדנית-sh2': {
    sourceName: 'אדנית',
    taskName: 'אדנית D0 (משמרת 2)',
    startOffsetMs: -11 * HOUR_MS,
    endOffsetMs: -3 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#4A90D9',
  },
  'אדנית-sh3': {
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
  // חממה — 12h × 2 shifts, startHour 6.  Shift 2 (18→06) overlaps with the
  // first hour of Day 1 op-day → HC-5 cross-boundary check.
  'חממה-sh1': {
    sourceName: 'חממה',
    taskName: 'חממה D0 (משמרת 1)',
    startOffsetMs: -18 * HOUR_MS,
    endOffsetMs: -6 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 5 / 6,
    hasDefaultRestRule: false,
    color: '#E74C3C',
  },
  'חממה-sh2': {
    sourceName: 'חממה',
    taskName: 'חממה D0 (משמרת 2)',
    startOffsetMs: -6 * HOUR_MS,
    endOffsetMs: 6 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 5 / 6,
    hasDefaultRestRule: false,
    color: '#E74C3C',
  },
  // שמש — 4h × 6 shifts, startHour 5.  Shift 6 (01→05) ends exactly at Day 1
  // op-day start — second cross-boundary trigger for HC-12 / HC-14.
  'שמש-sh1': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 1)',
    startOffsetMs: -19 * HOUR_MS,
    endOffsetMs: -15 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  'שמש-sh2': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 2)',
    startOffsetMs: -15 * HOUR_MS,
    endOffsetMs: -11 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  'שמש-sh3': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 3)',
    startOffsetMs: -11 * HOUR_MS,
    endOffsetMs: -7 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  'שמש-sh4': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 4)',
    startOffsetMs: -7 * HOUR_MS,
    endOffsetMs: -3 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  'שמש-sh5': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 5)',
    startOffsetMs: -3 * HOUR_MS,
    endOffsetMs: 1 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  'שמש-sh6': {
    sourceName: 'שמש',
    taskName: 'שמש D0 (משמרת 6)',
    startOffsetMs: 1 * HOUR_MS,
    endOffsetMs: 5 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: true,
    restRuleDurationHours: 5,
    color: '#F39C12',
  },
  // כרוב — 8h × 3 shifts, startHour 5.  blocksConsecutive=false and no rest
  // rule on the seeded template, and the seed's `loadWindows` carry no
  // `blocksAtBoundary` flag — so כרוב phantoms here are historical context
  // only, no cross-boundary HC impact.  loadWindows are intentionally
  // omitted from the phantom shape (mirrors the rest of this file).
  'כרוב-sh1': {
    sourceName: 'כרוב',
    taskName: 'כרוב D0 (משמרת 1)',
    startOffsetMs: -19 * HOUR_MS,
    endOffsetMs: -11 * HOUR_MS,
    blocksConsecutive: false,
    baseLoadWeight: 8 / 24,
    hasDefaultRestRule: false,
    color: '#8E44AD',
  },
  'כרוב-sh2': {
    sourceName: 'כרוב',
    taskName: 'כרוב D0 (משמרת 2)',
    startOffsetMs: -11 * HOUR_MS,
    endOffsetMs: -3 * HOUR_MS,
    blocksConsecutive: false,
    baseLoadWeight: 8 / 24,
    hasDefaultRestRule: false,
    color: '#8E44AD',
  },
  'כרוב-sh3': {
    sourceName: 'כרוב',
    taskName: 'כרוב D0 (משמרת 3)',
    startOffsetMs: -3 * HOUR_MS,
    endOffsetMs: 5 * HOUR_MS,
    blocksConsecutive: false,
    baseLoadWeight: 8 / 24,
    hasDefaultRestRule: false,
    color: '#8E44AD',
  },
  // Short single-shift dailies — historical-only.
  'ערוגת-בוקר': {
    sourceName: 'ערוגת בוקר',
    taskName: 'ערוגת בוקר D0',
    startOffsetMs: -19 * HOUR_MS,
    endOffsetMs: -17.5 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: false,
    color: '#1ABC9C',
  },
  'ערוגת-ערב': {
    sourceName: 'ערוגת ערב',
    taskName: 'ערוגת ערב D0',
    startOffsetMs: -7 * HOUR_MS,
    endOffsetMs: -5.5 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    hasDefaultRestRule: false,
    color: '#1ABC9C',
  },
  ממטרה: {
    sourceName: 'ממטרה',
    taskName: 'ממטרה D0',
    startOffsetMs: -15 * HOUR_MS,
    endOffsetMs: -1 * HOUR_MS,
    blocksConsecutive: true,
    baseLoadWeight: 0.75,
    hasDefaultRestRule: false,
    color: '#27AE60',
  },
} as const satisfies Record<string, TaskInstanceSpec>;

export type TaskInstanceKey = keyof typeof DEFAULT_TASK_INSTANCES;

// ─── Per-participant plan ───────────────────────────────────────────────────
//
// Mirrors `seedDefaultParticipants()`: 4 groups × 12 members.  Each entry
// re-states `level` / `certifications` from the seed so the snapshot is
// self-contained — the persistence test asserts these match the seed.
// `taskKeys: []` marks intentional Day-0 idleness — kept here for design
// documentation and to let the drift test verify completeness, but filtered
// out of the snapshot output (matches "real export" shape where only
// participants who worked are listed).
//
// Coverage by design:
//   קבוצה 1 → אדנית sh3 (night, cross-boundary HC-12 / HC-14)
//   קבוצה 2 → אדנית sh2 (afternoon) + L4 in חממה sh2 (cross-boundary HC-5)
//   קבוצה 3 → אדנית sh1 (morning)
//   קבוצה 4 → כרוב sh1+2+3 (the sameGroup-required all-day rotation)
//   Spillover: חממה sh1 (L4 lowPrio), שמש sh1-sh6 (sh6 cross-boundary),
//              ערוגת בוקר/ערב, ממטרה (Horesh excluded by slot rules).
//   Idle (5): the spare L4s and L2s have no eligible misc slot once the
//             same-group seniors slots in אדנית / כרוב are saturated —
//             realistic "not everyone works every day".

interface ParticipantPlanEntry {
  readonly name: string;
  readonly level: 0 | 2 | 3 | 4;
  readonly certifications: readonly string[];
  readonly taskKeys: readonly TaskInstanceKey[];
}

export const DEFAULT_PARTICIPANT_PLAN: Readonly<Record<string, readonly ParticipantPlanEntry[]>> = {
  'קבוצה 1': [
    { name: 'איתי לוין', level: 4, certifications: ['Nitzan', 'Hamama'], taskKeys: ['חממה-sh1'] },
    { name: 'נועה אברהמי', level: 3, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh3'] },
    { name: 'יונתן רפאלי', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh3'] },
    { name: 'מאיה ישראלי', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: [] },
    { name: 'עידו כהן', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh3'] },
    { name: 'עדי מזרחי', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh3'] },
    { name: 'רועי שפירא', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['שמש-sh1'] },
    { name: 'מיכל אשכנזי', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['שמש-sh2'] },
    { name: 'עומר דרוקר', level: 0, certifications: ['Nitzan', 'Horesh'], taskKeys: ['אדנית-sh3'] },
    { name: 'ענבר חזן', level: 0, certifications: ['Nitzan', 'Horesh'], taskKeys: ['אדנית-sh3'] },
    { name: 'אורי גבאי', level: 0, certifications: ['Nitzan'], taskKeys: ['ערוגת-בוקר'] },
    { name: 'טל בן-דור', level: 0, certifications: ['Nitzan'], taskKeys: ['ערוגת-ערב'] },
  ],
  'קבוצה 2': [
    { name: 'דניאל וייס', level: 4, certifications: ['Nitzan', 'Hamama'], taskKeys: ['חממה-sh2'] },
    { name: 'שירה אדרי', level: 3, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh2'] },
    { name: 'נדב הראל', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh2'] },
    { name: 'ליאור פלד', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: [] },
    { name: 'אסף גרינברג', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh2'] },
    { name: 'רוני סגל', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh2'] },
    { name: 'גיא מור', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh2'] },
    { name: 'יעל שלום', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh2'] },
    { name: 'אלון ברק', level: 0, certifications: ['Nitzan', 'Horesh'], taskKeys: ['שמש-sh3'] },
    { name: 'הילה חדד', level: 0, certifications: ['Nitzan'], taskKeys: ['שמש-sh4'] },
    { name: 'מתן אלוני', level: 0, certifications: ['Nitzan'], taskKeys: ['ערוגת-בוקר'] },
    { name: 'שחר עמר', level: 0, certifications: ['Nitzan'], taskKeys: ['ערוגת-ערב'] },
  ],
  'קבוצה 3': [
    { name: 'איתן דהן', level: 4, certifications: ['Nitzan', 'Hamama'], taskKeys: [] },
    { name: 'עמית מלכה', level: 3, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh1'] },
    { name: 'דורון פרידמן', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh1'] },
    { name: 'נטע לביא', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: [] },
    { name: 'יובל קליין', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh1'] },
    { name: 'קרן אורן', level: 0, certifications: ['Nitzan'], taskKeys: ['אדנית-sh1'] },
    { name: 'אריאל נחום', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh1'] },
    { name: 'דנה צור', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['אדנית-sh1'] },
    { name: 'אביב סוויסה', level: 0, certifications: ['Nitzan', 'Horesh'], taskKeys: ['שמש-sh5'] },
    { name: 'גלית שדה', level: 0, certifications: ['Nitzan'], taskKeys: ['שמש-sh6'] },
    { name: 'תומר גולן', level: 0, certifications: ['Nitzan'], taskKeys: ['ממטרה'] },
    { name: 'ספיר מלמד', level: 0, certifications: ['Nitzan'], taskKeys: ['ממטרה'] },
  ],
  'קבוצה 4': [
    { name: 'אופיר ביטון', level: 4, certifications: ['Nitzan', 'Hamama'], taskKeys: [] },
    { name: 'נועם פרץ', level: 3, certifications: ['Nitzan', 'Hamama'], taskKeys: ['כרוב-sh3'] },
    { name: 'בועז נאמן', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: ['כרוב-sh2'] },
    { name: 'ליהי כץ', level: 2, certifications: ['Nitzan', 'Hamama'], taskKeys: ['כרוב-sh1'] },
    { name: 'אייל רוזנפלד', level: 0, certifications: ['Nitzan'], taskKeys: ['כרוב-sh1'] },
    { name: 'תמר יוספי', level: 0, certifications: ['Nitzan'], taskKeys: ['כרוב-sh1'] },
    { name: 'יואב פולק', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['כרוב-sh2'] },
    { name: 'סיון ריבלין', level: 0, certifications: ['Nitzan', 'Hamama'], taskKeys: ['כרוב-sh2'] },
    { name: 'אוהד שטרן', level: 0, certifications: ['Nitzan'], taskKeys: ['כרוב-sh3'] },
    { name: 'רותם גנות', level: 0, certifications: ['Nitzan'], taskKeys: ['כרוב-sh3'] },
    { name: 'ברק אוריון', level: 0, certifications: ['Nitzan'], taskKeys: ['שמש-sh6'] },
    { name: 'נעמה שקד', level: 0, certifications: ['Nitzan'], taskKeys: ['שמש-sh5'] },
  ],
};

// ─── Public builder ─────────────────────────────────────────────────────────

/**
 * Build a JSON-serialised ContinuitySnapshot for the current `scheduleDate`,
 * with the default rest rule's id substituted into rest-rule-bearing
 * assignments so HC-14 pairs against the new schedule's rule.
 *
 * Output is deterministic for identical inputs: same plan + same offsets →
 * same JSON content (modulo the `exportedAt` metadata stamp, which is not
 * consumed downstream).  Participants with `taskKeys: []` (intentionally
 * idle on Day 0) are omitted from the output — they exist in the plan
 * above only to document the design and to satisfy the drift test.
 */
export function buildDefaultContinuityJson(scheduleDate: Date, defaultRestRuleId: string): string {
  const base = scheduleDate.getTime();
  const participants: ContinuityParticipant[] = [];

  for (const [group, entries] of Object.entries(DEFAULT_PARTICIPANT_PLAN)) {
    for (const entry of entries) {
      if (entry.taskKeys.length === 0) continue;
      const assignments: ContinuityAssignment[] = entry.taskKeys.map((key) => {
        const spec = DEFAULT_TASK_INSTANCES[key];
        return {
          sourceName: spec.sourceName,
          taskName: spec.taskName,
          timeBlock: {
            start: new Date(base + spec.startOffsetMs).toISOString(),
            end: new Date(base + spec.endOffsetMs).toISOString(),
          },
          blocksConsecutive: spec.blocksConsecutive,
          baseLoadWeight: spec.baseLoadWeight,
          restRuleId: spec.hasDefaultRestRule ? defaultRestRuleId : undefined,
          restRuleDurationHours: spec.hasDefaultRestRule ? spec.restRuleDurationHours : undefined,
          color: spec.color,
        };
      });
      participants.push({
        name: entry.name,
        level: entry.level,
        certifications: [...entry.certifications],
        group,
        assignments,
      });
    }
  }

  const snap: ContinuitySnapshot = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex: 1,
    dayWindow: {
      start: new Date(base + DAY_WINDOW_START_OFFSET_MS).toISOString(),
      end: new Date(base + DAY_WINDOW_END_OFFSET_MS).toISOString(),
    },
    participants,
  };
  return JSON.stringify(snap, null, 2);
}
