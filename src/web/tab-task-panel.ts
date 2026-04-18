/**
 * Task Panel View — Per-Task Weekly Dashboard
 *
 * Mirrors the Participant Profile panel for a task (grouped by sourceName).
 * Shows: KPIs, a "needs attention" card for unfilled slots, a weekly timeline
 * (7-lane desktop / day-stack phone), role-signature requirements, a
 * workload distribution across participants, and a constraints meta card.
 *
 * Reads exclusively from the frozen schedule snapshot passed via context —
 * never from the live config store.
 */

import type { Assignment, LoadWindow, Participant, Schedule, SlotRequirement, Task } from '../models/types';
import { hebrewDayName } from '../utils/date-utils';
import { certBadge, escHtml, fmt, groupColor, LEVEL_COLORS, levelBadge, taskBadge } from './ui-helpers';

// ─── Context ─────────────────────────────────────────────────────────────────

export interface TaskPanelContext {
  /** Match key — tasks are grouped by sourceName (falls back to task.name). */
  sourceName: string;
  schedule: Schedule;
  /** Day count in the frozen window. Passed in so we don't read from the live store. */
  numDays: number;
  /** Base date of the frozen window (day 1). */
  baseDate: Date;
  frozenAssignmentIds?: Set<string>;
  showSosButtons?: boolean;
  /** True when the viewport is at or below the phone breakpoint. */
  isSmallScreen: boolean;
}

/** Sentinel returned when the source name no longer resolves to any task in the schedule. */
export const TASK_PANEL_EMPTY = '__TASK_PANEL_EMPTY__';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDayLabel(d: Date): string {
  return 'יום ' + hebrewDayName(d);
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function fmtWindow(w: LoadWindow): string {
  return `${pad2(w.startHour)}:${pad2(w.startMinute)}–${pad2(w.endHour)}:${pad2(w.endMinute)}`;
}

function taskKey(t: Task): string {
  return t.sourceName || t.name;
}

function slotSignature(s: SlotRequirement): string {
  const lvls = [...s.acceptableLevels]
    .sort((a, b) => a.level - b.level)
    .map((l) => `${l.level}${l.lowPriority ? '~' : ''}`)
    .join('/');
  const req = [...(s.requiredCertifications || [])].sort().join(',');
  const fbd = [...(s.forbiddenCertifications || [])].sort().join(',');
  return `${s.subTeamLabel || ''}|${lvls}|R:${req}|F:${fbd}`;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Return the sub-ranges where this task's own load windows actually overlap
 * with its shift time. Each entry is clamped to the shift boundaries so the
 * caller can render the real hot sub-range (e.g. "08:00–09:30") instead of
 * implying the whole shift is under peak load.
 */
function shiftHotOverlaps(task: Task): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  if (!task.loadWindows || task.loadWindows.length === 0) return out;
  const startMs = task.timeBlock.start.getTime();
  const endMs = task.timeBlock.end.getTime();
  const day = new Date(task.timeBlock.start);
  day.setHours(0, 0, 0, 0);
  for (const w of task.loadWindows) {
    const ws = new Date(day);
    ws.setHours(w.startHour, w.startMinute, 0, 0);
    const we = new Date(day);
    we.setHours(w.endHour, w.endMinute, 0, 0);
    if (we.getTime() <= ws.getTime()) we.setDate(we.getDate() + 1);
    if (!rangesOverlap(startMs, endMs, ws.getTime(), we.getTime())) continue;
    out.push({
      start: new Date(Math.max(startMs, ws.getTime())),
      end: new Date(Math.min(endMs, we.getTime())),
    });
  }
  return out;
}

// ─── Main Render ─────────────────────────────────────────────────────────────

export function renderTaskPanel(ctx: TaskPanelContext): string {
  const { schedule, sourceName, numDays, baseDate, isSmallScreen } = ctx;

  const tasks = schedule.tasks
    .filter((t) => taskKey(t) === sourceName)
    .sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());

  if (tasks.length === 0) return TASK_PANEL_EMPTY;

  const taskIdSet = new Set(tasks.map((t) => t.id));
  const relevantAssignments = schedule.assignments.filter((a) => taskIdSet.has(a.taskId));
  const assignmentsByTask = new Map<string, Assignment[]>();
  for (const a of relevantAssignments) {
    const arr = assignmentsByTask.get(a.taskId) || [];
    arr.push(a);
    assignmentsByTask.set(a.taskId, arr);
  }

  // Build unfilled list (task + slot still missing an assignment)
  interface Unfilled {
    task: Task;
    slot: SlotRequirement;
    dayIndex: number;
  }
  const unfilled: Unfilled[] = [];
  for (const task of tasks) {
    const taskAssignments = assignmentsByTask.get(task.id) || [];
    const filledSlotIds = new Set(taskAssignments.map((a) => a.slotId));
    for (const slot of task.slots) {
      if (!filledSlotIds.has(slot.slotId)) {
        unfilled.push({ task, slot, dayIndex: dayIndexOf(task, baseDate, schedule.algorithmSettings.dayStartHour) });
      }
    }
  }
  const unfilledCount = unfilled.length;

  let html = '';
  html += renderTopBar(tasks, unfilledCount);

  // On phone, surface unfilled-first. On desktop, still above the timeline.
  if (unfilledCount > 0) html += renderNeedsAttention(unfilled, ctx.showSosButtons);

  html += '<div class="task-panel-grid">';

  html += '<div class="task-panel-left">';
  if (isSmallScreen) {
    html += renderDayStack(tasks, assignmentsByTask, schedule, numDays, baseDate, ctx);
  } else {
    html += renderWeekTimeline(tasks, assignmentsByTask, schedule, numDays, baseDate, ctx);
  }
  html += '</div>';

  html += '<div class="task-panel-right">';
  html += renderRequirementsCard(tasks[0]);
  html += renderConstraintsCard(tasks[0], schedule);
  html += renderWorkloadDistribution(tasks, relevantAssignments, schedule.participants);
  html += '</div>';

  html += '</div>';
  return html;
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────

function renderTopBar(tasks: Task[], unfilled: number): string {
  const first = tasks[0];
  const color = first.color || '#7f8c8d';
  const name = first.sourceName || first.name;

  const windows = first.loadWindows || [];
  const hotLabel = windows.length > 0 ? windows.map(fmtWindow).join(' · ') : 'אין';

  const unfilledKpi =
    unfilled > 0
      ? `<div class="task-panel-kpi kpi-danger">
          <span class="task-panel-kpi-value">${unfilled}</span>
          <span class="task-panel-kpi-label">סלוטים פתוחים</span>
        </div>`
      : `<div class="task-panel-kpi kpi-ok">
          <span class="task-panel-kpi-value">✓</span>
          <span class="task-panel-kpi-label">משובץ במלואו</span>
        </div>`;

  return `
  <div class="task-panel-topbar">
    <button class="btn-back" data-action="back-to-schedule" title="חזור לשבצ&quot;ק">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>חזור לשבצ"ק</span>
    </button>
    <div class="task-panel-identity">
      <h2 class="task-panel-name" style="border-inline-start:4px solid ${color};padding-inline-start:10px">${escHtml(name)}</h2>
      <div class="task-panel-badges">
        ${taskBadge(first)}
        ${first.isLight ? '<span class="badge badge-sm" style="background:#7f8c8d">קלה</span>' : ''}
        ${first.sameGroupRequired ? '<span class="badge badge-sm" style="background:#8e44ad">קבוצה אחידה</span>' : ''}
        ${first.blocksConsecutive ? '<span class="badge badge-sm" style="background:#c0392b">חוסמת רצף</span>' : ''}
      </div>
      <div class="task-panel-hot-summary">
        <span class="text-muted">חלונות עומס מוגבר:</span>
        <span dir="ltr">${hotLabel}</span>
      </div>
    </div>
    <div class="task-panel-kpis">
      <div class="task-panel-kpi">
        <span class="task-panel-kpi-value">${tasks.length}</span>
        <span class="task-panel-kpi-label">משמרות השבוע</span>
      </div>
      ${unfilledKpi}
    </div>
  </div>`;
}

// ─── Needs Attention ─────────────────────────────────────────────────────────

function renderNeedsAttention(
  unfilled: Array<{ task: Task; slot: SlotRequirement; dayIndex: number }>,
  _showSosButtons?: boolean,
): string {
  const itemsHtml = unfilled
    .map(({ task, slot, dayIndex }) => {
      const slotLabel = slot.subTeamLabel || slot.label || 'משבצת';
      const timeRange = `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`;
      return `<li class="tp-needs-item">
        <span class="tp-needs-day">יום ${dayIndex}</span>
        <span class="tp-needs-time" dir="ltr">${timeRange}</span>
        <span class="tp-needs-slot">${escHtml(slotLabel)}</span>
      </li>`;
    })
    .join('');

  return `<div class="tp-needs-attention">
    <h3 class="tp-needs-title">🚨 דרוש שיבוץ (${unfilled.length})</h3>
    <ul class="tp-needs-list">${itemsHtml}</ul>
  </div>`;
}

// ─── Week Timeline (Desktop) ─────────────────────────────────────────────────

function dayIndexOf(task: Task, baseDate: Date, dayStartHour: number): number {
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0);
  const diffMs = task.timeBlock.start.getTime() - start.getTime();
  return Math.floor(diffMs / 86400000) + 1;
}

function renderWeekTimeline(
  tasks: Task[],
  assignmentsByTask: Map<string, Assignment[]>,
  schedule: Schedule,
  numDays: number,
  baseDate: Date,
  ctx: TaskPanelContext,
): string {
  const dayStartHour = schedule.algorithmSettings.dayStartHour;
  const loadWindows = tasks[0].loadWindows || [];
  const dayMs = 86400000;

  // Group tasks by day index (anchored by start). Cross-day bleeding is handled by ghost continuation.
  const byDay = new Map<number, Task[]>();
  for (const t of tasks) {
    const d = dayIndexOf(t, baseDate, dayStartHour);
    if (d < 1 || d > numDays) continue;
    const arr = byDay.get(d) || [];
    arr.push(t);
    byDay.set(d, arr);
  }

  // Determine per-lane max slot count (so lane body height can fit the thickest shift)
  function laneMaxSlots(d: number): number {
    const dayTasks = byDay.get(d) || [];
    let m = 1;
    for (const t of dayTasks) m = Math.max(m, t.slots.length);
    // Also include any ghost continuations that land in day d
    for (const t of tasks) {
      const dStart = dayIndexOf(t, baseDate, dayStartHour);
      if (dStart + 1 !== d) continue;
      if (t.timeBlock.end.getTime() > laneStartMs(d, baseDate, dayStartHour)) {
        m = Math.max(m, t.slots.length);
      }
    }
    return m;
  }

  // Render hour ruler (every 4 hours)
  const rulerTicks: string[] = [];
  for (let h = 0; h <= 24; h += 4) {
    const hourLabel = (dayStartHour + h) % 24;
    const leftPct = (h / 24) * 100;
    rulerTicks.push(`<span class="tp-ruler-tick" style="inset-inline-start:${leftPct}%">${pad2(hourLabel)}:00</span>`);
  }

  let html = '<div class="task-panel-card task-panel-timeline-card">';
  html += '<h3 class="task-panel-card-title">📆 השבוע במבט-על</h3>';
  html += '<div class="task-panel-timeline">';
  html += `<div class="tp-timeline-ruler">${rulerTicks.join('')}</div>`;

  for (let d = 1; d <= numDays; d++) {
    const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const laneStart = laneStartMs(d, baseDate, dayStartHour);
    const laneEnd = laneStart + dayMs;
    const maxSlots = laneMaxSlots(d);
    const laneHeight = Math.max(48, maxSlots * 22 + 8);

    let laneContent = '';

    // Hot-window bands: render each loadWindow as a tinted vertical band
    for (const w of loadWindows) {
      const ws = windowStartInLane(w, dayDate, dayStartHour);
      const we = windowEndInLane(w, dayDate, dayStartHour, ws);
      const bs = Math.max(ws, laneStart);
      const be = Math.min(we, laneEnd);
      if (be <= bs) continue;
      const leftPct = ((bs - laneStart) / dayMs) * 100;
      const widthPct = ((be - bs) / dayMs) * 100;
      laneContent += `<div class="tp-hot-band" style="inset-inline-start:${leftPct}%;width:${widthPct}%;" title="עומס מוגבר ${fmtWindow(w)}"></div>`;
    }

    // Shifts anchored on this day
    const dayTasks = byDay.get(d) || [];
    for (const task of dayTasks) {
      laneContent += renderShiftBlock(task, assignmentsByTask, schedule, laneStart, laneEnd, false, ctx);
    }

    // Ghost continuations from the previous day
    for (const task of byDay.get(d - 1) || []) {
      if (task.timeBlock.end.getTime() > laneStart) {
        laneContent += renderShiftBlock(task, assignmentsByTask, schedule, laneStart, laneEnd, true, ctx);
      }
    }

    html += `<div class="tp-lane">
      <div class="tp-lane-header">${fmtDayLabel(dayDate)}</div>
      <div class="tp-lane-body" style="height:${laneHeight}px">${laneContent}</div>
    </div>`;
  }

  html += '</div></div>';
  return html;
}

function laneStartMs(dayIndex: number, baseDate: Date, dayStartHour: number): number {
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate() + dayIndex - 1,
    dayStartHour,
    0,
  ).getTime();
}

function windowStartInLane(w: LoadWindow, dayDate: Date, dayStartHour: number): number {
  // Windows are absolute clock times; if their start hour is BEFORE dayStartHour,
  // they conceptually land on the next calendar day within the operational lane.
  const d = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
  d.setHours(w.startHour, w.startMinute, 0, 0);
  if (w.startHour < dayStartHour) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function windowEndInLane(w: LoadWindow, dayDate: Date, dayStartHour: number, startMs: number): number {
  const d = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate());
  d.setHours(w.endHour, w.endMinute, 0, 0);
  if (w.endHour < dayStartHour || (w.endHour === dayStartHour && w.endMinute === 0)) {
    d.setDate(d.getDate() + 1);
  }
  let endMs = d.getTime();
  // Ensure monotonic against startMs (windows that straddle midnight)
  if (endMs <= startMs) endMs = startMs + 60_000;
  return endMs;
}

function renderShiftBlock(
  task: Task,
  assignmentsByTask: Map<string, Assignment[]>,
  schedule: Schedule,
  laneStart: number,
  laneEnd: number,
  ghost: boolean,
  ctx: TaskPanelContext,
): string {
  const dayMs = 86400000;
  const taskStart = Math.max(task.timeBlock.start.getTime(), laneStart);
  const taskEnd = Math.min(task.timeBlock.end.getTime(), laneEnd);
  if (taskEnd <= taskStart) return '';
  const leftPct = ((taskStart - laneStart) / dayMs) * 100;
  const widthPct = Math.max(6, ((taskEnd - taskStart) / dayMs) * 100);

  const pMap = new Map(schedule.participants.map((p) => [p.id, p]));
  const assignments = assignmentsByTask.get(task.id) || [];
  const assignMap = new Map(assignments.map((a) => [a.slotId, a]));

  const slotsHtml = renderGroupedSlots(task, assignMap, pMap, ctx);

  const classes = ['tp-shift', 'task-tooltip-hover'];
  if (ghost) classes.push('tp-shift-continues');

  const timeLabel = `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`;
  return `<div class="${classes.join(' ')}"
    data-task-id="${escHtml(task.id)}"
    style="inset-inline-start:${leftPct}%;width:${widthPct}%;--tp-shift-color:${task.color || '#7f8c8d'}"
    title="${escHtml(task.name)} · ${timeLabel}${ghost ? ' (המשך)' : ''}">
    ${ghost ? '<span class="tp-shift-ghost-label">↩ המשך</span>' : `<span class="tp-shift-time" dir="ltr">${timeLabel}</span>`}
    <div class="tp-shift-slots">${slotsHtml}</div>
  </div>`;
}

function renderGroupedSlots(
  task: Task,
  assignMap: Map<string, Assignment>,
  pMap: Map<string, Participant>,
  ctx: TaskPanelContext,
): string {
  type Group = { key: string; label: string; slots: SlotRequirement[] };
  const groups: Group[] = [];
  for (const slot of task.slots) {
    const key = slot.subTeamId || slot.subTeamLabel || '__none__';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.slots.push(slot);
    } else {
      groups.push({ key, label: slot.subTeamLabel || '', slots: [slot] });
    }
  }
  const hasSubTeam = groups.some((g) => g.key !== '__none__');
  if (!hasSubTeam) {
    return task.slots.map((slot) => renderSlotCell(slot, assignMap.get(slot.slotId), pMap, task, ctx)).join('');
  }
  return groups
    .map((g) => {
      const hide = g.key !== '__none__';
      const cells = g.slots
        .map((slot) => renderSlotCell(slot, assignMap.get(slot.slotId), pMap, task, ctx, hide))
        .join('');
      if (g.key === '__none__') return cells;
      return `<div class="tp-subteam-group" data-subteam="${escHtml(g.key)}">
        ${g.label ? `<span class="tp-subteam-label">${escHtml(g.label)}</span>` : ''}
        <div class="tp-subteam-slots">${cells}</div>
      </div>`;
    })
    .join('');
}

function renderSlotCell(
  slot: SlotRequirement,
  assignment: Assignment | undefined,
  pMap: Map<string, Participant>,
  task: Task,
  ctx: TaskPanelContext,
  hideSubTeamLabel = false,
): string {
  const slotLabel = hideSubTeamLabel ? slot.label || '' : slot.subTeamLabel || slot.label || '';
  if (!assignment) {
    return `<div class="tp-slot-cell tp-slot-unfilled"
      data-task-id="${escHtml(task.id)}"
      data-slot-id="${escHtml(slot.slotId)}"
      title="דרוש שיבוץ${slotLabel ? ' · ' + slotLabel : ''}">
      <span class="tp-slot-empty-label">דרוש שיבוץ</span>
      ${slotLabel ? `<span class="tp-slot-sublabel">${escHtml(slotLabel)}</span>` : ''}
    </div>`;
  }
  const p = pMap.get(assignment.participantId);
  if (!p) return '';
  const isFrozen = ctx.frozenAssignmentIds?.has(assignment.id) ?? false;
  const gColor = groupColor(p.group);
  const lvlColor = LEVEL_COLORS[p.level];
  const sos =
    ctx.showSosButtons && !isFrozen
      ? `<button class="btn-icon-sm btn-rescue" data-assignment-id="${escHtml(assignment.id)}" title="חילוץ">🆘</button>
       <button class="btn-icon-sm btn-swap" data-assignment-id="${escHtml(assignment.id)}" title="החלפה">⇄</button>`
      : isFrozen
        ? '<span class="frozen-action-icon" title="מוקפא">🧊</span>'
        : '';
  return `<div class="tp-slot-cell tp-slot-filled" style="--tp-slot-group:${gColor}">
    <span class="tp-slot-level" style="background:${lvlColor}">${p.level}</span>
    <span class="participant-hover tp-slot-name" data-pid="${escHtml(p.id)}" data-assignment-id="${escHtml(assignment.id)}" style="color:${gColor}">${escHtml(p.name)}</span>
    ${slotLabel ? `<span class="tp-slot-sublabel">${escHtml(slotLabel)}</span>` : ''}
    <span class="tp-slot-actions">${sos}</span>
  </div>`;
}

// ─── Day Stack (Phone) ───────────────────────────────────────────────────────

function renderDayStack(
  tasks: Task[],
  assignmentsByTask: Map<string, Assignment[]>,
  schedule: Schedule,
  numDays: number,
  baseDate: Date,
  ctx: TaskPanelContext,
): string {
  const dayStartHour = schedule.algorithmSettings.dayStartHour;
  const byDay = new Map<number, Task[]>();
  for (const t of tasks) {
    const d = dayIndexOf(t, baseDate, dayStartHour);
    if (d < 1 || d > numDays) continue;
    const arr = byDay.get(d) || [];
    arr.push(t);
    byDay.set(d, arr);
  }

  const pMap = new Map(schedule.participants.map((p) => [p.id, p]));
  const dayCards: string[] = [];

  for (let d = 1; d <= numDays; d++) {
    const dayTasks = byDay.get(d) || [];
    const dayDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayHasUnfilled = dayTasks.some((task) => {
      const filled = new Set((assignmentsByTask.get(task.id) || []).map((a) => a.slotId));
      return task.slots.some((s) => !filled.has(s.slotId));
    });
    const open = d === 1 || dayHasUnfilled;

    let shiftsHtml = '';
    if (dayTasks.length === 0) {
      shiftsHtml = '<p class="text-muted tp-day-empty">אין משמרות ביום זה</p>';
    } else {
      shiftsHtml = dayTasks
        .map((task) => {
          const timeLabel = `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`;
          const hotRanges = shiftHotOverlaps(task);
          const hotBadges = hotRanges
            .map(
              (r) =>
                `<span class="tp-shift-hot-badge" dir="ltr" title="עומס מוגבר">🔥 ${fmt(r.start)}–${fmt(r.end)}</span>`,
            )
            .join('');
          const assignments = assignmentsByTask.get(task.id) || [];
          const assignMap = new Map(assignments.map((a) => [a.slotId, a]));
          const slotRows = renderGroupedSlots(task, assignMap, pMap, ctx);
          return `<div class="tp-mobile-shift">
            <div class="tp-mobile-shift-header">
              <span class="tp-mobile-shift-time" dir="ltr">${timeLabel}</span>
              ${hotBadges}
            </div>
            <div class="tp-mobile-slots">${slotRows}</div>
          </div>`;
        })
        .join('');
    }

    dayCards.push(`<details class="tp-day-card" ${open ? 'open' : ''}>
      <summary class="tp-day-card-summary">
        <span class="tp-day-card-title">${fmtDayLabel(dayDate)}</span>
        <span class="tp-day-card-count">${dayTasks.length} משמרות</span>
      </summary>
      <div class="tp-day-card-body">${shiftsHtml}</div>
    </details>`);
  }

  return `<div class="task-panel-card">
    <h3 class="task-panel-card-title">📆 השבוע לפי ימים</h3>
    <div class="tp-day-stack">${dayCards.join('')}</div>
  </div>`;
}

// ─── Requirements Card ───────────────────────────────────────────────────────

function renderRequirementsCard(firstTask: Task): string {
  // Group by signature
  const groups = new Map<string, { slots: SlotRequirement[]; sig: SlotRequirement }>();
  for (const s of firstTask.slots) {
    const key = slotSignature(s);
    const g = groups.get(key);
    if (g) g.slots.push(s);
    else groups.set(key, { slots: [s], sig: s });
  }

  const rows: string[] = [];
  for (const { slots, sig } of groups.values()) {
    const levelsHtml = sig.acceptableLevels
      .sort((a, b) => a.level - b.level)
      .map((l) => {
        const badge = levelBadge(l.level);
        return l.lowPriority
          ? badge.replace(
              '<span class="badge"',
              '<span class="badge badge-sm tp-level-lowprio" title="דרגה זו מותרת אך בעדיפות נמוכה"',
            )
          : badge.replace('<span class="badge"', '<span class="badge badge-sm"');
      })
      .join('');
    const reqHtml = (sig.requiredCertifications || []).map((c) => certBadge(c)).join('');
    const fbdHtml = (sig.forbiddenCertifications || [])
      .map((c) => certBadge(c).replace('<span class="', '<span class="tp-cert-forbidden '))
      .join('');
    const subTeamHtml = sig.subTeamLabel ? `<span class="tp-req-team">${escHtml(sig.subTeamLabel)}</span>` : '';

    rows.push(`<li class="tp-req-row">
      <span class="tp-req-count">${slots.length}×</span>
      ${subTeamHtml}
      <span class="tp-req-chips">${levelsHtml}${reqHtml}${fbdHtml}</span>
    </li>`);
  }

  return `<div class="task-panel-card">
    <h3 class="task-panel-card-title">📋 דרישות משבצת</h3>
    <ul class="tp-req-list">${rows.join('')}</ul>
  </div>`;
}

// ─── Constraints Card ────────────────────────────────────────────────────────

function renderConstraintsCard(firstTask: Task, schedule: Schedule): string {
  const items: string[] = [];
  items.push(
    `<div class="tp-meta-row"><span class="tp-meta-label">משקל בסיס</span><span class="tp-meta-value">${(firstTask.baseLoadWeight ?? 1).toFixed(2)}</span></div>`,
  );
  const windows = firstTask.loadWindows || [];
  for (const w of windows) {
    items.push(
      `<div class="tp-meta-row"><span class="tp-meta-label">עומס מוגבר <span class="tp-meta-sublabel" dir="ltr">${fmtWindow(w)}</span></span><span class="tp-meta-value">×${w.weight.toFixed(2)}</span></div>`,
    );
  }
  items.push(
    `<div class="tp-meta-row"><span class="tp-meta-label">חוסמת רצף</span><span class="tp-meta-value">${firstTask.blocksConsecutive ? 'כן' : 'לא'}</span></div>`,
  );
  items.push(
    `<div class="tp-meta-row"><span class="tp-meta-label">נדרשת אותה הקבוצה</span><span class="tp-meta-value">${firstTask.sameGroupRequired ? 'כן' : 'לא'}</span></div>`,
  );
  items.push(
    `<div class="tp-meta-row"><span class="tp-meta-label">קלה (לא שוברת מנוחה)</span><span class="tp-meta-value">${firstTask.isLight ? 'כן' : 'לא'}</span></div>`,
  );
  if (firstTask.restRuleId) {
    const gapMs = schedule.restRuleSnapshot[firstTask.restRuleId];
    const gapLabel = gapMs != null ? `${(gapMs / 3600000).toFixed(1)}ש'` : '—';
    items.push(
      `<div class="tp-meta-row"><span class="tp-meta-label">פער מנוחה מינימלי</span><span class="tp-meta-value">${gapLabel}</span></div>`,
    );
  }

  return `<div class="task-panel-card">
    <h3 class="task-panel-card-title">⚙️ תכונות משימה</h3>
    <div class="tp-meta-list">${items.join('')}</div>
  </div>`;
}

// ─── Workload Distribution ──────────────────────────────────────────────────

function renderWorkloadDistribution(tasks: Task[], assignments: Assignment[], participants: Participant[]): string {
  const pMap = new Map(participants.map((p) => [p.id, p]));
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const hoursByPid = new Map<string, { hours: number; count: number }>();
  for (const a of assignments) {
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
    const cur = hoursByPid.get(a.participantId) || { hours: 0, count: 0 };
    cur.hours += hrs;
    cur.count += 1;
    hoursByPid.set(a.participantId, cur);
  }

  const rows = [...hoursByPid.entries()]
    .map(([pid, agg]) => ({ p: pMap.get(pid), ...agg }))
    .filter((r) => r.p)
    .sort((a, b) => b.hours - a.hours);

  if (rows.length === 0) {
    return `<div class="task-panel-card">
      <h3 class="task-panel-card-title">👥 פילוח עומס לפי משתתפים</h3>
      <p class="text-muted">אין שיבוצים למשימה זו.</p>
    </div>`;
  }

  const max = Math.max(...rows.map((r) => r.hours), 1);
  const barsHtml = rows
    .map((r) => {
      const p = r.p!;
      const pct = (r.hours / max) * 100;
      const gc = groupColor(p.group);
      return `<div class="breakdown-row">
        <span class="breakdown-label">
          <span class="participant-hover" data-pid="${escHtml(p.id)}" style="cursor:pointer;text-decoration:underline dotted;color:${gc}">${escHtml(p.name)}</span>
        </span>
        <div class="breakdown-bar-bg">
          <div class="breakdown-bar-fill" style="width:${pct}%;background:${gc}"></div>
        </div>
        <span class="breakdown-value">${r.count}× · ${r.hours.toFixed(1)}ש'</span>
      </div>`;
    })
    .join('');

  return `<div class="task-panel-card">
    <h3 class="task-panel-card-title">👥 פילוח עומס לפי משתתפים</h3>
    <div class="metrics-breakdown">${barsHtml}</div>
  </div>`;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireTaskPanelEvents(
  container: HTMLElement,
  onBack: () => void,
  onSwap: (assignmentId: string) => void,
  onRescue: (assignmentId: string) => void,
): void {
  // Participant-name clicks are handled by wireParticipantTooltip (hover/tap
  // shows the tooltip; on touch it's a bottom sheet with a "צפה בפרופיל"
  // button, on desktop it navigates on click via the shared tooltip wiring).
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const backBtn = target.closest('[data-action="back-to-schedule"]') as HTMLElement | null;
    if (backBtn) {
      onBack();
      return;
    }

    const swapBtn = target.closest('.btn-swap[data-assignment-id]') as HTMLElement | null;
    if (swapBtn?.dataset.assignmentId) {
      e.stopPropagation();
      onSwap(swapBtn.dataset.assignmentId);
      return;
    }

    const rescueBtn = target.closest('.btn-rescue[data-assignment-id]') as HTMLElement | null;
    if (rescueBtn?.dataset.assignmentId) {
      e.stopPropagation();
      onRescue(rescueBtn.dataset.assignmentId);
      return;
    }
  });
}
