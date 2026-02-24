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

import {
  SchedulingEngine,
  Participant,
  Level,
  Certification,
  TaskType,
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
} from '../index';
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
import { renderParticipantsTab, wireParticipantsEvents } from './tab-participants';
import { renderTaskRulesTab, wireTaskRulesEvents } from './tab-task-rules';
import { renderProfileView, wireProfileEvents, ProfileContext } from './tab-profile';
import { renderAlgorithmTab, wireAlgorithmEvents } from './tab-algorithm';
import { computeTaskBreakdown } from './workload-utils';
import { exportWeeklyOverview, exportDailyDetail } from './pdf-export';
import {
  TASK_COLORS, LEVEL_COLORS, CERT_COLORS, CERT_LABELS, TASK_TYPE_LABELS,
  fmt, levelBadge, certBadge, certBadges, groupBadge, groupColor, taskTypeBadge,
} from './ui-helpers';

// ─── Globals ─────────────────────────────────────────────────────────────────

let currentTab: 'participants' | 'task-rules' | 'schedule' | 'algorithm' = 'participants';
let engine: SchedulingEngine | null = null;
let currentSchedule: Schedule | null = null;
let scheduleElapsed = 0;
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

// ─── Rescue Modal State ──────────────────────────────────────────────────────

/** Currently displayed rescue result (null when modal is closed) */
let _rescueResult: RescueResult | null = null;
/** Which assignment ID the rescue modal is open for */
let _rescueAssignmentId: string | null = null;
/** Current rescue page (0-based) */
let _rescuePage = 0;

// ─── Formatting Helpers (app-local) ──────────────────────────────────────────

function fmtDate(d: Date): string {
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: 'short' }) + ' ' + fmt(d);
}

function fmtDayShort(d: Date): string {
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: 'short' });
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

// ─── Day Window Helpers ──────────────────────────────────────────────────────

/**
 * Filter out violations whose constraint code has been disabled by the user
 * in the Algorithm Settings panel.  This is a UI-only safety net; the engine
 * should already omit them, but we guard the display layer too.
 */
function filterVisibleViolations(violations: ConstraintViolation[]): ConstraintViolation[] {
  const disabledHC = store.getDisabledHCSet();
  const disabledSW = store.getDisabledSWSet();
  if (disabledHC.size === 0 && disabledSW.size === 0) return violations;
  return violations.filter(v => !disabledHC.has(v.code) && !disabledSW.has(v.code));
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
  const allTasks: Task[] = [];
  _tSlotCounter = 0;
  _tTaskCounter = 0;

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);

      let shifts: { start: Date; end: Date }[];
      if (tpl.taskType === TaskType.Aruga) {
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
          const adanitTeam = (st.name.includes('ראשי') || /main/i.test(st.name))
            ? AdanitTeam.SegolMain
            : (st.name.includes('משני') || /secondary/i.test(st.name))
              ? AdanitTeam.SegolSecondary
              : undefined;

          for (const s of st.slots) {
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              adanitTeam,
              label: s.label,
            });
          }
        }

        for (const s of tpl.slots) {
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            label: s.label,
          });
        }

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_tTaskCounter}`,
          type: (tpl.taskType as TaskType) || TaskType.Adanit,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          isLight: tpl.isLight,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive ?? !tpl.isLight,
        });
      }
    }
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
    const dayName = date.toLocaleDateString('he-IL', { weekday: 'short' });
    const dayNum = date.getDate();

    // Count tasks and assignments for this day
    let taskCount = 0;
    let violationCount = 0;
    if (currentSchedule) {
      taskCount = currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).length;
      // Count violations for tasks on this day
      const dayTaskIds = new Set(currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).map(t => t.id));
      violationCount = filterVisibleViolations(currentSchedule.violations).filter(v =>
        v.severity === ViolationSeverity.Error && v.taskId && dayTaskIds.has(v.taskId)
      ).length;
    }

    const violationDot = violationCount > 0
      ? `<span class="day-violation-dot" title="${violationCount} הפרות">!</span>`
      : '';

    // Frozen / partially frozen indicators
    let frozenTag = '';
    let frozenClass = '';
    if (liveMode.enabled) {
      if (isDayFrozen(d, baseDate, liveMode.currentTimestamp, DAY_START_HOUR)) {
        frozenTag = `<span class="day-frozen-badge" title="יום זה מוקפא (עבר)">🧊</span>`;
        frozenClass = ' day-tab-frozen';
      } else if (isDayPartiallyFrozen(d, baseDate, liveMode.currentTimestamp, DAY_START_HOUR)) {
        frozenTag = `<span class="day-frozen-badge day-frozen-partial" title="מוקפא חלקית">⏳</span>`;
        frozenClass = ' day-tab-partial-frozen';
      }
    }

    html += `<button class="day-tab ${currentDay === d ? 'day-tab-active' : ''}${frozenClass}" data-day="${d}">
      <span class="day-tab-name">${dayName}</span>
      <span class="day-tab-num">${dayNum}</span>
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
          <span class="kpi-value">${feasibleText}</span>
          <span class="kpi-label">סטטוס ${numDays} ימים</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${score.compositeScore.toFixed(1)}</span>
          <span class="kpi-label">ציון שבועי</span>
        </div>
        <div class="kpi ${totalViolations > 0 ? 'kpi-error' : 'kpi-ok'}">
          <span class="kpi-value">${totalViolations}</span>
          <span class="kpi-label">הפרות</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${warnings}</span>
          <span class="kpi-label">אזהרות</span>
        </div>
      </div>
      <div class="week-dots-strip">
        <span class="week-dots-label">ימים</span>
        <div class="week-dots">${dayDots}</div>
      </div>
    </div>
    <div class="dashboard-meta">
      הטוב מתוך ${OPTIM_ATTEMPTS} ניסיונות ב${(scheduleElapsed / 1000).toFixed(1)} שניות ביצוע.
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
    tooltipParts.push(`י${d}: ${dayHrs.toFixed(1)} שע'`);
  }
  const todayHrs = entry.perDay.get(currentDay) || 0;
  const todayRatio = totalPeriodHours > 0 ? todayHrs / totalPeriodHours : 0;
  const todayBarWidth = Math.min(todayRatio * 100 * (100 / 30), barWidth);

  const diagTooltip = `${entry.w.effectiveHours.toFixed(1)} שע' אפקטיביות / ${totalPeriodHours} שע' תקופה = ${entry.pctOfPeriod.toFixed(1)}%\n` +
    `חם: ${entry.w.hotHours.toFixed(1)} שע' · קר: ${entry.w.coldHours.toFixed(1)} שע' · גולמי: ${entry.w.totalHours.toFixed(1)} שע'\n` +
    `שיבוצים: ${entry.w.nonLightCount} משימות כבדות\n` +
    tooltipParts.join(' | ');

  return `<div class="sidebar-entry">
    <div class="sidebar-name">
      <span class="participant-hover" data-pid="${p.id}">${p.name}</span>
      <span class="sidebar-meta">${groupBadge(p.group)} ${levelBadge(p.level)}</span>
    </div>
    <div class="sidebar-bar-row">
      <div class="sidebar-bar-bg" title="${diagTooltip}">
        <div class="sidebar-bar-fill ${barClass}" style="width:${barWidth}%"></div>
        <div class="sidebar-bar-today" style="width:${todayBarWidth}%"></div>
        <span class="sidebar-bar-label">${entry.w.effectiveHours.toFixed(1)} שע' אפק' (${entry.pctOfPeriod.toFixed(1)}%)</span>
      </div>
      <span class="sidebar-today-tag" title="היום (יום ${currentDay}): ${todayHrs.toFixed(1)} שע' גולמיות">
        גולמי י${currentDay}: ${todayHrs.toFixed(1)} שע'
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
  let html = `<div class="participant-sidebar">
    <div class="sidebar-header">
      <h3>השוואת עומס</h3>
      <div class="sidebar-avg">ממוצע: ${l0Avg.toFixed(1)} שע' אפק' · ${l0Entries.length} משתתפים · ${numDays} ימים</div>
    </div>
    <div class="sidebar-entries">`;

  for (const entry of l0Entries) {
    html += renderSidebarEntry(entry, totalPeriodHours);
  }

  html += `</div>`;

  // ── Senior Section (hidden by default) ──
  html += `
    <div class="sidebar-senior-divider">
      <button class="btn-senior-toggle" id="btn-senior-toggle" title="הצג / הסתר עומס בכירים (L2-L4)">
        👤 תצוגת בכירים (${seniorEntries.length})
        <span class="senior-toggle-arrow" id="senior-toggle-arrow">▶</span>
      </button>
    </div>
    <div class="sidebar-senior-panel" id="sidebar-senior-panel" style="display:none">
      <div class="sidebar-header sidebar-header-senior">
        <h3>עומס בכירים (L2-L4)</h3>
        <div class="sidebar-avg">ממוצע: ${seniorAvg.toFixed(1)} שע' אפק' · σ ${seniorSigma.toFixed(2)} · ${seniorEntries.length} משתתפים</div>
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
    let dayOptions = '';
    for (let d = 1; d <= numDays; d++) {
      const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
      const label = `יום ${d} (${date.toLocaleDateString('he-IL', { weekday: 'short', day: '2-digit', month: 'short' })})`;
      // Determine which day is currently selected
      let selected = false;
      if (liveMode.enabled) {
        const anchor = liveMode.currentTimestamp;
        const dayStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1, DAY_START_HOUR, 0);
        const dayEnd = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d, DAY_START_HOUR, 0);
        selected = anchor.getTime() >= dayStart.getTime() && anchor.getTime() < dayEnd.getTime();
      }
      dayOptions += `<option value="${d}" ${selected ? 'selected' : ''}>${label}</option>`;
    }

    // Current anchor hour
    const anchorHour = liveMode.enabled ? liveMode.currentTimestamp.getHours() : 5;
    let hourOptions = '';
    for (let h = 0; h < 24; h++) {
      hourOptions += `<option value="${h}" ${h === anchorHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`;
    }

    liveModeControls = `
      <div class="live-mode-controls">
        <label class="live-mode-toggle" title="Enable Live Mode to freeze past assignments">
          <input type="checkbox" id="chk-live-mode" ${liveMode.enabled ? 'checked' : ''} />
          <span class="live-toggle-label">🔴 מצב חי</span>
        </label>
        ${liveMode.enabled ? `
          <div class="live-mode-picker">
            <label>עכשיו ב:
              <select id="sel-live-day" class="input-sm">${dayOptions}</select>
              <select id="sel-live-hour" class="input-sm">${hourOptions}</select>
            </label>
          </div>
        ` : ''}
      </div>`;
  }

  let html = `<div class="tab-toolbar">
    <div class="toolbar-left"><h2>תצוגת שבצ"ק</h2>
      <span class="text-muted" style="margin-inline-start:12px">שבצ"ק ל-${numDays} ימים</span>
    </div>
    <div class="toolbar-right">
      ${liveModeControls}
      <label class="scenarios-label" for="input-scenarios" title="מספר תרחישי אופטימיזציה לבדיקה">תרחישים
        <input type="number" id="input-scenarios" class="input-scenarios" min="1" max="50000" step="100" value="${OPTIM_ATTEMPTS}" ${_isOptimizing ? 'disabled' : ''} />
      </label>
      <button class="btn-primary ${_scheduleDirty && currentSchedule ? 'btn-generate-dirty' : ''}" id="btn-generate" ${!preflight.canGenerate || _isOptimizing ? 'disabled' : ''}
        ${!preflight.canGenerate ? 'title="תקן בעיות קריטיות בכללי המשימות תחילה"' : ''}>
        ${_isOptimizing ? '⏳ מייעל…' : currentSchedule ? '🔄 צור מחדש' : '⚡ צור שבצ"ק'}
      </button>
      ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-reset-storage" title="אפס להגדרות ברירת מחדל ומחק נתונים שמורים">🔄 אפס</button>` : ''}
      <button class="btn-sm ${_snapshotPanelOpen ? 'btn-primary' : 'btn-outline'}" id="btn-snap-toggle" title="תמונות מצב שמורות">💾${store.getAllSnapshots().length > 0 ? ` (${store.getAllSnapshots().length})` : ''}</button>
      ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-export-pdf" title="ייצוא PDF">📤 ייצוא</button>` : ''}
    </div>
  </div>`;

  // ── Snapshot Library Panel (collapsible) ──
  if (_snapshotPanelOpen) {
    html += renderSnapshotPanel();
  }

  if (_scheduleDirty && currentSchedule) {
    html += `<div class="dirty-notice">⚠ השבצ"ק לא מעודכן — מומלץ ליצור מחדש</div>`;
  }

  if (!preflight.canGenerate) {
    const crits = preflight.findings.filter(f => f.severity === 'Critical');
    html += `<div class="alert alert-error">
      <strong>לא ניתן ליצור — ${crits.length} בעיות קריטיות:</strong>
      <ul>${crits.map(f => `<li>${f.message}</li>`).join('')}</ul>
      <p>עבור ל<strong>פירוט משימות</strong> כדי לתקן.</p>
    </div>`;
  }

  if (!currentSchedule) {
    if (preflight.canGenerate) {
      html += `<div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>טרם נוצר שבצ"ק.</p>
        <p class="text-muted">הגדר משתתפים ופירוט משימות, ולאחר מכן לחץ "צור שבצ"ק".</p>
      </div>`;
    }
    return html;
  }

  const s = currentSchedule;

  // Weekly Dashboard — always visible
  html += renderWeeklyDashboard(s);

  // Day Navigator tabs
  html += renderDayNavigator();

  // Day window label
  const { start: dayStart, end: dayEnd } = getDayWindow(currentDay);
  html += `<div class="day-window-label">
    מציג <strong>יום ${currentDay}</strong>: ${fmtDayShort(dayStart)} ${fmt(dayStart)} – ${fmtDayShort(dayEnd)} ${fmt(dayEnd)}
  </div>`;

  // Main layout: content + sidebar
  html += `<div class="schedule-layout">`;
  html += `<div class="schedule-main">`;
  html += `<section><h2>שיבוצים <span class="count">${getFilteredAssignments(s).length}</span></h2>${renderScheduleGrid(s, currentDay, store.getLiveModeState())}</section>`;
  html += `<section><h2>מערכת שעות כללית</h2>${renderGanttChart(s)}</section>`;
  html += `<section><h2>הפרות אילוצים <span class="count">${filterVisibleViolations(s.violations).length}</span></h2>${renderViolations(s)}</section>`;
  html += `</div>`;
  html += renderParticipantSidebar(s);
  html += `</div>`;

  // Optimization overlay (rendered inside tab so it covers the schedule board)
  html += renderOptimOverlay();

  return html;
}

// ─── Snapshot Panel ─────────────────────────────────────────────────────────

function renderSnapshotPanel(): string {
  const snapshots = store.getAllSnapshots();
  const activeId = store.getActiveSnapshotId();
  const hasSchedule = !!currentSchedule;
  const maxSnaps = store.getMaxSnapshots();

  let html = `<div class="snapshot-panel">`;

  // ── Header row ──
  html += `<div class="snapshot-panel-header">
    <h3>💾 תמונות מצב <span class="count">${snapshots.length}/${maxSnaps}</span></h3>
    <button class="btn-sm btn-outline" id="btn-snap-close" title="סגור">✕</button>
  </div>`;

  // ── Save-as form / rename form ──
  if (_snapshotFormMode === 'save-as') {
    html += `<div class="snapshot-inline-form" id="snap-form">
      <div class="snapshot-form-row">
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" placeholder="לדוגמה: טיוטה 1" autofocus /></label>
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
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" value="${active?.name || ''}" /></label>
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
      <span class="text-muted">אין תמונות מצב שמורות. צור שבצ"ק ושמור תמונת מצב.</span>
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
    disabledSoftWarnings: snapshot.algorithmSettings.disabledSoftWarnings,
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
    store.getDisabledSWSet(),
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
    return '<div class="alert alert-ok">✓ אין הפרות אילוצים בכל 7 הימים.</div>';
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
      for (const v of today) html += `<li><code>${v.code}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    if (other.length > 0) {
      html += `<div class="violation-section violation-other"><em>ימים אחרים:</em><ul>`;
      for (const v of other) html += `<li><code>${v.code}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    html += '</div>';
  }
  if (warn.length > 0) {
    html += `<div class="alert alert-warn"><strong>אזהרות (${warn.length})</strong><ul>`;
    for (const w of warn) html += `<li><code>${w.code}</code> ${w.message}</li>`;
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
      html += `<tr class="row-warning"><td><strong>${task.name}</strong> ${crossDayTag}</td><td>${taskTypeBadge(task.type)}</td>
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
        html += `<td rowspan="${taskAssignments.length}" class="task-cell task-tooltip-hover${taskIsFrozen ? ' task-cell-frozen' : ''}" data-task-id="${task.id}" style="border-inline-start:4px solid ${TASK_COLORS[task.type] || '#999'}">
          <strong>${task.name}</strong>${task.isLight ? ' <small>(קלה)</small>' : ''} ${crossDayTag}
          ${taskIsFrozen ? '<span class="frozen-label">🧊 מוקפא</span>' : ''}</td>
          <td rowspan="${taskAssignments.length}">${taskTypeBadge(task.type)}</td>
          <td rowspan="${taskAssignments.length}">${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</td>`;
      }
      html += `<td><small>${slot?.label || a.slotId}</small></td>
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
let OPTIM_ATTEMPTS = 2000;

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
      <div class="optim-spinner"></div>
      <h3>מעריך ${totalAttempts} תרחישים לשיוויוניות מרבית…</h3>
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
  let overlay = document.querySelector('.optim-overlay') as HTMLElement | null;
  const html = renderOptimOverlay();

  if (!html) {
    // Remove overlay if present
    overlay?.remove();
    return;
  }

  if (overlay) {
    // Update in place
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    overlay.replaceWith(tmp.firstElementChild!);
  } else {
    // Insert overlay into tab-content
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
    store.getDisabledSWSet(),
  );
  engine.addParticipants(participants);
  engine.addTasks(tasks);

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

function handleSwap(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!assignment) return;
  if (assignment.status === AssignmentStatus.Frozen) {
    alert('🧊 שיבוץ זה מוקפא (בעבר). לא ניתן לשנותו.');
    return;
  }
  const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
  if (!task) return;
  const currentP = currentSchedule.participants.find(p => p.id === assignment.participantId);

  const options = currentSchedule.participants
    .filter(p => p.id !== assignment.participantId)
    .map(p => `${p.name} (L${p.level}, ${p.group})`)
    .join('\n');

  const choice = prompt(
    `החלפה ב-"${task.name}".\nנוכחי: ${currentP?.name}\n\nהזן שם משתתף:\n\n${options}`
  );
  if (!choice) return;

  const newP = currentSchedule.participants.find(
    p => choice.includes(p.name) || choice === p.id
  );
  if (!newP) { alert('המשתתף לא נמצא.'); return; }

  const result = engine.swapParticipant({ assignmentId, newParticipantId: newP.id });
  currentSchedule = engine.getSchedule();

  if (!result.valid) {
    const msgs = result.violations.map(v => `[${v.code}] ${v.message}`).join('\n');
    alert(`⚠ ההחלפה יצרה הפרות בשבצ"ק של 7 ימים:\n\n${msgs}`);
  }

  // Full re-validation + refresh
  revalidateAndRefresh();
}

function handleLock(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const a = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!a) return;

  if (a.status === AssignmentStatus.Frozen) {
    alert('🧊 שיבוץ זה מוקפא (בעבר). לא ניתן לשנותו.');
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
  _rescueResult = generateRescuePlans(currentSchedule, request, liveMode.currentTimestamp, _rescuePage);
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
        <strong>${task?.name || '???'}</strong></p>
      </div>
      <div class="rescue-plans">`;

  if (plans.length === 0) {
    html += `<div class="rescue-empty">לא נמצאו תוכניות החלפה מתאימות.</div>`;
  }

  for (const plan of plans) {
    html += `<div class="rescue-plan" data-plan-id="${plan.id}">
      <div class="rescue-plan-header">
        <span class="rescue-rank">#${plan.rank}</span>
        <span class="rescue-score">השפעה: ${plan.impactScore.toFixed(2)}</span>
        <span class="rescue-swaps">${plan.swaps.length} החלפות</span>
      </div>
      <div class="rescue-plan-details">
        <div class="rescue-metrics">
          <span>Δ יומי: ${plan.dailyLoadDelta >= 0 ? '+' : ''}${plan.dailyLoadDelta.toFixed(2)}</span>
          <span>Δ שבועי: ${plan.weeklyLoadDelta >= 0 ? '+' : ''}${plan.weeklyLoadDelta.toFixed(2)}</span>
        </div>
        <table class="rescue-swap-table">
          <thead><tr><th>שלב</th><th>שובץ</th><th>מחליף</th><th>משימה / משבצת</th></tr></thead>
          <tbody>`;

    for (let i = 0; i < plan.swaps.length; i++) {
      const sw = plan.swaps[i];
      const swP = pMap.get(sw.toParticipantId);
      const fromP = pMap.get(sw.fromParticipantId || '');
      const assignedSpan = `<span class="rescue-participant-hover" data-pid="${sw.toParticipantId}" data-plan-id="${plan.id}"><strong>${swP?.name || '???'}</strong></span>`;
      const replacingSpan = fromP
        ? `<span class="rescue-participant-hover" data-pid="${sw.fromParticipantId}" data-plan-id="${plan.id}">${fromP.name}</span>`
        : '(פנויה)';
      html += `<tr>
        <td>${i + 1}</td>
        <td>${assignedSpan}</td>
        <td>${replacingSpan}</td>
        <td>${sw.taskName} — ${sw.slotLabel}</td>
      </tr>`;
    }

    html += `</tbody></table>
      </div>`;

    // Show violation warnings if the plan has hard-constraint violations
    if (plan.violations && plan.violations.length > 0) {
      html += `<div class="rescue-violations-warning">
        <span class="rescue-violations-icon">⚠️</span>
        <span>${plan.violations.length} הפרות אילוצים</span>
        <details class="rescue-violations-details">
          <summary>הצג פרטים</summary>
          <ul>`;
      for (const v of plan.violations) {
        html += `<li><code>${v.code}</code> — ${v.message}</li>`;
      }
      html += `</ul>
        </details>
      </div>`;
    }

    html += `<button class="btn-apply-plan${plan.violations && plan.violations.length > 0 ? ' btn-apply-plan--warn' : ''}" data-plan-id="${plan.id}">${plan.violations && plan.violations.length > 0 ? '⚠️ החל תוכנית (יש הפרות)' : '✅ החל תוכנית'}</button>
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
): Array<{ taskName: string; start: Date; end: Date }> {
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

  // Resolve to task objects with time info
  const tasks: Array<{ taskName: string; start: Date; end: Date }> = [];
  for (const [, taskId] of myAssignmentTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    tasks.push({
      taskName: task.name,
      start: task.timeBlock.start,
      end: task.timeBlock.end,
    });
  }

  // Sort by start time ascending
  tasks.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Find the anchor: the earliest swap task's start time
  let anchorTime = Infinity;
  for (const sw of plan.swaps) {
    const task = taskMap.get(sw.taskId);
    if (task) {
      const t = task.timeBlock.start.getTime();
      if (t < anchorTime) anchorTime = t;
    }
  }
  if (anchorTime === Infinity) anchorTime = 0;

  // Filter to tasks starting from the anchor onward and return first 3
  return tasks.filter(t => t.start.getTime() >= anchorTime).slice(0, 3);
}

/** Build HTML content for the rescue participant hover tooltip. */
function buildRescueParticipantTooltip(
  participantName: string,
  nextTasks: Array<{ taskName: string; start: Date; end: Date }>,
): string {
  let html = `<div class="rescue-hover-tt-header">${participantName} — משימות הבאות אם יוחל</div>`;
  if (nextTasks.length === 0) {
    html += `<div class="rescue-hover-tt-empty">אין משימות קרובות</div>`;
  } else {
    for (let i = 0; i < nextTasks.length; i++) {
      const t = nextTasks[i];
      const dayStr = t.start.toLocaleDateString('he-IL', { weekday: 'short', day: '2-digit', month: 'short' });
      const timeStr = fmt(t.start) + ' – ' + fmt(t.end);
      html += `<div class="rescue-hover-tt-task">${i + 1}. ${t.taskName}<span class="rescue-hover-tt-time">${dayStr} ${timeStr}</span></div>`;
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

  // Show More — request all plans up to the next page boundary in one shot
  // to avoid duplicates from re-generation (engine is stateless).
  backdrop.querySelector('#btn-rescue-more')?.addEventListener('click', () => {
    if (!currentSchedule || !_rescueResult) return;
    _rescuePage++;
    const liveMode = store.getLiveModeState();
    const wantTotal = (_rescuePage + 1) * 3; // PAGE_SIZE = 3
    const result = generateRescuePlans(currentSchedule, _rescueResult.request, liveMode.currentTimestamp, 0, wantTotal);
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

    const nextTasks = computePostSwapTasks(pid, plan, currentSchedule);
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

function applyRescuePlan(plan: RescuePlan): void {
  if (!currentSchedule || !engine) return;

  // Snapshot the schedule before applying any swaps for atomic rollback.
  // Deep-clone assignments (the mutable parts) so we can restore on failure.
  // NOTE: This snapshot relies on swapParticipant only mutating assignment fields
  // that are captured by the spread clone (participantId, status, updatedAt).
  // If swapParticipant ever mutates preFreezeStatus, tasks, or nested objects,
  // this snapshot must be updated accordingly.
  const snapshotAssignments = currentSchedule.assignments.map(a => ({
    ...a,
    updatedAt: new Date(a.updatedAt.getTime()),
  }));
  const snapshotFeasible = currentSchedule.feasible;
  const snapshotViolations = [...currentSchedule.violations];
  const snapshotScore = { ...currentSchedule.score };

  // Each swap has the exact assignment ID to change and the new participant
  let failed = false;
  for (const sw of plan.swaps) {
    const result = engine.swapParticipant({ assignmentId: sw.assignmentId, newParticipantId: sw.toParticipantId });
    const updated = engine.getSchedule();
    if (!updated) {
      console.error('[Rescue] Engine returned null schedule after swap', sw);
      failed = true;
      break;
    }
    currentSchedule = updated;
    if (!result.valid) {
      console.warn('[Rescue] Swap created violations:', result.violations);
      failed = true;
      break;
    }
  }

  if (failed) {
    // Rollback: restore the snapshot
    if (currentSchedule) {
      currentSchedule.assignments = snapshotAssignments;
      currentSchedule.feasible = snapshotFeasible;
      currentSchedule.violations = snapshotViolations;
      currentSchedule.score = snapshotScore;
      engine.importSchedule(currentSchedule);
    }
    alert('תוכנית ההחלפה לא יושמה בהצלחה — בוצע שחזור למצב הקודם.');
    closeRescueModal();
    revalidateAndRefresh();
    return;
  }

  closeRescueModal();
  revalidateAndRefresh();
}

function closeRescueModal(): void {
  document.getElementById('rescue-modal-backdrop')?.remove();
  _rescueResult = null;
  _rescueAssignmentId = null;
  _rescuePage = 0;
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

function renderAll(): void {
  const app = document.getElementById('app')!;

  // Always hide tooltips on re-render to avoid stale state
  hideTooltip();
  hideTaskTooltip();

  // ── Profile View: completely different layout, no re-optimization ──
  if (_viewMode === 'PROFILE_VIEW' && _profileParticipantId && currentSchedule) {

    const p = currentSchedule.participants.find(pp => pp.id === _profileParticipantId);
    if (!p) { _viewMode = 'SCHEDULE_VIEW'; _profileParticipantId = null; /* fall through */ }
    else {
      const ctx: ProfileContext = {
        participant: p,
        schedule: currentSchedule,
      };

      app.innerHTML = `<div class="profile-view-root">${renderProfileView(ctx)}</div>`;
      const root = app.querySelector('.profile-view-root') as HTMLElement;
      wireProfileEvents(root, () => {
        // Back to schedule: restore scroll position
        _viewMode = 'SCHEDULE_VIEW';
        _profileParticipantId = null;
        renderAll();
        requestAnimationFrame(() => window.scrollTo(0, _scheduleScrollY));
      });
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
      <h1>⏱ מערכת שיבוץ חכמה <span class="beta-badge">beta</span></h1>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${!store.getUndoRedoState().canUndo ? 'disabled' : ''}
          title="ביטול (Ctrl+Z)">↪ ביטול${store.getUndoRedoState().undoDepth ? ' (' + store.getUndoRedoState().undoDepth + ')' : ''}</button>
        <button class="btn-sm btn-outline" id="btn-redo" ${!store.getUndoRedoState().canRedo ? 'disabled' : ''}
          title="שחזור (Ctrl+Y)">↩ שחזור${store.getUndoRedoState().redoDepth ? ' (' + store.getUndoRedoState().redoDepth + ')' : ''}</button>
      </div>
      <button class="theme-toggle" id="btn-theme-toggle" title="החלף מצב בהיר/כהה">
        ${document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️'}
      </button>
    </div>
    <p class="subtitle">
      <span id="live-clock">${formatLiveClock()}</span>
      · שבצ"ק ל-${store.getScheduleDays()} ימים
      · ${participants.length} משתתפים
      · ${templates.length} תבניות משימות
    </p>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn ${currentTab === 'participants' ? 'tab-active' : ''}" data-tab="participants">
      👥 משתתפים <span class="count">${participants.length}</span>
    </button>
    <button class="tab-btn ${currentTab === 'task-rules' ? 'tab-active' : ''}" data-tab="task-rules">
      📋 פירוט משימות <span class="count">${templates.length}</span>
      ${!preflight.canGenerate ? '<span class="badge badge-sm" style="background:var(--danger);margin-inline-start:4px">!</span>' : ''}
    </button>
    <button class="tab-btn ${currentTab === 'schedule' ? 'tab-active' : ''}" data-tab="schedule">
      📊 תצוגת שבצ"ק
      ${currentSchedule ? '<span class="badge badge-sm" style="background:var(--success);margin-inline-start:4px">✓</span>' : ''}
    </button>
    <button class="tab-btn ${currentTab === 'algorithm' ? 'tab-active' : ''}" data-tab="algorithm">
      ⚙️ אלגוריתם
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
  app.innerHTML = html;

  // Wire events
  wireTabNav(app);
  wireUndoRedo(app);
  wireThemeToggle(app);

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
}

function wireTabNav(container: HTMLElement): void {
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as typeof currentTab;
      if (tab && tab !== currentTab) {
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
  applyTheme(next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  renderAll();
}

function wireThemeToggle(container: HTMLElement): void {
  const btn = container.querySelector('#btn-theme-toggle');
  if (btn) btn.addEventListener('click', toggleTheme);
}

// ─── Snapshot Event Wiring ───────────────────────────────────────────────────

function wireSnapshotEvents(container: HTMLElement): void {
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
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-snap-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.snapAction;
    const snapId = btn.dataset.snapId;
    if (!action || !snapId) return;

    switch (action) {
      case 'load': {
        if (_snapshotDirty && currentSchedule) {
          if (!confirm('השבצ"ק הנוכחי שונה. לטעון תמונת מצב ולאבד שינויים?')) return;
        }
        loadScheduleSnapshot(snapId);
        break;
      }
      case 'update': {
        if (!currentSchedule) return;
        const algoSettings = store.getAlgorithmSettings();
        const ok = store.updateSnapshot(snapId, currentSchedule, algoSettings);
        if (ok) {
          _snapshotDirty = false;
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
          renderAll();
        } else {
          alert(`לא ניתן לשכפל — מגבלת ${store.getMaxSnapshots()} תמונות מצב.`);
        }
        break;
      }
      case 'delete': {
        const snap = store.getSnapshotById(snapId);
        if (snap && confirm(`למחוק את תמונת המצב "${snap.name}"?`)) {
          store.deleteSnapshot(snapId);
          _snapshotFormMode = 'none';
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

  // ── Participant Tooltip (event delegation) ──
  wireParticipantTooltip(container);

  // ── Task Tooltip (event delegation) ──
  wireTaskTooltip(container);

  // ── Participant click → Profile View ──
  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
    if (!target) return;
    const pid = target.dataset.pid;
    if (pid) navigateToProfile(pid);
  });

  // ── Senior toggle button ──
  const seniorToggle = container.querySelector('#btn-senior-toggle');
  if (seniorToggle) {
    seniorToggle.addEventListener('click', () => {
      const panel = document.getElementById('sidebar-senior-panel');
      const arrow = document.getElementById('senior-toggle-arrow');
      if (panel) {
        const visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : 'block';
        if (arrow) arrow.textContent = visible ? '▶' : '▼';
      }
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
    });
  }

  // ── Live Mode day/hour pickers ──
  const liveDay = container.querySelector('#sel-live-day') as HTMLSelectElement | null;
  const liveHour = container.querySelector('#sel-live-hour') as HTMLSelectElement | null;
  const updateLiveTimestamp = () => {
    if (!liveDay || !liveHour) return;
    const dayIdx = parseInt(liveDay.value, 10);
    const hour = parseInt(liveHour.value, 10);
    const base = store.getScheduleDate();
    const ts = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIdx - 1, hour, 0);
    store.setLiveModeTimestamp(ts);
    if (currentSchedule && store.getLiveModeState().enabled) {
      freezeAssignments(currentSchedule, ts);
    }
    renderAll();
  };
  if (liveDay) liveDay.addEventListener('change', updateLiveTimestamp);
  if (liveHour) liveHour.addEventListener('change', updateLiveTimestamp);

  // ── Reset storage button ──
  const resetBtn = container.querySelector('#btn-reset-storage');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('למחוק את כל הנתונים השמורים ולטעון מחדש? לא ניתן לבטל פעולה זו.')) {
        store.clearStorage();
        location.reload();
      }
    });
  }

  // ── Export PDF button ──
  const exportBtn = container.querySelector('#btn-export-pdf');
  if (exportBtn) exportBtn.addEventListener('click', openExportModal);
}

// ─── Export PDF Modal ────────────────────────────────────────────────────────

function openExportModal(): void {
  if (!currentSchedule) return;

  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();

  // Build day options for the daily picker
  let dayOptions = '';
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayName = date.toLocaleDateString('he-IL', { weekday: 'short' });
    const dayNum = date.getDate();
    const monthName = date.toLocaleDateString('he-IL', { month: 'short' });
    const selected = d === currentDay ? 'selected' : '';
    dayOptions += `<option value="${d}" ${selected}>יום ${d} — ${dayName} ${dayNum} ${monthName}</option>`;
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
                <div class="export-mode-label">סיכום שבועי</div>
                <div class="export-mode-desc">טבלת סיכום מרוכזת של כל השבוע — משתתפים × ימים</div>
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
          <div class="export-day-picker" id="export-day-picker" style="display:none">
            <label>בחר יום:</label>
            <select id="export-day-select">${dayOptions}</select>
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

  const closeModal = () => backdrop.remove();

  // Close buttons
  backdrop.querySelector('#export-close')?.addEventListener('click', closeModal);
  backdrop.querySelector('#export-cancel')?.addEventListener('click', closeModal);

  // Click outside modal closes
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  // Escape key closes
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEscape); }
  };
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
      dayPicker.style.display = mode === 'daily' ? 'flex' : 'none';
    });
  });

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
        const daySelect = backdrop.querySelector('#export-day-select') as HTMLSelectElement;
        const dayIdx = parseInt(daySelect.value, 10);
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
  let bd = { heavyHours: 0, heavyCount: 0, effectiveHeavyHours: 0, hotHours: 0, coldHours: 0, lightHours: 0, lightCount: 0, typeHours: {} as Record<string,number>, typeEffectiveHours: {} as Record<string,number>, typeCounts: {} as Record<string,number> };
  if (currentSchedule) {
    const taskMap = new Map<string, Task>();
    for (const t of currentSchedule.tasks) taskMap.set(t.id, t);
    const myItems = currentSchedule.assignments
      .filter(a => a.participantId === p.id)
      .map(a => ({ task: taskMap.get(a.taskId)! }))
      .filter(x => x.task);
    bd = computeTaskBreakdown(myItems);
  }
  const { heavyHours, effectiveHeavyHours, heavyCount, lightCount, typeHours, typeEffectiveHours, typeCounts } = bd;

  // R7: Use effectiveHeavyHours for workload %, consistent with sidebar & profile
  const pctOfPeriod = totalPeriodHours > 0 ? (effectiveHeavyHours / totalPeriodHours) * 100 : 0;

  const certsHtml = p.certifications.length > 0
    ? p.certifications.map((c: Certification) => {
        return `<span class="tt-cert" style="background:${CERT_COLORS[c] || '#7f8c8d'}">${CERT_LABELS[c] || c}</span>`;
      }).join(' ')
    : '<span class="tt-dim">אין</span>';

  // Build per-task breakdown rows (only show types with hours > 0)
  const taskTypeColors: Record<string, string> = {
    Adanit: '#e67e22', Hamama: '#c0392b', Shemesh: '#2ecc71',
    Mamtera: '#9b59b6', Karov: '#3498db', Karovit: '#7f8c8d', Aruga: '#e74c3c',
  };
  const breakdownRows = Object.values(TaskType)
    .filter(tt => typeCounts[tt] > 0)
    .map(tt => {
      const color = taskTypeColors[tt] || '#7f8c8d';
      return `<div class="tt-row">
        <span class="tt-label"><span style="color:${color};font-weight:600">${TASK_TYPE_LABELS[tt] || tt}</span></span>
        <span class="tt-value">${typeCounts[tt]}× · ${typeEffectiveHours[tt].toFixed(1)} שע' אפק'</span>
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
    actionsHtml = '<span class="tt-actions"><span class="tt-dim">❄️</span></span>';
  }

  return `
    <div class="tt-header">
      <span class="tt-name">${p.name}</span>
      ${actionsHtml}
      <span class="tt-level" style="background:${LEVEL_COLORS[p.level]}">L${p.level}</span>
    </div>
    <div class="tt-row"><span class="tt-label">קבוצה</span><span class="tt-value" style="color:${groupColor(p.group)}">${p.group}</span></div>
    <div class="tt-row"><span class="tt-label">הסמכות</span><span class="tt-value">${certsHtml}</span></div>
    <div class="tt-divider"></div>
    ${breakdownRows}
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">משימות כבדות</span><span class="tt-value">${heavyCount}</span></div>
    <div class="tt-row"><span class="tt-label">משימות קלות</span><span class="tt-value">${lightCount}</span></div>
    <div class="tt-row"><span class="tt-label">שעות שבועיות</span><span class="tt-value tt-bold">${effectiveHeavyHours.toFixed(1)} שע' אפק'</span></div>
    <div class="tt-row"><span class="tt-label">% עומס</span><span class="tt-value">${pctOfPeriod.toFixed(1)}% מתוך ${totalPeriodHours} שע'</span></div>
  `;
}

/** Wire event-delegated tooltip for .participant-hover elements. */
function wireParticipantTooltip(container: HTMLElement): void {
  if (!currentSchedule) return;

  const pMap = new Map<string, Participant>();
  for (const p of currentSchedule.participants) pMap.set(p.id, p);

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

  const taskColor = TASK_COLORS[task.type] || '#7f8c8d';
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
          ${slot ? `<span class="ttt-slot">${slot.label}</span>` : ''}
          ${certsHtml}
        </div>
      </div>`;
    }
    teammatesHtml += '</div>';
  }

  return `
    <div class="ttt-header">
      <span class="ttt-task-name" style="border-inline-start:3px solid ${taskColor};padding-inline-start:8px">${task.name}</span>
      <span class="badge badge-sm" style="background:${taskColor}">${TASK_TYPE_LABELS[task.type] || task.type}</span>
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

  // Refresh participant metadata from the store (Bug #10 fix)
  const currentParticipants = store.getAllParticipants();
  const storeIds = new Set(currentParticipants.map(p => p.id));
  const storeMap = new Map(currentParticipants.map(p => [p.id, p]));

  // Strip assignments for participants that no longer exist
  const before = currentSchedule.assignments.length;
  const cleanedAssignments = currentSchedule.assignments.filter(
    a => storeIds.has(a.participantId),
  );

  // Rebuild participants from current store state so levels/certs/groups
  // stay in sync (Bug #10 fix). Only include participants that still exist.
  const refreshedParticipants = currentSchedule.participants
    .filter(p => storeIds.has(p.id))
    .map(p => storeMap.get(p.id)!);

  const changed = cleanedAssignments.length !== before
    || refreshedParticipants.some((sp, i) => sp !== currentSchedule!.participants[i]);

  if (changed) {
    currentSchedule = {
      ...currentSchedule,
      assignments: cleanedAssignments,
      participants: refreshedParticipants,
    };

    // Revalidate violations/score after reconciliation (Bug #11 fix)
    if (engine) {
      engine.importSchedule(currentSchedule);
      engine.addParticipants(refreshedParticipants);
      engine.revalidateFull();
      currentSchedule = engine.getSchedule()!;
    }
  }
}

function init(): void {
  // Apply saved theme before first render to prevent flash
  applyTheme(getStoredTheme());

  store.initStore();
  store.subscribe(onStoreChanged);

  // Restore saved schedule from localStorage
  const savedSchedule = store.loadSchedule();
  if (savedSchedule) {
    const algoInit = store.getAlgorithmSettings();
    engine = new SchedulingEngine(
      algoInit.config,
      store.getDisabledHCSet(),
      store.getDisabledSWSet(),
    );

    // Bug #10 fix: use current store participants instead of stale
    // schedule snapshot — levels/certs/groups may have changed.
    const currentParticipants = store.getAllParticipants();
    const storeIds = new Set(currentParticipants.map(p => p.id));

    // Prune assignments/tasks for deleted participants
    const reconciledAssignments = savedSchedule.assignments.filter(
      a => storeIds.has(a.participantId),
    );
    const reconciledParticipants = currentParticipants.filter(
      p => savedSchedule.participants.some(sp => sp.id === p.id),
    );

    const reconciledSchedule: Schedule = {
      ...savedSchedule,
      participants: reconciledParticipants,
      assignments: reconciledAssignments,
    };

    engine.addParticipants(reconciledParticipants);
    engine.addTasks(savedSchedule.tasks);
    engine.importSchedule(reconciledSchedule);

    // Bug #11 fix: revalidate so violations/score reflect current state
    engine.revalidateFull();
    currentSchedule = engine.getSchedule()!;
    currentDay = 1;

    // Re-apply freeze if live mode was active
    const liveMode = store.getLiveModeState();
    if (liveMode.enabled) {
      freezeAssignments(currentSchedule, liveMode.currentTimestamp);
    }
  }

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

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      doUndoRedo('undo');
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      doUndoRedo('redo');
    }
    // Arrow keys for day navigation when in schedule tab
    if (currentTab === 'schedule' && currentSchedule) {
      if (e.key === 'ArrowLeft' && currentDay < store.getScheduleDays()) {
        currentDay++;
        renderAll();
      } else if (e.key === 'ArrowRight' && currentDay > 1) {
        currentDay--;
        renderAll();
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
