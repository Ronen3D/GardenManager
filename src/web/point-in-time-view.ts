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
import { escAttr, escHtml, fmt, getTaskColor, groupColor } from './ui-helpers';
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
 * Sort by group (Hebrew collation) then by name within each group. Used by the
 * free section so participants from the same group cluster visually — their
 * group-tinted names already share a color, so the result is colored bands of
 * names that read naturally as a group at a glance.
 */
function sortByGroupThenName(list: Participant[]): Participant[] {
  return [...list].sort((a, b) => {
    const g = a.group.localeCompare(b.group, 'he');
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, 'he');
  });
}

/** Format a duration (ms) as `H:MM`. Negative/zero clamped to `0:00`. */
function fmtDur(deltaMs: number): string {
  if (deltaMs <= 0) return '0:00';
  const totalMin = Math.round(deltaMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** Compute progress (0..1) of `t` inside `[start, end)`, clamped. */
function progressFraction(start: Date, end: Date, t: Date): number {
  const s = start.getTime();
  const e = end.getTime();
  const tm = t.getTime();
  if (e <= s) return 0;
  return Math.max(0, Math.min(1, (tm - s) / (e - s)));
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

  // ── Classify first so the KPI strip can show counts in the header ──
  const { assigned, recovery, unavailable, free } = classifyAll(schedule, timestamp);

  // ── Header bar (live-mode-controls chrome) + KPI strip ──
  let html = `<div class="pit-bar">
    <button class="btn-back" id="btn-pit-back" type="button" title="חזור לשבצ&quot;ק" aria-label="חזור לשבצ&quot;ק">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7.5 15L12.5 10L7.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="btn-back-label">חזור לשבצ"ק</span>
    </button>
    <h2 class="pit-title">איפה כולם?</h2>
    <div class="pit-pickers">
      <span class="pit-picker-label">זמן:</span>
      ${renderCustomSelect({ id: 'gm-pit-day', options: dayOpts, className: 'input-sm' })}
      ${renderCustomSelect({ id: 'gm-pit-hour', options: hourOpts, className: 'input-sm' })}
    </div>
  </div>`;

  html += renderKpiStrip(
    assigned.participants.length,
    recovery.participants.length,
    unavailable.participants.length,
    free.participants.length,
  );

  // ── Boundary banners ──
  if (anchorIdx === 0) {
    html += `<div class="pit-banner">המועד שבחרת לפני תחילת השבצ"ק (יום 1 מתחיל ב-${String(dsh).padStart(2, '0')}:00).</div>`;
  } else if (anchorIdx > numDays) {
    html += `<div class="pit-banner">המועד שבחרת אחרי סוף השבצ"ק.</div>`;
  }

  // ── Sections (grid: assigned wide-left, recovery+unavailable stacked right, free spans below) ──
  html += '<div class="pit-grid">';
  html += renderAssignedSection(assigned, timestamp);
  html += '<div class="pit-col-secondary">';
  html += renderRecoverySection(recovery, schedule, timestamp);
  html += renderUnavailableSection(unavailable);
  html += '</div>';
  html += renderFreeSection(free, freeCollapsed);
  html += '</div>';

  return html;
}

/**
 * Compact horizontal strip of section totals shown directly below the bar.
 * Mirrors the `.kpi-strip` pattern from `.weekly-dashboard` (subtle dividers,
 * tabular numerics, label below value) but at a smaller scale that suits a
 * picker row rather than a hero card.
 */
function renderKpiStrip(assigned: number, recovery: number, unavailable: number, free: number): string {
  const cells: { kind: string; value: number; label: string }[] = [
    { kind: 'assigned', value: assigned, label: 'משובצים' },
    { kind: 'recovery', value: recovery, label: 'במנוחה' },
    { kind: 'unavailable', value: unavailable, label: 'לא זמינים' },
    { kind: 'free', value: free, label: 'פנויים' },
  ];
  return `<div class="pit-kpi-strip" role="list">${cells
    .map(
      (c) => `<div class="pit-kpi pit-kpi-${c.kind}" role="listitem">
        <span class="pit-kpi-value">${c.value}</span>
        <span class="pit-kpi-label">${c.label}</span>
      </div>`,
    )
    .join('')}</div>`;
}

function renderAssignedSection(group: AssignedGroup, t: Date): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-assigned pit-section-empty" open>
      <summary><span class="pit-section-title">משובצים</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">אין משובצים בשעה זו.</div>
    </details>`;
  }
  // Sort tasks by start time so soonest-running shows first.
  const taskBuckets = Array.from(group.byTask.values()).sort(
    (a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime(),
  );
  let body = '';
  for (const { task, members } of taskBuckets) {
    body += renderTaskGroup(task, members, t);
  }
  return `<details class="pit-section pit-section-assigned" open>
    <summary><span class="pit-section-title">משובצים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">${body}</div>
  </details>`;
}

/**
 * Render one task and its assigned members as a self-contained card.
 * The header carries the task chip (template-color), time range, member count,
 * a thin progress bar showing where `t` falls in `[start, end)`, and a tiny
 * "X% · עוד H:MM" meta. Rows below show level-dot + name only — task-level
 * meta is shared across the group so per-row repetition is avoided.
 */
function renderTaskGroup(task: Task, members: Participant[], t: Date): string {
  const sourceName = task.sourceName || task.name;
  const taskColor = getTaskColor(task);
  const taskTime = `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`;
  const remaining = Math.max(0, task.timeBlock.end.getTime() - t.getTime());
  const remainingLabel = `עוד ${fmtDur(remaining)}`;
  const rows = sortByName(members)
    .map(
      (p) =>
        `<li class="pit-row" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
          ${nameSpan(p)}
        </li>`,
    )
    .join('');
  return `<div class="pit-task-group" style="--task-color:${taskColor}">
    <div class="pit-task-header">
      <button class="pit-task-chip" type="button" data-source-name="${escAttr(sourceName)}" title="פתח פאנל משימה">
        ${escHtml(sourceName)}
      </button>
      <span class="pit-task-time">${escHtml(taskTime)}</span>
      <span class="pit-task-remaining" title="זמן שנותר עד סוף המשימה">${escHtml(remainingLabel)}</span>
      <span class="pit-task-count" title="מספר משובצים במשימה">${members.length}</span>
    </div>
    <ul class="pit-row-list">${rows}</ul>
  </div>`;
}

function renderRecoverySection(group: RecoveryGroup, schedule: Schedule, t: Date): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-recovery pit-section-empty" open>
      <summary><span class="pit-section-title">במנוחה</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">איש לא במנוחה כרגע.</div>
    </details>`;
  }
  const sorted = sortByName(group.participants);
  const rows = sorted
    .map((p) => {
      const meta = group.byPid.get(p.id);
      if (!meta) return '';
      const sourceName = meta.sourceTask.sourceName || meta.sourceTask.name;
      const taskColor = getTaskColor(meta.sourceTask);
      const recoveryWin = getRecoveryWindow(meta.sourceTask);
      const recoveryStart = recoveryWin?.start || meta.sourceTask.timeBlock.end;
      const frac = progressFraction(recoveryStart, meta.recoveryEnd, t);
      const remaining = Math.max(0, meta.recoveryEnd.getTime() - t.getTime());
      const endLabel = formatRecoveryEndOnly(meta.recoveryEnd, schedule);
      return `<li class="pit-row pit-row-recovery" data-pid="${escAttr(p.id)}" tabindex="0" role="button" style="--task-color:${taskColor}">
        ${nameSpan(p)}
        <span class="pit-row-meta">
          <button class="pit-task-chip pit-task-chip-inline" type="button" data-source-name="${escAttr(sourceName)}" title="פתח פאנל משימה" tabindex="-1">
            ${escHtml(sourceName)}
          </button>
          <span class="pit-row-countdown" title="חוזר לזמינות ב-${escAttr(endLabel)}">עוד ${escHtml(fmtDur(remaining))}</span>
        </span>
        <div class="pit-row-progress" aria-hidden="true"><div class="pit-row-progress-fill" style="width:${Math.round(frac * 100)}%"></div></div>
      </li>`;
    })
    .join('');
  return `<details class="pit-section pit-section-recovery" open>
    <summary><span class="pit-section-title">במנוחה</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list">${rows}</ul>
    </div>
  </details>`;
}

function formatRecoveryEndOnly(endDate: Date, schedule: Schedule): string {
  const day = timestampToOpDayIndex(endDate, schedule);
  return `יום ${day} ${fmt(endDate)}`;
}

/**
 * Distinguish *why* a participant is unavailable. Reason text alone is often
 * generic ("לא זמין"); a short kind tag tells the user whether this is a
 * one-off Future-SOS block, a recurring rule, or a master availability gap.
 */
function unavailableKindTag(sourceKind: string): string {
  switch (sourceKind) {
    case 'scheduleUnavailability':
      return '<span class="pit-kind-tag pit-kind-tag-sos" title="חוסר זמינות שנרשם בשבצ&quot;ק זה (Future SOS)">תכנית</span>';
    case 'dateRule':
      return '<span class="pit-kind-tag pit-kind-tag-rule" title="כלל חוסר זמינות חוזר">כלל</span>';
    case 'availability':
      return '<span class="pit-kind-tag pit-kind-tag-avail" title="מחוץ לחלון הזמינות הקבוע">זמינות</span>';
    default:
      return '';
  }
}

function renderUnavailableSection(group: UnavailableGroup): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-unavailable pit-section-empty" open>
      <summary><span class="pit-section-title">לא זמינים</span><span class="pit-section-count">0</span></summary>
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
          <span class="pit-row-reason">${escHtml(meta.reason)}</span>
          ${unavailableKindTag(meta.sourceKind)}
        </span>
      </li>`;
    })
    .join('');
  return `<details class="pit-section pit-section-unavailable" open>
    <summary><span class="pit-section-title">לא זמינים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list">${rows}</ul>
    </div>
  </details>`;
}

function renderFreeSection(group: FreeGroup, collapsed: boolean): string {
  const count = group.participants.length;
  if (count === 0) {
    return `<details class="pit-section pit-section-free pit-section-empty" id="pit-section-free" open>
      <summary><span class="pit-section-title">פנויים</span><span class="pit-section-count">0</span></summary>
      <div class="pit-section-body pit-section-body-empty">אף אחד לא פנוי.</div>
    </details>`;
  }
  const sorted = sortByGroupThenName(group.participants);
  const rows = sorted
    .map(
      (p) =>
        `<li class="pit-row pit-row-free" data-pid="${escAttr(p.id)}" tabindex="0" role="button">
          ${nameSpan(p)}
        </li>`,
    )
    .join('');
  return `<details class="pit-section pit-section-free" id="pit-section-free"${collapsed ? '' : ' open'}>
    <summary><span class="pit-section-title">פנויים</span><span class="pit-section-count">${count}</span></summary>
    <div class="pit-section-body">
      <ul class="pit-row-list pit-free-grid">${rows}</ul>
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
