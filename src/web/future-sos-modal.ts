/**
 * Future SOS Modal — confirmation + batch rescue plan UI.
 *
 * Two phases:
 *   1) openConfirmModal — lists affected assignments (grouped by operational
 *      day) and any frozen-past locked entries, with Cancel / Compute buttons.
 *   2) openBatchPlansModal — shows generated batch plans with depth histogram,
 *      composite & fairness deltas, expandable swap list, and per-participant
 *      change summary. Disables Apply when infeasible slots remain.
 */

import type { AffectedAssignment, BatchRescuePlan, BatchRescueResult } from '../engine/future-sos';
import type { Participant, Schedule } from '../models/types';
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

export function openConfirmModal(ctx: ConfirmContext): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';

    const affectedHtml = renderAffectedGroupedList(ctx.affected, ctx.dayStartHour, 'fsos-confirm-list');
    const lockedHtml =
      ctx.lockedInPast.length > 0
        ? `<h4 class="profile-sub-title">שיבוצים שכבר נעולים (בעבר)</h4>${renderAffectedGroupedList(ctx.lockedInPast, ctx.dayStartHour, 'fsos-locked-list')}`
        : '';

    const confirmBtnDisabled = ctx.affected.length === 0 ? 'disabled' : '';
    const confirmLabel = ctx.affected.length === 0 ? 'אין שיבוצים להחלפה' : '🚀 חשב תוכניות';

    backdrop.innerHTML = `
      <div class="gm-modal-dialog fsos-modal" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🆘</span>
          <span class="gm-modal-title">SOS עתידי — ${escHtml(ctx.participantName)}</span>
        </div>
        <div class="gm-modal-body">
          המשתתף יסומן כלא־זמין בין
          <strong dir="ltr">${fmt(ctx.window.start)} (${escHtml(fmtDayLabel(ctx.window.start))})</strong>
          ל־
          <strong dir="ltr">${fmt(ctx.window.end)} (${escHtml(fmtDayLabel(ctx.window.end))})</strong>.
        </div>
        ${ctx.affected.length > 0 ? `<h4 class="profile-sub-title">שיבוצים שיש להחליף</h4>${affectedHtml}` : '<p class="gm-modal-body">אין שיבוצים חופפים לחלון זה.</p>'}
        ${lockedHtml}
        <div class="gm-modal-actions">
          <button class="btn-primary fsos-confirm-btn" ${confirmBtnDisabled}>${confirmLabel}</button>
          <button class="btn-sm btn-outline fsos-cancel-btn">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = (val: boolean) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    backdrop.querySelector('.fsos-confirm-btn')?.addEventListener('click', () => close(true));
    backdrop.querySelector('.fsos-cancel-btn')?.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(false);
      }
    });

    document.body.appendChild(backdrop);
  });
}

function fmtDayLabel(d: Date): string {
  return `יום ${hebrewDayName(d)}`;
}

function renderAffectedGroupedList(items: AffectedAssignment[], dayStartHour: number, className: string): string {
  if (items.length === 0) return '';
  const byDay = new Map<string, AffectedAssignment[]>();
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
  let html = '';
  for (const key of sortedKeys) {
    const dayItems = byDay.get(key);
    if (!dayItems || dayItems.length === 0) continue;
    const anchor = dayItems[0].task.timeBlock.start;
    html += `<div class="fsos-affected-day-header">${escHtml(fmtDayLabel(anchor))}</div><ul class="${className}">`;
    for (const it of dayItems) {
      const time = `<span dir="ltr">${fmt(it.task.timeBlock.start)} – ${fmt(it.task.timeBlock.end)}</span>`;
      const slotLabel = it.slot.label ? ` · ${escHtml(it.slot.label)}` : '';
      html += `<li><span>${escHtml(stripDayPrefix(it.task.name))}${slotLabel}</span>${time}</li>`;
    }
    html += '</ul>';
  }
  return html;
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
}

export function openBatchPlansModal(ctx: BatchPlansContext): void {
  const existing = document.getElementById('fsos-plans-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'fsos-plans-backdrop';
  backdrop.className = 'gm-modal-backdrop';

  const pMap = new Map<string, Participant>();
  for (const p of ctx.schedule.participants) pMap.set(p.id, p);

  const hasInfeasible = ctx.result.infeasibleAssignmentIds.length > 0;
  const warningHtml = hasInfeasible ? renderInfeasibleWarning(ctx.result, pMap) : '';

  let plansHtml = '';
  if (ctx.result.plans.length === 0) {
    plansHtml =
      '<p class="gm-modal-body">לא נמצאו תוכניות החלפה מתאימות. נסה לצמצם את החלון או להפעיל יותר משתתפים.</p>';
  } else {
    for (const plan of ctx.result.plans) {
      plansHtml += renderBatchPlan(plan, pMap, hasInfeasible);
    }
  }

  backdrop.innerHTML = `
    <div class="gm-modal-dialog fsos-modal" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">🆘</span>
        <span class="gm-modal-title">תוכניות החלפה — ${escHtml(ctx.participantName)}</span>
      </div>
      ${warningHtml}
      ${plansHtml}
      <div class="gm-modal-actions">
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

  backdrop.querySelectorAll<HTMLButtonElement>('.fsos-apply-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const planId = btn.dataset.planId;
      const plan = ctx.result.plans.find((p) => p.id === planId);
      if (!plan) return;
      close();
      ctx.onApply(plan);
    });
  });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
}

function renderInfeasibleWarning(result: BatchRescueResult, pMap: Map<string, Participant>): string {
  const lines: string[] = [];
  for (const aId of result.infeasibleAssignmentIds) {
    const aff = result.affected.find((a) => a.assignment.id === aId);
    if (!aff) continue;
    const time = `<span dir="ltr">${fmt(aff.task.timeBlock.start)} – ${fmt(aff.task.timeBlock.end)}</span>`;
    const slotLabel = aff.slot.label ? ` · ${escHtml(aff.slot.label)}` : '';
    lines.push(`<li>${escHtml(stripDayPrefix(aff.task.name))}${slotLabel} — ${time}</li>`);
  }
  void pMap;
  return `<div class="fsos-warning-banner">
    <strong>⚠️ לא ניתן להחליף את כל השיבוצים בעומק ≤ 3.</strong>
    <ul>${lines.join('')}</ul>
    צמצמו את החלון או בטלו ונסו שוב. לא ניתן להחיל תוכנית חלקית.
  </div>`;
}

function renderBatchPlan(plan: BatchRescuePlan, pMap: Map<string, Participant>, applyDisabled: boolean): string {
  const recommended = plan.rank === 1;
  const composite = plan.compositeDelta;
  const compositeClass = composite >= 0 ? 'fsos-metric--pos' : 'fsos-metric--neg';
  const compositeSign = composite >= 0 ? '+' : '';
  const depth = plan.depthHistogram;
  const depthParts: string[] = [];
  if (depth[1] > 0) depthParts.push(`${depth[1]}× ישיר`);
  if (depth[2] > 0) depthParts.push(`${depth[2]}× שרשרת 2`);
  if (depth[3] > 0) depthParts.push(`${depth[3]}× שרשרת 3`);

  const fairness = plan.fairnessDelta;
  const fairMetric = (label: string, v: number) => {
    if (Math.abs(v) < 0.01) return `<span class="fsos-metric">${escHtml(label)}: 0.0</span>`;
    const cls = v > 0 ? 'fsos-metric--pos' : 'fsos-metric--neg';
    const sign = v > 0 ? '+' : '';
    return `<span class="fsos-metric ${cls}">${escHtml(label)}: ${sign}${v.toFixed(2)}</span>`;
  };

  let swapsHtml = '<ol class="fsos-swaps">';
  for (const sw of plan.swaps) {
    const to = pMap.get(sw.toParticipantId)?.name ?? '???';
    const from = sw.fromParticipantId ? (pMap.get(sw.fromParticipantId)?.name ?? '???') : '—';
    swapsHtml += `<li><strong>${escHtml(to)}</strong> במקום ${escHtml(from)} — ${escHtml(stripDayPrefix(sw.taskName))} (${escHtml(sw.slotLabel)})</li>`;
  }
  swapsHtml += '</ol>';

  let changesHtml = '';
  if (plan.perParticipantChanges.length > 0) {
    changesHtml = '<ul class="fsos-participant-changes">';
    for (const change of plan.perParticipantChanges) {
      const name = pMap.get(change.participantId)?.name ?? '???';
      const parts: string[] = [];
      if (change.added.length > 0) parts.push(`+${change.added.length}`);
      if (change.removed.length > 0) parts.push(`−${change.removed.length}`);
      changesHtml += `<li>${escHtml(name)}: ${parts.join(' ')}</li>`;
    }
    changesHtml += '</ul>';
  }

  const violationsHtml =
    plan.violations.length > 0
      ? `<details><summary>⚠️ ${plan.violations.length} הפרות</summary><ul>${plan.violations.map((v) => `<li>${escHtml(v.code)} · ${escHtml(v.message)}</li>`).join('')}</ul></details>`
      : '';

  const disabled = applyDisabled || plan.violations.length > 0 ? 'disabled' : '';
  const applyLabel =
    plan.violations.length > 0
      ? '⚠️ לא ניתן להחיל (הפרות)'
      : applyDisabled
        ? 'לא ניתן להחיל (יש שיבוצים ללא פתרון)'
        : '✅ החל תוכנית';

  return `<div class="fsos-plan${recommended ? ' fsos-plan--recommended' : ''}">
    <div class="fsos-plan-header">
      <span class="fsos-plan-rank">#${plan.rank}${recommended ? ' · מומלץ' : ''}</span>
      <div class="fsos-plan-metrics">
        <span class="fsos-metric ${compositeClass}">ציון: ${compositeSign}${composite.toFixed(1)}</span>
        ${fairMetric('הוגנות L0', fairness.l0StdDev)}
        ${fairMetric('הוגנות סגל', fairness.seniorStdDev)}
        ${fairMetric('פיזור יומי', fairness.dailyGlobalStdDev)}
        <span class="fsos-metric">${escHtml(depthParts.join(' · ') || 'ללא שינוי')}</span>
      </div>
    </div>
    ${swapsHtml}
    ${changesHtml}
    ${violationsHtml}
    <button class="btn-primary fsos-apply-btn" data-plan-id="${escAttr(plan.id)}" ${disabled}>${applyLabel}</button>
  </div>`;
}
