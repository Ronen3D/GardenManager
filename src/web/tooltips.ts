/**
 * Tooltip System — participant and task hover/touch tooltips.
 *
 * Extracted from app.ts. Self-contained with own DOM singletons and timer state.
 * Read-only with respect to app state — never mutates schedule or engine.
 * Action callbacks (swap, rescue, navigateToProfile) are injected via initTooltips().
 */

import type { Participant, Schedule, Task } from '../index';
import * as store from './config-store';
import { renderPakalBadges } from './pakal-utils';
import { isTouchDevice } from './responsive';
import { escHtml, fmt, groupColor, LEVEL_COLORS, SVG_ICONS } from './ui-helpers';
import { showBottomSheet } from './ui-modal';
import { computeTaskBreakdown } from './workload-utils';

// ─── Callback injection ─────────────────────────────────────────────────────

export interface TooltipCallbacks {
  onSwap: (assignmentId: string) => void;
  onRescue: (assignmentId: string) => void;
  onNavigateToProfile: (participantId: string) => void;
}

let _callbacks: TooltipCallbacks | null = null;

export function initTooltips(cb: TooltipCallbacks): void {
  _callbacks = cb;
}

/**
 * Resolve a cert id to a human label, preferring the schedule's frozen
 * snapshot so labels for certs deleted after generation still render.
 * Falls back to the live store (covers cert-color + renaming live), and
 * finally to the raw id with a "(נמחק)" suffix.
 */
function resolveCertLabel(certId: string, schedule: Schedule | null): string {
  const snap = schedule?.certLabelSnapshot?.[certId];
  if (snap) return snap;
  const liveDef = store.getCertificationById(certId);
  if (liveDef) return liveDef.label;
  return `${certId} (נמחק)`;
}

// ─── Global Participant Tooltip ─────────────────────────────────────────────

let _tooltipEl: HTMLElement | null = null;
let _tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

/** Hide the global tooltip immediately (used when switching to profile view). */
export function hideTooltip(): void {
  if (_tooltipHideTimer) {
    clearTimeout(_tooltipHideTimer);
    _tooltipHideTimer = null;
  }
  if (_tooltipEl) _tooltipEl.style.display = 'none';
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
    if (_tooltipHideTimer) {
      clearTimeout(_tooltipHideTimer);
      _tooltipHideTimer = null;
    }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });

  // Delegate action button clicks (swap/rescue) inside the tooltip
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLElement | null;
    if (!btn) return;
    const assignmentId = btn.dataset.assignmentId;
    if (!assignmentId) return;
    e.stopPropagation(); // prevent navigateToProfile from triggering
    el.style.display = 'none'; // hide tooltip immediately

    if (btn.classList.contains('btn-swap')) {
      _callbacks?.onSwap(assignmentId);
    } else if (btn.classList.contains('btn-rescue')) {
      _callbacks?.onRescue(assignmentId);
    }
  });

  _tooltipEl = el;
  return el;
}

/** Build tooltip HTML content for a participant. */
export function buildParticipantTooltipContent(
  p: Participant,
  schedule: Schedule | null,
  slotCtx?: { assignmentId: string; taskId: string; isFrozen: boolean } | null,
): string {
  // Workload data
  const numDays = store.getScheduleDays();
  const totalPeriodHours = numDays * 24;

  // Build breakdown using shared utility (R1)
  let bd = {
    heavyHours: 0,
    heavyCount: 0,
    effectiveHeavyHours: 0,
    hotHours: 0,
    coldHours: 0,
    lightHours: 0,
    lightCount: 0,
    sourceHours: {} as Record<string, number>,
    sourceEffectiveHours: {} as Record<string, number>,
    sourceCounts: {} as Record<string, number>,
    sourceColors: {} as Record<string, string>,
  };
  if (schedule) {
    const taskMap = new Map<string, Task>();
    for (const t of schedule.tasks) taskMap.set(t.id, t);
    const myItems = schedule.assignments
      .filter((a) => a.participantId === p.id)
      .map((a) => ({ task: taskMap.get(a.taskId)! }))
      .filter((x) => x.task);
    bd = computeTaskBreakdown(myItems);
  }
  const {
    heavyHours,
    effectiveHeavyHours,
    sourceHours,
    sourceEffectiveHours,
    sourceCounts,
    sourceColors,
  } = bd;

  // R7: Use effectiveHeavyHours for workload %, consistent with sidebar & profile
  const pctOfPeriod = totalPeriodHours > 0 ? (effectiveHeavyHours / totalPeriodHours) * 100 : 0;

  const certsHtml =
    p.certifications.length > 0
      ? p.certifications
          .map((c: string) => {
            return `<span class="tt-cert" style="background:${store.getCertColor(c)}">${escHtml(resolveCertLabel(c, schedule))}</span>`;
          })
          .join(' ')
      : '<span class="tt-dim">אין</span>';
  const pakalHtml = renderPakalBadges(p, store.getAllPakalDefinitionsIncludeDeleted(), 'אין');

  // Build per-task breakdown rows (only show sources with count > 0)
  const breakdownRows = Object.keys(sourceCounts)
    .filter((key) => sourceCounts[key] > 0)
    .map((key) => {
      const color = sourceColors[key] || '#7f8c8d';
      return `<div class="tt-row">
        <span class="tt-label"><span style="color:${color};font-weight:600">${key}</span></span>
        <span class="tt-value">${sourceCounts[key]}× · ${sourceEffectiveHours[key].toFixed(1)} שע' אפקטיביות</span>
      </div>`;
    })
    .join('');

  // Build action buttons for the Group row (if we have slot context)
  let actionsHtml = '';
  if (slotCtx && !slotCtx.isFrozen) {
    const lm = store.getLiveModeState();
    actionsHtml = `<span class="tt-actions">
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
      <span class="tt-level" style="background:${LEVEL_COLORS[p.level]}">${p.level}</span>
    </div>
    <div class="tt-row"><span class="tt-label">קבוצה</span><span class="tt-value" style="color:${groupColor(p.group)}">${p.group}</span></div>
    <div class="tt-row"><span class="tt-label">הסמכות</span><span class="tt-value">${certsHtml}</span></div>
    <div class="tt-row tt-row-wrap"><span class="tt-label">פק"לים</span><span class="tt-value">${pakalHtml}</span></div>
    <div class="tt-divider"></div>
    ${breakdownRows}
    <div class="tt-divider"></div>
    <div class="tt-row"><span class="tt-label">סה"כ שעות</span><span class="tt-value tt-bold">${effectiveHeavyHours.toFixed(1)} שע' אפקטיביות</span></div>
    <div class="tt-row"><span class="tt-label">% עומס</span><span class="tt-value">${pctOfPeriod.toFixed(1)}% מתוך ${totalPeriodHours} שע'</span></div>
    ${isTouchDevice ? `<div class="tt-divider"></div><div class="tt-row"><button class="btn-sm btn-outline" data-action="goto-profile" data-pid="${p.id}" style="width:100%">📋 צפה בפרופיל</button></div>` : ''}
  `;
}

/** Wire event-delegated tooltip for .participant-hover elements. */
export function wireParticipantTooltip(container: HTMLElement, getSchedule: () => Schedule | null): void {
  const schedule = getSchedule();
  if (!schedule) return;

  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  if (isTouchDevice) {
    // ── Touch: tap opens bottom sheet with participant info ──
    let _longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let _longPressFired = false;

    container.addEventListener(
      'touchstart',
      (e) => {
        const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
        if (!target) return;
        _longPressFired = false;
        _longPressTimer = setTimeout(() => {
          _longPressFired = true;
          const pid = target.dataset.pid;
          if (pid) _callbacks?.onNavigateToProfile(pid);
        }, 500);
      },
      { passive: true },
    );

    container.addEventListener('touchend', () => {
      if (_longPressTimer) {
        clearTimeout(_longPressTimer);
        _longPressTimer = null;
      }
    });

    container.addEventListener(
      'touchmove',
      () => {
        if (_longPressTimer) {
          clearTimeout(_longPressTimer);
          _longPressTimer = null;
        }
      },
      { passive: true },
    );

    container.addEventListener('click', (e) => {
      if (_longPressFired) {
        _longPressFired = false;
        return;
      }
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
          }
        : null;

      const content = buildParticipantTooltipContent(p, getSchedule(), slotCtx);
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
          if (btn.classList.contains('btn-swap')) _callbacks?.onSwap(assignmentId);
          else if (btn.classList.contains('btn-rescue')) _callbacks?.onRescue(assignmentId);
        });

        // Wire "view profile" link if participant name is tapped inside sheet
        sheetBody.addEventListener('click', (ev) => {
          const profileLink = (ev.target as HTMLElement).closest('[data-action="goto-profile"]') as HTMLElement | null;
          if (profileLink?.dataset.pid) {
            handle.close();
            _callbacks?.onNavigateToProfile(profileLink.dataset.pid);
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

    if (_tooltipHideTimer) {
      clearTimeout(_tooltipHideTimer);
      _tooltipHideTimer = null;
    }

    // Build slot context from data attributes on the participant-hover span
    const slotCtx = target.dataset.assignmentId
      ? {
          assignmentId: target.dataset.assignmentId,
          taskId: target.dataset.taskId || '',
          isFrozen: target.dataset.frozen === '1',
        }
      : null;

    const tooltip = getTooltipEl();
    tooltip.innerHTML = buildParticipantTooltipContent(p, getSchedule(), slotCtx);
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

// ─── Global Task Tooltip ────────────────────────────────────────────────────

let _taskTooltipEl: HTMLElement | null = null;
let _taskTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

export function hideTaskTooltip(): void {
  if (_taskTooltipHideTimer) {
    clearTimeout(_taskTooltipHideTimer);
    _taskTooltipHideTimer = null;
  }
  if (_taskTooltipEl) _taskTooltipEl.style.display = 'none';
}

function getTaskTooltipEl(): HTMLElement {
  if (_taskTooltipEl) return _taskTooltipEl;
  const el = document.createElement('div');
  el.className = 'task-detail-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (_taskTooltipHideTimer) {
      clearTimeout(_taskTooltipHideTimer);
      _taskTooltipHideTimer = null;
    }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });
  // Delegate "open task panel" CTA clicks from the tooltip body.
  el.addEventListener('click', (e) => {
    const cta = (e.target as HTMLElement).closest('.ttt-action-open-panel') as HTMLElement | null;
    if (!cta?.dataset.sourceName) return;
    document.dispatchEvent(new CustomEvent('gm:open-task-panel', { detail: { sourceName: cta.dataset.sourceName } }));
    el.style.display = 'none';
  });
  _taskTooltipEl = el;
  return el;
}

/** Build rich tooltip HTML for a task showing time, name, type, and all teammates. */
function buildTaskTooltipContent(taskId: string, schedule: Schedule | null): string {
  if (!schedule) return '';
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const task = taskMap.get(taskId);
  if (!task) return '';

  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  const taskColor = task.color || '#7f8c8d';
  const startStr = fmt(task.timeBlock.start);
  const endStr = fmt(task.timeBlock.end);
  const hrs = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;

  // Find all assignments for this task
  const taskAssignments = schedule.assignments.filter((a) => a.taskId === taskId);

  // Build teammates list
  let teammatesHtml = '';
  if (taskAssignments.length === 0) {
    teammatesHtml = '<div class="ttt-empty">אין שיבוצים</div>';
  } else {
    teammatesHtml = '<div class="ttt-teammates">';
    for (const a of taskAssignments) {
      const p = pMap.get(a.participantId);
      if (!p) continue;
      const slot = task.slots.find((s) => s.slotId === a.slotId);
      const levelColors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
      const certsHtml =
        p.certifications.length > 0
          ? p.certifications
              .map(
                (c) =>
                  `<span class="ttt-cert" style="background:${store.getCertColor(c)}">${escHtml(resolveCertLabel(c, schedule))}</span>`,
              )
              .join('')
          : '';
      teammatesHtml += `<div class="ttt-mate">
        <div class="ttt-mate-main">
          <span class="ttt-mate-name">${p.name}</span>
          <span class="ttt-mate-level" style="background:${levelColors[p.level]}">${p.level}</span>
        </div>
        <div class="ttt-mate-meta">
          ${slot ? `<span class="ttt-slot">${slot.label || task.name}</span>` : ''}
          ${certsHtml}
        </div>
      </div>`;
    }
    teammatesHtml += '</div>';
  }

  const sourceName = task.sourceName || task.name;
  const openPanelBtn = sourceName
    ? `<div class="ttt-actions">
        <button class="ttt-action-open-panel" data-source-name="${escHtml(sourceName)}">📋 פתח חלונית משימה</button>
      </div>`
    : '';

  return `
    <div class="ttt-header">
      <span class="ttt-task-name" style="border-inline-start:3px solid ${taskColor};padding-inline-start:8px">${task.name}</span>
      <span class="badge badge-sm" style="background:${taskColor}">${task.sourceName || task.name}</span>
      ${task.isLight ? '<span class="badge badge-sm" style="background:#7f8c8d">קלה</span>' : ''}
    </div>
    <div class="ttt-time">
      <span dir="ltr">${startStr} – ${endStr}</span>
      <span class="ttt-dur">${hrs.toFixed(1)} שע'</span>
    </div>
    <div class="ttt-divider"></div>
    <div class="ttt-section-label">צוות משמרת (${taskAssignments.length})</div>
    ${teammatesHtml}
    ${openPanelBtn}
  `;
}

/** Wire event-delegated tooltip for .task-tooltip-hover elements. */
export function wireTaskTooltip(container: HTMLElement, getSchedule: () => Schedule | null): void {
  const schedule = getSchedule();
  if (!schedule) return;

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
      if (_expandedTaskId === taskId) {
        _expandedTaskId = null;
        return;
      }

      const content = buildTaskTooltipContent(taskId, getSchedule());
      if (!content) return;

      _expandedTaskId = taskId;
      const detail = document.createElement('div');
      detail.className = 'task-inline-detail';
      detail.innerHTML = content;
      target.insertAdjacentElement('afterend', detail);

      // Hook the CTA (rendered inside buildTaskTooltipContent) to dispatch the global event.
      const cta = detail.querySelector('.ttt-action-open-panel') as HTMLElement | null;
      if (cta) {
        cta.addEventListener('click', (evt) => {
          evt.stopPropagation();
          const sn = cta.dataset.sourceName;
          if (sn) document.dispatchEvent(new CustomEvent('gm:open-task-panel', { detail: { sourceName: sn } }));
        });
      }
    });

    // Dismiss when tapping outside a task-tooltip-hover
    container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]');
      if (target) return; // handled above
      const existing = container.querySelector('.task-inline-detail');
      if (existing) {
        existing.remove();
        _expandedTaskId = null;
      }
    });
    return;
  }

  // ── Desktop: hover shows fixed tooltip ──
  container.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('.task-tooltip-hover[data-task-id]') as HTMLElement | null;
    if (!target) return;
    const taskId = target.dataset.taskId;
    if (!taskId) return;

    if (_taskTooltipHideTimer) {
      clearTimeout(_taskTooltipHideTimer);
      _taskTooltipHideTimer = null;
    }

    const content = buildTaskTooltipContent(taskId, getSchedule());
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
