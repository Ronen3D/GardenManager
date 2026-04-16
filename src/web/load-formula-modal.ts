/**
 * Load Formula Modal — define a task's per-hour load (0..1) by comparison to
 * hours of other task templates.
 *
 * "1 hour of this task = N₁ hours of Ref₁ + N₂ hours of Ref₂ + …"
 *
 * Computed value feeds TaskTemplate.baseLoadWeight or LoadWindow.weight.
 * Self-contained: owns DOM, state, event wiring; persists via config-store.
 */

import type { LoadFormula, LoadFormulaComponent, LoadWindow, TaskTemplate } from '../models/types';
import * as store from './config-store';
import {
  buildFormula,
  buildSnapshot,
  computeFormulaValue,
  formatWindowLabel,
  normalizeTargetHours,
  rawFormulaSum,
  resolveRateValue,
  validateFormula,
} from './utils/load-formula';

// ─── Context injection ──────────────────────────────────────────────────────

export interface LoadFormulaModalContext {
  /** Called after the formula is saved or cleared, so the hosting tab re-renders. */
  onChanged: () => void;
}

let _ctx: LoadFormulaModalContext | null = null;

export function initLoadFormulaModal(ctx: LoadFormulaModalContext): void {
  _ctx = ctx;
}

// ─── Target descriptor ──────────────────────────────────────────────────────

export type LoadFormulaTarget =
  | { kind: 'base'; templateId: string }
  | { kind: 'window'; templateId: string; windowId: string };

// ─── State ──────────────────────────────────────────────────────────────────

type Side = 'rhs' | 'lhs';

let _target: LoadFormulaTarget | null = null;
/** RHS components: "X hours of THIS + lhsExtras = sum(components)". */
let _components: LoadFormulaComponent[] = [];
/** Extra LHS terms beyond the target task's X hours (subtracted from RHS). */
let _lhsExtras: LoadFormulaComponent[] = [];
let _escHandler: ((e: KeyboardEvent) => void) | null = null;
/** Which row's reference picker is currently expanded; null = collapsed. */
let _activeRow: { side: Side; idx: number } | null = null;
/** "X hours of this task = ..." — the equation's primary LHS term. */
let _targetHours: number = 1;
/** Whether the raw arithmetic breakdown is expanded; collapsed by default. */
let _showBreakdown: boolean = false;

function listFor(side: Side): LoadFormulaComponent[] {
  return side === 'lhs' ? _lhsExtras : _components;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Fallback colors when TaskTemplate.color is not set. */
const FALLBACK_COLORS = ['#4A90D9', '#E8985A', '#6AB97D', '#C57CBD', '#E5C15C', '#7F9BCE'];

// ─── Public API ─────────────────────────────────────────────────────────────

export function openLoadFormulaModal(target: LoadFormulaTarget): void {
  const tpl = store.getTaskTemplate(target.templateId);
  if (!tpl) return;
  if (target.kind === 'window' && !(tpl.loadWindows ?? []).some((w) => w.id === target.windowId)) {
    return;
  }

  _target = target;
  const existing = getExistingFormula(tpl, target);
  _components = existing
    ? existing.components.map((c) => ({ ...c, refRate: { ...c.refRate } }))
    : [emptyComponent()];
  _lhsExtras = existing?.lhsExtras
    ? existing.lhsExtras.map((c) => ({ ...c, refRate: { ...c.refRate } }))
    : [];
  _targetHours = normalizeTargetHours(existing?.targetHours);
  // Start with first RHS row's picker open if the formula is new or the first row is unset.
  _activeRow = !existing || !_components[0]?.refTemplateId ? { side: 'rhs', idx: 0 } : null;

  render();
}

export function closeLoadFormulaModal(): void {
  document.getElementById('lf-modal-backdrop')?.remove();
  _target = null;
  _components = [];
  _lhsExtras = [];
  _activeRow = null;
  _targetHours = 1;
  _showBreakdown = false;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getExistingFormula(tpl: TaskTemplate, target: LoadFormulaTarget): LoadFormula | undefined {
  if (target.kind === 'base') return tpl.loadFormula;
  const win = (tpl.loadWindows ?? []).find((w) => w.id === target.windowId);
  return win?.loadFormula;
}

function getTargetLabel(tpl: TaskTemplate, target: LoadFormulaTarget): string {
  if (target.kind === 'base') {
    // Only qualify with "בסיס" if the task actually has hot windows to distinguish from.
    return (tpl.loadWindows ?? []).length > 0 ? `${tpl.name} — בסיס` : tpl.name;
  }
  const win = (tpl.loadWindows ?? []).find((w) => w.id === target.windowId);
  return win ? `${tpl.name} — חם ${formatWindowLabel(win)}` : tpl.name;
}

function emptyComponent(): LoadFormulaComponent {
  return { refTemplateId: '', refRate: { kind: 'base' }, hours: 1 };
}

function escAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function templatesMap(): Map<string, TaskTemplate> {
  const m = new Map<string, TaskTemplate>();
  for (const t of store.getAllTaskTemplates()) m.set(t.id, t);
  return m;
}

function colorForTemplate(tpl: TaskTemplate | undefined, idx: number): string {
  return tpl?.color || FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
}

function templateBaseWeight(tpl: TaskTemplate): number {
  return tpl.isLight ? 0 : Math.max(0, Math.min(1, tpl.baseLoadWeight ?? 1));
}

function rateLabelFor(c: LoadFormulaComponent, tpl: TaskTemplate): string {
  const ref = c.refRate;
  if (ref.kind === 'base') {
    // "בסיס" only makes sense as a label when there's a hot window to contrast with.
    return (tpl.loadWindows ?? []).length > 0 ? 'בסיס' : '';
  }
  const win = (tpl.loadWindows ?? []).find((w) => w.id === ref.windowId);
  return win ? `חם ${formatWindowLabel(win)}` : '?';
}

function buildBreakdownText(
  components: LoadFormulaComponent[],
  snapshot: ReturnType<typeof buildSnapshot>,
): string {
  return components
    .map((c, i) => {
      const snap = snapshot[i];
      if (!snap) return '';
      if (snap.missing) return `${c.hours}×?`;
      return `${c.hours}×${snap.rate.value.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(' + ');
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  if (!_target) return;
  const tpl = store.getTaskTemplate(_target.templateId);
  if (!tpl) return;

  document.getElementById('lf-modal-backdrop')?.remove();

  const targetLabel = getTargetLabel(tpl, _target);
  const map = templatesMap();
  const otherTemplates = store.getAllTaskTemplates().filter((t) => t.id !== tpl.id);
  // Sort chips by base weight descending so the palette reads heavy → light.
  const templatesSorted = [...otherTemplates].sort((a, b) => templateBaseWeight(b) - templateBaseWeight(a));

  const rhsSnapshot = buildSnapshot(_components, map);
  const lhsSnapshot = buildSnapshot(_lhsExtras, map);
  const validation = validateFormula(_components, tpl.id, map, _lhsExtras);
  const rhsRaw = rawFormulaSum(_components, rhsSnapshot);
  const lhsRaw = rawFormulaSum(_lhsExtras, lhsSnapshot);
  const netRaw = rhsRaw - lhsRaw;
  const targetHours = normalizeTargetHours(_targetHours);
  const perHourRaw = netRaw / targetHours;
  const computed = computeFormulaValue(_components, rhsSnapshot, targetHours, _lhsExtras, lhsSnapshot);
  const clampedHigh = perHourRaw > 1 + 1e-9;
  const clampedLow = perHourRaw < -1e-9;

  const rhsBreakdown = buildBreakdownText(_components, rhsSnapshot);
  const lhsBreakdown = buildBreakdownText(_lhsExtras, lhsSnapshot);

  const baseContextWeight = _target.kind === 'window' ? templateBaseWeight(tpl) : null;
  const canShowClearBtn = !!getExistingFormula(tpl, _target);

  const rhsStackHtml = _components.map((c, idx) => renderStackRow('rhs', c, idx, map, templatesSorted)).join('');
  const lhsStackHtml = _lhsExtras.map((c, idx) => renderStackRow('lhs', c, idx, map, templatesSorted)).join('');

  const html = `
    <div id="lf-modal-backdrop" class="lf-backdrop">
      <div class="lf-modal" role="dialog" aria-label="הגדרת עומס לפי השוואה">
        <div class="lf-header">
          <h3>🧮 הגדר עומס לפי השוואה</h3>
          <button class="lf-close" data-lf-action="close" aria-label="סגור">✕</button>
        </div>
        <div class="lf-body">
          <div class="lf-target-equation">
            <div class="lf-target-stepper" dir="ltr">
              <button type="button" class="lf-stepper-btn" data-lf-action="target-step" data-lf-delta="-1" aria-label="הפחת שעות">−</button>
              <input class="lf-stepper-input" type="number" step="1" min="1" max="24"
                data-lf-field="target-hours" value="${targetHours}" />
              <button type="button" class="lf-stepper-btn" data-lf-action="target-step" data-lf-delta="1" aria-label="הוסף שעות">+</button>
            </div>
            <span class="lf-target-text">שעות של <strong>${escAttr(targetLabel)}</strong>${_lhsExtras.length ? '' : ' שוות ל:'}</span>
          </div>

          <div class="lf-lhs-extras">
            ${lhsStackHtml}
            ${_lhsExtras.every((c) => c.refTemplateId) ? '<button class="lf-stack-add lf-stack-add-lhs" data-lf-action="add-row" data-lf-side="lhs">+ הוסף משימה לצד העליון</button>' : ''}
            ${_lhsExtras.length ? '<div class="lf-lhs-eq-label">שוות ל:</div>' : ''}
          </div>

          ${baseContextWeight !== null ? renderContextBar(baseContextWeight, tpl) : ''}

          <div class="lf-bar-summary">
            <div class="lf-bar-number">
              <span class="lf-bar-number-label">עומס מחושב לשעה</span>
              <strong class="lf-bar-number-value">${computed.toFixed(2)}</strong>
              <span class="lf-bar-number-raw" title="ערך לפני חיתוך"${clampedHigh || clampedLow ? '' : ' hidden'}>(${perHourRaw.toFixed(2)})</span>
              ${
                rhsBreakdown || lhsBreakdown
                  ? `<button type="button" class="lf-bar-breakdown-toggle" data-lf-action="toggle-breakdown" aria-expanded="${_showBreakdown}">${_showBreakdown ? 'הסתר חישוב ▴' : 'הצג חישוב ▾'}</button>`
                  : ''
              }
            </div>
            <div class="lf-bar-breakdown" dir="ltr"${_showBreakdown ? '' : ' hidden'}>${renderBreakdownLine(rhsBreakdown, lhsBreakdown, rhsRaw, lhsRaw, netRaw, targetHours, clampedHigh, clampedLow)}</div>
            ${clampedHigh ? `<div class="lf-bar-clamp-warn">⚠ ערך לשעה חורג מ-1, נחתך ל-1.00</div>` : ''}
            ${clampedLow ? `<div class="lf-bar-clamp-warn">⚠ צד שמאל גדול מצד ימין — ערך לשעה נחתך ל-0.00</div>` : ''}
          </div>

          <div class="lf-stack">${rhsStackHtml}</div>
          ${_components.every((c) => c.refTemplateId) ? '<button class="lf-stack-add" data-lf-action="add-row" data-lf-side="rhs">+ הוסף רכיב השוואה</button>' : ''}

          ${!validation.ok ? `<div class="lf-validation-msg">${escAttr(validation.reason)}</div>` : ''}
        </div>
        <div class="lf-footer">
          ${canShowClearBtn ? `<button class="btn-sm btn-outline" data-lf-action="clear">חזור לערך ידני</button>` : '<span></span>'}
          <div class="lf-footer-right">
            <button class="btn-sm btn-outline" data-lf-action="cancel">ביטול</button>
            <button class="btn-sm btn-primary" data-lf-action="save" ${validation.ok ? '' : 'disabled'}>שמור</button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
  wireEvents();
}

function renderContextBar(baseWeight: number, tpl: TaskTemplate): string {
  const widthPct = Math.max(0, Math.min(1, baseWeight)) * 100;
  const color = colorForTemplate(tpl, 0);
  return `
    <div class="lf-context-bar" title="בסיס ${escAttr(tpl.name)}: ${baseWeight.toFixed(2)}">
      <span class="lf-context-label">בסיס ${escAttr(tpl.name)}</span>
      <div class="lf-context-track" dir="ltr">
        <div class="lf-context-fill" style="width:${widthPct.toFixed(2)}%;background:${color}"></div>
      </div>
      <span class="lf-context-value">${baseWeight.toFixed(2)}</span>
    </div>`;
}

function renderBreakdownLine(
  rhsBreakdown: string,
  lhsBreakdown: string,
  rhsRaw: number,
  lhsRaw: number,
  netRaw: number,
  targetHours: number,
  clampedHigh: boolean,
  clampedLow: boolean,
): string {
  if (!rhsBreakdown && !lhsBreakdown) return '';
  const hasLhs = lhsBreakdown.length > 0;
  const rhsLine = rhsBreakdown ? `${rhsBreakdown} = ${rhsRaw.toFixed(2)}` : '';
  const lhsLine = hasLhs ? `${lhsBreakdown} = ${lhsRaw.toFixed(2)}` : '';
  const netLine = hasLhs ? `${rhsRaw.toFixed(2)} − ${lhsRaw.toFixed(2)} = ${netRaw.toFixed(2)}` : '';
  const perHour = netRaw / normalizeTargetHours(targetHours);
  const divLine = targetHours !== 1 ? `${netRaw.toFixed(2)} ÷ ${targetHours} = ${perHour.toFixed(2)} לשעה` : '';
  const clampLine = clampedHigh ? '→ נחתך ל-1.00' : clampedLow ? '→ נחתך ל-0.00' : '';
  const parts: string[] = [];
  if (hasLhs) {
    if (rhsLine) parts.push(`\u05d9\u05de\u05d9\u05df: ${rhsLine}`);
    parts.push(`\u05e9\u05de\u05d0\u05dc: ${lhsLine}`);
    if (netLine) parts.push(netLine);
  } else if (rhsLine) {
    parts.push(rhsLine);
  }
  if (divLine) parts.push(divLine);
  if (clampLine) parts.push(clampLine);
  return parts.join(' · ');
}

function renderStackRow(
  side: Side,
  c: LoadFormulaComponent,
  idx: number,
  map: Map<string, TaskTemplate>,
  templatesSorted: TaskTemplate[],
): string {
  const refTpl = map.get(c.refTemplateId);
  const rateInfo = refTpl ? resolveRateValue(refTpl, c.refRate) : null;
  const contribution = rateInfo ? c.hours * rateInfo.value : 0;
  const color = colorForTemplate(refTpl, idx);
  const isActive = _activeRow?.side === side && _activeRow.idx === idx;
  const hoursVal = Number.isFinite(c.hours) ? c.hours : 0;

  const rateLbl = refTpl ? rateLabelFor(c, refTpl) : '';
  const rateDisplay = rateLbl ? `${escAttr(rateLbl)} · ${rateInfo ? rateInfo.value.toFixed(2) : '?'}` : `${rateInfo ? rateInfo.value.toFixed(2) : '?'}`;
  const chipLabel = refTpl
    ? `
        <span class="lf-ref-chip-swatch" style="background:${color}"></span>
        <span class="lf-ref-chip-name">${escAttr(refTpl.name)}</span>
        <span class="lf-ref-chip-rate">${rateDisplay}</span>`
    : `<span class="lf-ref-chip-empty">בחר משימה להשוואה…</span>`;

  const rowClass = side === 'lhs' ? 'lf-stack-row lf-stack-row-lhs' : 'lf-stack-row';

  const hoursControls = refTpl
    ? `
        <div class="lf-stack-hours">
          <div class="lf-stepper" dir="ltr">
            <button type="button" class="lf-stepper-btn" data-lf-action="hours-step" data-lf-idx="${idx}" data-lf-side="${side}" data-lf-delta="-0.25" aria-label="הפחת">−</button>
            <input class="lf-stepper-input" type="number" step="0.25" min="0" max="24"
              data-lf-field="hours" data-lf-idx="${idx}" data-lf-side="${side}" value="${hoursVal}" />
            <button type="button" class="lf-stepper-btn" data-lf-action="hours-step" data-lf-idx="${idx}" data-lf-side="${side}" data-lf-delta="0.25" aria-label="הוסף">+</button>
          </div>
          <span class="lf-stack-unit">שעות</span>
          <span class="lf-stack-eq" dir="ltr">= <strong>${contribution.toFixed(2)}</strong></span>
        </div>`
    : '';

  return `
    <div class="${rowClass}${isActive ? ' active' : ''}${refTpl ? '' : ' lf-stack-row-empty'}" data-lf-row="${idx}" data-lf-side="${side}">
      <div class="lf-stack-main">
        ${side === 'lhs' ? '<span class="lf-stack-plus">+</span>' : ''}
        <button type="button" class="lf-ref-chip${refTpl ? '' : ' empty'}" data-lf-action="toggle-picker" data-lf-idx="${idx}" data-lf-side="${side}" aria-expanded="${isActive}">
          ${chipLabel}
          <span class="lf-ref-chip-caret">${isActive ? '▴' : '▾'}</span>
        </button>
        ${hoursControls}
        <button type="button" class="lf-stack-remove" data-lf-action="remove-row" data-lf-idx="${idx}" data-lf-side="${side}" aria-label="הסר רכיב">✕</button>
      </div>
      ${isActive ? renderPicker(side, idx, c, refTpl, templatesSorted) : ''}
    </div>`;
}

function renderPicker(
  side: Side,
  idx: number,
  currentComp: LoadFormulaComponent,
  currentRefTpl: TaskTemplate | undefined,
  templatesSorted: TaskTemplate[],
): string {
  if (templatesSorted.length === 0) {
    return `<div class="lf-picker"><div class="lf-picker-empty">אין משימות אחרות להשוואה.</div></div>`;
  }

  const chipsHtml = templatesSorted
    .map((t, chipIdx) => {
      const w = templateBaseWeight(t);
      const selected = t.id === currentComp.refTemplateId;
      const color = colorForTemplate(t, chipIdx);
      return `
      <button type="button" class="lf-chip${selected ? ' selected' : ''}" data-lf-action="pick-chip" data-lf-idx="${idx}" data-lf-side="${side}" data-lf-tpl="${escAttr(t.id)}" style="--chip-color:${color}">
        <span class="lf-chip-name">${escAttr(t.name)}</span>
        <span class="lf-chip-mini-bar" dir="ltr">
          <span class="lf-chip-mini-fill" style="width:${(w * 100).toFixed(0)}%"></span>
        </span>
        <span class="lf-chip-value">${w.toFixed(2)}</span>
      </button>`;
    })
    .join('');

  let rateHtml = '';
  const windows: LoadWindow[] = currentRefTpl?.loadWindows ?? [];
  if (currentRefTpl && windows.length > 0) {
    const isBase = currentComp.refRate.kind === 'base';
    const currentWinId = currentComp.refRate.kind === 'window' ? currentComp.refRate.windowId : '';
    const winOpts = windows
      .map((w) => {
        const sel = !isBase && w.id === currentWinId ? ' selected' : '';
        return `<button type="button" class="lf-rate-opt${sel}" data-lf-action="pick-rate" data-lf-idx="${idx}" data-lf-side="${side}" data-lf-rate="win:${escAttr(w.id)}">חם ${escAttr(formatWindowLabel(w))} · ${w.weight.toFixed(2)}</button>`;
      })
      .join('');
    rateHtml = `
      <div class="lf-rate-picker">
        <span class="lf-rate-label">קצב של ${escAttr(currentRefTpl.name)}:</span>
        <button type="button" class="lf-rate-opt${isBase ? ' selected' : ''}" data-lf-action="pick-rate" data-lf-idx="${idx}" data-lf-side="${side}" data-lf-rate="base">בסיס · ${templateBaseWeight(currentRefTpl).toFixed(2)}</button>
        ${winOpts}
      </div>`;
  }

  return `
    <div class="lf-picker">
      <div class="lf-picker-title">השווה ל:</div>
      <div class="lf-chips">${chipsHtml}</div>
      ${rateHtml}
    </div>`;
}

// ─── Event wiring ───────────────────────────────────────────────────────────

function wireEvents(): void {
  const backdrop = document.getElementById('lf-modal-backdrop');
  if (!backdrop) return;

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeLoadFormulaModal();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-lf-action]');
    if (!btn) return;
    const action = btn.dataset.lfAction;
    switch (action) {
      case 'close':
      case 'cancel':
        closeLoadFormulaModal();
        break;
      case 'add-row': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const list = listFor(side);
        list.push(emptyComponent());
        _activeRow = { side, idx: list.length - 1 };
        render();
        break;
      }
      case 'remove-row': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        if (!Number.isFinite(idx)) break;
        const list = listFor(side);
        list.splice(idx, 1);
        // RHS must retain at least one row; LHS may be empty.
        if (side === 'rhs' && list.length === 0) list.push(emptyComponent());
        _activeRow = null;
        render();
        break;
      }
      case 'toggle-picker': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        if (!Number.isFinite(idx)) break;
        const open = _activeRow?.side === side && _activeRow.idx === idx;
        _activeRow = open ? null : { side, idx };
        render();
        break;
      }
      case 'pick-chip': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        const tplId = btn.dataset.lfTpl ?? '';
        const list = listFor(side);
        if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) break;
        const comp = list[idx];
        if (comp.refTemplateId !== tplId) {
          comp.refTemplateId = tplId;
          // New ref template may not have the previously selected window; reset to base.
          comp.refRate = { kind: 'base' };
        }
        // Keep picker open so user can choose a hot window; auto-close if no windows exist.
        const pickedTpl = store.getTaskTemplate(tplId);
        if (!pickedTpl || (pickedTpl.loadWindows?.length ?? 0) === 0) {
          _activeRow = null;
        }
        render();
        break;
      }
      case 'pick-rate': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        const raw = btn.dataset.lfRate ?? 'base';
        const list = listFor(side);
        if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) break;
        const comp = list[idx];
        if (raw === 'base') comp.refRate = { kind: 'base' };
        else if (raw.startsWith('win:')) comp.refRate = { kind: 'window', windowId: raw.slice(4) };
        _activeRow = null;
        render();
        break;
      }
      case 'focus-row': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        const list = listFor(side);
        if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) break;
        const open = _activeRow?.side === side && _activeRow.idx === idx;
        _activeRow = open ? null : { side, idx };
        render();
        break;
      }
      case 'hours-step': {
        const side: Side = btn.dataset.lfSide === 'lhs' ? 'lhs' : 'rhs';
        const idx = Number(btn.dataset.lfIdx);
        const delta = Number(btn.dataset.lfDelta);
        if (!Number.isFinite(idx) || !Number.isFinite(delta)) break;
        const list = listFor(side);
        if (idx < 0 || idx >= list.length) break;
        const next = Math.max(0, Math.min(24, (list[idx].hours ?? 0) + delta));
        list[idx].hours = Math.round(next * 100) / 100;
        render();
        break;
      }
      case 'target-step': {
        const delta = Number(btn.dataset.lfDelta);
        if (!Number.isFinite(delta)) break;
        const next = Math.max(1, Math.min(24, Math.round(_targetHours + delta)));
        _targetHours = next;
        render();
        break;
      }
      case 'toggle-breakdown':
        _showBreakdown = !_showBreakdown;
        render();
        break;
      case 'clear':
        clearFormula();
        break;
      case 'save':
        saveFormula();
        break;
    }
  });

  // Live preview while typing hours.
  backdrop.addEventListener('input', (e) => {
    const el = e.target as HTMLElement;
    const field = el.getAttribute?.('data-lf-field');
    if (field === 'hours') {
      const side: Side = el.getAttribute('data-lf-side') === 'lhs' ? 'lhs' : 'rhs';
      const idx = Number(el.getAttribute('data-lf-idx'));
      const list = listFor(side);
      if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) return;
      const n = parseFloat((el as HTMLInputElement).value);
      list[idx].hours = Number.isFinite(n) ? n : 0;
      updatePreviewOnly();
      return;
    }
    if (field === 'target-hours') {
      const n = parseFloat((el as HTMLInputElement).value);
      _targetHours = Number.isFinite(n) && n > 0 ? n : 1;
      updatePreviewOnly();
    }
  });

  // Commit typed hours on blur/change so downstream re-renders pick up clean values.
  backdrop.addEventListener('change', (e) => {
    const el = e.target as HTMLElement;
    const field = el.getAttribute?.('data-lf-field');
    if (field === 'hours' || field === 'target-hours') render();
  });

  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  _escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeLoadFormulaModal();
  };
  document.addEventListener('keydown', _escHandler);
}

function updatePreviewOnly(): void {
  const backdrop = document.getElementById('lf-modal-backdrop');
  if (!backdrop || !_target) return;
  const tpl = store.getTaskTemplate(_target.templateId);
  if (!tpl) return;
  const map = templatesMap();
  const rhsSnapshot = buildSnapshot(_components, map);
  const lhsSnapshot = buildSnapshot(_lhsExtras, map);
  const validation = validateFormula(_components, tpl.id, map, _lhsExtras);
  const rhsRaw = rawFormulaSum(_components, rhsSnapshot);
  const lhsRaw = rawFormulaSum(_lhsExtras, lhsSnapshot);
  const netRaw = rhsRaw - lhsRaw;
  const targetHours = normalizeTargetHours(_targetHours);
  const perHourRaw = netRaw / targetHours;
  const computed = computeFormulaValue(_components, rhsSnapshot, targetHours, _lhsExtras, lhsSnapshot);
  const clampedHigh = perHourRaw > 1 + 1e-9;
  const clampedLow = perHourRaw < -1e-9;

  const valueEl = backdrop.querySelector('.lf-bar-number-value');
  if (valueEl) valueEl.textContent = computed.toFixed(2);

  const rawEl = backdrop.querySelector<HTMLElement>('.lf-bar-number-raw');
  if (rawEl) {
    if (clampedHigh || clampedLow) {
      rawEl.textContent = `(${perHourRaw.toFixed(2)})`;
      rawEl.removeAttribute('hidden');
    } else {
      rawEl.setAttribute('hidden', '');
    }
  }

  const saveBtn = backdrop.querySelector<HTMLButtonElement>('[data-lf-action="save"]');
  if (saveBtn) saveBtn.disabled = !validation.ok;

  // Update each stack row's "= contribution" total (both sides).
  const updateRowContribs = (side: Side, list: LoadFormulaComponent[], snap: ReturnType<typeof buildSnapshot>) => {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const s = snap[i];
      const contribution = s && !s.missing ? c.hours * s.rate.value : 0;
      const eqEl = backdrop.querySelector(
        `.lf-stack-row[data-lf-side="${side}"][data-lf-row="${i}"] .lf-stack-eq strong`,
      );
      if (eqEl) eqEl.textContent = contribution.toFixed(2);
    }
  };
  updateRowContribs('rhs', _components, rhsSnapshot);
  updateRowContribs('lhs', _lhsExtras, lhsSnapshot);

  const rhsBreakdown = buildBreakdownText(_components, rhsSnapshot);
  const lhsBreakdown = buildBreakdownText(_lhsExtras, lhsSnapshot);
  const breakdownEl = backdrop.querySelector('.lf-bar-breakdown');
  if (breakdownEl) {
    breakdownEl.textContent = renderBreakdownLine(
      rhsBreakdown,
      lhsBreakdown,
      rhsRaw,
      lhsRaw,
      netRaw,
      targetHours,
      clampedHigh,
      clampedLow,
    );
  }
}

// ─── Save / Clear ───────────────────────────────────────────────────────────

function clearFormula(): void {
  if (!_target) return;
  const tpl = store.getTaskTemplate(_target.templateId);
  if (!tpl) return;
  applyFormulaToStore(tpl, _target, undefined);
  closeLoadFormulaModal();
  _ctx?.onChanged();
}

function saveFormula(): void {
  if (!_target) return;
  const tpl = store.getTaskTemplate(_target.templateId);
  if (!tpl) return;
  const map = templatesMap();
  const validation = validateFormula(_components, tpl.id, map, _lhsExtras);
  if (!validation.ok) return;
  const formula = buildFormula(_components, map, _targetHours, _lhsExtras);
  applyFormulaToStore(tpl, _target, formula);
  closeLoadFormulaModal();
  _ctx?.onChanged();
}

function applyFormulaToStore(tpl: TaskTemplate, target: LoadFormulaTarget, formula: LoadFormula | undefined): void {
  if (target.kind === 'base') {
    if (formula) {
      store.updateTaskTemplate(tpl.id, {
        loadFormula: formula,
        baseLoadWeight: formula.computedValue,
      });
    } else {
      store.updateTaskTemplate(tpl.id, { loadFormula: undefined });
    }
    return;
  }
  // Window target: patch the specific window inside loadWindows.
  const updatedWindows: LoadWindow[] = (tpl.loadWindows ?? []).map((w) => {
    if (w.id !== target.windowId) return w;
    if (formula) return { ...w, weight: formula.computedValue, loadFormula: formula };
    const next: LoadWindow = { ...w };
    delete next.loadFormula;
    return next;
  });
  store.updateTaskTemplate(tpl.id, { loadWindows: updatedWindows });
}
