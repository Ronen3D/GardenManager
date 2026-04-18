/**
 * Participant Profile View — Personal Dashboard
 *
 * Shows a detailed per-participant view with:
 * - Top bar: Name, Level, Group, Status
 * - Personal 7-day agenda
 * - Personal unavailability and workload distribution
 * - Unavailability / blackout section
 * - Weekly workload metrics & per-task-type breakdown
 */

import { type Assignment, Level, type Participant, type Schedule, type Task } from '../models/types';
import { hebrewDayName } from '../utils/date-utils';
import * as store from './config-store';
import { renderPakalBadges } from './pakal-utils';
import { certBadge, escHtml, fmt, groupBadge, LEVEL_COLORS, levelBadge, taskBadge } from './ui-helpers';
import { computeTaskBreakdown } from './workload-utils';

// ─── Constants ───────────────────────────────────────────────────────────────

// ─── Local Formatting Helpers ────────────────────────────────────────────────

function fmtDayLabel(d: Date): string {
  return 'יום ' + hebrewDayName(d);
}

// ─── Main Render ─────────────────────────────────────────────────────────────

export interface ProfileContext {
  participant: Participant;
  schedule: Schedule;
  frozenAssignmentIds?: Set<string>;
  showSosButtons?: boolean;
}

export function renderProfileView(ctx: ProfileContext): string {
  const { participant: p, schedule } = ctx;
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();

  // Build task/assignment maps
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  // All assignments for this participant
  const myAssignments = schedule.assignments.filter((a) => a.participantId === p.id);
  const myTasks = myAssignments.map((a) => ({ assignment: a, task: taskMap.get(a.taskId)! })).filter((x) => x.task);

  let html = '';

  // ── Top Bar ──
  html += renderTopBar(p, myTasks, ctx);

  // ── Main Grid ──
  html += '<div class="profile-grid">';

  // Left column: Agenda
  html += '<div class="profile-left">';
  // Use the schedule's frozen dayStartHour so the agenda groups tasks
  // the same way they were at generation time.
  html += renderPersonalAgenda(
    p,
    myTasks,
    numDays,
    baseDate,
    ctx.frozenAssignmentIds,
    ctx.showSosButtons,
    schedule.algorithmSettings.dayStartHour,
  );
  html += '</div>';

  // Right column: Unavailability + Metrics
  html += '<div class="profile-right">';
  html += renderMetrics(p, myTasks, numDays);
  html += renderUnavailabilitySection(p, schedule, ctx.showSosButtons ?? false);
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
  let statusText = 'זמין';
  let statusClass = 'status-available';

  const groupTasks = myTasks.filter((x) => x.task.sameGroupRequired);
  if (groupTasks.length > 0) {
    statusText = `משובץ ב${groupTasks[0].task.name.replace(/^D\d+\s*/, '')}`;
    statusClass = 'status-active';
  }

  const certHtml =
    p.certifications.length > 0
      ? p.certifications.map((c) => certBadge(c)).join(' ')
      : '<span class="text-muted">אין</span>';
  const pakalHtml = renderPakalBadges(p, store.getAllPakalDefinitionsIncludeDeleted(), 'אין');

  return `
  <div class="profile-topbar">
    <button class="btn-back" data-action="back-to-schedule" title="חזור לשבצ&quot;ק">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>חזור לשבצ"ק</span>
    </button>
    <div class="profile-identity">
      <h2 class="profile-name">${p.name}</h2>
      <div class="profile-badges">
        ${levelBadge(p.level)}
        ${groupBadge(p.group)}
        <span class="profile-status ${statusClass}">${statusText}</span>
      </div>
      <div class="profile-certs">הסמכות: ${certHtml}</div>
      <div class="profile-certs profile-pakalim">פק"לים: ${pakalHtml}</div>
    </div>
    <div class="profile-summary-kpis">
      <div class="profile-kpi">
        <span class="profile-kpi-value">${myTasks.filter((x) => !x.task.isLight).length}</span>
        <span class="profile-kpi-label">משימות כבדות</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${myTasks.filter((x) => x.task.isLight).length}</span>
        <span class="profile-kpi-label">משימות קלות</span>
      </div>
      <div class="profile-kpi">
        <span class="profile-kpi-value">${computeHeavyHours(myTasks).toFixed(1)}h</span>
        <span class="profile-kpi-label">עומס אפקטיבי</span>
      </div>
    </div>
  </div>`;
}

function computeHeavyHours(myTasks: Array<{ assignment: Assignment; task: Task }>): number {
  return computeTaskBreakdown(myTasks).effectiveHeavyHours;
}

// ─── Personal Agenda ─────────────────────────────────────────────────────────

function renderPersonalAgenda(
  _p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  numDays: number,
  baseDate: Date,
  frozenAssignmentIds?: Set<string>,
  showSosButtons?: boolean,
  dayStartHour: number = 5,
): string {
  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📅 לו"ז אישי</h3>
    <div class="agenda-days">`;

  for (let d = 1; d <= numDays; d++) {
    const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), dayStartHour, 0);
    const dayEnd = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1, dayStartHour, 0);

    // Anchor each task to the day it STARTS in (no duplicates across days).
    // Cross-day tasks are displayed once, with a visual indicator.
    const dayTasks = myTasks
      .filter(
        ({ task }) =>
          task.timeBlock.start.getTime() >= dayStart.getTime() && task.timeBlock.start.getTime() < dayEnd.getTime(),
      )
      .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());

    const dayLabel = fmtDayLabel(dayDate);
    const isToday = d === 1; // Day 1 is "today" in context

    html += `<div class="agenda-day ${isToday ? 'agenda-day-current' : ''}">
      <div class="agenda-day-header">
        <span class="agenda-day-label">${dayLabel}</span>
        <span class="agenda-day-count">${dayTasks.length} ${dayTasks.length !== 1 ? 'משימות' : 'משימה'}</span>
      </div>`;

    if (dayTasks.length === 0) {
      html += '<div class="agenda-empty">אין שיבוצים</div>';
    } else {
      html += '<div class="agenda-tasks">';
      for (const { assignment, task } of dayTasks) {
        const color = task.color || '#7f8c8d';
        // Detect cross-day tasks (end time extends past this day's boundary)
        const crossDay = task.timeBlock.end.getTime() > dayEnd.getTime();
        const endDayIdx = crossDay
          ? Math.ceil(
              (task.timeBlock.end.getTime() -
                new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0).getTime()) /
                86400000,
            )
          : 0;
        const crossDayBadge = crossDay
          ? `<span class="badge badge-sm" style="background:#555;color:#ffc107" title="ממשיך ליום ${endDayIdx}">← יום ${endDayIdx}</span>`
          : '';
        const isFrozen = frozenAssignmentIds?.has(assignment.id) ?? false;
        let sosHtml = '';
        if (showSosButtons) {
          sosHtml = isFrozen
            ? '<span class="frozen-action-icon" title="מוקפא">&#x1F9CA;</span>'
            : `<button class="btn-rescue btn-rescue-profile" data-assignment-id="${assignment.id}" title="חילוץ">&#x1F198;</button>`;
        }
        html += `<div class="agenda-task task-tooltip-hover${crossDay ? ' agenda-task-crossday' : ''}" data-task-id="${task.id}" data-assignment-id="${assignment.id}" style="border-inline-start:3px solid ${color}">
          <div class="agenda-task-time" dir="ltr">${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}</div>
          <div class="agenda-task-info">
            <span class="agenda-task-name">${task.name}</span>
            ${taskBadge(task)}
            ${task.isLight ? '<span class="badge badge-sm" style="background:#7f8c8d">קלה</span>' : ''}
            ${crossDayBadge}
            ${sosHtml}
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

// ─── Unavailability Section ──────────────────────────────────────────────────

function renderUnavailabilitySection(p: Participant, schedule: Schedule, showSosButtons: boolean): string {
  const dateRules = store.getDateUnavailabilities(p.id);
  const fsos = (schedule.scheduleUnavailability ?? []).filter((u) => u.participantId === p.id);

  const sosBtn = showSosButtons
    ? `<button class="btn-future-sos profile-availability-action" data-action="future-sos" data-pid="${p.id}" title="סמן חלון אי־זמינות וחשב תוכנית החלפה">🆘 סמן אי־זמינות</button>`
    : '';

  let html = `<div class="profile-card">
    <div class="profile-card-header-row">
      <h3 class="profile-card-title">🚫 אי זמינות</h3>
      ${sosBtn}
    </div>`;

  if (fsos.length > 0) {
    html += '<h4 class="profile-sub-title">אי זמינות עתידית (על השבצ"ק הזה בלבד)</h4><ul class="profile-fsos-list">';
    for (const entry of fsos) {
      const startLabel = `יום ${hebrewDayName(entry.start)}`;
      const endLabel = `יום ${hebrewDayName(entry.end)}`;
      const timeLabel = `<span dir="ltr">${fmt(entry.start)} (${startLabel}) – ${fmt(entry.end)} (${endLabel})</span>`;
      const reason = entry.reason ? `<span class="text-muted"> · ${escHtml(entry.reason)}</span>` : '';
      const swapBadge =
        typeof entry.appliedSwapCount === 'number' && entry.appliedSwapCount > 0
          ? `<span class="profile-fsos-swap-badge" title="החלפות שנעשו עבור חלון זה">הוחלפו ${entry.appliedSwapCount}</span>`
          : '';
      html += `<li>
        <span>${timeLabel}${reason}${swapBadge}</span>
        <button class="profile-fsos-remove" data-action="remove-fsos" data-entry-id="${entry.id}" title="הסר">הסר</button>
      </li>`;
    }
    html += '</ul>';
  }

  if (dateRules.length > 0) {
    html += '<h4 class="profile-sub-title">כללים לפי יום בשבוע</h4><ul class="profile-list">';
    for (const r of dateRules) {
      const label = `כל ${hebrewDayName(new Date(2026, 0, 4 + r.dayOfWeek))}`;
      const timeLabel = r.allDay
        ? 'כל היום'
        : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00</span>`;
      html += `<li>
        <strong>${label}</strong> — ${timeLabel}
        ${r.reason ? `<span class="text-muted"> · ${r.reason}</span>` : ''}
        <span class="badge badge-sm" style="background:#8e44ad;margin-inline-start:6px">חוזר</span>
      </li>`;
    }
    html += '</ul>';
  }

  if (dateRules.length === 0 && fsos.length === 0) {
    html += '<p class="text-muted profile-empty-note">לא הוגדרו מגבלות זמינות. המשתתף זמין בכל שעות היממה.</p>';
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
  const {
    heavyHours,
    effectiveHeavyHours,
    hotHours,
    coldHours,
    lightHours,
    sourceHours,
    sourceEffectiveHours,
    sourceCounts,
    sourceColors,
  } = computeTaskBreakdown(myTasks);

  const pctOfPeriod = totalPeriodHours > 0 ? (effectiveHeavyHours / totalPeriodHours) * 100 : 0;
  const workloadClass = pctOfPeriod > 25 ? 'metric-danger' : pctOfPeriod > 18 ? 'metric-warning' : 'metric-ok';

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📊 מדדי עומס</h3>
    <div class="metrics-summary">
      <div class="metric-row">
        <span class="metric-label">שעות חמות (100% עומס)</span>
        <span class="metric-value">${hotHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">שעות קרות (עומס מופחת)</span>
        <span class="metric-value">${coldHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">משימות קלות (כרובית)</span>
        <span class="metric-value">${lightHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">עומס אפקטיבי</span>
        <span class="metric-value">${effectiveHeavyHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">שעות כבדות גולמיות</span>
        <span class="metric-value">${heavyHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">% עומס אפקטיבי מתוך ${totalPeriodHours} שעות</span>
        <span class="metric-value ${workloadClass}">${pctOfPeriod.toFixed(1)}%</span>
      </div>
    </div>

    <h4 class="profile-sub-title" style="margin-top:16px">פירוט לפי סוג משימה</h4>
    <div class="metrics-breakdown">`;

  // Bar chart for each task source
  const maxHours = Math.max(...Object.values(sourceEffectiveHours), 1);
  for (const key of Object.keys(sourceCounts)) {
    if (sourceCounts[key] === 0) continue;
    const color = sourceColors[key] || '#7f8c8d';
    const barPct = (sourceEffectiveHours[key] / maxHours) * 100;
    html += `<div class="breakdown-row">
      <span class="breakdown-label"><span class="badge" style="background:${color}">${key}</span></span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar-fill" style="width:${barPct}%;background:${color}"></div>
      </div>
      <span class="breakdown-value">${sourceCounts[key]}× · ${sourceEffectiveHours[key].toFixed(1)} שעות אפקטיביות (${sourceHours[key].toFixed(1)} שעות גולמיות)</span>
    </div>`;
  }

  html += '</div></div>';
  return html;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export interface ProfileEventHandlers {
  onBackToSchedule: () => void;
  onSosClick?: (assignmentId: string) => void;
  onFutureSosClick?: (participantId: string) => void;
  onRemoveFutureSosEntry?: (entryId: string) => void;
}

export function wireProfileEvents(
  container: HTMLElement,
  onBackToScheduleOrHandlers: (() => void) | ProfileEventHandlers,
  onSosClick?: (assignmentId: string) => void,
): void {
  // Back-compat: first form is (container, onBack, onSosClick).
  const handlers: ProfileEventHandlers =
    typeof onBackToScheduleOrHandlers === 'function'
      ? { onBackToSchedule: onBackToScheduleOrHandlers, onSosClick }
      : onBackToScheduleOrHandlers;

  container.addEventListener('click', (e) => {
    const rescueBtn = (e.target as HTMLElement).closest('.btn-rescue') as HTMLElement | null;
    if (rescueBtn?.dataset.assignmentId && handlers.onSosClick) {
      handlers.onSosClick(rescueBtn.dataset.assignmentId);
      return;
    }
    const target = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'back-to-schedule') {
      handlers.onBackToSchedule();
      return;
    }
    if (action === 'future-sos' && target.dataset.pid && handlers.onFutureSosClick) {
      handlers.onFutureSosClick(target.dataset.pid);
      return;
    }
    if (action === 'remove-fsos' && target.dataset.entryId && handlers.onRemoveFutureSosEntry) {
      handlers.onRemoveFutureSosEntry(target.dataset.entryId);
      return;
    }
  });
}
