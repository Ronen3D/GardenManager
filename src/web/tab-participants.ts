/**
 * Participants Tab — Stage 0 Configuration UI
 *
 * CRUD table for managing participants, with inline editing,
 * group filtering, and blackout period management.
 */

import type { CertificationDefinition, Participant } from '../models/types';
import { fmtTime } from '../utils/date-utils';
import * as store from './config-store';
import { openParticipantSetFormatSheet, openXlsxImportFlow } from './data-transfer-ui';
import { triggerCharacterFarewell } from './easter-eggs';
import { renderPakalBadges } from './pakal-utils';
import { showParticipantEditor } from './participant-editor-sheet';
import {
  canLeaveTableEdit,
  enterTableEditMode,
  exitTableEditMode,
  isTableEditActive,
  renderTableEditMode,
  wireTableEditEvents,
} from './table-edit-participants';
import { certBadges, escHtml, groupBadge, levelBadge, SVG_ICONS } from './ui-helpers';
import { showConfirm, showToast } from './ui-modal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_WORKLOAD_MULTIPLIER = 1;

/** Compact display for a workload multiplier (e.g. 0.5, 1.25, 2). */
export function formatWorkloadMultiplier(m: number): string {
  return Number(m.toFixed(2)).toString();
}

/** Badge shown in the participant row when workloadMultiplier ≠ 1.
 *  Returns '' when the multiplier is the default. */
function workloadMultBadge(mult: number | undefined): string {
  if (mult === undefined || Math.abs(mult - 1) < 1e-9) return '';
  const display = formatWorkloadMultiplier(mult);
  return ` <span class="badge badge-sm workload-mult-badge"
       title="מקדם עומס ${display} — היעד הוגנות מותאם בהתאם.">מקדם ×${display}</span>`;
}

function getCertOptions(): CertificationDefinition[] {
  return store.getCertificationDefinitions();
}

/** Check if a participant holds any deleted certification or pakal. */
function hasOrphanedRefs(p: Participant): boolean {
  const activeCertIds = new Set(getCertOptions().map((d) => d.id));
  if (p.certifications.some((c) => !activeCertIds.has(c))) return true;
  const activePakalIds = new Set(store.getPakalDefinitions().map((d) => d.id));
  if ((p.pakalIds || []).some((id) => !activePakalIds.has(id))) return true;
  return false;
}

/** Format the day-range prefix of a DateUnavailability rule as "יום N" or "יום N–יום M". */
function formatRuleDayRangeShort(r: { dayIndex: number; endDayIndex?: number }): string {
  const start = r.dayIndex;
  const end = r.endDayIndex ?? r.dayIndex;
  return start === end ? `יום ${start}` : `יום ${start}–${end}`;
}
function formatRuleDayRangeLong(r: { dayIndex: number; endDayIndex?: number }): string {
  const start = r.dayIndex;
  const end = r.endDayIndex ?? r.dayIndex;
  return start === end ? `יום ${start}` : `יום ${start}–יום ${end}`;
}

/** Compact unavailability chips rendered below participant name. */
function renderUnavailChips(pid: string): string {
  const rules = store.getDateUnavailabilities(pid);
  if (rules.length === 0) return '';

  const MAX_VISIBLE = 3;
  const visible = rules.slice(0, MAX_VISIBLE);

  const chips = visible
    .map((r) => {
      const day = formatRuleDayRangeShort(r);
      const time = r.allDay
        ? 'כל היום'
        : `${String(r.startHour).padStart(2, '0')}-${String(r.endHour).padStart(2, '0')}`;
      const tooltipTime = r.allDay
        ? 'כל היום'
        : `${String(r.startHour).padStart(2, '0')}:00–${String(r.endHour).padStart(2, '0')}:00`;
      const tooltip = `${formatRuleDayRangeLong(r)} ${tooltipTime}${r.reason ? ` (${r.reason})` : ''}`;
      return `<span class="unavail-chip" title="${escHtml(tooltip)}">${day} ${time}</span>`;
    })
    .join('');

  const overflow =
    rules.length > MAX_VISIBLE
      ? `<span class="unavail-chip unavail-chip-more" title="${rules.length} כללי אי-זמינות">+${rules.length - MAX_VISIBLE}</span>`
      : '';

  return `<div class="unavail-chips" data-action="toggle-blackouts" data-pid="${pid}">${chips}${overflow}</div>`;
}

function renderPreferenceBadges(p: Participant): string {
  const parts: string[] = [];
  if (p.preferredTaskName) {
    parts.push(`<span class="badge badge-sm" style="background:#27ae60">מעדיף: ${p.preferredTaskName}</span>`);
  }
  if (p.lessPreferredTaskName) {
    parts.push(`<span class="badge badge-sm" style="background:#e67e22">פחות: ${p.lessPreferredTaskName}</span>`);
  }
  return parts.length > 0 ? parts.join(' ') : '<span class="text-muted">—</span>';
}

// ─── State ───────────────────────────────────────────────────────────────────

let filterGroup: string = '';
let sortColumn: 'name' | 'group' | 'level' | '' = '';
let sortDirection: 'asc' | 'desc' = 'asc';

// ─── Multi-Select State ──────────────────────────────────────────────────────

const selectedIds: Set<string> = new Set();
/** Tracks the last-clicked participant ID for Shift+Click range selection */
let _lastClickedId: string | null = null;
/** When true the bulk unavailability dialog is open */
let _bulkDialogOpen = false;
/** When true the bulk delete confirmation dialog is open */
let _bulkDeleteDialogOpen = false;

function getVisibleParticipants(allParticipants: Participant[] = store.getAllParticipants()): Participant[] {
  const filtered = filterGroup ? allParticipants.filter((p) => p.group === filterGroup) : allParticipants;
  return sortParticipants(filtered);
}

function reconcileSelection(visibleParticipants: Participant[] = getVisibleParticipants()): void {
  const visibleIds = new Set(visibleParticipants.map((p) => p.id));

  for (const id of Array.from(selectedIds)) {
    if (!visibleIds.has(id)) selectedIds.delete(id);
  }

  if (_lastClickedId && !visibleIds.has(_lastClickedId)) {
    _lastClickedId = null;
  }

  if (selectedIds.size === 0) {
    _bulkDialogOpen = false;
    _bulkDeleteDialogOpen = false;
  }
}

// ─── Participant Sets Panel State ────────────────────────────────────────────

let _setsPanelOpen = false;
let _setsFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _setsFormError = '';
let _setsRenameTargetId: string | null = null;

/** Clear participant selection state (called on tab change) */
export function clearParticipantSelection(): void {
  if (isTableEditActive()) exitTableEditMode();
  selectedIds.clear();
  _lastClickedId = null;
  _bulkDialogOpen = false;
  _bulkDeleteDialogOpen = false;
}

/** Full reset of module-level view state. Called by the tutorial demo mode
 *  on tour entry and exit so a filter/sort the user set during one tour
 *  doesn't leak into the next, and the demo's full 6-participant roster
 *  isn't accidentally filtered to one group. */
export function resetParticipantsTabViewState(): void {
  filterGroup = '';
  sortColumn = '';
  sortDirection = 'asc';
  _setsPanelOpen = false;
  _setsFormMode = 'none';
  _setsFormError = '';
  _setsRenameTargetId = null;
  clearParticipantSelection();
}

/**
 * Async guard for tab switching: if table-edit mode has unsaved changes,
 * show a save/discard/continue dialog. Returns true if leaving is allowed.
 */
export async function canLeaveParticipantsTab(): Promise<boolean> {
  return canLeaveTableEdit();
}
// ─── Sort Logic ──────────────────────────────────────────────────────────────

function sortParticipants(list: Participant[]): Participant[] {
  if (!sortColumn) return list;
  const dir = sortDirection === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    switch (sortColumn) {
      case 'name':
        return dir * a.name.localeCompare(b.name);
      case 'group':
        return dir * a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
      case 'level':
        return dir * (a.level - b.level) || a.name.localeCompare(b.name);
      default:
        return 0;
    }
  });
}

function sortIndicator(col: string): string {
  if (sortColumn !== col) return '';
  return sortDirection === 'asc' ? ' ▲' : ' ▼';
}

// ─── Participant Sets Panel ───────────────────────────────────────────────────

function renderSetsPanel(): string {
  const sets = store.getAllParticipantSets();
  const activeId = store.getActiveParticipantSetId();
  const dirty = store.isParticipantSetDirty();

  let html = `<div class="preset-panel pset-panel">`;

  // Header
  html += `<div class="preset-panel-header">
    <h3>📋 סטים של משתתפים <span class="count">${sets.length}</span></h3>
    <div class="preset-header-actions">
      <button class="btn-xs btn-outline" data-action="pset-import-xlsx" title="ייבוא סט מקובץ Excel">📊 ייבוא Excel</button>
      <button class="btn-xs btn-outline" data-action="pset-panel-close" title="סגור">✕</button>
    </div>
  </div>`;

  // Form area
  if (_setsFormMode === 'save-as') {
    html += `<div class="preset-inline-form" id="pset-saveas-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="pset-saveas-name" maxlength="60" placeholder="סט המשתתפים שלי" autofocus /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="pset-saveas-desc" maxlength="200" placeholder="תיאור אופציונלי" /></label>
        <button class="btn-sm btn-primary" data-action="pset-saveas-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="pset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="pset-form-error">${_setsFormError}</div>
    </div>`;
  } else if (_setsFormMode === 'rename') {
    const targetId = _setsRenameTargetId ?? activeId;
    const target = targetId ? store.getParticipantSetById(targetId) : undefined;
    html += `<div class="preset-inline-form" id="pset-rename-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="pset-rename-name" maxlength="60" value="${escHtml(target?.name ?? '')}" /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="pset-rename-desc" maxlength="200" value="${escHtml(target?.description ?? '')}" /></label>
        <button class="btn-sm btn-primary" data-action="pset-rename-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="pset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="pset-form-error">${_setsFormError}</div>
    </div>`;
  } else {
    html += `<div class="preset-actions-primary">
      <button class="btn-sm btn-primary" data-action="pset-new">+ שמור סט חדש</button>
    </div>`;
  }

  // Set list
  if (sets.length === 0) {
    html += `<div class="preset-empty"><span class="text-muted">אין סטים שמורים.</span></div>`;
  } else {
    html += `<div class="preset-list">`;
    for (const s of sets) {
      const isActive = s.id === activeId;
      const isBuiltIn = s.builtIn ?? false;
      const count = s.participants.length;
      html += `<div class="preset-item ${isActive ? 'preset-item-active' : ''}" data-pset-id="${s.id}">
        <div class="preset-item-main">
          <span class="preset-item-name">${escHtml(s.name)}</span>
          <span class="pset-count-badge">${count} משתתפים</span>
          ${isBuiltIn ? '<span class="preset-builtin-badge">מובנה</span>' : ''}
          ${isActive && dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
        </div>
        ${s.description ? `<div class="preset-item-desc text-muted">${escHtml(s.description)}</div>` : ''}
        <div class="preset-item-actions">
          ${!isActive ? `<button class="btn-xs btn-primary" data-pset-action="load" data-pset-id="${s.id}" title="טען סט זה">▶ טען</button>` : ''}
          ${isActive && dirty && !isBuiltIn ? `<button class="btn-xs btn-outline" data-pset-action="update" data-pset-id="${s.id}" title="עדכן עם המשתתפים הנוכחיים">עדכן</button>` : ''}
          ${!isBuiltIn ? `<button class="btn-xs btn-outline" data-pset-action="rename" data-pset-id="${s.id}" title="שנה שם">✎</button>` : ''}
          <button class="btn-xs btn-outline" data-pset-action="duplicate" data-pset-id="${s.id}" title="שכפל">⧉</button>
          <button class="btn-xs btn-outline" data-pset-action="export" data-pset-id="${s.id}" title="ייצוא (JSON / Excel)">📤</button>
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-pset-action="delete" data-pset-id="${s.id}" title="מחק">${SVG_ICONS.trash}</button>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderParticipantsTab(): string {
  // ── Table Edit Mode branch ──
  if (isTableEditActive()) {
    return renderTableEditMode();
  }

  const allParticipants = store.getAllParticipants();
  const groups = store.getGroups();
  const sorted = getVisibleParticipants(allParticipants);
  reconcileSelection(sorted);
  const visibleSelectedCount = sorted.reduce(
    (count, participant) => count + (selectedIds.has(participant.id) ? 1 : 0),
    0,
  );

  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>משתתפים <span class="count">${allParticipants.length}</span></h2>
      <div class="filter-pills">
        <button class="pill ${filterGroup === '' ? 'pill-active' : ''}" data-action="filter-group" data-group="">הכל</button>
        ${groups
          .map(
            (g) =>
              `<button class="pill ${filterGroup === g ? 'pill-active' : ''}" data-action="filter-group" data-group="${escHtml(g)}">${escHtml(g)}</button>`,
          )
          .join('')}
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-expand-all-mobile btn-sm btn-outline" data-action="toggle-all-details">הרחב הכל</button>
      <button class="btn-sm btn-outline${_setsPanelOpen ? ' pill-active' : ''}" data-action="pset-panel-toggle" title="סטים של משתתפים">📋 סטים${store.isParticipantSetDirty() ? ' <span class="dirty-dot"></span>' : ''}</button>
      <button class="btn-sm btn-outline" data-action="enter-table-edit" title="עריכת טבלה מרובה">✏️ עריכת טבלה</button>
      <button class="btn-primary btn-sm" data-action="add-participant">+ הוסף משתתף</button>
    </div>
  </div>`;

  // Participant Sets panel
  if (_setsPanelOpen) {
    html += renderSetsPanel();
  }
  // Table
  html += `<div class="table-responsive"><table class="table table-participants">
    <thead><tr>
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="בחר הכל" ${visibleSelectedCount > 0 && visibleSelectedCount === sorted.length ? 'checked' : ''} /></th>
      <th class="col-index">#</th>
      <th class="col-name sortable-th" data-action="sort-column" data-sort-col="name">שם${sortIndicator('name')}</th>
      <th class="col-group sortable-th" data-action="sort-column" data-sort-col="group">קבוצה${sortIndicator('group')}</th>
      <th class="col-level sortable-th" data-action="sort-column" data-sort-col="level">דרגה${sortIndicator('level')}</th>
      <th class="col-certs">הסמכות</th>
      <th class="col-pakals">פק"לים</th>
      <th class="col-prefs">העדפות</th>
      <th class="col-avail">זמינות</th><th class="col-actions">פעולות</th><th class="col-expand"></th>
    </tr></thead><tbody>`;

  sorted.forEach((p, i) => {
    const dateRules = store.getDateUnavailabilities(p.id);
    const totalRules = dateRules.length;
    const isSelected = selectedIds.has(p.id);
    const allPakalDefs = store.getAllPakalDefinitionsIncludeDeleted();

    html += `<tr data-participant-id="${p.id}" class="${isSelected ? 'row-selected' : ''}${totalRules > 0 ? ' has-unavail' : ''}">
        <td class="col-select"><input type="checkbox" class="cb-select-participant" data-pid="${p.id}" ${isSelected ? 'checked' : ''} /></td>
        <td class="col-index">${i + 1}</td>
        <td class="col-name" title="${escHtml(p.name)}">${hasOrphanedRefs(p) ? '<span class="badge-orphan-icon">⚠</span> ' : ''}<strong>${escHtml(p.name)}</strong>${renderUnavailChips(p.id)}</td>
        <td class="col-group">${groupBadge(p.group, true)}</td>
        <td class="col-level">${levelBadge(p.level)}${workloadMultBadge(p.workloadMultiplier)}</td>
        <td class="col-certs">${certBadges(p.certifications)}</td>
        <td class="col-pakals">${renderPakalBadges(p, allPakalDefs)}</td>
        <td class="col-prefs">${renderPreferenceBadges(p)}</td>
        <td class="col-avail avail-cell">
          <span class="mobile-label">זמינות: </span>${p.availability.map((w) => `<small dir="ltr">${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
        </td>
        <td class="col-actions">
          <button class="btn-sm btn-outline btn-icon" data-action="edit-participant" data-pid="${p.id}" title="עריכה">${SVG_ICONS.edit}</button>
          <button class="btn-sm btn-outline btn-danger-outline btn-icon" data-action="remove-participant" data-pid="${p.id}" title="הסרה">${SVG_ICONS.trash}</button>
        </td>
        <td class="col-expand"><button class="btn-expand-details${totalRules > 0 ? ' has-unavail-badge' : ''}" data-action="toggle-details" data-pid="${p.id}" title="פרטים">${SVG_ICONS.chevronDown}${totalRules > 0 ? `<span class="expand-unavail-count" aria-label="${totalRules} כללי אי-זמינות">${totalRules}</span>` : ''}</button></td>
      </tr>`;
  });

  html += '</tbody></table></div>';

  // ── Bulk Actions Toolbar (shown when selection is non-empty) ──
  if (selectedIds.size > 0) {
    html += `<div class="bulk-toolbar">
      <span class="bulk-count">${selectedIds.size} משתתפים נבחרו</span>
      <button class="btn-sm btn-outline" data-action="bulk-add-unavailability">${SVG_ICONS.calendar} הוסף חוסר זמינות</button>
      <button class="btn-sm btn-danger-outline" data-action="bulk-delete-participants">${SVG_ICONS.trash} מחק משתתפים</button>
      <button class="btn-sm btn-outline" data-action="bulk-clear-selection">נקה בחירה</button>
    </div>`;
  }

  // ── Bulk Unavailability Dialog ──
  if (_bulkDialogOpen) {
    html += renderBulkUnavailDialog();
  }

  // ── Bulk Delete Confirmation Dialog ──
  if (_bulkDeleteDialogOpen) {
    html += renderBulkDeleteDialog();
  }

  return html;
}

// ─── Bulk Unavailability Dialog ──────────────────────────────────────────────

function renderBulkUnavailDialog(): string {
  const nDays = store.getScheduleDays();
  const dayOptions = Array.from({ length: nDays }, (_, i) => `<option value="${i + 1}">יום ${i + 1}</option>`).join('');
  return `<div class="bulk-dialog-backdrop" data-action="bulk-dialog-dismiss">
    <div class="bulk-dialog">
      <h3>הוסף חוסר זמינות עבור ${selectedIds.size} משתתפים</h3>

      <div class="bulk-dialog-body">
        <div class="form-row">
          <label>מיום
            <select class="input-sm" data-field="bulk-day-start">
              ${dayOptions}
            </select>
          </label>
          <label>עד יום
            <select class="input-sm" data-field="bulk-day-end">
              ${dayOptions}
            </select>
          </label>
        </div>

        <div class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" data-field="bulk-allday" /> כל היום
          </label>
        </div>

        <div class="form-row bulk-time-fields">
          <label>שעת התחלה
            <input type="number" class="input-sm" data-field="bulk-start" min="0" max="23" value="8" style="width:70px" />
          </label>
          <span style="align-self:end;padding-bottom:4px">עד</span>
          <label>שעת סיום
            <input type="number" class="input-sm" data-field="bulk-end" min="0" max="23" value="16" style="width:70px" />
          </label>
        </div>

        <div class="form-row">
          <label style="flex:1">סיבה
            <input type="text" class="input-sm" data-field="bulk-reason" placeholder="למשל: הכשרת צוות" style="width:100%" />
          </label>
        </div>
      </div>

      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-outline" data-action="bulk-dialog-cancel">ביטול</button>
        <button class="btn-primary btn-sm" data-action="bulk-dialog-save">שמור ל-${selectedIds.size} משתתפים</button>
      </div>
    </div>
  </div>`;
}

// ─── Bulk Delete Confirmation Dialog ─────────────────────────────────────────

function renderBulkDeleteDialog(): string {
  const n = selectedIds.size;
  return `<div class="bulk-dialog-backdrop" data-action="bulk-delete-dismiss">
    <div class="bulk-dialog bulk-delete-dialog">
      <h3>⚠️ למחוק ${n} משתתפים?</h3>
      <p class="bulk-delete-warning">
        האם למחוק <strong>${n}</strong> משתתפים?
        פעולה זו תסיר גם את כל השיבוצים וכללי חוסר הזמינות המשויכים.
        לא ניתן לבטל פעולה זו.
      </p>
      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-danger-outline" data-action="bulk-delete-confirm">אישור מחיקה</button>
        <button class="btn-sm btn-outline" data-action="bulk-delete-cancel">ביטול</button>
      </div>
    </div>
  </div>`;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireParticipantsEvents(container: HTMLElement, rerender: () => void): void {
  // ── Table Edit Mode branch ──
  if (isTableEditActive()) {
    wireTableEditEvents(container, rerender);
    return;
  }

  // ── Enter Table Edit button ──
  container.querySelector('[data-action="enter-table-edit"]')?.addEventListener('click', () => {
    enterTableEditMode();
    rerender();
  });

  // ─── Bulk: Select-All checkbox ─────────────────────────────────────────────
  const selectAllCb = container.querySelector('#cb-select-all') as HTMLInputElement | null;
  if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
      const cbs = container.querySelectorAll<HTMLInputElement>('.cb-select-participant');
      if (selectAllCb.checked) {
        cbs.forEach((cb) => selectedIds.add(cb.dataset.pid!));
      } else {
        selectedIds.clear();
      }
      _lastClickedId = null;
      rerender();
    });
  }

  // ─── Bulk: Individual checkboxes (Shift+Click range, Ctrl+Click toggle) ───

  // ─── Group badge click → select entire group ──────────────────────────────
  container.querySelectorAll<HTMLElement>('[data-select-group]').forEach((badge) => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = badge.dataset.selectGroup!;
      const all = store.getAllParticipants();
      const groupIds = all.filter((p) => p.group === group).map((p) => p.id);
      // If all group members are already selected, deselect them; otherwise select all
      const allSelected = groupIds.every((id) => selectedIds.has(id));
      if (allSelected) {
        for (const id of groupIds) selectedIds.delete(id);
      } else {
        for (const id of groupIds) selectedIds.add(id);
      }
      rerender();
    });
  });

  container.querySelectorAll<HTMLInputElement>('.cb-select-participant').forEach((cb) => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = cb.dataset.pid!;
      const visiblePids = Array.from(container.querySelectorAll<HTMLInputElement>('.cb-select-participant')).map(
        (el) => el.dataset.pid!,
      );

      if (e.shiftKey && _lastClickedId) {
        // range-select between _lastClickedId and pid
        const from = visiblePids.indexOf(_lastClickedId);
        const to = visiblePids.indexOf(pid);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          for (let i = lo; i <= hi; i++) selectedIds.add(visiblePids[i]);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedIds.has(pid)) selectedIds.delete(pid);
        else selectedIds.add(pid);
      } else {
        // plain click — toggles the one checkbox
        if (selectedIds.has(pid)) selectedIds.delete(pid);
        else selectedIds.add(pid);
      }
      _lastClickedId = pid;
      rerender();
    });
  });

  // ─── Bulk: Dialog live toggles (allDay) ─────────────────────────────────────
  container.addEventListener('change', (e) => {
    const field = (e.target as HTMLElement).getAttribute('data-field');
    if (field === 'bulk-allday') {
      const checked = (e.target as HTMLInputElement).checked;
      const dialog = (e.target as HTMLElement).closest('.bulk-dialog')!;
      const timeFields = dialog.querySelector('.bulk-time-fields') as HTMLElement;
      if (timeFields) timeFields.classList.toggle('hidden', checked);
    }
  });

  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // ── Participant Set item actions (load/update/rename/duplicate/delete) ──
    const psetButton = target.closest<HTMLElement>('[data-pset-action]');
    const psetAction = psetButton?.dataset.psetAction;
    if (psetAction) {
      const psetId = psetButton?.dataset.psetId;
      if (!psetId) return;
      await _handlePsetItemAction(psetAction, psetId, rerender);
      return;
    }

    const actionButton = target.closest<HTMLElement>('[data-action]');
    const action = actionButton?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'sort-column': {
        const col = actionButton?.dataset.sortCol as typeof sortColumn;
        if (col === sortColumn) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col;
          sortDirection = 'asc';
        }
        rerender();
        break;
      }
      case 'filter-group': {
        filterGroup = actionButton?.dataset.group || '';
        rerender();
        break;
      }
      case 'add-participant': {
        const result = await showParticipantEditor({ mode: 'create' });
        if (result.saved) rerender();
        break;
      }
      case 'edit-participant': {
        const pid = actionButton?.dataset.pid;
        if (!pid) break;
        const result = await showParticipantEditor({ mode: 'edit', participantId: pid });
        // Re-render whether saved or not — unavailability rules may have changed
        // even when the main draft was discarded (rules are committed live).
        rerender();
        void result;
        break;
      }
      case 'remove-participant': {
        const pid = actionButton?.dataset.pid!;
        const p = store.getParticipant(pid);
        if (p) {
          const okRm = await showConfirm(`להסיר את ${p.name}?`, {
            danger: true,
            title: 'הסרת משתתף',
            confirmLabel: 'הסר',
          });
          if (okRm) {
            // Capture row anchor before rerender — the row is about to vanish.
            let farewellAnchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
            const row = container.querySelector(`tr[data-participant-id="${pid}"]`);
            if (row) {
              const r = row.getBoundingClientRect();
              farewellAnchor = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }

            store.removeParticipant(pid);
            showToast(`${p.name} הוסר/ה`, {
              type: 'success',
              duration: 6000,
              action: {
                label: 'בטל',
                callback: () => {
                  store.undo();
                  rerender();
                },
              },
            });
            rerender();
            triggerCharacterFarewell(p.name, farewellAnchor);
          }
        }
        break;
      }
      case 'toggle-details': {
        const row = actionButton?.closest('tr');
        if (row) row.classList.toggle('row-expanded');
        break;
      }
      case 'toggle-all-details': {
        const table = container.querySelector('.table-participants tbody');
        if (!table) break;
        const rows = table.querySelectorAll('tr[data-participant-id]');
        const allExpanded = Array.from(rows).every((r) => r.classList.contains('row-expanded'));
        rows.forEach((r) => r.classList.toggle('row-expanded', !allExpanded));
        if (actionButton) {
          actionButton.textContent = allExpanded ? 'הרחב הכל' : 'כווץ הכל';
        }
        break;
      }
      case 'toggle-blackouts': {
        const pid = actionButton?.closest('[data-pid]')?.getAttribute('data-pid') || actionButton?.dataset.pid;
        if (!pid) break;
        await showParticipantEditor({ mode: 'edit', participantId: pid, scrollTo: 'unavailability' });
        rerender();
        break;
      }

      // ─── Participant Sets panel actions ────────────────────────────────────
      case 'pset-panel-toggle': {
        _setsPanelOpen = !_setsPanelOpen;
        _setsFormMode = 'none';
        _setsFormError = '';
        _setsRenameTargetId = null;
        rerender();
        break;
      }
      case 'pset-panel-close': {
        _setsPanelOpen = false;
        _setsFormMode = 'none';
        _setsFormError = '';
        _setsRenameTargetId = null;
        rerender();
        break;
      }
      case 'pset-import-xlsx': {
        void openXlsxImportFlow(() => rerender());
        break;
      }
      case 'pset-new': {
        _setsFormMode = 'save-as';
        _setsFormError = '';
        rerender();
        break;
      }
      case 'pset-saveas-confirm': {
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="pset-saveas-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="pset-saveas-desc"]');
        const psetName = nameInput?.value.trim() ?? '';
        const psetDesc = descInput?.value.trim() ?? '';
        if (!psetName) {
          _setsFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const result = store.saveCurrentAsParticipantSet(psetName, psetDesc);
        if (!result) {
          _setsFormError = 'סט עם שם זה כבר קיים';
          rerender();
          return;
        }
        _setsFormMode = 'none';
        _setsFormError = '';
        showToast(`סט "${psetName}" נשמר`, { type: 'success' });
        rerender();
        break;
      }
      case 'pset-rename-confirm': {
        const renameId = _setsRenameTargetId ?? store.getActiveParticipantSetId();
        if (!renameId) return;
        const rnInput = container.querySelector<HTMLInputElement>('[data-field="pset-rename-name"]');
        const rdInput = container.querySelector<HTMLInputElement>('[data-field="pset-rename-desc"]');
        const rnName = rnInput?.value.trim() ?? '';
        const rnDesc = rdInput?.value.trim() ?? '';
        if (!rnName) {
          _setsFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const rnErr = store.renameParticipantSet(renameId, rnName, rnDesc);
        if (rnErr) {
          _setsFormError = rnErr;
          rerender();
          return;
        }
        _setsFormMode = 'none';
        _setsFormError = '';
        _setsRenameTargetId = null;
        showToast('הסט עודכן בהצלחה', { type: 'success' });
        rerender();
        break;
      }
      case 'pset-form-cancel': {
        _setsFormMode = 'none';
        _setsFormError = '';
        _setsRenameTargetId = null;
        rerender();
        break;
      }

      // ─── Bulk toolbar & dialog actions ─────────────────────────────────────
      case 'bulk-add-unavailability': {
        _bulkDialogOpen = true;
        rerender();
        break;
      }
      case 'bulk-clear-selection': {
        selectedIds.clear();
        _lastClickedId = null;
        rerender();
        break;
      }
      case 'bulk-delete-participants': {
        _bulkDeleteDialogOpen = true;
        rerender();
        break;
      }
      case 'bulk-delete-dismiss': {
        if (target !== actionButton) break;
        _bulkDeleteDialogOpen = false;
        rerender();
        break;
      }
      case 'bulk-delete-cancel': {
        _bulkDeleteDialogOpen = false;
        rerender();
        break;
      }
      case 'bulk-delete-confirm': {
        const ids = Array.from(selectedIds);
        const deleted = store.removeParticipantsBulk(ids);
        _bulkDeleteDialogOpen = false;
        selectedIds.clear();
        _lastClickedId = null;

        rerender();
        showToast(`${deleted} משתתפים נמחקו בהצלחה.`, {
          type: 'success',
          duration: 6000,
          action: {
            label: 'בטל',
            callback: () => {
              store.undo();
              rerender();
            },
          },
        });
        break;
      }
      case 'bulk-dialog-dismiss': {
        if (target !== actionButton) break;
        _bulkDialogOpen = false;
        rerender();
        break;
      }
      case 'bulk-dialog-cancel': {
        _bulkDialogOpen = false;
        rerender();
        break;
      }
      case 'bulk-dialog-save': {
        const dialog = container.querySelector('.bulk-dialog')!;
        const allDay = (dialog.querySelector('[data-field="bulk-allday"]') as HTMLInputElement).checked;
        const startHour = parseInt(
          (dialog.querySelector('[data-field="bulk-start"]') as HTMLInputElement).value || '0',
        );
        const endHour = parseInt((dialog.querySelector('[data-field="bulk-end"]') as HTMLInputElement).value || '0');
        const reason = (dialog.querySelector('[data-field="bulk-reason"]') as HTMLInputElement).value || undefined;

        const dayStart = parseInt(
          (dialog.querySelector('[data-field="bulk-day-start"]') as HTMLSelectElement).value || '1',
        );
        const dayEndRaw = parseInt(
          (dialog.querySelector('[data-field="bulk-day-end"]') as HTMLSelectElement).value || String(dayStart),
        );
        if (dayEndRaw < dayStart) {
          showToast('יום סיום חייב להיות גדול או שווה ליום ההתחלה.', { type: 'error' });
          break;
        }
        const endDayIndex = dayEndRaw > dayStart ? dayEndRaw : undefined;
        const rule: Omit<import('../models/types').DateUnavailability, 'id'> = {
          dayIndex: dayStart,
          ...(endDayIndex !== undefined ? { endDayIndex } : {}),
          allDay,
          startHour: allDay ? 0 : startHour,
          endHour: allDay ? 24 : endHour,
          reason,
        };

        const count = store.addDateUnavailabilityBulk(Array.from(selectedIds), rule);
        _bulkDialogOpen = false;
        selectedIds.clear();
        _lastClickedId = null;

        rerender();
        showToast(`חוסר זמינות נוסף עבור ${count} משתתפים.`, { type: 'success' });
        break;
      }
    }
  });
}

// ─── Participant Set Item Actions ────────────────────────────────────────────

async function _handlePsetItemAction(action: string, id: string, rerender: () => void): Promise<void> {
  switch (action) {
    case 'load': {
      const ok = await showConfirm('טעינת הסט תחליף את רשימת המשתתפים הנוכחית. להמשיך?', {
        danger: true,
        title: 'טעינת סט משתתפים',
        confirmLabel: 'טען',
      });
      if (!ok) return;
      store.loadParticipantSet(id);
      showToast('סט נטען בהצלחה', { type: 'success' });
      rerender();
      break;
    }
    case 'update': {
      const ok = await showConfirm('לעדכן את הסט לפי רשימת המשתתפים הנוכחית?', {
        title: 'עדכון סט',
        confirmLabel: 'עדכן',
      });
      if (!ok) return;
      store.updateParticipantSet(id);
      showToast('הסט עודכן', { type: 'success' });
      rerender();
      break;
    }
    case 'rename': {
      _setsRenameTargetId = id;
      _setsFormMode = 'rename';
      _setsFormError = '';
      rerender();
      break;
    }
    case 'duplicate': {
      store.duplicateParticipantSet(id);
      showToast('הסט שוכפל', { type: 'success' });
      rerender();
      break;
    }
    case 'export': {
      const pset = store.getParticipantSetById(id);
      if (!pset) return;
      openParticipantSetFormatSheet(id, pset.name);
      break;
    }
    case 'delete': {
      const pset = store.getParticipantSetById(id);
      if (!pset || pset.builtIn) return;
      const ok = await showConfirm(`למחוק את הסט "${pset.name}"? לא ניתן לבטל פעולה זו.`, {
        danger: true,
        title: 'מחיקת סט',
        confirmLabel: 'מחק',
      });
      if (!ok) return;
      store.deleteParticipantSet(id);
      _setsFormMode = 'none';
      _setsFormError = '';
      _setsRenameTargetId = null;
      showToast('הסט נמחק', {
        type: 'success',
        duration: 6000,
        action: {
          label: 'בטל',
          callback: () => {
            store.undo();
            rerender();
          },
        },
      });
      rerender();
      break;
    }
  }
}
