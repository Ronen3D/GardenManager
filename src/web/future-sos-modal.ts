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
import { escAttr, escHtml, fmt } from './ui-helpers';
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
          <span class="gm-modal-title">SOS עתידי — ${escHtml(ctx.participantName)}</span>
        </div>
        <div class="fsos-step-indicator" aria-hidden="true">
          <span class="fsos-step">1 · חלון</span>
          <span class="fsos-step fsos-step--active">2 · השפעה</span>
          <span class="fsos-step">3 · תוכנית</span>
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
          <button class="btn-primary fsos-confirm-btn" ${ctx.affected.length === 0 && ctx.lockedInPast.length === 0 ? 'disabled' : ''}>
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
      const slotLabel = it.slot.label ? ` · ${escHtml(it.slot.label)}` : '';
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
      const slotLabel = it.slot.label ? ` · ${escHtml(it.slot.label)}` : '';
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

function stripDayPrefix(name: string): string {
  return name.replace(/^D\d+\s+/, '');
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
  reason: string;
}

function computeVerdict(plan: BatchRescuePlan): PlanVerdict {
  if (plan.violations.length > 0) {
    return {
      level: 'poor',
      label: 'בעייתי',
      reason: `${plan.violations.length} הפרות — יש לעיין לפני החלה`,
    };
  }
  const cd = plan.compositeDelta;
  const reasonParts: string[] = [];
  const { l0StdDev, seniorStdDev, dailyGlobalStdDev } = plan.fairnessDelta;
  if (l0StdDev > 0.1) reasonParts.push('איזון ג׳וניורים משתפר');
  else if (l0StdDev < -0.1) reasonParts.push('איזון ג׳וניורים מורע');
  if (seniorStdDev > 0.1) reasonParts.push('איזון סגל משתפר');
  else if (seniorStdDev < -0.1) reasonParts.push('איזון סגל מורע');
  if (dailyGlobalStdDev > 0.1) reasonParts.push('פיזור יומי משתפר');
  if (reasonParts.length === 0) reasonParts.push('ללא השפעה משמעותית על איזון');

  let level: PlanVerdict['level'];
  let label: string;
  if (cd >= 5) {
    level = 'excellent';
    label = 'מצוין';
  } else if (cd >= 0) {
    level = 'good';
    label = 'טוב';
  } else {
    level = 'fair';
    label = 'סביר';
  }
  return { level, label, reason: reasonParts.slice(0, 2).join(' · ') };
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
    plansHtml = ctx.result.plans
      .map((p) => renderBatchPlanCard(p, pMap, taskMap, dayStartHour, hasInfeasible, { expanded: p.rank === 1 }))
      .join('');
  }

  backdrop.innerHTML = `
    <div class="gm-modal-dialog fsos-modal fsos-plans-v2 ${isTouch ? 'fsos-plans--touch' : ''}" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">🆘</span>
        <span class="gm-modal-title">תוכניות החלפה — ${escHtml(ctx.participantName)}</span>
      </div>
      <div class="fsos-step-indicator" aria-hidden="true">
        <span class="fsos-step">1 · חלון</span>
        <span class="fsos-step">2 · השפעה</span>
        <span class="fsos-step fsos-step--active">3 · תוכנית</span>
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

  backdrop.querySelectorAll<HTMLButtonElement>('.fsos-carousel-jump').forEach((chip) => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.dataset.planIdx ?? '0', 10);
      const carousel = backdrop.querySelector('.fsos-carousel') as HTMLElement | null;
      if (!carousel) return;
      const card = carousel.children.item(idx) as HTMLElement | null;
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    });
  });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
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
    const slotLabel = aff.slot.label ? ` · ${escHtml(aff.slot.label)}` : '';
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
  const chips = plans
    .map(
      (p, i) =>
        `<button type="button" class="fsos-carousel-jump" data-plan-idx="${i}">#${p.rank}${p.rank === 1 ? ' · מומלץ' : ''}</button>`,
    )
    .join('');
  return `<div class="fsos-carousel-pager"><div class="fsos-carousel-dots" aria-hidden="true">${dots}</div><div class="fsos-carousel-chips" role="tablist">${chips}</div></div>`;
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
  const composite = plan.compositeDelta;
  const compositeClass = composite >= 0 ? 'fsos-headline--pos' : 'fsos-headline--neg';
  const compositeDisplay = formatSignedNumber(composite, 1);

  const chainPictogram = renderChainPictogram(plan.depthHistogram);

  const swapsGrouped = renderSwapsGroupedByDay(plan, pMap, taskMap, dayStartHour);

  const detailsHtml = renderPlanDetails(plan, pMap);

  const recommended = plan.rank === 1;
  const expandedClass = opts.expanded ? ' fsos-plan-card--expanded' : '';
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
        <span class="fsos-verdict fsos-verdict--${verdict.level}">${escHtml(verdict.label)}</span>
      </div>
      <div class="fsos-plan-reason">${escHtml(verdict.reason)}</div>
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
      <button type="button" class="fsos-plan-toggle" aria-expanded="${opts.expanded ? 'true' : 'false'}" aria-label="הרחב/הסתר פרטים">
        <span class="fsos-plan-toggle-label">פרטים</span>
        <span class="fsos-plan-toggle-arrow">▾</span>
      </button>
    </header>
    <div class="fsos-plan-body">
      ${swapsGrouped}
      <details class="fsos-plan-details">
        <summary>פרטים מתקדמים</summary>
        ${detailsHtml}
      </details>
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
      slotLabel: sw.slotLabel,
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
        <span class="fsos-plan-swap-meta"><span class="fsos-plan-swap-names">${escHtml(it.fromName)} <span class="fsos-plan-swap-arrow">→</span> <strong>${escHtml(it.toName)}</strong></span> ${timeTag}</span>
      </li>`;
    }
    html += '</ul></div>';
  }
  html += '</div>';
  return html;
}

function renderPlanDetails(plan: BatchRescuePlan, pMap: Map<string, Participant>): string {
  const rows: Array<{ label: string; hint: string; value: number }> = [
    {
      label: 'איזון עול ג׳וניורים (L0)',
      hint: 'שינוי בסטיית תקן של עומס ג׳וניורים — חיובי: איזון משתפר',
      value: plan.fairnessDelta.l0StdDev,
    },
    {
      label: 'איזון עול סגל',
      hint: 'שינוי בסטיית תקן של עומס סגל — חיובי: איזון משתפר',
      value: plan.fairnessDelta.seniorStdDev,
    },
    {
      label: 'פיזור ימי גלובלי',
      hint: 'האם העומס מתחלק באופן אחיד על פני ימי השבוע',
      value: plan.fairnessDelta.dailyGlobalStdDev,
    },
    {
      label: 'פיזור ימי למשתתף',
      hint: 'האם כל משתתף זוכה לחלוקה אחידה על פני ימי השבוע',
      value: plan.fairnessDelta.dailyPerParticipantStdDev,
    },
  ];

  let fairnessHtml =
    '<h5 class="fsos-plan-details-title">איזון הוגנות</h5><table class="fsos-plan-fairness-table">';
  for (const r of rows) {
    const cls = Math.abs(r.value) < 0.01 ? 'fsos-fair-neutral' : r.value > 0 ? 'fsos-fair-pos' : 'fsos-fair-neg';
    fairnessHtml += `<tr>
      <td class="fsos-plan-fairness-label"><span title="${escAttr(r.hint)}">${escHtml(r.label)}</span></td>
      <td class="fsos-plan-fairness-value ${cls}" dir="ltr">${escHtml(formatSignedNumber(r.value, 2))}</td>
    </tr>`;
  }
  fairnessHtml += '</table>';

  let changesHtml = '';
  if (plan.perParticipantChanges.length > 0) {
    changesHtml = '<h5 class="fsos-plan-details-title">השפעה על משתתפים</h5><ul class="fsos-plan-changes">';
    for (const change of plan.perParticipantChanges) {
      const name = pMap.get(change.participantId)?.name ?? '???';
      const added = change.added.length;
      const removed = change.removed.length;
      changesHtml += `<li><span class="fsos-plan-change-name">${escHtml(name)}</span><span class="fsos-plan-change-delta" dir="ltr">${added > 0 ? `+${added}` : ''}${added > 0 && removed > 0 ? ' ' : ''}${removed > 0 ? `\u2212${removed}` : ''}</span></li>`;
    }
    changesHtml += '</ul>';
  }

  let violationsHtml = '';
  if (plan.violations.length > 0) {
    violationsHtml = '<h5 class="fsos-plan-details-title fsos-plan-details-title--warn">הפרות</h5><ul class="fsos-plan-violations">';
    for (const v of plan.violations) {
      violationsHtml += `<li><code>${escHtml(v.code)}</code> · ${escHtml(v.message)}</li>`;
    }
    violationsHtml += '</ul>';
  }

  return fairnessHtml + changesHtml + violationsHtml;
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
