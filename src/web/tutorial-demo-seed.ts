/**
 * Tutorial demo seed — pure data + builders for the curated state the
 * tutorial runs against. Independent of `tutorial.ts` / `tutorial-content.ts`.
 * The orchestrator in `tutorial-demo.ts` writes this state into the store
 * before the tour starts and restores the user's real state on exit.
 *
 * Design constraints:
 * - Small enough to fit the participants/task-rules tabs at a glance (6 / 3 / 1).
 * - Realistic Hebrew names with no demo marker; the visible difference from the
 *   user's roster is the cue that this is curated data.
 * - One deliberate HC-1 violation (L0 in an L3+ slot) so step `s-7` (violations
 *   section) lights up.
 * - One empty future slot in day 2 so step `tp-2` (needs-attention card) lights up.
 * - Live-mode anchored mid-day-1 so steps `s-9` / `s-10` / `s-13` (live-mode UI)
 *   light up with a real schedule.
 */

import { type Assignment, AssignmentStatus, Level, type Participant, type Task } from '../index';

export interface DemoParticipantSpec {
  name: string;
  level: Level;
  group: string;
  certifications: string[];
}

/**
 * Roster is inserted in group order so the participants table — which renders
 * in `store.getAllParticipants()` insertion order by default — visibly groups
 * קבוצה 1 rows together, then קבוצה 2. Group 1 holds all the Hamama-cert
 * participants so חממה (sameGroupRequired + Hamama) is staffable from a
 * single group. Group counts are balanced 3 + 3 so the group-filter pills
 * each cover a meaningful slice.
 */
export const DEMO_PARTICIPANTS: DemoParticipantSpec[] = [
  { name: 'שרון בכר', level: Level.L4, group: 'קבוצה 1', certifications: ['Nitzan', 'Hamama'] },
  { name: 'דני לוי', level: Level.L3, group: 'קבוצה 1', certifications: ['Nitzan', 'Hamama'] },
  { name: 'תום פז', level: Level.L0, group: 'קבוצה 1', certifications: ['Nitzan', 'Hamama'] },
  { name: 'אריה כהן', level: Level.L3, group: 'קבוצה 2', certifications: ['Nitzan'] },
  { name: 'יעל אביב', level: Level.L2, group: 'קבוצה 2', certifications: ['Nitzan'] },
  { name: 'מאיה דור', level: Level.L0, group: 'קבוצה 2', certifications: ['Nitzan'] },
];

/** Schedule period for the demo: 2 operational days, dayStartHour = 5. */
export const DEMO_PERIOD_DAYS = 2;
export const DEMO_DAY_START_HOUR = 5;

/**
 * Curated assignment plan, expressed in human terms — the orchestrator looks
 * up the matching Task in the generated array and resolves slotId by index.
 *
 * `slotIndex` is the 0-based index within `task.slots`. The template
 * definitions below pin slot ordering deterministically:
 *   אדנית: [L0 משתתף, L3+ אחראי]
 *   חממה:  [L0+ מפעיל]
 *   שמירה: [L2+ שומר]
 *   ביקור משלחת: [L0+ מלווה, L0+ מלווה]
 */
export interface DemoAssignmentSpec {
  /** Matches `Task.sourceName`. */
  sourceName: string;
  /** 1-based schedule day index (1..DEMO_PERIOD_DAYS). */
  dayIndex: number;
  /** 1-based shift index within the day (matches `Task.shiftIndex`). */
  shiftIndex: number;
  /** 0-based slot index within `task.slots`. */
  slotIndex: number;
  /** Participant name (matched against DEMO_PARTICIPANTS). */
  participantName: string;
}

/**
 * The hand-authored assignment plan. Two intentional gaps:
 *
 *  1. **HC-1 violation** — `מאיה דור` (L0) assigned to the day-1 shift-1 L3+
 *     אחראי slot. `revalidateFull()` emits `LEVEL_MISMATCH`.
 *  2. **Empty future slot** — day-2 shift-2 L0 slot left unfilled. The
 *     validator emits `SLOT_UNFILLED`; the task-panel renders the needs-
 *     attention card.
 */
export const DEMO_ASSIGNMENTS: DemoAssignmentSpec[] = [
  // ── Day 1 ───────────────────────────────────────────────────────────────
  // אדנית shift 1 (frozen — before anchor)
  { sourceName: 'אדנית', dayIndex: 1, shiftIndex: 1, slotIndex: 0, participantName: 'תום פז' },
  { sourceName: 'אדנית', dayIndex: 1, shiftIndex: 1, slotIndex: 1, participantName: 'מאיה דור' }, // HC-1 violation
  // חממה (frozen — ends at anchor 12:00)
  { sourceName: 'חממה', dayIndex: 1, shiftIndex: 1, slotIndex: 0, participantName: 'דני לוי' },
  // אדנית shift 2 (future)
  { sourceName: 'אדנית', dayIndex: 1, shiftIndex: 2, slotIndex: 0, participantName: 'מאיה דור' },
  { sourceName: 'אדנית', dayIndex: 1, shiftIndex: 2, slotIndex: 1, participantName: 'שרון בכר' },
  // ביקור משלחת (one-time, future — see DEMO_ONE_TIME_TASK)
  { sourceName: 'ביקור משלחת', dayIndex: 1, shiftIndex: 1, slotIndex: 0, participantName: 'שרון בכר' },
  { sourceName: 'ביקור משלחת', dayIndex: 1, shiftIndex: 1, slotIndex: 1, participantName: 'יעל אביב' },
  // שמירה (future)
  { sourceName: 'שמירה', dayIndex: 1, shiftIndex: 1, slotIndex: 0, participantName: 'יעל אביב' },

  // ── Day 2 ───────────────────────────────────────────────────────────────
  { sourceName: 'אדנית', dayIndex: 2, shiftIndex: 1, slotIndex: 0, participantName: 'תום פז' },
  { sourceName: 'אדנית', dayIndex: 2, shiftIndex: 1, slotIndex: 1, participantName: 'אריה כהן' },
  { sourceName: 'חממה', dayIndex: 2, shiftIndex: 1, slotIndex: 0, participantName: 'דני לוי' },
  // אדנית shift 2 slot 0 (L0) — INTENTIONALLY LEFT EMPTY for tp-2.
  { sourceName: 'אדנית', dayIndex: 2, shiftIndex: 2, slotIndex: 1, participantName: 'שרון בכר' },
  { sourceName: 'שמירה', dayIndex: 2, shiftIndex: 1, slotIndex: 0, participantName: 'דני לוי' },
];

/**
 * Demo rest-rule, referenced by every template. Kept lightweight (4h gap) so
 * HC-14 doesn't fire on the curated layout.
 */
export const DEMO_REST_RULE = { label: 'הפסקה מינימלית', durationHours: 4 } as const;

/**
 * Returns a fresh copy of the demo task-template definitions. Each call
 * produces independent objects so the caller (which feeds these into
 * `addTaskTemplate`) doesn't share mutable state across runs.
 *
 * `restRuleId` is filled in by the caller after the rest rule is added.
 */
export interface DemoTaskTemplateSpec {
  name: string;
  durationHours: number;
  shiftsPerDay: number;
  startHour: number;
  sameGroupRequired: boolean;
  blocksConsecutive: boolean;
  baseLoadWeight: number;
  slots: {
    label: string;
    levels: { level: Level; lowPriority?: boolean }[];
    requiredCertifications: string[];
  }[];
  sleepRecovery?: { triggerShifts: number[]; recoveryHours: number };
  color: string;
}

export function buildDemoTaskTemplateSpecs(): DemoTaskTemplateSpec[] {
  return [
    {
      name: 'אדנית',
      durationHours: 4,
      shiftsPerDay: 2,
      startHour: 5,
      sameGroupRequired: false,
      blocksConsecutive: true,
      baseLoadWeight: 1,
      slots: [
        { label: 'משתתף', levels: [{ level: Level.L0 }], requiredCertifications: ['Nitzan'] },
        {
          label: 'אחראי',
          levels: [{ level: Level.L3 }, { level: Level.L4 }],
          requiredCertifications: ['Nitzan'],
        },
      ],
      color: '#4A90D9',
    },
    {
      name: 'חממה',
      durationHours: 4,
      shiftsPerDay: 1,
      startHour: 8,
      sameGroupRequired: true,
      blocksConsecutive: false,
      baseLoadWeight: 0.75,
      slots: [
        {
          label: 'מפעיל חממה',
          levels: [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
          requiredCertifications: ['Hamama'],
        },
      ],
      color: '#E74C3C',
    },
    {
      name: 'שמירה',
      durationHours: 4,
      shiftsPerDay: 1,
      startHour: 22,
      sameGroupRequired: false,
      blocksConsecutive: true,
      baseLoadWeight: 0.8,
      slots: [
        {
          label: 'שומר',
          levels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
          requiredCertifications: [],
        },
      ],
      sleepRecovery: { triggerShifts: [1], recoveryHours: 8 },
      color: '#8E44AD',
    },
  ];
}

/** One-time task definition — used to populate `ft-one-time` step's target. */
export interface DemoOneTimeTaskSpec {
  name: string;
  /** 1-based day index within the demo schedule. */
  dayIndex: number;
  startHour: number;
  startMinute: number;
  durationHours: number;
  slots: {
    label: string;
    levels: { level: Level; lowPriority?: boolean }[];
    requiredCertifications: string[];
  }[];
  color: string;
}

export const DEMO_ONE_TIME_TASK: DemoOneTimeTaskSpec = {
  name: 'ביקור משלחת',
  dayIndex: 1,
  startHour: 18,
  startMinute: 0,
  durationHours: 2,
  slots: [
    {
      label: 'מלווה',
      levels: [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
      requiredCertifications: [],
    },
    {
      label: 'מלווה',
      levels: [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
      requiredCertifications: [],
    },
  ],
  color: '#F39C12',
};

/**
 * Build the demo schedule's `Assignment[]` by resolving each spec entry
 * against the generated task array. Unresolvable specs are skipped — the
 * caller decides whether that's an error (in practice it means a template
 * was renamed or shift count shrunk without updating the seed).
 */
export function buildDemoAssignments(
  tasks: Task[],
  participants: Participant[],
  periodStart: Date,
  dayStartHour: number,
): Assignment[] {
  const nameToId = new Map<string, string>();
  for (const p of participants) nameToId.set(p.name, p.id);

  const opDayMs = (() => {
    const base = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
    return base.getTime() + dayStartHour * 3600_000;
  })();

  const taskDayIndex = (t: Task): number => {
    const diffMs = t.timeBlock.start.getTime() - opDayMs;
    return Math.floor(diffMs / 86_400_000) + 1;
  };

  const assignments: Assignment[] = [];
  const now = new Date();
  for (let i = 0; i < DEMO_ASSIGNMENTS.length; i++) {
    const spec = DEMO_ASSIGNMENTS[i];
    const task = tasks.find(
      (t) => t.sourceName === spec.sourceName && t.shiftIndex === spec.shiftIndex && taskDayIndex(t) === spec.dayIndex,
    );
    if (!task) continue;
    const slot = task.slots[spec.slotIndex];
    if (!slot) continue;
    const pid = nameToId.get(spec.participantName);
    if (!pid) continue;
    assignments.push({
      id: `demo-asg-${i}`,
      taskId: task.id,
      slotId: slot.slotId,
      participantId: pid,
      status: AssignmentStatus.Scheduled,
      updatedAt: now,
    });
  }
  return assignments;
}

/**
 * The live-mode anchor for the demo. Noon of operational day 1 (`periodStart`
 * + `dayStartHour` + 7h). Freezes day-1 morning content (`אדנית` sh1 ends 9,
 * `חממה` ends 12) and leaves day-1 afternoon + all of day-2 modifiable.
 */
export function buildDemoLiveModeAnchor(periodStart: Date, dayStartHour: number): Date {
  const base = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate());
  return new Date(base.getTime() + (dayStartHour + 7) * 3600_000);
}
