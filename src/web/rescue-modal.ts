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
import * as store from './config-store';
import { isTouchDevice } from './responsive';
import { escAttr, escHtml, fmt, getSplitDisplay, stripDayPrefix } from './ui-helpers';

// ─── Context injection ──────────────────────────────────────────────────────

/** One swap step label for the post-rescue toast. */
export interface RescueSwapLabel {
  /** e.g. "החלפה: שירה אדרי ← דניאל וייס" */
  label: string;
}

/** Optional record-as-future-unavailability payload built when the
 *  "mark vacated participant unavailable for this slot's time" checkbox
 *  is checked at apply time. App.ts upserts this onto
 *  `Schedule.scheduleUnavailability` after pushing the undo snapshot. */
export interface VacatedSlotRecord {
  participantId: string;
  start: Date;
  end: Date;
  /** Optional free-text reason captured from the modal input. */
  reason?: string;
}

export interface RescueContext {
  getSchedule: () => Schedule | null;
  getEngine: () => SchedulingEngine | null;
  /** Called after a rescue plan is successfully applied (swaps done, schedule updated).
   *  `recordVacatedSlot` is non-null when the user kept the (default-on)
   *  "mark vacated participant unavailable for this slot's time" checkbox
   *  checked. App.ts is responsible for upserting it onto
   *  `Schedule.scheduleUnavailability` after the undo snapshot push. */
  onPlanApplied: (
    updatedSchedule: Schedule,
    swapLabels: RescueSwapLabel[],
    swappedAssignmentIds: string[],
    recordVacatedSlot: VacatedSlotRecord | null,
  ) => void;
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

// ─── "Record vacated as future unavailability" preference ───────────────────

/** Session-scoped: the user's last choice for the "record vacated participant
 *  as unavailable for this slot's time" checkbox in the rescue modal. Default
 *  is `true` (record). Persists for the session only — not localStorage. */
let _rescueRecordVacatedDefault = true;

/** Per-modal reason input value. Reset when a fresh rescue modal opens so it
 *  does not bleed between unrelated rescue sessions, but preserved across
 *  same-session re-renders (Show More / page navigation). */
let _rescueReasonInflight = '';

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
  _rescueReasonInflight = '';
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
    engine?.getEffectiveConfig(),
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
        <p>משבצת שהתפנתה על ידי <strong>${escHtml(vacatedP?.name || '???')}</strong> ב-
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

    const qualityTier =
      plan.impactScore < excellentCap ? 'excellent' : plan.impactScore < fairCap ? 'fair' : 'significant';
    const qualityLabel = qualityTier === 'excellent' ? 'מצוין' : qualityTier === 'fair' ? 'סביר' : 'משמעותי';

    const isTerminalSplit = plan.terminalSplit === true;
    // Swap count label — friendly wording
    const swapLabel = isTerminalSplit
      ? 'החלפה + פיצול'
      : plan.swaps.length === 1
        ? 'החלפה ישירה'
        : `שרשרת של ${plan.swaps.length}`;

    const isDeepFallback = typeof plan.fallbackDepth === 'number' && plan.fallbackDepth >= 4;

    html += `<div class="rescue-plan${isRecommended ? ' rescue-plan--recommended' : ''}${isDeepFallback ? ' rescue-plan--fallback' : ''}" data-plan-id="${plan.id}">
      <div class="rescue-plan-header">
        <span class="rescue-rank">#${plan.rank}${isRecommended ? ' <span class="rescue-recommended-tag">מומלץ ✓</span>' : ''}</span>
        <span class="rescue-quality rescue-quality--${qualityTier}">● ${qualityLabel}</span>
        <span class="rescue-swaps">${swapLabel}</span>
      </div>
      ${
        isDeepFallback
          ? `<div class="rescue-fallback-warning" dir="rtl">
              ${
                isTerminalSplit
                  ? '⚠️ שילוב החלפה ופיצול — הוצע רק כמוצא אחרון, כשלא נמצאה חלופה אחרת'
                  : '⚠️ שרשרת מעמיקה — הוצעה רק כי לא נמצאה חלופה קצרה יותר'
              }
            </div>`
          : ''
      }`;

    // Build swap + split-fill steps as a plain-language list. Mono-kind plans
    // render a single section; a terminal-split plan renders BOTH the chain
    // swap(s) AND the donor split (swaps and splitOps are independent).
    let stepsHtml = `<ol class="rescue-steps">`;
    for (let i = 0; i < plan.swaps.length; i++) {
      const sw = plan.swaps[i];
      const swP = pMap.get(sw.toParticipantId);
      const fromP = pMap.get(sw.fromParticipantId || '');
      const assignedSpan = `<span class="rescue-participant-hover" data-pid="${sw.toParticipantId}" data-plan-id="${plan.id}"><strong>${escHtml(swP?.name || '???')}</strong></span>`;
      const fromSpan = fromP
        ? `<span class="rescue-participant-hover" data-pid="${sw.fromParticipantId}" data-plan-id="${plan.id}">${escHtml(fromP.name)}</span>`
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
    for (const op of plan.splitOps ?? []) {
      const fillAP = pMap.get(op.fillA.participantId);
      const fillBP = pMap.get(op.fillB.participantId);
      const parentTask = taskMap.get(op.taskId);
      const midDate = new Date(op.midpointMs);
      const midLabel = `<span dir="ltr">${fmt(midDate)}</span>`;
      const startLabel = parentTask ? `<span dir="ltr">${fmt(parentTask.timeBlock.start)}</span>` : '';
      const endLabel = parentTask ? `<span dir="ltr">${fmt(parentTask.timeBlock.end)}</span>` : '';
      const aSpan = `<span class="rescue-participant-hover" data-pid="${op.fillA.participantId}" data-plan-id="${plan.id}"><strong>${escHtml(fillAP?.name || op.fillA.displayName)}</strong></span>`;
      const bSpan = `<span class="rescue-participant-hover" data-pid="${op.fillB.participantId}" data-plan-id="${plan.id}"><strong>${escHtml(fillBP?.name || op.fillB.displayName)}</strong></span>`;
      stepsHtml += `<li class="rescue-step-split">פיצול <strong>${escHtml(op.slotLabel)}</strong> <span class="split-badge">½</span> — ${aSpan} (${startLabel}–${midLabel}) / ${bSpan} (${midLabel}–${endLabel})</li>`;
    }
    stepsHtml += `</ol>`;

    // Plan #1: expanded by default. Others: collapsed.
    if (isRecommended) {
      html += `<div class="rescue-plan-details">
        ${stepsHtml}
      </div>`;
    } else {
      html += `<details class="rescue-plan-details rescue-plan-collapsible">
        <summary class="rescue-plan-expand">הצג פרטים</summary>
        ${stepsHtml}
      </details>`;
    }

    html += `<button class="btn-apply-plan" data-plan-id="${plan.id}">✅ החל תוכנית</button>
    </div>`;
  }

  // "Record vacated participant as future-unavailable" toggle. Single shared
  // state — applies to whichever plan the user clicks Apply on.
  const recordChecked = _rescueRecordVacatedDefault ? ' checked' : '';
  const reasonDisplay = _rescueRecordVacatedDefault ? 'block' : 'none';
  const recordVacatedRow = vacatedP
    ? `<div class="rescue-record-vacated-row">
        <label class="rescue-record-vacated-label">
          <input type="checkbox" id="rescue-record-vacated"${recordChecked}>
          <span>סמן את <strong>${escHtml(vacatedP.name)}</strong> כלא־זמין/ה לחלון הזמן של המשבצת (לרסקיו עתידי)</span>
        </label>
        <div class="rescue-record-vacated-reason" id="rescue-record-vacated-reason" style="display: ${reasonDisplay};">
          <input id="rescue-record-vacated-reason-input"
                 class="input-sm rescue-record-vacated-reason-input"
                 type="text" maxlength="80" autocomplete="off"
                 placeholder="סיבה (אופציונלי, למשל: מילואים, חופש, מחלה)"
                 value="${escAttr(_rescueReasonInflight)}" />
        </div>
      </div>`
    : '';

  html += `</div>
    ${recordVacatedRow}
    <div class="rescue-footer">
      ${hasMore ? `<button class="btn-rescue-more" id="btn-rescue-more">הצג אפשרויות נוספות</button>` : ''}
      <button class="btn-rescue-dismiss" id="btn-rescue-dismiss">סגור</button>
    </div>
    </div></div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  wireRescueModalEvents();
}

/** Task label for swap steps: clean template name + time range, e.g. "שמש 13:00–17:00".
 *  For a split half, makes clear only half the shift is being filled. */
function taskLabel(task: Task | undefined, fallbackName: string): string {
  const name = escHtml(task?.sourceName ?? stripDayPrefix(task?.name ?? fallbackName));
  if (!task) return name;
  const sd = getSplitDisplay(task);
  const splitNote = sd
    ? ` <span class="split-badge">½</span> <span class="rescue-split-note">${sd.halfLabel} · מתוך משמרת <span dir="ltr">${sd.fullWindow}</span></span>`
    : '';
  return `${name} <span dir="ltr">${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</span>${splitNote}`;
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
 *
 * The "reference task" — highlighted with the ◄ marker — is the task this
 * participant is being moved INTO by the chain (the swap where they appear as
 * `toParticipantId`). For the depth-1 participant that is the focal/vacated
 * task; for deeper chain steps it is the donor task they take over. Falls back
 * to `fallbackReferenceTaskId` (the focal task) if the participant isn't a
 * `toParticipantId` in any swap.
 */
function computePostSwapTasks(
  participantId: string,
  plan: RescuePlan,
  schedule: Schedule,
  fallbackReferenceTaskId: string,
): Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  // The task this participant is being moved INTO by the chain is the
  // reference for their tooltip. Each participant typically appears as `to`
  // in exactly one swap of a rescue chain.
  let referenceTaskId = fallbackReferenceTaskId;
  for (const sw of plan.swaps) {
    if (sw.toParticipantId === participantId) {
      referenceTaskId = sw.taskId;
      break;
    }
  }

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
  periodStart: Date,
  dayStartHour: number,
): string {
  let html = `<div class="rescue-hover-tt-header">${escHtml(participantName)} — משימות סביב המשבצת אם יוחל</div>`;
  if (nextTasks.length === 0) {
    html += `<div class="rescue-hover-tt-empty">אין משימות קרובות</div>`;
  } else {
    const baseMidnight = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()).getTime();
    for (let i = 0; i < nextTasks.length; i++) {
      const t = nextTasks[i];
      const shifted = new Date(t.start.getTime());
      if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
      const shiftedMidnight = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime();
      const dIdx = Math.floor((shiftedMidnight - baseMidnight) / (24 * 3600 * 1000)) + 1;
      const dayStr = `יום ${dIdx}`;
      const timeStr = `<span dir="ltr">${fmt(t.start)} – ${fmt(t.end)}</span>`;
      const refClass = t.isReference ? ' rescue-hover-tt-task--ref' : '';
      const refMarker = t.isReference ? ' ◄' : '';
      html += `<div class="rescue-hover-tt-task${refClass}">${i + 1}. ${escHtml(stripDayPrefix(t.taskName))}${refMarker}<span class="rescue-hover-tt-time">${dayStr} ${timeStr}</span></div>`;
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
      engine?.getEffectiveConfig(),
      engine?.buildScoreContext(),
      engine?.getScheduleContext(),
    );
    // Ranks are already sequential from the engine (1-based per returned plan)
    _rescueResult = result;
    showRescueModal();
  });

  // Record-vacated checkbox: update session default whenever it changes so
  // re-rendering after "Show More" preserves the user's choice and the next
  // modal open inherits it. Also toggles the reason input visibility (it is
  // an opt-in inside an opt-in).
  const recordCb = backdrop.querySelector<HTMLInputElement>('#rescue-record-vacated');
  const reasonWrap = backdrop.querySelector<HTMLElement>('#rescue-record-vacated-reason');
  const reasonInput = backdrop.querySelector<HTMLInputElement>('#rescue-record-vacated-reason-input');
  if (recordCb) {
    recordCb.addEventListener('change', () => {
      _rescueRecordVacatedDefault = recordCb.checked;
      if (reasonWrap) {
        reasonWrap.style.display = recordCb.checked ? 'block' : 'none';
        if (recordCb.checked && reasonInput) reasonInput.focus();
      }
    });
  }
  if (reasonInput) {
    reasonInput.addEventListener('input', () => {
      _rescueReasonInflight = reasonInput.value;
    });
  }

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
      detail.innerHTML = buildRescueParticipantTooltip(
        participant.name,
        nextTasks,
        schedule.periodStart,
        schedule.algorithmSettings.dayStartHour,
      );
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
      tooltip.innerHTML = buildRescueParticipantTooltip(
        participant.name,
        nextTasks,
        schedule.periodStart,
        schedule.algorithmSettings.dayStartHour,
      );
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
  if (!currentSchedule || !engine || !_rescueResult) return;

  // Snapshot the checkbox state before closing the modal, then resolve the
  // focal task's time block — those drive the optional VacatedSlotRecord
  // payload that app.ts persists onto `Schedule.scheduleUnavailability`.
  const recordCb = document.getElementById('rescue-record-vacated') as HTMLInputElement | null;
  const recordChecked = recordCb ? recordCb.checked : _rescueRecordVacatedDefault;
  const reasonInputEl = document.getElementById('rescue-record-vacated-reason-input') as HTMLInputElement | null;
  const reasonRaw = (reasonInputEl?.value ?? _rescueReasonInflight).trim();
  const reason = reasonRaw === '' ? undefined : reasonRaw;
  const focalTask = currentSchedule.tasks.find((t) => t.id === _rescueResult!.request.taskId);
  const recordVacatedSlot: VacatedSlotRecord | null =
    recordChecked && focalTask
      ? {
          participantId: _rescueResult.request.vacatedBy,
          start: focalTask.timeBlock.start,
          end: focalTask.timeBlock.end,
          reason,
        }
      : null;

  const isSplitPlan = (plan.splitOps?.length ?? 0) > 0;

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
  if (isSplitPlan) {
    for (const op of plan.splitOps ?? []) {
      const a = currentSchedule.assignments.find((a) => a.id === op.originalAssignmentId);
      if (!a) {
        showRescueError('תוכנית הפיצול מיושנת — השיבוץ הוסר. נסו שוב.');
        return;
      }
      if (a.status === AssignmentStatus.Frozen) {
        showRescueError('תוכנית הפיצול מיושנת — השיבוץ קפוא. נסו שוב.');
        return;
      }
    }
  }

  // Build per-step labels before applying (participant names from current
  // state). A terminal-split plan has BOTH swaps and splitOps — render both.
  const swapLabels: RescueSwapLabel[] = [];
  for (const sw of plan.swaps) {
    const fromName = currentSchedule.participants.find((p) => p.id === sw.fromParticipantId)?.name ?? '';
    const toName = currentSchedule.participants.find((p) => p.id === sw.toParticipantId)?.name ?? '';
    swapLabels.push({ label: `החלפה: ${toName} ← ${fromName}` });
  }
  for (const op of plan.splitOps ?? []) {
    const aName =
      currentSchedule.participants.find((p) => p.id === op.fillA.participantId)?.name ?? op.fillA.displayName;
    const bName =
      currentSchedule.participants.find((p) => p.id === op.fillB.participantId)?.name ?? op.fillB.displayName;
    swapLabels.push({ label: `פיצול: ${aName} / ${bName}` });
  }

  // Apply through `applyPlanOps` when the plan includes split-fill ops;
  // otherwise the existing pure-swap-chain path.
  let result: ReturnType<typeof engine.swapParticipantChain>;
  if (isSplitPlan) {
    result = engine.applyPlanOps({
      swaps: plan.swaps.map((sw) => ({ assignmentId: sw.assignmentId, newParticipantId: sw.toParticipantId })),
      splitOps: plan.splitOps,
    });
  } else {
    const requests = plan.swaps.map((sw) => ({
      assignmentId: sw.assignmentId,
      newParticipantId: sw.toParticipantId,
    }));
    result = engine.swapParticipantChain(requests);
  }
  const updated = engine.getSchedule();

  if (!updated || !result.valid) {
    console.warn('[Rescue] Plan apply failed:', result.violations);
    showRescueError('תוכנית ההחלפה לא יושמה בהצלחה — בוצע שחזור למצב הקודם.');
    _ctx?.onPlanFailed();
    return;
  }

  closeRescueModal();
  const animIds: string[] = plan.swaps.map((sw) => sw.assignmentId);
  if (isSplitPlan) {
    for (const op of plan.splitOps ?? []) {
      animIds.push(`${op.originalAssignmentId}#a`, `${op.originalAssignmentId}#b`);
    }
  }
  _ctx?.onPlanApplied(updated, swapLabels, animIds, recordVacatedSlot);
}
