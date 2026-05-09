/**
 * Point-in-Time Status View — "Where is everyone now?"
 *
 * Full-screen overlay that, given a single timestamp, classifies every
 * participant in the frozen schedule snapshot as one of:
 *   - assigned  → currently inside a task's timeBlock
 *   - recovery  → inside an HC-15 recovery window from a previous task
 *   - unavailable → master availability gap, dateUnavailability rule, or
 *                   schedule-scoped scheduleUnavailability entry
 *   - free      → none of the above
 *
 * Read-only by design. Clicking a participant opens their profile; clicking
 * a task chip opens the task panel — same callbacks the schedule grid uses.
 *
 * Reads exclusively from the frozen schedule passed via context — never from
 * the live config store.
 *
 * Caveat: phantom assignments (continuity-snapshot context for HC-12/14
 * cross-boundary enforcement) are optimizer-internal and never appear on
 * `schedule.assignments`. So picking a moment before periodStart + dayStartHour
 * cannot reconstruct what a participant was "doing" pre-schedule — most rows
 * fall into "free" and a boundary banner is shown.
 */

import { getRecoveryWindow } from '../constraints/sleep-recovery';
import { getAnchorDayIndex } from '../engine/temporal';
import type { Participant, Schedule, Task } from '../models/types';
import {
  hourInOpDay,
  isBlockedByDateUnavailability,
  isFullyCovered,
  type ScheduleContext,
} from '../shared/utils/time-utils';
import { operationalHourOrder, timestampToOpDayIndex } from './schedule-utils';
import { escAttr, escHtml, fmt, groupColor } from './ui-helpers';
import { renderCustomSelect, wireCustomSelect } from './ui-modal';

// ─── Context ─────────────────────────────────────────────────────────────────

export interface PointInTimeContext {
  schedule: Schedule;
  /** The exact moment to inspect. */
  timestamp: Date;
  /** Whether the "פנויים" section starts collapsed. Toggled by user. */
  freeCollapsed: boolean;
  /** Called when the user changes day or hour. */
  onTimestampChange: (t: Date) => void;
  /** Called when the user toggles the "פנויים" section. */
  onToggleFreeCollapsed: () => void;
  /** Called when the user clicks the back button. */
  onBack: () => void;
  /** Click on a participant row. */
  onNavigateToProfile: (participantId: string) => void;
  /** Click on a task chip. */
  onNavigateToTaskPanel: (sourceName: string) => void;
}

// ─── Status Detection ────────────────────────────────────────────────────────

type PointInTimeStatus =
  | { kind: 'assigned'; task: Task }
  | { kind: 'recovery'; recoveryEnd: Date; sourceTask: Task }
  | { kind: 'unavailable'; reason: string; sourceKind: 'availability' | 'dateRule' | 'scheduleUnavailability' }
  | { kind: 'free' };

function getPointInTimeStatus(
  p: Participant,
  schedule: Schedule,
  taskMap: Map<string, Task>,
  t: Date,
  scheduleCtx: ScheduleContext,
): PointInTimeStatus {
  const tMs = t.getTime();

  // 1) Assigned — currently inside a task time block
  for (const a of schedule.assignments) {
    if (a.participantId !== p.id) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    const start = task.timeBlock.start.getTime();
    const end = task.timeBlock.end.getTime();
    if (start <= tMs && tMs < end) {
      return { kind: 'assigned', task };
    }
  }

  // 2) Recovery — inside an HC-15 window of a finished assigned task
  for (const a of schedule.assignments) {
    if (a.participantId !== p.id) continue;
    const task = taskMap.get(a.taskId);
    if (!task) continue;
    const win = getRecoveryWindow(task);
    if (!win) continue;
    if (win.start.getTime() <= tMs && tMs < win.end.getTime()) {
      return { kind: 'recovery', recoveryEnd: win.end, sourceTask: task };
    }
  }

  // 3) Unavailable — three sources, mirroring HC-3
  const pointBlock = { start: t, end: new Date(tMs + 1) };

  // 3a) schedule-scoped (Future SOS) — most specific, surfaces user reason
  if (schedule.scheduleUnavailability) {
    for (const u of schedule.scheduleUnavailability) {
      if (u.participantId !== p.id) continue;
      if (u.start.getTime() <= tMs && tMs < u.end.getTime()) {
        return {
          kind: 'unavailable',
          reason: u.reason?.trim() || 'לא זמין',
          sourceKind: 'scheduleUnavailability',
        };
      }
    }
  }

  // 3b) recurring dateUnavailability rules
  if (p.dateUnavailability && p.dateUnavailability.length > 0) {
    if (isBlockedByDateUnavailability(pointBlock, p.dateUnavailability, scheduleCtx)) {
      // Look up the matching rule for its reason text
      const matchingReason = findDateRuleReason(p, t, scheduleCtx);
      return {
        kind: 'unavailable',
        reason: matchingReason || 'לא זמין',
        sourceKind: 'dateRule',
      };
    }
  }

  // 3c) master availability windows — gaps mean unavailable
  if (p.availability && p.availability.length > 0) {
    if (!isFullyCovered(pointBlock, p.availability)) {
      return { kind: 'unavailable', reason: 'מחוץ לזמינות', sourceKind: 'availability' };
    }
  }

  return { kind: 'free' };
}

/** Find the first dateUnavailability rule whose computed window contains t — for the reason text. */
function findDateRuleReason(p: Participant, t: Date, ctx: ScheduleContext): string | null {
  const tMs = t.getTime();
  for (const rule of p.dateUnavailability) {
    if (!Number.isInteger(rule.dayIndex)) continue;
    const startIdx = Math.max(1, rule.dayIndex);
    const endIdx = Math.min(ctx.scheduleDays, rule.endDayIndex ?? rule.dayIndex);
    if (endIdx < 1 || startIdx > ctx.scheduleDays || endIdx < startIdx) continue;

    let blockStartMs: number;
    let blockEndMs: number;
    if (rule.allDay) {
      blockStartMs = new Date(
        ctx.baseDate.getFullYear(),
        ctx.baseDate.getMonth(),
        ctx.baseDate.getDate() + startIdx - 1,
        ctx.dayStartHour,
        0,
      ).getTime();
      blockEndMs = new Date(
        ctx.baseDate.getFullYear(),
        ctx.baseDate.getMonth(),
        ctx.baseDate.getDate() + endIdx,
        ctx.dayStartHour,
        0,
      ).getTime();
    } else {
      blockStartMs = hourInOpDay(ctx.baseDate, ctx.dayStartHour, startIdx, rule.startHour);
      blockEndMs = hourInOpDay(ctx.baseDate, ctx.dayStartHour, endIdx, rule.endHour);
      if (blockEndMs <= blockStartMs) blockEndMs += 24 * 3600 * 1000;
    }
    if (blockStartMs <= tMs && tMs < blockEndMs) {
      return rule.reason?.trim() || null;
    }
  }
  return null;
}

// ─── Render ──────────────────────────────────────────────────────────────────

interface AssignedGroup {
  participants: Participant[];
  byTask: Map<string, { task: Task; members: Participant[] }>;
}
interface RecoveryGroup {
  participants: Participant[];
  byPid: Map<string, { recoveryEnd: Date; sourceTask: Task }>;
}
interface UnavailableGroup {
  participants: Participant[];
  byPid: Map<string, { reason: string; sourceKind: string }>;
}
interface FreeGroup {
  participants: Participant[];
}

function classifyAll(
  schedule: Schedule,
  t: Date,
): {
  assigned: AssignedGroup;
  recovery: RecoveryGroup;
  unavailable: UnavailableGroup;
  free: FreeGroup;
} {
  const taskMap = new Map<string, Task>();
  for (const task of schedule.tasks) taskMap.set(task.id, task);

  const ctx: ScheduleContext = {
    baseDate: schedule.periodStart,
    scheduleDays: schedule.periodDays,
    dayStartHour: schedule.algorithmSettings.dayStartHour,
  };

  const assigned: AssignedGroup = { participants: [], byTask: new Map() };
  const recovery: RecoveryGroup = { participants: [], byPid: new Map() };
  const unavailable: UnavailableGroup = { participants: [], byPid: new Map() };
  const free: FreeGroup = { participants: [] };

  for (const p of schedule.participants) {
    const status = getPointInTimeStatus(p, schedule, taskMap, t, ctx);
    switch (status.kind) {
      case 'assigned': {
        assigned.participants.push(p);
        const taskKey = status.task.id;
        let bucket = assigned.byTask.get(taskKey);
        if (!bucket) {
          bucket = { task: status.task, members: [] };
          assigned.byTask.set(taskKey, bucket);
        }
        bucket.members.push(p);
        break;
      }
      case 'recovery': {
        recovery.participants.push(p);
        recovery.byPid.set(p.id, {
          recoveryEnd: status.recoveryEnd,
          sourceTask: status.sourceTask,
        });
        break;
      }
      case 'unavailable': {
        unavailable.participants.push(p);
        unavailable.byPid.set(p.id, {
          reason: status.reason,
          sourceKind: status.sourceKind,
        });
        break;
      }
      case 'free':
        free.participants.push(p);
        break;
    }
  }

  return { assigned, recovery, unavailable, free };
}

function sortByName(list: Participant[]): Participant[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

/**
 * Name span tinted with the participant's group color, mirroring the
 * schedule-grid coloring so users can match a row to its group at a glance.
 */
function nameSpan(p: Participant): string {
  const color = groupColor(p.group);
  return `<span class="pit-row-name" style="color:${color}">${escHtml(p.name)}</span>`;
}

export function renderPointInTimeView(ctx: PointInTimeContext): string {
  const { schedule, timestamp, freeCollapsed } = ctx;
  const dsh = schedule.algorithmSettings.dayStartHour;
  const numDays = schedule.periodDays;

  // Resolve the picker's day index. When timestamp falls outside [day1..dayN]
  // (anchor index 0 or numDays+1), clamp the picker to a valid day for display.
  const anchorIdx = getAnchorDayIndex(schedule.periodStart, numDays, timestamp, dsh);
  const pickerDay = Math.max(1, Math.min(numDays, anchorIdx === 0 ? 1 : anchorIdx));
  const pickerHour = timestamp.getHours();

  const dayOpts = [];
  for (let d = 1; d <= numDays; d++) {
    dayOpts.push({ value: String(d), label: `יום ${d}`, selected: d === pickerDay });
  }
  const hourOpts = operationalHourOrder(dsh).map((h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
    selected: h === pickerHour,
  }));

  // ── Header ──
  let html = `<div class="pit-header">
    <button class="btn-back" id="btn-pit-back" type="button" title="חזור לשבצ&quot;ק" aria-label="חזור לשבצ&quot;ק">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="btn-back-label">חזור לשבצ"ק</span>
    </button>
    <h2 class="pit-title">איפה כולם?</h2>
    <div class="pit-pickers">
      <span class="pit-picker-label">זמן:</span>
      ${renderCustomSelect({ id: 'gm-pit-day', options: dayOpts, className: 'input-sm' })}
      ${renderCustomSelect({ id: 'gm-pit-hour', options: hourOpts, className: 'input-sm' })}
    </div>
  </div>`;

  // ── Boundary banners ──
  if (anchorIdx === 0) {
    html += `<div class="pit-banner">📋 המועד שבחרת לפני תחילת השבצ"ק (יום 1 מתחיל ב-${String(dsh).padStart(2, '0')}:00).</div>`;
  } else if (anchorIdx > numDays) {
    html += `<div class="pit-banner">📋 המועד שבחרת אחרי סוף השבצ"ק.</div>`;
  }

  // ── Classify and render sections ──
  const { assigned, recovery, unavailable, free } = classifyAll(schedule, timestamp);

  html += '<div class="pit-sections">';
  html += renderAssignedSection(assigned);
  html += renderRecoverySection(recovery, schedule);
  html += renderUnavailableSection(unavailable);
  html += renderFreeSection(free, freeCollapsed);
  html += '</div>';

  return html;
}

function renderAssignedSection(group: AssignedGroup): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-empty" open>
      <summary><span class="pit-section-icon">⚒</span><span class="pit-section-title">משובצים</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">אין משובצים בשעה זו.</div>
    </details>`;
  }
  // Sort tasks by start time so soonest-running shows first.
  const taskBuckets = Array.from(group.byTask.values()).sort(
    (a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime(),
  );
  let body = '';
  for (const { task, members } of taskBuckets) {
    const sourceName = task.sourceName || task.name;
    const taskTime = `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`;
    body += `<div class="pit-task-group">
      <div class="pit-task-header">
        <button class="pit-task-chip" type="button" data-source-name="${escAttr(sourceName)}" title="פתח פאנל משימה">
          ${escHtml(sourceName)}
        </button>
        <span class="pit-task-time">${escHtml(taskTime)}</span>
        <span class="pit-task-count">${members.length}</span>
      </div>
      <ul class="pit-row-list">
        ${sortByName(members)
          .map(
            (p) =>
              `<li class="pit-row" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
                ${nameSpan(p)}
              </li>`,
          )
          .join('')}
      </ul>
    </div>`;
  }
  return `<details class="pit-section pit-section-assigned" open>
    <summary><span class="pit-section-icon">⚒</span><span class="pit-section-title">משובצים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">${body}</div>
  </details>`;
}

function renderRecoverySection(group: RecoveryGroup, schedule: Schedule): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-empty" open>
      <summary><span class="pit-section-icon">😴</span><span class="pit-section-title">במנוחה</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">איש לא במנוחה כרגע.</div>
    </details>`;
  }
  const sorted = sortByName(group.participants);
  const rows = sorted
    .map((p) => {
      const meta = group.byPid.get(p.id);
      if (!meta) return '';
      const sourceName = meta.sourceTask.sourceName || meta.sourceTask.name;
      const endOnly = formatRecoveryEndOnly(meta.recoveryEnd, schedule);
      return `<li class="pit-row" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
        ${nameSpan(p)}
        <span class="pit-row-meta">
          <span class="pit-row-meta-text">במנוחה עד ${escHtml(endOnly)}</span>
          <button class="pit-task-chip pit-task-chip-inline" type="button" data-source-name="${escAttr(sourceName)}" title="פתח פאנל משימה" tabindex="-1">
            ${escHtml(sourceName)}
          </button>
        </span>
      </li>`;
    })
    .join('');
  return `<details class="pit-section pit-section-recovery" open>
    <summary><span class="pit-section-icon">😴</span><span class="pit-section-title">במנוחה</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list">${rows}</ul>
    </div>
  </details>`;
}

function formatRecoveryEndOnly(endDate: Date, schedule: Schedule): string {
  const day = timestampToOpDayIndex(endDate, schedule);
  return `יום ${day} ${fmt(endDate)}`;
}

function renderUnavailableSection(group: UnavailableGroup): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-empty" open>
      <summary><span class="pit-section-icon">🚫</span><span class="pit-section-title">לא זמינים</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">כולם זמינים.</div>
    </details>`;
  }
  const sorted = sortByName(group.participants);
  const rows = sorted
    .map((p) => {
      const meta = group.byPid.get(p.id);
      if (!meta) return '';
      return `<li class="pit-row" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
        ${nameSpan(p)}
        <span class="pit-row-meta">
          <span class="pit-row-meta-text">${escHtml(meta.reason)}</span>
        </span>
      </li>`;
    })
    .join('');
  return `<details class="pit-section pit-section-unavailable" open>
    <summary><span class="pit-section-icon">🚫</span><span class="pit-section-title">לא זמינים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list">${rows}</ul>
    </div>
  </details>`;
}

function renderFreeSection(group: FreeGroup, collapsed: boolean): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-empty" open>
      <summary><span class="pit-section-icon">⏸</span><span class="pit-section-title">פנויים</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">אף אחד לא פנוי.</div>
    </details>`;
  }
  const sorted = sortByName(group.participants);
  const rows = sorted
    .map(
      (p) =>
        `<li class="pit-row" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
          ${nameSpan(p)}
        </li>`,
    )
    .join('');
  return `<details class="pit-section pit-section-free" id="pit-section-free"${collapsed ? '' : ' open'}>
    <summary><span class="pit-section-icon">⏸</span><span class="pit-section-title">פנויים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list">${rows}</ul>
    </div>
  </details>`;
}

// ─── Wire ────────────────────────────────────────────────────────────────────

export function wirePointInTimeEvents(root: HTMLElement, ctx: PointInTimeContext): void {
  const { schedule, timestamp } = ctx;

  // Back button
  const backBtn = root.querySelector('#btn-pit-back') as HTMLButtonElement | null;
  if (backBtn) backBtn.addEventListener('click', ctx.onBack);

  // Day / hour pickers
  let pendingDay = String(Math.max(1, Math.min(schedule.periodDays, timestampToOpDayIndex(timestamp, schedule))));
  let pendingHour = String(timestamp.getHours());

  const updateTimestamp = () => {
    const dayIdx = parseInt(pendingDay, 10);
    const hour = parseInt(pendingHour, 10);
    if (Number.isNaN(dayIdx) || Number.isNaN(hour)) return;
    const ms = hourInOpDay(schedule.periodStart, schedule.algorithmSettings.dayStartHour, dayIdx, hour);
    ctx.onTimestampChange(new Date(ms));
  };
  wireCustomSelect(root, 'gm-pit-day', (v) => {
    pendingDay = v;
    updateTimestamp();
  });
  wireCustomSelect(root, 'gm-pit-hour', (v) => {
    pendingHour = v;
    updateTimestamp();
  });

  // Free section toggle persistence (so a time change doesn't re-collapse it)
  const freeSection = root.querySelector('#pit-section-free') as HTMLDetailsElement | null;
  if (freeSection) {
    freeSection.addEventListener('toggle', () => {
      const wantCollapsed = !freeSection.open;
      if (wantCollapsed !== ctx.freeCollapsed) {
        ctx.onToggleFreeCollapsed();
      }
    });
  }

  // Row clicks → profile; chip clicks → task panel.
  // Listen on root so both keyboard (Enter/Space) and click work.
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest('.pit-task-chip[data-source-name]') as HTMLElement | null;
    if (chip) {
      e.stopPropagation();
      const sourceName = chip.dataset.sourceName;
      if (sourceName) ctx.onNavigateToTaskPanel(sourceName);
      return;
    }
    const row = target.closest('.pit-row[data-pid]') as HTMLElement | null;
    if (row) {
      const pid = row.dataset.pid;
      if (pid) ctx.onNavigateToProfile(pid);
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    const row = target.closest('.pit-row[data-pid]') as HTMLElement | null;
    if (!row) return;
    e.preventDefault();
    const pid = row.dataset.pid;
    if (pid) ctx.onNavigateToProfile(pid);
  });
}
