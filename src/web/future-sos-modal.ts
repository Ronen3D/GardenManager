/**
 * Future SOS Modal — confirmation + batch rescue plan UI (v2).
 *
 * Two phases, both as `.gm-modal-dialog` sheets:
 *   1) openConfirmModal — step-scoped impact preview with one checkbox per
 *      affected assignment (opt-out per slot), collapsible locked-past chip,
 *      sticky action bar. Returns `{ confirmed, excludedIds }`.
 *   2) openBatchPlansModal — each plan is rendered as a card with a human
 *      verdict headline, two headline numbers (composite delta, chain
 *      pictogram), swaps grouped by day, and a `פרטים ▾` expander that
 *      reveals the full fairness breakdown, per-participant deltas, and
 *      violations. On touch devices the cards form a scroll-snap carousel
 *      with a pager; on pointer devices they stack with only rank #1
 *      expanded. Soft-violation Apply goes through a confirmation step;
 *      infeasibility is surfaced as inline text with a "narrow the window"
 *      action rather than a muted disabled button.
 */

import type { AffectedAssignment, BatchRescuePlan, BatchRescueResult } from '../engine/future-sos';
import type { Participant, Schedule, Task } from '../models/types';
import { hebrewDayName, operationalDateKey } from '../utils/date-utils';
import { cleanSlotLabel, escAttr, escHtml, fmt, stripDayPrefix } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

// ─── Confirmation ────────────────────────────────────────────────────────────

export interface ConfirmContext {
  participantName: string;
  window: { start: Date; end: Date };
  affected: AffectedAssignment[];
  lockedInPast: AffectedAssignment[];
  dayStartHour: number;
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

    const excludedIds = new Set<string>();

    const affectedHtml = ctx.affected.length > 0 ? renderAffectedChecklist(ctx.affected, ctx.dayStartHour) : '';
    const lockedHtml = ctx.lockedInPast.length > 0 ? renderLockedChip(ctx.lockedInPast, ctx.dayStartHour) : '';

    const windowSentence = renderWindowSentence(ctx.window);

    backdrop.innerHTML = `
      <div class="gm-modal-dialog fsos-modal fsos-confirm-v2" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🆘</span>
          <span class="gm-modal-title">אי זמינות עתידית — שלב 2: השפעה · ${escHtml(ctx.participantName)}</span>
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

function renderWindowSentence(window: { start: Date; end: Date }): string {
  const sameDay = fmtDayLabel(window.start) === fmtDayLabel(window.end);
  if (sameDay) {
    return `החלון: <strong>${escHtml(fmtDayLabel(window.start))}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.start)}–${fmt(window.end)}</span>`;
  }
  return `החלון: <strong>${escHtml(fmtDayLabel(window.start))}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.start)}</span> → <strong>${escHtml(fmtDayLabel(window.end))}</strong> <span dir="ltr" class="fsos-ltr">${fmt(window.end)}</span>`;
}

function fmtDayLabel(d: Date): string {
  return `יום ${hebrewDayName(d)}`;
}

function renderAffectedChecklist(items: AffectedAssignment[], dayStartHour: number): string {
  const byDay = groupByOperationalDay(items, dayStartHour);
  let html = '<div class="fsos-confirm-groups">';
  for (const [_key, dayItems] of byDay) {
    if (dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    html += `<div class="fsos-affected-day-group"><div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor))}</div><ul class="fsos-confirm-list">`;
    for (const it of dayItems) {
      const time = `<span dir="ltr" class="fsos-ltr">${fmt(it.task.timeBlock.start)}–${fmt(it.task.timeBlock.end)}</span>`;
      const cleaned = it.slot.label ? cleanSlotLabel(it.slot.label) : '';
      const slotLabel = cleaned ? ` · ${escHtml(cleaned)}` : '';
      html += `<li>
        <label class="fsos-affected-check">
          <input type="checkbox" class="fsos-affected-checkbox" data-assignment-id="${escAttr(it.assignment.id)}" checked>
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

function renderLockedChip(items: AffectedAssignment[], dayStartHour: number): string {
  const byDay = groupByOperationalDay(items, dayStartHour);
  let panelHtml = '<div class="fsos-locked-panel" hidden>';
  for (const [_key, dayItems] of byDay) {
    if (dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    panelHtml += `<div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor))}</div><ul class="fsos-locked-list">`;
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
  const isTouch = document.documentElement.classList.contains('touch-device');

  let plansHtml = '';
  let pagerHtml = '';
  if (ctx.result.plans.length === 0) {
    plansHtml = renderNoPlans();
  } else if (isTouch) {
    // Carousel layout: all plans expanded, horizontally scrollable with snap points.
    const cards = ctx.result.plans
      .map((p) => renderBatchPlanCard(p, pMap, taskMap, dayStartHour, hasInfeasible, { expanded: true }))
      .join('');
    plansHtml = `<div class="fsos-carousel" role="region" aria-label="תוכניות החלפה">${cards}</div>`;
    pagerHtml = renderCarouselPager(ctx.result.plans);
  } else {
    // Stacked layout: rank #1 expanded, others collapsed to a verdict summary.
    const cards = ctx.result.plans
      .map((p) => renderBatchPlanCard(p, pMap, taskMap, dayStartHour, hasInfeasible, { expanded: p.rank === 1 }))
      .join('');
    plansHtml = `<div class="fsos-plans-stack">${cards}</div>`;
  }

  backdrop.innerHTML = `
    <div class="gm-modal-dialog fsos-modal fsos-plans-v2 ${isTouch ? 'fsos-plans--touch' : ''}" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">🆘</span>
        <span class="gm-modal-title">אי זמינות עתידית — שלב 3: תוכנית · ${escHtml(ctx.participantName)}</span>
      </div>
      ${timeoutHtml}
      ${warningHtml}
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
    <p class="fsos-empty-state-body">ניסינו עומק 1, 2 ו־3 ולא הצלחנו להשלים את השיבוצים.</p>
    <div class="fsos-empty-state-actions">
      <button type="button" class="fsos-narrow-btn btn-sm btn-outline">צמצם חלון</button>
    </div>
  </div>`;
}

function renderCarouselPager(plans: BatchRescuePlan[]): string {
  const dots = plans.map((_, i) => `<span class="fsos-carousel-dot${i === 0 ? ' fsos-carousel-dot--active' : ''}"></span>`).join('');
  return `<div class="fsos-carousel-pager"><div class="fsos-carousel-dots" aria-hidden="true">${dots}</div></div>`;
}

function renderBatchPlanCard(
  plan: BatchRescuePlan,
  pMap: Map<string, Participant>,
  taskMap: Map<string, Task>,
  dayStartHour: number,
  infeasible: boolean,
  opts: { expanded: boolean },
): string {
  const verdict = computeVerdict(plan);
  // HC-invalid plans ship without full composite scoring (we skip it at B3's
  // validate-before-score step). The solo-delta sum we keep for fallback
  // ordering is NOT the real composite delta — displaying it as "השפעה
  // כוללת" would mislead. Render an em-dash instead; users already see the
  // violations list and a warning on Apply.
  const hasViolations = plan.violations.length > 0;
  const composite = plan.compositeDelta;
  const compositeClass = hasViolations
    ? 'fsos-headline--muted'
    : composite >= 0
      ? 'fsos-headline--pos'
      : 'fsos-headline--neg';
  const compositeDisplay = hasViolations ? '—' : formatSignedNumber(composite, 1);

  const chainPictogram = renderChainPictogram(plan.depthHistogram);

  const swapsGrouped = renderSwapsGroupedByDay(plan, pMap, taskMap, dayStartHour);

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
    const label =
      plan.violations.length > 0 ? `⚠️ החל בכל זאת (${plan.violations.length} הפרות)` : '✅ החל תוכנית';
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
      <div class="fsos-plan-headlines">
        <div class="fsos-headline">
          <div class="fsos-headline-label">השפעה כוללת</div>
          <div class="fsos-headline-value ${compositeClass}" dir="ltr">${escHtml(compositeDisplay)}</div>
        </div>
        <div class="fsos-headline">
          <div class="fsos-headline-label">שרשראות</div>
          <div class="fsos-headline-value">${chainPictogram}</div>
        </div>
      </div>
    </header>
    <div class="fsos-plan-body">
      ${swapsGrouped}
      ${detailsHtml}
      ${applyHtml}
    </div>
  </div>`;
}

function formatSignedNumber(v: number, digits: number): string {
  const rounded = v.toFixed(digits);
  if (v > 0) return `+${rounded}`;
  if (v < 0) return `\u2212${Math.abs(v).toFixed(digits)}`;
  return rounded;
}

function renderChainPictogram(depth: Record<1 | 2 | 3, number>): string {
  const parts: string[] = [];
  if (depth[1] > 0) parts.push(`<span class="fsos-chain-pic"><span class="fsos-chain-pic-dot"></span>×${depth[1]}</span>`);
  if (depth[2] > 0) parts.push(`<span class="fsos-chain-pic"><span class="fsos-chain-pic-dot"></span><span class="fsos-chain-pic-arrow">→</span><span class="fsos-chain-pic-dot"></span>×${depth[2]}</span>`);
  if (depth[3] > 0)
    parts.push(
      `<span class="fsos-chain-pic"><span class="fsos-chain-pic-dot"></span><span class="fsos-chain-pic-arrow">→</span><span class="fsos-chain-pic-dot"></span><span class="fsos-chain-pic-arrow">→</span><span class="fsos-chain-pic-dot"></span>×${depth[3]}</span>`,
    );
  if (parts.length === 0) return '<span class="fsos-chain-pic-empty">ללא שינוי</span>';
  return parts.join(' · ');
}

function renderSwapsGroupedByDay(
  plan: BatchRescuePlan,
  pMap: Map<string, Participant>,
  taskMap: Map<string, Task>,
  dayStartHour: number,
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
    const fromName = sw.fromParticipantId ? pMap.get(sw.fromParticipantId)?.name ?? '???' : '—';
    const task = taskMap.get(sw.taskId);
    const taskStart = task?.timeBlock.start ?? null;
    const taskEnd = task?.timeBlock.end ?? null;
    const dayKey = taskStart ? operationalDateKey(taskStart, dayStartHour) : sw.assignmentId;
    const dayLabel = taskStart ? fmtDayLabel(taskStart) : '';
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
  // HC-invalid plans have no meaningful fairness numbers (we skipped the full
  // scoring step). Replace the balance breakdown with a short explanation so
  // users aren't shown all-zero "ללא שינוי משמעותי" badges that look like
  // computed results.
  const hasViolations = plan.violations.length > 0;
  let balanceHtml: string;
  if (hasViolations) {
    balanceHtml = `<h5 class="fsos-plan-section-title">איזון עומסים</h5>
      <p class="fsos-plan-no-eval">לא ניתן להעריך איזון עבור תוכנית שאינה עומדת באילוצים קשיחים.</p>`;
  } else {
    const balanceRows: Array<{ label: string; hint: string; value: number }> = [
      {
        label: 'הוגנות ג׳וניורים',
        hint: 'האם עומס המשמרות מתחלק בצורה שווה בין הג׳וניורים',
        value: plan.fairnessDelta.l0StdDev,
      },
      {
        label: 'הוגנות סגל',
        hint: 'האם עומס המשמרות מתחלק בצורה שווה בין אנשי הסגל',
        value: plan.fairnessDelta.seniorStdDev,
      },
      {
        label: 'אחידות לאורך השבוע',
        hint: 'האם העומס מתחלק בצורה אחידה על פני כל ימי השבוע (עבור כל הצוות וכל משתתף)',
        value: plan.fairnessDelta.dailyGlobalStdDev + plan.fairnessDelta.dailyPerParticipantStdDev,
      },
    ];
    balanceHtml = '<h5 class="fsos-plan-section-title">איזון עומסים</h5><ul class="fsos-plan-balance-list">';
    for (const r of balanceRows) {
      const badge = renderBalanceBadge(r.value);
      balanceHtml += `<li class="fsos-plan-balance-row">
        <span class="fsos-plan-balance-label" title="${escAttr(r.hint)}">${escHtml(r.label)}</span>
        ${badge}
      </li>`;
    }
    balanceHtml += '</ul>';
  }

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
      if (added > 0) parts.push(`<span class="fsos-plan-change-added">${added === 1 ? 'שיבוץ חדש' : `${added} שיבוצים חדשים`}</span>`);
      if (removed > 0) parts.push(`<span class="fsos-plan-change-removed">${removed === 1 ? 'שיבוץ הוסר' : `${removed} שיבוצים הוסרו`}</span>`);
      changesHtml += `<li><span class="fsos-plan-change-name">${escHtml(name)}</span><span class="fsos-plan-change-delta">${parts.join(' · ')}</span></li>`;
    }
    changesHtml += '</ul>';
  }

  let violationsHtml = '';
  if (plan.violations.length > 0) {
    violationsHtml = '<h5 class="fsos-plan-section-title fsos-plan-section-title--warn">הפרות אילוצים</h5><ul class="fsos-plan-violations">';
    for (const v of plan.violations) {
      violationsHtml += `<li>${escHtml(v.message)}</li>`;
    }
    violationsHtml += '</ul>';
  }

  return balanceHtml + changesHtml + violationsHtml;
}

function renderBalanceBadge(delta: number): string {
  // Positive delta = stdDev dropped = balance improved. Threshold chosen so
  // sub-6-minute swings don't claim "improved"/"worsened" — they're noise.
  if (Math.abs(delta) < 0.1) {
    return '<span class="fsos-plan-balance-badge fsos-plan-balance-badge--neutral">ללא שינוי משמעותי</span>';
  }
  const magnitude = Math.abs(delta).toFixed(1);
  if (delta > 0) {
    return `<span class="fsos-plan-balance-badge fsos-plan-balance-badge--pos">משתפר <span dir="ltr" class="fsos-ltr">(${magnitude}h)</span></span>`;
  }
  return `<span class="fsos-plan-balance-badge fsos-plan-balance-badge--neg">מחמיר <span dir="ltr" class="fsos-ltr">(${magnitude}h)</span></span>`;
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
