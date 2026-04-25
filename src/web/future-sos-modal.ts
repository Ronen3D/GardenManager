/**
 * Future SOS Modal — confirmation + batch rescue plan UI (v2).
 *
 * Two phases, both as `.gm-modal-dialog` sheets:
 *   1) openConfirmModal — step-scoped impact preview with one checkbox per
 *      affected assignment (opt-out per slot), collapsible locked-past chip,
 *      sticky action bar. Returns `{ confirmed, excludedIds }`.
 *   2) openBatchPlansModal — each plan is rendered as a card with a human
 *      verdict headline, swaps grouped by day, and a `פרטים ▾` expander
 *      that reveals the full fairness breakdown, per-participant deltas,
 *      and violations. On touch devices the cards form a scroll-snap carousel
 *      with a pager; on pointer devices they stack with only rank #1
 *      expanded. Soft-violation Apply goes through a confirmation step;
 *      infeasibility is surfaced as inline text with a "narrow the window"
 *      action rather than a muted disabled button.
 */

import type { AffectedAssignment, BatchRescuePlan, BatchRescueResult } from '../engine/future-sos';
import type { Participant, Schedule, Task } from '../models/types';
import { operationalDateKey } from '../utils/date-utils';
import { cleanSlotLabel, escAttr, escHtml, fmt, stripDayPrefix } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

// ─── Confirmation ────────────────────────────────────────────────────────────

export interface ConfirmContext {
  participantName: string;
  window: { start: Date; end: Date };
  affected: AffectedAssignment[];
  lockedInPast: AffectedAssignment[];
  dayStartHour: number;
  periodStart: Date;
  /** Assignment IDs to start unchecked (e.g. carried over from a prior infeasible attempt). */
  preExcludedIds?: ReadonlySet<string>;
}

/** Convert an absolute timestamp to its schedule-day index (1..periodDays),
 *  relative to the schedule's frozen `periodStart` + `dayStartHour`. */
function toDayIndex(d: Date, periodStart: Date, dayStartHour: number): number {
  const shifted = new Date(d.getTime());
  if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
  const baseMidnight = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()).getTime();
  const shiftedMidnight = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime();
  return Math.floor((shiftedMidnight - baseMidnight) / (24 * 3600 * 1000)) + 1;
}

export interface ConfirmResult {
  confirmed: boolean;
  /** IDs of affected assignments the user opted out of replacing. */
  excludedIds: string[];
}

export function openConfirmModal(ctx: ConfirmContext): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';

    const excludedIds = new Set<string>(ctx.preExcludedIds ?? []);

    const affectedHtml =
      ctx.affected.length > 0
        ? renderAffectedChecklist(ctx.affected, ctx.dayStartHour, ctx.periodStart, excludedIds)
        : '';
    const lockedHtml =
      ctx.lockedInPast.length > 0 ? renderLockedChip(ctx.lockedInPast, ctx.dayStartHour, ctx.periodStart) : '';

    const windowSentence = renderWindowSentence(ctx.window, ctx.periodStart, ctx.dayStartHour);

    backdrop.innerHTML = `
      <div class="gm-modal-dialog fsos-modal fsos-confirm-v2" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🆘</span>
          <span class="gm-modal-title">אי זמינות עתידית — השפעה · ${escHtml(ctx.participantName)}</span>
        </div>
        <div class="fsos-window-sentence">${windowSentence}</div>
        ${
          ctx.affected.length > 0
            ? `<h4 class="profile-sub-title fsos-affected-title">שיבוצים שיש להחליף</h4>${affectedHtml}`
            : '<p class="gm-modal-body fsos-empty-note">אין שיבוצים חופפים לחלון זה.</p>'
        }
        ${lockedHtml}
        <div class="fsos-confirm-summary" id="fsos-confirm-summary"></div>
        <div class="gm-modal-actions fsos-sticky-actions">
          <button class="btn-primary fsos-confirm-btn">
            ${ctx.affected.length === 0 ? 'רשום חלון בלבד' : 'מצא תוכניות'}
          </button>
          <button class="btn-sm btn-outline fsos-cancel-btn">חזור</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = (val: ConfirmResult) => {
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const summaryEl = backdrop.querySelector('#fsos-confirm-summary') as HTMLElement;
    const confirmBtn = backdrop.querySelector('.fsos-confirm-btn') as HTMLButtonElement;

    const refreshSummary = () => {
      const selectedCount = ctx.affected.length - excludedIds.size;
      if (ctx.affected.length === 0) {
        summaryEl.textContent = '';
        summaryEl.style.display = 'none';
        return;
      }
      summaryEl.style.display = 'block';
      if (selectedCount === 0) {
        summaryEl.textContent = 'בחרת להשאיר את כל השיבוצים. ייתכן שהחלון יירשם בלבד, ללא החלפות.';
        summaryEl.classList.add('fsos-confirm-summary--muted');
      } else {
        summaryEl.textContent = `יוחלפו ${selectedCount} שיבוצים.`;
        summaryEl.classList.remove('fsos-confirm-summary--muted');
      }
      confirmBtn.textContent = selectedCount === 0 ? 'רשום חלון בלבד' : 'מצא תוכניות';
    };

    backdrop.querySelectorAll<HTMLInputElement>('.fsos-affected-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.dataset.assignmentId ?? '';
        if (!id) return;
        if (cb.checked) excludedIds.delete(id);
        else excludedIds.add(id);
        refreshSummary();
      });
    });

    backdrop.querySelectorAll<HTMLElement>('.fsos-locked-toggle').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const panel = toggle.nextElementSibling as HTMLElement | null;
        if (!panel) return;
        const open = panel.hasAttribute('hidden');
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', String(open));
      });
    });

    confirmBtn.addEventListener('click', () => close({ confirmed: true, excludedIds: [...excludedIds] }));
    backdrop
      .querySelector('.fsos-cancel-btn')
      ?.addEventListener('click', () => close({ confirmed: false, excludedIds: [] }));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close({ confirmed: false, excludedIds: [] });
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close({ confirmed: false, excludedIds: [] });
    }
    document.addEventListener('keydown', onKey);

    refreshSummary();
    document.body.appendChild(backdrop);
  });
}

function renderWindowSentence(window: { start: Date; end: Date }, periodStart: Date, dayStartHour: number): string {
  const startLabel = fmtDayLabel(window.start, periodStart, dayStartHour);
  const endLabel = fmtDayLabel(window.end, periodStart, dayStartHour);
  if (startLabel === endLabel) {
    return `החלון: <strong>${escHtml(startLabel)}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.start)}–${fmt(window.end)}</span>`;
  }
  return `החלון: <strong>${escHtml(startLabel)}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.start)}</span> → <strong>${escHtml(endLabel)}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.end)}</span>`;
}

function fmtDayLabel(d: Date, periodStart: Date, dayStartHour: number): string {
  return `יום ${toDayIndex(d, periodStart, dayStartHour)}`;
}

function renderAffectedChecklist(
  items: AffectedAssignment[],
  dayStartHour: number,
  periodStart: Date,
  excludedIds: ReadonlySet<string>,
): string {
  const byDay = groupByOperationalDay(items, dayStartHour);
  let html = '<div class="fsos-confirm-groups">';
  for (const [_key, dayItems] of byDay) {
    if (dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    html += `<div class="fsos-affected-day-group"><div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor, periodStart, dayStartHour))}</div><ul class="fsos-confirm-list">`;
    for (const it of dayItems) {
      const time = `<span dir="ltr" class="fsos-ltr">${fmt(it.task.timeBlock.start)}–${fmt(it.task.timeBlock.end)}</span>`;
      const cleaned = it.slot.label ? cleanSlotLabel(it.slot.label) : '';
      const slotLabel = cleaned ? ` · ${escHtml(cleaned)}` : '';
      const checkedAttr = excludedIds.has(it.assignment.id) ? '' : ' checked';
      html += `<li>
        <label class="fsos-affected-check">
          <input type="checkbox" class="fsos-affected-checkbox" data-assignment-id="${escAttr(it.assignment.id)}"${checkedAttr}>
          <span class="fsos-affected-name">${escHtml(stripDayPrefix(it.task.name))}${slotLabel}</span>
        </label>
        ${time}
      </li>`;
    }
    html += '</ul></div>';
  }
  html += '</div>';
  return html;
}

function renderLockedChip(items: AffectedAssignment[], dayStartHour: number, periodStart: Date): string {
  const byDay = groupByOperationalDay(items, dayStartHour);
  let panelHtml = '<div class="fsos-locked-panel" hidden>';
  for (const [_key, dayItems] of byDay) {
    if (dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    panelHtml += `<div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor, periodStart, dayStartHour))}</div><ul class="fsos-locked-list">`;
    for (const it of dayItems) {
      const time = `<span dir="ltr" class="fsos-ltr">${fmt(it.task.timeBlock.start)}–${fmt(it.task.timeBlock.end)}</span>`;
      const cleaned = it.slot.label ? cleanSlotLabel(it.slot.label) : '';
      const slotLabel = cleaned ? ` · ${escHtml(cleaned)}` : '';
      panelHtml += `<li><span>${escHtml(stripDayPrefix(it.task.name))}${slotLabel}</span>${time}</li>`;
    }
    panelHtml += '</ul>';
  }
  panelHtml += '</div>';
  return `<div class="fsos-locked-section">
    <button type="button" class="fsos-locked-toggle" aria-expanded="false">
      <span class="fsos-locked-chip">🔒 ${items.length} שיבוצים בעבר (נעולים)</span>
      <span class="fsos-locked-arrow">▾</span>
    </button>
    ${panelHtml}
  </div>`;
}

function groupByOperationalDay<T extends AffectedAssignment>(items: T[], dayStartHour: number): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const key = operationalDateKey(item.task.timeBlock.start, dayStartHour);
    let list = byDay.get(key);
    if (!list) {
      list = [];
      byDay.set(key, list);
    }
    list.push(item);
  }
  const sortedKeys = [...byDay.keys()].sort();
  const ordered = new Map<string, T[]>();
  for (const k of sortedKeys) ordered.set(k, byDay.get(k)!);
  return ordered;
}

// ─── Loading overlay ─────────────────────────────────────────────────────────

const FSOS_LOADER_ID = 'fsos-loading-overlay';

/**
 * Show a brief loading overlay while the (synchronous) batch planner runs.
 * Yields a microtask so the overlay actually paints before the main thread
 * blocks on plan computation. Caller must await `closeLoadingOverlay`.
 */
export async function openLoadingOverlay(): Promise<void> {
  closeLoadingOverlay();
  const overlay = document.createElement('div');
  overlay.id = FSOS_LOADER_ID;
  overlay.className = 'optim-overlay fsos-loading-overlay';
  overlay.innerHTML = `
    <div class="optim-card">
      <div class="cube-loader-wrapper optim-cube">
        <div class="cube-loader">
          <div class="cube-cell" style="--cell-color:#4A90D9"></div>
          <div class="cube-cell" style="--cell-color:#E74C3C"></div>
          <div class="cube-cell" style="--cell-color:#F39C12"></div>
          <div class="cube-cell" style="--cell-color:#27AE60"></div>
          <div class="cube-cell" style="--cell-color:#8E44AD"></div>
          <div class="cube-cell" style="--cell-color:#1ABC9C"></div>
          <div class="cube-cell" style="--cell-color:#3498db"></div>
          <div class="cube-cell" style="--cell-color:#e67e22"></div>
          <div class="cube-cell" style="--cell-color:#2ecc71"></div>
        </div>
      </div>
      <h3>מחפש תוכניות החלפה…</h3>
    </div>`;
  document.body.appendChild(overlay);
  // Double-RAF: wait for layout + paint before returning so the synchronous
  // computation that follows doesn't block the loader from ever rendering.
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function closeLoadingOverlay(): void {
  document.getElementById(FSOS_LOADER_ID)?.remove();
}

// ─── Infeasibility ───────────────────────────────────────────────────────────

export type InfeasibleDecision = 'remove-and-retry' | 'narrow-window' | 'cancel';

export interface InfeasibleContext {
  participantName: string;
  affected: AffectedAssignment[];
  /** Subset of `affected` for which no candidate chain was found at all. */
  unsolvable: AffectedAssignment[];
  /**
   * True when the planner returned best-so-far due to a wall-clock budget
   * cap. In that case "no plan" may not be a true infeasibility — the search
   * just ran out of time. Surface it so the user can choose to narrow rather
   * than assume the batch is unsolvable.
   */
  timedOut: boolean;
  dayStartHour: number;
  periodStart: Date;
}

/**
 * Shown instead of the plans modal when no plan is both HC-clean and complete
 * (i.e. every returned plan either violates HC or leaves slots unfilled).
 *
 * Two distinct failure shapes feed this modal:
 *   - **No-chain slots**: assignments in `unsolvable` had zero candidate
 *     chains at any depth — they cannot be filled regardless of the rest.
 *   - **Composition-only failure**: every slot has individual chains, but no
 *     joint composition passes hard constraints. These slots get an amber
 *     "candidate exists but no working combination" treatment — *not* a
 *     green checkmark, because nothing in this modal is actually applyable.
 *
 * Three actions: remove the no-chain items and retry (preferred when any
 * exist), narrow the window, or cancel.
 */
export function openInfeasibleModal(ctx: InfeasibleContext): Promise<InfeasibleDecision> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';

    const unsolvableSet = new Set(ctx.unsolvable.map((a) => a.assignment.id));
    const candidateOnly = ctx.affected.filter((a) => !unsolvableSet.has(a.assignment.id));

    const hasUnsolvable = ctx.unsolvable.length > 0;
    const hasCandidateOnly = candidateOnly.length > 0;

    const timeoutHtml = ctx.timedOut
      ? `<div class="fsos-warning-banner fsos-warning-banner--timeout">
          <strong>⏱ החיפוש נקטע בגלל מגבלת זמן.</strong>
          <span>ייתכן שיש תוכנית טובה יותר שלא נבדקה — מומלץ לצמצם את החלון ולנסות שוב.</span>
        </div>`
      : '';

    let explainText: string;
    if (hasUnsolvable && hasCandidateOnly) {
      explainText =
        'לחלק מהשיבוצים לא נמצאה תוכנית החלפה כלל, ושאר השיבוצים — אף שקיימים להם מועמדים בנפרד — לא ניתן לשלב לתוכנית שעומדת באילוצים הקשיחים. ניתן להוציא את הבלתי־פתירים ולנסות שוב; אם גם אחר כך לא יימצא שילוב, יש לצמצם ידנית את האצווה.';
    } else if (hasUnsolvable) {
      explainText =
        'לחלק מהשיבוצים לא נמצאה תוכנית החלפה כלל. ניתן להוציא אותם מהאצווה ולנסות שוב.';
    } else {
      explainText =
        'לכל שיבוץ נמצאו מועמדים בנפרד, אך לא נמצא שילוב ביניהם שעומד באילוצים הקשיחים. נסה להוציא חלק מהשיבוצים מהאצווה ידנית כדי לאפשר תוכנית.';
    }
    const explainHtml = `<p class="fsos-infeasible-explain">${escHtml(explainText)}</p>`;

    const unsolvableHtml = hasUnsolvable
      ? `<section class="fsos-infeasible-section fsos-infeasible-section--missing">
          <h4 class="fsos-infeasible-section-title">❌ לא נמצאה תוכנית החלפה (${ctx.unsolvable.length})</h4>
          <p class="fsos-infeasible-section-note">לשיבוצים האלה אין מועמד מתאים בכלל.</p>
          ${renderInfeasibleList(ctx.unsolvable, ctx.dayStartHour, ctx.periodStart)}
        </section>`
      : '';

    const candidateOnlyHtml = hasCandidateOnly
      ? `<section class="fsos-infeasible-section fsos-infeasible-section--candidate">
          <h4 class="fsos-infeasible-section-title">⚠️ קיימים מועמדים אך לא נמצא שילוב תקף (${candidateOnly.length})</h4>
          <p class="fsos-infeasible-section-note">לשיבוצים האלה יש מועמדים בנפרד, אבל המועמדים מתנגשים זה בזה — אי אפשר ליישם אותם יחד מבלי להפר אילוצים.</p>
          ${renderInfeasibleList(candidateOnly, ctx.dayStartHour, ctx.periodStart)}
        </section>`
      : '';

    const retryLabel = hasUnsolvable ? 'הסר את הבלתי־פתירים ונסה שוב' : 'חזור והסר שיבוצים ידנית';

    backdrop.innerHTML = `
      <div class="gm-modal-dialog fsos-modal fsos-infeasible-modal" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">⚠️</span>
          <span class="gm-modal-title">לא נמצאה תוכנית החלפה תקפה · ${escHtml(ctx.participantName)}</span>
        </div>
        ${timeoutHtml}
        ${explainHtml}
        ${unsolvableHtml}
        ${candidateOnlyHtml}
        <div class="gm-modal-actions fsos-sticky-actions">
          <button class="btn-primary fsos-infeasible-retry-btn">${escHtml(retryLabel)}</button>
          <button class="btn-sm btn-outline fsos-infeasible-narrow-btn">צמצם חלון</button>
          <button class="btn-sm btn-outline fsos-infeasible-cancel-btn">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = (decision: InfeasibleDecision) => {
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(decision);
    };

    backdrop.querySelector('.fsos-infeasible-retry-btn')?.addEventListener('click', () => close('remove-and-retry'));
    backdrop.querySelector('.fsos-infeasible-narrow-btn')?.addEventListener('click', () => close('narrow-window'));
    backdrop.querySelector('.fsos-infeasible-cancel-btn')?.addEventListener('click', () => close('cancel'));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close('cancel');
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close('cancel');
    }
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
  });
}

function renderInfeasibleList(items: AffectedAssignment[], dayStartHour: number, periodStart: Date): string {
  const byDay = groupByOperationalDay(items, dayStartHour);
  let html = '<div class="fsos-confirm-groups">';
  for (const [_key, dayItems] of byDay) {
    if (dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    html += `<div class="fsos-affected-day-group"><div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor, periodStart, dayStartHour))}</div><ul class="fsos-infeasible-list">`;
    for (const it of dayItems) {
      const time = `<span dir="ltr" class="fsos-ltr">${fmt(it.task.timeBlock.start)}–${fmt(it.task.timeBlock.end)}</span>`;
      const cleaned = it.slot.label ? cleanSlotLabel(it.slot.label) : '';
      const slotLabel = cleaned ? ` · ${escHtml(cleaned)}` : '';
      html += `<li>
        <span class="fsos-affected-name">${escHtml(stripDayPrefix(it.task.name))}${slotLabel}</span>
        ${time}
      </li>`;
    }
    html += '</ul></div>';
  }
  html += '</div>';
  return html;
}

// ─── Batch Plans ─────────────────────────────────────────────────────────────

export interface BatchPlansContext {
  result: BatchRescueResult;
  schedule: Schedule;
  participantName: string;
  onApply: (plan: BatchRescuePlan) => void;
  /** Invoked when the user taps "צמצם חלון" on the infeasibility banner. */
  onNarrowWindow?: () => void;
}

interface PlanVerdict {
  level: 'excellent' | 'good' | 'fair' | 'poor';
  label: string;
}

function computeVerdict(plan: BatchRescuePlan): PlanVerdict {
  if (plan.violations.length > 0) return { level: 'poor', label: 'בעייתי' };
  const cd = plan.compositeDelta;
  if (cd >= 5) return { level: 'excellent', label: 'מצוין' };
  if (cd >= 0) return { level: 'good', label: 'טוב' };
  return { level: 'fair', label: 'סביר' };
}

export function openBatchPlansModal(ctx: BatchPlansContext): void {
  const existing = document.getElementById('fsos-plans-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'fsos-plans-backdrop';
  backdrop.className = 'gm-modal-backdrop';

  const pMap = new Map<string, Participant>();
  for (const p of ctx.schedule.participants) pMap.set(p.id, p);
  const taskMap = new Map<string, Task>();
  for (const t of ctx.schedule.tasks) taskMap.set(t.id, t);

  const dayStartHour = ctx.schedule.algorithmSettings.dayStartHour;
  const hasInfeasible = ctx.result.infeasibleAssignmentIds.length > 0;
  const warningHtml = hasInfeasible ? renderInfeasibleWarning(ctx.result) : '';
  const timeoutHtml = ctx.result.timedOut ? renderTimeoutBanner(ctx.result.plans.length > 0) : '';
  const usesDeepFallback = ctx.result.plans.some((p) => p.fallbackDepthUsed !== undefined);
  const fallbackHtml = usesDeepFallback ? renderFallbackBanner() : '';
  const isTouch = document.documentElement.classList.contains('touch-device');

  let plansHtml = '';
  let pagerHtml = '';
  if (ctx.result.plans.length === 0) {
    plansHtml = renderNoPlans();
  } else if (isTouch) {
    // Carousel layout: all plans expanded, horizontally scrollable with snap points.
    const cards = ctx.result.plans
      .map((p) =>
        renderBatchPlanCard(p, pMap, taskMap, dayStartHour, ctx.schedule.periodStart, hasInfeasible, {
          expanded: true,
        }),
      )
      .join('');
    plansHtml = `<div class="fsos-carousel" role="region" aria-label="תוכניות החלפה">${cards}</div>`;
    pagerHtml = renderCarouselPager(ctx.result.plans);
  } else {
    // Stacked layout: rank #1 expanded, others collapsed to a verdict summary.
    const cards = ctx.result.plans
      .map((p) =>
        renderBatchPlanCard(p, pMap, taskMap, dayStartHour, ctx.schedule.periodStart, hasInfeasible, {
          expanded: p.rank === 1,
        }),
      )
      .join('');
    plansHtml = `<div class="fsos-plans-stack">${cards}</div>`;
  }

  backdrop.innerHTML = `
    <div class="gm-modal-dialog fsos-modal fsos-plans-v2 ${isTouch ? 'fsos-plans--touch' : ''}" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">🆘</span>
        <span class="gm-modal-title">אי זמינות עתידית — תוכניות · ${escHtml(ctx.participantName)}</span>
      </div>
      ${timeoutHtml}
      ${warningHtml}
      ${fallbackHtml}
      ${pagerHtml}
      ${plansHtml}
      <div class="gm-modal-actions fsos-sticky-actions">
        <button class="btn-sm btn-outline fsos-close-btn">סגור</button>
      </div>
    </div>`;

  lockBodyScroll();
  const close = () => {
    backdrop.remove();
    unlockBodyScroll();
    document.removeEventListener('keydown', onKey);
  };
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  backdrop.querySelector('.fsos-close-btn')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  backdrop.querySelectorAll<HTMLButtonElement>('.fsos-narrow-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      close();
      ctx.onNarrowWindow?.();
    });
  });

  if (!isTouch) {
    backdrop.querySelectorAll<HTMLElement>('.fsos-plan-collapsed').forEach((header) => {
      header.addEventListener('click', () => togglePlanCard(header));
    });

    backdrop.querySelectorAll<HTMLElement>('.fsos-plan-toggle').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const card = toggle.closest('.fsos-plan-card') as HTMLElement | null;
        if (card) togglePlanCard(card);
      });
    });
  }

  backdrop.querySelectorAll<HTMLButtonElement>('.fsos-apply-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const planId = btn.dataset.planId;
      const plan = ctx.result.plans.find((p) => p.id === planId);
      if (!plan) return;
      // Soft-violation plans require an extra confirmation step.
      if (plan.violations.length > 0) {
        const ok = await showSoftViolationsSubConfirm(plan);
        if (!ok) return;
      }
      close();
      ctx.onApply(plan);
    });
  });

  if (isTouch) {
    const carousel = backdrop.querySelector<HTMLElement>('.fsos-carousel');
    if (carousel) wireCarouselGestureForwarding(carousel);
  }

  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
}

// Mobile browsers don't reliably chain horizontal swipes from a vertically-
// scrolling child (card body) to a horizontally-scrolling parent (carousel).
// Take over touch handling at the carousel level: lock to an axis after the
// first 8px of movement, then drive carousel.scrollLeft (horizontal) or the
// hit body's scrollTop (vertical) manually. Scroll-snap is disabled during
// the gesture to avoid fighting programmatic scroll, then re-engaged via a
// JS snap on touchend.
function wireCarouselGestureForwarding(carousel: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let axis: 'x' | 'y' | null = null;
  let activeBody: HTMLElement | null = null;
  const isRtl = getComputedStyle(carousel).direction === 'rtl';

  carousel.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = lastX = t.clientX;
      startY = lastY = t.clientY;
      axis = null;
      activeBody = (t.target as HTMLElement | null)?.closest<HTMLElement>('.fsos-plan-body') ?? null;
    },
    { passive: true, capture: true },
  );

  carousel.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const x = t.clientX;
      const y = t.clientY;

      if (axis === null) {
        const dx = Math.abs(x - startX);
        const dy = Math.abs(y - startY);
        if (dx < 8 && dy < 8) return;
        axis = dx > dy ? 'x' : 'y';
        if (axis === 'x') carousel.style.scrollSnapType = 'none';
      }

      if (axis === 'x') {
        // In RTL Chrome/Firefox, scrollLeft is 0 at the rightmost position
        // and becomes negative when scrolled left. In LTR it's the reverse.
        const delta = x - lastX;
        carousel.scrollLeft += isRtl ? delta : -delta;
        e.preventDefault();
      } else if (axis === 'y' && activeBody) {
        const delta = y - lastY;
        activeBody.scrollTop -= delta;
        e.preventDefault();
      }
      lastX = x;
      lastY = y;
    },
    { passive: false, capture: true },
  );

  const endGesture = () => {
    if (axis === 'x') {
      carousel.style.scrollSnapType = '';
      // JS snap: scroll the nearest card's start edge into view.
      const cards = Array.from(carousel.querySelectorAll<HTMLElement>('.fsos-plan-card'));
      if (cards.length > 0) {
        const rect = carousel.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        let closest = cards[0];
        let minDist = Infinity;
        for (const c of cards) {
          const r = c.getBoundingClientRect();
          const d = Math.abs(r.left + r.width / 2 - center);
          if (d < minDist) {
            minDist = d;
            closest = c;
          }
        }
        closest.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
    axis = null;
    activeBody = null;
  };
  carousel.addEventListener('touchend', endGesture, { capture: true });
  carousel.addEventListener('touchcancel', endGesture, { capture: true });
}

function togglePlanCard(cardOrHeader: HTMLElement) {
  const card = cardOrHeader.classList.contains('fsos-plan-card')
    ? cardOrHeader
    : (cardOrHeader.closest('.fsos-plan-card') as HTMLElement | null);
  if (!card) return;
  const nowExpanded = !card.classList.contains('fsos-plan-card--expanded');
  card.classList.toggle('fsos-plan-card--expanded', nowExpanded);
  card.querySelector('.fsos-plan-toggle')?.setAttribute('aria-expanded', String(nowExpanded));
}

function renderTimeoutBanner(hasPartialPlans: boolean): string {
  const body = hasPartialPlans
    ? 'חיפוש התוכניות הגיע לתקרת הזמן לפני שסיים. ייתכנו תוכניות טובות יותר שלא נבדקו.'
    : 'חיפוש התוכניות הגיע לתקרת הזמן לפני שנמצאה תוכנית כלשהי.';
  return `<div class="fsos-warning-banner fsos-warning-banner--timeout">
    <strong>⏱ החיפוש נקטע בגלל מגבלת זמן.</strong>
    <span>${escHtml(body)}</span>
    <button type="button" class="fsos-narrow-btn btn-sm btn-outline">חפש שוב עם חלון קטן יותר</button>
  </div>`;
}

function renderInfeasibleWarning(result: BatchRescueResult): string {
  const lines: string[] = [];
  for (const aId of result.infeasibleAssignmentIds) {
    const aff = result.affected.find((a) => a.assignment.id === aId);
    if (!aff) continue;
    const time = `<span dir="ltr" class="fsos-ltr">${fmt(aff.task.timeBlock.start)}–${fmt(aff.task.timeBlock.end)}</span>`;
    const cleaned = aff.slot.label ? cleanSlotLabel(aff.slot.label) : '';
    const slotLabel = cleaned ? ` · ${escHtml(cleaned)}` : '';
    lines.push(`<li>${escHtml(stripDayPrefix(aff.task.name))}${slotLabel} — ${time}</li>`);
  }
  return `<div class="fsos-warning-banner fsos-warning-banner--infeasible">
    <strong>⚠️ לא ניתן להחליף את כל השיבוצים בעומק ≤ 3.</strong>
    <ul>${lines.join('')}</ul>
    <button type="button" class="fsos-narrow-btn btn-sm btn-outline">חזור וצמצם חלון</button>
  </div>`;
}

function renderNoPlans(): string {
  return `<div class="fsos-empty-state">
    <div class="fsos-empty-state-icon" aria-hidden="true">🔍</div>
    <h4 class="fsos-empty-state-title">לא נמצאו תוכניות החלפה</h4>
    <p class="fsos-empty-state-body">ניסינו עומק 1–5 ולא הצלחנו להשלים את השיבוצים.</p>
    <div class="fsos-empty-state-actions">
      <button type="button" class="fsos-narrow-btn btn-sm btn-outline">צמצם חלון</button>
    </div>
  </div>`;
}

/**
 * Rendered when at least one plan in the result used the deep-chain fallback
 * (depth 4 or 5). Signals to the user that the shallow-chain search exhausted
 * and the engine produced unusually long chains as a last-resort. Plan details
 * are still shown as usual — the banner just primes the user to expect deeper
 * chains inside the per-slot "Show Details" sections.
 */
function renderFallbackBanner(): string {
  return `<div class="fsos-warning-banner fsos-warning-banner--fallback">
    <strong>⚠️ תוכנית זו נוצרה במצב חירום ועלולה לכלול שרשראות עמוקות — כדאי לעיין בפרטים לפני אישור.</strong>
  </div>`;
}

function renderCarouselPager(plans: BatchRescuePlan[]): string {
  const dots = plans
    .map((_, i) => `<span class="fsos-carousel-dot${i === 0 ? ' fsos-carousel-dot--active' : ''}"></span>`)
    .join('');
  return `<div class="fsos-carousel-pager"><div class="fsos-carousel-dots" aria-hidden="true">${dots}</div></div>`;
}

function renderBatchPlanCard(
  plan: BatchRescuePlan,
  pMap: Map<string, Participant>,
  taskMap: Map<string, Task>,
  dayStartHour: number,
  periodStart: Date,
  infeasible: boolean,
  opts: { expanded: boolean },
): string {
  const verdict = computeVerdict(plan);

  const swapsGrouped = renderSwapsGroupedByDay(plan, pMap, taskMap, dayStartHour, periodStart);

  const detailsHtml = renderPlanDetails(plan, pMap);

  const recommended = plan.rank === 1 && !plan.isPartial;
  const expandedClass = opts.expanded ? ' fsos-plan-card--expanded' : '';
  const partialBadgeHtml = plan.isPartial
    ? `<span class="fsos-partial-badge" title="תוכנית זו ממלאת רק חלק מהשיבוצים ולא ניתנת להחלה">תצוגה חלקית בלבד</span>`
    : '';
  const rankLine = `#${plan.rank}${recommended ? ' · מומלץ' : ''}`;

  let applyHtml = '';
  if (infeasible) {
    applyHtml = `<div class="fsos-apply-infeasible">לא ניתן להחיל — יש שיבוצים ללא פתרון</div>`;
  } else {
    const disabledAttr = '';
    const violationHint = plan.violations.length > 0 ? ' fsos-apply-btn--warn' : '';
    const label = plan.violations.length > 0 ? `⚠️ החל בכל זאת (${plan.violations.length} הפרות)` : '✅ החל תוכנית';
    applyHtml = `<button class="btn-primary fsos-apply-btn${violationHint}" data-plan-id="${escAttr(plan.id)}"${disabledAttr}>${label}</button>`;
  }

  return `<div class="fsos-plan-card fsos-plan-card--${verdict.level}${recommended ? ' fsos-plan-card--recommended' : ''}${expandedClass}" data-plan-rank="${plan.rank}">
    <header class="fsos-plan-collapsed">
      <div class="fsos-plan-header-main">
        <span class="fsos-plan-rank">${escHtml(rankLine)}</span>
        ${partialBadgeHtml}
        <span class="fsos-verdict fsos-verdict--${verdict.level}">${escHtml(verdict.label)}</span>
        <button type="button" class="fsos-plan-toggle" aria-expanded="${opts.expanded ? 'true' : 'false'}" aria-label="הרחב/הסתר פרטים">
          <span class="fsos-plan-toggle-label">פרטים</span>
          <span class="fsos-plan-toggle-arrow">▾</span>
        </button>
      </div>
    </header>
    <div class="fsos-plan-body">
      ${swapsGrouped}
      ${detailsHtml}
      ${applyHtml}
    </div>
  </div>`;
}

function renderSwapsGroupedByDay(
  plan: BatchRescuePlan,
  pMap: Map<string, Participant>,
  taskMap: Map<string, Task>,
  dayStartHour: number,
  periodStart: Date,
): string {
  interface RenderedSwap {
    timeStart: string;
    timeEnd: string;
    sortKey: number;
    taskName: string;
    slotLabel: string;
    fromName: string;
    toName: string;
    dayLabel: string;
  }
  const bySwapDayKey = new Map<string, RenderedSwap[]>();

  for (const sw of plan.swaps) {
    const toName = pMap.get(sw.toParticipantId)?.name ?? '???';
    const fromName = sw.fromParticipantId ? (pMap.get(sw.fromParticipantId)?.name ?? '???') : '—';
    const task = taskMap.get(sw.taskId);
    const taskStart = task?.timeBlock.start ?? null;
    const taskEnd = task?.timeBlock.end ?? null;
    const dayKey = taskStart ? operationalDateKey(taskStart, dayStartHour) : sw.assignmentId;
    const dayLabel = taskStart ? fmtDayLabel(taskStart, periodStart, dayStartHour) : '';
    let list = bySwapDayKey.get(dayKey);
    if (!list) {
      list = [];
      bySwapDayKey.set(dayKey, list);
    }
    list.push({
      timeStart: taskStart ? fmt(taskStart) : '',
      timeEnd: taskEnd ? fmt(taskEnd) : '',
      sortKey: taskStart ? taskStart.getTime() : 0,
      taskName: stripDayPrefix(sw.taskName),
      slotLabel: cleanSlotLabel(sw.slotLabel),
      fromName,
      toName,
      dayLabel,
    });
  }

  const keys = [...bySwapDayKey.keys()].sort();
  let html = '<div class="fsos-plan-swaps-grouped">';
  for (const k of keys) {
    const items = (bySwapDayKey.get(k) ?? []).slice().sort((a, b) => a.sortKey - b.sortKey);
    if (items.length === 0) continue;
    html += `<div class="fsos-plan-swap-day">`;
    if (items[0].dayLabel) html += `<div class="fsos-plan-swap-day-header">${escHtml(items[0].dayLabel)}</div>`;
    html += '<ul class="fsos-plan-swap-list">';
    for (const it of items) {
      const timeTag = it.timeStart
        ? `<span class="fsos-ltr" dir="ltr">${escHtml(it.timeStart)}–${escHtml(it.timeEnd)}</span>`
        : '';
      html += `<li>
        <span class="fsos-plan-swap-task">${escHtml(it.taskName)}${it.slotLabel ? ` (${escHtml(it.slotLabel)})` : ''}</span>
        <span class="fsos-plan-swap-meta"><span class="fsos-plan-swap-names"><strong>${escHtml(it.toName)}</strong> <span class="fsos-plan-swap-arrow" dir="ltr">←</span> ${escHtml(it.fromName)}</span> ${timeTag}</span>
      </li>`;
    }
    html += '</ul></div>';
  }
  html += '</div>';
  return html;
}

function renderPlanDetails(plan: BatchRescuePlan, pMap: Map<string, Participant>): string {
  let changesHtml = '';
  if (plan.perParticipantChanges.length > 0) {
    const nAffected = plan.perParticipantChanges.length;
    const affectedSuffix = nAffected === 1 ? 'משתתף אחד' : `${nAffected} משתתפים`;
    changesHtml = `<h5 class="fsos-plan-section-title">שינויי שיבוץ (${escHtml(affectedSuffix)})</h5><ul class="fsos-plan-changes">`;
    for (const change of plan.perParticipantChanges) {
      const name = pMap.get(change.participantId)?.name ?? '???';
      const added = change.added.length;
      const removed = change.removed.length;
      const parts: string[] = [];
      if (added > 0)
        parts.push(
          `<span class="fsos-plan-change-added">${added === 1 ? 'שיבוץ חדש' : `${added} שיבוצים חדשים`}</span>`,
        );
      if (removed > 0)
        parts.push(
          `<span class="fsos-plan-change-removed">${removed === 1 ? 'שיבוץ הוסר' : `${removed} שיבוצים הוסרו`}</span>`,
        );
      changesHtml += `<li><span class="fsos-plan-change-name">${escHtml(name)}</span><span class="fsos-plan-change-delta">${parts.join(' · ')}</span></li>`;
    }
    changesHtml += '</ul>';
  }

  let violationsHtml = '';
  if (plan.violations.length > 0) {
    violationsHtml =
      '<h5 class="fsos-plan-section-title fsos-plan-section-title--warn">הפרות אילוצים</h5><ul class="fsos-plan-violations">';
    for (const v of plan.violations) {
      violationsHtml += `<li>${escHtml(v.message)}</li>`;
    }
    violationsHtml += '</ul>';
  }

  return changesHtml + violationsHtml;
}

function showSoftViolationsSubConfirm(plan: BatchRescuePlan): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop fsos-subconfirm-backdrop';
    const lines = plan.violations
      .map((v) => `<li><code>${escHtml(v.code)}</code> · ${escHtml(v.message)}</li>`)
      .join('');
    backdrop.innerHTML = `
      <div class="gm-modal-dialog fsos-subconfirm-dialog" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">⚠️</span>
          <span class="gm-modal-title">לאשר תוכנית עם הפרות?</span>
        </div>
        <div class="gm-modal-body">
          <p>בתוכנית זו נמצאו ${plan.violations.length} הפרות של אילוצים קשיחים. החלתה עלולה להשאיר את השבצ״ק במצב לא תקין.</p>
          <ul class="fsos-plan-violations">${lines}</ul>
        </div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-danger fsos-subconfirm-ok">כן, החל בכל זאת</button>
          <button class="btn-sm btn-outline fsos-subconfirm-cancel">ביטול</button>
        </div>
      </div>`;
    lockBodyScroll();
    const close = (val: boolean) => {
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    backdrop.querySelector('.fsos-subconfirm-ok')?.addEventListener('click', () => close(true));
    backdrop.querySelector('.fsos-subconfirm-cancel')?.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(false);
    }
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
  });
}
