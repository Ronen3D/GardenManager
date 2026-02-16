/**
 * Participant Profile View — Personal Dashboard
 *
 * Shows a detailed per-participant view with:
 * - Top bar: Name, Level, Group, Status
 * - Personal 7-day agenda
 * - L1 Adanit cycle visualization (if applicable)
 * - Unavailability / blackout section
 * - Weekly workload metrics & per-task-type breakdown
 */

import {
  Participant,
  Level,
  Certification,
  TaskType,
  Schedule,
  Task,
  Assignment,
  L1CyclePhase,
  L1CycleState,
  DateUnavailability,
} from '../models/types';
import {
  getFullCycleTimeline,
  isInRestPhase,
  PHASE_DURATIONS,
  CYCLE_PERIOD_HOURS,
} from './utils/l1-cycle';
import * as store from './config-store';
import { computeTaskBreakdown } from './workload-utils';

// ─── Colors ──────────────────────────────────────────────────────────────────

const TASK_COLORS: Record<string, string> = {
  Adanit: '#4A90D9', Hamama: '#E74C3C', Shemesh: '#F39C12',
  Mamtera: '#27AE60', Karov: '#8E44AD', Karovit: '#BDC3C7', Aruga: '#1ABC9C',
};

const GROUP_COLORS: Record<string, string> = {
  'Dept A': '#3498db', 'Dept B': '#e67e22', 'Dept C': '#2ecc71', 'Dept D': '#e74c9b',
};

const LEVEL_COLORS = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function fmt(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDayLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
}

function levelBadge(level: Level): string {
  return `<span class="badge" style="background:${LEVEL_COLORS[level]}">L${level}</span>`;
}

function certBadge(c: Certification): string {
  const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
  return `<span class="badge" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`;
}

function groupBadge(group: string): string {
  const color = GROUP_COLORS[group] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${group}</span>`;
}

function taskTypeBadge(type: TaskType): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  return `<span class="badge badge-sm" style="background:${color}">${type}</span>`;
}

// ─── Main Render ─────────────────────────────────────────────────────────────

export interface ProfileContext {
  participant: Participant;
  schedule: Schedule;
  l1CycleState: L1CycleState | undefined;
  weekEnd: Date;
}

export function renderProfileView(ctx: ProfileContext): string {
  const { participant: p, schedule } = ctx;
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();

  // Build task/assignment maps
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  // All assignments for this participant
  const myAssignments = schedule.assignments.filter(a => a.participantId === p.id);
  const myTasks = myAssignments.map(a => ({ assignment: a, task: taskMap.get(a.taskId)! })).filter(x => x.task);

  let html = '';

  // ── Top Bar ──
  html += renderTopBar(p, myTasks, ctx);

  // ── Main Grid ──
  html += '<div class="profile-grid">';

  // Left column: Agenda + L1 Cycle
  html += '<div class="profile-left">';
  html += renderPersonalAgenda(p, myTasks, numDays, baseDate);
  if (p.level === Level.L1 && ctx.l1CycleState) {
    html += renderL1CycleVisualization(ctx.l1CycleState, ctx.weekEnd, numDays, baseDate);
  }
  html += '</div>';

  // Right column: Unavailability + Metrics
  html += '<div class="profile-right">';
  html += renderMetrics(p, myTasks, numDays);
  html += renderUnavailabilitySection(p);
  html += '</div>';

  html += '</div>';

  return html;
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────

function renderTopBar(
  p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  ctx: ProfileContext,
): string {
  // Determine status
  let statusText = 'Available';
  let statusClass = 'status-available';

  if (p.level === Level.L1 && ctx.l1CycleState) {
    const timeline = getFullCycleTimeline(ctx.l1CycleState, ctx.weekEnd);
    const now = new Date();
    const restCheck = isInRestPhase(timeline, now);
    if (restCheck.inRest) {
      statusText = `Absolute Rest (until ${fmt(restCheck.restEndsAt!)})`;
      statusClass = 'status-rest';
    } else {
      statusText = 'Active in Adanit Cycle';
      statusClass = 'status-active';
    }
  }

  const adanitTasks = myTasks.filter(x => x.task.type === TaskType.Adanit);
  if (adanitTasks.length > 0 && p.level !== Level.L1) {
    statusText = 'Assigned to Adanit';
    statusClass = 'status-active';
  }

  const certHtml = p.certifications.length > 0
    ? p.certifications.map(c => certBadge(c)).join(' ')
    : '<span class="text-muted">None</span>';

  return `
  <div class="profile-topbar">
    <button class="btn-back" data-action="back-to-schedule" title="Back to Full Schedule">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Back to Schedule</span>
    </button>
    <div class="profile-identity">
      <h2 class="profile-name">${p.name}</h2>
      <div class="profile-badges">
        ${levelBadge(p.level)}
        ${groupBadge(p.group)}
        <span class="profile-status ${statusClass}">${statusText}</span>
      </div>
      <div class="profile-certs">Certs: ${certHtml}</div>
    </div>
    <div class="profile-summary-kpis">
      <div class="profile-kpi">
        <span class="profile-kpi-value">${myTasks.filter(x => !x.task.isLight).length}</span>
        <span class="profile-kpi-label">Heavy Tasks</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${myTasks.filter(x => x.task.isLight).length}</span>
        <span class="profile-kpi-label">Light Tasks</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${computeHeavyHours(myTasks).toFixed(1)}h</span>
        <span class="profile-kpi-label">Weekly Hours</span>
      </div>
    </div>
  </div>`;
}

function computeHeavyHours(myTasks: Array<{ assignment: Assignment; task: Task }>): number {
  return computeTaskBreakdown(myTasks).heavyHours;
}

// ─── Personal Agenda ─────────────────────────────────────────────────────────

function renderPersonalAgenda(
  _p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  numDays: number,
  baseDate: Date,
): string {
  const DAY_START_HOUR = 5;

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📅 Personal Agenda</h3>
    <div class="agenda-days">`;

  for (let d = 1; d <= numDays; d++) {
    const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), DAY_START_HOUR, 0);
    const dayEnd = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1, DAY_START_HOUR, 0);

    // Anchor each task to the day it STARTS in (no duplicates across days).
    // Cross-day tasks are displayed once, with a visual indicator.
    const dayTasks = myTasks.filter(({ task }) =>
      task.timeBlock.start.getTime() >= dayStart.getTime() &&
      task.timeBlock.start.getTime() < dayEnd.getTime()
    ).sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());

    const dayLabel = fmtDayLabel(dayDate);
    const isToday = d === 1; // Day 1 is "today" in context

    html += `<div class="agenda-day ${isToday ? 'agenda-day-current' : ''}">
      <div class="agenda-day-header">
        <span class="agenda-day-label">Day ${d} · ${dayLabel}</span>
        <span class="agenda-day-count">${dayTasks.length} task${dayTasks.length !== 1 ? 's' : ''}</span>
      </div>`;

    if (dayTasks.length === 0) {
      html += '<div class="agenda-empty">No assignments</div>';
    } else {
      html += '<div class="agenda-tasks">';
      for (const { task } of dayTasks) {
        const color = TASK_COLORS[task.type] || '#7f8c8d';
        const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
        // Detect cross-day tasks (end time extends past this day's boundary)
        const crossDay = task.timeBlock.end.getTime() > dayEnd.getTime();
        const endDayIdx = crossDay
          ? Math.ceil((task.timeBlock.end.getTime() - new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), DAY_START_HOUR, 0).getTime()) / 86400000)
          : 0;
        const crossDayBadge = crossDay
          ? `<span class="badge badge-sm" style="background:#555;color:#ffc107" title="Continues into Day ${endDayIdx}">→ Day ${endDayIdx}</span>`
          : '';
        html += `<div class="agenda-task${crossDay ? ' agenda-task-crossday' : ''}" style="border-left:3px solid ${color}">
          <div class="agenda-task-time">${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}</div>
          <div class="agenda-task-info">
            <span class="agenda-task-name">${task.name}</span>
            ${taskTypeBadge(task.type)}
            <span class="agenda-task-dur">${hrs.toFixed(1)}h</span>
            ${task.isLight ? '<span class="badge badge-sm" style="background:#7f8c8d">Light</span>' : ''}
            ${crossDayBadge}
          </div>
        </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

// ─── L1 Cycle Visualization ──────────────────────────────────────────────────

function renderL1CycleVisualization(
  cycleState: L1CycleState,
  weekEnd: Date,
  numDays: number,
  baseDate: Date,
): string {
  const timeline = getFullCycleTimeline(cycleState, weekEnd);
  const DAY_START_HOUR = 5;

  // Total timeline span in ms
  const schedStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), DAY_START_HOUR, 0);
  const schedEnd = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + numDays, DAY_START_HOUR, 0);
  const totalMs = schedEnd.getTime() - schedStart.getTime();

  if (totalMs <= 0) return '';

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">🔄 L1 Adanit Cycle (8-8-8-16)</h3>
    <p class="profile-card-subtitle">Stagger Group: ${cycleState.staggerIndex} · Cycle Period: ${CYCLE_PERIOD_HOURS}h</p>
    <div class="l1-timeline-container">`;

  // Day boundary markers
  html += '<div class="l1-timeline-days">';
  for (let d = 0; d <= numDays; d++) {
    const pos = (d / numDays) * 100;
    const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d);
    const label = d < numDays ? `D${d + 1}` : '';
    html += `<span class="l1-day-marker" style="left:${pos}%">${label}</span>`;
  }
  html += '</div>';

  // Phase blocks
  html += '<div class="l1-timeline-bar">';
  for (const entry of timeline) {
    const entryStart = Math.max(entry.start.getTime(), schedStart.getTime());
    const entryEnd = Math.min(entry.end.getTime(), schedEnd.getTime());
    if (entryEnd <= entryStart) continue;

    const left = ((entryStart - schedStart.getTime()) / totalMs) * 100;
    const width = ((entryEnd - entryStart) / totalMs) * 100;

    let phaseClass: string;
    let phaseLabel: string;
    switch (entry.phase) {
      case L1CyclePhase.Work1:
        phaseClass = 'l1-phase-work';
        phaseLabel = 'W1';
        break;
      case L1CyclePhase.Work2:
        phaseClass = 'l1-phase-work';
        phaseLabel = 'W2';
        break;
      case L1CyclePhase.Rest8:
        phaseClass = 'l1-phase-rest8';
        phaseLabel = 'R8';
        break;
      case L1CyclePhase.Rest16:
        phaseClass = 'l1-phase-rest16';
        phaseLabel = 'R16';
        break;
    }

    const durationH = (entryEnd - entryStart) / 3600000;
    const tooltip = `${phaseLabel} (${entry.phase})\n${fmt(entry.start)} – ${fmt(entry.end)}\n${durationH.toFixed(0)}h`;
    html += `<div class="l1-phase-block ${phaseClass}" style="left:${left}%;width:${width}%" title="${tooltip}">
      <span class="l1-phase-label">${width > 3 ? phaseLabel : ''}</span>
    </div>`;
  }
  html += '</div>';

  // Legend
  html += `<div class="l1-legend">
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-work"></span> Work (8h)</span>
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-rest8"></span> Rest 8h</span>
    <span class="l1-legend-item"><span class="l1-legend-swatch l1-phase-rest16"></span> Absolute Rest 16h</span>
  </div>`;

  html += '</div></div>';
  return html;
}

// ─── Unavailability Section ──────────────────────────────────────────────────

function renderUnavailabilitySection(p: Participant): string {
  const blackouts = store.getBlackouts(p.id);
  const dateRules = store.getDateUnavailabilities(p.id);

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">🚫 Unavailability</h3>`;

  // Blackout periods
  if (blackouts.length > 0) {
    html += '<h4 class="profile-sub-title">Blackout Periods</h4><ul class="profile-list">';
    for (const b of blackouts) {
      html += `<li>
        <strong>${fmt(b.start)} – ${fmt(b.end)}</strong>
        ${b.reason ? `<span class="text-muted"> · ${b.reason}</span>` : ''}
        <span class="badge badge-sm" style="background:#e74c3c;margin-left:6px">One-time</span>
      </li>`;
    }
    html += '</ul>';
  }

  // Date-specific rules
  if (dateRules.length > 0) {
    html += '<h4 class="profile-sub-title">Date-Specific Rules</h4><ul class="profile-list">';
    for (const r of dateRules) {
      const isRecurring = r.dayOfWeek !== undefined;
      let label: string;
      if (r.specificDate) {
        label = r.specificDate;
      } else if (r.dayOfWeek !== undefined) {
        label = `Every ${DAY_NAMES[r.dayOfWeek]}`;
      } else {
        label = 'Unknown';
      }
      const timeLabel = r.allDay ? 'All Day' : `${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00`;
      html += `<li>
        <strong>${label}</strong> — ${timeLabel}
        ${r.reason ? `<span class="text-muted"> · ${r.reason}</span>` : ''}
        <span class="badge badge-sm" style="background:${isRecurring ? '#8e44ad' : '#e74c3c'};margin-left:6px">${isRecurring ? 'Recurring' : 'Specific Date'}</span>
      </li>`;
    }
    html += '</ul>';
  }

  if (blackouts.length === 0 && dateRules.length === 0) {
    html += '<p class="text-muted profile-empty-note">No unavailability rules configured. Participant is available 24/7.</p>';
  }

  html += '</div>';
  return html;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function renderMetrics(
  _p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  numDays: number,
): string {
  const totalPeriodHours = numDays * 24;

  // Shared breakdown utility (R1)
  const { heavyHours, lightHours, typeHours, typeCounts } = computeTaskBreakdown(myTasks);

  const pctOfPeriod = totalPeriodHours > 0 ? (heavyHours / totalPeriodHours) * 100 : 0;
  const workloadClass = pctOfPeriod > 25 ? 'metric-danger' : pctOfPeriod > 18 ? 'metric-warning' : 'metric-ok';

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📊 Workload Metrics</h3>
    <div class="metrics-summary">
      <div class="metric-row">
        <span class="metric-label">Heavy Hours</span>
        <span class="metric-value">${heavyHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Light Hours</span>
        <span class="metric-value">${lightHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Workload % (of ${totalPeriodHours}h)</span>
        <span class="metric-value ${workloadClass}">${pctOfPeriod.toFixed(1)}%</span>
      </div>
    </div>

    <h4 class="profile-sub-title" style="margin-top:16px">Breakdown by Task Type</h4>
    <div class="metrics-breakdown">`;

  // Bar chart for each task type
  const maxHours = Math.max(...Object.values(typeHours), 1);
  for (const tt of Object.values(TaskType)) {
    if (typeCounts[tt] === 0) continue;
    const color = TASK_COLORS[tt] || '#7f8c8d';
    const barPct = (typeHours[tt] / maxHours) * 100;
    html += `<div class="breakdown-row">
      <span class="breakdown-label">${taskTypeBadge(tt as TaskType)}</span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar-fill" style="width:${barPct}%;background:${color}"></div>
      </div>
      <span class="breakdown-value">${typeCounts[tt]}× · ${typeHours[tt].toFixed(1)}h</span>
    </div>`;
  }

  html += '</div></div>';
  return html;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireProfileEvents(
  container: HTMLElement,
  onBackToSchedule: () => void,
): void {
  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    if (target.dataset.action === 'back-to-schedule') {
      onBackToSchedule();
    }
  });
}
