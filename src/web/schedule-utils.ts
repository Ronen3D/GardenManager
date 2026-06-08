/**
 * Schedule Utilities — pure/stateless helpers extracted from app.ts.
 *
 * Every function here takes its inputs as parameters and never closes
 * over module-level UI state (currentDay, currentSchedule, engine, etc.).
 * Some read from the `store` singleton, which is an imported module.
 */

import type { AssignmentStatus, ConstraintViolation, Schedule, Task } from '../index';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import { hourInOpDay } from '../shared/utils/time-utils';
import { taskOpDayEnd, taskOpDayStart } from '../utils/date-utils';
import * as store from './config-store';
import { fmt } from './ui-helpers';

// ─── Time Parsing ───────────────────────────────────────────────────────────
// Pure parsers live in shared/utils/time-utils so the Node test runner (which
// excludes src/web/) can import them. Re-exported here to keep existing
// schedule-utils import paths working.

export { parseTimeInput, resolveLogicalDayTimestamp } from '../shared/utils/time-utils';

// ─── Day Visibility (incl. Day 0) ───────────────────────────────────────────

/**
 * True when this schedule has previous-schedule continuity context attached.
 * Drives the optional "Day 0" tab/page in display surfaces. Aggregation paths
 * (period totals, fairness, summary export sheet) ignore this flag — Day 0
 * is never part of THIS schedule's load.
 */
export function hasDay0(schedule: Schedule | null | undefined): boolean {
  return !!schedule?.continuitySnapshot;
}

/**
 * Day indices to render in display loops (navigator chips, profile agenda,
 * workload sparkline). Returns `[0, 1..periodDays]` when continuity context
 * is present, else `[1..periodDays]`. Use this only for display — keep
 * aggregation loops at `1..periodDays` so totals exclude Day 0.
 */
export function getVisibleDayIndices(schedule: Schedule): number[] {
  const out: number[] = [];
  if (hasDay0(schedule)) out.push(0);
  for (let d = 1; d <= schedule.periodDays; d++) out.push(d);
  return out;
}

// ─── Day Window Helpers ─────────────────────────────────────────────────────

/**
 * Returns {start, end} for the 24h window of a given day index (1-based).
 * Window runs from `dayStartHour` on day d to `dayStartHour` on day d+1.
 * When omitted, `dayStartHour` and `baseDate` fall back to the live store —
 * callers in the schedule-display path MUST pass the schedule's frozen
 * values (`schedule.algorithmSettings.dayStartHour`, `schedule.periodStart`)
 * so day grouping stays stable across external edits.
 *
 * Day 0 is supported: dayIndex=0 yields the prior 24h window
 * `[periodStart + dayStartHour - 24h, periodStart + dayStartHour)`.
 */
export function getDayWindow(dayIndex: number, dayStartHour?: number, baseDate?: Date): { start: Date; end: Date } {
  const base = baseDate ?? store.getScheduleDate();
  const dsh = dayStartHour ?? store.getDayStartHour();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex - 1, dsh, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex, dsh, 0);
  return { start, end };
}

/**
 * Does a task intersect (partially or fully) with a given day window?
 */
export function taskIntersectsDay(task: Task, dayIndex: number, dayStartHour?: number, baseDate?: Date): boolean {
  const { start, end } = getDayWindow(dayIndex, dayStartHour, baseDate);
  // Split fragments use their OCCURRENCE span so they appear on exactly the
  // op-day(s) the unsplit shift would (and the residual already does) — never
  // scattered onto the midpoint's day. Non-split: identical to before.
  return taskOpDayStart(task).getTime() < end.getTime() && taskOpDayEnd(task).getTime() > start.getTime();
}

/**
 * The 1-based operational-day index a task's start falls within, relative to
 * `baseDate + dayStartHour`. Derived from the timestamp (not parsed from the
 * task's display name).
 */
export function taskDayIndex(task: Task, dayStartHour: number, baseDate: Date): number {
  const anchor = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0);
  // Bucket split fragments by their occurrence start (so `#b` shares its
  // siblings' day index); non-split tasks are unchanged.
  const diffMs = taskOpDayStart(task).getTime() - anchor.getTime();
  return Math.floor(diffMs / 86400000) + 1;
}

/**
 * Convert an arbitrary timestamp to a 1-based op-day index against the given
 * schedule's `periodStart + dayStartHour` anchor. Hours before `dayStartHour`
 * roll to the previous op-day's tail. Result is clamped to ≥ 1.
 */
export function timestampToOpDayIndex(d: Date, schedule: Schedule): number {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const shifted = new Date(d.getTime());
  if (shifted.getHours() < dsh) shifted.setDate(shifted.getDate() - 1);
  shifted.setHours(0, 0, 0, 0);
  const baseMidnight = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
  return Math.max(1, Math.floor((shifted.getTime() - baseMidnight) / 86400000) + 1);
}

/**
 * Default Live Mode anchor at picker-open time: "right now" mapped onto the
 * schedule's op-day coordinates. Used as the pre-selected value wherever the
 * user sets the temporal anchor (rescue/SOS/inject prompt, Future-SOS freeze
 * point, capability-change, the toolbar checkbox).
 *
 *   - now BEFORE the window → day 1 at dayStartHour (schedule hasn't started;
 *     nothing frozen).
 *   - now AFTER the window  → the last day (יום N) at the real current hour
 *     (the 3-day-schedule-on-Wednesday case): an honest, editable starting
 *     point. Isolated to the single POLICY line below if it ever changes.
 *   - now INSIDE the window → the exact current moment.
 *
 * One-shot: the anchor does not auto-advance — the user controls it after.
 * `now` is injectable for deterministic tests.
 */
export function computeDefaultLiveAnchor(schedule: Schedule, now: Date = new Date()): Date {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const numDays = schedule.periodDays;
  // Op-day 1 starts at periodStart@dayStartHour; the window ends at the start
  // of op-day N+1 (exclusive upper bound).
  const day1StartMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), dsh, 0).getTime();
  const windowEndMs = new Date(base.getFullYear(), base.getMonth(), base.getDate() + numDays, dsh, 0).getTime();
  if (now.getTime() < day1StartMs) return new Date(day1StartMs);
  // POLICY (after window): last day at the real current hour. hourInOpDay maps
  // tail hours (< dayStartHour) onto the correct op-day.
  if (now.getTime() >= windowEndMs) return new Date(hourInOpDay(base, dsh, numDays, now.getHours()));
  return new Date(now.getTime());
}

/**
 * Convert a live anchor `Date` into the `{ defaultDay, defaultHour }` string
 * pair `showTimePicker` needs to pre-select its `<select>` options. The day is
 * derived via {@link timestampToOpDayIndex} and clamped to `[1, periodDays]`
 * so it always matches a rendered `יום N` option; the hour (0..23) always
 * matches an `operationalHourOrder` option.
 */
export function anchorToPickerDefaults(anchor: Date, schedule: Schedule): { defaultDay: string; defaultHour: string } {
  const dayIndex = Math.max(1, Math.min(schedule.periodDays, timestampToOpDayIndex(anchor, schedule)));
  return { defaultDay: String(dayIndex), defaultHour: String(anchor.getHours()) };
}

/**
 * Live-mode picker (`dayIdx`, wall-clock `hour`) → absolute anchor on the
 * schedule's frozen op-day grid. Tail hours (`hour < dayStartHour`) map to the
 * op-day's post-midnight tail. Reads the FROZEN `periodStart` + `dayStartHour`
 * so the anchor lands on the same grid the user sees — mirrors the picker
 * composition in `ensureLiveModeAnchor`.
 */
export function liveAnchorFromPicker(schedule: Schedule, dayIdx: number, hour: number): Date {
  return new Date(hourInOpDay(schedule.periodStart, schedule.algorithmSettings.dayStartHour, dayIdx, hour));
}

/** Format an HC-15 recovery window as `יום N HH:MM – HH:MM` (single op-day) or `יום N HH:MM – יום M HH:MM`. */
export function fmtRecoveryWindow(win: { start: Date; end: Date }, schedule: Schedule): string {
  const startDay = timestampToOpDayIndex(win.start, schedule);
  const endDay = timestampToOpDayIndex(win.end, schedule);
  const startTime = fmt(win.start);
  const endTime = fmt(win.end);
  if (startDay === endDay) return `יום ${startDay} ${startTime} – ${endTime}`;
  return `יום ${startDay} ${startTime} – יום ${endDay} ${endTime}`;
}

/**
 * Does a task start before this day window (i.e. it's a continuation from
 * the previous day)?
 */
export function taskStartsBefore(task: Task, dayIndex: number, dayStartHour?: number, baseDate?: Date): boolean {
  const { start } = getDayWindow(dayIndex, dayStartHour, baseDate);
  return task.timeBlock.start.getTime() < start.getTime();
}

/**
 * Does a task end after this day window (i.e. continues into the next day)?
 */
export function taskEndsAfter(task: Task, dayIndex: number, dayStartHour?: number, baseDate?: Date): boolean {
  const { end } = getDayWindow(dayIndex, dayStartHour, baseDate);
  return task.timeBlock.end.getTime() > end.getTime();
}

/**
 * Hours of the day (0..23) ordered by the operational day boundary: starts
 * at `dayStartHour` and wraps around midnight. E.g. dsh=5 → [5,6,…,23,0,1,2,3,4].
 */
export function operationalHourOrder(dayStartHour: number): number[] {
  const dsh = ((Math.trunc(dayStartHour) % 24) + 24) % 24;
  const hours: number[] = [];
  for (let i = 0; i < 24; i++) hours.push((dsh + i) % 24);
  return hours;
}

/**
 * Operational-day half-hour labels: 05:00, 05:30, 06:00, …, 04:00, 04:30 for dsh=5.
 * Used by the availability inspector strip so users can query e.g. 14:30.
 */
export function operationalHalfHourLabels(dayStartHour: number): string[] {
  const labels: string[] = [];
  for (const h of operationalHourOrder(dayStartHour)) {
    labels.push(`${String(h).padStart(2, '0')}:00`);
    labels.push(`${String(h).padStart(2, '0')}:30`);
  }
  return labels;
}

// ─── Status & Violation Display ─────────────────────────────────────────────

export function statusBadge(status: AssignmentStatus): string {
  const colors: Record<string, string> = {
    Scheduled: '#27ae60',
    Manual: '#f39c12',
    Conflict: '#e74c3c',
    Frozen: '#00bcd4',
  };
  const labels: Record<string, string> = {
    Scheduled: 'משובץ',
    Manual: 'ידני',
    Conflict: 'התנגשות',
    Frozen: 'מוקפא',
  };
  return `<span class="badge badge-sm" style="background:${colors[status] || '#7f8c8d'}">${labels[status] || status}</span>`;
}

// ─── Violation Code → Hebrew Label ──────────────────────────────────────────

const violationCodeLabels: Record<string, string> = {
  SLOT_NOT_FOUND: 'משבצת חסרה',
  LEVEL_MISMATCH: 'אי-התאמת דרגה',
  CERT_MISSING: 'הסמכה חסרה',
  AVAILABILITY_VIOLATION: 'חוסר זמינות',
  GROUP_MISMATCH: 'ערבוב קבוצות',
  EXCLUDED_CERTIFICATION: 'הסמכה אסורה',
  DOUBLE_BOOKING: 'שיבוץ כפול',
  SLOT_UNFILLED: 'משבצת ריקה',
  SLOT_OVERBOOKED: 'עודף שיבוצים',
  DUPLICATE_IN_TASK: 'משתתף כפול במשימה',
  GROUP_INSUFFICIENT: 'אין מספיק חברי קבוצה',
  CONSECUTIVE_HIGH_LOAD: 'עומס רצוף ללא מנוחה',
  CATEGORY_BREAK_VIOLATION: 'מנוחה לא מספקת',
  PARTICIPANT_NOT_FOUND: 'משתתף לא נמצא',
  INFEASIBLE_SLOT: 'משבצת ללא מועמד מתאים',
  SENIOR_HARD_BLOCK: 'חסימת סגל',
  SENIOR_IN_JUNIOR_PREFERRED: 'סגל בכיר במשימת צעירים',
  LOW_PRIORITY_LEVEL: 'שיבוץ בעדיפות נמוכה',
  LESS_PREFERRED_ASSIGNMENT: 'משימה לא מועדפת',
  PREFERRED_NAME_UNAVAILABLE: 'אין משתתף מסוג המועדף',
  PREFERRED_NOT_SATISFIED: 'העדפה לא מומשה',
};

export function violationLabel(code: string): string {
  return violationCodeLabels[code] || code;
}

/**
 * Filter out violations whose constraint code has been disabled by the user
 * in the Algorithm Settings panel.  This is a UI-only safety net; the engine
 * should already omit them, but we guard the display layer too.
 *
 * Callers displaying a frozen schedule MUST pass the schedule's own
 * `algorithmSettings.disabledHardConstraints` — otherwise a user editing the
 * disabled-HC set after generation would silently hide violations from a
 * schedule that was actually generated with those constraints enabled.
 * When `disabledHC` is omitted, falls back to the live store for back-compat
 * with contexts that don't have a schedule in scope.
 */
export function filterVisibleViolations(
  violations: ConstraintViolation[],
  disabledHC?: Set<string> | ReadonlySet<string>,
): ConstraintViolation[] {
  const effective = disabledHC ?? store.getDisabledHCSet();
  if (effective.size === 0) return violations;
  return violations.filter((v) => !effective.has(v.code));
}

// ─── Live Clock ─────────────────────────────────────────────────────────────

export function formatLiveClock(): string {
  const now = new Date();
  const date = now.toLocaleDateString('he-IL', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

// ─── Per-Day Hours ──────────────────────────────────────────────────────────

/**
 * Compute per-day raw clock hours for a participant.
 * Returns a Map<dayIndex, hours> for days 1..numDays.
 *
 * Intentionally uses raw (un-weighted) hours — this measures how many
 * hours of the day the participant is physically occupied, regardless
 * of load weighting. For weighted effort see computeTaskBreakdown()
 * and computeTaskEffectiveHours().
 */
export function computePerDayHours(
  participantId: string,
  schedule: Schedule,
  taskMap?: Map<string, Task>,
): Map<number, number> {
  const numDays = schedule.periodDays;
  const result = new Map<number, number>();
  for (let d = 1; d <= numDays; d++) result.set(d, 0);

  const tMap = taskMap ?? new Map<string, Task>(schedule.tasks.map((t) => [t.id, t]));
  // Use the schedule's own frozen period so day attribution stays stable.
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;

  for (const a of schedule.assignments) {
    if (a.participantId !== participantId) continue;
    const task = tMap.get(a.taskId);
    if (!task) continue;

    // Zero-effective-hours tasks contribute nothing to daily load
    if (computeTaskEffectiveHours(task) === 0) continue;

    for (let d = 1; d <= numDays; d++) {
      if (taskIntersectsDay(task, d, dsh, base)) {
        // Cross-day tasks: split proportionally between both day windows.
        const { start: winStart, end: winEnd } = getDayWindow(d, dsh, base);
        const overlapStart = Math.max(task.timeBlock.start.getTime(), winStart.getTime());
        const overlapEnd = Math.min(task.timeBlock.end.getTime(), winEnd.getTime());
        const overlapHrs = Math.max(0, (overlapEnd - overlapStart) / 3600000);
        result.set(d, (result.get(d) || 0) + overlapHrs);
      }
    }
  }
  return result;
}
