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
} from '../index';
import { scheduleToGantt } from '../ui/gantt-bridge';
import { computeAllRestProfiles, computeRestFairness } from './utils/rest-calculator';
import { generateShiftBlocks } from './utils/time-utils';
import { computeWeeklyWorkloads } from './workload-utils';

import * as store from './config-store';
import { runPreflight } from './preflight';
import { renderParticipantsTab, wireParticipantsEvents } from './tab-participants';
import { renderTaskRulesTab, wireTaskRulesEvents } from './tab-task-rules';
import { renderProfileView, wireProfileEvents, ProfileContext } from './tab-profile';
import { computeTaskBreakdown } from './workload-utils';

// ─── Globals ─────────────────────────────────────────────────────────────────

let currentTab: 'participants' | 'task-rules' | 'schedule' = 'participants';
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

// ─── Color Map ───────────────────────────────────────────────────────────────

const TASK_COLORS: Record<string, string> = {
  Adanit: '#4A90D9', Hamama: '#E74C3C', Shemesh: '#F39C12',
  Mamtera: '#27AE60', Karov: '#8E44AD', Karovit: '#BDC3C7', Aruga: '#1ABC9C',
};

const GROUP_COLORS: Record<string, string> = {
  'Dept A': '#3498db', 'Dept B': '#e67e22', 'Dept C': '#2ecc71', 'Dept D': '#e74c9b',
};

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function fmt(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + fmt(d);
}

function fmtDayShort(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function levelBadge(level: Level): string {
  const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
  return `<span class="badge" style="background:${colors[level]}">L${level}</span>`;
}

function certBadges(certs: Certification[]): string {
  if (certs.length === 0) return '<span class="text-muted">—</span>';
  return certs.map(c => {
    const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
    return `<span class="badge" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`;
  }).join(' ');
}

function groupBadge(group: string): string {
  const color = GROUP_COLORS[group] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${group}</span>`;
}

function statusBadge(status: AssignmentStatus): string {
  const colors: Record<string, string> = {
    Scheduled: '#27ae60', Locked: '#2980b9', Manual: '#f39c12', Conflict: '#e74c3c'
  };
  return `<span class="badge badge-sm" style="background:${colors[status] || '#7f8c8d'}">${status}</span>`;
}

function taskTypeBadge(type: TaskType): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${type}</span>`;
}

// ─── Day Window Helpers ──────────────────────────────────────────────────────

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
        const eveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0);
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
          const adanitTeam = st.name.toLowerCase().includes('main')
            ? AdanitTeam.SegolMain
            : st.name.toLowerCase().includes('secondary')
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

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` Shift ${si + 1}` : '';
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
 * Compute per-day hours for a participant.
 * Returns a Map<dayIndex, hours> for days 1..numDays.
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

  let html = `<div class="day-navigator">`;

  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayName = date.toLocaleDateString('en-GB', { weekday: 'short' });
    const dayNum = date.getDate();

    // Count tasks and assignments for this day
    let taskCount = 0;
    let violationCount = 0;
    if (currentSchedule) {
      taskCount = currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).length;
      // Count violations for tasks on this day
      const dayTaskIds = new Set(currentSchedule.tasks.filter(t => taskIntersectsDay(t, d)).map(t => t.id));
      violationCount = currentSchedule.violations.filter(v =>
        v.severity === ViolationSeverity.Error && v.taskId && dayTaskIds.has(v.taskId)
      ).length;
    }

    const violationDot = violationCount > 0
      ? `<span class="day-violation-dot" title="${violationCount} violation(s)">!</span>`
      : '';

    html += `<button class="day-tab ${currentDay === d ? 'day-tab-active' : ''}" data-day="${d}">
      <span class="day-tab-name">${dayName}</span>
      <span class="day-tab-num">${dayNum}</span>
      <span class="day-tab-label">Day ${d}</span>
      ${taskCount > 0 ? `<span class="day-tab-count">${taskCount} tasks</span>` : ''}
      ${violationDot}
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
  const totalViolations = schedule.violations.filter(v => v.severity === ViolationSeverity.Error).length;
  const warnings = schedule.violations.filter(v => v.severity === ViolationSeverity.Warning).length;
  const feasibleClass = schedule.feasible ? 'kpi-ok' : 'kpi-error';
  const feasibleText = schedule.feasible ? '✓ Feasible' : '✗ Infeasible';

  // Per-day task counts
  let dayDots = '';
  for (let d = 1; d <= numDays; d++) {
    const count = schedule.tasks.filter(t => taskIntersectsDay(t, d)).length;
    const dayViolations = schedule.violations.filter(v => {
      if (v.severity !== ViolationSeverity.Error || !v.taskId) return false;
      const task = schedule.tasks.find(t => t.id === v.taskId);
      return task ? taskIntersectsDay(task, d) : false;
    }).length;
    const dotClass = dayViolations > 0 ? 'dot-error' : count > 0 ? 'dot-ok' : 'dot-empty';
    dayDots += `<span class="week-dot ${dotClass}" title="Day ${d}: ${count} tasks, ${dayViolations} violations"></span>`;
  }

  return `<div class="weekly-dashboard">
    <div class="dashboard-row">
      <div class="kpi-group">
        <div class="kpi ${feasibleClass}">
          <span class="kpi-value">${feasibleText}</span>
          <span class="kpi-label">${numDays}-Day Status</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${score.compositeScore.toFixed(1)}</span>
          <span class="kpi-label">Weekly Score</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${score.restStdDev.toFixed(2)}</span>
          <span class="kpi-label">Fairness (σ)</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${score.minRestHours.toFixed(1)}h</span>
          <span class="kpi-label">Min Rest</span>
        </div>
        <div class="kpi ${totalViolations > 0 ? 'kpi-error' : 'kpi-ok'}">
          <span class="kpi-value">${totalViolations}</span>
          <span class="kpi-label">Violations</span>
        </div>
        <div class="kpi">
          <span class="kpi-value">${warnings}</span>
          <span class="kpi-label">Warnings</span>
        </div>
      </div>
      <div class="week-dots-strip">
        <span class="week-dots-label">Days</span>
        <div class="week-dots">${dayDots}</div>
      </div>
    </div>
    <div class="dashboard-meta">
      Best of ${OPTIM_ATTEMPTS} attempts in ${scheduleElapsed}ms · ${schedule.participants.length} participants ·
      ${schedule.tasks.length} tasks · ${schedule.assignments.length} assignments
    </div>
  </div>`;
}

// ─── Participant Status Sidebar ──────────────────────────────────────────────

/**
 * Render the participant sidebar with:
 * - Cumulative 7-day workload bar (the "orange line")
 * - Per-day contribution tooltip
 * - Day-by-day workload visibility
 */
function renderParticipantSidebar(schedule: Schedule): string {
  const workloads = computeWeeklyWorkloads(schedule.participants, schedule.assignments, schedule.tasks);
  const numDays = store.getScheduleDays();
  const totalPeriodHours = numDays * 24; // e.g. 168h for 7 days

  // Average
  let totalHours = 0;
  let count = 0;
  for (const w of workloads.values()) {
    totalHours += w.effectiveHours;
    count++;
  }
  const avgHours = count > 0 ? totalHours / count : 0;

  // Build task lookup once for all participants
  const sidebarTaskMap = new Map<string, Task>(schedule.tasks.map(t => [t.id, t]));

  // Build participant entries
  const entries = schedule.participants.map(p => {
    const w = workloads.get(p.id) || { totalHours: 0, effectiveHours: 0, hotHours: 0, coldHours: 0, nonLightCount: 0 };
    // Percentage = effective heavy load / total period hours
    const pctOfPeriod = totalPeriodHours > 0 ? (w.effectiveHours / totalPeriodHours) * 100 : 0;
    const perDay = computePerDayHours(p.id, schedule, sidebarTaskMap);

    return { p, w, pctOfPeriod, perDay };
  }).sort((a, b) => b.w.effectiveHours - a.w.effectiveHours);

  // Render
  let html = `<div class="participant-sidebar">
    <div class="sidebar-header">
      <h3>Participant Status</h3>
      <div class="sidebar-avg">Avg Effective: ${avgHours.toFixed(1)}h · ${numDays}d (${totalPeriodHours}h)</div>
    </div>
    <div class="sidebar-entries">`;

  for (const entry of entries) {
    const p = entry.p;
    // Bar fill: workload-based (pctOfPeriod scaled so ~30% of period = full bar)
    const barPct = Math.min(entry.pctOfPeriod * (100 / 30), 100); // 30%+ of period = full bar
    const barWidth = barPct;
    const overloaded = entry.pctOfPeriod > 25;                    // >25% of period → red
    const underloaded = entry.pctOfPeriod < 5;                    // <5% of period → dim
    const barClass = overloaded ? 'wbar-over' : underloaded ? 'wbar-under' : 'wbar-normal';

    // Per-day breakdown tooltip
    let tooltipParts: string[] = [];
    for (let d = 1; d <= store.getScheduleDays(); d++) {
      const dayHrs = entry.perDay.get(d) || 0;
      tooltipParts.push(`D${d}: ${dayHrs.toFixed(1)}h`);
    }
    // Highlight current day's contribution
    const todayHrs = entry.perDay.get(currentDay) || 0;

    // Today portion on the bar
    const todayRatio = totalPeriodHours > 0 ? todayHrs / totalPeriodHours : 0;
    const todayBarWidth = Math.min(todayRatio * 100 * (100 / 30), barWidth);

    // Diagnostic tooltip: raw math breakdown
    const diagTooltip = `${entry.w.effectiveHours.toFixed(1)}h effective / ${totalPeriodHours}h period = ${entry.pctOfPeriod.toFixed(1)}%\n` +
      `Hot: ${entry.w.hotHours.toFixed(1)}h · Cold: ${entry.w.coldHours.toFixed(1)}h · Raw: ${entry.w.totalHours.toFixed(1)}h\n` +
      `Assignments: ${entry.w.nonLightCount} heavy tasks\n` +
      tooltipParts.join(' | ');

    html += `<div class="sidebar-entry">
      <div class="sidebar-name">
        <span class="participant-hover" data-pid="${p.id}">${p.name}</span>
        <span class="sidebar-meta">${groupBadge(p.group)} ${levelBadge(p.level)}</span>
      </div>
      <div class="sidebar-bar-row">
        <div class="sidebar-bar-bg" title="${diagTooltip}">
          <div class="sidebar-bar-fill ${barClass}" style="width:${barWidth}%"></div>
          <div class="sidebar-bar-today" style="width:${todayBarWidth}%"></div>
          <span class="sidebar-bar-label">${entry.w.effectiveHours.toFixed(1)}h eff (${entry.pctOfPeriod.toFixed(1)}%)</span>
        </div>
        <span class="sidebar-today-tag" title="Today (Day ${currentDay}): ${todayHrs.toFixed(1)} raw h">
          Raw D${currentDay}: ${todayHrs.toFixed(1)}h
        </span>
      </div>
    </div>`;
  }

  html += `</div></div>`;
  return html;
}

// ─── Schedule Tab ────────────────────────────────────────────────────────────

function renderScheduleTab(): string {
  const preflight = runPreflight();

  let html = `<div class="tab-toolbar">
    <div class="toolbar-left"><h2>Schedule View</h2>
      <span class="text-muted" style="margin-left:12px">${store.getScheduleDays()}-Day Schedule</span>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary ${_scheduleDirty && currentSchedule ? 'btn-generate-dirty' : ''}" id="btn-generate" ${!preflight.canGenerate || _isOptimizing ? 'disabled' : ''}
        ${!preflight.canGenerate ? 'title="Fix critical issues in Task Rules first"' : ''}>
        ${_isOptimizing ? '⏳ Optimizing…' : currentSchedule ? '🔄 Regenerate' : '⚡ Generate Schedule'}
      </button>
    </div>
  </div>`;

  if (_scheduleDirty && currentSchedule) {
    html += `<div class="dirty-notice">⚠ Schedule out of sync — Re-generate recommended</div>`;
  }

  if (!preflight.canGenerate) {
    const crits = preflight.findings.filter(f => f.severity === 'Critical');
    html += `<div class="alert alert-error">
      <strong>Cannot generate — ${crits.length} critical issue(s):</strong>
      <ul>${crits.map(f => `<li>${f.message}</li>`).join('')}</ul>
      <p>Switch to <strong>Task Rules</strong> to resolve.</p>
    </div>`;
  }

  if (!currentSchedule) {
    if (preflight.canGenerate) {
      html += `<div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No schedule generated yet.</p>
        <p class="text-muted">Configure participants and task rules, then click "Generate Schedule".</p>
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
    Showing <strong>Day ${currentDay}</strong>: ${fmtDayShort(dayStart)} ${fmt(dayStart)} – ${fmtDayShort(dayEnd)} ${fmt(dayEnd)}
  </div>`;

  // Main layout: content + sidebar
  html += `<div class="schedule-layout">`;
  html += `<div class="schedule-main">`;
  html += `<section><h2>Assignments <span class="count">${getFilteredAssignments(s).length}</span></h2>${renderAssignmentsTable(s)}</section>`;
  html += `<section><h2>Gantt Timeline</h2>${renderGanttChart(s)}</section>`;
  html += `<section><h2>Constraint Violations <span class="count">${s.violations.length}</span></h2>${renderViolations(s)}</section>`;
  html += `<section><h2>Rest Fairness</h2>${renderRestTable(s)}</section>`;
  html += `</div>`;
  html += renderParticipantSidebar(s);
  html += `</div>`;

  // Optimization overlay (rendered inside tab so it covers the schedule board)
  html += renderOptimOverlay();

  return html;
}

// ─── Violations ──────────────────────────────────────────────────────────────

function renderViolations(schedule: Schedule): string {
  const hard = schedule.violations.filter(v => v.severity === ViolationSeverity.Error);
  const warn = schedule.violations.filter(v => v.severity === ViolationSeverity.Warning);

  if (hard.length === 0 && warn.length === 0) {
    return '<div class="alert alert-ok">✓ No constraint violations across all 7 days.</div>';
  }

  // Separate into current-day and other-day violations
  const dayTaskIds = new Set(getFilteredTasks(schedule).map(t => t.id));

  let html = '';
  if (hard.length > 0) {
    const today = hard.filter(v => v.taskId && dayTaskIds.has(v.taskId));
    const other = hard.filter(v => !v.taskId || !dayTaskIds.has(v.taskId));

    html += `<div class="alert alert-error"><strong>Hard Violations (${hard.length})</strong>`;
    if (today.length > 0) {
      html += `<div class="violation-section"><em>Day ${currentDay}:</em><ul>`;
      for (const v of today) html += `<li><code>${v.code}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    if (other.length > 0) {
      html += `<div class="violation-section violation-other"><em>Other days:</em><ul>`;
      for (const v of other) html += `<li><code>${v.code}</code> ${v.message}</li>`;
      html += `</ul></div>`;
    }
    html += '</div>';
  }
  if (warn.length > 0) {
    html += `<div class="alert alert-warn"><strong>Warnings (${warn.length})</strong><ul>`;
    for (const w of warn) html += `<li><code>${w.code}</code> ${w.message}</li>`;
    html += '</ul></div>';
  }
  return html;
}

// ─── Assignments Table ───────────────────────────────────────────────────────

function renderAssignmentsTable(schedule: Schedule): string {
  const filteredTasks = getFilteredTasks(schedule);
  const filteredAssignments = getFilteredAssignments(schedule);

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
    <thead><tr><th>Task</th><th>Type</th><th>Time</th><th>Slot</th><th>Participant</th>
    <th>Level</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;

  for (const task of sortedTasks) {
    const taskAssignments = groupedByTask.get(task.id) || [];

    // Cross-day indicators
    const contFromPrev = taskStartsBefore(task, currentDay);
    const contToNext = taskEndsAfter(task, currentDay);
    let crossDayTag = '';
    if (contFromPrev && contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-both" title="Continues from Day ${currentDay - 1} into Day ${currentDay + 1}">◀ ▶</span>`;
    } else if (contFromPrev) {
      crossDayTag = `<span class="cross-day-badge cross-from" title="Continued from Day ${currentDay - 1}">◀ from D${currentDay - 1}</span>`;
    } else if (contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-to" title="Continues into Day ${currentDay + 1}">▶ to D${currentDay + 1}</span>`;
    }

    if (taskAssignments.length === 0) {
      html += `<tr class="row-warning"><td><strong>${task.name}</strong> ${crossDayTag}</td><td>${taskTypeBadge(task.type)}</td>
        <td>${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</td>
        <td colspan="6"><em class="text-danger">⚠ No assignments</em></td></tr>`;
      continue;
    }

    taskAssignments.forEach((a, i) => {
      const p = pMap.get(a.participantId);
      const slot = task.slots.find(s => s.slotId === a.slotId);
      html += `<tr class="${a.status === AssignmentStatus.Conflict ? 'row-error' : ''}" data-assignment-id="${a.id}">`;
      if (i === 0) {
        html += `<td rowspan="${taskAssignments.length}" class="task-cell" style="border-left:4px solid ${TASK_COLORS[task.type] || '#999'}">
          <strong>${task.name}</strong>${task.isLight ? ' <small>(Light)</small>' : ''} ${crossDayTag}</td>
          <td rowspan="${taskAssignments.length}">${taskTypeBadge(task.type)}</td>
          <td rowspan="${taskAssignments.length}">${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</td>`;
      }
      html += `<td><small>${slot?.label || a.slotId}</small></td>
        <td><strong class="participant-hover" data-pid="${p?.id || ''}">${p?.name || '???'}</strong></td>
        <td>${p ? levelBadge(p.level) : '—'}</td>
        <td>${p ? groupBadge(p.group) : '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td>
          <button class="btn-swap" data-assignment-id="${a.id}" data-task-id="${task.id}" title="Swap">⇄</button>
          <button class="btn-lock" data-assignment-id="${a.id}" title="Lock/Unlock">🔒</button>
        </td></tr>`;
    });
  }
  html += '</tbody></table></div>';
  return html;
}

// ─── Rest Fairness Table ─────────────────────────────────────────────────────

function renderRestTable(schedule: Schedule): string {
  const profiles = computeAllRestProfiles(schedule.participants, schedule.assignments, schedule.tasks);
  const fairness = computeRestFairness(profiles);

  let html = `<div class="rest-summary">
    <span><strong>Min Rest:</strong> ${isFinite(fairness.globalMinRest) ? fairness.globalMinRest.toFixed(1) + 'h' : 'N/A'}</span>
    <span><strong>Avg Rest:</strong> ${isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest.toFixed(1) + 'h' : 'N/A'}</span>
    <span><strong>Std Dev:</strong> ${fairness.stdDevRest.toFixed(2)}</span>
  </div>`;

  html += `<div class="table-responsive"><table class="table">
    <thead><tr><th>Participant</th><th>Group</th><th>Level</th><th>Non-Light</th>
    <th>Work Hours</th><th>Min Rest</th><th>Avg Rest</th><th>Gaps</th></tr></thead><tbody>`;

  const sorted = [...profiles.entries()].sort((a, b) => a[1].minRestHours - b[1].minRestHours);
  for (const [pid, profile] of sorted) {
    const p = schedule.participants.find(pp => pp.id === pid);
    if (!p) continue;
    const cls = profile.minRestHours < 4 ? 'text-danger' : profile.minRestHours < 8 ? 'text-warn' : '';
    const minR = isFinite(profile.minRestHours) ? profile.minRestHours.toFixed(1) + 'h' : '—';
    const avgR = isFinite(profile.avgRestHours) ? profile.avgRestHours.toFixed(1) + 'h' : '—';
    const gaps = profile.restGaps.length > 0 ? profile.restGaps.map(g => g.toFixed(1) + 'h').join(', ') : '—';

    html += `<tr><td><strong>${p.name}</strong></td><td>${groupBadge(p.group)}</td>
      <td>${levelBadge(p.level)}</td><td>${profile.nonLightAssignmentCount}</td>
      <td>${profile.totalWorkHours.toFixed(1)}h</td><td class="${cls}"><strong>${minR}</strong></td>
      <td>${avgR}</td><td><small>${gaps}</small></td></tr>`;
  }
  html += '</tbody></table></div>';
  return html;
}

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
  if (totalMs <= 0) return '<p>No timeline data for this day.</p>';

  const totalHours = totalMs / 3600000;
  // Use smaller tick interval for single day view
  const tickInterval = totalHours <= 26 ? 1 : 2;

  let html = `<div class="gantt-container"><div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-timeline-col">`;

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

      const tooltip = `${block.taskName}&#10;${new Date(block.startMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${new Date(block.endMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${crossFrom ? '&#10;◀ Continued from previous day' : ''}${crossTo ? '&#10;▶ Continues to next day' : ''}`;
      html += `<div class="gantt-block ${block.isLight ? 'gantt-light' : ''} ${crossClass}" style="left:${left}%;width:${width}%;background:${block.color}" title="${tooltip}">
        <span class="gantt-block-text">${crossFrom ? '◀ ' : ''}${block.taskName}${crossTo ? ' ▶' : ''}</span></div>`;
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  return html;
}

// ─── Schedule Generation ─────────────────────────────────────────────────────

/** Number of optimization attempts per generation */
const OPTIM_ATTEMPTS = 40;

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
      <h3>Evaluating ${totalAttempts} scenarios for maximum fairness…</h3>
      <div class="optim-progress-bar">
        <div class="optim-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="optim-status">
        Attempt <strong>${attempt}</strong> / ${totalAttempts}
        ${lastImproved ? '<span class="optim-improved">★ Improved!</span>' : ''}
      </div>
      <div class="optim-metrics">
        <div class="optim-metric">
          <span class="optim-metric-label">Best Score</span>
          <span class="optim-metric-value">${bestScore.toFixed(1)}</span>
        </div>
        <div class="optim-metric">
          <span class="optim-metric-label">Unfilled Slots</span>
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

  const participants = store.getAllParticipants();
  const tasks = generateTasksFromTemplates();

  engine = new SchedulingEngine({
    maxIterations: 6000,
    maxSolverTimeMs: 15000,
  });
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
    genBtn.textContent = '⏳ Optimizing…';
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
  } catch (err) {
    // Safety buffer: if all attempts fail, show error without clearing board
    console.error('[Scheduler] All optimization attempts failed:', err);
    const errDiv = document.querySelector('.optim-overlay .optim-card');
    if (errDiv) {
      errDiv.innerHTML = `
        <div class="optim-error">
          <h3>⚠ Optimization Failed</h3>
          <p>Could not find a valid solution within ${OPTIM_ATTEMPTS} attempts.</p>
          <p>Please check your constraints and participant availability.</p>
          <button class="btn-primary" id="btn-dismiss-error">Dismiss</button>
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

  // Full 7-day re-validation
  const validation = engine.validate();
  // Merge new violations into schedule
  const softWarnings = currentSchedule.violations.filter(v => v.severity === ViolationSeverity.Warning);
  currentSchedule = {
    ...currentSchedule,
    violations: [...validation.violations, ...softWarnings],
    feasible: validation.valid,
  };

  renderAll();
}

function handleSwap(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!assignment) return;
  const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
  if (!task) return;
  const currentP = currentSchedule.participants.find(p => p.id === assignment.participantId);

  const options = currentSchedule.participants
    .filter(p => p.id !== assignment.participantId)
    .map(p => `${p.name} (L${p.level}, ${p.group})`)
    .join('\n');

  const choice = prompt(
    `Swap in "${task.name}".\nCurrently: ${currentP?.name}\n\nEnter participant name:\n\n${options}`
  );
  if (!choice) return;

  const newP = currentSchedule.participants.find(
    p => choice.includes(p.name) || choice === p.id
  );
  if (!newP) { alert('Participant not found.'); return; }

  const result = engine.swapParticipant({ assignmentId, newParticipantId: newP.id });
  currentSchedule = engine.getSchedule();

  if (!result.valid) {
    const msgs = result.violations.map(v => `[${v.code}] ${v.message}`).join('\n');
    alert(`⚠ Swap created violations across the 7-day schedule:\n\n${msgs}`);
  }

  // Full re-validation + refresh
  revalidateAndRefresh();
}

function handleLock(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const a = currentSchedule.assignments.find(a => a.id === assignmentId);
  if (!a) return;

  if (a.status === AssignmentStatus.Locked) {
    engine.unlockAssignment(assignmentId);
  } else {
    engine.lockAssignment(assignmentId);
  }
  currentSchedule = engine.getSchedule();
  revalidateAndRefresh();
}

// ─── Main Render ─────────────────────────────────────────────────────────────

function renderAll(): void {
  const app = document.getElementById('app')!;

  // ── Profile View: completely different layout, no re-optimization ──
  if (_viewMode === 'PROFILE_VIEW' && _profileParticipantId && currentSchedule) {
    // Hide the global tooltip when entering profile view
    hideTooltip();

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
      return;
    }
  }

  const participants = store.getAllParticipants();
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  let html = `
  <header>
    <div class="header-top">
      <h1>⏱ Resource Scheduling Engine</h1>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${!store.getUndoRedoState().canUndo ? 'disabled' : ''}
          title="Undo (Ctrl+Z)">↩ Undo${store.getUndoRedoState().undoDepth ? ' (' + store.getUndoRedoState().undoDepth + ')' : ''}</button>
        <button class="btn-sm btn-outline" id="btn-redo" ${!store.getUndoRedoState().canRedo ? 'disabled' : ''}
          title="Redo (Ctrl+Y)">↪ Redo${store.getUndoRedoState().redoDepth ? ' (' + store.getUndoRedoState().redoDepth + ')' : ''}</button>
      </div>
    </div>
    <p class="subtitle">
      ${store.getScheduleDate().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
      · ${store.getScheduleDays()}-Day Schedule
      · ${participants.length} Participants
      · ${templates.length} Task Templates
    </p>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn ${currentTab === 'participants' ? 'tab-active' : ''}" data-tab="participants">
      👥 Participants <span class="count">${participants.length}</span>
    </button>
    <button class="tab-btn ${currentTab === 'task-rules' ? 'tab-active' : ''}" data-tab="task-rules">
      📋 Task Rules <span class="count">${templates.length}</span>
      ${!preflight.canGenerate ? '<span class="badge badge-sm" style="background:var(--danger);margin-left:4px">!</span>' : ''}
    </button>
    <button class="tab-btn ${currentTab === 'schedule' ? 'tab-active' : ''}" data-tab="schedule">
      📊 Schedule View
      ${currentSchedule ? '<span class="badge badge-sm" style="background:var(--success);margin-left:4px">✓</span>' : ''}
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
  }

  html += '</div>';
  app.innerHTML = html;

  // Wire events
  wireTabNav(app);
  wireUndoRedo(app);

  const content = document.getElementById('tab-content')!;
  if (currentTab === 'participants') {
    wireParticipantsEvents(content, renderAll);
  } else if (currentTab === 'task-rules') {
    wireTaskRulesEvents(content, renderAll);
  } else if (currentTab === 'schedule') {
    wireScheduleEvents(content);
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

function wireScheduleEvents(container: HTMLElement): void {
  const genBtn = container.querySelector('#btn-generate');
  if (genBtn) genBtn.addEventListener('click', doGenerate);

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

  container.querySelectorAll('.btn-swap').forEach(btn => {
    btn.addEventListener('click', (e) => {
      handleSwap((e.target as HTMLElement).dataset.assignmentId!);
    });
  });

  container.querySelectorAll('.btn-lock').forEach(btn => {
    btn.addEventListener('click', (e) => {
      handleLock((e.target as HTMLElement).dataset.assignmentId!);
    });
  });

  // ── Participant Tooltip (event delegation) ──
  wireParticipantTooltip(container);

  // ── Participant click → Profile View ──
  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
    if (!target) return;
    const pid = target.dataset.pid;
    if (pid) navigateToProfile(pid);
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
  _tooltipEl = el;
  return el;
}

/** Build tooltip HTML content for a participant. */
function buildParticipantTooltipContent(p: Participant): string {
  // Workload data
  const numDays = store.getScheduleDays();
  const totalPeriodHours = numDays * 24;

  // Build breakdown using shared utility (R1)
  let bd = { heavyHours: 0, heavyCount: 0, lightHours: 0, lightCount: 0, typeHours: {} as Record<string,number>, typeCounts: {} as Record<string,number> };
  if (currentSchedule) {
    const taskMap = new Map<string, Task>();
    for (const t of currentSchedule.tasks) taskMap.set(t.id, t);
    const myItems = currentSchedule.assignments
      .filter(a => a.participantId === p.id)
      .map(a => ({ task: taskMap.get(a.taskId)! }))
      .filter(x => x.task);
    bd = computeTaskBreakdown(myItems);
  }
  const { heavyHours, heavyCount, lightCount, typeHours, typeCounts } = bd;

  const pctOfPeriod = totalPeriodHours > 0 ? (heavyHours / totalPeriodHours) * 100 : 0;

  const certsHtml = p.certifications.length > 0
    ? p.certifications.map((c: Certification) => {
        const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
        return `<span class="tt-cert" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`;
      }).join(' ')
    : '<span class="tt-dim">None</span>';

  const levelColors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];

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
        <span class="tt-label"><span style="color:${color};font-weight:600">${tt}</span></span>
        <span class="tt-value">${typeCounts[tt]}× · ${typeHours[tt].toFixed(1)}h</span>
      </div>`;
    }).join('');

  return `
    <div class="tt-header">
      <span class="tt-name">${p.name}</span>
      <span class="tt-level" style="background:${levelColors[p.level]}">L${p.level}</span>
    </div>
    <div class="tt-row"><span class="tt-label">Group</span><span class="tt-value">${p.group}</span></div>
    <div class="tt-row"><span class="tt-label">Certs</span><span class="tt-value">${certsHtml}</span></div>
    <div class="tt-divider"></div>
    ${breakdownRows}
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">Heavy tasks</span><span class="tt-value">${heavyCount}</span></div>
    <div class="tt-row"><span class="tt-label">Light tasks</span><span class="tt-value">${lightCount}</span></div>
    <div class="tt-row"><span class="tt-label">Weekly hours</span><span class="tt-value tt-bold">${heavyHours.toFixed(1)}h</span></div>
    <div class="tt-row"><span class="tt-label">Workload %</span><span class="tt-value">${pctOfPeriod.toFixed(1)}% of ${totalPeriodHours}h</span></div>
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

    const tooltip = getTooltipEl();
    tooltip.innerHTML = buildParticipantTooltipContent(p);
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

  // Build a set of current participant IDs from the store
  const storeIds = new Set(store.getAllParticipants().map(p => p.id));

  // Strip assignments for participants that no longer exist
  const before = currentSchedule.assignments.length;
  const cleanedAssignments = currentSchedule.assignments.filter(
    a => storeIds.has(a.participantId),
  );
  if (cleanedAssignments.length !== before) {
    currentSchedule = {
      ...currentSchedule,
      assignments: cleanedAssignments,
      // Also trim the participant list to match the store
      participants: currentSchedule.participants.filter(p => storeIds.has(p.id)),
    };
  }
}

function init(): void {
  store.initStore();
  store.subscribe(onStoreChanged);
  renderAll();

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
      if (e.key === 'ArrowRight' && currentDay < store.getScheduleDays()) {
        currentDay++;
        renderAll();
      } else if (e.key === 'ArrowLeft' && currentDay > 1) {
        currentDay--;
        renderAll();
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
