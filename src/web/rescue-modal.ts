/**
 * Rescue Modal — minimum-disruption replanning UI.
 *
 * Extracted from app.ts. Self-contained with own state, DOM overlay,
 * tooltip, and event wiring. Communicates with app.ts via injected
 * callbacks (RescueContext).
 */

import { generateRescuePlans } from '../engine/rescue';
import {
  AssignmentStatus,
  type Participant,
  type RescuePlan,
  type RescueRequest,
  type RescueResult,
  type Schedule,
  type SchedulingEngine,
  type Task,
} from '../index';
import { hebrewDayName } from '../utils/date-utils';
import * as store from './config-store';
import { isTouchDevice } from './responsive';
import { violationLabel } from './schedule-utils';
import { escHtml, fmt } from './ui-helpers';

// ─── Context injection ──────────────────────────────────────────────────────

/** One swap step label for the post-rescue toast. */
export interface RescueSwapLabel {
  /** e.g. "החלפה: שירה אדרי ← דניאל וייס" */
  label: string;
}

export interface RescueContext {
  getSchedule: () => Schedule | null;
  getEngine: () => SchedulingEngine | null;
  /** Called after a rescue plan is successfully applied (swaps done, schedule updated). */
  onPlanApplied: (updatedSchedule: Schedule, swapLabels: RescueSwapLabel[], swappedAssignmentIds: string[]) => void;
  /** Called when a rescue plan swap fails and the engine rolled back. */
  onPlanFailed: () => void;
}

let _ctx: RescueContext | null = null;

export function initRescue(ctx: RescueContext): void {
  _ctx = ctx;
}

// ─── Rescue Modal State ─────────────────────────────────────────────────────

/** Currently displayed rescue result (null when modal is closed) */
let _rescueResult: RescueResult | null = null;
/** Which assignment ID the rescue modal is open for */
let _rescueAssignmentId: string | null = null;
/** Current rescue page (0-based) */
let _rescuePage = 0;
/** Escape key handler for rescue modal (stored for cleanup) */
let _rescueEscHandler: ((e: KeyboardEvent) => void) | null = null;

// ─── Rescue Tooltip State ───────────────────────────────────────────────────

let _rescueTooltipEl: HTMLElement | null = null;
let _rescueTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

export function openRescueModal(assignmentId: string): void {
  const currentSchedule = _ctx?.getSchedule();
  if (!currentSchedule) return;
  const assignment = currentSchedule.assignments.find((a) => a.id === assignmentId);
  if (!assignment) return;
  const task = currentSchedule.tasks.find((t) => t.id === assignment.taskId);
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
  // Read frozen engine state so rescue planning uses the schedule's generation-
  // time settings; external edits since then are deliberately ignored.
  const engine = _ctx?.getEngine();
  _rescueResult = generateRescuePlans(
    currentSchedule,
    request,
    liveMode.currentTimestamp,
    _rescuePage,
    undefined,
    engine?.getDisabledHC(),
    engine?.getRestRuleMap(),
    engine?.getDayStartHour() ?? currentSchedule.algorithmSettings.dayStartHour,
    engine?.getCertLabelResolver() ?? ((id: string) => id),
    engine?.getConfig(),
    engine?.buildScoreContext(),
    engine?.getScheduleContext(),
  );
  showRescueModal();
}

export function closeRescueModal(): void {
  document.getElementById('rescue-modal-backdrop')?.remove();
  _rescueResult = null;
  _rescueAssignmentId = null;
  _rescuePage = 0;
  // Remove Escape key handler
  if (_rescueEscHandler) {
    document.removeEventListener('keydown', _rescueEscHandler);
    _rescueEscHandler = null;
  }
  // Hide rescue tooltip if visible
  if (_rescueTooltipHideTimer) {
    clearTimeout(_rescueTooltipHideTimer);
    _rescueTooltipHideTimer = null;
  }
  if (_rescueTooltipEl) _rescueTooltipEl.style.display = 'none';
}

// ─── Internal Functions ─────────────────────────────────────────────────────

function showRescueModal(): void {
  // Remove any existing modal
  document.getElementById('rescue-modal-backdrop')?.remove();

  const currentSchedule = _ctx?.getSchedule();
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
        <strong>${taskLabel(task ?? undefined, '???')}</strong></p>
      </div>
      <div class="rescue-plans">`;

  if (plans.length === 0) {
    html += `<div class="rescue-empty">לא נמצאו תוכניות החלפה מתאימות.</div>`;
  }

  // Dynamic quality-tier thresholds derived from actual penalty weights.
  // Reference scale = smallest active major penalty (lowPriority / notWith).
  // If both are disabled, fall back to the largest minor weight.
  const cfg = _ctx?.getEngine()?.getConfig();
  const activeMajors = [cfg?.lowPriorityLevelPenalty ?? 1166, cfg?.notWithPenalty ?? 1929].filter((v) => v > 0);
  const refPenalty =
    activeMajors.length > 0
      ? Math.min(...activeMajors)
      : Math.max(cfg?.taskNamePreferencePenalty ?? 140, cfg?.dailyBalanceWeight ?? 144, 100);
  const excellentCap = Math.round(refPenalty * 0.04);
  const fairCap = Math.round(refPenalty * 0.43);

  for (const plan of plans) {
    const isRecommended = plan.rank === 1;
    const hasViolations = plan.violations && plan.violations.length > 0;

    const qualityTier =
      plan.impactScore < excellentCap ? 'excellent' : plan.impactScore < fairCap ? 'fair' : 'significant';
    const qualityLabel = qualityTier === 'excellent' ? 'מצוין' : qualityTier === 'fair' ? 'סביר' : 'משמעותי';

    // Swap count label — friendly wording
    const swapLabel = plan.swaps.length === 1 ? 'החלפה ישירה' : `שרשרת של ${plan.swaps.length}`;

    const isDeepFallback = typeof plan.fallbackDepth === 'number' && plan.fallbackDepth >= 4;

    html += `<div class="rescue-plan${isRecommended ? ' rescue-plan--recommended' : ''}${isDeepFallback ? ' rescue-plan--fallback' : ''}" data-plan-id="${plan.id}">
      <div class="rescue-plan-header">
        <span class="rescue-rank">#${plan.rank}${isRecommended ? ' <span class="rescue-recommended-tag">מומלץ ✓</span>' : ''}</span>
        <span class="rescue-quality rescue-quality--${qualityTier}">● ${qualityLabel}</span>
        <span class="rescue-swaps">${swapLabel}</span>
        ${hasViolations ? `<span class="rescue-violations-badge" title="${plan.violations!.length} הפרות אילוצים">⚠️</span>` : ''}
      </div>
      ${
        isDeepFallback
          ? `<div class="rescue-fallback-warning" dir="rtl">
              ⚠️ שרשרת מעמיקה — הוצעה רק כי לא נמצאה חלופה קצרה יותר
            </div>`
          : ''
      }`;

    // Build swap steps as plain-language list
    let stepsHtml = `<ol class="rescue-steps">`;
    for (let i = 0; i < plan.swaps.length; i++) {
      const sw = plan.swaps[i];
      const swP = pMap.get(sw.toParticipantId);
      const fromP = pMap.get(sw.fromParticipantId || '');
      const assignedSpan = `<span class="rescue-participant-hover" data-pid="${sw.toParticipantId}" data-plan-id="${plan.id}"><strong>${swP?.name || '???'}</strong></span>`;
      const fromSpan = fromP
        ? `<span class="rescue-participant-hover" data-pid="${sw.fromParticipantId}" data-plan-id="${plan.id}">${fromP.name}</span>`
        : '';

      const swTask = taskMap.get(sw.taskId);
      const swLabel = taskLabel(swTask, sw.taskName);
      if (plan.swaps.length === 1) {
        // Direct swap: natural sentence
        stepsHtml += `<li>${assignedSpan} יחליף${fromSpan ? ` את ${fromSpan}` : ''} ב-<strong>${swLabel}</strong></li>`;
      } else {
        // Chain swap: arrow style
        stepsHtml += `<li>${assignedSpan} ← <strong>${swLabel}</strong>${fromSpan ? ` במקום ${fromSpan}` : ''}</li>`;
      }
    }
    stepsHtml += `</ol>`;

    // Violations section
    let violationsHtml = '';
    if (hasViolations) {
      violationsHtml = `<div class="rescue-violations-warning">
        <span class="rescue-violations-icon">⚠️</span>
        <span>${plan.violations!.length} הפרות אילוצים</span>
        <details class="rescue-violations-details">
          <summary>הצג פרטים</summary>
          <ul>`;
      for (const v of plan.violations!) {
        violationsHtml += `<li dir="rtl"><code>${violationLabel(v.code)}</code> · ${v.message}</li>`;
      }
      violationsHtml += `</ul></details></div>`;
    }

    // Plan #1: expanded by default. Others: collapsed.
    if (isRecommended) {
      html += `<div class="rescue-plan-details">
        ${stepsHtml}
        ${violationsHtml}
      </div>`;
    } else {
      html += `<details class="rescue-plan-details rescue-plan-collapsible">
        <summary class="rescue-plan-expand">הצג פרטים</summary>
        ${stepsHtml}
        ${violationsHtml}
      </details>`;
    }

    html += `<button class="btn-apply-plan${hasViolations ? ' btn-apply-plan--warn' : ''}" data-plan-id="${plan.id}">${hasViolations ? '⚠️ החל תוכנית (יש הפרות)' : '✅ החל תוכנית'}</button>
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

/** Strip D-prefix ("D1 שמש") and shift suffix ("שמש משמרת 3" → "שמש"). Time range disambiguates shifts. */
function cleanTaskName(name: string): string {
  return name.replace(/^D\d+\s+/, '').replace(/\s+משמרת\s+\d+$/, '');
}

/** Task label for swap steps: cleaned name + time range, e.g. "שמש 13:00–17:00". */
function taskLabel(task: Task | undefined, fallbackName: string): string {
  const name = cleanTaskName(task?.name ?? fallbackName);
  if (!task) return name;
  return `${name} <span dir="ltr">${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</span>`;
}

function getRescueTooltipEl(): HTMLElement {
  if (_rescueTooltipEl) return _rescueTooltipEl;
  const el = document.createElement('div');
  el.className = 'rescue-hover-tt';
  el.style.display = 'none';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (_rescueTooltipHideTimer) {
      clearTimeout(_rescueTooltipHideTimer);
      _rescueTooltipHideTimer = null;
    }
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
  referenceTaskId: string,
): Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> {
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

  // Resolve to task objects with time info, tracking which is the reference task
  const tasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> = [];
  for (const [, taskId] of myAssignmentTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    tasks.push({
      taskName: task.name,
      start: task.timeBlock.start,
      end: task.timeBlock.end,
      isReference: taskId === referenceTaskId,
    });
  }

  // Sort by start time ascending
  tasks.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Find the reference task index; fall back to earliest swap task
  let refIdx = tasks.findIndex((t) => t.isReference);
  if (refIdx === -1) {
    // Fallback: find the earliest swap task's start time
    let anchorTime = Infinity;
    for (const sw of plan.swaps) {
      const task = taskMap.get(sw.taskId);
      if (task) {
        const t = task.timeBlock.start.getTime();
        if (t < anchorTime) anchorTime = t;
      }
    }
    if (anchorTime !== Infinity) {
      refIdx = tasks.findIndex((t) => t.start.getTime() >= anchorTime);
    }
    if (refIdx === -1) refIdx = 0;
  }

  // Return 2 before + reference + 2 after
  const startIdx = Math.max(0, refIdx - 2);
  const endIdx = Math.min(tasks.length, refIdx + 3);
  return tasks.slice(startIdx, endIdx);
}

/** Build HTML content for the rescue participant hover tooltip. */
function buildRescueParticipantTooltip(
  participantName: string,
  nextTasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }>,
): string {
  let html = `<div class="rescue-hover-tt-header">${participantName} — משימות סביב המשבצת אם יוחל</div>`;
  if (nextTasks.length === 0) {
    html += `<div class="rescue-hover-tt-empty">אין משימות קרובות</div>`;
  } else {
    for (let i = 0; i < nextTasks.length; i++) {
      const t = nextTasks[i];
      const dayStr = 'יום ' + hebrewDayName(t.start);
      const timeStr = `<span dir="ltr">${fmt(t.start)} – ${fmt(t.end)}</span>`;
      const refClass = t.isReference ? ' rescue-hover-tt-task--ref' : '';
      const refMarker = t.isReference ? ' ◄' : '';
      html += `<div class="rescue-hover-tt-task${refClass}">${i + 1}. ${cleanTaskName(t.taskName)}${refMarker}<span class="rescue-hover-tt-time">${dayStr} ${timeStr}</span></div>`;
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

  // Escape key to close
  if (_rescueEscHandler) document.removeEventListener('keydown', _rescueEscHandler);
  _rescueEscHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeRescueModal();
  };
  document.addEventListener('keydown', _rescueEscHandler);

  // Show More — request all plans up to the next page boundary in one shot
  // to avoid duplicates from re-generation (engine is stateless).
  backdrop.querySelector('#btn-rescue-more')?.addEventListener('click', () => {
    const currentSchedule = _ctx?.getSchedule();
    if (!currentSchedule || !_rescueResult) return;
    _rescuePage++;
    const liveMode = store.getLiveModeState();
    const wantTotal = (_rescuePage + 1) * 3; // PAGE_SIZE = 3
    const engine = _ctx?.getEngine();
    const result = generateRescuePlans(
      currentSchedule,
      _rescueResult.request,
      liveMode.currentTimestamp,
      0,
      wantTotal,
      engine?.getDisabledHC(),
      engine?.getRestRuleMap(),
      engine?.getDayStartHour() ?? currentSchedule.algorithmSettings.dayStartHour,
      engine?.getCertLabelResolver() ?? ((id: string) => id),
      engine?.getConfig(),
      engine?.buildScoreContext(),
      engine?.getScheduleContext(),
    );
    // Ranks are already sequential from the engine (1-based per returned plan)
    _rescueResult = result;
    showRescueModal();
  });

  // Apply plan buttons
  backdrop.querySelectorAll('.btn-apply-plan').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const planId = (e.target as HTMLElement).dataset.planId;
      const currentSchedule = _ctx?.getSchedule();
      const engine = _ctx?.getEngine();
      if (!planId || !_rescueResult || !currentSchedule || !engine) return;
      const plan = _rescueResult.plans.find((p) => p.id === planId);
      if (!plan) return;
      applyRescuePlan(plan);
    });
  });

  // Rescue participant hover tooltip — show next 3 tasks if plan applied
  const currentSchedule = _ctx?.getSchedule();
  const pMap = new Map<string, Participant>();
  if (currentSchedule) {
    for (const p of currentSchedule.participants) pMap.set(p.id, p);
  }

  if (isTouchDevice) {
    // ── Touch: tap toggles inline task preview ──
    let _expandedRescuePid: string | null = null;

    backdrop.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      const planId = target.dataset.planId;
      const schedule = _ctx?.getSchedule();
      if (!pid || !planId || !_rescueResult || !schedule) return;

      // Remove any existing inline preview
      const existing = backdrop.querySelector('.rescue-inline-preview');
      if (existing) existing.remove();

      if (_expandedRescuePid === pid) {
        _expandedRescuePid = null;
        return;
      }

      const plan = _rescueResult.plans.find((p) => p.id === planId);
      if (!plan) return;
      const participant = pMap.get(pid);
      if (!participant) return;

      _expandedRescuePid = pid;
      const nextTasks = computePostSwapTasks(pid, plan, schedule, _rescueResult.request.taskId);
      const detail = document.createElement('div');
      detail.className = 'rescue-inline-preview task-inline-detail';
      detail.innerHTML = buildRescueParticipantTooltip(participant.name, nextTasks);
      target.insertAdjacentElement('afterend', detail);
    });
  } else {
    // ── Desktop: hover shows fixed tooltip ──
    backdrop.addEventListener('mouseover', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      const planId = target.dataset.planId;
      const schedule = _ctx?.getSchedule();
      if (!pid || !planId || !_rescueResult || !schedule) return;

      const plan = _rescueResult.plans.find((p) => p.id === planId);
      if (!plan) return;
      const participant = pMap.get(pid);
      if (!participant) return;

      if (_rescueTooltipHideTimer) {
        clearTimeout(_rescueTooltipHideTimer);
        _rescueTooltipHideTimer = null;
      }

      const nextTasks = computePostSwapTasks(pid, plan, schedule, _rescueResult.request.taskId);
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
}

function showRescueError(message: string): void {
  const errorBanner = document.createElement('div');
  errorBanner.className = 'rescue-error-banner';
  errorBanner.innerHTML = `<span>${escHtml(message)}</span>
    <button class="rescue-error-dismiss">✕</button>`;
  errorBanner.querySelector('.rescue-error-dismiss')?.addEventListener('click', () => errorBanner.remove());
  const modal = document.querySelector('.rescue-modal');
  if (modal) {
    modal.insertBefore(errorBanner, modal.firstChild);
  }
}

function applyRescuePlan(plan: RescuePlan): void {
  const currentSchedule = _ctx?.getSchedule();
  const engine = _ctx?.getEngine();
  if (!currentSchedule || !engine) return;

  // Staleness check: verify all assignments still match the expected state
  for (const sw of plan.swaps) {
    const a = currentSchedule.assignments.find((a) => a.id === sw.assignmentId);
    if (!a) {
      showRescueError('תוכנית ההחלפה מיושנת — השיבוץ לא נמצא. נסו שוב.');
      return;
    }
    if (a.participantId !== sw.fromParticipantId) {
      showRescueError('תוכנית ההחלפה מיושנת — המשתתף השתנה. נסו שוב.');
      return;
    }
    if (a.status === AssignmentStatus.Frozen) {
      showRescueError('תוכנית ההחלפה מיושנת — השיבוץ קפוא. נסו שוב.');
      return;
    }
  }

  // Build per-step labels before applying (participant names from current state)
  const swapLabels: RescueSwapLabel[] = plan.swaps.map((sw) => {
    const fromName = currentSchedule.participants.find((p) => p.id === sw.fromParticipantId)?.name ?? '';
    const toName = currentSchedule.participants.find((p) => p.id === sw.toParticipantId)?.name ?? '';
    return { label: `החלפה: ${toName} ← ${fromName}` };
  });

  // Apply all swaps atomically via the chain method
  const requests = plan.swaps.map((sw) => ({
    assignmentId: sw.assignmentId,
    newParticipantId: sw.toParticipantId,
  }));
  const result = engine.swapParticipantChain(requests);
  const updated = engine.getSchedule();

  if (!updated || !result.valid) {
    console.warn('[Rescue] Chain swap failed:', result.violations);
    showRescueError('תוכנית ההחלפה לא יושמה בהצלחה — בוצע שחזור למצב הקודם.');
    _ctx?.onPlanFailed();
    return;
  }

  closeRescueModal();
  _ctx?.onPlanApplied(
    updated,
    swapLabels,
    plan.swaps.map((sw) => sw.assignmentId),
  );
}
