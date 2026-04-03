/**
 * Browser Entry Point — Tabbed UI with Daily Focus + Weekly Context
 *
 * Layout: Day 1–7 navigation with a focused 24h grid per day,
 * a sticky Weekly Dashboard header showing global fairness & KPIs,
 * and a Participant Status sidebar with cumulative orange workload bars
 * and per-participant workload indicators.
 *
 * Every manual change triggers full 7-day re-validation so cross-day
 * conflicts are caught immediately.
 */

import './style.css';
import './style-mobile.css';
import { initResponsive, isTouchDevice, isSmallScreen } from './responsive';

import {
  SchedulingEngine,
  Participant,
  Level,
  Certification,
  AssignmentStatus,
  ViolationSeverity,
  Schedule,
  Task,
  Assignment,
  SlotRequirement,
  AdanitTeam,
  RescueResult,
  RescuePlan,
  RescueRequest,
  LiveModeState,
  ConstraintViolation,
  AlgorithmSettings,
  RejectionCode,
} from '../index';
import { getRejectionReason, getEligibleParticipantsForSlot } from '../engine/validator';
import { hebrewDayName } from '../utils/date-utils';
import { scheduleToGantt } from '../ui/gantt-bridge';
import { renderScheduleGrid } from './schedule-grid-view';
import { generateShiftBlocks } from './utils/time-utils';
import { computeWeeklyWorkloads } from './workload-utils';
import {
  freezeAssignments,
  unfreezeAll,
  isFutureTask,
  isModifiableAssignment,
  isDayFrozen,
  isDayPartiallyFrozen,
} from '../engine/temporal';
import { generateRescuePlans } from '../engine/rescue';

import * as store from './config-store';
import { runPreflight } from './preflight';
import { renderParticipantsTab, wireParticipantsEvents, clearParticipantSelection } from './tab-participants';
import { renderTaskRulesTab, wireTaskRulesEvents } from './tab-task-rules';
import { renderProfileView, wireProfileEvents, ProfileContext } from './tab-profile';
import { renderAlgorithmTab, wireAlgorithmEvents } from './tab-algorithm';
import { computeTaskBreakdown } from './workload-utils';
import { exportWeeklyOverview, exportDailyDetail } from './pdf-export';
import {
  LEVEL_COLORS, CERT_COLORS, CERT_LABELS,
  fmt, levelBadge, certBadge, certBadges, groupBadge, groupColor, taskBadge, SVG_ICONS, escHtml,
} from './ui-helpers';
import { getEffectivePakalDefinitions, renderPakalBadges } from './pakal-utils';
import { showAlert, showPrompt, showConfirm, showToast, showBottomSheet, showContinuityImport, showTimePicker, renderCustomSelect, wireCustomSelect } from './ui-modal';
import { exportDaySnapshot } from './continuity-export';
import { parseContinuitySnapshot } from './continuity-import';
import { buildPhantomContext } from '../engine/phantom';

// ─── Globals ─────────────────────────────────────────────────────────────────

let currentTab: 'participants' | 'task-rules' | 'schedule' | 'algorithm' = 'participants';
let engine: SchedulingEngine | null = null;
let currentSchedule: Schedule | null = null;
let scheduleElapsed = 0;
let scheduleActualAttempts = 0;
/** Currently viewed day (1–7). Always a specific day when schedule is shown. */
let currentDay = 1;
/** True while multi-attempt optimization is running */
let _isOptimizing = false;
/**
 * True when the config store has been mutated after the latest schedule
 * generation.  Signals that the current schedule may be out of sync with
 * participants / rules.
 */
let _scheduleDirty = false;

/** True when the current schedule differs from the active snapshot */
let _snapshotDirty = false;
/** State for inline snapshot forms */
let _snapshotFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _snapshotFormError = '';
/** Whether the snapshot panel is expanded */
let _snapshotPanelOpen = false;
/** Whether the workload sidebar is collapsed */
let _sidebarCollapsed = localStorage.getItem('gm-sidebar-collapsed') === '1';
let _availabilityPopoverEl: HTMLElement | null = null;
let _availabilityPopoverKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let _availabilityInlineOpen = false;
let _availabilityInlineTimeMs: number | null = null;

/** Continuity feature: pasted or auto-populated JSON from previous schedule */
let _continuityJson = '';
let _availabilityInspectorDay: number | null = null;
let _availabilityInspectorTime = '05:00';
let _availabilityMobileOpen = false;

// ─── View Router ─────────────────────────────────────────────────────────────

type ViewMode = 'SCHEDULE_VIEW' | 'PROFILE_VIEW';
let _viewMode: ViewMode = 'SCHEDULE_VIEW';
let _profileParticipantId: string | null = null;
/** Saved scroll position of the schedule view for seamless return */
let _scheduleScrollY = 0;
/** Progress state for the optimization overlay */
let _optimProgress: {
  attempt: number;
  totalAttempts: number;
  bestScore: number;
  bestUnfilled: number;
  lastImproved: boolean;
} | null = null;

/** The 24h window boundary hour (05:00–05:00 by default) */
const DAY_START_HOUR = 5;

/** Sidebar workload bar thresholds (fraction of total period hours). */
const WORKLOAD_OVER_THRESHOLD = 0.18;
const WORKLOAD_UNDER_THRESHOLD = 0.08;

// ─── Rescue Modal State ──────────────────────────────────────────────────────

/** Currently displayed rescue result (null when modal is closed) */
let _rescueResult: RescueResult | null = null;
/** Which assignment ID the rescue modal is open for */
let _rescueAssignmentId: string | null = null;
/** Current rescue page (0-based) */
let _rescuePage = 0;
/** Escape key handler for rescue modal (stored for cleanup) */
let _rescueEscHandler: ((e: KeyboardEvent) => void) | null = null;

// ─── Manual Build Mode State ────────────────────────────────────────────────

let _manualBuildActive = false;
/** Currently selected slot in manual-build mode */
let _manualSelectedTaskId: string | null = null;
let _manualSelectedSlotId: string | null = null;
/** Cached eligible participant IDs for the selected slot */
let _eligibleForSelectedSlot: Set<string> | null = null;
/** Manual-build undo stack: snapshots of assignment arrays */
let _manualUndoStack: Assignment[][] = [];
/** Warehouse search filter text */
let _warehouseFilter = '';

/** HC rejection code → Hebrew user-facing message */
const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  'HC-1':  'הדרגה לא מתאימה למשבצת הזו',
  'HC-2':  'חסרה הסמכה נדרשת',
  'HC-3':  'המשתתף לא זמין בשעות המשימה',
  'HC-4':  'המשתתפים חייבים להיות מאותה קבוצה',
  'HC-5':  'המשתתף כבר משובץ במשימה חופפת',
  'HC-7':  'המשתתף כבר משובץ במשימה הזו',
  'HC-11': 'למשתתף הסמכה אסורה למשבצת הזו',
  'HC-12': 'לא ניתן לשבץ למשימות כבדות רצופות',
  'HC-13': 'מגבלת שיבוץ סגל — מחוץ לתחום הטבעי',
  'HC-14': 'נדרשת הפסקה של 5 שעות לפחות ממשימת קטגוריה',
};

function clearManualSelection(): void {
  _manualSelectedTaskId = null;
  _manualSelectedSlotId = null;
  _eligibleForSelectedSlot = null;
}

// ─── Formatting Helpers (app-local) ──────────────────────────────────────────

function fmtDate(d: Date): string {
  return hebrewDayName(d) + ' ' + fmt(d);
}

function fmtDayShort(d: Date): string {
  return 'יום ' + hebrewDayName(d);
}

function parseTimeInput(timeValue: string): { hours: number; minutes: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(timeValue.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

function resolveLogicalDayTimestamp(dayIndex: number, timeValue: string): Date | null {
  const parsed = parseTimeInput(timeValue);
  if (!parsed) return null;
  const base = store.getScheduleDate();
  const dayOffset = parsed.hours < DAY_START_HOUR ? dayIndex : dayIndex - 1;
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + dayOffset,
    parsed.hours,
    parsed.minutes,
    0,
    0,
  );
}

function renderAvailabilityInspectorInline(): string {
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const selectedDay = _availabilityInspectorDay && _availabilityInspectorDay >= 1 && _availabilityInspectorDay <= numDays
    ? _availabilityInspectorDay
    : currentDay;
  _availabilityInspectorDay = selectedDay;

  const dayOptions: { value: string; label: string; selected: boolean }[] = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    dayOptions.push({
      value: String(d),
      label: `יום ${d} · ${hebrewDayName(date)}`,
      selected: d === selectedDay,
    });
  }

  return `
    ${renderCustomSelect({ id: 'gm-availability-day', options: dayOptions, className: 'input-sm availability-day-select' })}
    <input type="time" id="gm-availability-time" class="input-sm availability-time-input" value="${_availabilityInspectorTime}" step="60" title="שעה לבדיקת זמינות (00:00–04:59 נספרות לסוף היום)" />
    <button class="btn-sm btn-primary" id="btn-open-availability-inspector" title="בדיקת זמינות לפי זמן">הצג זמינות</button>
  `;
}

/** Collapsible availability strip between schedule grid and gantt */
function renderAvailabilityStrip(): string {
  if (!currentSchedule) return '';

  // Collapsed state — just the bar
  if (!_availabilityInlineOpen) {
    return `<div class="avail-strip" data-action="open-avail-strip">
      <span class="avail-strip-icon">🕐</span>
      <span class="avail-strip-label">בדיקת עתודה פנויה</span>
      <span class="avail-strip-arrow">◂</span>
    </div>`;
  }

  // Expanded state — inputs + results
  let html = `<div class="avail-strip avail-strip-open">`;
  html += `<div class="avail-strip-header" data-action="close-avail-strip">
    <span class="avail-strip-icon">🕐</span>
    <span class="avail-strip-label">בדיקת עתודה פנויה</span>
    <span class="avail-strip-arrow">▾</span>
  </div>`;

  html += `<div class="avail-strip-body">`;
  html += `<div class="avail-strip-inputs">${renderAvailabilityInspectorInline()}</div>`;

  if (_availabilityInlineTimeMs !== null) {
    html += `<div class="avail-strip-results">${buildAvailabilityPopoverContent(_availabilityInlineTimeMs)}</div>`;
  }

  html += `</div></div>`;
  return html;
}

function statusBadge(status: AssignmentStatus): string {
  const colors: Record<string, string> = {
    Scheduled: '#27ae60', Locked: '#2980b9', Manual: '#f39c12', Conflict: '#e74c3c', Frozen: '#00bcd4'
  };
  const labels: Record<string, string> = {
    Scheduled: 'משובץ', Locked: 'נעול', Manual: 'ידני', Conflict: 'התנגשות', Frozen: 'מוקפא'
  };
  return `<span class="badge badge-sm" style="background:${colors[status] || '#7f8c8d'}">${labels[status] || status}</span>`;
}

// ─── Violation Code → Hebrew Label ──────────────────────────────────────────

const violationCodeLabels: Record<string, string> = {
  'SLOT_NOT_FOUND':            'משבצת חסרה',
  'LEVEL_MISMATCH':            'אי-התאמת דרגה',
  'CERT_MISSING':              'הסמכה חסרה',
  'AVAILABILITY_VIOLATION':    'חוסר זמינות',
  'GROUP_MISMATCH':            'ערבוב קבוצות',
  'EXCLUDED_CERTIFICATION':    'הסמכה אסורה',
  'DOUBLE_BOOKING':            'שיבוץ כפול',
  'SLOT_UNFILLED':             'משבצת ריקה',
  'SLOT_OVERBOOKED':           'עודף שיבוצים',
  'DUPLICATE_IN_TASK':         'משתתף כפול במשימה',
  'GROUP_INSUFFICIENT':        'קבוצה לא מספקת',
  'CONSECUTIVE_HIGH_LOAD':     'עומס רצוף',
  'CATEGORY_BREAK_VIOLATION':  'הפסקה לא מספקת',
  'PARTICIPANT_NOT_FOUND':     'משתתף לא נמצא',
  'INFEASIBLE_SLOT':           'שיבוץ בלתי אפשרי',
  'SENIOR_HARD_BLOCK':         'חסימת סגל',
  'SENIOR_IN_JUNIOR_PREFERRED': 'סגל בכיר במשימת צעירים',
  'LESS_PREFERRED_ASSIGNMENT':  'משימה לא מועדפת',
  'PREFERRED_TYPE_UNAVAILABLE': 'סוג מועדף לא קיים',
  'PREFERRED_NOT_SATISFIED':    'העדפה לא מומשה',
};

function violationLabel(code: string): string {
  return violationCodeLabels[code] || code;
}

// ─── Day Window Helpers ──────────────────────────────────────────────────────

/**
 * Filter out violations whose constraint code has been disabled by the user
 * in the Algorithm Settings panel.  This is a UI-only safety net; the engine
 * should already omit them, but we guard the display layer too.
 */
function filterVisibleViolations(violations: ConstraintViolation[]): ConstraintViolation[] {
  const disabledHC = store.getDisabledHCSet();
  if (disabledHC.size === 0) return violations;
  return violations.filter(v => !disabledHC.has(v.code));
}

/**
 * Returns {start, end} for the 24h window of a given day index (1-based).
 * Window runs from 05:00 on day d to 05:00 on day d+1.
 */
function getDayWindow(dayIndex: number): { start: Date; end: Date } {
  const base = store.getScheduleDate();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex - 1, DAY_START_HOUR, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIndex, DAY_START_HOUR, 0);
  return { start, end };
}

/**
 * Does a task intersect (partially or fully) with a given day window?
 */
function taskIntersectsDay(task: Task, dayIndex: number): boolean {
  const { start, end } = getDayWindow(dayIndex);
  return task.timeBlock.start.getTime() < end.getTime() &&
         task.timeBlock.end.getTime() > start.getTime();
}

/**
 * Does a task start before this day window (i.e. it's a continuation from
 * the previous day)?
 */
function taskStartsBefore(task: Task, dayIndex: number): boolean {
  const { start } = getDayWindow(dayIndex);
  return task.timeBlock.start.getTime() < start.getTime();
}

/**
 * Does a task end after this day window (i.e. continues into the next day)?
 */
function taskEndsAfter(task: Task, dayIndex: number): boolean {
  const { end } = getDayWindow(dayIndex);
  return task.timeBlock.end.getTime() > end.getTime();
}

// ─── Template → Task Conversion ──────────────────────────────────────────────

let _tSlotCounter = 0;
let _tTaskCounter = 0;

function generateTasksFromTemplates(): Task[] {
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const templates = store.getAllTaskTemplates();
  const visuals = store.getTemplateVisualMap();
  const allTasks: Task[] = [];
  _tSlotCounter = 0;
  _tTaskCounter = 0;

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);

      let shifts: { start: Date; end: Date }[];
      if (tpl.eveningStartHour !== undefined && tpl.shiftsPerDay === 2) {
        const morningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);
        const morningEnd = new Date(morningStart.getTime() + tpl.durationHours * 3600000);
        const eveHour = tpl.eveningStartHour ?? 17;
        const eveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eveHour, 0);
        const eveningEnd = new Date(eveningStart.getTime() + tpl.durationHours * 3600000);
        shifts = [
          { start: morningStart, end: morningEnd },
          { start: eveningStart, end: eveningEnd },
        ];
      } else if (tpl.shiftsPerDay === 1) {
        shifts = [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }];
      } else {
        shifts = generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);
      }

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams) {
          const subTeamRole = st.subTeamRole
            ?? ((st.name.includes('ראשי') || /main/i.test(st.name))
              ? AdanitTeam.SegolMain
              : (st.name.includes('משני') || /secondary/i.test(st.name))
                ? AdanitTeam.SegolSecondary
                : undefined);

          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) {
              console.warn(`Slot "${s.label}" in template "${tpl.name}" has no acceptable levels — skipping`);
              continue;
            }
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              subTeamRole,
              label: s.label,
              subTeamId: st.id,
            });
          }
        }

        for (const s of tpl.slots) {
          if (s.acceptableLevels.length === 0) {
            console.warn(`Slot "${s.label}" in template "${tpl.name}" has no acceptable levels — skipping`);
            continue;
          }
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        const v = visuals[tpl.name];
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_tTaskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          isLight: tpl.isLight,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive ?? !tpl.isLight,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          requiresCategoryBreak: tpl.requiresCategoryBreak,
          displayCategory: tpl.displayCategory,
          color: tpl.color || v?.color || '#7f8c8d',
        });
      }
    }
  }

  // ── One-Time Tasks ───────────────────────────────────────────────────────
  const allOneTimeTasks = store.getAllOneTimeTasks();
  const windowStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const windowEnd = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + numDays);

  for (const ot of allOneTimeTasks) {
    const otDay = new Date(
      ot.scheduledDate.getFullYear(),
      ot.scheduledDate.getMonth(),
      ot.scheduledDate.getDate(),
    );

    // Range filter: skip if outside scheduling window
    if (otDay < windowStart || otDay >= windowEnd) continue;

    const dayIdx = Math.round((otDay.getTime() - windowStart.getTime()) / 86400000);
    const dayLabel = `D${dayIdx + 1}`;

    const start = new Date(otDay.getFullYear(), otDay.getMonth(), otDay.getDate(),
                           ot.startHour, ot.startMinute || 0);
    const end = new Date(start.getTime() + ot.durationHours * 3600000);

    // Build slots (same logic as template slot building above)
    const slots: SlotRequirement[] = [];
    for (const st of ot.subTeams) {
      const subTeamRole = st.subTeamRole
        ?? ((st.name.includes('ראשי') || /main/i.test(st.name))
          ? AdanitTeam.SegolMain
          : (st.name.includes('משני') || /secondary/i.test(st.name))
            ? AdanitTeam.SegolSecondary
            : undefined);

      for (const s of st.slots) {
        if (s.acceptableLevels.length === 0) continue;
        slots.push({
          slotId: `ot-slot-${++_tSlotCounter}`,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          subTeamRole,
          label: s.label,
          subTeamId: st.id,
        });
      }
    }
    for (const s of ot.slots) {
      if (s.acceptableLevels.length === 0) continue;
      slots.push({
        slotId: `ot-slot-${++_tSlotCounter}`,
        acceptableLevels: [...s.acceptableLevels],
        requiredCertifications: [...s.requiredCertifications],
        forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        label: s.label,
      });
    }

    allTasks.push({
      id: `ot-${ot.id}-d${dayIdx + 1}-${++_tTaskCounter}`,
      name: `${dayLabel} ${ot.name}`,
      sourceName: ot.name,
      timeBlock: { start, end },
      requiredCount: slots.length,
      slots,
      isLight: ot.isLight,
      baseLoadWeight: ot.baseLoadWeight,
      loadWindows: (ot.loadWindows ?? []).map((w) => ({ ...w })),
      sameGroupRequired: ot.sameGroupRequired,
      blocksConsecutive: ot.blocksConsecutive ?? !ot.isLight,
      schedulingPriority: ot.schedulingPriority,
      togethernessRelevant: ot.togethernessRelevant,
      requiresCategoryBreak: ot.requiresCategoryBreak,
      displayCategory: ot.displayCategory,
      color: ot.color || '#7f8c8d',
    });
  }

  return allTasks;
}

// ─── Day Filtering ───────────────────────────────────────────────────────────

/** Get tasks that intersect the current day's 05:00–05:00 window */
function getFilteredTasks(schedule: Schedule): Task[] {
  return schedule.tasks.filter(t => taskIntersectsDay(t, currentDay));
}

/** Get assignments for tasks visible in the current day */
function getFilteredAssignments(schedule: Schedule): Assignment[] {
  const filteredTaskIds = new Set(getFilteredTasks(schedule).map(t => t.id));
  return schedule.assignments.filter(a => filteredTaskIds.has(a.taskId));
}

/**
 * Compute per-day raw clock hours for a participant.
 * Returns a Map<dayIndex, hours> for days 1..numDays.
 *
 * Intentionally uses raw (un-weighted) hours — this measures how many
 * hours of the day the participant is physically occupied, regardless
 * of load weighting. For weighted effort see computeTaskBreakdown()
 * and computeTaskEffectiveHours().
 */
function computePerDayHours(
  participantId: string,
  schedule: Schedule,
  taskMap?: Map<string, Task>,
): Map<number, number> {
  const numDays = store.getScheduleDays();
  const result = new Map<number, number>();
  for (let d = 1; d <= numDays; d++) result.set(d, 0);

  const tMap = taskMap ?? new Map<string, Task>(schedule.tasks.map(t => [t.id, t]));

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

// ─── Day Navigator ───────────────────────────────────────────────────────────

/** Render the day navigation tabs (Day 1 – Day 7) */
function renderDayNavigator(): string {
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const liveMode = store.getLiveModeState();

  let html = `<div class="day-navigator">`;

  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayName = hebrewDayName(date);

    let taskCount = 0;
    let violationCount = 0;
    if (currentSchedule) {
      taskCount = currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).length;
      const dayTaskIds = new Set(currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).map(t => t.id));
      violationCount = filterVisibleViolations(currentSchedule.violations).filter(v =>
        v.severity === ViolationSeverity.Error && v.taskId && dayTaskIds.has(v.taskId)
      ).length;
    }

    const violationDot = violationCount > 0
      ? `<span class="day-violation-dot" title="${violationCount} הפרות">!</span>`
      : '';

    let frozenTag = '';
    let frozenClass = '';
    if (liveMode.enabled) {
      if (isDayFrozen(d, baseDate, liveMode.currentTimestamp, DAY_START_HOUR)) {
        frozenTag = `<span class="day-frozen-badge" title="היום הזה מוקפא כי הוא בעבר">🧊</span>`;
        frozenClass = ' day-tab-frozen';
      } else if (isDayPartiallyFrozen(d, baseDate, liveMode.currentTimestamp, DAY_START_HOUR)) {
        frozenTag = `<span class="day-frozen-badge day-frozen-partial" title="מוקפא חלקית לפי שעה נוכחית">⏳</span>`;
        frozenClass = ' day-tab-partial-frozen';
      }
    }

    html += `<button class="day-tab ${currentDay === d ? 'day-tab-active' : ''}${frozenClass}" data-day="${d}">
      <span class="day-tab-name">${dayName}</span>
      <span class="day-tab-label">יום ${d}</span>
      ${taskCount > 0 ? `<span class="day-tab-count">${taskCount} משימות</span>` : ''}
      ${violationDot}
      ${frozenTag}
    </button>`;
  }

  html += `</div>`;
  return html;
}

// ─── Weekly Dashboard (Always Visible Header) ────────────────────────────────

/** Render the sticky weekly performance dashboard that stays visible across day tabs */
function renderWeeklyDashboard(schedule: Schedule): string {
  const score = schedule.score;
  const numDays = store.getScheduleDays();
  const visibleViolations = filterVisibleViolations(schedule.violations);
  const totalViolations = visibleViolations.filter(v => v.severity === ViolationSeverity.Error).length;
  const warnings = visibleViolations.filter(v => v.severity === ViolationSeverity.Warning).length;
  const feasibleClass = schedule.feasible ? 'kpi-ok' : 'kpi-error';
  const feasibleText = schedule.feasible ? '✓ ישים' : '✗ לא ישים';

  // Per-day task counts
  let dayDots = '';
  for (let d = 1; d <= numDays; d++) {
    const count = schedule.tasks.filter(t => taskIntersectsDay(t, d)).length;
    const dayViolations = filterVisibleViolations(schedule.violations).filter(v => {
      if (v.severity !== ViolationSeverity.Error || !v.taskId) return false;
      const task = schedule.tasks.find(t => t.id === v.taskId);
      return task ? taskIntersectsDay(task, d) : false;
    }).length;
    const dotClass = dayViolations > 0 ? 'dot-error' : count > 0 ? 'dot-ok' : 'dot-empty';
    dayDots += `<span class="week-dot ${dotClass}" title="יום ${d}: ${count} משימות, ${dayViolations} הפרות"></span>`;
  }

  return `<div class="weekly-dashboard">
    <div class="dashboard-row">
      <div class="kpi-group">
        <div class="kpi ${feasibleClass}">
          <span class="kpi-value" id="kpi-feasible">${feasibleText}</span>
          <span class="kpi-label">סטטוס ${numDays} ימים</span>
        </div>
        <div class="kpi">
          <span class="kpi-value" id="kpi-score" data-target="${score.compositeScore.toFixed(1)}">${score.compositeScore.toFixed(1)}</span>
          <span class="kpi-label">ציון שבצ"ק</span>
        </div>
        <div class="kpi ${totalViolations > 0 ? 'kpi-error' : 'kpi-ok'}">
          <span class="kpi-value" id="kpi-violations" data-target="${totalViolations}">${totalViolations}</span>
          <span class="kpi-label">הפרות</span>
        </div>
        <div class="kpi">
          <span class="kpi-value" id="kpi-warnings" data-target="${warnings}">${warnings}</span>
          <span class="kpi-label">אזהרות</span>
        </div>
      </div>
      <div class="week-dots-strip">
        <span class="week-dots-label">ימים</span>
        <div class="week-dots">${dayDots}</div>
      </div>
    </div>
    <div class="dashboard-meta">
      ${scheduleActualAttempts > 0
        ? `התוצאה הטובה ביותר מתוך ${scheduleActualAttempts} ניסיונות, בזמן חישוב של ${(scheduleElapsed / 1000).toFixed(1)} שניות.`
        : 'שבצ"ק נבנה ידנית.'}
    </div>
  </div>`;
}

// ─── Participant Status Sidebar ──────────────────────────────────────────────

/** Build a single sidebar entry's HTML */
function renderSidebarEntry(
  entry: { p: Participant; w: { totalHours: number; effectiveHours: number; hotHours: number; coldHours: number; nonLightCount: number }; pctOfPeriod: number; perDay: Map<number, number> },
  totalPeriodHours: number,
): string {
  const p = entry.p;
  const barPct = Math.min(entry.pctOfPeriod * (100 / 30), 100);
  const barWidth = barPct;
  const overloaded = entry.pctOfPeriod > 25;
  const underloaded = entry.pctOfPeriod < 5;
  const barClass = overloaded ? 'wbar-over' : underloaded ? 'wbar-under' : 'wbar-normal';

  let tooltipParts: string[] = [];
  for (let d = 1; d <= store.getScheduleDays(); d++) {
    const dayHrs = entry.perDay.get(d) || 0;
    const ttBase = store.getScheduleDate();
    const ttDate = new Date(ttBase.getFullYear(), ttBase.getMonth(), ttBase.getDate() + d - 1);
    tooltipParts.push(`${hebrewDayName(ttDate)}: ${dayHrs.toFixed(1)} שע'`);
  }
  const todayHrs = entry.perDay.get(currentDay) || 0;
  const todayRatio = totalPeriodHours > 0 ? todayHrs / totalPeriodHours : 0;
  const todayBarWidth = Math.min(todayRatio * 100 * (100 / 30), barWidth);

  const diagTooltip = `שעות עומס: ${entry.w.effectiveHours.toFixed(1)} (${entry.pctOfPeriod.toFixed(1)}%)\n` +
    `משימות כבדות: ${entry.w.nonLightCount}\n` +
    tooltipParts.join('\n');

  return `<div class="sidebar-entry">
    <div class="sidebar-name">
      <span class="participant-hover" data-pid="${p.id}">${p.name}</span>
      <span class="sidebar-meta">${groupBadge(p.group)} ${levelBadge(p.level)}</span>
    </div>
    <div class="sidebar-bar-row">
      <div class="sidebar-bar-bg" title="${diagTooltip}">
        <div class="sidebar-bar-fill ${barClass}" style="width:${barWidth}%"></div>
        <div class="sidebar-bar-today" style="width:${todayBarWidth}%"></div>
        <span class="sidebar-bar-label">${entry.w.effectiveHours.toFixed(1)} שעות עומס (${entry.pctOfPeriod.toFixed(1)}%)</span>
      </div>
      <span class="sidebar-today-tag" title="היום (יום ${currentDay}): ${todayHrs.toFixed(1)} שע'">
        ${hebrewDayName(new Date(store.getScheduleDate().getFullYear(), store.getScheduleDate().getMonth(), store.getScheduleDate().getDate() + currentDay - 1))}: ${todayHrs.toFixed(1)} שע'
      </span>
    </div>
  </div>`;
}

/**
 * Render the participant sidebar with split pools:
 * - L0 workload shown by default (primary focus)
 * - Senior (L2-L4) workload hidden behind a toggle button
 */
function renderParticipantSidebar(schedule: Schedule): string {
  const workloads = computeWeeklyWorkloads(schedule.participants, schedule.assignments, schedule.tasks);
  const numDays = store.getScheduleDays();
  const totalPeriodHours = numDays * 24;

  const sidebarTaskMap = new Map<string, Task>(schedule.tasks.map(t => [t.id, t]));

  // Build all entries
  const allEntries = schedule.participants.map(p => {
    const w = workloads.get(p.id) || { totalHours: 0, effectiveHours: 0, hotHours: 0, coldHours: 0, nonLightCount: 0 };
    const pctOfPeriod = totalPeriodHours > 0 ? (w.effectiveHours / totalPeriodHours) * 100 : 0;
    const perDay = computePerDayHours(p.id, schedule, sidebarTaskMap);
    return { p, w, pctOfPeriod, perDay };
  });

  // Split into L0 and Senior pools
  const l0Entries = allEntries
    .filter(e => e.p.level === Level.L0)
    .sort((a, b) => b.w.effectiveHours - a.w.effectiveHours);
  const seniorEntries = allEntries
    .filter(e => e.p.level !== Level.L0)
    .sort((a, b) => b.w.effectiveHours - a.w.effectiveHours);

  // L0 stats
  const l0Total = l0Entries.reduce((s, e) => s + e.w.effectiveHours, 0);
  const l0Avg = l0Entries.length > 0 ? l0Total / l0Entries.length : 0;
  const l0Var = l0Entries.length > 0
    ? l0Entries.reduce((s, e) => s + (e.w.effectiveHours - l0Avg) ** 2, 0) / l0Entries.length : 0;
  const l0Sigma = Math.sqrt(l0Var);

  // Senior stats
  const seniorTotal = seniorEntries.reduce((s, e) => s + e.w.effectiveHours, 0);
  const seniorAvg = seniorEntries.length > 0 ? seniorTotal / seniorEntries.length : 0;
  const seniorVar = seniorEntries.length > 0
    ? seniorEntries.reduce((s, e) => s + (e.w.effectiveHours - seniorAvg) ** 2, 0) / seniorEntries.length : 0;
  const seniorSigma = Math.sqrt(seniorVar);

  // ── L0 Section (always visible) ──
  let html = `<div class="participant-sidebar${_sidebarCollapsed ? ' sidebar-collapsed' : ''}">`;

  // Always render the toggle button
  html += `<button class="sidebar-toggle" data-action="sidebar-toggle" title="${_sidebarCollapsed ? 'הרחב סרגל עומס' : 'כווץ סרגל עומס'}">${_sidebarCollapsed ? '◀' : '▶'}</button>`;

  if (_sidebarCollapsed) {
    // Mini bars — tiny workload indicators for each L0 participant
    html += `<div class="sidebar-mini">`;
    for (const entry of l0Entries) {
      const pct = entry.w.effectiveHours / totalPeriodHours;
      const cls = pct > WORKLOAD_OVER_THRESHOLD ? 'mini-over' : pct < WORKLOAD_UNDER_THRESHOLD ? 'mini-under' : 'mini-normal';
      html += `<div class="sidebar-mini-bar ${cls}" title="${entry.p.name}: ${entry.w.effectiveHours.toFixed(1)} שעות עומס"></div>`;
    }
    html += `</div></div>`;
    return html;
  }

  html += `<div class="sidebar-header">
      <div class="sidebar-header-row">
        <h3>השוואת עומס</h3>
      </div>
      <div class="sidebar-avg">ממוצע: ${l0Avg.toFixed(1)} שעות עומס · ${l0Entries.length} משתתפים · ${numDays} ימים</div>
    </div>
    <div class="sidebar-entries">`;

  for (const entry of l0Entries) {
    html += renderSidebarEntry(entry, totalPeriodHours);
  }

  html += `</div>`;

  // ── Senior Section (hidden by default) ──
  html += `
    <div class="sidebar-senior-divider">
      <button class="btn-senior-toggle" id="btn-senior-toggle" title="הצג / הסתר עומס סגל (L2-L4)">
        👤 עומס סגל (${seniorEntries.length})
        <span class="senior-toggle-arrow" id="senior-toggle-arrow">▶</span>
      </button>
    </div>
    <div class="sidebar-senior-panel hidden" id="sidebar-senior-panel">
      <div class="sidebar-header sidebar-header-senior">
        <h3>עומס סגל (L2-L4)</h3>
        <div class="sidebar-avg">ממוצע: ${seniorAvg.toFixed(1)} שעות עומס · σ ${seniorSigma.toFixed(2)} · ${seniorEntries.length} משתתפים</div>
      </div>
      <div class="sidebar-entries">`;

  for (const entry of seniorEntries) {
    html += renderSidebarEntry(entry, totalPeriodHours);
  }

  html += `</div></div></div>`;
  return html;
}

// ─── Schedule Tab ────────────────────────────────────────────────────────────

function renderScheduleTab(): string {
  const preflight = runPreflight();
  const liveMode = store.getLiveModeState();
  const numDays = store.getScheduleDays();

  // Build Live Mode day/hour options
  let liveModeControls = '';
  if (currentSchedule) {
    const baseDate = store.getScheduleDate();
    const daySelectOpts: { value: string; label: string; selected: boolean }[] = [];
    for (let d = 1; d <= numDays; d++) {
      const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
      const label = `יום ${hebrewDayName(date)}`;
      let selected = false;
      if (liveMode.enabled) {
        const anchor = liveMode.currentTimestamp;
        const dayStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1, DAY_START_HOUR, 0);
        const dayEnd = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d, DAY_START_HOUR, 0);
        selected = anchor.getTime() >= dayStart.getTime() && anchor.getTime() < dayEnd.getTime();
      }
      daySelectOpts.push({ value: String(d), label, selected });
    }
    // Fallback: if no day matched (anchor outside schedule range), select day 1
    if (liveMode.enabled && !daySelectOpts.some(o => o.selected) && daySelectOpts.length > 0) {
      daySelectOpts[0].selected = true;
    }

    const anchorHour = liveMode.enabled ? liveMode.currentTimestamp.getHours() : 5;
    const hourSelectOpts: { value: string; label: string; selected: boolean }[] = [];
    for (let h = 0; h < 24; h++) {
      hourSelectOpts.push({ value: String(h), label: `${String(h).padStart(2, '0')}:00`, selected: h === anchorHour });
    }

    liveModeControls = `
      <div class="live-mode-controls">
        <label class="live-mode-toggle" title="Enable Live Mode to freeze past assignments">
          <input type="checkbox" id="chk-live-mode" ${liveMode.enabled ? 'checked' : ''} />
          <span class="live-toggle-label">🔴 מצב חי</span>
        </label>
        ${liveMode.enabled ? `
          <div class="live-mode-picker">
            <span class="live-picker-label">זמן נוכחי:</span>
            ${renderCustomSelect({ id: 'gm-live-day', options: daySelectOpts, className: 'input-sm' })}
            ${renderCustomSelect({ id: 'gm-live-hour', options: hourSelectOpts, className: 'input-sm' })}
          </div>
        ` : ''}
      </div>`;
  }

  let html = `<div class="tab-toolbar schedule-toolbar${_manualBuildActive ? ' schedule-toolbar-manual' : ''}">
    <div class="toolbar-left"><h2>תצוגת שבצ"ק</h2>
      <span class="text-muted" style="margin-inline-start:12px">שבצ"ק ל-${numDays} ימים</span>
    </div>
    <div class="toolbar-right">
      ${liveModeControls}
      <span class="toolbar-group toolbar-group--generate">
        <label class="scenarios-label" for="input-days" title="מספר ימים בשבצ\"ק">ימים
          <input type="number" id="input-days" class="input-scenarios" min="1" max="7" step="1" value="${numDays}" ${_isOptimizing ? 'disabled' : ''} />
        </label>
        <label class="scenarios-label" for="input-scenarios" title="מספר ניסיונות אופטימיזציה לבדיקה">ניסיונות
          <input type="number" id="input-scenarios" class="input-scenarios" min="50" max="50000" step="50" value="${OPTIM_ATTEMPTS}" ${_isOptimizing ? 'disabled' : ''} />
        </label>
        <button class="btn-primary ${_scheduleDirty && currentSchedule ? 'btn-generate-dirty' : ''}" id="btn-generate" ${!preflight.canGenerate || _isOptimizing ? 'disabled' : ''}
          ${!preflight.canGenerate ? 'title="תקן בעיות קריטיות בכללי המשימות תחילה"' : ''}>
          ${_isOptimizing ? '⏳ מייעל…' : currentSchedule ? '🔄 צור מחדש' : '⚡ צור שבצ"ק'}
        </button>
        ${!currentSchedule && preflight.canGenerate && !_isOptimizing ? `<button class="btn-sm btn-outline" id="btn-create-manual" title="צור שבצ\"ק ריק לבנייה ידנית">✏️ בנייה ידנית</button>` : ''}
      </span>
      <span class="toolbar-group toolbar-group--state">
        ${currentSchedule ? `<button class="btn-sm ${_manualBuildActive ? 'btn-primary' : 'btn-outline'}" id="btn-manual-build" title="${_manualBuildActive ? 'יציאה ממצב בנייה ידנית' : 'בנייה ידנית של שבצ\"ק'}">${_manualBuildActive ? '✕ יציאה מבנייה ידנית' : '✏️ בנייה ידנית'}</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-reset-storage" title="אפס להגדרות ברירת מחדל ומחק נתונים שמורים">🔄 אפס</button>` : ''}
        <button class="btn-sm ${_snapshotPanelOpen ? 'btn-primary' : 'btn-outline'}" id="btn-snap-toggle" title="תמונות מצב שמורות">💾 שמירת שבצקים${store.getAllSnapshots().length > 0 ? ` (${store.getAllSnapshots().length})` : ''}</button>
        ${renderContinuityChip()}
        ${!currentSchedule && !_continuityJson.trim() ? `<button class="btn-sm btn-outline" id="btn-continuity-import" title="ייבוא נתוני המשכיות מהשבצ\"ק הקודם">📋 ייבוא המשכיות</button>` : ''}
      </span>
      <span class="toolbar-group toolbar-group--day-actions">
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-export-day-json" title="ייצוא מצב יום ${currentDay} כ-JSON להמשכיות">📋 ייצוא יום</button>` : ''}
        ${currentSchedule && currentDay < store.getScheduleDays() ? `<button class="btn-sm btn-outline" id="btn-generate-from-day" title="צור שבצ\"ק חדש מסוף יום ${currentDay}">🔗 המשך מכאן</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-export-pdf" title="ייצוא PDF">📤 ייצוא</button>` : ''}
      </span>
    </div>
  </div>`;

  // ── Snapshot Library Panel (collapsible) ──
  if (_snapshotPanelOpen) {
    html += renderSnapshotPanel();
  }

  if (_scheduleDirty && currentSchedule) {
    html += `<div class="dirty-notice">⚠ השיבוץ לא מעודכן. מומלץ ליצור אותו מחדש.</div>`;
  }

  if (!preflight.canGenerate) {
    const crits = preflight.findings.filter(f => f.severity === 'Critical');
    html += `<div class="alert alert-error">
      <strong>לא ניתן ליצור שיבוץ - נמצאו ${crits.length} בעיות קריטיות:</strong>
      <ul>${crits.map(f => `<li>${f.message}</li>`).join('')}</ul>
      <p>עבור ל<strong>מסך פירוט משימות</strong> כדי לתקן אותן.</p>
    </div>`;
  }

  if (!currentSchedule) {
    if (preflight.canGenerate) {
      html += `<div class="empty-state">
        <div class="empty-icon">${SVG_ICONS.tasks}</div>
        <p>טרם נוצר שבצ"ק.</p>
        <p class="text-muted">הגדר משתתפים ומשימות, ואז לחץ על "צור שבצ"ק" או בנה ידנית.</p>
        <button class="btn-sm btn-outline" id="btn-create-manual-empty" title="צור שבצ\"ק ריק לבנייה ידנית" style="margin-top:12px">✏️ התחל בנייה ידנית</button>
      </div>`;
    }
    return html;
  }

  const s = currentSchedule;

  // Weekly Dashboard — hide in manual build mode on mobile to save space
  if (!_manualBuildActive) {
    html += renderWeeklyDashboard(s);
  }

  // Day Navigator tabs
  html += renderDayNavigator();
  // Manual-build undo strip
  if (_manualBuildActive) {
    const totalSlots = s.tasks.reduce((sum, t) => sum + t.slots.length, 0);
    const filledSlots = s.assignments.length;
    html += `<div class="manual-build-strip">
      <span class="manual-build-status">מצב בנייה ידנית — ${filledSlots}/${totalSlots} משבצות מלאות</span>
      <button class="btn-sm btn-outline" id="btn-manual-undo" ${_manualUndoStack.length === 0 ? 'disabled' : ''} title="ביטול פעולה אחרונה">↩ ביטול</button>
    </div>`;
  }

  // Main layout: content + sidebar
  const manualCtx = { active: _manualBuildActive, selectedTaskId: _manualSelectedTaskId ?? undefined, selectedSlotId: _manualSelectedSlotId ?? undefined };
  html += `<div class="schedule-layout">`;
  html += `<div class="schedule-main">`;
  html += `<section><h2>שיבוצים <span class="count">${getFilteredAssignments(s).length}</span></h2>${renderScheduleGrid(s, currentDay, store.getLiveModeState(), manualCtx)}</section>`;
  // Participant warehouse (desktop: inline; mobile: hidden, shown via bottom sheet)
  if (_manualBuildActive) {
    html += renderParticipantWarehouse(s);
  }
  // Availability inspector strip — between schedule grid and gantt
  html += renderAvailabilityStrip();

  // Gantt chart: wrapped in mobile-toggleable accordion
  const ganttExpanded = !_manualBuildActive;
  html += `<section class="gantt-section">`;
  html += `<button class="gantt-mobile-toggle" aria-expanded="${ganttExpanded}" data-action="toggle-gantt">${SVG_ICONS.chart} מערכת שעות כללית</button>`;
  html += `<div class="gantt-section-content"${_manualBuildActive ? ' style="display:none"' : ''}><h2 class="gantt-desktop-title">מערכת שעות כללית</h2>${renderGanttChart(s)}</div>`;
  html += `</section>`;
  // In manual build mode, collapse violations by default (empty schedule generates hundreds)
  const violationCount = filterVisibleViolations(s.violations).length;
  if (_manualBuildActive) {
    html += `<section class="violations-section violations-collapsed">
      <button class="violations-toggle" data-action="toggle-violations" aria-expanded="false">
        <h2>הפרות אילוצים <span class="count">${violationCount}</span></h2>
        <span class="violations-toggle-icon">▸</span>
      </button>
    </section>`;
  } else {
    html += `<section><h2>הפרות אילוצים <span class="count">${violationCount}</span></h2>${renderViolations(s)}</section>`;
  }
  html += `</div>`;
  html += renderParticipantSidebar(s);
  // Mobile-only FAB to toggle sidebar drawer
  html += `<button class="sidebar-fab" title="עומס עבודה" aria-label="הצג סרגל עומס">${SVG_ICONS.chart}<span class="sidebar-fab-label">עומסים</span></button>`;
  html += `</div>`;

  // Optimization overlay (rendered inside tab so it covers the schedule board)
  html += renderOptimOverlay();

  return html;
}

// ─── Manual Build: Participant Warehouse ────────────────────────────────────

function renderParticipantWarehouse(schedule: Schedule): string {
  const participants = schedule.participants;
  const l0Pool = participants.filter(p => p.level === Level.L0);
  const seniorPool = participants.filter(p => p.level !== Level.L0);

  // Count current-day assignments per participant
  const { start: dayStart, end: dayEnd } = getDayWindow(currentDay);
  const dayTaskIds = new Set(schedule.tasks.filter(t => {
    const s = new Date(t.timeBlock.start).getTime();
    return s >= dayStart.getTime() && s < dayEnd.getTime();
  }).map(t => t.id));
  const dayAssignmentCounts = new Map<string, number>();
  for (const a of schedule.assignments) {
    if (dayTaskIds.has(a.taskId)) {
      dayAssignmentCounts.set(a.participantId, (dayAssignmentCounts.get(a.participantId) || 0) + 1);
    }
  }

  const filterText = _warehouseFilter.trim().toLowerCase();

  function renderPool(pool: Participant[], label: string): string {
    let filtered = pool;
    if (filterText) {
      filtered = pool.filter(p => p.name.toLowerCase().includes(filterText));
    }

    // Sort: eligible first (if slot selected), then by name
    if (_eligibleForSelectedSlot) {
      filtered.sort((a, b) => {
        const aElig = _eligibleForSelectedSlot!.has(a.id) ? 0 : 1;
        const bElig = _eligibleForSelectedSlot!.has(b.id) ? 0 : 1;
        if (aElig !== bElig) return aElig - bElig;
        return a.name.localeCompare(b.name, 'he');
      });
    }

    const cards = filtered.map(p => {
      const dayCount = dayAssignmentCounts.get(p.id) || 0;
      let cardClass = 'warehouse-card';
      if (_eligibleForSelectedSlot) {
        cardClass += _eligibleForSelectedSlot.has(p.id) ? ' wc-eligible' : ' wc-ineligible';
      }
      return `<div class="${cardClass}" data-pid="${p.id}" role="button" tabindex="0">
        <span class="wc-name" style="color:${groupColor(p.group)}">${escHtml(p.name)}</span>
        <span class="wc-badges">${levelBadge(p.level)} ${certBadges(p.certifications, '')}</span>
        ${dayCount > 0 ? `<span class="wc-load" title="${dayCount} שיבוצים היום">${dayCount}</span>` : ''}
      </div>`;
    }).join('');

    return `<div class="warehouse-pool">
      <div class="warehouse-pool-header">${label} (${filtered.length})</div>
      <div class="warehouse-pool-cards">${cards || '<span class="text-muted">אין משתתפים</span>'}</div>
    </div>`;
  }

  return `<section class="manual-warehouse" id="manual-warehouse">
    <div class="warehouse-header">
      <h3>מאגר משתתפים</h3>
      <input type="search" class="warehouse-filter" id="warehouse-filter" placeholder="חיפוש שם..." value="${escHtml(_warehouseFilter)}" />
    </div>
    ${renderPool(l0Pool, 'דרגה 0')}
    ${renderPool(seniorPool, 'סגל (L2-L4)')}
  </section>`;
}

/**
 * Build warehouse HTML for use inside a mobile bottom sheet.
 * Includes a header with slot context and a remove button if the slot is filled.
 */
function buildWarehouseSheetContent(schedule: Schedule): string {
  const task = schedule.tasks.find(t => t.id === _manualSelectedTaskId);
  if (!task || !_manualSelectedSlotId) return '';
  const slot = task.slots.find(s => s.slotId === _manualSelectedSlotId);
  if (!slot) return '';

  const existingAssignment = schedule.assignments.find(
    a => a.taskId === task.id && a.slotId === _manualSelectedSlotId
  );
  const existingParticipant = existingAssignment
    ? schedule.participants.find(p => p.id === existingAssignment.participantId)
    : undefined;

  const levels = slot.acceptableLevels.map(l => l.level).join('/');
  const cleanTaskName = (task.sourceName || task.name).replace(/^D\d+\s+/, '');
  const slotLabel = slot.label ? ` — ${slot.label}` : '';
  const timeRange = `${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}`;
  let header = `<div class="warehouse-sheet-header">
    <div class="warehouse-sheet-title">בחר משתתף ל-${escHtml(cleanTaskName)}${escHtml(slotLabel)}</div>
    <div class="warehouse-sheet-reqs">${timeRange} ${levels ? `L${levels}` : ''} ${certBadges(slot.requiredCertifications, '')}</div>
  </div>`;

  if (existingAssignment && existingParticipant) {
    header += `<button class="btn-manual-remove-sheet" data-action="manual-remove" data-assignment-id="${existingAssignment.id}">✕ הסר שיבוץ של ${escHtml(existingParticipant.name)}</button>`;
  }

  // Render participant cards
  const participants = schedule.participants;
  const filterText = _warehouseFilter.trim().toLowerCase();
  let filtered = filterText ? participants.filter(p => p.name.toLowerCase().includes(filterText)) : [...participants];

  // Sort eligible first
  if (_eligibleForSelectedSlot) {
    filtered.sort((a, b) => {
      const aElig = _eligibleForSelectedSlot!.has(a.id) ? 0 : 1;
      const bElig = _eligibleForSelectedSlot!.has(b.id) ? 0 : 1;
      if (aElig !== bElig) return aElig - bElig;
      return a.name.localeCompare(b.name, 'he');
    });
  }

  const cards = filtered.map(p => {
    let cardClass = 'warehouse-card warehouse-card-sheet';
    if (_eligibleForSelectedSlot) {
      cardClass += _eligibleForSelectedSlot.has(p.id) ? ' wc-eligible' : ' wc-ineligible';
    }
    return `<div class="${cardClass}" data-pid="${p.id}" role="button" tabindex="0">
      <span class="wc-name" style="color:${groupColor(p.group)}">${escHtml(p.name)}</span>
      <span class="wc-badges">${levelBadge(p.level)} ${certBadges(p.certifications, '')}</span>
    </div>`;
  }).join('');

  return `${header}
    <div class="warehouse-sheet-filter">
      <input type="search" class="warehouse-sheet-search" id="warehouse-sheet-search" placeholder="🔍 חיפוש שם..." autocomplete="off" />
    </div>
    <div class="warehouse-sheet-cards">${cards}</div>`;
}

// ─── Manual Build: Interaction Handlers ─────────────────────────────────────

function handleManualSlotClick(taskId: string, slotId: string): void {
  if (!currentSchedule) return;

  // Toggle off if already selected
  if (_manualSelectedTaskId === taskId && _manualSelectedSlotId === slotId) {
    clearManualSelection();
    renderAll();
    return;
  }

  // Check if the slot is frozen
  const task = currentSchedule.tasks.find(t => t.id === taskId);
  if (!task) return;
  const lm = store.getLiveModeState();
  if (lm.enabled && !isFutureTask(task, lm.currentTimestamp)) {
    showToast('המשימה מוקפאת — לא ניתן לערוך', { type: 'error' });
    return;
  }

  // Select slot + compute eligible
  _manualSelectedTaskId = taskId;
  _manualSelectedSlotId = slotId;

  const allTasks = currentSchedule.tasks;
  const disabledHC = engine ? new Set(store.getAlgorithmSettings().disabledHardConstraints) : undefined;
  const eligible = getEligibleParticipantsForSlot(task, slotId, currentSchedule.participants, currentSchedule.assignments, allTasks, disabledHC, store.getCategoryBreakHours() * 3600000);
  _eligibleForSelectedSlot = new Set(eligible.map(p => p.id));

  if (isSmallScreen) {
    openWarehouseSheet();
  } else {
    renderAll();
  }
}

async function handleManualParticipantClick(participantId: string): Promise<void> {
  if (!currentSchedule || !engine || !_manualSelectedTaskId || !_manualSelectedSlotId) return;

  const task = currentSchedule.tasks.find(t => t.id === _manualSelectedTaskId);
  if (!task) return;
  const slot = task.slots.find(s => s.slotId === _manualSelectedSlotId);
  if (!slot) return;
  const participant = currentSchedule.participants.find(p => p.id === participantId);
  if (!participant) return;

  // Build assignment context for eligibility check
  const taskMap = new Map(currentSchedule.tasks.map(t => [t.id, t]));
  const pMap = new Map(currentSchedule.participants.map(p => [p.id, p]));
  const existingAssignment = currentSchedule.assignments.find(
    a => a.taskId === task.id && a.slotId === _manualSelectedSlotId
  );

  // Build participant's current assignments, excluding the target slot if it's a replace
  const pAssignments = currentSchedule.assignments.filter(
    a => a.participantId === participantId && !(a.taskId === task.id && a.slotId === _manualSelectedSlotId)
  );

  const taskAssignments = currentSchedule.assignments.filter(a => a.taskId === task.id);
  const disabledHC = new Set(store.getAlgorithmSettings().disabledHardConstraints);

  const reason = getRejectionReason(participant, task, slot, pAssignments, taskMap, {
    checkSameGroup: true,
    taskAssignments,
    participantMap: pMap,
    disabledHC,
    categoryBreakMs: store.getCategoryBreakHours() * 3600000,
  });

  if (reason) {
    showToast(REJECTION_MESSAGES[reason] || `אילוץ ${reason}`, { type: 'error' });
    return;
  }

  // Check if participant is already assigned elsewhere (not in target slot)
  const otherAssignment = currentSchedule.assignments.find(
    a => a.participantId === participantId && !(a.taskId === task.id && a.slotId === _manualSelectedSlotId)
  );
  if (otherAssignment) {
    const otherTask = currentSchedule.tasks.find(t => t.id === otherAssignment.taskId);
    const confirmed = await showConfirm(
      `${participant.name} משובץ כרגע ב-"${otherTask?.name || '?'}". להעביר לכאן?`
    );
    if (!confirmed) return;
  }

  executeManualAssignment(participantId, existingAssignment, otherAssignment || null);
}

function executeManualAssignment(
  participantId: string,
  existingInSlot: Assignment | undefined,
  moveFrom: Assignment | null,
): void {
  if (!currentSchedule || !engine) return;

  // Push undo snapshot
  _manualUndoStack.push(currentSchedule.assignments.map(a => ({ ...a })));

  // Remove from source slot if moving
  if (moveFrom) {
    currentSchedule.assignments = currentSchedule.assignments.filter(a => a.id !== moveFrom.id);
  }

  if (existingInSlot) {
    // Replace existing occupant
    existingInSlot.participantId = participantId;
    existingInSlot.status = AssignmentStatus.Manual;
    existingInSlot.updatedAt = new Date();
  } else {
    // New assignment
    currentSchedule.assignments.push({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: _manualSelectedTaskId!,
      slotId: _manualSelectedSlotId!,
      participantId,
      status: AssignmentStatus.Manual,
      updatedAt: new Date(),
    } as Assignment);
  }

  // Capture info for feedback before clearing selection
  const assignedParticipant = currentSchedule.participants.find(p => p.id === participantId);
  const assignedTask = currentSchedule.tasks.find(t => t.id === _manualSelectedTaskId);
  const assignedSlotId = _manualSelectedSlotId;

  engine.importSchedule(currentSchedule);
  clearManualSelection();
  revalidateAndRefresh();

  // Descriptive toast with participant + task name
  const pName = assignedParticipant?.name || '';
  const tName = assignedTask ? (assignedTask.sourceName || assignedTask.name).replace(/^D\d+\s+/, '') : '';
  showToast(`${pName} שובץ/ה ל${tName}`, { type: 'success' });

  // Highlight the just-assigned slot with a pulse animation
  if (assignedTask && assignedSlotId) {
    requestAnimationFrame(() => {
      const card = document.querySelector(`.assignment-card[data-task-id="${assignedTask.id}"][data-slot-id="${assignedSlotId}"]`);
      if (card) {
        card.classList.add('assignment-flash');
        card.addEventListener('animationend', () => card.classList.remove('assignment-flash'), { once: true });
      }
    });
  }
}

function handleManualRemove(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const a = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!a) return;

  if (a.status === AssignmentStatus.Frozen) {
    showToast('השיבוץ מוקפא — לא ניתן לשנות', { type: 'error' });
    return;
  }

  // Push undo snapshot
  _manualUndoStack.push(currentSchedule.assignments.map(a => ({ ...a })));

  currentSchedule.assignments = currentSchedule.assignments.filter(x => x.id !== assignmentId);
  engine.importSchedule(currentSchedule);
  clearManualSelection();
  revalidateAndRefresh();
  showToast('השיבוץ הוסר', { type: 'info' });
}

function handleManualUndo(): void {
  if (!currentSchedule || !engine || _manualUndoStack.length === 0) return;
  const prev = _manualUndoStack.pop()!;
  currentSchedule.assignments = prev;
  engine.importSchedule(currentSchedule);
  clearManualSelection();
  revalidateAndRefresh();
  showToast('הפעולה בוטלה', { type: 'info' });
}

/** Open warehouse as a bottom sheet on mobile */
function openWarehouseSheet(): void {
  if (!currentSchedule) return;
  const content = buildWarehouseSheetContent(currentSchedule);
  const handle = showBottomSheet(content, {
    title: 'בחר משתתף',
  });

  // Wire participant card clicks and search inside the sheet
  // Use requestAnimationFrame to ensure DOM is painted
  requestAnimationFrame(() => {
    const sheetBody = document.querySelector('.gm-bs-body');
    if (!sheetBody) return;

    // Wire search/filter
    const searchInput = sheetBody.querySelector('#warehouse-sheet-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        const cards = sheetBody.querySelectorAll('.warehouse-card[data-pid]');
        cards.forEach(card => {
          const name = card.querySelector('.wc-name')?.textContent?.toLowerCase() || '';
          (card as HTMLElement).style.display = name.includes(query) ? '' : 'none';
        });
      });
      searchInput.focus();
    }

    sheetBody.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const card = target.closest('.warehouse-card[data-pid]') as HTMLElement | null;
      if (card) {
        e.stopPropagation();
        const pid = card.dataset.pid!;
        handleManualParticipantClick(pid).then(() => {
          handle.close();
        });
        return;
      }
      // Remove button
      const removeBtn = target.closest('[data-action="manual-remove"]') as HTMLElement | null;
      if (removeBtn) {
        e.stopPropagation();
        const aid = removeBtn.dataset.assignmentId;
        if (aid) {
          handleManualRemove(aid);
          handle.close();
        }
      }
    });
  });
}

// ─── Snapshot Panel ─────────────────────────────────────────────────────────

// ─── Continuity Panel ───────────────────────────────────────────────────────

function renderContinuityChip(): string {
  const json = _continuityJson.trim();
  if (!json) return '';

  const parsed = parseContinuitySnapshot(_continuityJson);
  if ('error' in parsed) {
    return `<span class="continuity-chip continuity-chip-error" id="continuity-chip" title="${escHtml(parsed.error)}">
      <span class="continuity-chip-dot"></span>
      המשכיות: שגיאה
      <button class="continuity-chip-clear" id="btn-continuity-clear" title="נקה">✕</button>
    </span>`;
  }

  const pCount = parsed.participants.length;
  const aCount = parsed.participants.reduce((sum, p) => sum + p.assignments.length, 0);
  return `<span class="continuity-chip" id="continuity-chip" title="לחץ לצפייה/עריכה">
    <span class="continuity-chip-dot"></span>
    המשכיות: יום ${parsed.dayIndex}, ${pCount} משתתפים, ${aCount} שיבוצים
    <button class="continuity-chip-clear" id="btn-continuity-clear" title="נקה">✕</button>
  </span>`;
}

function validateContinuityJson(json: string): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = parseContinuitySnapshot(json);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const pCount = parsed.participants.length;
  const aCount = parsed.participants.reduce((sum, p) => sum + p.assignments.length, 0);
  return { ok: true, summary: `${pCount} משתתפים, ${aCount} שיבוצים (יום ${parsed.dayIndex})` };
}

function openContinuityImportModal(): void {
  showContinuityImport({
    defaultValue: _continuityJson,
    validate: validateContinuityJson,
  }).then((result) => {
    if (result !== null) {
      _continuityJson = result;
    }
    renderAll();
  });
}

function renderSnapshotPanel(): string {
  const snapshots = store.getAllSnapshots();
  const activeId = store.getActiveSnapshotId();
  const hasSchedule = !!currentSchedule;
  const maxSnaps = store.getMaxSnapshots();
  const nameFieldInvalid = _snapshotFormError ? ' aria-invalid="true" aria-describedby="snap-error"' : '';

  let html = `<div class="snapshot-panel">`;

  // ── Header row ──
  html += `<div class="snapshot-panel-header">
    <h3>💾 תמונות מצב שמורות <span class="count">${snapshots.length}/${maxSnaps}</span></h3>
    <button class="btn-sm btn-outline" id="btn-snap-close" title="סגור">✕</button>
  </div>`;

  // ── Save-as form / rename form ──
  if (_snapshotFormMode === 'save-as') {
    html += `<div class="snapshot-inline-form" id="snap-form">
      <div class="snapshot-form-row">
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" placeholder="לדוגמה: טיוטה 1" autofocus${nameFieldInvalid} /></label>
        <label>תיאור: <input class="snapshot-desc-input" type="text" id="snap-desc" placeholder="אופציונלי" /></label>
        <button class="btn-sm btn-primary" id="btn-snap-confirm-save">שמור</button>
        <button class="btn-sm btn-outline" id="btn-snap-cancel">ביטול</button>
      </div>
      <div class="snapshot-validation-error" id="snap-error">${_snapshotFormError}</div>
    </div>`;
  } else if (_snapshotFormMode === 'rename' && activeId) {
    const active = snapshots.find(s => s.id === activeId);
    html += `<div class="snapshot-inline-form" id="snap-form">
      <div class="snapshot-form-row">
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" value="${active?.name || ''}"${nameFieldInvalid} /></label>
        <label>תיאור: <input class="snapshot-desc-input" type="text" id="snap-desc" value="${active?.description || ''}" /></label>
        <button class="btn-sm btn-primary" id="btn-snap-confirm-rename">שמור</button>
        <button class="btn-sm btn-outline" id="btn-snap-cancel">ביטול</button>
      </div>
      <div class="snapshot-validation-error" id="snap-error">${_snapshotFormError}</div>
    </div>`;
  } else {
    // Primary action: Save current schedule
    html += `<div class="snapshot-actions-primary">
      <button class="btn-sm btn-primary" id="btn-snap-save-as" ${!hasSchedule ? 'disabled' : ''}>+ שמור תמונת מצב חדשה</button>
    </div>`;
  }

  // ── Snapshot list ──
  if (snapshots.length === 0) {
    html += `<div class="snapshot-empty">
      <span class="text-muted">אין תמונות מצב שמורות. צור שיבוץ ואז שמור תמונת מצב.</span>
    </div>`;
  } else {
    html += `<div class="snapshot-list">`;
    for (const snap of snapshots) {
      const isActive = snap.id === activeId;
      const date = new Date(snap.createdAt);
      const dateStr = date.toLocaleDateString('he-IL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      html += `<div class="snapshot-item ${isActive ? 'snapshot-item-active' : ''}" data-snap-id="${snap.id}">
        <div class="snapshot-item-main">
          <span class="snapshot-item-name">${snap.name}</span>
          ${isActive && _snapshotDirty ? '<span class="snapshot-dirty-badge">שונה</span>' : ''}
          <span class="snapshot-item-date text-muted">${dateStr}</span>
        </div>
        ${snap.description ? `<div class="snapshot-item-desc text-muted">${snap.description}</div>` : ''}
        <div class="snapshot-item-actions">
          <button class="btn-xs btn-primary" data-snap-action="load" data-snap-id="${snap.id}" title="טען תמונת מצב זו">▶ טען</button>
          ${isActive && _snapshotDirty ? `<button class="btn-xs btn-outline" data-snap-action="update" data-snap-id="${snap.id}" title="עדכן עם השבצ\\"ק הנוכחי">עדכן</button>` : ''}
          <button class="btn-xs btn-outline" data-snap-action="rename" data-snap-id="${snap.id}" title="שנה שם">✎</button>
          <button class="btn-xs btn-outline" data-snap-action="duplicate" data-snap-id="${snap.id}" title="שכפל">⧉</button>
          <button class="btn-xs btn-danger-outline" data-snap-action="delete" data-snap-id="${snap.id}" title="מחק">✕</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Snapshot Load Logic ─────────────────────────────────────────────────────

function loadScheduleSnapshot(snapshotId: string): void {
  const snapshot = store.getSnapshotById(snapshotId);
  if (!snapshot) return;

  // 1. Restore algorithm settings
  store.setAlgorithmSettings({
    config: snapshot.algorithmSettings.config,
    disabledHardConstraints: snapshot.algorithmSettings.disabledHardConstraints,
  });

  // 2. Reconcile with current participants
  const currentParticipants = store.getAllParticipants();
  const storeIds = new Set(currentParticipants.map(p => p.id));
  const storeMap = new Map(currentParticipants.map(p => [p.id, p]));

  const reconciledAssignments = snapshot.schedule.assignments.filter(
    a => storeIds.has(a.participantId),
  );
  const reconciledParticipants = currentParticipants.filter(
    p => snapshot.schedule.participants.some(sp => sp.id === p.id),
  );

  const reconciledSchedule: Schedule = {
    ...snapshot.schedule,
    participants: reconciledParticipants,
    assignments: reconciledAssignments,
  };

  // 3. Create engine with restored algorithm settings
  const algoSettings = store.getAlgorithmSettings();
  engine = new SchedulingEngine(
    algoSettings.config,
    store.getDisabledHCSet(),
    store.getCategoryBreakHours() * 3600000,
  );

  // 4. Load data into engine
  engine.addParticipants(reconciledParticipants);
  engine.addTasks(snapshot.schedule.tasks);
  engine.importSchedule(reconciledSchedule);

  // 5. Re-validate
  engine.revalidateFull();
  currentSchedule = engine.getSchedule()!;
  currentDay = 1;
  _scheduleDirty = false;
  _snapshotDirty = false;

  // 6. Apply live mode freeze if active
  const liveMode = store.getLiveModeState();
  if (liveMode.enabled && currentSchedule) {
    freezeAssignments(currentSchedule, liveMode.currentTimestamp);
  }

  // 7. Persist as current schedule
  store.saveSchedule(currentSchedule);
  store.setActiveSnapshotId(snapshotId);

  // 8. Re-render
  renderAll();
}

// ─── Violations ──────────────────────────────────────────────────────────────

function renderViolations(schedule: Schedule): string {
  const visible = filterVisibleViolations(schedule.violations);
  const hard = visible.filter(v => v.severity === ViolationSeverity.Error);
  const warn = visible.filter(v => v.severity === ViolationSeverity.Warning);

  if (hard.length === 0 && warn.length === 0) {
    return `<div class="alert alert-ok">✓ אין הפרות אילוצים בכל ${store.getScheduleDays()} הימים.</div>`;
  }

  // Separate into current-day and other-day violations
  const dayTaskIds = new Set(getFilteredTasks(schedule).map(t => t.id));

  let html = '';
  if (hard.length > 0) {
    const today = hard.filter(v => v.taskId && dayTaskIds.has(v.taskId));
    const other = hard.filter(v => !v.taskId || !dayTaskIds.has(v.taskId));

    html += `<div class="alert alert-error"><strong>הפרות חמורות (${hard.length})</strong>`;
    if (today.length > 0) {
      html += `<div class="violation-section"><em>יום ${currentDay}:</em><ul>`;
      for (const v of today) html += `<li><code>${violationLabel(v.code)}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    if (other.length > 0) {
      html += `<div class="violation-section violation-other"><em>ימים אחרים:</em><ul>`;
      for (const v of other) html += `<li><code>${violationLabel(v.code)}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    html += '</div>';
  }
  if (warn.length > 0) {
    html += `<div class="alert alert-warn"><strong>אזהרות (${warn.length})</strong><ul>`;
    for (const w of warn) html += `<li><code>${violationLabel(w.code)}</code> ${w.message}</li>`;
    html += '</ul></div>';
  }
  return html;
}

// ─── Assignments Table ───────────────────────────────────────────────────────

/*
function renderAssignmentsTable(schedule: Schedule): string {
  const filteredTasks = getFilteredTasks(schedule);
  const filteredAssignments = getFilteredAssignments(schedule);
  const liveMode = store.getLiveModeState();

  const taskMap = new Map<string, Task>();
  for (const t of filteredTasks) taskMap.set(t.id, t);
  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  const groupedByTask = new Map<string, Assignment[]>();
  for (const a of filteredAssignments) {
    const arr = groupedByTask.get(a.taskId) || [];
    arr.push(a);
    groupedByTask.set(a.taskId, arr);
  }

  // Sort tasks by start time
  const sortedTasks = [...filteredTasks].sort(
    (a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime()
  );

  let html = `<div class="table-responsive"><table class="table">
    <thead><tr><th>משימה</th><th>סוג</th><th>זמן</th><th>עמדה</th><th>משתתף</th>
    <th>דרגה</th><th>קבוצה</th><th>סטטוס</th><th>פעולות</th></tr></thead><tbody>`;

  for (const task of sortedTasks) {
    const taskAssignments = groupedByTask.get(task.id) || [];
    const taskIsFrozen = liveMode.enabled && !isFutureTask(task, liveMode.currentTimestamp);

    // Cross-day indicators
    const contFromPrev = taskStartsBefore(task, currentDay);
    const contToNext = taskEndsAfter(task, currentDay);
    let crossDayTag = '';
    if (contFromPrev && contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-both" title="ממשיך מיום ${currentDay - 1} ליום ${currentDay + 1}">◀ ▶</span>`;
    } else if (contFromPrev) {
      crossDayTag = `<span class="cross-day-badge cross-from" title="המשך מיום ${currentDay - 1}">▶ מיום ${currentDay - 1}</span>`;
    } else if (contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-to" title="ממשיך ליום ${currentDay + 1}">◀ ליום ${currentDay + 1}</span>`;
    }

    if (taskAssignments.length === 0) {
      html += `<tr class="row-warning"><td><strong>${task.name}</strong> ${crossDayTag}</td><td>${taskBadge(task)}</td>
        <td>${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</td>
        <td colspan="6"><em class="text-danger">⚠ אין שיבוצים</em></td></tr>`;
      continue;
    }

    taskAssignments.forEach((a, i) => {
      const p = pMap.get(a.participantId);
      const slot = task.slots.find(s => s.slotId === a.slotId);
      const isFrozen = a.status === AssignmentStatus.Frozen;
      const rowClass = a.status === AssignmentStatus.Conflict ? 'row-error' : isFrozen ? 'row-frozen' : '';
      html += `<tr class="${rowClass}" data-assignment-id="${a.id}">`;
      if (i === 0) {
        html += `<td rowspan="${taskAssignments.length}" class="task-cell task-tooltip-hover${taskIsFrozen ? ' task-cell-frozen' : ''}" data-task-id="${task.id}" style="border-inline-start:4px solid ${task.color || '#7f8c8d'}">
          <strong>${task.name}</strong>${task.isLight ? ' <small>(קלה)</small>' : ''} ${crossDayTag}
          ${taskIsFrozen ? '<span class="frozen-label">🧊 מוקפא</span>' : ''}</td>
          <td rowspan="${taskAssignments.length}">${taskBadge(task)}</td>
          <td rowspan="${taskAssignments.length}">${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</td>`;
      }
      html += `<td><small>${slot?.label || task.name}</small></td>
        <td><strong class="participant-hover" data-pid="${p?.id || ''}">${p?.name || '???'}</strong></td>
        <td>${p ? levelBadge(p.level) : '—'}</td>
        <td>${p ? groupBadge(p.group) : '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td>
          ${isFrozen
            ? `<span class="frozen-action-icon" title="מוקפא — לא ניתן לשנות שיבוצי עבר">🧊</span>`
            : `<button class="btn-swap" data-assignment-id="${a.id}" data-task-id="${task.id}" title="החלפה">⇄</button>
               <button class="btn-lock" data-assignment-id="${a.id}" title="נעילה/שחרור">🔒</button>
               ${liveMode.enabled ? `<button class="btn-rescue" data-assignment-id="${a.id}" title="תוכניות חילוץ">🆘</button>` : ''}`
          }
        </td></tr>`;
    });
  }
  html += '</tbody></table></div>';
  return html;
}
*/

// ─── Gantt Chart ─────────────────────────────────────────────────────────────

function renderGanttChart(schedule: Schedule): string {
  // Build a filtered schedule for gantt rendering (only current day)
  const filteredTasks = getFilteredTasks(schedule);
  const filteredAssignments = getFilteredAssignments(schedule);
  const filteredSchedule: Schedule = {
    ...schedule,
    tasks: filteredTasks,
    assignments: filteredAssignments,
  };
  const ganttData = scheduleToGantt(filteredSchedule);
  const totalMs = ganttData.timelineEndMs - ganttData.timelineStartMs;
  if (totalMs <= 0) return '<p>אין נתוני ציר זמן ליום זה.</p>';

  const totalHours = totalMs / 3600000;
  // 2-hour labelled ticks for readability; 1-hour subtle gridlines
  const tickInterval = 2;

  let html = `<div class="gantt-container"><div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-timeline-col">`;

  // Subtle gridlines for every hour
  for (let h = 0; h <= totalHours; h += 1) {
    const pos = (h / totalHours) * 100;
    html += `<span class="gantt-gridline" style="left:${pos}%"></span>`;
  }

  // Labelled hour marks every 2 hours
  for (let h = 0; h <= totalHours; h += tickInterval) {
    const pos = (h / totalHours) * 100;
    const d = new Date(ganttData.timelineStartMs + h * 3600000);
    html += `<span class="gantt-hour-mark" style="left:${pos}%">${d.getHours().toString().padStart(2, '0')}:00</span>`;
  }
  html += `</div></div>`;

  for (const row of ganttData.rows) {
    // Skip rows with no blocks on this day
    if (row.blocks.length === 0) continue;

    html += `<div class="gantt-row"><div class="gantt-label-col">
      <span class="gantt-name participant-hover" data-pid="${row.participantId}">${row.participantName}</span>
      <span class="gantt-meta">${row.group} · L${row.level}</span>
    </div><div class="gantt-timeline-col">`;

    for (const block of row.blocks) {
      const left = ((block.startMs - ganttData.timelineStartMs) / totalMs) * 100;
      const width = (block.durationMs / totalMs) * 100;

      // Cross-day indicator on gantt blocks
      const task = filteredTasks.find(t => t.id === block.taskId);
      const crossFrom = task && taskStartsBefore(task, currentDay);
      const crossTo = task && taskEndsAfter(task, currentDay);
      const crossClass = crossFrom ? 'gantt-cross-from' : crossTo ? 'gantt-cross-to' : '';

      const tooltip = `${block.taskName}&#10;${new Date(block.startMs).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} – ${new Date(block.endMs).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}${crossFrom ? '&#10;▶ המשך מהיום הקודם' : ''}${crossTo ? '&#10;◀ ממשיך ליום הבא' : ''}`;
      const shortName = block.taskName.replace(/^D\d+\s+/, '').replace(/\s+משמרת\s+\d+$/, '');
      html += `<div class="gantt-block task-tooltip-hover ${block.isLight ? 'gantt-light' : ''} ${crossClass}" data-task-id="${block.taskId}" style="left:${left}%;width:${width}%;background:${block.color}" title="${tooltip}">
        <span class="gantt-block-text">${crossFrom ? '▶ ' : ''}${shortName}${crossTo ? ' ◀' : ''}</span></div>`;
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  return html;
}

// ─── Schedule Generation ─────────────────────────────────────────────────────

/** Number of optimization attempts per generation (user-configurable) */
let OPTIM_ATTEMPTS = 100;

/**
 * Render the optimization overlay that covers the schedule board
 * while multi-attempt optimization is running.
 */
function renderOptimOverlay(): string {
  if (!_isOptimizing || !_optimProgress) return '';

  const { attempt, totalAttempts, bestScore, bestUnfilled, lastImproved } = _optimProgress;
  const pct = Math.round((attempt / totalAttempts) * 100);

  return `<div class="optim-overlay">
    <div class="optim-card">
      <div class="cube-loader-wrapper optim-cube">
        <div class="cube-loader">
          <div class="cube-cell" style="--cell-color:#4A90D9"></div>
          <div class="cube-cell" style="--cell-color:#E74C3C"></div>
          <div class="cube-cell" style="--cell-color:#F39C12"></div>
          <div class="cube-cell" style="--cell-color:#27AE60"></div>
          <div class="cube-cell" style="--cell-color:#8E44AD"></div>
          <div class="cube-cell" style="--cell-color:#1ABC9C"></div>
          <div class="cube-cell" style="--cell-color:#3498db"></div>
          <div class="cube-cell" style="--cell-color:#e67e22"></div>
          <div class="cube-cell" style="--cell-color:#2ecc71"></div>
        </div>
      </div>
      <h3>מעריך ${totalAttempts} ניסיונות לשיוויוניות מרבית…</h3>
      <div class="optim-progress-bar">
        <div class="optim-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="optim-status">
        ניסיון <strong>${attempt}</strong> / ${totalAttempts}
        ${lastImproved ? '<span class="optim-improved">★ שיפור!</span>' : ''}
      </div>
      <div class="optim-metrics">
        <div class="optim-metric">
          <span class="optim-metric-label">ציון הטוב ביותר</span>
          <span class="optim-metric-value">${bestScore.toFixed(1)}</span>
        </div>
        <div class="optim-metric">
          <span class="optim-metric-label">משבצות ריקות</span>
          <span class="optim-metric-value ${bestUnfilled === 0 ? 'optim-ok' : 'optim-warn'}">${bestUnfilled}</span>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * Update ONLY the optimization overlay without touching the rest of the DOM.
 * This avoids a full renderAll cycle during optimization.
 */
function updateOverlay(): void {
  const overlay = document.querySelector('.optim-overlay') as HTMLElement | null;

  if (!_isOptimizing || !_optimProgress) {
    overlay?.remove();
    return;
  }

  const { attempt, totalAttempts, bestScore, bestUnfilled, lastImproved } = _optimProgress;
  const pct = Math.round((attempt / totalAttempts) * 100);

  if (overlay) {
    // Surgically update only the changing parts — keep the cube animation running
    const fill = overlay.querySelector('.optim-progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;
    const status = overlay.querySelector('.optim-status') as HTMLElement | null;
    if (status) status.innerHTML = `ניסיון <strong>${attempt}</strong> / ${totalAttempts} ${lastImproved ? '<span class="optim-improved">★ שיפור!</span>' : ''}`;
    const scoreVal = overlay.querySelector('.optim-metric-value') as HTMLElement | null;
    if (scoreVal) scoreVal.textContent = bestScore.toFixed(1);
    const unfilledVal = overlay.querySelectorAll('.optim-metric-value')[1] as HTMLElement | null;
    if (unfilledVal) {
      unfilledVal.textContent = String(bestUnfilled);
      unfilledVal.className = `optim-metric-value ${bestUnfilled === 0 ? 'optim-ok' : 'optim-warn'}`;
    }
  } else {
    // First render — insert full overlay with cube
    const html = renderOptimOverlay();
    const content = document.getElementById('tab-content');
    if (content) {
      content.insertAdjacentHTML('beforeend', html);
    }
  }
}

async function doGenerate(): Promise<void> {
  // Prevent double-click
  if (_isOptimizing) return;

  // Read user-configured scenario count
  const scenarioInput = document.getElementById('input-scenarios') as HTMLInputElement | null;
  if (scenarioInput) {
    const val = parseInt(scenarioInput.value, 10);
    if (val > 0) OPTIM_ATTEMPTS = val;
  }

  const participants = store.getAllParticipants();
  const tasks = generateTasksFromTemplates();

  const algoSettings = store.getAlgorithmSettings();
  engine = new SchedulingEngine(
    algoSettings.config,
    store.getDisabledHCSet(),
    store.getCategoryBreakHours() * 3600000,
  );
  engine.addParticipants(participants);
  engine.addTasks(tasks);

  // Continuity: if previous-schedule JSON is present, build phantom context
  if (_continuityJson.trim()) {
    const parsed = parseContinuitySnapshot(_continuityJson);
    if ('error' in parsed) {
      showToast(parsed.error, { type: 'error' });
      return;
    }
    const phantom = buildPhantomContext(parsed, participants);
    if (phantom.phantomAssignments.length > 0) {
      engine.setPhantomContext(phantom);
    }
  }

  // Switch to schedule tab and show overlay (keep old schedule visible behind it)
  currentTab = 'schedule';
  _isOptimizing = true;
  _optimProgress = {
    attempt: 0,
    totalAttempts: OPTIM_ATTEMPTS,
    bestScore: -Infinity,
    bestUnfilled: Infinity,
    lastImproved: false,
  };

  // Render the tab (with old schedule or empty state) + overlay
  renderAll();

  // Disable generate button during optimization
  const genBtn = document.getElementById('btn-generate') as HTMLButtonElement | null;
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.textContent = '⏳ מייעל…';
  }

  const t0 = performance.now();

  try {
    const schedule = await engine.generateScheduleAsync(
      OPTIM_ATTEMPTS,
      (info) => {
        // Update progress state (in-memory only, no DOM thrash on renderAll)
        _optimProgress = {
          attempt: info.attempt,
          totalAttempts: info.totalAttempts,
          bestScore: info.currentBestScore,
          bestUnfilled: info.currentBestUnfilled,
          lastImproved: info.improved,
        };
        // Surgically update just the overlay
        updateOverlay();
      },
    );

    // ── Atomic commit: update state in one go, then render once ──
    currentSchedule = schedule;
    scheduleElapsed = Math.round(performance.now() - t0);
    scheduleActualAttempts = schedule.actualAttempts ?? OPTIM_ATTEMPTS;
    currentDay = 1;
    _scheduleDirty = false;
    _snapshotDirty = true;
    store.setActiveSnapshotId(null);

    // Persist schedule to localStorage
    store.saveSchedule(schedule);

    // Apply live mode freeze if active
    const liveMode = store.getLiveModeState();
    if (liveMode.enabled) {
      freezeAssignments(currentSchedule, liveMode.currentTimestamp);
    }
  } catch (err) {
    // Safety buffer: if all attempts fail, show error without clearing board
    console.error('[Scheduler] All optimization attempts failed:', err);
    const errDiv = document.querySelector('.optim-overlay .optim-card');
    if (errDiv) {
      errDiv.innerHTML = `
        <div class="optim-error">
          <h3>⚠ האופטימיזציה נכשלה</h3>
          <p>לא נמצא פתרון תקין ב-${OPTIM_ATTEMPTS} ניסיונות.</p>
          <p>בדוק את האילוצים ואת זמינות המשתתפים.</p>
          <button class="btn-primary" id="btn-dismiss-error">סגור</button>
        </div>`;
      const dismissBtn = document.getElementById('btn-dismiss-error');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', () => {
          _isOptimizing = false;
          _optimProgress = null;
          renderAll();
        });
      }
      return; // Don't remove overlay yet
    }
  } finally {
    _isOptimizing = false;
    _optimProgress = null;
  }

  // Final atomic render with the winning schedule
  renderAll();
  showToast(`שבצ"ק נוצר בהצלחה (${(scheduleElapsed / 1000).toFixed(1)} שניות)`, { type: 'success' });
}

// ─── Create Empty Manual Schedule ──────────────────────────────────────────

function doCreateManualSchedule(): void {
  const participants = store.getAllParticipants();
  const tasks = generateTasksFromTemplates();

  if (tasks.length === 0) {
    showToast('אין משימות להציג — הגדר תחילה כללי משימות', { type: 'error' });
    return;
  }

  // Initialize engine (same as doGenerate) so revalidateAndRefresh() works
  const algoSettings = store.getAlgorithmSettings();
  engine = new SchedulingEngine(
    algoSettings.config,
    store.getDisabledHCSet(),
    store.getCategoryBreakHours() * 3600000,
  );
  engine.addParticipants(participants);
  engine.addTasks(tasks);

  // Build empty schedule — tasks populated, no assignments
  const emptySchedule: Schedule = {
    id: `manual-${Date.now()}`,
    tasks,
    participants,
    assignments: [],
    feasible: false,
    score: {
      minRestHours: 0,
      avgRestHours: 0,
      restStdDev: 0,
      totalPenalty: 0,
      compositeScore: 0,
      l0StdDev: 0,
      l0AvgEffective: 0,
      seniorStdDev: 0,
      seniorAvgEffective: 0,
      dailyPerParticipantStdDev: 0,
      dailyGlobalStdDev: 0,
    },
    violations: [],
    generatedAt: new Date(),
  };

  engine.importSchedule(emptySchedule);
  engine.revalidateFull();
  currentSchedule = engine.getSchedule()!;

  currentDay = 1;
  _scheduleDirty = false;
  _snapshotDirty = true;
  store.setActiveSnapshotId(null);

  // Activate manual build mode immediately
  _manualBuildActive = true;
  clearManualSelection();
  _manualUndoStack = [];
  _warehouseFilter = '';

  scheduleElapsed = 0;
  scheduleActualAttempts = 0;

  store.saveSchedule(currentSchedule);
  renderAll();

  // Auto-scroll to the grid so slots are immediately visible
  requestAnimationFrame(() => {
    const grid = document.querySelector('.schedule-grid-container');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  showToast('שבצ"ק ריק נוצר — בחר משבצת ואז משתתף', { type: 'success' });
}

// ─── Interactive Handlers ────────────────────────────────────────────────────

/**
 * After every manual change we re-validate the ENTIRE 7-day schedule
 * and refresh all stats so cross-day conflicts surface immediately.
 */
function revalidateAndRefresh(): void {
  if (!engine || !currentSchedule) return;

  // C1+R6: Full 7-day re-validation — recomputes hard constraints,
  // soft warnings, AND schedule score so nothing is stale.
  engine.revalidateFull();
  currentSchedule = engine.getSchedule();

  // Mark snapshot as dirty (schedule was modified since last save/load)
  _snapshotDirty = true;

  // Re-apply freeze if live mode is active
  const liveMode = store.getLiveModeState();
  if (liveMode.enabled && currentSchedule) {
    freezeAssignments(currentSchedule, liveMode.currentTimestamp);
  }

  // Persist updated schedule
  if (currentSchedule) {
    store.saveSchedule(currentSchedule);
  }

  renderAll();
}

async function handleSwap(assignmentId: string): Promise<void> {
  if (!currentSchedule || !engine) return;
  const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!assignment) return;
  if (assignment.status === AssignmentStatus.Frozen) {
    await showAlert('השיבוץ הזה מוקפא כי הוא בעבר. אי אפשר לשנות אותו.', { icon: '🧊' });
    return;
  }
  const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
  if (!task) return;
  const currentP = currentSchedule.participants.find(p => p.id === assignment.participantId);

  const suggestions = currentSchedule.participants
    .filter(p => p.id !== assignment.participantId)
    .map(p => `${p.name} (L${p.level}, ${p.group})`);

  const choice = await showPrompt(
    `החלפה ב-"${task.name}".\nנוכחי: ${currentP?.name}`,
    { title: 'החלפת משתתף', suggestions }
  );
  if (!choice) return;

  const newP = currentSchedule.participants.find(
    p => choice.includes(p.name) || choice === p.id
  );
  if (!newP) { await showAlert('לא נמצא משתתף בשם הזה.', { icon: '⚠️' }); return; }

  const result = engine.swapParticipant({ assignmentId, newParticipantId: newP.id });
  currentSchedule = engine.getSchedule();

  if (!result.valid) {
    const msgs = result.violations.map(v => `[${v.code}] ${v.message}`).join('\n');
    await showAlert(`ההחלפה יוצרת הפרות בשבצ"ק:\n\n${msgs}`, { title: 'הפרות', icon: '⚠️' });
  } else {
    showToast('החלפה בוצעה בהצלחה', { type: 'success' });
    // Full re-validation + refresh only on successful swap
    revalidateAndRefresh();
  }
}

async function handleLock(assignmentId: string): Promise<void> {
  if (!currentSchedule || !engine) return;
  const a = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!a) return;

  if (a.status === AssignmentStatus.Frozen) {
    await showAlert('השיבוץ הזה מוקפא כי הוא בעבר. אי אפשר לשנות אותו.', { icon: '🧊' });
    return;
  }

  if (a.status === AssignmentStatus.Locked) {
    engine.unlockAssignment(assignmentId);
  } else {
    engine.lockAssignment(assignmentId);
  }
  currentSchedule = engine.getSchedule();
  revalidateAndRefresh();
}

// ─── Rescue Modal ────────────────────────────────────────────────────────────

async function handleProfileSos(assignmentId: string): Promise<void> {
  if (!currentSchedule) return;
  const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!assignment) return;
  const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
  if (!task) return;

  const lm = store.getLiveModeState();
  if (lm.enabled) {
    openRescueModal(assignmentId);
    return;
  }

  // Live mode is OFF — prompt for day + time
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    days.push({ value: String(d), label: `יום ${hebrewDayName(date)}` });
  }
  const hours: Array<{ value: string; label: string }> = [];
  for (let h = 0; h < 24; h++) {
    hours.push({ value: String(h), label: `${String(h).padStart(2, '0')}:00` });
  }

  const result = await showTimePicker(
    'כדי להפעיל חילוץ, יש להגדיר את הזמן הנוכחי במצב חי.',
    { title: 'הפעלת מצב חי', days, hours, defaultDay: '1', defaultHour: '5' },
  );
  if (!result) return;

  const dayIdx = parseInt(result.day, 10);
  const hour = parseInt(result.hour, 10);
  const ts = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx - 1, hour, 0);

  if (!isFutureTask(task, ts)) {
    await showAlert('הזמן שנבחר הופך את המשימה למוקפאת (בעבר). לא ניתן להפעיל חילוץ על משימה שכבר חלפה.', { title: 'לא ניתן להמשיך', icon: '⚠️' });
    return;
  }

  store.setLiveModeEnabled(true);
  store.setLiveModeTimestamp(ts);
  freezeAssignments(currentSchedule, ts);

  openRescueModal(assignmentId);
}

function openRescueModal(assignmentId: string): void {
  if (!currentSchedule) return;
  const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!assignment) return;
  const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
  if (!task) return;

  const liveMode = store.getLiveModeState();

  const request: RescueRequest = {
    vacatedAssignmentId: assignmentId,
    taskId: task.id,
    slotId: assignment.slotId,
    vacatedBy: assignment.participantId,
  };

  _rescuePage = 0;
  _rescueAssignmentId = assignmentId;
  _rescueResult = generateRescuePlans(currentSchedule, request, liveMode.currentTimestamp, _rescuePage, undefined, store.getDisabledHCSet(), store.getCategoryBreakHours() * 3600000);
  showRescueModal();
}

function showRescueModal(): void {
  // Remove any existing modal
  document.getElementById('rescue-modal-backdrop')?.remove();

  if (!_rescueResult || !currentSchedule) return;

  const pMap = new Map<string, Participant>();
  for (const p of currentSchedule.participants) pMap.set(p.id, p);
  const taskMap = new Map<string, Task>();
  for (const t of currentSchedule.tasks) taskMap.set(t.id, t);

  const { request, plans, hasMore } = _rescueResult;
  const vacatedP = pMap.get(request.vacatedBy);
  const task = taskMap.get(request.taskId) || null;

  let html = `<div id="rescue-modal-backdrop" class="rescue-backdrop">
    <div class="rescue-modal">
      <div class="rescue-header">
        <h3>🆘 תוכניות החלפה</h3>
        <button class="rescue-close" id="btn-rescue-close">✕</button>
      </div>
      <div class="rescue-context">
        <p>משבצת שהתפנתה על ידי <strong>${vacatedP?.name || '???'}</strong> ב-
        <strong>${stripDayPrefix(task?.name || '???')}</strong></p>
      </div>
      <div class="rescue-plans">`;

  if (plans.length === 0) {
    html += `<div class="rescue-empty">לא נמצאו תוכניות החלפה מתאימות.</div>`;
  }

  for (const plan of plans) {
    const isRecommended = plan.rank === 1;
    const hasViolations = plan.violations && plan.violations.length > 0;

    // Quality tier from impact score
    const qualityTier = plan.impactScore < 3 ? 'excellent' : plan.impactScore < 7 ? 'fair' : 'significant';
    const qualityLabel = qualityTier === 'excellent' ? 'מצוין' : qualityTier === 'fair' ? 'סביר' : 'משמעותי';

    // Swap count label — friendly wording
    const swapLabel = plan.swaps.length === 1 ? 'החלפה ישירה' : `שרשרת של ${plan.swaps.length}`;

    html += `<div class="rescue-plan${isRecommended ? ' rescue-plan--recommended' : ''}" data-plan-id="${plan.id}">
      <div class="rescue-plan-header">
        <span class="rescue-rank">#${plan.rank}${isRecommended ? ' <span class="rescue-recommended-tag">מומלץ ✓</span>' : ''}</span>
        <span class="rescue-quality rescue-quality--${qualityTier}">● ${qualityLabel}</span>
        <span class="rescue-swaps">${swapLabel}</span>
        ${hasViolations ? `<span class="rescue-violations-badge" title="${plan.violations!.length} הפרות אילוצים">⚠️</span>` : ''}
      </div>`;

    // Build swap steps as plain-language list
    let stepsHtml = `<ol class="rescue-steps">`;
    for (let i = 0; i < plan.swaps.length; i++) {
      const sw = plan.swaps[i];
      const swP = pMap.get(sw.toParticipantId);
      const fromP = pMap.get(sw.fromParticipantId || '');
      const assignedSpan = `<span class="rescue-participant-hover" data-pid="${sw.toParticipantId}" data-plan-id="${plan.id}"><strong>${swP?.name || '???'}</strong></span>`;
      const fromSpan = fromP
        ? `<span class="rescue-participant-hover" data-pid="${sw.fromParticipantId}" data-plan-id="${plan.id}">${fromP.name}</span>`
        : '';

      if (plan.swaps.length === 1) {
        // Direct swap: natural sentence
        stepsHtml += `<li>${assignedSpan} יחליף${fromSpan ? ` את ${fromSpan}` : ''} ב-<strong>${stripDayPrefix(sw.taskName)}</strong> (${sw.slotLabel})</li>`;
      } else {
        // Chain swap: arrow style
        stepsHtml += `<li>${assignedSpan} → <strong>${stripDayPrefix(sw.taskName)}</strong> (${sw.slotLabel})${fromSpan ? ` במקום ${fromSpan}` : ''}</li>`;
      }
    }
    stepsHtml += `</ol>`;

    // Violations section
    let violationsHtml = '';
    if (hasViolations) {
      violationsHtml = `<div class="rescue-violations-warning">
        <span class="rescue-violations-icon">⚠️</span>
        <span>${plan.violations!.length} הפרות אילוצים</span>
        <details class="rescue-violations-details">
          <summary>הצג פרטים</summary>
          <ul>`;
      for (const v of plan.violations!) {
        violationsHtml += `<li><code>${violationLabel(v.code)}</code> — ${v.message}</li>`;
      }
      violationsHtml += `</ul></details></div>`;
    }

    // Plan #1: expanded by default. Others: collapsed.
    if (isRecommended) {
      html += `<div class="rescue-plan-details">
        ${stepsHtml}
        ${violationsHtml}
      </div>`;
    } else {
      html += `<details class="rescue-plan-details rescue-plan-collapsible">
        <summary class="rescue-plan-expand">הצג פרטים</summary>
        ${stepsHtml}
        ${violationsHtml}
      </details>`;
    }

    html += `<button class="btn-apply-plan${hasViolations ? ' btn-apply-plan--warn' : ''}" data-plan-id="${plan.id}">${hasViolations ? '⚠️ החל תוכנית (יש הפרות)' : '✅ החל תוכנית'}</button>
    </div>`;
  }

  html += `</div>
    <div class="rescue-footer">
      ${hasMore ? `<button class="btn-rescue-more" id="btn-rescue-more">הצג אפשרויות נוספות</button>` : ''}
      <button class="btn-rescue-dismiss" id="btn-rescue-dismiss">סגור</button>
    </div>
    </div></div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  wireRescueModalEvents();
}

/** Strip D-prefix (e.g. "D1 ממטרה" → "ממטרה") from task names in the rescue modal. */
function stripDayPrefix(name: string): string {
  return name.replace(/^D\d+\s+/, '');
}

// ─── Rescue Tooltip: Next-3-Tasks Preview ────────────────────────────────────

let _rescueTooltipEl: HTMLElement | null = null;
let _rescueTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

function getRescueTooltipEl(): HTMLElement {
  if (_rescueTooltipEl) return _rescueTooltipEl;
  const el = document.createElement('div');
  el.className = 'rescue-hover-tt';
  el.style.display = 'none';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (_rescueTooltipHideTimer) { clearTimeout(_rescueTooltipHideTimer); _rescueTooltipHideTimer = null; }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });
  _rescueTooltipEl = el;
  return el;
}

/**
 * Compute the next 3 tasks a participant would have after applying a plan's swaps.
 * Uses the vacated task's start as the "now" anchor so it works for future schedules.
 */
function computePostSwapTasks(
  participantId: string,
  plan: RescuePlan,
  schedule: Schedule,
  referenceTaskId: string,
): Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  // Start with the participant's current task IDs (assignment → taskId)
  // Build a set of assignment IDs this participant currently holds
  const myAssignmentTaskIds = new Map<string, string>(); // assignmentId → taskId
  for (const a of schedule.assignments) {
    if (a.participantId === participantId) {
      myAssignmentTaskIds.set(a.id, a.taskId);
    }
  }

  // Apply the plan's swaps
  for (const sw of plan.swaps) {
    // If participant is being moved OUT of an assignment
    if (sw.fromParticipantId === participantId) {
      myAssignmentTaskIds.delete(sw.assignmentId);
    }
    // If participant is being moved IN to an assignment
    if (sw.toParticipantId === participantId) {
      myAssignmentTaskIds.set(sw.assignmentId, sw.taskId);
    }
  }

  // Resolve to task objects with time info, tracking which is the reference task
  const tasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> = [];
  for (const [, taskId] of myAssignmentTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    tasks.push({
      taskName: task.name,
      start: task.timeBlock.start,
      end: task.timeBlock.end,
      isReference: taskId === referenceTaskId,
    });
  }

  // Sort by start time ascending
  tasks.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Find the reference task index; fall back to earliest swap task
  let refIdx = tasks.findIndex(t => t.isReference);
  if (refIdx === -1) {
    // Fallback: find the earliest swap task's start time
    let anchorTime = Infinity;
    for (const sw of plan.swaps) {
      const task = taskMap.get(sw.taskId);
      if (task) {
        const t = task.timeBlock.start.getTime();
        if (t < anchorTime) anchorTime = t;
      }
    }
    if (anchorTime !== Infinity) {
      refIdx = tasks.findIndex(t => t.start.getTime() >= anchorTime);
    }
    if (refIdx === -1) refIdx = 0;
  }

  // Return 2 before + reference + 2 after
  const startIdx = Math.max(0, refIdx - 2);
  const endIdx = Math.min(tasks.length, refIdx + 3);
  return tasks.slice(startIdx, endIdx);
}

/** Build HTML content for the rescue participant hover tooltip. */
function buildRescueParticipantTooltip(
  participantName: string,
  nextTasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }>,
): string {
  let html = `<div class="rescue-hover-tt-header">${participantName} — משימות סביב המשבצת אם יוחל</div>`;
  if (nextTasks.length === 0) {
    html += `<div class="rescue-hover-tt-empty">אין משימות קרובות</div>`;
  } else {
    for (let i = 0; i < nextTasks.length; i++) {
      const t = nextTasks[i];
      const dayStr = 'יום ' + hebrewDayName(t.start);
      const timeStr = fmt(t.start) + ' – ' + fmt(t.end);
      const refClass = t.isReference ? ' rescue-hover-tt-task--ref' : '';
      const refMarker = t.isReference ? ' ◄' : '';
      html += `<div class="rescue-hover-tt-task${refClass}">${i + 1}. ${stripDayPrefix(t.taskName)}${refMarker}<span class="rescue-hover-tt-time">${dayStr} ${timeStr}</span></div>`;
    }
  }
  return html;
}

function wireRescueModalEvents(): void {
  const backdrop = document.getElementById('rescue-modal-backdrop');
  if (!backdrop) return;

  // Close button
  backdrop.querySelector('#btn-rescue-close')?.addEventListener('click', closeRescueModal);
  backdrop.querySelector('#btn-rescue-dismiss')?.addEventListener('click', closeRescueModal);

  // Click backdrop to close
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeRescueModal();
  });

  // Escape key to close
  if (_rescueEscHandler) document.removeEventListener('keydown', _rescueEscHandler);
  _rescueEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeRescueModal();
  };
  document.addEventListener('keydown', _rescueEscHandler);

  // Show More — request all plans up to the next page boundary in one shot
  // to avoid duplicates from re-generation (engine is stateless).
  backdrop.querySelector('#btn-rescue-more')?.addEventListener('click', () => {
    if (!currentSchedule || !_rescueResult) return;
    _rescuePage++;
    const liveMode = store.getLiveModeState();
    const wantTotal = (_rescuePage + 1) * 3; // PAGE_SIZE = 3
    const result = generateRescuePlans(currentSchedule, _rescueResult.request, liveMode.currentTimestamp, 0, wantTotal, store.getDisabledHCSet(), store.getCategoryBreakHours() * 3600000);
    // Ranks are already sequential from the engine (1-based per returned plan)
    _rescueResult = result;
    showRescueModal();
  });

  // Apply plan buttons
  backdrop.querySelectorAll('.btn-apply-plan').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const planId = (e.target as HTMLElement).dataset.planId;
      if (!planId || !_rescueResult || !currentSchedule || !engine) return;
      const plan = _rescueResult.plans.find(p => p.id === planId);
      if (!plan) return;
      applyRescuePlan(plan);
    });
  });

  // Rescue participant hover tooltip — show next 3 tasks if plan applied
  const pMap = new Map<string, Participant>();
  if (currentSchedule) {
    for (const p of currentSchedule.participants) pMap.set(p.id, p);
  }

  if (isTouchDevice) {
    // ── Touch: tap toggles inline task preview ──
    let _expandedRescuePid: string | null = null;

    backdrop.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      const planId = target.dataset.planId;
      if (!pid || !planId || !_rescueResult || !currentSchedule) return;

      // Remove any existing inline preview
      const existing = backdrop.querySelector('.rescue-inline-preview');
      if (existing) existing.remove();

      if (_expandedRescuePid === pid) { _expandedRescuePid = null; return; }

      const plan = _rescueResult.plans.find(p => p.id === planId);
      if (!plan) return;
      const participant = pMap.get(pid);
      if (!participant) return;

      _expandedRescuePid = pid;
      const nextTasks = computePostSwapTasks(pid, plan, currentSchedule, _rescueResult.request.taskId);
      const detail = document.createElement('div');
      detail.className = 'rescue-inline-preview task-inline-detail';
      detail.innerHTML = buildRescueParticipantTooltip(participant.name, nextTasks);
      target.insertAdjacentElement('afterend', detail);
    });
  } else {
    // ── Desktop: hover shows fixed tooltip ──
    backdrop.addEventListener('mouseover', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      const planId = target.dataset.planId;
      if (!pid || !planId || !_rescueResult || !currentSchedule) return;

      const plan = _rescueResult.plans.find(p => p.id === planId);
      if (!plan) return;
      const participant = pMap.get(pid);
      if (!participant) return;

      if (_rescueTooltipHideTimer) { clearTimeout(_rescueTooltipHideTimer); _rescueTooltipHideTimer = null; }

      const nextTasks = computePostSwapTasks(pid, plan, currentSchedule, _rescueResult.request.taskId);
      const tooltip = getRescueTooltipEl();
      tooltip.innerHTML = buildRescueParticipantTooltip(participant.name, nextTasks);
      tooltip.style.display = 'block';

      // Position near the target element
      const rect = target.getBoundingClientRect();
      let left = rect.right + 8;
      let top = rect.top - 4;

      const ttWidth = 260;
      const ttHeight = tooltip.offsetHeight || 140;
      if (left + ttWidth > window.innerWidth) {
        left = rect.left - ttWidth - 8;
      }
      if (top + ttHeight > window.innerHeight) {
        top = window.innerHeight - ttHeight - 8;
      }
      if (top < 4) top = 4;

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    });

    backdrop.addEventListener('mouseout', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      _rescueTooltipHideTimer = setTimeout(() => {
        const tooltip = getRescueTooltipEl();
        tooltip.style.display = 'none';
      }, 120);
    });
  }
}

function showRescueError(message: string): void {
  const errorBanner = document.createElement('div');
  errorBanner.className = 'rescue-error-banner';
  errorBanner.innerHTML = `<span>${message}</span>
    <button class="rescue-error-dismiss">✕</button>`;
  errorBanner.querySelector('.rescue-error-dismiss')?.addEventListener('click', () => errorBanner.remove());
  const modal = document.querySelector('.rescue-modal');
  if (modal) {
    modal.insertBefore(errorBanner, modal.firstChild);
  }
}

function applyRescuePlan(plan: RescuePlan): void {
  if (!currentSchedule || !engine) return;

  // Staleness check: verify all assignments still match the expected state
  for (const sw of plan.swaps) {
    const a = currentSchedule.assignments.find(a => a.id === sw.assignmentId);
    if (!a) {
      showRescueError('תוכנית ההחלפה מיושנת — השיבוץ לא נמצא. נסו שוב.');
      return;
    }
    if (a.participantId !== sw.fromParticipantId) {
      showRescueError('תוכנית ההחלפה מיושנת — המשתתף השתנה. נסו שוב.');
      return;
    }
    if (a.status === AssignmentStatus.Frozen) {
      showRescueError('תוכנית ההחלפה מיושנת — השיבוץ קפוא. נסו שוב.');
      return;
    }
  }

  // Apply all swaps atomically via the chain method
  const requests = plan.swaps.map(sw => ({
    assignmentId: sw.assignmentId,
    newParticipantId: sw.toParticipantId,
  }));
  const result = engine.swapParticipantChain(requests);
  const updated = engine.getSchedule();

  if (!updated || !result.valid) {
    console.warn('[Rescue] Chain swap failed:', result.violations);
    showRescueError('תוכנית ההחלפה לא יושמה בהצלחה — בוצע שחזור למצב הקודם.');
    revalidateAndRefresh();
    return;
  }

  currentSchedule = updated;
  closeRescueModal();
  revalidateAndRefresh();
}

function closeRescueModal(): void {
  document.getElementById('rescue-modal-backdrop')?.remove();
  _rescueResult = null;
  _rescueAssignmentId = null;
  _rescuePage = 0;
  // Remove Escape key handler
  if (_rescueEscHandler) { document.removeEventListener('keydown', _rescueEscHandler); _rescueEscHandler = null; }
  // Hide rescue tooltip if visible
  if (_rescueTooltipHideTimer) { clearTimeout(_rescueTooltipHideTimer); _rescueTooltipHideTimer = null; }
  if (_rescueTooltipEl) _rescueTooltipEl.style.display = 'none';
}

// ─── Main Render ─────────────────────────────────────────────────────────────

function formatLiveClock(): string {
  const now = new Date();
  const date = now.toLocaleDateString('he-IL', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}

/**
 * Scroll the schedule grid to the row closest to the current live-mode timestamp.
 * Highlights the target row briefly with an animation.
 */
function scrollToNow(storeRef: typeof store, scroll = true): void {
  const liveState = storeRef.getLiveModeState();
  if (!liveState.enabled) return;

  const target = liveState.currentTimestamp.getTime();
  const container = document.querySelector('.schedule-grid-container');
  if (!container) return;

  const rows = container.querySelectorAll<HTMLTableRowElement>('tr[data-time]');
  if (rows.length === 0) return;

  // Remove previous now-row highlights
  container.querySelectorAll('.now-row, .now-row-animate').forEach(el => {
    el.classList.remove('now-row', 'now-row-animate');
  });

  // Find the row with the largest data-time <= target (current or most recent shift)
  let bestRow: HTMLTableRowElement | null = null;
  let bestTime = -Infinity;

  rows.forEach(row => {
    const t = Number(row.dataset.time);
    if (t <= target && t > bestTime) {
      bestTime = t;
      bestRow = row;
    }
  });

  // If no row <= target, pick the first row (earliest time)
  if (!bestRow) bestRow = rows[0];

  // Highlight all rows with the same time across all tables
  container.querySelectorAll<HTMLTableRowElement>(`tr[data-time="${bestRow.dataset.time}"]`).forEach(r => {
    r.classList.add('now-row', 'now-row-animate');
  });

  // Scroll the first matching row into view (only on initial live-mode activation)
  if (scroll) {
    bestRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderAll(): void {
  const app = document.getElementById('app')!;

  // Always hide tooltips on re-render to avoid stale state
  hideTooltip();
  hideTaskTooltip();
  hideAvailabilityPopover();

  // ── Profile View: completely different layout, no re-optimization ──
  if (_viewMode === 'PROFILE_VIEW' && _profileParticipantId && currentSchedule) {

    const p = currentSchedule.participants.find(pp => pp.id === _profileParticipantId);
    if (!p) { _viewMode = 'SCHEDULE_VIEW'; _profileParticipantId = null; /* fall through */ }
    else {
      const lmProfile = store.getLiveModeState();
      const frozenIds = new Set<string>();
      if (lmProfile.enabled) {
        const tMap = new Map(currentSchedule.tasks.map(t => [t.id, t]));
        for (const a of currentSchedule.assignments) {
          const t = tMap.get(a.taskId);
          if (t && !isFutureTask(t, lmProfile.currentTimestamp)) frozenIds.add(a.id);
        }
      }

      const ctx: ProfileContext = {
        participant: p,
        schedule: currentSchedule,
        frozenAssignmentIds: frozenIds,
        showSosButtons: true,
      };

      app.innerHTML = `<div class="profile-view-root">${renderProfileView(ctx)}</div>`;
      const root = app.querySelector('.profile-view-root') as HTMLElement;
      wireProfileEvents(root, () => {
        // Back to schedule: restore scroll position
        _viewMode = 'SCHEDULE_VIEW';
        _profileParticipantId = null;
        renderAll();
        requestAnimationFrame(() => window.scrollTo(0, _scheduleScrollY));
      }, handleProfileSos);
      // Wire task tooltip in profile view too
      wireTaskTooltip(root);
      return;
    }
  }

  const participants = store.getAllParticipants();
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  let html = `
  <header>
    <div class="header-top">
      <h1>⏱ מערכת שיבוץ חכמה</h1><span class="beta-badge">v1.6.5</span>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${!store.getUndoRedoState().canUndo ? 'disabled' : ''}
          title="ביטול">↪<span class="btn-label"> ביטול${store.getUndoRedoState().undoDepth ? ' (' + store.getUndoRedoState().undoDepth + ')' : ''}</span></button>
        <button class="btn-sm btn-outline" id="btn-redo" ${!store.getUndoRedoState().canRedo ? 'disabled' : ''}
          title="שחזור">↩<span class="btn-label"> שחזור${store.getUndoRedoState().redoDepth ? ' (' + store.getUndoRedoState().redoDepth + ')' : ''}</span></button>
      </div>
      <button class="theme-toggle" id="btn-theme-toggle" title="החלף מצב בהיר/כהה">
        ${document.documentElement.dataset.theme === 'light' ? SVG_ICONS.moon : SVG_ICONS.sun}
      </button>
    </div>
    <p class="subtitle">
      <span id="live-clock">${formatLiveClock()}</span>
      · שבצ"ק ל-${store.getScheduleDays()} ימים
      · ${participants.length} משתתפים
      · ${templates.length} משימות
    </p>
    <div class="header-credit">
      <span class="credit-left">פותח על ידי אייל צמיר</span>
      <span class="credit-right">כי עוד אאמין גם באדם גם ברוחו רוח עז</span>
    </div>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn ${currentTab === 'participants' ? 'tab-active' : ''}" data-tab="participants" aria-label="משתתפים">
      <span class="tab-icon">${SVG_ICONS.participants}</span>
      <span class="tab-label">משתתפים <span class="count">${participants.length}</span></span>
    </button>
    <button class="tab-btn ${currentTab === 'task-rules' ? 'tab-active' : ''}" data-tab="task-rules" aria-label="משימות">
      <span class="tab-icon">${SVG_ICONS.tasks}</span>
      <span class="tab-label">משימות <span class="count">${templates.length}</span>
      ${!preflight.canGenerate ? '<span class="badge badge-sm" style="background:var(--danger);margin-inline-start:4px">!</span>' : ''}</span>
    </button>
    <button class="tab-btn ${currentTab === 'schedule' ? 'tab-active' : ''}" data-tab="schedule" aria-label="שבצ&quot;ק">
      <span class="tab-icon">${SVG_ICONS.chart}</span>
      <span class="tab-label">שבצ"ק
      ${currentSchedule ? '<span class="badge badge-sm" style="background:var(--success);margin-inline-start:4px">✓</span>' : ''}</span>
    </button>
    <button class="tab-btn ${currentTab === 'algorithm' ? 'tab-active' : ''}" data-tab="algorithm" aria-label="אלגוריתם">
      <span class="tab-icon">${SVG_ICONS.settings}</span>
      <span class="tab-label">אלגוריתם</span>
    </button>
  </nav>

  <div class="tab-content" id="tab-content">`;

  switch (currentTab) {
    case 'participants':
      html += renderParticipantsTab();
      break;
    case 'task-rules':
      html += renderTaskRulesTab();
      break;
    case 'schedule':
      html += renderScheduleTab();
      break;
    case 'algorithm':
      html += renderAlgorithmTab();
      break;
  }

  html += '</div>';

  // Preserve scroll position during manual-build re-renders
  const savedScrollY = _manualBuildActive && currentTab === 'schedule' ? window.scrollY : 0;

  app.innerHTML = html;

  // Restore scroll position for manual build mode
  if (savedScrollY > 0) {
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  // Wire events
  wireTabNav(app);
  wireUndoRedo(app);
  wireThemeToggle(app);
  wireFactoryReset(app);

  const content = document.getElementById('tab-content')!;
  if (currentTab === 'participants') {
    wireParticipantsEvents(content, renderAll);
  } else if (currentTab === 'task-rules') {
    wireTaskRulesEvents(content, renderAll);
  } else if (currentTab === 'schedule') {
    wireScheduleEvents(content);
  } else if (currentTab === 'algorithm') {
    wireAlgorithmEvents(content, renderAll);
  }

  // Run KPI count-up animations when on schedule tab
  if (currentTab === 'schedule' && currentSchedule) {
    requestAnimationFrame(runKpiAnimations);
  }

}

function wireTabNav(container: HTMLElement): void {
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as typeof currentTab;
      if (tab && tab !== currentTab) {
        // Issue 6: clear participant selection when leaving Participants tab
        if (currentTab === 'participants') {
          clearParticipantSelection();
        }
        currentTab = tab;
        renderAll();
      }
    });
  });
}

function doUndoRedo(action: 'undo' | 'redo'): void {
  const ok = action === 'undo' ? store.undo() : store.redo();
  if (ok) {
    // Manual Mode: keep existing schedule but strip orphaned assignments
    // and mark dirty.  The store subscriber handles both automatically.
    renderAll();
  }
}

function wireUndoRedo(container: HTMLElement): void {
  const undoBtn = container.querySelector('#btn-undo');
  const redoBtn = container.querySelector('#btn-redo');
  if (undoBtn) undoBtn.addEventListener('click', () => doUndoRedo('undo'));
  if (redoBtn) redoBtn.addEventListener('click', () => doUndoRedo('redo'));
}

// ─── KPI Count-Up Animation ─────────────────────────────────────────────────

const _prevKpiValues: Record<string, number> = {};

function animateCountUp(el: HTMLElement, target: number, decimals: number, duration = 600): void {
  const start = performance.now();
  const from = 0;
  const step = (now: number) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = from + (target - from) * eased;
    el.textContent = decimals > 0 ? current.toFixed(decimals) : Math.round(current).toString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function runKpiAnimations(): void {
  const ids: Array<{ id: string; decimals: number }> = [
    { id: 'kpi-score', decimals: 1 },
    { id: 'kpi-violations', decimals: 0 },
    { id: 'kpi-warnings', decimals: 0 },
  ];
  for (const { id, decimals } of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const target = parseFloat(el.dataset.target || '0');
    const prev = _prevKpiValues[id];
    // Animate on first render or when value changes
    if (prev === undefined || prev !== target) {
      animateCountUp(el, target, decimals);
      // Flash green briefly if value improved (score up, violations/warnings down)
      if (prev !== undefined) {
        const improved = id === 'kpi-score' ? target > prev : target < prev;
        if (improved) {
          const kpiDiv = el.closest('.kpi');
          if (kpiDiv) {
            (kpiDiv as HTMLElement).classList.add('kpi-improved');
            setTimeout(() => (kpiDiv as HTMLElement).classList.remove('kpi-improved'), 800);
          }
        }
      }
    }
    _prevKpiValues[id] = target;
  }
  // Feasible KPI: just fade in
  const feasEl = document.getElementById('kpi-feasible');
  if (feasEl) {
    feasEl.style.animation = 'none';
    feasEl.offsetHeight; // trigger reflow
    feasEl.style.animation = 'kpiFadeIn 0.3s ease';
  }
}

// ─── Theme Toggle ────────────────────────────────────────────────────────────

const THEME_STORAGE_KEY = 'gardenmanager_theme';

function applyTheme(theme: 'dark' | 'light'): void {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function getStoredTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  // Fallback to system preference
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function toggleTheme(): void {
  const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = current === 'dark' ? 'light' : 'dark';

  const commitSwitch = () => {
    applyTheme(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) btn.innerHTML = next === 'light' ? SVG_ICONS.moon : SVG_ICONS.sun;
  };

  // Use the View Transitions API when available for a seamless crossfade;
  // otherwise fall back to the CSS transition path which is still smooth.
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(commitSwitch);
  } else {
    commitSwitch();
  }
}

function wireThemeToggle(container: HTMLElement): void {
  const btn = container.querySelector('#btn-theme-toggle');
  if (btn) btn.addEventListener('click', toggleTheme);
}

function wireFactoryReset(container: HTMLElement): void {
  const btn = container.querySelector('#btn-factory-reset');
  if (btn) {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm(
        'פעולה זו תמחק את כל הנתונים במערכת:\n' +
        '• כל המשתתפים והגדרותיהם\n' +
        '• כל המשימות והשיבוצים\n' +
        '• כל הגדרות האלגוריתם והפריסטים\n' +
        '• כל תמונות המצב השמורות\n' +
        '• כל סטי המשתתפים וסטי המשימות\n\n' +
        'המערכת תחזור למצב ההתחלתי כאילו הותקנה מחדש.\n' +
        'לא ניתן לבטל פעולה זו!',
        {
          danger: true,
          title: '⚠ איפוס מערכת מלא',
          confirmLabel: 'כן, אפס הכל',
          cancelLabel: 'ביטול',
        }
      );
      if (ok) {
        store.factoryReset();
        location.reload();
      }
    });
  }
}

// ─── Snapshot Event Wiring ───────────────────────────────────────────────────

function wireSnapshotEvents(container: HTMLElement): void {
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.id !== 'snap-name') return;
    if (!_snapshotFormError) return;
    _snapshotFormError = '';
    target.removeAttribute('aria-invalid');
    const errorEl = container.querySelector('#snap-error') as HTMLElement | null;
    if (errorEl) errorEl.textContent = '';
  });

  // Toggle panel open/close
  const toggleBtn = container.querySelector('#btn-snap-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      _snapshotPanelOpen = !_snapshotPanelOpen;
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // ── Continuity chip + import modal events ──
  const continuityChip = container.querySelector('#continuity-chip');
  if (continuityChip) {
    continuityChip.addEventListener('click', (e) => {
      // Don't open modal if the clear button was clicked
      if ((e.target as HTMLElement).closest('.continuity-chip-clear')) return;
      openContinuityImportModal();
    });
  }
  const continuityClear = container.querySelector('#btn-continuity-clear');
  if (continuityClear) {
    continuityClear.addEventListener('click', (e) => {
      e.stopPropagation();
      _continuityJson = '';
      renderAll();
    });
  }
  const continuityImportBtn = container.querySelector('#btn-continuity-import');
  if (continuityImportBtn) {
    continuityImportBtn.addEventListener('click', () => {
      openContinuityImportModal();
    });
  }

  // Close button inside panel
  const closeBtn = container.querySelector('#btn-snap-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      _snapshotPanelOpen = false;
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Save As → show form
  const saveAsBtn = container.querySelector('#btn-snap-save-as');
  if (saveAsBtn) {
    saveAsBtn.addEventListener('click', () => {
      _snapshotFormMode = 'save-as';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Confirm Save As
  const confirmSaveBtn = container.querySelector('#btn-snap-confirm-save');
  if (confirmSaveBtn) {
    confirmSaveBtn.addEventListener('click', () => {
      if (!currentSchedule) return;
      const nameInput = document.getElementById('snap-name') as HTMLInputElement | null;
      const descInput = document.getElementById('snap-desc') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || '';
      const desc = descInput?.value.trim() || '';
      if (!name) {
        _snapshotFormError = 'השם לא יכול להיות ריק';
        renderAll();
        return;
      }
      const algoSettings = store.getAlgorithmSettings();
      const result = store.saveScheduleAsSnapshot(currentSchedule, algoSettings, name, desc);
      if (!result) {
        _snapshotFormError = 'שם זה כבר תפוס או שהגעת למגבלת תמונות המצב';
        renderAll();
        return;
      }
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      _snapshotDirty = false;
      renderAll();
    });
  }

  // Confirm Rename
  const confirmRenameBtn = container.querySelector('#btn-snap-confirm-rename');
  if (confirmRenameBtn) {
    confirmRenameBtn.addEventListener('click', () => {
      const activeId = store.getActiveSnapshotId();
      if (!activeId) return;
      const nameInput = document.getElementById('snap-name') as HTMLInputElement | null;
      const descInput = document.getElementById('snap-desc') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || '';
      const desc = descInput?.value.trim() || '';
      if (!name) {
        _snapshotFormError = 'השם לא יכול להיות ריק';
        renderAll();
        return;
      }
      const err = store.renameSnapshot(activeId, name, desc);
      if (err) {
        _snapshotFormError = err;
        renderAll();
        return;
      }
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Cancel form
  const cancelBtn = container.querySelector('#btn-snap-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Delegated click handler for snapshot item actions
  container.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('[data-snap-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.snapAction;
    const snapId = btn.dataset.snapId;
    if (!action || !snapId) return;

    switch (action) {
      case 'load': {
        if (_snapshotDirty && currentSchedule) {
          const ok = await showConfirm('השיבוץ הנוכחי השתנה. לטעון את תמונת המצב ולאבד את השינויים?', { title: 'טעינת תמונת מצב' });
          if (!ok) return;
        }
        loadScheduleSnapshot(snapId);
        showToast('תמונת מצב נטענה', { type: 'success' });
        break;
      }
      case 'update': {
        if (!currentSchedule) return;
        const algoSettings = store.getAlgorithmSettings();
        const ok = store.updateSnapshot(snapId, currentSchedule, algoSettings);
        if (ok) {
          _snapshotDirty = false;
          showToast('תמונת מצב עודכנה', { type: 'success' });
          renderAll();
        }
        break;
      }
      case 'rename': {
        store.setActiveSnapshotId(snapId);
        _snapshotFormMode = 'rename';
        _snapshotFormError = '';
        renderAll();
        break;
      }
      case 'duplicate': {
        const dup = store.duplicateSnapshot(snapId);
        if (dup) {
          store.setActiveSnapshotId(dup.id);
          showToast('תמונת מצב שוכפלה', { type: 'success' });
          renderAll();
        } else {
          await showAlert(`אי אפשר לשכפל: הגעת למגבלה של ${store.getMaxSnapshots()} תמונות מצב.`, { icon: '⚠️' });
        }
        break;
      }
      case 'delete': {
        const snap = store.getSnapshotById(snapId);
        if (!snap) break;
        const ok = await showConfirm(`למחוק את תמונת המצב "${snap.name}"?`, { danger: true, title: 'מחיקת תמונת מצב' });
        if (ok) {
          store.deleteSnapshot(snapId);
          _snapshotFormMode = 'none';
          showToast('תמונת מצב נמחקה', { type: 'success' });
          renderAll();
        }
        break;
      }
    }
  });
}

function wireScheduleEvents(container: HTMLElement): void {
  const genBtn = container.querySelector('#btn-generate');
  if (genBtn) genBtn.addEventListener('click', doGenerate);

  const createManualBtn = container.querySelector('#btn-create-manual');
  if (createManualBtn) createManualBtn.addEventListener('click', doCreateManualSchedule);
  const createManualEmptyBtn = container.querySelector('#btn-create-manual-empty');
  if (createManualEmptyBtn) createManualEmptyBtn.addEventListener('click', doCreateManualSchedule);

  const daysInput = container.querySelector('#input-days') as HTMLInputElement | null;
  if (daysInput) {
    daysInput.addEventListener('change', () => {
      const val = parseInt(daysInput.value, 10);
      if (val >= 1 && val <= 7) {
        store.setScheduleDays(val);
        if (currentDay > val) currentDay = 1;
        renderAll();
      }
    });
  }

  // ── Snapshot Library Events ──
  wireSnapshotEvents(container);

  // Day navigator tabs
  container.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = parseInt((btn as HTMLElement).dataset.day || '1', 10);
      if (day !== currentDay && day >= 1) {
        currentDay = day;
        renderAll();
      }
    });
  });

  // ── Availability strip: open / close / results ──
  const availStrip = container.querySelector('.avail-strip') as HTMLElement | null;
  if (availStrip) {
    availStrip.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (action?.dataset.action === 'open-avail-strip') {
        _availabilityInlineOpen = true;
        renderAll();
        return;
      }
      if (action?.dataset.action === 'close-avail-strip') {
        _availabilityInlineOpen = false;
        _availabilityInlineTimeMs = null;
        renderAll();
        return;
      }
      // Close button inside results
      const closeTarget = (e.target as HTMLElement).closest('[data-action="close-availability-popover"]');
      if (closeTarget) {
        _availabilityInlineTimeMs = null;
        renderAll();
        return;
      }
      // Participant click
      const participantTarget = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (participantTarget?.dataset.pid) {
        navigateToProfile(participantTarget.dataset.pid);
      }
    });
    wireParticipantTooltip(availStrip);
  }

  // ── Continuity: Export day JSON ──
  const exportDayBtn = container.querySelector('#btn-export-day-json');
  if (exportDayBtn && currentSchedule) {
    exportDayBtn.addEventListener('click', () => {
      if (!currentSchedule) return;
      const snapshot = exportDaySnapshot(currentSchedule, currentDay, store.getScheduleDate(), DAY_START_HOUR);
      const json = JSON.stringify(snapshot, null, 2);
      navigator.clipboard.writeText(json).then(() => {
        showToast(`יום ${currentDay} הועתק ללוח — הדבק בשבצ"ק הבא`, { type: 'success' });
      }).catch(() => {
        // Fallback: populate via import modal
        _continuityJson = json;
        showToast('לא ניתן להעתיק ללוח — הנתונים נשמרו בזיכרון', { type: 'warning' });
        renderAll();
      });
    });
  }

  // ── Continuity: Generate from end of day X ──
  const genFromDayBtn = container.querySelector('#btn-generate-from-day');
  if (genFromDayBtn && currentSchedule) {
    genFromDayBtn.addEventListener('click', async () => {
      if (!currentSchedule) return;
      const numDaysNow = store.getScheduleDays();
      const remainingDays = numDaysNow - currentDay;
      if (remainingDays < 1) return;

      // 1. Export snapshot for the current day
      const snapshot = exportDaySnapshot(currentSchedule, currentDay, store.getScheduleDate(), DAY_START_HOUR);
      _continuityJson = JSON.stringify(snapshot, null, 2);

      // 2. Update schedule start date to end of current day
      const dayWindow = getDayWindow(currentDay);
      store.setScheduleDate(dayWindow.end);
      store.setScheduleDays(remainingDays);

      // 3. Trigger generation
      currentDay = 1;
      renderAll();
      await doGenerate();
    });
  }

  // ── Gantt mobile accordion toggle ──
  const ganttToggle = container.querySelector('[data-action="toggle-gantt"]');
  if (ganttToggle) {
    const ganttContent = container.querySelector('.gantt-section-content') as HTMLElement | null;
    // Default: collapsed on mobile, expanded on desktop
    if (isSmallScreen && ganttContent) {
      ganttContent.style.display = 'none';
      ganttToggle.setAttribute('aria-expanded', 'false');
    }
    ganttToggle.addEventListener('click', () => {
      if (!ganttContent) return;
      const expanded = ganttToggle.getAttribute('aria-expanded') === 'true';
      ganttToggle.setAttribute('aria-expanded', String(!expanded));
      ganttContent.style.display = expanded ? 'none' : '';
    });
  }

  // ── Violations toggle (manual build mode) ──
  const violationsToggle = container.querySelector('[data-action="toggle-violations"]');
  if (violationsToggle) {
    violationsToggle.addEventListener('click', () => {
      const section = violationsToggle.closest('.violations-section');
      if (!section) return;
      const expanded = violationsToggle.getAttribute('aria-expanded') === 'true';
      if (!expanded) {
        // Lazy-render violations content
        let content = section.querySelector('.violations-content') as HTMLElement | null;
        if (!content && currentSchedule) {
          content = document.createElement('div');
          content.className = 'violations-content';
          content.innerHTML = renderViolations(currentSchedule);
          section.appendChild(content);
        }
        if (content) content.style.display = '';
        section.classList.remove('violations-collapsed');
      } else {
        const content = section.querySelector('.violations-content') as HTMLElement | null;
        if (content) content.style.display = 'none';
        section.classList.add('violations-collapsed');
      }
      violationsToggle.setAttribute('aria-expanded', String(!expanded));
      const icon = violationsToggle.querySelector('.violations-toggle-icon');
      if (icon) icon.textContent = expanded ? '▸' : '▾';
    });
  }

  // ── Participant Tooltip (event delegation) ──
  wireParticipantTooltip(container);

  // ── Task Tooltip (event delegation) ──
  wireTaskTooltip(container);

  // ── Participant click → Profile View (desktop only; touch uses bottom sheet / long-press) ──
  if (!isTouchDevice) {
    container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      if (pid) navigateToProfile(pid);
    });
  }

  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.time-cell-inspectable[data-time-ms]') as HTMLElement | null;
    if (!target) return;
    const timeMs = Number(target.dataset.timeMs || target.closest('tr[data-time]')?.getAttribute('data-time'));
    if (!Number.isFinite(timeMs)) return;
    _availabilityInlineOpen = true;
    _availabilityInlineTimeMs = timeMs;
    renderAll();
  });

  container.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement).closest('.time-cell-inspectable[data-time-ms]') as HTMLElement | null;
    if (!target) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const timeMs = Number(target.dataset.timeMs || target.closest('tr[data-time]')?.getAttribute('data-time'));
    if (!Number.isFinite(timeMs)) return;
    _availabilityInlineOpen = true;
    _availabilityInlineTimeMs = timeMs;
    renderAll();
  });

  wireCustomSelect(container, 'gm-availability-day', (value) => {
    const day = parseInt(value, 10);
    if (!Number.isNaN(day)) _availabilityInspectorDay = day;
  });

  const availabilityTimeInput = container.querySelector('#gm-availability-time') as HTMLInputElement | null;
  if (availabilityTimeInput) {
    availabilityTimeInput.addEventListener('input', () => {
      _availabilityInspectorTime = availabilityTimeInput.value || '05:00';
    });
    availabilityTimeInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const triggerBtn = container.querySelector('#btn-open-availability-inspector') as HTMLElement | null;
      triggerBtn?.click();
    });
  }

  const availabilityBtn = container.querySelector('#btn-open-availability-inspector') as HTMLElement | null;
  if (availabilityBtn) {
    availabilityBtn.addEventListener('click', () => {
      const selectedDay = _availabilityInspectorDay ?? currentDay;
      const timeValue = availabilityTimeInput?.value || _availabilityInspectorTime;
      const timestamp = resolveLogicalDayTimestamp(selectedDay, timeValue);
      if (!timestamp) {
        showToast('יש להזין שעה תקינה בפורמט HH:MM', { type: 'error' });
        availabilityTimeInput?.focus();
        return;
      }
      _availabilityInspectorTime = timeValue;
      _availabilityInlineTimeMs = timestamp.getTime();
      renderAll();
    });
  }

  // ── Senior toggle button ──
  const seniorToggle = container.querySelector('#btn-senior-toggle');
  if (seniorToggle) {
    seniorToggle.addEventListener('click', () => {
      const panel = document.getElementById('sidebar-senior-panel');
      const arrow = document.getElementById('senior-toggle-arrow');
      if (panel) {
        const visible = !panel.classList.contains('hidden');
        panel.classList.toggle('hidden', visible);
        if (arrow) arrow.textContent = visible ? '▶' : '▼';
      }
    });
  }

  // ── Sidebar collapse toggle ──
  const sidebarToggle = container.querySelector('[data-action="sidebar-toggle"]');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      _sidebarCollapsed = !_sidebarCollapsed;
      localStorage.setItem('gm-sidebar-collapsed', _sidebarCollapsed ? '1' : '0');
      renderAll();
    });
  }

  // ── Mobile sidebar drawer (FAB toggle) ──
  if (isSmallScreen) {
    const fab = container.querySelector('.sidebar-fab');
    if (fab) {
      fab.addEventListener('click', () => {
        const sidebar = container.querySelector('.participant-sidebar');
        const existingBackdrop = document.querySelector('.sidebar-drawer-backdrop');
        if (sidebar?.classList.contains('sidebar-mobile-open')) {
          sidebar.classList.remove('sidebar-mobile-open');
          existingBackdrop?.remove();
        } else if (sidebar) {
          sidebar.classList.add('sidebar-mobile-open');
          const bd = document.createElement('div');
          bd.className = 'sidebar-drawer-backdrop';
          bd.addEventListener('click', () => {
            sidebar.classList.remove('sidebar-mobile-open');
            bd.remove();
          });
          document.body.appendChild(bd);
        }
      });
    }

    // ── Workload bar tap → toast on mobile ──
    container.addEventListener('click', (e) => {
      const bar = (e.target as HTMLElement).closest('.sidebar-bar-bg[title]') as HTMLElement | null;
      if (!bar) return;
      const details = bar.getAttribute('title');
      if (details) showToast(details, { type: 'info', duration: 5000 });
    });
  }

  // ── Live Mode toggle ──
  const liveModeChk = container.querySelector('#chk-live-mode') as HTMLInputElement | null;
  if (liveModeChk) {
    liveModeChk.addEventListener('change', () => {
      store.setLiveModeEnabled(liveModeChk.checked);
      if (liveModeChk.checked && currentSchedule) {
        freezeAssignments(currentSchedule, store.getLiveModeState().currentTimestamp);
      } else if (currentSchedule) {
        unfreezeAll(currentSchedule);
      }
      renderAll();
      if (liveModeChk.checked) {
        requestAnimationFrame(() => scrollToNow(store, false));
      }
    });
  }

  // ── Live Mode day/hour pickers ──
  let _liveDayVal = '';
  let _liveHourVal = '';
  const liveDayEl = container.querySelector('#gm-live-day') as HTMLElement | null;
  const liveHourEl = container.querySelector('#gm-live-hour') as HTMLElement | null;
  if (liveDayEl) _liveDayVal = liveDayEl.dataset.value || '';
  if (liveHourEl) _liveHourVal = liveHourEl.dataset.value || '';
  const updateLiveTimestamp = () => {
    const dayIdx = parseInt(_liveDayVal, 10);
    const hour = parseInt(_liveHourVal, 10);
    if (isNaN(dayIdx) || isNaN(hour)) return;
    const base = store.getScheduleDate();
    const ts = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIdx - 1, hour, 0);
    store.setLiveModeTimestamp(ts);
    if (currentSchedule && store.getLiveModeState().enabled) {
      freezeAssignments(currentSchedule, ts);
    }
    const savedScrollY = window.scrollY;
    renderAll();
    requestAnimationFrame(() => {
      scrollToNow(store, false);
      window.scrollTo(0, savedScrollY);
    });
  };
  wireCustomSelect(container, 'gm-live-day', (v) => { _liveDayVal = v; updateLiveTimestamp(); });
  wireCustomSelect(container, 'gm-live-hour', (v) => { _liveHourVal = v; updateLiveTimestamp(); });

  // ── Reset storage button ──
  const resetBtn = container.querySelector('#btn-reset-storage');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const ok = await showConfirm('למחוק את כל הנתונים השמורים ולטעון מחדש? לא ניתן לבטל פעולה זו.', { danger: true, title: 'איפוס נתונים', confirmLabel: 'אפס הכל' });
      if (ok) {
        store.clearStorage();
        location.reload();
      }
    });
  }

  // ── Export PDF button ──
  const exportBtn = container.querySelector('#btn-export-pdf');
  if (exportBtn) exportBtn.addEventListener('click', openExportModal);

  // ── Manual Build Mode ──
  const manualBuildBtn = container.querySelector('#btn-manual-build');
  if (manualBuildBtn) {
    manualBuildBtn.addEventListener('click', () => {
      _manualBuildActive = !_manualBuildActive;
      clearManualSelection();
      _manualUndoStack = [];
      _warehouseFilter = '';
      renderAll();
    });
  }

  const manualUndoBtn = container.querySelector('#btn-manual-undo');
  if (manualUndoBtn) {
    manualUndoBtn.addEventListener('click', handleManualUndo);
  }

  // Manual-build: slot click delegation on schedule grid
  if (_manualBuildActive) {
    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Handle remove button click
      const removeBtn = target.closest('[data-action="manual-remove"]') as HTMLElement | null;
      if (removeBtn) {
        e.stopPropagation();
        const card = removeBtn.closest('.assignment-card') as HTMLElement | null;
        const aid = card?.dataset.assignmentId;
        if (aid) handleManualRemove(aid);
        return;
      }

      // Handle slot card click
      const card = target.closest('.assignment-card[data-task-id]') as HTMLElement | null;
      if (card) {
        const taskId = card.dataset.taskId;
        const slotId = card.dataset.slotId;
        if (taskId && slotId) {
          handleManualSlotClick(taskId, slotId);
        }
        return;
      }

      // Handle warehouse participant card click (desktop)
      const warehouseCard = target.closest('.warehouse-card[data-pid]') as HTMLElement | null;
      if (warehouseCard) {
        const pid = warehouseCard.dataset.pid;
        if (pid) handleManualParticipantClick(pid);
        return;
      }
    });

    // Warehouse search filter
    const filterInput = container.querySelector('#warehouse-filter') as HTMLInputElement | null;
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        _warehouseFilter = filterInput.value;
        renderAll();
      });
    }

    // Escape key to clear selection
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && _manualBuildActive && (_manualSelectedTaskId || _manualSelectedSlotId)) {
        clearManualSelection();
        renderAll();
      }
    };
    document.addEventListener('keydown', escHandler);
  }
}

// ─── Export PDF Modal ────────────────────────────────────────────────────────

function openExportModal(): void {
  if (!currentSchedule) return;

  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();

  // Build day options for the daily picker
  const exportDayOpts: { value: string; label: string; selected: boolean }[] = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    exportDayOpts.push({ value: String(d), label: `יום ${hebrewDayName(date)}`, selected: d === currentDay });
  }

  const html = `
    <div class="export-backdrop" id="export-modal-backdrop">
      <div class="export-modal">
        <div class="export-header">
          <h3>📤 ייצוא PDF</h3>
          <button class="export-close" id="export-close">✕</button>
        </div>
        <div class="export-body">
          <div class="export-mode-group">
            <label class="export-mode-option selected" id="opt-weekly">
              <input type="radio" name="export-mode" value="weekly" checked />
              <div>
                <div class="export-mode-label">סיכום כללי</div>
                <div class="export-mode-desc">טבלת סיכום מרוכזת של כל השבצ"ק — משתתפים × ימים</div>
              </div>
            </label>
            <label class="export-mode-option" id="opt-daily">
              <input type="radio" name="export-mode" value="daily" />
              <div>
                <div class="export-mode-label">פירוט יומי</div>
                <div class="export-mode-desc">טבלאות מפורטות לפי סוג משימה ליום ספציפי</div>
              </div>
            </label>
          </div>
          <div class="export-day-picker hidden" id="export-day-picker">
            <label>בחר יום:</label>
            ${renderCustomSelect({ id: 'gm-export-day-select', options: exportDayOpts, className: 'export-day-select' })}
          </div>
        </div>
        <div class="export-footer">
          <button class="btn-primary" id="export-do">📄 ייצוא</button>
          <button class="btn-sm btn-outline" id="export-cancel">ביטול</button>
          <span class="export-status" id="export-status"></span>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  wireExportModalEvents();
}

function wireExportModalEvents(): void {
  const backdrop = document.getElementById('export-modal-backdrop');
  if (!backdrop) return;

  // Escape key handler — must be declared before closeModal so it can be cleaned up
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };

  const closeModal = () => {
    document.removeEventListener('keydown', onEscape);
    backdrop.remove();
  };

  // Close buttons
  backdrop.querySelector('#export-close')?.addEventListener('click', closeModal);
  backdrop.querySelector('#export-cancel')?.addEventListener('click', closeModal);

  // Click outside modal closes
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  document.addEventListener('keydown', onEscape);

  // Mode radio toggle
  const optWeekly = backdrop.querySelector('#opt-weekly') as HTMLElement;
  const optDaily = backdrop.querySelector('#opt-daily') as HTMLElement;
  const dayPicker = backdrop.querySelector('#export-day-picker') as HTMLElement;
  const radios = backdrop.querySelectorAll('input[name="export-mode"]');

  radios.forEach(r => {
    r.addEventListener('change', () => {
      const mode = (r as HTMLInputElement).value;
      optWeekly.classList.toggle('selected', mode === 'weekly');
      optDaily.classList.toggle('selected', mode === 'daily');
      if (mode === 'daily') {
        dayPicker.classList.remove('hidden');
        dayPicker.style.display = 'flex';
      } else {
        dayPicker.classList.add('hidden');
        dayPicker.style.display = '';
      }
    });
  });

  // Wire custom select for export day picker
  wireCustomSelect(backdrop, 'gm-export-day-select', () => {});

  // Export action
  backdrop.querySelector('#export-do')?.addEventListener('click', () => {
    if (!currentSchedule) return;
    const status = backdrop.querySelector('#export-status') as HTMLElement;

    const selectedMode = (backdrop.querySelector('input[name="export-mode"]:checked') as HTMLInputElement)?.value;

    try {
      status.textContent = 'מייצא…';
      if (selectedMode === 'weekly') {
        exportWeeklyOverview(currentSchedule);
      } else {
        const daySelectEl = backdrop.querySelector('#gm-export-day-select') as HTMLElement | null;
        const dayIdx = parseInt(daySelectEl?.dataset.value || '1', 10);
        exportDailyDetail(currentSchedule, dayIdx);
      }
      status.textContent = '✓ הייצוא הושלם';
      setTimeout(closeModal, 1200);
    } catch (err) {
      console.error('PDF export error:', err);
      status.textContent = '✗ שגיאה בייצוא';
      status.style.color = '#e74c3c';
    }
  });
}

// ─── Global Participant Tooltip ──────────────────────────────────────────────

let _tooltipEl: HTMLElement | null = null;
let _tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

/** Hide the global tooltip immediately (used when switching to profile view). */
function hideTooltip(): void {
  if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }
  if (_tooltipEl) _tooltipEl.style.display = 'none';
}

/** Navigate to a participant's profile view from any clickable name. */
function navigateToProfile(participantId: string): void {
  if (!currentSchedule) return;
  // Save current scroll position for seamless return
  _scheduleScrollY = window.scrollY;
  _viewMode = 'PROFILE_VIEW';
  _profileParticipantId = participantId;
  hideTooltip();
  renderAll();
  window.scrollTo(0, 0);
}

/** Create or return the singleton tooltip DOM element. */
function getTooltipEl(): HTMLElement {
  if (_tooltipEl) return _tooltipEl;
  const el = document.createElement('div');
  el.className = 'participant-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  // Keep tooltip visible while hovering over the tooltip itself
  el.addEventListener('mouseenter', () => {
    if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });

  // Delegate action button clicks (swap/lock/rescue) inside the tooltip
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    const assignmentId = btn.dataset.assignmentId;
    if (!assignmentId) return;
    e.stopPropagation(); // prevent navigateToProfile from triggering
    el.style.display = 'none'; // hide tooltip immediately

    if (btn.classList.contains('btn-swap')) {
      handleSwap(assignmentId);
    } else if (btn.classList.contains('btn-lock')) {
      handleLock(assignmentId);
    } else if (btn.classList.contains('btn-rescue')) {
      openRescueModal(assignmentId);
    }
  });

  _tooltipEl = el;
  return el;
}

/** Build tooltip HTML content for a participant. */
function buildParticipantTooltipContent(p: Participant, slotCtx?: { assignmentId: string; taskId: string; isFrozen: boolean; isLocked: boolean } | null): string {
  // Workload data
  const numDays = store.getScheduleDays();
  const totalPeriodHours = numDays * 24;

  // Build breakdown using shared utility (R1)
  let bd = { heavyHours: 0, heavyCount: 0, effectiveHeavyHours: 0, hotHours: 0, coldHours: 0, lightHours: 0, lightCount: 0, sourceHours: {} as Record<string,number>, sourceEffectiveHours: {} as Record<string,number>, sourceCounts: {} as Record<string,number>, sourceColors: {} as Record<string,string> };
  if (currentSchedule) {
    const taskMap = new Map<string, Task>();
    for (const t of currentSchedule.tasks) taskMap.set(t.id, t);
    const myItems = currentSchedule.assignments
      .filter(a => a.participantId === p.id)
      .map(a => ({ task: taskMap.get(a.taskId)! }))
      .filter(x => x.task);
    bd = computeTaskBreakdown(myItems);
  }
  const { heavyHours, effectiveHeavyHours, heavyCount, lightCount, sourceHours, sourceEffectiveHours, sourceCounts, sourceColors } = bd;

  // R7: Use effectiveHeavyHours for workload %, consistent with sidebar & profile
  const pctOfPeriod = totalPeriodHours > 0 ? (effectiveHeavyHours / totalPeriodHours) * 100 : 0;

  const certsHtml = p.certifications.length > 0
    ? p.certifications.map((c: Certification) => {
        return `<span class="tt-cert" style="background:${CERT_COLORS[c] || '#7f8c8d'}">${CERT_LABELS[c] || c}</span>`;
      }).join(' ')
    : '<span class="tt-dim">אין</span>';
  const pakalHtml = renderPakalBadges(p, store.getPakalDefinitions(), 'אין');

  // Build per-task breakdown rows (only show sources with count > 0)
  const breakdownRows = Object.keys(sourceCounts)
    .filter(key => sourceCounts[key] > 0)
    .map(key => {
      const color = sourceColors[key] || '#7f8c8d';
      return `<div class="tt-row">
        <span class="tt-label"><span style="color:${color};font-weight:600">${key}</span></span>
        <span class="tt-value">${sourceCounts[key]}× · ${sourceEffectiveHours[key].toFixed(1)} שע' אפקטיביות</span>
      </div>`;
    }).join('');

  // Build action buttons for the Group row (if we have slot context)
  let actionsHtml = '';
  if (slotCtx && !slotCtx.isFrozen) {
    const lm = store.getLiveModeState();
    actionsHtml = `<span class="tt-actions">
      <button class="btn-lock ${slotCtx.isLocked ? 'active' : ''}" data-assignment-id="${slotCtx.assignmentId}" title="${slotCtx.isLocked ? 'בטל נעילה' : 'נעל'}">${slotCtx.isLocked ? '🔒' : '🔓'}</button>
      <button class="btn-swap" data-assignment-id="${slotCtx.assignmentId}" data-task-id="${slotCtx.taskId}" title="החלף">⇄</button>
      ${lm.enabled ? `<button class="btn-rescue" data-assignment-id="${slotCtx.assignmentId}" title="החלפה">🆘</button>` : ''}
    </span>`;
  } else if (slotCtx && slotCtx.isFrozen) {
    actionsHtml = `<span class="tt-actions"><span class="tt-dim">${SVG_ICONS.snowflake}</span></span>`;
  }

  return `
    <div class="tt-header">
      <span class="tt-name">${p.name}</span>
      ${actionsHtml}
      <span class="tt-level" style="background:${LEVEL_COLORS[p.level]}">L${p.level}</span>
    </div>
    <div class="tt-row"><span class="tt-label">קבוצה</span><span class="tt-value" style="color:${groupColor(p.group)}">${p.group}</span></div>
    <div class="tt-row"><span class="tt-label">הסמכות</span><span class="tt-value">${certsHtml}</span></div>
    <div class="tt-row tt-row-wrap"><span class="tt-label">פק"לים</span><span class="tt-value">${pakalHtml}</span></div>
    <div class="tt-divider"></div>
    ${breakdownRows}
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">משימות כבדות</span><span class="tt-value">${heavyCount}</span></div>
    <div class="tt-row"><span class="tt-label">משימות קלות</span><span class="tt-value">${lightCount}</span></div>
    <div class="tt-row"><span class="tt-label">סה"כ שעות</span><span class="tt-value tt-bold">${effectiveHeavyHours.toFixed(1)} שע' אפקטיביות</span></div>
    <div class="tt-row"><span class="tt-label">% עומס</span><span class="tt-value">${pctOfPeriod.toFixed(1)}% מתוך ${totalPeriodHours} שע'</span></div>
    ${isTouchDevice ? `<div class="tt-divider"></div><div class="tt-row"><button class="btn-sm btn-outline" data-action="goto-profile" data-pid="${p.id}" style="width:100%">📋 צפה בפרופיל</button></div>` : ''}
  `;
}

function hideAvailabilityPopover(): void {
  if (_availabilityPopoverKeyHandler) {
    document.removeEventListener('keydown', _availabilityPopoverKeyHandler);
    _availabilityPopoverKeyHandler = null;
  }
  if (_availabilityPopoverEl) {
    _availabilityPopoverEl.remove();
    _availabilityPopoverEl = null;
  }
}

function getAvailableParticipantsAtTime(schedule: Schedule, timeMs: number): Participant[] {
  const taskMap = new Map(schedule.tasks.map(task => [task.id, task]));
  const occupied = new Set<string>();
  for (const assignment of schedule.assignments) {
    const task = taskMap.get(assignment.taskId);
    if (!task) continue;
    const startMs = task.timeBlock.start.getTime();
    const endMs = task.timeBlock.end.getTime();
    if (startMs <= timeMs && timeMs < endMs) {
      occupied.add(assignment.participantId);
    }
  }
  return schedule.participants.filter(participant => !occupied.has(participant.id));
}

function buildAvailabilityPopoverContent(timeMs: number): string {
  if (!currentSchedule) return '';
  const selectedTime = new Date(timeMs);
  const definitions = store.getPakalDefinitions();
  const available = getAvailableParticipantsAtTime(currentSchedule, timeMs);
  const pakalimByParticipantId = new Map(
    available.map(participant => [participant.id, getEffectivePakalDefinitions(participant, definitions)])
  );

  const summarizeParticipants = (participants: Participant[]): string => {
    if (participants.length === 0) return 'אין פנויים כרגע';
    const leadingNames = participants.slice(0, 2).map(participant => participant.name);
    const remaining = participants.length - leadingNames.length;
    return remaining > 0 ? `${leadingNames.join(', ')} +${remaining}` : leadingNames.join(', ');
  };

  const buckets = definitions.map(def => {
    const participants = available.filter(participant =>
      (pakalimByParticipantId.get(participant.id) || []).some(item => item.id === def.id)
    );
    return {
      label: def.label,
      participants,
      count: participants.length,
      preview: summarizeParticipants(participants),
      className: 'availability-bucket',
    };
  });

  const noPakalParticipants = available.filter(participant => (pakalimByParticipantId.get(participant.id)?.length ?? 0) === 0);
  const multiPakalParticipants = available.filter(participant => (pakalimByParticipantId.get(participant.id)?.length ?? 0) > 1);
  const totalWithPakal = available.length - noPakalParticipants.length;
  const noPakalBucket = {
    label: 'ללא שיוך לפק"ל',
    participants: noPakalParticipants,
    count: noPakalParticipants.length,
    preview: summarizeParticipants(noPakalParticipants),
    className: 'availability-bucket availability-bucket-none',
  };
  const visibleBuckets = buckets
    .filter(bucket => bucket.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'he'));
  const emptyBuckets = buckets.filter(bucket => bucket.count === 0);
  const displayBuckets = [...visibleBuckets, noPakalBucket, ...emptyBuckets];

  const renderParticipantList = (participants: Participant[]): string => {
    if (participants.length === 0) return '<div class="availability-empty">כרגע אין פנויים בקבוצה הזאת.</div>';
    return `<div class="availability-name-list">${participants.map(participant => {
      const pakalCount = pakalimByParticipantId.get(participant.id)?.length ?? 0;
      return `<div class="availability-name-row"><span class="participant-hover" data-pid="${participant.id}">${escHtml(participant.name)}</span>${pakalCount > 1 ? `<span class="badge badge-sm availability-multi-tag">${pakalCount} פק"לים</span>` : ''}</div>`;
    }).join('')}</div>`;
  };

  const renderBucket = (
    bucket: { label: string; participants: Participant[]; count: number; preview: string; className: string },
  ): string => {
    const bucketLabel = escHtml(bucket.label);
    const preview = escHtml(bucket.preview);
    if (bucket.count === 0) {
      return `<div class="${bucket.className} availability-bucket-empty availability-bucket-zero"><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">אין פנויים כרגע</span></span><span class="availability-bucket-count">0</span></div>`;
    }
    return `<details class="${bucket.className}">
      <summary><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">${preview}</span></span><span class="availability-bucket-count">${bucket.count}</span></summary>
      ${renderParticipantList(bucket.participants)}
    </details>`;
  };

  const quickStats = [
    { label: 'עם פק"ל', value: totalWithPakal },
    { label: 'ללא פק"ל', value: noPakalParticipants.length },
    { label: 'בכמה פק"לים', value: multiPakalParticipants.length },
  ];

  return `
    <div class="availability-popover-header">
      <div>
        <h3>פנויים לפי פק"ל</h3>
        <div class="availability-popover-subtitle">נכון ל${fmtDate(selectedTime)}</div>
      </div>
      <button class="btn-sm btn-outline availability-close" data-action="close-availability-popover">סגור</button>
    </div>
    <div class="availability-popover-body">
      <div class="availability-overview">
        <div class="availability-total-card">
          <span class="availability-total-count">${available.length}</span>
          <div class="availability-total-copy">
            <strong>${available.length === 0 ? 'אין עתודה פנויה' : 'עתודה פנויה'}</strong>
            <span>מספר המשתתפים שלא נמצאים כרגע במשימה.</span>
          </div>
        </div>
        <div class="availability-quick-stats">
          ${quickStats.map(stat => `<div class="availability-quick-stat"><span class="availability-quick-stat-value">${stat.value}</span><span class="availability-quick-stat-label">${stat.label}</span></div>`).join('')}
        </div>
      </div>
      <div class="availability-summary-note">למטה מופיע פירוט לפי פק"ל. משתתף עם יותר מפק"ל אחד יכול להופיע ביותר מקבוצה אחת.</div>
      <div class="availability-section-title">פירוט מהיר לפי פק"ל</div>
      <div class="availability-bucket-list">
        ${displayBuckets.map(renderBucket).join('')}
      </div>
      ${multiPakalParticipants.length > 0 ? `<details class="availability-overlap">
        <summary><span class="availability-bucket-main"><span class="availability-bucket-label">מופיעים בכמה פק"לים</span><span class="availability-bucket-preview">כדאי לבדוק אותם קודם</span></span><span class="availability-bucket-count">${multiPakalParticipants.length}</span></summary>
        <div class="availability-overlap-note">המשתתפים כאן כבר נספרו בפירוט שלמעלה. הרשימה הזאת רק עוזרת לזהות במהירות חפיפות בין פק"לים.</div>
        ${renderParticipantList(multiPakalParticipants)}
      </details>` : ''}
    </div>
  `;
}


/** Wire event-delegated tooltip for .participant-hover elements. */
function wireParticipantTooltip(container: HTMLElement): void {
  if (!currentSchedule) return;

  const pMap = new Map<string, Participant>();
  for (const p of currentSchedule.participants) pMap.set(p.id, p);

  if (isTouchDevice) {
    // ── Touch: tap opens bottom sheet with participant info ──
    let _longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let _longPressFired = false;

    container.addEventListener('touchstart', (e) => {
      const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (!target) return;
      _longPressFired = false;
      _longPressTimer = setTimeout(() => {
        _longPressFired = true;
        const pid = target.dataset.pid;
        if (pid) navigateToProfile(pid);
      }, 500);
    }, { passive: true });

    container.addEventListener('touchend', () => {
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    });

    container.addEventListener('touchmove', () => {
      if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
    }, { passive: true });

    container.addEventListener('click', (e) => {
      if (_longPressFired) { _longPressFired = false; return; }
      const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      if (!pid) return;
      const p = pMap.get(pid);
      if (!p) return;

      e.stopPropagation(); // prevent navigateToProfile click handler

      const slotCtx = target.dataset.assignmentId
        ? {
            assignmentId: target.dataset.assignmentId,
            taskId: target.dataset.taskId || '',
            isFrozen: target.dataset.frozen === '1',
            isLocked: target.dataset.locked === '1',
          }
        : null;

      const content = buildParticipantTooltipContent(p, slotCtx);
      const handle = showBottomSheet(content, {
        title: p.name,
        onClose: () => {},
      });

      // Wire action buttons inside the bottom sheet
      const sheetBody = document.querySelector('.gm-bs-body');
      if (sheetBody) {
        sheetBody.addEventListener('click', (ev) => {
          const btn = (ev.target as HTMLElement).closest('button') as HTMLElement | null;
          if (!btn) return;
          const assignmentId = btn.dataset.assignmentId;
          if (!assignmentId) return;
          handle.close();
          if (btn.classList.contains('btn-swap')) handleSwap(assignmentId);
          else if (btn.classList.contains('btn-lock')) handleLock(assignmentId);
          else if (btn.classList.contains('btn-rescue')) openRescueModal(assignmentId);
        });

        // Wire "view profile" link if participant name is tapped inside sheet
        sheetBody.addEventListener('click', (ev) => {
          const profileLink = (ev.target as HTMLElement).closest('[data-action="goto-profile"]') as HTMLElement | null;
          if (profileLink?.dataset.pid) {
            handle.close();
            navigateToProfile(profileLink.dataset.pid);
          }
        });
      }
    });
    return;
  }

  // ── Desktop: hover shows fixed tooltip ──
  container.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('.participant-hover') as HTMLElement | null;
    if (!target) return;
    const pid = target.dataset.pid;
    if (!pid) return;
    const p = pMap.get(pid);
    if (!p) return;

    if (_tooltipHideTimer) { clearTimeout(_tooltipHideTimer); _tooltipHideTimer = null; }

    // Build slot context from data attributes on the participant-hover span
    const slotCtx = target.dataset.assignmentId
      ? {
          assignmentId: target.dataset.assignmentId,
          taskId: target.dataset.taskId || '',
          isFrozen: target.dataset.frozen === '1',
          isLocked: target.dataset.locked === '1',
        }
      : null;

    const tooltip = getTooltipEl();
    tooltip.innerHTML = buildParticipantTooltipContent(p, slotCtx);
    tooltip.style.display = 'block';

    // Position near the target
    const rect = target.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top - 4;

    // Clamp to viewport
    const ttWidth = 280;
    const ttHeight = 260;
    if (left + ttWidth > window.innerWidth) {
      left = rect.left - ttWidth - 8;
    }
    if (top + ttHeight > window.innerHeight) {
      top = window.innerHeight - ttHeight - 8;
    }
    if (top < 4) top = 4;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });

  container.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('.participant-hover') as HTMLElement | null;
    if (!target) return;
    // Delay hide so user can hover onto the tooltip itself
    _tooltipHideTimer = setTimeout(() => {
      const tooltip = getTooltipEl();
      tooltip.style.display = 'none';
    }, 120);
  });
}

// ─── Global Task Tooltip ─────────────────────────────────────────────────────

let _taskTooltipEl: HTMLElement | null = null;
let _taskTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

function hideTaskTooltip(): void {
  if (_taskTooltipHideTimer) { clearTimeout(_taskTooltipHideTimer); _taskTooltipHideTimer = null; }
  if (_taskTooltipEl) _taskTooltipEl.style.display = 'none';
}

function getTaskTooltipEl(): HTMLElement {
  if (_taskTooltipEl) return _taskTooltipEl;
  const el = document.createElement('div');
  el.className = 'task-detail-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (_taskTooltipHideTimer) { clearTimeout(_taskTooltipHideTimer); _taskTooltipHideTimer = null; }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });
  _taskTooltipEl = el;
  return el;
}

/** Build rich tooltip HTML for a task showing time, name, type, and all teammates. */
function buildTaskTooltipContent(taskId: string): string {
  if (!currentSchedule) return '';
  const taskMap = new Map<string, Task>();
  for (const t of currentSchedule.tasks) taskMap.set(t.id, t);
  const task = taskMap.get(taskId);
  if (!task) return '';

  const pMap = new Map<string, Participant>();
  for (const p of currentSchedule.participants) pMap.set(p.id, p);

  const taskColor = task.color || '#7f8c8d';
  const startStr = fmt(task.timeBlock.start);
  const endStr = fmt(task.timeBlock.end);
  const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;

  // Find all assignments for this task
  const taskAssignments = currentSchedule.assignments.filter(a => a.taskId === taskId);

  // Build teammates list
  let teammatesHtml = '';
  if (taskAssignments.length === 0) {
    teammatesHtml = '<div class="ttt-empty">אין שיבוצים</div>';
  } else {
    teammatesHtml = '<div class="ttt-teammates">';
    for (const a of taskAssignments) {
      const p = pMap.get(a.participantId);
      if (!p) continue;
      const slot = task.slots.find(s => s.slotId === a.slotId);
      const levelColors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
      const certsHtml = p.certifications.length > 0
        ? p.certifications.map(c =>
            `<span class="ttt-cert" style="background:${CERT_COLORS[c] || '#7f8c8d'}">${CERT_LABELS[c] || c}</span>`
          ).join('')
        : '';
      teammatesHtml += `<div class="ttt-mate">
        <div class="ttt-mate-main">
          <span class="ttt-mate-name">${p.name}</span>
          <span class="ttt-mate-level" style="background:${levelColors[p.level]}">L${p.level}</span>
        </div>
        <div class="ttt-mate-meta">
          ${slot ? `<span class="ttt-slot">${slot.label || task.name}</span>` : ''}
          ${certsHtml}
        </div>
      </div>`;
    }
    teammatesHtml += '</div>';
  }

  return `
    <div class="ttt-header">
      <span class="ttt-task-name" style="border-inline-start:3px solid ${taskColor};padding-inline-start:8px">${task.name}</span>
      <span class="badge badge-sm" style="background:${taskColor}">${task.sourceName || task.name}</span>
      ${task.isLight ? '<span class="badge badge-sm" style="background:#7f8c8d">קלה</span>' : ''}
    </div>
    <div class="ttt-time">
      <span>${startStr} – ${endStr}</span>
      <span class="ttt-dur">${hrs.toFixed(1)} שע'</span>
    </div>
    <div class="ttt-divider"></div>
    <div class="ttt-section-label">צוות משמרת (${taskAssignments.length})</div>
    ${teammatesHtml}
  `;
}

/** Wire event-delegated tooltip for .task-tooltip-hover elements. */
function wireTaskTooltip(container: HTMLElement): void {
  if (!currentSchedule) return;

  if (isTouchDevice) {
    // ── Touch: tap toggles inline detail panel ──
    let _expandedTaskId: string | null = null;

    container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]') as HTMLElement | null;
      if (!target) return;
      const taskId = target.dataset.taskId;
      if (!taskId) return;

      // Remove any existing inline detail
      const existing = container.querySelector('.task-inline-detail');
      if (existing) existing.remove();

      // If same task tapped again, just collapse
      if (_expandedTaskId === taskId) { _expandedTaskId = null; return; }

      const content = buildTaskTooltipContent(taskId);
      if (!content) return;

      _expandedTaskId = taskId;
      const detail = document.createElement('div');
      detail.className = 'task-inline-detail';
      detail.innerHTML = content;
      target.insertAdjacentElement('afterend', detail);
    });

    // Dismiss when tapping outside a task-tooltip-hover
    container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]');
      if (target) return; // handled above
      const existing = container.querySelector('.task-inline-detail');
      if (existing) { existing.remove(); _expandedTaskId = null; }
    });
    return;
  }

  // ── Desktop: hover shows fixed tooltip ──
  container.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]') as HTMLElement | null;
    if (!target) return;
    const taskId = target.dataset.taskId;
    if (!taskId) return;

    if (_taskTooltipHideTimer) { clearTimeout(_taskTooltipHideTimer); _taskTooltipHideTimer = null; }

    const content = buildTaskTooltipContent(taskId);
    if (!content) return;

    const tooltip = getTaskTooltipEl();
    tooltip.innerHTML = content;
    tooltip.style.display = 'block';

    // Position near the target
    const rect = target.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top - 4;

    // Clamp to viewport
    const ttWidth = 310;
    const ttHeight = tooltip.offsetHeight || 200;
    if (left + ttWidth > window.innerWidth) {
      left = rect.left - ttWidth - 8;
    }
    if (top + ttHeight > window.innerHeight) {
      top = window.innerHeight - ttHeight - 8;
    }
    if (top < 4) top = 4;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });

  container.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]') as HTMLElement | null;
    if (!target) return;
    _taskTooltipHideTimer = setTimeout(() => {
      const tooltip = getTaskTooltipEl();
      tooltip.style.display = 'none';
    }, 150);
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Store-change subscriber — called by config-store.notify() after every
 * mutation.  Marks the schedule as dirty so the UI can prompt for
 * re-generation, and strips assignments whose participant was deleted.
 */
function onStoreChanged(): void {
  // Never mess with schedule during optimization
  if (_isOptimizing) return;
  if (!currentSchedule) return;

  _scheduleDirty = true;

  // ── 1. Refresh participants ──────────────────────────────────────────────
  const currentParticipants = store.getAllParticipants();
  const storeIds = new Set(currentParticipants.map(p => p.id));
  const storeMap = new Map(currentParticipants.map(p => [p.id, p]));

  let cleanedAssignments = currentSchedule.assignments.filter(
    a => storeIds.has(a.participantId),
  );

  const refreshedParticipants = currentSchedule.participants
    .filter(p => storeIds.has(p.id))
    .map(p => storeMap.get(p.id)!);

  // ── 2. Sync tasks with current templates ─────────────────────────────────
  // Regenerate tasks from current template definitions so added/removed
  // sub-teams are reflected immediately in the schedule grid.
  const freshTasks = generateTasksFromTemplates();

  // Build a lookup: old task name → old task (names are stable across edits)
  const oldTaskByName = new Map(currentSchedule.tasks.map(t => [t.name, t]));

  // Build a lookup: old slotId → assignment  (for remapping)
  const assignBySlot = new Map(cleanedAssignments.map(a => [a.slotId, a]));

  const remappedAssignments: typeof cleanedAssignments = [];
  const newTasks: Task[] = freshTasks.map(freshTask => {
    const oldTask = oldTaskByName.get(freshTask.name);
    if (!oldTask) return freshTask; // brand-new task, no assignments to carry

    // Map old slots by subTeamId+label for stable matching
    const oldSlotKey = (s: SlotRequirement) => `${s.subTeamId ?? ''}::${s.label ?? ''}`;
    // Track which old slots have been consumed (to handle duplicates)
    const oldSlotsByKey = new Map<string, SlotRequirement[]>();
    for (const s of oldTask.slots) {
      const key = oldSlotKey(s);
      if (!oldSlotsByKey.has(key)) oldSlotsByKey.set(key, []);
      oldSlotsByKey.get(key)!.push(s);
    }

    // For each new slot, try to find a matching old slot and carry its assignment
    const mappedSlots = freshTask.slots.map(newSlot => {
      const key = oldSlotKey(newSlot);
      const candidates = oldSlotsByKey.get(key);
      if (candidates && candidates.length > 0) {
        const oldSlot = candidates.shift()!;
        const oldAssign = assignBySlot.get(oldSlot.slotId);
        if (oldAssign) {
          remappedAssignments.push({
            ...oldAssign,
            taskId: freshTask.id,
            slotId: newSlot.slotId,
          });
        }
      }
      return newSlot;
    });

    return { ...freshTask, slots: mappedSlots };
  });

  // Also carry over assignments that were already remapped above
  // (drop old assignments — they've been remapped or belong to deleted slots)
  cleanedAssignments = remappedAssignments;

  // ── 3. Rebuild schedule ──────────────────────────────────────────────────
  currentSchedule = {
    ...currentSchedule,
    tasks: newTasks,
    assignments: cleanedAssignments,
    participants: refreshedParticipants,
  };

  // Revalidate violations/score after reconciliation
  if (engine) {
    engine.importSchedule(currentSchedule);
    engine.addParticipants(refreshedParticipants);
    engine.revalidateFull();
    currentSchedule = engine.getSchedule()!;
  }
}

function init(): void {
  // Set .touch-device / .pointer-device on <html> before first render
  initResponsive();

  // Apply saved theme before first render to prevent flash
  applyTheme(getStoredTheme());

  store.initStore();
  store.subscribe(onStoreChanged);
  store.setSaveErrorHandler(() => {
    showToast('שמירת נתונים נכשלה — ייתכן שהדפדפן חסם אחסון מקומי', { type: 'error', duration: 5000 });
  });

  // Clear any previously saved schedule so the app starts fresh
  store.clearSchedule();

  renderAll();

  // Update the live clock every 30 seconds without a full re-render
  setInterval(() => {
    const el = document.getElementById('live-clock');
    if (el) el.textContent = formatLiveClock();
  }, 30_000);

  // Flush any pending debounced save on page unload to prevent data loss
  window.addEventListener('beforeunload', (e) => {
    store.flushPendingSave();
    if (_isOptimizing) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

}

document.addEventListener('DOMContentLoaded', init);
