/**
 * Grouped Slot Edit — bottom-sheet editor that applies level / certification
 * changes to every slot in one scope (a task's top-level slots, or one
 * sub-team's slots) at once.
 *
 * Edit model = add/remove with an explicit MIXED state. Each control's initial
 * state is the current aggregate across the scope's slots; controls left MIXED
 * are omitted from the patch, so legitimate per-slot differences are never
 * silently destroyed. Self-contained: owns DOM + draft state, persists via
 * config-store's batched `applyGroupedSlotEdit` (single undo / single notify).
 */

import {
  type CertCtl,
  computeCertAggregate,
  computeLevelAggregate,
  type GroupedConflict,
  type GroupedSlotEdit,
  type LevelCtl,
} from '../models/grouped-slot-edit';
import { Level } from '../models/types';
import type { GroupedSlotScope } from './config-store';
import * as store from './config-store';
import { escHtml, levelBadge } from './ui-helpers';
import { showBottomSheet, showToast } from './ui-modal';

// ─── Context injection ──────────────────────────────────────────────────────

export interface GroupedSlotEditContext {
  /** Called after a grouped edit is applied so the hosting tab re-renders. */
  rerender: () => void;
}

let _ctx: GroupedSlotEditContext | null = null;

export function initGroupedSlotEdit(ctx: GroupedSlotEditContext): void {
  _ctx = ctx;
}

// ─── State ──────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
const LP_SUP = '<sup class="gse-lp" title="מוצא אחרון – הדרגה מותרת אך לא מועדפת">⚠</sup>';
const MIXED_MARK = '<span class="gse-mixed-mark" title="ערכים מעורבים – לא ישתנה אם יישאר כך">⟂</span>';

let _scope: GroupedSlotScope | null = null;
let _handle: { close: () => void; el: HTMLElement } | null = null;
const _levelState = new Map<Level, LevelCtl>();
const _reqState = new Map<string, CertCtl>();
const _forbState = new Map<string, CertCtl>();

// ─── Cycle orders ───────────────────────────────────────────────────────────

const LEVEL_CYCLE: LevelCtl[] = ['off', 'normal', 'low', 'mixed'];
const CERT_CYCLE: CertCtl[] = ['on', 'off', 'mixed'];

function nextLevel(s: LevelCtl): LevelCtl {
  return LEVEL_CYCLE[(LEVEL_CYCLE.indexOf(s) + 1) % LEVEL_CYCLE.length];
}
function nextCert(s: CertCtl): CertCtl {
  return CERT_CYCLE[(CERT_CYCLE.indexOf(s) + 1) % CERT_CYCLE.length];
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function levelBtnHtml(level: Level): string {
  const st = _levelState.get(level) ?? 'mixed';
  let inner: string;
  if (st === 'off') inner = `<span class="gse-lvl-off">L${level}</span>`;
  else if (st === 'mixed') inner = levelBadge(level) + MIXED_MARK;
  else inner = levelBadge(level) + (st === 'low' ? LP_SUP : '');
  return `<button type="button" class="gse-lvl" data-gse-lvl="${level}" data-state="${st}">${inner}</button>`;
}

function certBtnHtml(kind: 'req' | 'forb', certId: string, label: string, color: string): string {
  const map = kind === 'req' ? _reqState : _forbState;
  const st = map.get(certId) ?? 'mixed';
  const mark = st === 'mixed' ? MIXED_MARK : '';
  return `<button type="button" class="gse-cert" data-gse-cert="${kind}" data-cert-id="${escHtml(certId)}" data-state="${st}">
    <span class="gse-cert-dot" style="background:${color}"></span>${escHtml(label)}${mark}
  </button>`;
}

function sheetBody(slotCount: number): string {
  const certs = store.getCertificationDefinitions();
  const levelsRow = LEVEL_OPTIONS.map(levelBtnHtml).join('');
  const reqRow = certs.length
    ? certs.map((c) => certBtnHtml('req', c.id, c.label, c.color)).join('')
    : '<span class="text-muted">אין הסמכות מוגדרות</span>';
  const forbRow = certs.length
    ? certs.map((c) => certBtnHtml('forb', c.id, c.label, c.color)).join('')
    : '<span class="text-muted">אין הסמכות מוגדרות</span>';

  return `
    <p class="gse-summary">${slotCount} משבצות בטווח · שדות עם ערכים מעורבים מסומנים ⟂ ולא ישתנו אם יישארו כך</p>
    <section class="gse-section">
      <div class="gse-section-title">דרגות</div>
      <div class="gse-row">${levelsRow}</div>
      <div class="gse-legend">לחיצה מחליפה: כבוי → רגיל → מוצא אחרון → מעורב</div>
    </section>
    <section class="gse-section">
      <div class="gse-section-title">הסמכות נדרשות</div>
      <div class="gse-row">${reqRow}</div>
    </section>
    <section class="gse-section">
      <div class="gse-section-title">הסמכות אסורות</div>
      <div class="gse-row">${forbRow}</div>
    </section>
    <div id="gse-error" class="gse-error" hidden></div>`;
}

function actionsHtml(slotCount: number): string {
  return `<button class="btn-sm btn-primary" data-gse="apply">החל על ${slotCount} משבצות</button>
    <button class="btn-sm btn-outline" data-gse="cancel">ביטול</button>`;
}

// ─── Patch building + apply ─────────────────────────────────────────────────

function buildPatch(): GroupedSlotEdit {
  const levels = new Map<Level, 'off' | 'normal' | 'low'>();
  for (const [lvl, st] of _levelState) {
    if (st !== 'mixed') levels.set(lvl, st);
  }
  const requiredCerts = new Map<string, boolean>();
  for (const [c, st] of _reqState) {
    if (st !== 'mixed') requiredCerts.set(c, st === 'on');
  }
  const forbiddenCerts = new Map<string, boolean>();
  for (const [c, st] of _forbState) {
    if (st !== 'mixed') forbiddenCerts.set(c, st === 'on');
  }
  return { levels, requiredCerts, forbiddenCerts };
}

function renderConflicts(offending: GroupedConflict[]): string {
  const empty = offending.filter((o) => o.reason === 'EMPTY_LEVELS').map((o) => escHtml(o.label));
  const overlap = offending.filter((o) => o.reason === 'CERT_OVERLAP');
  const lines: string[] = ['<strong>לא ניתן להחיל את השינוי:</strong>'];
  if (empty.length) {
    lines.push(`• המשבצות הבאות יישארו ללא אף דרגה: ${empty.join(', ')}`);
  }
  if (overlap.length) {
    const certNames = (o: GroupedConflict) => (o.certs ?? []).map((c) => escHtml(store.getCertLabel(c))).join(', ');
    const parts = overlap.map((o) => `${escHtml(o.label)} (${certNames(o)})`);
    lines.push(`• הסמכה לא יכולה להיות גם נדרשת וגם אסורה במשבצות: ${parts.join(', ')}`);
  }
  return lines.join('<br>');
}

function onApply(): void {
  if (!_scope || !_handle) return;
  const patch = buildPatch();
  const result = store.applyGroupedSlotEdit(_scope, patch);

  if (!result.ok) {
    const box = _handle.el.querySelector<HTMLElement>('#gse-error');
    if (box) {
      box.innerHTML = renderConflicts(result.offending);
      box.hidden = false;
    }
    showToast('יש משבצות שהשינוי לא חוקי עבורן', { type: 'error' });
    return;
  }

  if (result.changed === 0) {
    showToast('לא בוצעו שינויים', { type: 'info' });
    closeGroupedSlotEdit();
    return;
  }

  showToast(`${result.changed} משבצות עודכנו`, { type: 'success' });
  closeGroupedSlotEdit();
  _ctx?.rerender();
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function openGroupedSlotEdit(scope: GroupedSlotScope): void {
  const view = store.getGroupedSlotScopeView(scope);
  if (!view || view.slots.length === 0) {
    showToast('אין משבצות לעריכה בטווח זה', { type: 'info' });
    return;
  }

  _scope = scope;
  const slots = view.slots;

  _levelState.clear();
  for (const l of LEVEL_OPTIONS) _levelState.set(l, computeLevelAggregate(slots, l));
  _reqState.clear();
  _forbState.clear();
  for (const c of store.getCertificationDefinitions()) {
    _reqState.set(c.id, computeCertAggregate(slots, c.id, 'required'));
    _forbState.set(c.id, computeCertAggregate(slots, c.id, 'forbidden'));
  }

  const title = view.subTeamName
    ? `עריכה קבוצתית — ${view.ownerName} › ${view.subTeamName}`
    : `עריכה קבוצתית — ${view.ownerName}`;

  _handle = showBottomSheet(sheetBody(slots.length), {
    title,
    actions: actionsHtml(slots.length),
    onClose: () => {
      _scope = null;
      _handle = null;
    },
  });

  _handle.el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const lvlBtn = target.closest<HTMLElement>('[data-gse-lvl]');
    if (lvlBtn) {
      const lvl = Number(lvlBtn.dataset.gseLvl) as Level;
      _levelState.set(lvl, nextLevel(_levelState.get(lvl) ?? 'mixed'));
      lvlBtn.outerHTML = levelBtnHtml(lvl);
      return;
    }

    const certBtn = target.closest<HTMLElement>('[data-gse-cert]');
    if (certBtn) {
      const kind = certBtn.dataset.gseCert as 'req' | 'forb';
      const certId = certBtn.dataset.certId ?? '';
      const map = kind === 'req' ? _reqState : _forbState;
      map.set(certId, nextCert(map.get(certId) ?? 'mixed'));
      const def = store.getCertificationById(certId);
      certBtn.outerHTML = certBtnHtml(kind, certId, def?.label ?? certId, def?.color ?? '#7f8c8d');
      return;
    }

    const act = target.closest<HTMLElement>('[data-gse]')?.dataset.gse;
    if (act === 'apply') onApply();
    else if (act === 'cancel') closeGroupedSlotEdit();
  });
}

export function closeGroupedSlotEdit(): void {
  _handle?.close();
  _handle = null;
  _scope = null;
}
