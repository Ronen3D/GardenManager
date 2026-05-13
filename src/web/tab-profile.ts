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

import type { Assignment, Participant, Schedule, Task } from '../models/types';
import { computeParticipantCapacity } from '../utils/capacity';
import * as store from './config-store';
import { renderPakalBadges } from './pakal-utils';
import { certBadge, escHtml, fmt, groupBadge, levelBadge, stripDayPrefix, taskBadge } from './ui-helpers';
import { computeTaskBreakdown } from './workload-utils';

// ─── Main Render ─────────────────────────────────────────────────────────────

export interface ProfileContext {
  participant: Participant;
  schedule: Schedule;
  frozenAssignmentIds?: Set<string>;
  showSosButtons?: boolean;
}

export function renderProfileView(ctx: ProfileContext): string {
  const { participant: p, schedule } = ctx;
  // Read from the frozen schedule, not the live store — the schedule
  // snapshot is the source of truth post-generation. Pre-fix this read
  // `store.getScheduleDays()` / `store.getScheduleDate()` which could drift
  // if the user edited those settings after generation.
  const numDays = schedule.periodDays;
  const baseDate = schedule.periodStart;

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
    schedule,
  );
  html += '</div>';

  // Right column: Unavailability + Metrics
  html += '<div class="profile-right">';
  html += renderMetrics(p, myTasks, numDays, schedule);
  html += renderUnavailabilitySection(p, schedule, ctx.showSosButtons ?? false, numDays);
  html += '</div>';

  html += '</div>';

  return html;
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────

function renderTopBar(
  p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  _ctx: ProfileContext,
): string {
  // Determine status
  let statusText = 'זמין';
  let statusClass = 'status-available';

  const groupTasks = myTasks.filter((x) => x.task.sameGroupRequired);
  if (groupTasks.length > 0) {
    statusText = `משובץ ב${groupTasks[0].task.sourceName ?? stripDayPrefix(groupTasks[0].task.name)}`;
    statusClass = 'status-active';
  }

  const certHtml =
    p.certifications.length > 0
      ? p.certifications.map((c) => certBadge(c)).join(' ')
      : '<span class="text-muted">אין</span>';
  const pakalHtml = renderPakalBadges(p, store.getAllPakalDefinitionsIncludeDeleted(), 'אין');

  const hours = computeHeavyHours(myTasks).toFixed(1);
  const safeName = escHtml(p.name);
  const safeStatus = escHtml(statusText);

  const iconPin = `<svg class="icon-pin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-12a7 7 0 1 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>`;
  const iconMedal = `<svg class="icon-medal" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3l4 7 4-7"/><path d="M8 3h8"/><circle cx="12" cy="15" r="6"/><path d="M10 14l2 2 2-2"/></svg>`;
  const iconTag = `<svg class="icon-tag" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="8" cy="8" r="1.5"/></svg>`;
  const iconHeart = `<svg class="icon-heart" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  const iconHeartOff = `<svg class="icon-heart-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 3a5.5 5.5 0 0 1 4.38 8.84l-.1.13L19 14M12 21.23l-7.78-7.78a5.5 5.5 0 0 1 .03-7.8 5.5 5.5 0 0 1 7.78-.02L12 6.66M3 3l18 18"/></svg>`;

  const preferencesHtml = renderPreferences(p, iconHeart, iconHeartOff);

  return `
  <div class="profile-topbar">
    <button class="btn-back" data-action="back-to-schedule" title="חזור לשבצ&quot;ק" aria-label="חזור לשבצ&quot;ק">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="btn-back-label">חזור לשבצ"ק</span>
    </button>
    <div class="profile-kpi-hero" title="עומס אפקטיבי">
      <span class="profile-kpi-value">${hours}h</span>
      <span class="profile-kpi-label">עומס אפקטיבי</span>
    </div>
    <div class="profile-identity">
      <h2 class="profile-name" title="${safeName}">${safeName}</h2>
      <div class="profile-badges">
        ${levelBadge(p.level)}
        ${groupBadge(p.group)}
      </div>
      <div class="profile-assignment ${statusClass}" title="${safeStatus}">
        ${iconPin}
        <span>${safeStatus}</span>
      </div>
      <div class="profile-meta-row" aria-label="הסמכות">
        ${iconMedal}
        ${certHtml}
      </div>
      <div class="profile-meta-row profile-meta-pakalim" aria-label="פק&quot;לים">
        ${iconTag}
        ${pakalHtml}
      </div>
      ${preferencesHtml}
    </div>
  </div>`;
}

function renderPreferences(p: Participant, iconHeart: string, iconHeartOff: string): string {
  if (!p.preferredTaskName && !p.lessPreferredTaskName) return '';
  const templateMap = store.getTemplateVisualMap();
  const badge = (name: string): string => {
    const color = templateMap[name]?.color || '#7f8c8d';
    return `<span class="badge" style="background:${color}">${escHtml(name)}</span>`;
  };
  let html = '';
  if (p.preferredTaskName) {
    html += `
      <div class="profile-meta-row profile-meta-pref" aria-label="משימה מועדפת" title="משימה מועדפת">
        ${iconHeart}
        <span class="profile-pref-label">מעדיף</span>
        ${badge(p.preferredTaskName)}
      </div>`;
  }
  if (p.lessPreferredTaskName) {
    html += `
      <div class="profile-meta-row profile-meta-pref" aria-label="משימה פחות מועדפת" title="משימה פחות מועדפת">
        ${iconHeartOff}
        <span class="profile-pref-label">פחות מעדיף</span>
        ${badge(p.lessPreferredTaskName)}
      </div>`;
  }
  return html;
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
  schedule?: Schedule,
): string {
  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📅 לו"ז אישי</h3>
    <div class="agenda-days">`;

  // Day 0 (continuity context): if the schedule was generated with previous-
  // day context AND this participant appears in that snapshot (matched by
  // name), prepend a read-only ghost card. Foreign participants (continuity
  // names absent from the current roster) never reach this profile view —
  // they aren't in `schedule.participants` so the user can't open them.
  if (schedule?.continuitySnapshot) {
    const snap = schedule.continuitySnapshot;
    const cp = snap.participants.find((q) => q.name === _p.name);
    if (cp && cp.assignments.length > 0) {
      const sortedAssignments = [...cp.assignments].sort(
        (a, b) => new Date(a.timeBlock.start).getTime() - new Date(b.timeBlock.start).getTime(),
      );
      html += `<div class="agenda-day agenda-day-day0">
        <div class="agenda-day-header">
          <span class="agenda-day-label">📋 יום 0 · הקשר</span>
          <span class="agenda-day-count">${sortedAssignments.length} ${sortedAssignments.length !== 1 ? 'משימות' : 'משימה'}</span>
        </div>
        <div class="agenda-tasks">`;
      for (const ca of sortedAssignments) {
        const color = ca.color || '#95A5A6';
        const start = new Date(ca.timeBlock.start);
        const end = new Date(ca.timeBlock.end);
        html += `<div class="agenda-task agenda-task--day0" style="border-inline-start:3px solid ${color}">
          <div class="agenda-task-time" dir="ltr">${fmt(start)} – ${fmt(end)}</div>
          <div class="agenda-task-info">
            <span class="badge badge-sm" style="background:${color}">${escHtml(stripDayPrefix(ca.taskName))}</span>
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }
  }

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

    const dayLabel = `יום ${d}`;
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
            ${taskBadge(task)}
            ${crossDayBadge}
          </div>
          ${sosHtml}
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

function renderUnavailabilitySection(
  p: Participant,
  schedule: Schedule,
  showSosButtons: boolean,
  numDays: number,
): string {
  const dateRules = store.getDateUnavailabilities(p.id);
  const fsos = (schedule.scheduleUnavailability ?? []).filter((u) => u.participantId === p.id);
  const capLoss = (schedule.capabilityLoss ?? []).filter((u) => u.participantId === p.id);
  const certLabel = (id: string): string => schedule.certLabelSnapshot[id] ?? id;

  const sosBtn = showSosButtons
    ? `<button class="btn-future-sos profile-availability-action" data-action="future-sos" data-pid="${p.id}" title="סמן חלון אי־זמינות וחשב תוכנית החלפה">🆘 סמן אי־זמינות</button>`
    : '';
  const capChangeBtn =
    showSosButtons && p.certifications.length > 0
      ? `<button class="btn-cap-change profile-availability-action" data-action="capability-change" data-pid="${p.id}" title="סמן הסמכה שאבדה וחשב תוכנית החלפה">📜 שינוי הסמכה</button>`
      : '';

  let html = `<div class="profile-card">
    <div class="profile-card-header-row">
      <h3 class="profile-card-title">🚫 אי זמינות</h3>
      ${sosBtn}
      ${capChangeBtn}
    </div>`;

  if (fsos.length > 0) {
    html += '<h4 class="profile-sub-title">אי זמינות עתידית (על השבצ"ק הזה בלבד)</h4><ul class="profile-fsos-list">';
    const base = schedule.periodStart;
    const dsh = schedule.algorithmSettings.dayStartHour;
    const baseMidnight = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    const toDayIdx = (d: Date): number => {
      const shifted = new Date(d.getTime());
      if (shifted.getHours() < dsh) shifted.setDate(shifted.getDate() - 1);
      const shiftedMidnight = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime();
      return Math.floor((shiftedMidnight - baseMidnight) / (24 * 3600 * 1000)) + 1;
    };
    for (const entry of fsos) {
      const startLabel = `יום ${toDayIdx(entry.start)}`;
      const endLabel = `יום ${toDayIdx(entry.end)}`;
      const timeLabel = `${startLabel} <span dir="ltr">${fmt(entry.start)}</span> – ${endLabel} <span dir="ltr">${fmt(entry.end)}</span>`;
      const reason = entry.reason ? `<span class="text-muted"> · ${escHtml(entry.reason)}</span>` : '';
      html += `<li>
        <span>${timeLabel}${reason}</span>
        <button class="profile-fsos-remove" data-action="remove-fsos" data-entry-id="${entry.id}" title="הסר">הסר</button>
      </li>`;
    }
    html += '</ul>';
  }

  if (capLoss.length > 0) {
    html += '<h4 class="profile-sub-title">שינויי הסמכה (על השבצ"ק הזה בלבד)</h4><ul class="profile-fsos-list">';
    const base = schedule.periodStart;
    const dsh = schedule.algorithmSettings.dayStartHour;
    const baseMidnight = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    const toDayIdx = (d: Date): number => {
      const shifted = new Date(d.getTime());
      if (shifted.getHours() < dsh) shifted.setDate(shifted.getDate() - 1);
      const shiftedMidnight = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime();
      return Math.floor((shiftedMidnight - baseMidnight) / (24 * 3600 * 1000)) + 1;
    };
    for (const entry of capLoss) {
      const startLabel = `יום ${toDayIdx(entry.start)}`;
      const endLabel = `יום ${toDayIdx(entry.end)}`;
      const timeLabel = `${startLabel} <span dir="ltr">${fmt(entry.start)}</span> – ${endLabel} <span dir="ltr">${fmt(entry.end)}</span>`;
      const certs = entry.lostCertifications.map(certLabel).join(', ');
      const reason = entry.reason ? `<span class="text-muted"> · ${escHtml(entry.reason)}</span>` : '';
      html += `<li>
        <span><strong>${escHtml(certs)}</strong> · ${timeLabel}${reason}</span>
        <button class="profile-fsos-remove" data-action="remove-cap-loss" data-entry-id="${entry.id}" title="הסר">הסר</button>
      </li>`;
    }
    html += '</ul>';
  }

  if (dateRules.length > 0) {
    html += '<h4 class="profile-sub-title">כללים קבועים לפי יום בשבצ״ק</h4><ul class="profile-list">';
    for (const r of dateRules) {
      const start = r.dayIndex;
      const end = r.endDayIndex ?? r.dayIndex;
      const label = start === end ? `יום ${start}` : `יום ${start}–יום ${end}`;
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

  if (dateRules.length === 0 && fsos.length === 0 && capLoss.length === 0) {
    const scopeLabel = numDays <= 1 ? 'לכל אורך היום' : 'לכל אורך השבצ"ק';
    html += `<p class="text-muted profile-empty-note">לא הוגדרו מגבלות זמינות. המשתתף זמין ${scopeLabel}.</p>`;
  }

  html += '</div>';
  return html;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function renderMetrics(
  p: Participant,
  myTasks: Array<{ assignment: Assignment; task: Task }>,
  numDays: number,
  schedule: Schedule,
): string {
  // Shared breakdown utility (R1)
  const { effectiveHeavyHours, sourceHours, sourceCounts, sourceColors, sourceBaseLoadWeights } =
    computeTaskBreakdown(myTasks);

  // Capacity-aware: render % as utilization of the participant's actual
  // available hours, not a flat numDays × 24 denominator. Falls back to the
  // flat denominator when the schedule has no tasks (capacity == 0).
  let schedStart = schedule.tasks[0]?.timeBlock.start ?? schedule.periodStart;
  let schedEnd = schedule.tasks[0]?.timeBlock.end ?? schedule.periodStart;
  for (const t of schedule.tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const cap = computeParticipantCapacity(p, schedStart, schedEnd, schedule.algorithmSettings.dayStartHour);
  const denom = cap.totalAvailableHours > 0 ? cap.totalAvailableHours : numDays * 24;
  const pctOfCapacity = denom > 0 ? (effectiveHeavyHours / denom) * 100 : 0;
  // Thresholds re-calibrated for utilization-space: > 70% danger, > 50% warning.
  const workloadClass = pctOfCapacity > 70 ? 'metric-danger' : pctOfCapacity > 50 ? 'metric-warning' : 'metric-ok';
  const denomLabel = `${denom.toFixed(0)} שעות זמינות`;

  let html = `<div class="profile-card">
    <h3 class="profile-card-title">📊 מדדי עומס</h3>
    <div class="metrics-summary">
      <div class="metric-row">
        <span class="metric-label">עומס (בשעות משוכללות)</span>
        <span class="metric-value">${effectiveHeavyHours.toFixed(1)}h</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">אחוז ניצול מתוך ${denomLabel}</span>
        <span class="metric-value ${workloadClass}">${pctOfCapacity.toFixed(1)}%</span>
      </div>
    </div>

    <h4 class="profile-sub-title" style="margin-top:16px">פירוט לפי סוג משימה</h4>
    <div class="metrics-breakdown">`;

  // Bar chart for each task source
  const maxHours = Math.max(...Object.values(sourceHours), 1);
  for (const key of Object.keys(sourceCounts)) {
    if (sourceCounts[key] === 0) continue;
    const color = sourceColors[key] || '#7f8c8d';
    const barPct = (sourceHours[key] / maxHours) * 100;
    const weight = sourceBaseLoadWeights[key] ?? 1;
    html += `<div class="breakdown-row">
      <span class="breakdown-label"><span class="badge" style="background:${color}">${key}</span></span>
      <div class="breakdown-bar-bg">
        <div class="breakdown-bar-fill" style="width:${barPct}%;background:${color}"></div>
      </div>
      <span class="breakdown-value">${sourceCounts[key]}× · ${sourceHours[key].toFixed(1)} שעות גולמיות · משקל בסיס ${weight.toFixed(2)}</span>
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
  onCapabilityChangeClick?: (participantId: string) => void;
  onRemoveCapabilityLossEntry?: (entryId: string) => void;
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
    if (action === 'capability-change' && target.dataset.pid && handlers.onCapabilityChangeClick) {
      handlers.onCapabilityChangeClick(target.dataset.pid);
      return;
    }
    if (action === 'remove-cap-loss' && target.dataset.entryId && handlers.onRemoveCapabilityLossEntry) {
      handlers.onRemoveCapabilityLossEntry(target.dataset.entryId);
      return;
    }
  });
}
