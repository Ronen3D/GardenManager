/**
 * Table Edit Mode for Participants — Bulk editing surface.
 *
 * Draft-based: all changes are held in memory until the user clicks Save.
 * A single undo snapshot is pushed on save via bulkMutateParticipants().
 */

import { type CertificationDefinition, Level, type PakalDefinition } from '../models/types';
import type { BulkParticipantOp } from './config-store';
import * as store from './config-store';
import { FORBIDDEN_GROUP_PATTERNS } from './group-name-rules';
import { getEffectivePakalIds } from './pakal-utils';
import { isSmallScreen } from './responsive';
import { certBadge, escAttr, escHtml, groupColor, SVG_ICONS } from './ui-helpers';
import { showAlert, showBottomSheet, showPrompt, showSaveConfirm, showToast } from './ui-modal';

// ─── Constants ──────────────────────────────────────────────────────────────

const LEVEL_OPTIONS: Level[] = [Level.L0, Level.L2, Level.L3, Level.L4];
const LEVEL_LABELS: Record<Level, string> = { [Level.L0]: 'L0', [Level.L2]: 'L2', [Level.L3]: 'L3', [Level.L4]: 'L4' };

// ─── Draft State ────────────────────────────────────────────────────────────

type RowStatus = 'unchanged' | 'modified' | 'new' | 'deleted';

interface DraftRow {
  rowId: string;
  originalId: string | null;
  name: string;
  group: string;
  level: Level;
  certifications: string[];
  pakalIds: string[];
  preferredTaskName: string;
  lessPreferredTaskName: string;
  status: RowStatus;
  errors: Map<string, string>;
  selected: boolean;
}

interface OriginalValues {
  name: string;
  group: string;
  level: Level;
  certifications: string[];
  pakalIds: string[];
  preferredTaskName: string;
  lessPreferredTaskName: string;
}

let _tableEditActive = false;
let _draftRows: DraftRow[] = [];
let _originalSnapshot: Map<string, OriginalValues> = new Map();
let _tmpCounter = 0;
let _beforeUnloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
let _expandedRows: Set<string> = new Set();

// ─── Public API ─────────────────────────────────────────────────────────────

export function isTableEditActive(): boolean {
  return _tableEditActive;
}

export function hasTableEditChanges(): boolean {
  if (!_tableEditActive) return false;
  return _draftRows.some((r) => r.status !== 'unchanged');
}

export function enterTableEditMode(): void {
  _tableEditActive = true;
  _tmpCounter = 0;
  _draftRows = [];
  _originalSnapshot = new Map();

  const participants = store.getAllParticipants();
  for (const p of participants) {
    const pref = store.getTaskNamePreference(p.id);
    const row: DraftRow = {
      rowId: p.id,
      originalId: p.id,
      name: p.name,
      group: p.group,
      level: p.level,
      certifications: [...p.certifications],
      pakalIds: [...(p.pakalIds || [])],
      preferredTaskName: pref.preferred || '',
      lessPreferredTaskName: pref.lessPreferred || '',
      status: 'unchanged',
      errors: new Map(),
      selected: false,
    };
    _draftRows.push(row);
    _originalSnapshot.set(p.id, {
      name: p.name,
      group: p.group,
      level: p.level,
      certifications: [...p.certifications],
      pakalIds: [...(p.pakalIds || [])],
      preferredTaskName: pref.preferred || '',
      lessPreferredTaskName: pref.lessPreferred || '',
    });
  }

  // Validate all rows (catches pre-existing issues)
  for (const row of _draftRows) validateRow(row);

  // Browser close guard
  _beforeUnloadHandler = (e: BeforeUnloadEvent) => {
    if (hasTableEditChanges()) {
      e.preventDefault();
    }
  };
  window.addEventListener('beforeunload', _beforeUnloadHandler);
}

export function exitTableEditMode(): void {
  _tableEditActive = false;
  _draftRows = [];
  _originalSnapshot = new Map();
  _expandedRows = new Set();
  if (_beforeUnloadHandler) {
    window.removeEventListener('beforeunload', _beforeUnloadHandler);
    _beforeUnloadHandler = null;
  }
}

export async function canLeaveTableEdit(): Promise<boolean> {
  if (!_tableEditActive) return true;
  if (!hasTableEditChanges()) {
    exitTableEditMode();
    return true;
  }
  const result = await showSaveConfirm();
  if (result === 'save') {
    const saved = executeSave();
    return saved;
  }
  if (result === 'discard') {
    exitTableEditMode();
    return true;
  }
  // 'continue' — stay in table edit
  return false;
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateRow(row: DraftRow): void {
  row.errors.clear();
  if (row.status === 'deleted') return;

  // Name required
  const trimmedName = row.name.trim();
  if (!trimmedName) {
    row.errors.set('name', 'שם הוא שדה חובה.');
  } else {
    // Name uniqueness among non-deleted draft rows
    const lower = trimmedName.toLowerCase();
    const dup = _draftRows.find(
      (r) => r.rowId !== row.rowId && r.status !== 'deleted' && r.name.trim().toLowerCase() === lower,
    );
    if (dup) {
      row.errors.set('name', 'שם כפול בטבלה.');
    }
  }

  // Group required + validation
  const groupName = row.group.trim();
  if (!groupName) {
    row.errors.set('group', 'קבוצה היא שדה חובה.');
  } else if (groupName.length < 2) {
    row.errors.set('group', 'שם קבוצה חייב להכיל לפחות 2 תווים.');
  } else {
    for (const pat of FORBIDDEN_GROUP_PATTERNS) {
      if (pat.test(groupName)) {
        row.errors.set('group', `"${groupName}" אינו מותר כשם קבוצה.`);
        break;
      }
    }
  }

  // Preference conflict
  if (row.preferredTaskName && row.lessPreferredTaskName && row.preferredTaskName === row.lessPreferredTaskName) {
    row.errors.set('preferredTaskName', 'לא ניתן לבחור אותה משימה כמועדפת וכפחות מועדפת.');
    row.errors.set('lessPreferredTaskName', 'לא ניתן לבחור אותה משימה כמועדפת וכפחות מועדפת.');
  }
}

function validateAllRows(): void {
  for (const row of _draftRows) validateRow(row);
}

/** After a name change on one row, re-validate name uniqueness across all rows. */
function revalidateNames(): void {
  for (const row of _draftRows) {
    if (row.status === 'deleted') continue;
    // Re-run just the name portion
    const oldErrors = new Map(row.errors);
    row.errors.delete('name');
    const trimmedName = row.name.trim();
    if (!trimmedName) {
      row.errors.set('name', 'שם הוא שדה חובה.');
    } else {
      const lower = trimmedName.toLowerCase();
      const dup = _draftRows.find(
        (r) => r.rowId !== row.rowId && r.status !== 'deleted' && r.name.trim().toLowerCase() === lower,
      );
      if (dup) {
        row.errors.set('name', 'שם כפול בטבלה.');
      }
    }
    // Restore non-name errors
    for (const [k, v] of oldErrors) {
      if (k !== 'name') row.errors.set(k, v);
    }
  }
}

function computeRowStatus(row: DraftRow): void {
  if (row.originalId === null) {
    row.status = 'new';
    return;
  }
  if (row.status === 'deleted') return;
  const orig = _originalSnapshot.get(row.originalId);
  if (!orig) {
    row.status = 'modified';
    return;
  }
  const changed =
    row.name !== orig.name ||
    row.group !== orig.group ||
    row.level !== orig.level ||
    row.preferredTaskName !== orig.preferredTaskName ||
    row.lessPreferredTaskName !== orig.lessPreferredTaskName ||
    JSON.stringify([...row.certifications].sort()) !== JSON.stringify([...orig.certifications].sort()) ||
    JSON.stringify([...row.pakalIds].sort()) !== JSON.stringify([...orig.pakalIds].sort());
  row.status = changed ? 'modified' : 'unchanged';
}

function hasValidationErrors(): boolean {
  return _draftRows.some((r) => r.status !== 'deleted' && r.errors.size > 0);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCertDefs(): CertificationDefinition[] {
  return store.getCertificationDefinitions();
}

function getPakalDefs(): PakalDefinition[] {
  return store.getPakalDefinitions();
}

function getTaskNameOptions(): string[] {
  return [...new Set(store.getAllTaskTemplates().map((t) => t.name))];
}

function getGroupOptions(): string[] {
  // Collect groups from both store and draft rows
  const groups = new Set(store.getGroups());
  for (const row of _draftRows) {
    if (row.status !== 'deleted' && row.group.trim()) groups.add(row.group.trim());
  }
  return [...groups].sort();
}

function getChangeSummary(): { total: number; added: number; modified: number; deleted: number } {
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const r of _draftRows) {
    if (r.status === 'new') added++;
    else if (r.status === 'modified') modified++;
    else if (r.status === 'deleted') deleted++;
  }
  return { total: added + modified + deleted, added, modified, deleted };
}

function getSelectedNonDeletedRows(): DraftRow[] {
  return _draftRows.filter((r) => r.selected && r.status !== 'deleted');
}

// ─── Save ───────────────────────────────────────────────────────────────────

function executeSave(): boolean {
  validateAllRows();
  if (hasValidationErrors()) {
    const errCount = _draftRows.filter((r) => r.status !== 'deleted' && r.errors.size > 0).length;
    showAlert(`${errCount} שורות עם שגיאות מונעות שמירה. תקן את השגיאות ונסה שוב.`, { icon: '⚠' });
    return false;
  }

  const ops: BulkParticipantOp[] = [];
  for (const row of _draftRows) {
    if (row.status === 'new') {
      ops.push({
        type: 'add',
        data: {
          name: row.name.trim(),
          group: row.group.trim(),
          level: row.level,
          certifications: [...row.certifications],
          pakalIds: [...row.pakalIds],
          preferredTaskName: row.preferredTaskName || undefined,
          lessPreferredTaskName: row.lessPreferredTaskName || undefined,
        },
      });
    } else if (row.status === 'modified') {
      ops.push({
        type: 'update',
        id: row.originalId!,
        data: {
          name: row.name.trim(),
          group: row.group.trim(),
          level: row.level,
          certifications: [...row.certifications],
          pakalIds: [...row.pakalIds],
          preferredTaskName: row.preferredTaskName || undefined,
          lessPreferredTaskName: row.lessPreferredTaskName || undefined,
        },
      });
    } else if (row.status === 'deleted' && row.originalId) {
      ops.push({ type: 'delete', id: row.originalId });
    }
  }

  if (ops.length === 0) {
    exitTableEditMode();
    return true;
  }

  const result = store.bulkMutateParticipants(ops);
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${result.added} חדשים`);
  if (result.updated > 0) parts.push(`${result.updated} עודכנו`);
  if (result.deleted > 0) parts.push(`${result.deleted} נמחקו`);
  showToast(`שינויים נשמרו: ${parts.join(', ')}`, { type: 'success' });
  exitTableEditMode();
  return true;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

export function renderTableEditMode(): string {
  const certDefs = getCertDefs();
  const pakalDefs = getPakalDefs();
  const taskNames = getTaskNameOptions();
  const groups = getGroupOptions();
  const summary = getChangeSummary();
  const selCount = getSelectedNonDeletedRows().length;

  let html = '';

  // ── Toolbar ──
  html += `<div class="te-toolbar">
    <div class="te-toolbar-left">
      <h2>עריכת טבלה <span class="count">${_draftRows.length}</span></h2>`;
  if (summary.total > 0) {
    const parts: string[] = [];
    if (summary.added > 0) parts.push(`${summary.added} חדש`);
    if (summary.modified > 0) parts.push(`${summary.modified} עדכון`);
    if (summary.deleted > 0) parts.push(`${summary.deleted} מחיקה`);
    html += ` <span class="te-change-summary">${summary.total} שינויים (${parts.join(', ')})</span>`;
  }
  html += `</div>
    <div class="te-toolbar-right">
      <button class="btn-sm btn-outline" data-te-action="add-row">+ שורה חדשה</button>`;
  if (selCount > 0) {
    html += `<button class="btn-sm btn-outline" data-te-action="bulk-group">קבוצה ל-${selCount} נבחרים</button>`;
  }
  html += `
      <button class="btn-sm btn-outline" data-te-action="cancel">ביטול</button>
      <button class="btn-primary btn-sm${hasValidationErrors() ? ' btn-disabled' : ''}" data-te-action="save"${hasValidationErrors() ? ' disabled' : ''}>שמירה</button>
    </div>
  </div>`;

  // ── Validation summary ──
  const errorRows = _draftRows.filter((r) => r.status !== 'deleted' && r.errors.size > 0);
  if (errorRows.length > 0) {
    html += `<div class="te-validation-bar">
      <strong>⚠ ${errorRows.length} שורות עם שגיאות מונעות שמירה</strong>
      <ul class="te-error-list">`;
    for (const row of errorRows) {
      const idx = _draftRows.indexOf(row) + 1;
      const name = row.name.trim() || `שורה ${idx}`;
      for (const [, msg] of row.errors) {
        html += `<li>${escHtml(name)}: ${escHtml(msg)}</li>`;
      }
    }
    html += `</ul></div>`;
  }

  // ── Table (desktop) or Cards (mobile) ──
  if (isSmallScreen) {
    html += renderMobileCompactList(certDefs, pakalDefs, taskNames, groups);
  } else {
    html += renderDesktopTable(certDefs, pakalDefs, taskNames, groups);
  }

  return html;
}

function renderDesktopTable(
  certDefs: CertificationDefinition[],
  pakalDefs: PakalDefinition[],
  taskNames: string[],
  groups: string[],
): string {
  const allSelected = _draftRows.length > 0 && _draftRows.every((r) => r.selected || r.status === 'deleted');

  let html = `<div class="table-responsive"><table class="table te-table">
    <thead><tr>
      <th class="te-col-select"><input type="checkbox" data-te-action="select-all" ${allSelected ? 'checked' : ''} /></th>
      <th class="te-col-index">#</th>
      <th class="te-col-name">שם</th>
      <th class="te-col-group">קבוצה</th>
      <th class="te-col-level">דרגה</th>
      <th class="te-col-certs">הסמכות</th>
      <th class="te-col-pakals">פק"לים</th>
      <th class="te-col-pref">מעדיף</th>
      <th class="te-col-lesspref">פחות מועדף</th>
      <th class="te-col-delete"></th>
    </tr></thead><tbody>`;

  _draftRows.forEach((row, i) => {
    html += renderDesktopRow(row, i, certDefs, pakalDefs, taskNames, groups);
  });

  html += '</tbody></table></div>';
  return html;
}

function renderDesktopRow(
  row: DraftRow,
  index: number,
  certDefs: CertificationDefinition[],
  pakalDefs: PakalDefinition[],
  taskNames: string[],
  groups: string[],
): string {
  const isDeleted = row.status === 'deleted';
  const cls = isDeleted
    ? 'te-row-deleted'
    : row.status === 'new'
      ? 'te-row-new'
      : row.status === 'modified'
        ? 'te-row-modified'
        : '';
  const dis = isDeleted ? ' disabled' : '';

  return `<tr class="te-row ${cls}" data-te-row="${row.rowId}">
    <td class="te-col-select"><input type="checkbox" data-te-action="select-row" data-te-row-id="${row.rowId}" ${row.selected ? 'checked' : ''}${dis} /></td>
    <td class="te-col-index">${index + 1}</td>
    <td class="te-col-name">
      <input type="text" class="input-sm te-input${row.errors.has('name') ? ' te-cell-error' : ''}" data-te-field="name" data-te-row-id="${row.rowId}" value="${escAttr(row.name)}"${dis} aria-invalid="${row.errors.has('name')}" />
      ${row.errors.has('name') ? `<div class="te-field-error">${escHtml(row.errors.get('name')!)}</div>` : ''}
    </td>
    <td class="te-col-group">
      ${renderGroupSelect(row, groups, isDeleted)}
      ${row.errors.has('group') ? `<div class="te-field-error">${escHtml(row.errors.get('group')!)}</div>` : ''}
    </td>
    <td class="te-col-level">
      <select class="input-sm te-input" data-te-field="level" data-te-row-id="${row.rowId}"${dis}>
        ${LEVEL_OPTIONS.map((l) => `<option value="${l}"${row.level === l ? ' selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('')}
      </select>
    </td>
    <td class="te-col-certs">${renderCertCheckboxes(row, certDefs, isDeleted)}</td>
    <td class="te-col-pakals">${renderPakalCheckboxes(row, pakalDefs, isDeleted)}</td>
    <td class="te-col-pref">
      ${renderTaskSelect(row, 'preferredTaskName', taskNames, isDeleted)}
      ${row.errors.has('preferredTaskName') ? `<div class="te-field-error">${escHtml(row.errors.get('preferredTaskName')!)}</div>` : ''}
    </td>
    <td class="te-col-lesspref">
      ${renderTaskSelect(row, 'lessPreferredTaskName', taskNames, isDeleted)}
      ${row.errors.has('lessPreferredTaskName') ? `<div class="te-field-error">${escHtml(row.errors.get('lessPreferredTaskName')!)}</div>` : ''}
    </td>
    <td class="te-col-delete">
      <button class="btn-sm btn-outline btn-icon" data-te-action="${isDeleted ? 'restore-row' : 'delete-row'}" data-te-row-id="${row.rowId}" title="${isDeleted ? 'שחזור' : 'מחיקה'}">
        ${isDeleted ? '↩' : SVG_ICONS.trash}
      </button>
    </td>
  </tr>`;
}

function renderGroupSelect(row: DraftRow, groups: string[], disabled: boolean): string {
  const dis = disabled ? ' disabled' : '';
  return `<select class="input-sm te-input${row.errors.has('group') ? ' te-cell-error' : ''}" data-te-field="group" data-te-row-id="${row.rowId}"${dis} aria-invalid="${row.errors.has('group')}">
    ${groups.map((g) => `<option value="${escAttr(g)}"${row.group === g ? ' selected' : ''}>${escHtml(g)}</option>`).join('')}
    <option value="__new__">+ קבוצה חדשה…</option>
  </select>`;
}

function renderCertCheckboxes(row: DraftRow, defs: CertificationDefinition[], disabled: boolean): string {
  const dis = disabled ? ' disabled' : '';
  return `<div class="te-cert-checks">${defs
    .filter((d) => !d.deleted)
    .map(
      (d) =>
        `<label class="te-check-label" title="${escHtml(d.label)}"><input type="checkbox" data-te-field="cert" data-te-cert-id="${d.id}" data-te-row-id="${row.rowId}" ${row.certifications.includes(d.id) ? 'checked' : ''}${dis} />${certBadge(d.id)}</label>`,
    )
    .join('')}</div>`;
}

function renderPakalCheckboxes(row: DraftRow, defs: PakalDefinition[], disabled: boolean): string {
  const dis = disabled ? ' disabled' : '';
  const effectiveIds = new Set(
    getEffectivePakalIds(
      {
        id: '',
        name: '',
        level: row.level,
        certifications: row.certifications,
        group: '',
        availability: [],
        dateUnavailability: [],
        pakalIds: row.pakalIds,
      },
      defs,
    ),
  );
  return `<div class="te-pakal-checks">${defs
    .map(
      (d) =>
        `<label class="te-check-label" title="${escHtml(d.label)}"><input type="checkbox" data-te-field="pakal" data-te-pakal-id="${d.id}" data-te-row-id="${row.rowId}" ${effectiveIds.has(d.id) ? 'checked' : ''}${dis} />${escHtml(d.label)}</label>`,
    )
    .join('')}</div>`;
}

function renderTaskSelect(
  row: DraftRow,
  field: 'preferredTaskName' | 'lessPreferredTaskName',
  taskNames: string[],
  disabled: boolean,
): string {
  const val = row[field];
  const dis = disabled ? ' disabled' : '';
  return `<select class="input-sm te-input${row.errors.has(field) ? ' te-cell-error' : ''}" data-te-field="${field}" data-te-row-id="${row.rowId}"${dis} aria-invalid="${row.errors.has(field)}">
    <option value="">— ללא —</option>
    ${taskNames.map((n) => `<option value="${escAttr(n)}"${val === n ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}
  </select>`;
}

// ─── Mobile Compact List Rendering ─────────────────────────────────────────

function renderMobileCompactList(
  certDefs: CertificationDefinition[],
  pakalDefs: PakalDefinition[],
  taskNames: string[],
  groups: string[],
): string {
  const selCount = getSelectedNonDeletedRows().length;
  let html = '<div class="te-compact-list">';
  _draftRows.forEach((row, i) => {
    html += renderCompactRow(row, i, certDefs, pakalDefs, taskNames, groups);
  });
  html += '</div>';

  // Sticky bottom toolbar for mobile
  if (selCount > 0) {
    html += `<div class="te-mobile-bottom-bar te-mobile-bulk-bar">
      <span class="te-bulk-count">${selCount} נבחרים</span>
      <button class="btn-sm btn-outline" data-te-action="bulk-group">קבוצה</button>
      <button class="btn-sm btn-outline" data-te-action="bulk-level">דרגה</button>
      <button class="btn-sm btn-outline" data-te-action="bulk-certs">הסמכות</button>
      <button class="btn-sm btn-outline btn-danger-outline" data-te-action="bulk-delete">${SVG_ICONS.trash}</button>
    </div>`;
  } else {
    html += `<div class="te-mobile-bottom-bar">
      <button class="btn-sm btn-outline" data-te-action="quick-add">+ הוספה מהירה</button>
      <button class="btn-sm btn-outline" data-te-action="add-row">+ שורה</button>
      <button class="btn-sm btn-outline" data-te-action="cancel">ביטול</button>
      <button class="btn-primary btn-sm${hasValidationErrors() ? ' btn-disabled' : ''}" data-te-action="save"${hasValidationErrors() ? ' disabled' : ''}>שמירה${getChangeSummary().total > 0 ? ` · ${getChangeSummary().total}` : ''}</button>
    </div>`;
  }
  return html;
}

function renderCompactRow(
  row: DraftRow,
  index: number,
  certDefs: CertificationDefinition[],
  pakalDefs: PakalDefinition[],
  taskNames: string[],
  groups: string[],
): string {
  const isDeleted = row.status === 'deleted';
  const isExpanded = _expandedRows.has(row.rowId);
  const statusCls = isDeleted
    ? 'te-compact-deleted'
    : row.status === 'new'
      ? 'te-compact-new'
      : row.status === 'modified'
        ? 'te-compact-modified'
        : '';
  const dis = isDeleted ? ' disabled' : '';
  const hasErrors = row.errors.size > 0;

  let html = `<div class="te-compact-row ${statusCls}${isExpanded ? ' te-compact-expanded' : ''}${hasErrors ? ' te-compact-has-errors' : ''}" data-te-row="${row.rowId}">
    <div class="te-compact-header">
      <input type="checkbox" data-te-action="select-row" data-te-row-id="${row.rowId}" ${row.selected ? 'checked' : ''}${dis} />
      <input type="text" class="te-compact-name${row.errors.has('name') ? ' te-cell-error' : ''}" data-te-field="name" data-te-row-id="${row.rowId}" value="${escAttr(row.name)}" placeholder="שם"${dis} aria-invalid="${row.errors.has('name')}" />
      <select class="te-compact-pill te-compact-group${row.errors.has('group') ? ' te-cell-error' : ''}" data-te-field="group" data-te-row-id="${row.rowId}"${dis} aria-invalid="${row.errors.has('group')}">
        ${groups.map((g) => `<option value="${escAttr(g)}"${row.group === g ? ' selected' : ''}>${escHtml(g)}</option>`).join('')}
        <option value="__new__">+ חדשה…</option>
      </select>
      <select class="te-compact-pill te-compact-level" data-te-field="level" data-te-row-id="${row.rowId}"${dis}>
        ${LEVEL_OPTIONS.map((l) => `<option value="${l}"${row.level === l ? ' selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('')}
      </select>
      <button class="te-compact-chevron" data-te-action="${isDeleted ? 'restore-row' : 'toggle-expand'}" data-te-row-id="${row.rowId}">
        ${isDeleted ? '↩' : isExpanded ? '⌃' : '⌄'}
      </button>
    </div>`;

  // Inline error for name/group (shown in compact view, targetable for DOM updates)
  if (row.errors.has('name')) {
    html += `<div class="te-field-error te-compact-error" data-te-error-for="name">${escHtml(row.errors.get('name')!)}</div>`;
  }
  if (row.errors.has('group')) {
    html += `<div class="te-field-error te-compact-error" data-te-error-for="group">${escHtml(row.errors.get('group')!)}</div>`;
  }

  // Expanded section (secondary fields — visibility controlled via CSS grid animation)
  // Single wrapper child is required for the 0fr → 1fr grid animation to work
  html += `<div class="te-compact-body${isDeleted ? ' te-compact-body-hidden' : ''}">
    <div class="te-compact-body-inner">
      <div class="te-compact-field">
        <label class="te-compact-label">הסמכות</label>
        ${renderCertCheckboxes(row, certDefs, isDeleted)}
      </div>
      <div class="te-compact-field">
        <label class="te-compact-label">פק"לים</label>
        ${renderPakalCheckboxes(row, pakalDefs, isDeleted)}
      </div>
      <div class="te-compact-field">
        <label class="te-compact-label">מעדיף</label>
        ${renderTaskSelect(row, 'preferredTaskName', taskNames, isDeleted)}
        ${row.errors.has('preferredTaskName') ? `<div class="te-field-error">${escHtml(row.errors.get('preferredTaskName')!)}</div>` : ''}
      </div>
      <div class="te-compact-field">
        <label class="te-compact-label">פחות מועדף</label>
        ${renderTaskSelect(row, 'lessPreferredTaskName', taskNames, isDeleted)}
        ${row.errors.has('lessPreferredTaskName') ? `<div class="te-field-error">${escHtml(row.errors.get('lessPreferredTaskName')!)}</div>` : ''}
      </div>
      <button class="btn-sm btn-danger-outline te-compact-delete" data-te-action="delete-row" data-te-row-id="${row.rowId}">
        ${SVG_ICONS.trash} מחיקה
      </button>
    </div>
  </div>`;

  html += '</div>';
  return html;
}

// ─── Event Wiring ───────────────────────────────────────────────────────────

export function wireTableEditEvents(container: HTMLElement, rerender: () => void): void {
  // Delegated event handler for buttons
  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('[data-te-action]');
    if (!btn) return;
    const action = btn.dataset.teAction;

    switch (action) {
      case 'add-row':
        handleAddRow(rerender);
        break;
      case 'delete-row':
        handleDeleteRow(btn.dataset.teRowId!, rerender);
        break;
      case 'restore-row':
        handleRestoreRow(btn.dataset.teRowId!, rerender);
        break;
      case 'save':
        if (executeSave()) rerender();
        break;
      case 'cancel':
        await handleCancel(rerender);
        break;
      case 'select-all':
        handleSelectAll(btn as HTMLInputElement, rerender);
        break;
      case 'select-row':
        handleSelectRow(btn as HTMLInputElement, rerender);
        break;
      case 'bulk-group':
        await handleBulkGroup(rerender);
        break;
      case 'bulk-level':
        await handleBulkLevel(rerender);
        break;
      case 'bulk-certs':
        await handleBulkCerts(rerender);
        break;
      case 'bulk-delete':
        handleBulkDelete(rerender);
        break;
      case 'toggle-expand':
        handleToggleExpand(btn.dataset.teRowId!, rerender);
        break;
      case 'quick-add':
        await handleQuickAdd(rerender);
        break;
    }
  });

  // Delegated input handler for text fields (selects are handled by 'change' only
  // to avoid double-processing — selects fire both 'input' and 'change')
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    if (target.tagName === 'SELECT') return;
    const rowId = target.dataset.teRowId;
    const field = target.dataset.teField;
    if (!rowId || !field) return;

    const row = _draftRows.find((r) => r.rowId === rowId);
    if (!row) return;

    handleFieldChange(row, field, target, container, rerender);
  });

  // Change handler for selects and checkboxes
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const rowId = target.dataset.teRowId;
    const field = target.dataset.teField;
    if (!rowId || !field) return;

    const row = _draftRows.find((r) => r.rowId === rowId);
    if (!row) return;

    handleFieldChange(row, field, target, container, rerender);
  });
}

function handleFieldChange(
  row: DraftRow,
  field: string,
  target: HTMLInputElement | HTMLSelectElement,
  container: HTMLElement,
  rerender: () => void,
): void {
  switch (field) {
    case 'name':
      row.name = (target as HTMLInputElement).value;
      computeRowStatus(row);
      revalidateNames();
      updateRowUI(row, container);
      updateToolbarUI(container);
      break;

    case 'group':
      if (target.value === '__new__') {
        // Show prompt for new group name
        showPrompt('שם קבוצה חדשה:', { title: 'קבוצה חדשה', placeholder: 'שם קבוצה' }).then((name) => {
          if (name?.trim()) {
            row.group = name.trim();
          }
          // Reset select to current group value either way
          computeRowStatus(row);
          validateRow(row);
          rerender();
        });
        return;
      }
      row.group = target.value;
      computeRowStatus(row);
      validateRow(row);
      updateRowUI(row, container);
      updateToolbarUI(container);
      break;

    case 'level':
      row.level = Number.parseInt(target.value, 10) as Level;
      computeRowStatus(row);
      validateRow(row);
      updateRowUI(row, container);
      updateToolbarUI(container);
      break;

    case 'cert': {
      const certId = (target as HTMLInputElement).dataset.teCertId!;
      const checked = (target as HTMLInputElement).checked;
      if (checked && !row.certifications.includes(certId)) {
        row.certifications.push(certId);
      } else if (!checked) {
        row.certifications = row.certifications.filter((c) => c !== certId);
      }
      computeRowStatus(row);
      validateRow(row);
      updateToolbarUI(container);
      break;
    }

    case 'pakal': {
      const pakalId = (target as HTMLInputElement).dataset.tePakalId!;
      const checked = (target as HTMLInputElement).checked;
      if (checked && !row.pakalIds.includes(pakalId)) {
        row.pakalIds.push(pakalId);
      } else if (!checked) {
        row.pakalIds = row.pakalIds.filter((p) => p !== pakalId);
      }
      computeRowStatus(row);
      validateRow(row);
      updateToolbarUI(container);
      break;
    }

    case 'preferredTaskName':
      row.preferredTaskName = target.value;
      computeRowStatus(row);
      validateRow(row);
      updateRowUI(row, container);
      updateToolbarUI(container);
      break;

    case 'lessPreferredTaskName':
      row.lessPreferredTaskName = target.value;
      computeRowStatus(row);
      validateRow(row);
      updateRowUI(row, container);
      updateToolbarUI(container);
      break;
  }
}

// ─── Action Handlers ────────────────────────────────────────────────────────

function handleAddRow(rerender: () => void): void {
  const firstCert = getCertDefs().find((d) => !d.deleted)?.id;
  // Smart defaults: inherit group + level from the last non-deleted row
  let lastRow: DraftRow | null = null;
  for (let i = _draftRows.length - 1; i >= 0; i--) {
    if (_draftRows[i].status !== 'deleted') {
      lastRow = _draftRows[i];
      break;
    }
  }
  const defaultGroup = lastRow?.group || getGroupOptions()[0] || '';
  const defaultLevel = lastRow?.level ?? Level.L0;
  const row: DraftRow = {
    rowId: `tmp-${++_tmpCounter}`,
    originalId: null,
    name: '',
    group: defaultGroup,
    level: defaultLevel,
    certifications: firstCert ? [firstCert] : [],
    pakalIds: [],
    preferredTaskName: '',
    lessPreferredTaskName: '',
    status: 'new',
    errors: new Map(),
    selected: false,
  };
  validateRow(row);
  _draftRows.push(row);
  rerender();

  // After re-render, scroll to and focus the new row's name input
  requestAnimationFrame(() => {
    const nameInput = document.querySelector<HTMLInputElement>(`[data-te-field="name"][data-te-row-id="${row.rowId}"]`);
    nameInput?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    nameInput?.focus();
  });
}

function handleDeleteRow(rowId: string, rerender: () => void): void {
  const row = _draftRows.find((r) => r.rowId === rowId);
  if (!row) return;

  if (row.originalId === null) {
    // New row: just remove it entirely
    _draftRows = _draftRows.filter((r) => r.rowId !== rowId);
    revalidateNames();
  } else {
    row.status = 'deleted';
    row.selected = false;
    row.errors.clear();
    revalidateNames();
  }
  rerender();
}

function handleRestoreRow(rowId: string, rerender: () => void): void {
  const row = _draftRows.find((r) => r.rowId === rowId);
  if (!row) return;
  computeRowStatus(row);
  validateRow(row);
  revalidateNames();
  rerender();
}

async function handleCancel(rerender: () => void): Promise<void> {
  if (!hasTableEditChanges()) {
    exitTableEditMode();
    rerender();
    return;
  }
  const result = await showSaveConfirm();
  if (result === 'save') {
    if (executeSave()) rerender();
  } else if (result === 'discard') {
    exitTableEditMode();
    rerender();
  }
  // 'continue' — do nothing
}

function handleSelectAll(checkbox: HTMLInputElement, rerender: () => void): void {
  const checked = checkbox.checked;
  for (const row of _draftRows) {
    if (row.status !== 'deleted') row.selected = checked;
  }
  rerender();
}

function handleSelectRow(checkbox: HTMLInputElement, rerender: () => void): void {
  const rowId = checkbox.dataset.teRowId!;
  const row = _draftRows.find((r) => r.rowId === rowId);
  if (!row) return;
  row.selected = checkbox.checked;
  rerender();
}

async function handleBulkGroup(rerender: () => void): Promise<void> {
  const selected = getSelectedNonDeletedRows();
  if (selected.length === 0) return;

  const groups = getGroupOptions();

  if (isSmallScreen) {
    // Mobile: bottom sheet
    const sheetHtml = `<div class="te-bulk-group-sheet">
      <p>בחר קבוצה עבור ${selected.length} משתתפים:</p>
      ${groups.map((g) => `<button class="btn-sm btn-outline te-group-option" data-group="${escAttr(g)}" style="border-color:${groupColor(g)}">${escHtml(g)}</button>`).join('')}
      <button class="btn-sm btn-outline te-group-option" data-group="__new__">+ קבוצה חדשה…</button>
    </div>`;
    const sheet = showBottomSheet(sheetHtml, { title: 'קבוצה לנבחרים' });
    sheet.el.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.te-group-option');
      if (!btn) return;
      let group = btn.dataset.group!;
      if (group === '__new__') {
        const name = await showPrompt('שם קבוצה חדשה:', { title: 'קבוצה חדשה', placeholder: 'שם קבוצה' });
        if (!name?.trim()) return;
        group = name.trim();
      }
      for (const row of selected) {
        row.group = group;
        computeRowStatus(row);
        validateRow(row);
      }
      sheet.close();
      rerender();
    });
  } else {
    // Desktop: prompt for simplicity
    const options = groups.map((g) => `• ${g}`).join('\n');
    const name = await showPrompt(`בחר קבוצה עבור ${selected.length} משתתפים:\n\nקבוצות קיימות:\n${options}`, {
      title: 'קבוצה לנבחרים',
      placeholder: 'שם קבוצה',
      suggestions: groups,
    });
    if (!name?.trim()) return;
    for (const row of selected) {
      row.group = name.trim();
      computeRowStatus(row);
      validateRow(row);
    }
    rerender();
  }
}

function handleToggleExpand(rowId: string, _rerender: () => void): void {
  if (_expandedRows.has(rowId)) {
    _expandedRows.delete(rowId);
  } else {
    _expandedRows.add(rowId);
  }
  // Targeted toggle without full re-render — CSS grid animation handles visibility
  const rowEl = document.querySelector<HTMLElement>(`[data-te-row="${rowId}"]`);
  if (rowEl) {
    const chevron = rowEl.querySelector<HTMLElement>('[data-te-action="toggle-expand"]');
    const isExpanded = _expandedRows.has(rowId);
    rowEl.classList.toggle('te-compact-expanded', isExpanded);
    if (chevron) chevron.textContent = isExpanded ? '⌃' : '⌄';
  }
}

async function handleBulkLevel(rerender: () => void): Promise<void> {
  const selected = getSelectedNonDeletedRows();
  if (selected.length === 0) return;

  const sheetHtml = `<div class="te-bulk-group-sheet">
    <p>בחר דרגה עבור ${selected.length} משתתפים:</p>
    ${LEVEL_OPTIONS.map((l) => `<button class="btn-sm btn-outline te-level-option" data-level="${l}">${LEVEL_LABELS[l]}</button>`).join('')}
  </div>`;
  const sheet = showBottomSheet(sheetHtml, { title: 'דרגה לנבחרים' });
  sheet.el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.te-level-option');
    if (!btn) return;
    const level = Number.parseInt(btn.dataset.level!, 10) as Level;
    for (const row of selected) {
      row.level = level;
      computeRowStatus(row);
      validateRow(row);
    }
    sheet.close();
    rerender();
  });
}

async function handleBulkCerts(rerender: () => void): Promise<void> {
  const selected = getSelectedNonDeletedRows();
  if (selected.length === 0) return;

  const certDefs = getCertDefs().filter((d) => !d.deleted);
  // Pre-check certs that ALL selected participants currently have
  const allHaveCert = (certId: string) => selected.every((r) => r.certifications.includes(certId));

  const sheetHtml = `<div class="te-bulk-group-sheet">
    <p>הסמכות עבור ${selected.length} משתתפים:</p>
    <p class="te-bulk-hint">סמן כדי להוסיף, בטל סימון כדי להסיר</p>
    ${certDefs.map((d) => `<label class="te-check-label te-bulk-cert-label"><input type="checkbox" data-cert-id="${d.id}" ${allHaveCert(d.id) ? 'checked' : ''} />${certBadge(d.id)} ${escHtml(d.label)}</label>`).join('')}
    <button class="btn-primary btn-sm te-bulk-apply" style="margin-top:8px">החל</button>
  </div>`;
  const sheet = showBottomSheet(sheetHtml, { title: 'הסמכות לנבחרים' });
  sheet.el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.te-bulk-apply');
    if (!btn) return;
    const checks = sheet.el.querySelectorAll<HTMLInputElement>('[data-cert-id]');
    for (const chk of checks) {
      const certId = chk.dataset.certId!;
      for (const row of selected) {
        if (chk.checked && !row.certifications.includes(certId)) {
          row.certifications.push(certId);
        } else if (!chk.checked) {
          row.certifications = row.certifications.filter((c) => c !== certId);
        }
        computeRowStatus(row);
        validateRow(row);
      }
    }
    sheet.close();
    rerender();
  });
}

function handleBulkDelete(rerender: () => void): void {
  const selected = getSelectedNonDeletedRows();
  if (selected.length === 0) return;
  for (const row of selected) {
    if (row.originalId === null) {
      _draftRows = _draftRows.filter((r) => r.rowId !== row.rowId);
    } else {
      row.status = 'deleted';
      row.selected = false;
      row.errors.clear();
    }
  }
  revalidateNames();
  rerender();
}

// ─── Quick-Add Sheet ───────────────────────────────────────────────────────

interface QuickAddChip {
  name: string;
  id: number;
}

let _quickAddCounter = 0;

async function handleQuickAdd(rerender: () => void): Promise<void> {
  const groups = getGroupOptions();
  const certDefs = getCertDefs().filter((d) => !d.deleted);
  let chips: QuickAddChip[] = [];
  let selectedGroup = groups[0] || '';
  let selectedLevel = Level.L0;

  const sheetHtml = `<div class="te-quick-add">
    <div class="te-qa-field">
      <label class="te-compact-label">קבוצה</label>
      <select class="input-sm te-input te-qa-group">
        ${groups.map((g) => `<option value="${escAttr(g)}">${escHtml(g)}</option>`).join('')}
        <option value="__new__">+ קבוצה חדשה…</option>
      </select>
    </div>
    <div class="te-qa-field">
      <label class="te-compact-label">דרגה</label>
      <select class="input-sm te-input te-qa-level">
        ${LEVEL_OPTIONS.map((l) => `<option value="${l}"${l === Level.L0 ? ' selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('')}
      </select>
    </div>
    <details class="te-qa-details">
      <summary>הסמכות ברירת מחדל</summary>
      <div class="te-cert-checks te-qa-certs">
        ${certDefs.map((d) => `<label class="te-check-label"><input type="checkbox" data-qa-cert="${d.id}" />${certBadge(d.id)} ${escHtml(d.label)}</label>`).join('')}
      </div>
    </details>
    <hr class="te-qa-divider" />
    <div class="te-qa-input-row">
      <input type="text" class="input-sm te-input te-qa-name" placeholder="שם משתתף" />
      <button class="btn-sm btn-outline te-qa-add-btn" disabled>הוסף</button>
      <button class="btn-sm btn-outline te-qa-paste-btn" title="הדבק שמות מהלוח">📋</button>
    </div>
    <div class="te-qa-error" style="display:none"></div>
    <div class="te-qa-chips"></div>
    <div class="te-qa-summary" style="display:none"></div>
    <button class="btn-primary btn-sm te-qa-create" disabled style="width:100%;margin-top:8px"></button>
  </div>`;

  const sheet = showBottomSheet(sheetHtml, { title: 'הוספה מהירה' });
  const el = sheet.el;

  const nameInput = el.querySelector<HTMLInputElement>('.te-qa-name')!;
  const addBtn = el.querySelector<HTMLButtonElement>('.te-qa-add-btn')!;
  const chipsEl = el.querySelector<HTMLElement>('.te-qa-chips')!;
  const summaryEl = el.querySelector<HTMLElement>('.te-qa-summary')!;
  const createBtn = el.querySelector<HTMLButtonElement>('.te-qa-create')!;
  const errorEl = el.querySelector<HTMLElement>('.te-qa-error')!;
  const groupSelect = el.querySelector<HTMLSelectElement>('.te-qa-group')!;
  const levelSelect = el.querySelector<HTMLSelectElement>('.te-qa-level')!;

  function updateChipsUI(): void {
    chipsEl.innerHTML = chips
      .map(
        (c) =>
          `<span class="te-qa-chip" data-qa-chip="${c.id}">${escHtml(c.name)}<button class="te-qa-chip-remove" data-qa-remove="${c.id}">×</button></span>`,
      )
      .join('');
    const count = chips.length;
    createBtn.textContent = count > 0 ? `צור ${count} משתתפים` : 'צור משתתפים';
    // Disable Create when no chips OR no group selected
    createBtn.disabled = count === 0 || !selectedGroup.trim();
    // Also disable name input & add button when no group selected
    const noGroup = !selectedGroup.trim();
    nameInput.disabled = noGroup;
    addBtn.disabled = noGroup || !nameInput.value.trim();
    if (noGroup) {
      errorEl.textContent = 'יש לבחור קבוצה תחילה.';
      errorEl.style.display = '';
    } else if (errorEl.textContent === 'יש לבחור קבוצה תחילה.') {
      errorEl.style.display = 'none';
    }
    summaryEl.style.display = count > 0 ? '' : 'none';
    summaryEl.textContent = `${count} משתתפים · ${selectedGroup} · ${LEVEL_LABELS[selectedLevel]}`;
  }

  function validateName(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    // Check against existing draft rows
    const lower = trimmed.toLowerCase();
    const existsInDraft = _draftRows.find((r) => r.status !== 'deleted' && r.name.trim().toLowerCase() === lower);
    if (existsInDraft) return `"${trimmed}" כבר קיים ברשימה.`;
    // Check against chips already added
    const existsInChips = chips.find((c) => c.name.trim().toLowerCase() === lower);
    if (existsInChips) return `"${trimmed}" כבר נוסף.`;
    return null;
  }

  function addChip(): void {
    const name = nameInput.value.trim();
    if (!name) return;
    const err = validateName(name);
    if (err) {
      errorEl.textContent = err;
      errorEl.style.display = '';
      return;
    }
    chips.push({ name, id: ++_quickAddCounter });
    nameInput.value = '';
    errorEl.style.display = 'none';
    addBtn.disabled = true;
    updateChipsUI();
    nameInput.focus();
  }

  // Initialize UI state (gates name input when no group selected)
  updateChipsUI();

  // Wire events
  nameInput.addEventListener('input', () => {
    const val = nameInput.value.trim();
    addBtn.disabled = !val || !selectedGroup.trim();
    if (val) {
      const err = validateName(val);
      if (err) {
        errorEl.textContent = err;
        errorEl.style.display = '';
      } else {
        errorEl.style.display = 'none';
      }
    } else {
      errorEl.style.display = 'none';
    }
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addChip();
    }
  });

  addBtn.addEventListener('click', () => addChip());

  chipsEl.addEventListener('click', (e) => {
    const removeBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-qa-remove]');
    if (!removeBtn) return;
    const chipId = Number.parseInt(removeBtn.dataset.qaRemove!, 10);
    chips = chips.filter((c) => c.id !== chipId);
    updateChipsUI();
  });

  // Paste from clipboard
  const pasteBtn = el.querySelector<HTMLButtonElement>('.te-qa-paste-btn')!;
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const names = text
        .split(/\r?\n/)
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length === 0) {
        errorEl.textContent = 'הלוח ריק או לא מכיל שמות.';
        errorEl.style.display = '';
        return;
      }
      let added = 0;
      const errors: string[] = [];
      for (const name of names) {
        const err = validateName(name);
        if (err) {
          errors.push(`${name}: ${err}`);
        } else {
          chips.push({ name, id: ++_quickAddCounter });
          added++;
        }
      }
      updateChipsUI();
      if (errors.length > 0) {
        errorEl.textContent = `${added} שמות נוספו, ${errors.length} דולגו (כפילויות).`;
        errorEl.style.display = '';
      } else {
        errorEl.style.display = 'none';
      }
    } catch {
      errorEl.textContent = 'אין גישה ללוח. בדוק הרשאות.';
      errorEl.style.display = '';
    }
  });

  groupSelect.addEventListener('change', async () => {
    if (groupSelect.value === '__new__') {
      const name = await showPrompt('שם קבוצה חדשה:', { title: 'קבוצה חדשה', placeholder: 'שם קבוצה' });
      if (name?.trim()) {
        selectedGroup = name.trim();
        // Add option and select it
        const opt = document.createElement('option');
        opt.value = selectedGroup;
        opt.textContent = selectedGroup;
        groupSelect.insertBefore(opt, groupSelect.querySelector('option[value="__new__"]'));
        groupSelect.value = selectedGroup;
      } else {
        groupSelect.value = selectedGroup;
      }
    } else {
      selectedGroup = groupSelect.value;
    }
    updateChipsUI();
  });

  levelSelect.addEventListener('change', () => {
    selectedLevel = Number.parseInt(levelSelect.value, 10) as Level;
    updateChipsUI();
  });

  createBtn.addEventListener('click', () => {
    if (chips.length === 0) return;
    const certChecks = el.querySelectorAll<HTMLInputElement>('[data-qa-cert]');
    const defaultCerts: string[] = [];
    for (const chk of certChecks) {
      if (chk.checked) defaultCerts.push(chk.dataset.qaCert!);
    }
    // If no certs selected, use the first active cert as default (matching handleAddRow behavior)
    const firstCert = getCertDefs().find((d) => !d.deleted)?.id;
    const certs = defaultCerts.length > 0 ? defaultCerts : firstCert ? [firstCert] : [];

    for (const chip of chips) {
      const row: DraftRow = {
        rowId: `tmp-${++_tmpCounter}`,
        originalId: null,
        name: chip.name,
        group: selectedGroup,
        level: selectedLevel,
        certifications: [...certs],
        pakalIds: [],
        preferredTaskName: '',
        lessPreferredTaskName: '',
        status: 'new',
        errors: new Map(),
        selected: false,
      };
      validateRow(row);
      _draftRows.push(row);
    }
    revalidateNames();
    sheet.close();
    showToast(`${chips.length} משתתפים נוספו ל-${selectedGroup}`, { type: 'success' });
    rerender();
  });

  // Focus the name input after the sheet animates in
  requestAnimationFrame(() => nameInput.focus());
}

// ─── Targeted DOM Updates ───────────────────────────────────────────────────

function updateRowUI(row: DraftRow, container: HTMLElement): void {
  const rowEl = container.querySelector<HTMLElement>(`[data-te-row="${row.rowId}"]`);
  if (!rowEl) return;

  // Update status class
  rowEl.classList.remove(
    'te-row-new',
    'te-row-modified',
    'te-row-deleted',
    'te-compact-new',
    'te-compact-modified',
    'te-compact-deleted',
  );
  const prefix = rowEl.tagName === 'TR' ? 'te-row' : 'te-compact';
  if (row.status === 'new') rowEl.classList.add(`${prefix}-new`);
  else if (row.status === 'modified') rowEl.classList.add(`${prefix}-modified`);
  else if (row.status === 'deleted') rowEl.classList.add(`${prefix}-deleted`);

  // Update error indicators on each field
  const fields = ['name', 'group', 'preferredTaskName', 'lessPreferredTaskName'];
  for (const field of fields) {
    const input = rowEl.querySelector<HTMLElement>(`[data-te-field="${field}"][data-te-row-id="${row.rowId}"]`);
    if (!input) continue;
    const hasError = row.errors.has(field);
    input.classList.toggle('te-cell-error', hasError);
    input.setAttribute('aria-invalid', String(hasError));

    // Update or create error message
    // For desktop rows: error is inside the <td> parent of the input
    // For compact rows: error has data-te-error-for attribute, lives in the row element
    const existingMsg =
      rowEl.querySelector<HTMLElement>(`.te-field-error[data-te-error-for="${field}"]`) ??
      input.parentElement?.querySelector('.te-field-error');
    if (hasError) {
      const msg = row.errors.get(field)!;
      if (existingMsg) {
        existingMsg.textContent = msg;
      } else if (rowEl.tagName === 'TR') {
        // Desktop: append to the input's parent <td>
        const div = document.createElement('div');
        div.className = 'te-field-error';
        div.textContent = msg;
        input.parentElement?.appendChild(div);
      }
      // Compact rows: errors are rendered during full re-render only (not created dynamically)
    } else if (existingMsg) {
      existingMsg.remove();
    }
  }
}

function updateToolbarUI(container: HTMLElement): void {
  // Update save button state
  const saveBtn = container.querySelector<HTMLButtonElement>('[data-te-action="save"]');
  if (saveBtn) {
    const hasErrors = hasValidationErrors();
    saveBtn.disabled = hasErrors;
    saveBtn.classList.toggle('btn-disabled', hasErrors);
  }

  // Update change summary
  const summary = getChangeSummary();
  const summaryEl = container.querySelector('.te-change-summary');
  if (summaryEl && summary.total > 0) {
    const parts: string[] = [];
    if (summary.added > 0) parts.push(`${summary.added} חדש`);
    if (summary.modified > 0) parts.push(`${summary.modified} עדכון`);
    if (summary.deleted > 0) parts.push(`${summary.deleted} מחיקה`);
    summaryEl.textContent = `${summary.total} שינויים (${parts.join(', ')})`;
  } else if (summaryEl) {
    summaryEl.textContent = '';
  }

  // Update validation bar
  const valBar = container.querySelector('.te-validation-bar');
  const errorRows = _draftRows.filter((r) => r.status !== 'deleted' && r.errors.size > 0);
  if (valBar) {
    if (errorRows.length === 0) {
      valBar.remove();
    }
    // For simplicity, don't rebuild the bar on targeted updates — full rerender handles it
  }
}
