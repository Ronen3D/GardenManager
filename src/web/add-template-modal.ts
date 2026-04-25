/**
 * Add Task Template Modal — centered overlay that replaces the inline
 * "+ משימה חדשה" form on the task-rules tab.
 *
 * Self-contained: owns DOM, state, and event wiring; persists via config-store
 * and notifies the host tab through `onCreated` so it can re-render.
 */

import type { LoadFormula } from '../models/types';
import * as store from './config-store';
import { openLoadFormulaModal } from './load-formula-modal';
import { escAttr } from './ui-helpers';
import { showToast } from './ui-modal';

// ─── Context injection ──────────────────────────────────────────────────────

export interface AddTemplateModalContext {
  /** Called after a template is successfully added so the host tab can re-render. */
  onCreated: () => void;
}

let _ctx: AddTemplateModalContext | null = null;

export function initAddTemplateModal(ctx: AddTemplateModalContext): void {
  _ctx = ctx;
}

// ─── State ──────────────────────────────────────────────────────────────────

const MODAL_ID = 'add-template-modal-backdrop';

let _isOpen = false;
let _pendingFormula: LoadFormula | undefined;
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

export function openAddTemplateModal(): void {
  if (_isOpen) return;
  _isOpen = true;
  _pendingFormula = undefined;
  render();

  _escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeAddTemplateModal();
  };
  document.addEventListener('keydown', _escHandler);

  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(`#${MODAL_ID} [data-field="tpl-name"]`);
    input?.focus();
  });
}

export function closeAddTemplateModal(): void {
  document.getElementById(MODAL_ID)?.remove();
  _isOpen = false;
  _pendingFormula = undefined;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  document.getElementById(MODAL_ID)?.remove();

  const baseLoadValue = _pendingFormula?.computedValue !== undefined ? _pendingFormula.computedValue.toFixed(2) : '1';

  const backdrop = document.createElement('div');
  backdrop.id = MODAL_ID;
  backdrop.className = 'gm-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gm-modal-dialog gm-modal-dialog-wide" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">➕</span>
        <span class="gm-modal-title">משימה חדשה</span>
      </div>
      <div class="gm-modal-body">
        <div class="form-row">
          <label>שם: <input class="input-sm" type="text" data-field="tpl-name" placeholder="שם משימה" /></label>
          <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
          <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
          <label>שעת התחלה: <input class="input-sm" type="time" step="3600" value="06:00" data-field="tpl-start" /></label>
          <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="${escAttr(baseLoadValue)}" data-field="tpl-base-load" /><span class="lf-controls"><button class="btn-xs btn-outline lf-open-btn" type="button" data-action="open-load-formula" title="הגדר לפי השוואה" aria-label="הגדר לפי השוואה">🧮</button></span></label>
        </div>
        <div class="form-row">
          <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> נדרשת אותה קבוצה</label>
          <label class="checkbox-label"><input type="checkbox" data-field="tpl-blocks-consecutive" checked /> חוסם רצף משימות</label>
        </div>
      </div>
      <div class="gm-modal-actions">
        <button class="btn-sm btn-primary" data-action="confirm">צור</button>
        <button class="btn-sm btn-outline" data-action="cancel">ביטול</button>
      </div>
    </div>`;

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeAddTemplateModal();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn || !backdrop.contains(btn)) return;
    const action = btn.dataset.action;
    if (action === 'cancel') closeAddTemplateModal();
    else if (action === 'confirm') handleConfirm();
    else if (action === 'open-load-formula') handleOpenLoadFormula();
  });

  // Submit on Enter while focused inside a text input (mirrors the time-picker UX).
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
        e.preventDefault();
        handleConfirm();
      }
    }
  });

  document.body.appendChild(backdrop);
}

// ─── Handlers ───────────────────────────────────────────────────────────────

function handleOpenLoadFormula(): void {
  const dialog = document.getElementById(MODAL_ID);
  if (!dialog) return;
  const name = (dialog.querySelector('[data-field="tpl-name"]') as HTMLInputElement)?.value.trim() || 'משימה חדשה';
  openLoadFormulaModal({
    kind: 'ephemeral',
    name,
    existingFormula: _pendingFormula,
    onSave: (formula) => {
      _pendingFormula = formula;
      const input = dialog.querySelector<HTMLInputElement>('[data-field="tpl-base-load"]');
      if (input) {
        input.value = formula?.computedValue !== undefined ? formula.computedValue.toFixed(2) : '1';
      }
    },
  });
}

function handleConfirm(): void {
  const dialog = document.getElementById(MODAL_ID);
  if (!dialog) return;

  const name = (dialog.querySelector('[data-field="tpl-name"]') as HTMLInputElement)?.value.trim();
  if (!name) {
    showToast('שם משימה נדרש', { type: 'error' });
    return;
  }
  if (isTaskNameTaken(name)) {
    showToast(`משימה בשם "${name}" כבר קיימת`, { type: 'error' });
    return;
  }
  const dur = parseFloat((dialog.querySelector('[data-field="tpl-duration"]') as HTMLInputElement)?.value || '8');
  const shifts = parseFloat((dialog.querySelector('[data-field="tpl-shifts"]') as HTMLInputElement)?.value || '1');
  const startH = parseFloat((dialog.querySelector('[data-field="tpl-start"]') as HTMLInputElement)?.value || '6');
  const baseLoad = parseFloat((dialog.querySelector('[data-field="tpl-base-load"]') as HTMLInputElement)?.value || '1');
  const sameGroup = (dialog.querySelector('[data-field="tpl-samegroup"]') as HTMLInputElement)?.checked || false;
  const blocksConsecutive =
    (dialog.querySelector('[data-field="tpl-blocks-consecutive"]') as HTMLInputElement)?.checked ?? true;

  const sanitized = store.sanitizeTemplateNumericFields({
    durationHours: dur,
    shiftsPerDay: shifts,
    startHour: startH,
  });
  notifyIfClamped({ durationHours: dur, shiftsPerDay: shifts, startHour: startH }, sanitized);

  const clampedBaseLoad = Math.max(0, Math.min(1, baseLoad));
  // Drop pending formula if user manually edited the input away from the computed value.
  const keepFormula =
    _pendingFormula !== undefined && Math.abs(clampedBaseLoad - _pendingFormula.computedValue) <= 1e-9;

  store.addTaskTemplate({
    name,
    durationHours: sanitized.durationHours,
    shiftsPerDay: sanitized.shiftsPerDay,
    startHour: sanitized.startHour,
    sameGroupRequired: sameGroup,
    baseLoadWeight: clampedBaseLoad,
    loadFormula: keepFormula ? _pendingFormula : undefined,
    loadWindows: [],
    blocksConsecutive,
    togethernessRelevant: false,
    restRuleId: undefined,
    subTeams: [],
    slots: [],
  });

  closeAddTemplateModal();
  _ctx?.onCreated();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTaskNameTaken(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (!key) return false;
  for (const t of store.getAllTaskTemplates()) {
    if (t.name.trim().toLowerCase() === key) return true;
  }
  for (const ot of store.getAllOneTimeTasks()) {
    if (ot.name.trim().toLowerCase() === key) return true;
  }
  return false;
}

const FIELD_LABELS: Record<string, string> = {
  durationHours: 'משך',
  shiftsPerDay: 'משמרות/יום',
  startHour: 'שעת התחלה',
  startMinute: 'דקת התחלה',
};

function notifyIfClamped(raw: Record<string, number | undefined>, sanitized: Record<string, number | undefined>): void {
  const corrections: string[] = [];
  for (const key of Object.keys(raw)) {
    const r = raw[key];
    const s = sanitized[key];
    if (r !== undefined && s !== undefined && r !== s) {
      // U+2066/U+2069 keep the numeric "raw → sanitized" transition rendering LTR
      // inside the surrounding Hebrew toast.
      corrections.push(`${FIELD_LABELS[key] || key}: ⁦${r} → ${s}⁩`);
    }
  }
  if (corrections.length) {
    showToast(`ערכים לא תקינים תוקנו: ${corrections.join(', ')}`, { type: 'warning', duration: 5000 });
  }
}
