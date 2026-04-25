/**
 * Swimlane View — person-first schedule renderer.
 *
 * One row per participant, each row a horizontal mini-timeline of the
 * operational day. Empty lane = free time; saturated blocks = busy. The
 * live-mode "now" line is a CSS variable shared across every track.
 *
 * Frozen-snapshot semantics: every value comes from `schedule.*` (algorithm
 * settings, periodStart, scheduleUnavailability). Never reads `store.*`.
 */

import { isFutureTask } from '../engine/temporal';
import type { ConstraintViolation, LiveModeState, Participant, Schedule, Task } from '../models/types';
import { AssignmentStatus, Level } from '../models/types';
import { filterVisibleViolations, getDayWindow, violationLabel } from './schedule-utils';
import {
  type Band,
  type DayWindow,
  getParticipantTasksForDay,
  getUnavailabilityBandsForDay,
  isAllDayUnavailable,
  positionFraction,
  totalAssignedHoursForDay,
} from './swimlane-utils';
import { buildParticipantTooltipContent } from './tooltips';
import {
  certBadges,
  escAttr,
  escHtml,
  fmt,
  getTaskColor,
  getTaskLabel,
  groupColor,
  LEVEL_COLORS,
  SVG_ICONS,
} from './ui-helpers';
import { showBottomSheet } from './ui-modal';

// ─── Module state ────────────────────────────────────────────────────────────

/**
 * Names of group sections the user has collapsed. Transient — resets on full
 * page reload, which is what the plan specified for filter/group state.
 */
const _collapsedGroups = new Set<string>();

export interface SwimlaneCallbacks {
  onSwap: (assignmentId: string) => void;
  onRescue: (assignmentId: string) => void;
  onNavigateToProfile: (participantId: string) => void;
  onNavigateToTaskPanel: (sourceName: string) => void;
  /** Live getters so handlers always read the latest schedule / day index. */
  getSchedule: () => Schedule | null;
  getDayIndex: () => number;
  getLiveMode: () => LiveModeState;
}

let _cb: SwimlaneCallbacks | null = null;

/** Register callbacks once at app startup. Mirrors `initTooltips`. */
export function initSwimlane(cb: SwimlaneCallbacks): void {
  _cb = cb;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Render the swimlane view for one operational day.
 * Returns an HTML string; caller is responsible for inserting it into the DOM.
 */
export function renderSwimlaneView(schedule: Schedule, dayIndex: number, liveMode: LiveModeState): string {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const win = getDayWindow(dayIndex, dsh, schedule.periodStart);

  // CSS variable for the "now" line — undefined when not in live mode or when
  // the anchor sits outside the displayed day window.
  const nowFraction =
    liveMode.enabled &&
    liveMode.currentTimestamp.getTime() >= win.start.getTime() &&
    liveMode.currentTimestamp.getTime() <= win.end.getTime()
      ? positionFraction(liveMode.currentTimestamp.getTime(), win)
      : null;

  const rootStyle =
    nowFraction !== null
      ? `style="--swimlane-now-x:${(nowFraction * 100).toFixed(2)}%"`
      : 'style="--swimlane-now-x:none"';

  const groups = buildGroups(schedule, dayIndex);

  let html = `<div class="swimlane-view${liveMode.enabled ? ' live' : ''}${nowFraction !== null ? ' has-now' : ''}" ${rootStyle}>`;
  html += renderAxis(dsh, nowFraction, nowFraction !== null ? liveMode.currentTimestamp : null);
  html += `<div class="swimlane-groups">`;
  for (const g of groups) html += renderGroup(g, schedule, dayIndex, win, liveMode);
  if (groups.length === 0) {
    html += `<div class="swimlane-empty">אין משתתפים להצגה</div>`;
  }
  html += `</div>`;
  html += `</div>`;
  return html;
}

// ─── Group composition & ordering ────────────────────────────────────────────

interface GroupBucket {
  name: string;
  participants: Participant[];
}

/**
 * Group participants by `group`, preserving first-appearance order of the
 * groups themselves (stable across renders given a stable participant list).
 *
 * Within a group, sort by:
 *   1. Level descending (L4 → L3 → L2 → L0).
 *   2. Today's total assigned hours descending — busiest at top of each level.
 */
function buildGroups(schedule: Schedule, dayIndex: number): GroupBucket[] {
  const order: string[] = [];
  const map = new Map<string, Participant[]>();
  for (const p of schedule.participants) {
    const key = p.group || '—';
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)?.push(p);
  }

  const levelRank: Record<Level, number> = {
    [Level.L4]: 4,
    [Level.L3]: 3,
    [Level.L2]: 2,
    [Level.L0]: 1,
  };

  const buckets: GroupBucket[] = [];
  for (const name of order) {
    const stored = map.get(name);
    if (!stored) continue;
    const list = stored.slice();
    // Pre-compute hours once per participant for the sort.
    const hoursCache = new Map<string, number>();
    for (const p of list) hoursCache.set(p.id, totalAssignedHoursForDay(schedule, p.id, dayIndex));
    list.sort((a, b) => {
      const lvl = levelRank[b.level] - levelRank[a.level];
      if (lvl !== 0) return lvl;
      const dh = (hoursCache.get(b.id) ?? 0) - (hoursCache.get(a.id) ?? 0);
      if (dh !== 0) return dh;
      // Stable tiebreak so identical (level, hours) lanes don't reorder
      // between renders or across days.
      return a.name.localeCompare(b.name, 'he');
    });
    buckets.push({ name, participants: list });
  }
  return buckets;
}

// ─── Time axis ───────────────────────────────────────────────────────────────

function renderAxis(dayStartHour: number, nowFraction: number | null, nowTimestamp: Date | null): string {
  // Major ticks at dsh, +4, +8, +12, +16, +20. Op-day boundary on both edges.
  // Each tick is tappable: opens a "free at HH:00" cross-section bottom sheet.
  let html = `<div class="swimlane-axis">`;
  html += `<div class="swimlane-axis-gutter"></div>`;
  html += `<div class="swimlane-axis-track">`;
  for (let off = 0; off < 24; off += 4) {
    const hour = (dayStartHour + off) % 24;
    const right = (off / 24) * 100;
    html += `<button type="button" class="swimlane-axis-tick" style="right:${right.toFixed(2)}%" data-hour="${hour}" title="פנויים בשעה ${pad2(hour)}:00"><span class="swimlane-axis-label">${pad2(hour)}</span></button>`;
  }
  // End-edge tick at the operational boundary on the visual left.
  html += `<button type="button" class="swimlane-axis-tick swimlane-axis-tick--end" style="right:100%" data-hour="${dayStartHour}" title="פנויים בשעה ${pad2(dayStartHour)}:00"><span class="swimlane-axis-label">${pad2(dayStartHour)}</span></button>`;
  if (nowFraction !== null && nowTimestamp) {
    html += `<div class="swimlane-axis-now" aria-hidden="true" style="right:${(nowFraction * 100).toFixed(2)}%"><span class="swimlane-axis-now-pill">עכשיו ${fmt(nowTimestamp)}</span></div>`;
  }
  html += `</div>`;
  html += `</div>`;
  return html;
}

// ─── Group section ──────────────────────────────────────────────────────────

function renderGroup(
  group: GroupBucket,
  schedule: Schedule,
  dayIndex: number,
  win: DayWindow,
  liveMode: LiveModeState,
): string {
  const color = groupColor(group.name);
  const collapsed = _collapsedGroups.has(group.name);
  let html = `<div class="swimlane-group${collapsed ? ' swimlane-group--collapsed' : ''}" data-group="${escAttr(group.name)}">`;
  // Header is the click target for collapse/expand. role=button + aria-expanded
  // for a11y; the chevron icon flips via CSS based on the parent's collapsed
  // class so toggling needs no re-render.
  html += `<div class="swimlane-group-header" role="button" tabindex="0" aria-expanded="${collapsed ? 'false' : 'true'}" data-group-toggle="${escAttr(group.name)}">`;
  html += `<span class="swimlane-group-chevron" aria-hidden="true">${SVG_ICONS.chevronDown}</span>`;
  html += `<span class="swimlane-group-dot" style="background:${color}"></span>`;
  html += `<span class="swimlane-group-name">${escHtml(group.name)}</span>`;
  html += `<span class="swimlane-group-count">${group.participants.length}</span>`;
  html += `</div>`;
  html += `<div class="swimlane-lanes">`;
  for (const p of group.participants) html += renderLane(p, schedule, dayIndex, win, liveMode);
  html += `</div>`;
  html += `</div>`;
  return html;
}

// ─── Lane ───────────────────────────────────────────────────────────────────

function renderLane(
  participant: Participant,
  schedule: Schedule,
  dayIndex: number,
  win: DayWindow,
  liveMode: LiveModeState,
): string {
  const tasks = getParticipantTasksForDay(schedule, participant.id, dayIndex);
  const bands = getUnavailabilityBandsForDay(participant, schedule, dayIndex);
  const hours = totalAssignedHoursForDay(schedule, participant.id, dayIndex);
  const allOut = isAllDayUnavailable(bands, win);

  // Look up assignment statuses for the displayed tasks (by taskId).
  // Conflict / Frozen styling needs the assignment record.
  const assignmentByTaskId = new Map<string, AssignmentStatus>();
  for (const a of schedule.assignments) {
    if (a.participantId !== participant.id) continue;
    if (!assignmentByTaskId.has(a.taskId)) assignmentByTaskId.set(a.taskId, a.status);
  }

  // Lane status flags for identity-row icons.
  let hasFrozen = false;
  let hasConflict = false;
  for (const t of tasks) {
    const status = assignmentByTaskId.get(t.id);
    if (status === AssignmentStatus.Conflict) hasConflict = true;
    if (liveMode.enabled && !isFutureTask(t, liveMode.currentTimestamp)) hasFrozen = true;
  }
  const hasUnavailability = bands.length > 0;

  const groupColorHex = groupColor(participant.group || '—');
  const levelHex = LEVEL_COLORS[participant.level];

  const laneClasses = [
    'swimlane-lane',
    allOut ? 'swimlane-lane--out' : '',
    tasks.length === 0 && !allOut ? 'swimlane-lane--free' : '',
    hasConflict ? 'swimlane-lane--has-conflict' : '',
  ]
    .filter(Boolean)
    .join(' ');

  let html = `<div class="${laneClasses}" data-participant-id="${escAttr(participant.id)}">`;

  // Identity row.
  html += `<div class="swimlane-identity">`;
  html += `<span class="swimlane-id-dot" style="background:${groupColorHex}"></span>`;
  html += `<span class="swimlane-id-name">${escHtml(participant.name)}</span>`;
  html += `<span class="swimlane-id-level" style="background:${levelHex}">${levelLabel(participant.level)}</span>`;
  html += `<span class="swimlane-id-hours">${formatHours(hours, allOut)}</span>`;
  if (hasFrozen || hasConflict || hasUnavailability) {
    html += `<span class="swimlane-id-icons">`;
    if (hasConflict) html += `<span class="swimlane-id-icon swimlane-id-icon--conflict" title="התנגשות">●</span>`;
    if (hasFrozen)
      html += `<span class="swimlane-id-icon swimlane-id-icon--frozen" title="קפוא">${SVG_ICONS.snowflake}</span>`;
    if (hasUnavailability && !allOut)
      html += `<span class="swimlane-id-icon swimlane-id-icon--out" title="חוסר זמינות חלקי">⊘</span>`;
    html += `</span>`;
  }
  if (allOut) html += `<span class="swimlane-id-out-chip">לא זמין</span>`;
  html += `</div>`;

  // Track.
  html += `<div class="swimlane-track">`;
  // Bands first (paint behind blocks).
  for (const b of bands) html += renderBand(b, win);
  // Blocks.
  for (const t of tasks) {
    const status = assignmentByTaskId.get(t.id);
    const frozen = liveMode.enabled && !isFutureTask(t, liveMode.currentTimestamp);
    html += renderBlock(t, status, frozen, win);
  }
  // The now-line is rendered via CSS pseudo-element on .swimlane-track,
  // driven by --swimlane-now-x on the root. No per-lane HTML needed.
  html += `</div>`;

  html += `</div>`;
  return html;
}

// ─── Block & band ───────────────────────────────────────────────────────────

function renderBlock(task: Task, status: AssignmentStatus | undefined, frozen: boolean, win: DayWindow): string {
  const startMs = task.timeBlock.start.getTime();
  const endMs = task.timeBlock.end.getTime();
  const left = positionFraction(startMs, win);
  const right = positionFraction(endMs, win);
  const width = Math.max(0, right - left);
  if (width <= 0) return '';

  const color = getTaskColor(task);
  const label = getTaskLabel(task);
  const conflict = status === AssignmentStatus.Conflict;
  const injected = !!task.injectedPostGeneration;

  const classes = [
    'swimlane-block',
    frozen ? 'swimlane-block--frozen' : '',
    conflict ? 'swimlane-block--conflict' : '',
    injected ? 'swimlane-block--injected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Hebrew RTL layout: position from the right edge so day flows right-to-left.
  const rightPct = (left * 100).toFixed(2);
  const widthPct = (width * 100).toFixed(2);
  const titleParts = [label, `${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}`];
  if (frozen) titleParts.push('(קפוא)');
  if (conflict) titleParts.push('(התנגשות)');
  const title = titleParts.join(' · ');

  let html = `<div class="${classes}" `;
  html += `style="right:${rightPct}%;width:${widthPct}%;background:${color}" `;
  html += `data-task-id="${escAttr(task.id)}" `;
  html += `title="${escAttr(title)}">`;
  html += `<span class="swimlane-block-label">${escHtml(label)}</span>`;
  if (frozen) html += `<span class="swimlane-block-frozen" aria-hidden="true">${SVG_ICONS.snowflake}</span>`;
  html += `</div>`;
  return html;
}

function renderBand(b: Band, win: DayWindow): string {
  const left = positionFraction(b.startMs, win);
  const right = positionFraction(b.endMs, win);
  const width = Math.max(0, right - left);
  if (width <= 0) return '';
  const rightPct = (left * 100).toFixed(2);
  const widthPct = (width * 100).toFixed(2);
  return `<div class="swimlane-band" style="right:${rightPct}%;width:${widthPct}%" aria-hidden="true"></div>`;
}

// ─── Small formatters ──────────────────────────────────────────────────────

function levelLabel(level: Level): string {
  // Compact level chip — e.g. "L4". Engine-internal numbers, not Hebrew.
  return `L${level}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatHours(hours: number, allOut: boolean): string {
  if (allOut) return '—';
  if (hours <= 0) return '—';
  // Sub-hour assignments (Future-SOS partials, short tasks) — show minutes.
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes}ד׳`;
  }
  // One decimal when fractional, else integer.
  const rounded = Math.round(hours * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${display}ש`;
}

// ─── Tap handling ───────────────────────────────────────────────────────────

/**
 * Wire delegated click handlers on the swimlane container. Call this once per
 * render (after the swimlane HTML has been inserted into the DOM). Idempotent
 * via a marker class — re-binding the same node is a no-op.
 *
 * Three tap targets (resolved in order, first match wins):
 *   1. Group header        → toggle collapse
 *   2. Block               → block bottom sheet (task + assigned participant + actions)
 *   3. Axis tick           → "free at HH:00" cross-section
 *   4. Lane (anywhere else)→ participant bottom sheet (workload, profile)
 */
export function wireSwimlaneEvents(container: HTMLElement): void {
  if (container.dataset.swimlaneWired === '1') return;
  container.dataset.swimlaneWired = '1';

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // 1. Group header → collapse/expand. Toggle DOM class without re-render.
    const groupHeader = target.closest('[data-group-toggle]') as HTMLElement | null;
    if (groupHeader) {
      e.stopPropagation();
      const groupName = groupHeader.dataset.groupToggle;
      if (!groupName) return;
      const groupEl = groupHeader.closest('.swimlane-group');
      if (!groupEl) return;
      const willCollapse = !groupEl.classList.contains('swimlane-group--collapsed');
      groupEl.classList.toggle('swimlane-group--collapsed', willCollapse);
      groupHeader.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
      if (willCollapse) _collapsedGroups.add(groupName);
      else _collapsedGroups.delete(groupName);
      return;
    }

    // 2. Block tap → task / assignment bottom sheet.
    const block = target.closest('.swimlane-block') as HTMLElement | null;
    if (block) {
      e.stopPropagation();
      openBlockSheet(block);
      return;
    }

    // 3. Axis tick tap → "free at HH:00" cross-section.
    const tick = target.closest('.swimlane-axis-tick') as HTMLElement | null;
    if (tick) {
      e.stopPropagation();
      const hour = tick.dataset.hour;
      if (hour !== undefined) openAxisHourSheet(Number.parseInt(hour, 10));
      return;
    }

    // 4. Lane tap (anywhere not on a block) → participant bottom sheet.
    const lane = target.closest('.swimlane-lane') as HTMLElement | null;
    if (lane) {
      const pid = lane.dataset.participantId;
      if (pid) openParticipantSheet(pid);
    }
  });

  // Keyboard a11y for group-header toggle.
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const header = (e.target as HTMLElement).closest('[data-group-toggle]') as HTMLElement | null;
    if (!header) return;
    e.preventDefault();
    header.click();
  });
}

// ─── Bottom sheet builders ──────────────────────────────────────────────────

function openBlockSheet(blockEl: HTMLElement): void {
  if (!_cb) return;
  const schedule = _cb.getSchedule();
  if (!schedule) return;
  const taskId = blockEl.dataset.taskId;
  const lane = blockEl.closest('.swimlane-lane') as HTMLElement | null;
  const participantId = lane?.dataset.participantId;
  if (!taskId || !participantId) return;

  const task = schedule.tasks.find((t) => t.id === taskId);
  const participant = schedule.participants.find((p) => p.id === participantId);
  const assignment = schedule.assignments.find((a) => a.taskId === taskId && a.participantId === participantId);
  if (!task || !participant || !assignment) return;

  const liveMode = _cb.getLiveMode();
  const frozen = liveMode.enabled && !isFutureTask(task, liveMode.currentTimestamp);

  // Body — task summary block, then full participant tooltip with slot context.
  const sourceName = task.sourceName || task.name;
  const slotMeta = task.slots.find((s) => s.slotId === assignment.slotId);
  const subTeam = slotMeta?.subTeamLabel;
  const certs = slotMeta?.requiredCertifications ?? [];

  // Per-task violations for this assignment.
  const visibleViolations = filterVisibleViolations(
    schedule.violations,
    new Set(schedule.algorithmSettings.disabledHardConstraints),
  ).filter((v) => v.taskId === task.id && (!v.participantId || v.participantId === participant.id));

  const violationsHtml =
    visibleViolations.length > 0
      ? `<div class="swimlane-bs-violations">${visibleViolations
          .map(
            (v: ConstraintViolation) =>
              `<div class="swimlane-bs-violation"><span class="swimlane-bs-violation-code">${escHtml(violationLabel(v.code))}</span><span class="swimlane-bs-violation-msg">${escHtml(v.message)}</span></div>`,
          )
          .join('')}</div>`
      : '';

  let body = `<div class="swimlane-bs-task-summary" style="border-inline-start:3px solid ${getTaskColor(task)}">`;
  body += `<div class="swimlane-bs-task-time">${escHtml(fmt(task.timeBlock.start))}–${escHtml(fmt(task.timeBlock.end))}</div>`;
  if (subTeam) body += `<div class="swimlane-bs-task-subteam">${escHtml(subTeam)}</div>`;
  if (certs.length > 0) body += `<div class="swimlane-bs-task-certs">${certBadges(certs)}</div>`;
  if (frozen) body += `<div class="swimlane-bs-task-flag">${SVG_ICONS.snowflake} שיבוץ קפוא</div>`;
  if (task.injectedPostGeneration) body += `<div class="swimlane-bs-task-flag">⚡ משימת חירום</div>`;
  body += `</div>`;
  if (violationsHtml) body += violationsHtml;

  // Participant section reuses the canonical tooltip content with slot context
  // so the swap/rescue buttons render with the right assignmentId.
  body += `<div class="swimlane-bs-participant">`;
  body += buildParticipantTooltipContent(participant, schedule, {
    assignmentId: assignment.id,
    taskId: task.id,
    isFrozen: frozen,
  });
  body += `</div>`;

  // Action row (uses the bottom-sheet's actions slot).
  const actions: string[] = [];
  if (sourceName) {
    actions.push(
      `<button class="btn-sm btn-outline" data-bs-action="task-panel" data-source-name="${escAttr(sourceName)}">📋 פתח לוח משימה</button>`,
    );
  }

  const handle = showBottomSheet(body, {
    title: sourceName ?? 'משימה',
    actions: actions.length > 0 ? actions.join(' ') : undefined,
  });

  // Wire actions inside the sheet — swap/rescue/navigate buttons.
  handle.el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const swapBtn = t.closest('.btn-swap[data-assignment-id]') as HTMLElement | null;
    const swapId = swapBtn?.dataset.assignmentId;
    if (swapId) {
      handle.close();
      _cb?.onSwap(swapId);
      return;
    }
    const rescueBtn = t.closest('.btn-rescue[data-assignment-id]') as HTMLElement | null;
    const rescueId = rescueBtn?.dataset.assignmentId;
    if (rescueId) {
      handle.close();
      _cb?.onRescue(rescueId);
      return;
    }
    const profileBtn = t.closest('[data-action="goto-profile"][data-pid]') as HTMLElement | null;
    const pid = profileBtn?.dataset.pid;
    if (pid) {
      handle.close();
      _cb?.onNavigateToProfile(pid);
      return;
    }
    const taskPanelBtn = t.closest('[data-bs-action="task-panel"][data-source-name]') as HTMLElement | null;
    const sourceName = taskPanelBtn?.dataset.sourceName;
    if (sourceName) {
      handle.close();
      _cb?.onNavigateToTaskPanel(sourceName);
      return;
    }
  });
}

function openParticipantSheet(participantId: string): void {
  if (!_cb) return;
  const schedule = _cb.getSchedule();
  if (!schedule) return;
  const participant = schedule.participants.find((p) => p.id === participantId);
  if (!participant) return;

  const dayIndex = _cb.getDayIndex();
  const todaysTasks = getParticipantTasksForDay(schedule, participantId, dayIndex);

  let body = buildParticipantTooltipContent(participant, schedule, null);

  // Today's tasks list — gives at-a-glance "what's their day look like".
  if (todaysTasks.length > 0) {
    body += `<div class="tt-divider"></div><div class="swimlane-bs-today">`;
    body += `<div class="swimlane-bs-today-title">היום:</div>`;
    for (const t of todaysTasks) {
      const color = getTaskColor(t);
      body += `<div class="swimlane-bs-today-row">`;
      body += `<span class="swimlane-bs-today-dot" style="background:${color}"></span>`;
      body += `<span class="swimlane-bs-today-name">${escHtml(getTaskLabel(t))}</span>`;
      body += `<span class="swimlane-bs-today-time">${fmt(t.timeBlock.start)}–${fmt(t.timeBlock.end)}</span>`;
      body += `</div>`;
    }
    body += `</div>`;
  }

  const handle = showBottomSheet(body, { title: participant.name });

  handle.el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const profileBtn = t.closest('[data-action="goto-profile"][data-pid]') as HTMLElement | null;
    const pid = profileBtn?.dataset.pid;
    if (pid) {
      handle.close();
      _cb?.onNavigateToProfile(pid);
    }
  });
}

function openAxisHourSheet(hour: number): void {
  if (!_cb) return;
  const schedule = _cb.getSchedule();
  if (!schedule) return;
  const dayIndex = _cb.getDayIndex();
  const dsh = schedule.algorithmSettings.dayStartHour;
  const win = getDayWindow(dayIndex, dsh, schedule.periodStart);

  // Build absolute timestamp for `hour` inside this op-day.
  const offsetH = (hour - dsh + 24) % 24;
  const probeMs = win.start.getTime() + offsetH * 3600000;

  // For each participant, compute: assigned at this hour? unavailable at this hour?
  const taskById = new Map<string, Task>();
  for (const t of schedule.tasks) taskById.set(t.id, t);

  type Row = { p: Participant; status: 'free' | 'busy' | 'out'; busyTask?: Task };
  const rows: Row[] = [];

  for (const p of schedule.participants) {
    // Unavailability check (date rules + scheduleUnavailability for this day).
    const bands = getUnavailabilityBandsForDay(p, schedule, dayIndex);
    const blocked = bands.some((b) => probeMs >= b.startMs && probeMs < b.endMs);
    if (blocked) {
      rows.push({ p, status: 'out' });
      continue;
    }
    // Assigned at this hour?
    let busyTask: Task | undefined;
    for (const a of schedule.assignments) {
      if (a.participantId !== p.id) continue;
      const t = taskById.get(a.taskId);
      if (!t) continue;
      if (t.timeBlock.start.getTime() <= probeMs && t.timeBlock.end.getTime() > probeMs) {
        busyTask = t;
        break;
      }
    }
    rows.push({ p, status: busyTask ? 'busy' : 'free', busyTask });
  }

  const free = rows.filter((r) => r.status === 'free');
  const busy = rows.filter((r) => r.status === 'busy');
  const out = rows.filter((r) => r.status === 'out');

  // Sort each bucket: level desc, then name.
  const lvlRank: Record<Level, number> = { [Level.L4]: 4, [Level.L3]: 3, [Level.L2]: 2, [Level.L0]: 1 };
  const sortLevelName = (a: Row, b: Row) =>
    lvlRank[b.p.level] - lvlRank[a.p.level] || a.p.name.localeCompare(b.p.name, 'he');
  free.sort(sortLevelName);
  busy.sort(sortLevelName);
  out.sort(sortLevelName);

  const renderChip = (r: Row): string => {
    const dot = `<span class="swimlane-bs-chip-dot" style="background:${groupColor(r.p.group || '—')}"></span>`;
    const lvl = `<span class="swimlane-bs-chip-level" style="background:${LEVEL_COLORS[r.p.level]}">L${r.p.level}</span>`;
    const sub = r.busyTask ? `<span class="swimlane-bs-chip-sub">${escHtml(getTaskLabel(r.busyTask))}</span>` : '';
    return `<div class="swimlane-bs-chip" data-pid="${escAttr(r.p.id)}">${dot}<span class="swimlane-bs-chip-name">${escHtml(r.p.name)}</span>${lvl}${sub}</div>`;
  };

  const renderSection = (label: string, list: Row[], cls: string) => {
    if (list.length === 0) return '';
    return `<div class="swimlane-bs-axis-section ${cls}">
      <div class="swimlane-bs-axis-section-title">${escHtml(label)} <span class="swimlane-bs-axis-count">${list.length}</span></div>
      <div class="swimlane-bs-axis-list">${list.map(renderChip).join('')}</div>
    </div>`;
  };

  let body = '';
  body += renderSection('פנויים', free, 'swimlane-bs-axis-free');
  body += renderSection('עסוקים', busy, 'swimlane-bs-axis-busy');
  body += renderSection('לא זמינים', out, 'swimlane-bs-axis-out');

  const title = `שעה ${pad2(hour)}:00 · יום ${dayIndex}`;
  const handle = showBottomSheet(body, { title });

  handle.el.addEventListener('click', (ev) => {
    const chip = (ev.target as HTMLElement).closest('.swimlane-bs-chip[data-pid]') as HTMLElement | null;
    if (!chip) return;
    const pid = chip.dataset.pid;
    if (!pid) return;
    handle.close();
    openParticipantSheet(pid);
  });
}
