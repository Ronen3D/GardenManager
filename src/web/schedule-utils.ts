/**
 * Schedule Utilities — pure/stateless helpers extracted from app.ts.
 *
 * Every function here takes its inputs as parameters and never closes
 * over module-level UI state (currentDay, currentSchedule, engine, etc.).
 * Some read from the `store` singleton, which is an imported module.
 */

import type { AssignmentStatus, ConstraintViolation, Schedule, Task } from '../index';
import { hebrewDayName } from '../utils/date-utils';
import * as store from './config-store';
import { fmt } from './ui-helpers';

// ─── Formatting Helpers ─────────────────────────────────────────────────────

export function fmtDate(d: Date): string {
  return hebrewDayName(d) + ' ' + fmt(d);
}

export function fmtDayShort(d: Date): string {
  return 'יום ' + hebrewDayName(d);
}

// ─── Time Parsing ───────────────────────────────────────────────────────────

export function parseTimeInput(timeValue: string): { hours: number; minutes: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

export function resolveLogicalDayTimestamp(dayIndex: number, timeValue: string): Date | null {
  const parsed = parseTimeInput(timeValue);
  if (!parsed) return null;
  const base = store.getScheduleDate();
  const dayOffset = parsed.hours < store.getDayStartHour() ? dayIndex : dayIndex - 1;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, parsed.hours, parsed.minutes, 0, 0);
}

// ─── Day Window Helpers ─────────────────────────────────────────────────────

/**
 * Returns {start, end} for the 24h window of a given day index (1-based).
 * Window runs from 05:00 on day d to 05:00 on day d+1.
 */
export function getDayWindow(dayIndex: number): { start: Date; end: Date } {
  const base = store.getScheduleDate();
  const start = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayIndex - 1,
    store.getDayStartHour(),
    0,
  );
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex, store.getDayStartHour(), 0);
  return { start, end };
}

/**
 * Does a task intersect (partially or fully) with a given day window?
 */
export function taskIntersectsDay(task: Task, dayIndex: number): boolean {
  const { start, end } = getDayWindow(dayIndex);
  return task.timeBlock.start.getTime() < end.getTime() && task.timeBlock.end.getTime() > start.getTime();
}

/**
 * Does a task start before this day window (i.e. it's a continuation from
 * the previous day)?
 */
export function taskStartsBefore(task: Task, dayIndex: number): boolean {
  const { start } = getDayWindow(dayIndex);
  return task.timeBlock.start.getTime() < start.getTime();
}

/**
 * Does a task end after this day window (i.e. continues into the next day)?
 */
export function taskEndsAfter(task: Task, dayIndex: number): boolean {
  const { end } = getDayWindow(dayIndex);
  return task.timeBlock.end.getTime() > end.getTime();
}

// ─── Status & Violation Display ─────────────────────────────────────────────

export function statusBadge(status: AssignmentStatus): string {
  const colors: Record<string, string> = {
    Scheduled: '#27ae60',
    Locked: '#2980b9',
    Manual: '#f39c12',
    Conflict: '#e74c3c',
    Frozen: '#00bcd4',
  };
  const labels: Record<string, string> = {
    Scheduled: 'משובץ',
    Locked: 'נעול',
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
  GROUP_INSUFFICIENT: 'קבוצה לא מספקת',
  CONSECUTIVE_HIGH_LOAD: 'עומס רצוף',
  CATEGORY_BREAK_VIOLATION: 'הפסקה לא מספקת',
  PARTICIPANT_NOT_FOUND: 'משתתף לא נמצא',
  INFEASIBLE_SLOT: 'שיבוץ בלתי אפשרי',
  SENIOR_HARD_BLOCK: 'חסימת סגל',
  SENIOR_IN_JUNIOR_PREFERRED: 'סגל בכיר במשימת צעירים',
  LESS_PREFERRED_ASSIGNMENT: 'משימה לא מועדפת',
  PREFERRED_TYPE_UNAVAILABLE: 'סוג מועדף לא קיים',
  PREFERRED_NOT_SATISFIED: 'העדפה לא מומשה',
};

export function violationLabel(code: string): string {
  return violationCodeLabels[code] || code;
}

/**
 * Filter out violations whose constraint code has been disabled by the user
 * in the Algorithm Settings panel.  This is a UI-only safety net; the engine
 * should already omit them, but we guard the display layer too.
 */
export function filterVisibleViolations(violations: ConstraintViolation[]): ConstraintViolation[] {
  const disabledHC = store.getDisabledHCSet();
  if (disabledHC.size === 0) return violations;
  return violations.filter((v) => !disabledHC.has(v.code));
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
  const numDays = store.getScheduleDays();
  const result = new Map<number, number>();
  for (let d = 1; d <= numDays; d++) result.set(d, 0);

  const tMap = taskMap ?? new Map<string, Task>(schedule.tasks.map((t) => [t.id, t]));

  for (const a of schedule.assignments) {
    if (a.participantId !== participantId) continue;
    const task = tMap.get(a.taskId);
    if (!task) continue;

    // Light tasks (Karovit) contribute 0 hours — only heavy tasks count
    if (task.isLight) continue;

    // Attribute hours to the day the task starts in
    for (let d = 1; d <= numDays; d++) {
      if (taskIntersectsDay(task, d)) {
        // For cross-day tasks, split proportionally
        const { start: winStart, end: winEnd } = getDayWindow(d);
        const overlapStart = Math.max(task.timeBlock.start.getTime(), winStart.getTime());
        const overlapEnd = Math.min(task.timeBlock.end.getTime(), winEnd.getTime());
        const overlapHrs = Math.max(0, (overlapEnd - overlapStart) / 3600000);
        result.set(d, (result.get(d) || 0) + overlapHrs);
      }
    }
  }
  return result;
}
