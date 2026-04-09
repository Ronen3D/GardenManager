/**
 * Participants Tab — Stage 0 Configuration UI
 *
 * CRUD table for managing participants, with inline editing,
 * group filtering, and blackout period management.
 */

import { checkTemplateEligibility, type TemplateEligibilityResult } from '../engine/validator';
import {
  type CertificationDefinition,
  type DateUnavailability,
  Level,
  type PakalDefinition,
  type Participant,
} from '../models/types';
import { fmtTime, HEBREW_DAYS } from '../utils/date-utils';
import * as store from './config-store';
import { getEffectivePakalIds, renderPakalBadges } from './pakal-utils';
import { certBadges, escHtml, groupBadge, groupColor, levelBadge, SVG_ICONS } from './ui-helpers';
import { showConfirm, showSaveConfirm, showToast } from './ui-modal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
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

function getNotWithNamesForEdit(pid: string): string {
  const ids = store.getNotWithIds(pid);
  return ids
    .map((id) => {
      const p = store.getParticipant(id);
      return p ? p.name : '';
    })
    .filter(Boolean)
    .join(', ');
}

function renderNotWithBadges(pid: string): string {
  const ids = store.getNotWithIds(pid);
  if (ids.length === 0) return '<span class="text-muted">—</span>';
  return ids
    .map((id) => {
      const p = store.getParticipant(id);
      return p ? `<span class="badge badge-sm" style="background:#e74c3c">${escHtml(p.name)}</span>` : '';
    })
    .filter(Boolean)
    .join(' ');
}

/** Compact inline summary of unavailability rules for mobile cards. */
function formatUnavailSummary(rules: DateUnavailability[]): string {
  return rules
    .map((r) => {
      const day = HEBREW_DAYS[r.dayOfWeek];
      const time = r.allDay
        ? 'כל היום'
        : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00–${String(r.endHour).padStart(2, '0')}:00</span>`;
      return `<small>${day} ${time}</small>`;
    })
    .join('<br>');
}

/** Get distinct task template names for preference dropdowns. */
function getTaskNameOptions(): string[] {
  return [...new Set(store.getAllTaskTemplates().map((t) => t.name))];
}

function renderPakalCheckboxes(
  definitions: PakalDefinition[],
  explicitIds: string[],
  _certifications: string[],
  attrName: string,
): string {
  const effectiveIds = new Set(
    getEffectivePakalIds(
      {
        id: '',
        name: '',
        level: Level.L0,
        certifications: _certifications,
        group: '',
        availability: [],
        dateUnavailability: [],
        pakalIds: explicitIds,
      },
      definitions,
    ),
  );

  return `<div class="pakal-checkboxes">
    ${definitions
      .map((def) => {
        const checked = effectiveIds.has(def.id);
        return `<label class="checkbox-label" title="${escHtml(def.label)}">
        <input type="checkbox" ${attrName}="${def.id}" ${checked ? 'checked' : ''} /> ${escHtml(def.label)}
      </label>`;
      })
      .join('')}
  </div>`;
}

function collectPakalIds(scope: ParentNode, selector: string): string[] {
  const ids: string[] = [];
  scope.querySelectorAll<HTMLInputElement>(selector).forEach((cb) => {
    const pakalId = cb.getAttribute(selector.includes('new-pakal') ? 'data-new-pakal' : 'data-pakal');
    if (!pakalId || !cb.checked) return;
    ids.push(pakalId);
  });
  return ids;
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

function renderTaskNameSelect(fieldName: string, value?: string): string {
  const options = getTaskNameOptions();
  return `<select class="input-sm" data-field="${fieldName}">
    <option value="">— ללא —</option>
    ${options.map((name) => `<option value="${name}" ${value === name ? 'selected' : ''}>${name}</option>`).join('')}
  </select>
  <div class="pref-eligibility-warning hidden" data-warning-for="${fieldName}">
    <span class="warn-icon">⚠</span>
    <span class="warn-text"></span>
  </div>`;
}

// ─── Preference Eligibility Warning Helpers ─────────────────────────────────

/** Read participant level + certs from an edit row or add form. */
function readParticipantFromForm(row: Element, isAddForm: boolean): { level: Level; certifications: string[] } {
  const levelField = isAddForm ? 'new-level' : 'level';
  const levelSel = row.querySelector(`[data-field="${levelField}"]`) as HTMLSelectElement | null;
  const level = parseInt(levelSel?.value || '0') as Level;
  const certAttr = isAddForm ? 'data-new-cert' : 'data-cert';
  const certs: string[] = [];
  row.querySelectorAll<HTMLInputElement>(`[${certAttr}]`).forEach((cb) => {
    if (cb.checked) {
      const val = isAddForm ? cb.dataset.newCert : cb.dataset.cert;
      if (val) certs.push(val);
    }
  });
  return { level, certifications: certs };
}

/** Show/hide the eligibility warning for a preference select. */
function updatePrefWarning(
  container: Element,
  fieldName: string,
  taskName: string,
  level: Level,
  certs: string[],
): void {
  const warningEl = container.querySelector(`[data-warning-for="${fieldName}"]`) as HTMLElement | null;
  if (!warningEl) return;
  const textEl = warningEl.querySelector('.warn-text') as HTMLElement;

  if (!taskName) {
    warningEl.classList.add('hidden');
    return;
  }

  const templates = store.getAllTaskTemplates().filter((t) => t.name === taskName);
  if (templates.length === 0) {
    warningEl.classList.add('hidden');
    return;
  }

  // Eligible if ANY template with this name has a fillable slot
  let bestResult: TemplateEligibilityResult = { eligible: false, reasons: [] };
  for (const tpl of templates) {
    const result = checkTemplateEligibility(level, certs, tpl, store.getCertLabel);
    if (result.eligible) {
      bestResult = result;
      break;
    }
    if (bestResult.reasons.length === 0) bestResult = result;
  }

  if (bestResult.eligible) {
    warningEl.classList.add('hidden');
  } else {
    textEl.textContent = bestResult.reasons.join(' | ');
    warningEl.classList.remove('hidden');
  }
}

/** Trigger eligibility warning for both preference selects in a row/form. */
function recheckAllPrefWarnings(container: Element, isAddForm: boolean): void {
  const { level, certifications } = readParticipantFromForm(container, isAddForm);
  const prefField = isAddForm ? 'new-preferredTask' : 'preferredTask';
  const lessField = isAddForm ? 'new-lessPreferredTask' : 'lessPreferredTask';
  const prefVal = (container.querySelector(`[data-field="${prefField}"]`) as HTMLSelectElement | null)?.value || '';
  const lessVal = (container.querySelector(`[data-field="${lessField}"]`) as HTMLSelectElement | null)?.value || '';
  updatePrefWarning(container, prefField, prefVal, level, certifications);
  updatePrefWarning(container, lessField, lessVal, level, certifications);
}

// ─── Group Name Validation ───────────────────────────────────────────────────

const FORBIDDEN_GROUP_PATTERNS = [
  /^new\s*group$/i,
  /^group\s*\w$/i, // "Group A", "Group X", "Group 1"
  /^untitled/i,
  /^default/i,
];

interface GroupValidation {
  valid: boolean;
  error: string;
}

function setAriaInvalid(field: HTMLElement | null, invalid: boolean): void {
  if (!field) return;
  if (invalid) {
    field.setAttribute('aria-invalid', 'true');
    return;
  }
  field.removeAttribute('aria-invalid');
}

function syncGroupValidationState(
  newGroupInput: HTMLInputElement | null,
  errorSpan: HTMLElement | null,
  result: GroupValidation,
): void {
  setAriaInvalid(newGroupInput, !result.valid);
  if (!errorSpan) return;
  errorSpan.textContent = result.error;
  errorSpan.classList.toggle('hidden', result.valid);
}

function validateGroupName(raw: string, existingGroups: string[]): GroupValidation {
  const name = raw.trim();
  if (!name) return { valid: false, error: 'קבוצה לא יכולה להיות ריקה.' };
  if (name.length < 2) return { valid: false, error: 'שם קבוצה חייב להכיל לפחות 2 תווים.' };
  for (const pat of FORBIDDEN_GROUP_PATTERNS) {
    if (pat.test(name)) return { valid: false, error: `"${name}" אינו מותר כשם קבוצה.` };
  }
  // Check for near-duplicates (case-insensitive)
  const lower = name.toLowerCase();
  const dup = existingGroups.find((g) => g.toLowerCase() === lower && g !== name);
  if (dup) return { valid: false, error: `קבוצה דומה "${dup}" כבר קיימת. השתמש בה.` };
  return { valid: true, error: '' };
}

/** Resolve a group select + optional new-group input into a validated group name. Returns null on failure. */
function resolveGroupInput(
  groupValue: string,
  newGroupInput: HTMLInputElement | null,
  errorSpan: HTMLElement | null,
): string | null {
  if (groupValue !== '__new__') {
    syncGroupValidationState(newGroupInput, errorSpan, { valid: true, error: '' });
    return groupValue;
  }
  const raw = newGroupInput?.value ?? '';
  const result = validateGroupName(raw, store.getGroups());
  if (!result.valid) {
    syncGroupValidationState(newGroupInput, errorSpan, result);
    newGroupInput?.focus();
    return null;
  }
  syncGroupValidationState(newGroupInput, errorSpan, result);
  // Normalize: if exact match exists already, use it
  const existing = store.getGroups().find((g) => g.toLowerCase() === raw.trim().toLowerCase());
  return existing ?? raw.trim();
}

// ─── State ───────────────────────────────────────────────────────────────────

let editingId: string | null = null;
let expandedBlackoutId: string | null = null;
let filterGroup: string = '';
let sortColumn: 'name' | 'group' | 'level' | '' = '';
let sortDirection: 'asc' | 'desc' = 'asc';
let showNotWithColumn = false;

// ─── Multi-Select State ──────────────────────────────────────────────────────

const selectedIds: Set<string> = new Set();
/** Tracks the last-clicked participant ID for Shift+Click range selection */
let _lastClickedId: string | null = null;
/** When true the bulk unavailability dialog is open */
let _bulkDialogOpen = false;
/** When true the bulk delete confirmation dialog is open */
let _bulkDeleteDialogOpen = false;

/** Check whether the editing form has unsaved changes compared to the stored participant. */
function hasEditingChanges(row: Element, pid: string): boolean {
  const p = store.getParticipant(pid);
  if (!p) return false;

  const name = (row.querySelector('[data-field="name"]') as HTMLInputElement)?.value.trim() || '';
  if (name !== p.name) return true;

  const group = (row.querySelector('[data-field="group"]') as HTMLSelectElement)?.value || '';
  if (group === '__new__') {
    const newGroupVal = (row.querySelector('[data-field="new-group-name"]') as HTMLInputElement)?.value.trim() || '';
    if (newGroupVal) return true;
  } else if (group !== p.group) {
    return true;
  }

  const level = parseInt((row.querySelector('[data-field="level"]') as HTMLSelectElement)?.value || '0') as Level;
  if (level !== p.level) return true;

  const certs: string[] = [];
  row.querySelectorAll<HTMLInputElement>('[data-cert]').forEach((cb) => {
    if (cb.checked && cb.dataset.cert) certs.push(cb.dataset.cert);
  });
  const origCerts = [...p.certifications].sort();
  const newCerts = [...certs].sort();
  if (origCerts.length !== newCerts.length || origCerts.some((c, i) => c !== newCerts[i])) return true;

  const pakalIds = collectPakalIds(row, '[data-pakal]');
  const origPakals = [...(p.pakalIds || [])].sort();
  const newPakals = [...pakalIds].sort();
  if (origPakals.length !== newPakals.length || origPakals.some((c, i) => c !== newPakals[i])) return true;

  if (showNotWithColumn) {
    const notWithRaw = (row.querySelector('[data-field="notWith"]') as HTMLInputElement)?.value || '';
    const origNotWith = store
      .getNotWithIds(pid)
      .map((id) => {
        const partner = store.getParticipant(id);
        return partner ? partner.name : '';
      })
      .filter(Boolean)
      .sort()
      .join(', ');
    const newNotWith = notWithRaw
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .sort()
      .join(', ');
    if (origNotWith !== newNotWith) return true;
  }

  const prefVal = (row.querySelector('[data-field="preferredTask"]') as HTMLSelectElement)?.value || '';
  if (prefVal !== (p.preferredTaskName || '')) return true;

  const lessPrefVal = (row.querySelector('[data-field="lessPreferredTask"]') as HTMLSelectElement)?.value || '';
  if (lessPrefVal !== (p.lessPreferredTaskName || '')) return true;

  return false;
}

/** Flag to prevent re-entrant outside-click handling. */
let _outsideClickBusy = false;

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
  selectedIds.clear();
  _lastClickedId = null;
  _bulkDialogOpen = false;
  _bulkDeleteDialogOpen = false;
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
    <button class="btn-xs btn-outline" data-action="pset-panel-close" title="סגור">✕</button>
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
      <button class="btn-primary btn-sm" data-action="add-participant">+ הוסף משתתף</button>
    </div>
  </div>`;

  // Participant Sets panel
  if (_setsPanelOpen) {
    html += renderSetsPanel();
  }
  // Table
  html += `<div class="table-responsive"><table class="table table-participants${showNotWithColumn ? ' notwith-visible' : ''}">
    <thead><tr>
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="בחר הכל" ${visibleSelectedCount > 0 && visibleSelectedCount === sorted.length ? 'checked' : ''} /></th>
      <th class="col-index">#</th>
      <th class="col-name sortable-th" data-action="sort-column" data-sort-col="name">שם${sortIndicator('name')}</th>
      <th class="col-group sortable-th" data-action="sort-column" data-sort-col="group">קבוצה${sortIndicator('group')}</th>
      <th class="col-level sortable-th" data-action="sort-column" data-sort-col="level">דרגה${sortIndicator('level')}</th>
      <th class="col-certs">הסמכות</th>
      <th class="col-pakals">פק"לים</th>
      ${showNotWithColumn ? '<th class="col-notwith">אי התאמה</th>' : ''}
      <th class="col-prefs">העדפות</th>
      <th class="col-avail">זמינות</th><th class="col-unavail">אי-זמינות</th><th class="col-actions">פעולות</th><th class="col-expand"></th>
    </tr></thead><tbody>`;

  sorted.forEach((p, i) => {
    const isEditing = editingId === p.id;
    const dateRules = store.getDateUnavailabilities(p.id);
    const isExpanded = expandedBlackoutId === p.id;
    const totalRules = dateRules.length;
    const isSelected = selectedIds.has(p.id);
    const allPakalDefs = store.getAllPakalDefinitionsIncludeDeleted();

    if (isEditing) {
      html += renderEditRow(p, i + 1);
    } else {
      html += `<tr data-participant-id="${p.id}" class="${isSelected ? 'row-selected' : ''}">
        <td class="col-select"><input type="checkbox" class="cb-select-participant" data-pid="${p.id}" ${isSelected ? 'checked' : ''} /></td>
        <td class="col-index">${i + 1}</td>
        <td class="col-name" title="${escHtml(p.name)}">${hasOrphanedRefs(p) ? '<span class="badge-orphan-icon">⚠</span> ' : ''}<strong>${escHtml(p.name)}</strong></td>
        <td class="col-group">${groupBadge(p.group, true)}</td>
        <td class="col-level">${levelBadge(p.level)}</td>
        <td class="col-certs">${certBadges(p.certifications)}</td>
        <td class="col-pakals">${renderPakalBadges(p, allPakalDefs)}</td>
        ${showNotWithColumn ? `<td class="col-notwith notwith-cell">${renderNotWithBadges(p.id)}</td>` : ''}
        <td class="col-prefs">${renderPreferenceBadges(p)}</td>
        <td class="col-avail avail-cell">
          <span class="mobile-label">זמינות: </span>${p.availability.map((w) => `<small dir="ltr">${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
        </td>
        <td class="col-unavail unavail-cell${totalRules === 0 ? ' unavail-empty' : ''}">
          <button class="btn-sm btn-outline btn-icon" data-action="toggle-blackouts" data-pid="${p.id}" title="ניהול אי-זמינות">
            ${totalRules > 0 ? `<span class="badge badge-sm" style="background:var(--warning)">${totalRules}</span>` : SVG_ICONS.block}
          </button>
          ${totalRules > 0 ? `<span class="unavail-summary"><span class="mobile-label">חסר: </span>${formatUnavailSummary(dateRules)}</span>` : ''}
        </td>
        <td class="col-actions">
          <button class="btn-sm btn-outline btn-icon" data-action="edit-participant" data-pid="${p.id}" title="עריכה">${SVG_ICONS.edit}</button>
          <button class="btn-sm btn-outline btn-danger-outline btn-icon" data-action="remove-participant" data-pid="${p.id}" title="הסרה">${SVG_ICONS.trash}</button>
        </td>
        <td class="col-expand"><button class="btn-expand-details" data-action="toggle-details" data-pid="${p.id}" title="פרטים">${SVG_ICONS.chevronDown}</button></td>
      </tr>`;

      // Blackout expansion row
      if (isExpanded) {
        html += renderBlackoutRow(p.id);
      }
    }
  });

  html += '</tbody></table></div>';

  // Add participant form (inline at bottom when triggered)
  html += renderAddForm(groups);

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

function renderEditRow(p: Participant, idx: number): string {
  const groups = store.getGroups();
  const pakalDefs = store.getPakalDefinitions();
  return `<tr class="row-editing" data-participant-id="${p.id}">
    <td class="col-select"></td>
    <td class="col-index">${idx}</td>
    <td class="col-name"><input class="input-sm" type="text" data-field="name" value="${escHtml(p.name)}" /></td>
    <td class="col-group">
      <select class="input-sm" data-field="group" data-group-select>
        ${groups.map((g) => `<option value="${escHtml(g)}" ${p.group === g ? 'selected' : ''}>${escHtml(g)}</option>`).join('')}
        <option value="__new__">+ קבוצה חדשה…</option>
      </select>
      <input class="input-sm hidden" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" style="margin-top:4px" />
      <span class="group-error hidden" style="color:var(--danger); font-size:0.75rem;"></span>
    </td>
    <td class="col-level">
      <label style="font-size:0.75rem;margin:0">דרגה
      <select class="input-sm" data-field="level">
        ${LEVEL_OPTIONS.map((l) => `<option value="${l}" ${p.level === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    </td>
    <td class="col-certs">
      <div class="cert-checkboxes">
        ${getCertOptions()
          .map(
            (def) =>
              `<label class="checkbox-label">
            <input type="checkbox" data-cert="${def.id}" ${p.certifications.includes(def.id) ? 'checked' : ''} /> ${escHtml(def.label)}
          </label>`,
          )
          .join('')}
        ${(() => {
          const activeIds = new Set(getCertOptions().map((d) => d.id));
          return p.certifications
            .filter((c) => !activeIds.has(c))
            .map((c) => {
              const tomb = store.getCertificationById(c);
              const label = tomb ? tomb.label : c;
              return `<label class="checkbox-label badge-orphan-label">
              <input type="checkbox" data-cert="${c}" checked /> ⚠ ${escHtml(label)}
            </label>`;
            })
            .join('');
        })()}
      </div>
    </td>
    <td class="col-pakals">
      ${renderPakalCheckboxes(pakalDefs, p.pakalIds || [], p.certifications, 'data-pakal')}
      ${(() => {
        const activeIds = new Set(pakalDefs.map((d) => d.id));
        return (p.pakalIds || [])
          .filter((id) => !activeIds.has(id))
          .map((id) => {
            const tomb = store.getPakalById(id);
            const label = tomb ? tomb.label : id;
            return `<label class="checkbox-label badge-orphan-label">
            <input type="checkbox" data-pakal="${id}" checked /> ⚠ ${escHtml(label)}
          </label>`;
          })
          .join('');
      })()}
    </td>
    ${
      showNotWithColumn
        ? `<td class="col-notwith">
      <input class="input-sm" type="text" data-field="notWith" value="${getNotWithNamesForEdit(p.id)}" placeholder="הקלד שמות, מופרדים בפסיקים" title="שמות משתתפים מופרדים בפסיק" />
    </td>`
        : ''
    }
    <td class="col-prefs">
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.75rem;margin:0">משימה מועדפת</label>
        ${renderTaskNameSelect('preferredTask', p.preferredTaskName)}
        <label style="font-size:0.75rem;margin:0">עדיף שלא</label>
        ${renderTaskNameSelect('lessPreferredTask', p.lessPreferredTaskName)}
      </div>
    </td>
    <td class="col-avail avail-cell">
      <span class="mobile-label">זמינות: </span>${p.availability.map((w) => `<small dir="ltr">${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
    </td>
    <td class="col-unavail unavail-cell">
      ${renderInlineUnavailEditor(p.id)}
    </td>
    <td class="col-actions">
      <button class="btn-sm btn-primary" data-action="save-participant" data-pid="${p.id}">שמור</button>
      <button class="btn-sm btn-outline" data-action="cancel-edit">ביטול</button>
    </td>
    <td class="col-expand"></td>
  </tr>`;
}

function renderInlineUnavailEditor(pid: string): string {
  const dateRules = store.getDateUnavailabilities(pid);
  let html = '<div class="inline-unavail-editor">';

  if (dateRules.length > 0) {
    html += '<ul class="inline-unavail-list">';
    for (const r of dateRules) {
      const label = HEBREW_DAYS[r.dayOfWeek];
      const timeLabel = r.allDay
        ? 'כל היום'
        : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00–${String(r.endHour).padStart(2, '0')}:00</span>`;
      html += `<li>${label} ${timeLabel}${r.reason ? ` (${r.reason})` : ''} <button class="btn-inline-remove" data-action="remove-date-unavail" data-pid="${pid}" data-rid="${r.id}">✕</button></li>`;
    }
    html += '</ul>';
  }

  html += `<div class="inline-unavail-add">
    <select class="input-sm" data-field="du-dow" style="width:auto">
      ${HEBREW_DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
    </select>
    <label class="checkbox-label" style="white-space:nowrap">
      <input type="checkbox" data-field="du-allday" /> כל היום
    </label>
    <span class="time-label">משעה</span>
    <input type="text" class="input-sm time-24h" maxlength="5" placeholder="HH:mm" data-field="bo-start" value="08:00" style="width:60px" />
    <span class="time-label">עד שעה</span>
    <input type="text" class="input-sm time-24h" maxlength="5" placeholder="HH:mm" data-field="bo-end" value="12:00" style="width:60px" />
    <input type="text" class="input-sm" data-field="bo-reason" placeholder="סיבה" style="width:80px" />
    <button class="btn-sm btn-primary" data-action="add-unified-constraint" data-pid="${pid}">+</button>
  </div>`;

  html += '</div>';
  return html;
}

function renderBlackoutRow(pid: string): string {
  const dateRules = store.getDateUnavailabilities(pid);

  let html = `<tr class="row-blackout-expansion">
    <td colspan="${showNotWithColumn ? 13 : 12}">
      <div class="blackout-panel">
        <h4>כללי אי-זמינות</h4>
        <div class="blackout-list">`;

  if (dateRules.length === 0) {
    html += '<p class="text-muted">אין כללי אי-זמינות מוגדרים.</p>';
  } else {
    html += '<ul>';
    for (const r of dateRules) {
      const label = `כל ${HEBREW_DAYS[r.dayOfWeek]}`;
      const timeLabel = r.allDay
        ? 'כל היום'
        : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00</span>`;
      html += `<li>
        <span class="constraint-type">יום קבוע</span>
        <strong>${label}</strong> — <span>${timeLabel}</span>
        ${r.reason ? `<span class="text-muted"> (${r.reason})</span>` : ''}
        <button class="btn-sm btn-danger-outline" data-action="remove-date-unavail" data-pid="${pid}" data-rid="${r.id}">✕</button>
      </li>`;
    }
    html += '</ul>';
  }

  html += `</div>
    <h4 style="margin-top:16px">הוסף כלל אי-זמינות</h4>
    <div class="blackout-add unified-constraint-form">
      <select class="input-sm" data-field="du-dow" style="width:120px;">
        ${HEBREW_DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
      </select>

      <div class="time-inputs-group">
        <label class="checkbox-label" style="white-space:nowrap;" data-field="du-allday-wrapper">
          <input type="checkbox" data-field="du-allday" /> כל היום
        </label>
        <span class="time-label">משעה</span>
        <input type="text" class="input-sm time-24h" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="bo-start" value="08:00" />
        <span class="time-label">עד שעה</span>
        <input type="text" class="input-sm time-24h" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="bo-end" value="12:00" />
      </div>
      
      <input type="text" class="input-sm" data-field="bo-reason" placeholder="סיבה (אופציונלי)" />
      <button class="btn-sm btn-primary" data-action="add-unified-constraint" data-pid="${pid}">הוסף</button>
      <span class="du-validation-error" class="hidden" style="color:#e74c3c;font-size:0.85em;margin-inline-start:6px"></span>
    </div>
  </div></td></tr>`;
  return html;
}

function renderAddForm(groups: string[]): string {
  const pakalDefs = store.getPakalDefinitions();
  return `
  <div id="add-participant-form" class="add-form hidden">
    <h4>הוסף משתתף</h4>
    <div class="form-row">
      <label>שם <input class="input-sm" type="text" data-field="new-name" placeholder="שם" /></label>
      <label>קבוצה
        <select class="input-sm" data-field="new-group" data-group-select>
          ${groups.map((g) => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join('')}
          <option value="__new__">+ קבוצה חדשה…</option>
        </select>
        <input class="input-sm hidden" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" style="margin-top:4px" />
        <span class="group-error hidden" style="color:var(--danger); font-size:0.75rem;"></span>
      </label>
      <label>דרגה
        <select class="input-sm" data-field="new-level">
          ${LEVEL_OPTIONS.map((l) => `<option value="${l}" ${l === Level.L0 ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="form-row">
      <span>הסמכות:</span>
      ${getCertOptions()
        .map(
          (def, i) =>
            `<label class="checkbox-label">
          <input type="checkbox" data-new-cert="${def.id}" ${i === 0 ? 'checked' : ''} /> ${escHtml(def.label)}
        </label>`,
        )
        .join('')}
    </div>
    <div class="form-row form-row-pakalim">
      <span>פק"לים:</span>
      <div>
        ${renderPakalCheckboxes(pakalDefs, [], [getCertOptions()[0]?.id].filter(Boolean), 'data-new-pakal')}
      </div>
    </div>
    <div class="form-row">
      <label>מעדיף ${renderTaskNameSelect('new-preferredTask')}</label>
      <label>פחות מועדף ${renderTaskNameSelect('new-lessPreferredTask')}</label>
    </div>
    <div class="form-row">
      <button class="btn-primary btn-sm" data-action="confirm-add-participant">הוסף</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-participant">ביטול</button>
    </div>
  </div>`;
}

// ─── Bulk Unavailability Dialog ──────────────────────────────────────────────

function renderBulkUnavailDialog(): string {
  return `<div class="bulk-dialog-backdrop" data-action="bulk-dialog-dismiss">
    <div class="bulk-dialog">
      <h3>הוסף חוסר זמינות עבור ${selectedIds.size} משתתפים</h3>

      <div class="bulk-dialog-body">
        <div class="form-row">
          <label>יום
            <select class="input-sm" data-field="bulk-dow">
              ${HEBREW_DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
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
  // ─── Preference eligibility warnings: show on edit open if prefs already set ─
  container.querySelectorAll<HTMLElement>('tr.row-editing').forEach((row) => {
    recheckAllPrefWarnings(row, false);
  });
  const addForm = container.querySelector('#add-participant-form') as HTMLElement | null;
  if (addForm && !addForm.classList.contains('hidden')) {
    recheckAllPrefWarnings(addForm, true);
  }

  // ─── Preference eligibility warnings: react to select / level / cert changes ─
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    const field = target.getAttribute('data-field') || '';

    // Preference select changed → update just that warning
    if (['preferredTask', 'lessPreferredTask', 'new-preferredTask', 'new-lessPreferredTask'].includes(field)) {
      const isAdd = field.startsWith('new-');
      const scope = isAdd ? target.closest('#add-participant-form') : target.closest('tr.row-editing');
      if (!scope) return;
      const { level, certifications } = readParticipantFromForm(scope, isAdd);
      updatePrefWarning(scope, field, (target as HTMLSelectElement).value, level, certifications);
      return;
    }

    // Level changed → recheck both preference warnings in the same row/form
    if (field === 'level' || field === 'new-level') {
      const isAdd = field === 'new-level';
      const scope = isAdd ? target.closest('#add-participant-form') : target.closest('tr.row-editing');
      if (scope) recheckAllPrefWarnings(scope, isAdd);
      return;
    }

    // Certification checkbox changed → recheck both preference warnings
    if (target.hasAttribute('data-cert') || target.hasAttribute('data-new-cert')) {
      const isAdd = target.hasAttribute('data-new-cert');
      const scope = isAdd ? target.closest('#add-participant-form') : target.closest('tr.row-editing');
      if (scope) recheckAllPrefWarnings(scope, isAdd);
    }
  });

  // ─── Outside-click: close editing panel (with save confirmation if dirty) ──
  if (editingId) {
    const editRow = container.querySelector('tr.row-editing') as HTMLElement | null;
    if (editRow) {
      const onOutsideClick = async (e: MouseEvent) => {
        // Ignore if already handling an outside click, or if a modal is open
        if (_outsideClickBusy) return;
        if (document.querySelector('.gm-modal-backdrop')) return;

        const target = e.target as HTMLElement;
        // Click inside the editing row — do nothing
        if (editRow.contains(target)) return;

        e.preventDefault();
        e.stopPropagation();

        const pid = editingId;
        if (!pid) return;

        if (!hasEditingChanges(editRow, pid)) {
          // No changes — close immediately
          document.removeEventListener('click', onOutsideClick, true);
          editingId = null;
          rerender();
          return;
        }

        // Has unsaved changes — show 3-button confirmation
        _outsideClickBusy = true;
        try {
          const result = await showSaveConfirm();
          document.removeEventListener('click', onOutsideClick, true);
          if (result === 'save') {
            // Trigger the save button click
            const saveBtn = editRow.querySelector('[data-action="save-participant"]') as HTMLElement | null;
            if (saveBtn) saveBtn.click();
          } else if (result === 'discard') {
            editingId = null;
            rerender();
          }
          // 'continue' → do nothing, keep panel open (re-attach listener)
          if (result === 'continue') {
            document.addEventListener('click', onOutsideClick, true);
          }
        } finally {
          _outsideClickBusy = false;
        }
      };
      // Use capture phase so we intercept before other click handlers
      document.addEventListener('click', onOutsideClick, true);
    }
  }

  // ─── Easter egg: triple-tap on count badge toggles "אי התאמה" column ──
  const countBadge = container.querySelector('.tab-toolbar h2 .count') as HTMLElement | null;
  if (countBadge) {
    let tapCount = 0;
    let tapTimer: ReturnType<typeof setTimeout> | undefined;
    countBadge.addEventListener('click', () => {
      tapCount++;
      clearTimeout(tapTimer);
      if (tapCount >= 3) {
        tapCount = 0;
        showNotWithColumn = !showNotWithColumn;
        rerender();
      } else {
        tapTimer = setTimeout(() => {
          tapCount = 0;
        }, 600);
      }
    });
  }

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

  // ─── Group select change handlers (show/hide + validate new-group input) ──
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-group-select')) return;
    const select = target as HTMLSelectElement;
    const parent = select.parentElement!;
    const newGroupInput = parent.querySelector('[data-field="new-group-name"]') as HTMLInputElement | null;
    const errorSpan = parent.querySelector('.group-error') as HTMLElement | null;
    if (select.value === '__new__') {
      if (newGroupInput) {
        newGroupInput.classList.remove('hidden');
        newGroupInput.value = '';
        setAriaInvalid(newGroupInput, false);
        newGroupInput.focus();
      }
    } else {
      if (newGroupInput) {
        newGroupInput.classList.add('hidden');
        newGroupInput.value = '';
      }
      syncGroupValidationState(newGroupInput, errorSpan, { valid: true, error: '' });
    }
  });

  // Recurring-rule controls
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    // Handle "All Day" checkbox toggle
    if ((target as HTMLInputElement).dataset?.field === 'du-allday') {
      const cb = target as HTMLInputElement;
      const panel = cb.closest('.blackout-panel') || cb.closest('.inline-unavail-add');
      if (!panel) return;
      const startInp = panel.querySelector('[data-field="bo-start"]') as HTMLInputElement;
      const endInp = panel.querySelector('[data-field="bo-end"]') as HTMLInputElement;
      const timeLabels = panel.querySelectorAll('.time-label');

      if (cb.checked) {
        if (startInp) startInp.classList.add('hidden');
        if (endInp) endInp.classList.add('hidden');
        timeLabels.forEach((el) => el.classList.add('hidden'));
      } else {
        if (startInp) startInp.classList.remove('hidden');
        if (endInp) endInp.classList.remove('hidden');
        timeLabels.forEach((el) => el.classList.remove('hidden'));
      }
    }
  });

  // Live validation as user types a new group name
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field !== 'new-group-name') return;
    const parent = target.closest('td, label')!;
    const errorSpan = parent.querySelector('.group-error') as HTMLElement | null;
    const raw = target.value;
    if (!raw.trim()) {
      syncGroupValidationState(target, errorSpan, { valid: true, error: '' });
      return;
    }
    const result = validateGroupName(raw, store.getGroups());
    syncGroupValidationState(target, errorSpan, result);
  });

  // Live validation for "not with" input — red-highlight invalid names
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field !== 'notWith') return;
    const row = target.closest('tr')!;
    const pid = row.dataset.participantId || '';
    const allParticipants = store.getAllParticipants();
    const validNames = new Set(allParticipants.filter((p) => p.id !== pid).map((p) => p.name));
    const names = target.value.split(',').map((n) => n.trim());
    const hasInvalid = names.some((n) => n !== '' && !validNames.has(n));
    setAriaInvalid(target, hasInvalid);
    target.style.color = hasInvalid ? 'var(--error, #e74c3c)' : '';
    target.title = hasInvalid ? 'שמות לא תקינים יסומנו באדום ויתעלמו בשמירה' : 'שמות משתתפים מופרדים בפסיק';
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
        const form = container.querySelector('#add-participant-form') as HTMLElement;
        if (form) {
          const wasHidden = form.classList.contains('hidden');
          form.classList.toggle('hidden', !wasHidden);
          if (wasHidden) {
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const nameInput = form.querySelector('[data-field="new-name"]') as HTMLInputElement | null;
            nameInput?.focus({ preventScroll: true });
          }
        }
        break;
      }
      case 'confirm-add-participant': {
        const nameEl = container.querySelector('[data-field="new-name"]') as HTMLInputElement;
        const groupEl = container.querySelector('[data-field="new-group"]') as HTMLSelectElement;
        const levelEl = container.querySelector('[data-field="new-level"]') as HTMLSelectElement;
        const name = nameEl?.value.trim();
        if (!name) {
          nameEl?.focus();
          return;
        }
        if (store.isParticipantNameTaken(name)) {
          showToast('משתתף/ת בשם זה כבר קיים/ת', { type: 'error' });
          nameEl?.focus();
          nameEl?.select();
          return;
        }

        const formEl = container.querySelector('#add-participant-form')!;
        const newGroupInput = formEl.querySelector('[data-field="new-group-name"]') as HTMLInputElement | null;
        const errorSpan = formEl.querySelector('.group-error') as HTMLElement | null;

        const group = resolveGroupInput(groupEl?.value || '', newGroupInput, errorSpan);
        if (group === null) return; // validation failed — error is shown inline

        const level = parseInt(levelEl?.value || '0') as Level;
        const certs: string[] = [];
        container.querySelectorAll<HTMLInputElement>('[data-new-cert]').forEach((cb) => {
          if (cb.checked && cb.dataset.newCert) certs.push(cb.dataset.newCert);
        });
        const pakalIds = collectPakalIds(container, '[data-new-pakal]');

        const newPref = (container.querySelector('[data-field="new-preferredTask"]') as HTMLSelectElement)?.value || '';
        const newLess =
          (container.querySelector('[data-field="new-lessPreferredTask"]') as HTMLSelectElement)?.value || '';
        if (newPref && newLess && newPref === newLess) {
          showToast('משימה מועדפת ומשימה פחות מועדפת לא יכולות להיות זהות', { type: 'error' });
          return;
        }

        const newP = store.addParticipant({ name, level, certifications: certs, pakalIds, group });
        if (newPref || newLess) {
          store.setTaskNamePreference(newP.id, newPref || undefined, newLess || undefined);
        }
        rerender();
        showToast(`${name} נוסף/ה`, { type: 'success' });
        break;
      }
      case 'cancel-add-participant': {
        const form = container.querySelector('#add-participant-form') as HTMLElement;
        if (form) form.classList.add('hidden');
        break;
      }
      case 'edit-participant': {
        editingId = actionButton?.dataset.pid || null;
        rerender();
        break;
      }
      case 'save-participant': {
        const pid = actionButton?.dataset.pid!;
        const row = container.querySelector(`tr[data-participant-id="${pid}"]`)!;
        const nameEl = row.querySelector('[data-field="name"]') as HTMLInputElement;
        const name = nameEl?.value.trim();
        if (!name) {
          nameEl?.focus();
          return;
        }
        if (store.isParticipantNameTaken(name, pid)) {
          showToast('משתתף/ת בשם זה כבר קיים/ת', { type: 'error' });
          nameEl?.focus();
          nameEl?.select();
          return;
        }
        const groupSel = row.querySelector('[data-field="group"]') as HTMLSelectElement;
        const newGroupInput = row.querySelector('[data-field="new-group-name"]') as HTMLInputElement | null;
        const errorSpan = row.querySelector('.group-error') as HTMLElement | null;

        const group = resolveGroupInput(groupSel?.value || '', newGroupInput, errorSpan);
        if (group === null) return; // validation failed

        const level = parseInt((row.querySelector('[data-field="level"]') as HTMLSelectElement)?.value || '0') as Level;
        const certs: string[] = [];
        row.querySelectorAll<HTMLInputElement>('[data-cert]').forEach((cb) => {
          if (cb.checked && cb.dataset.cert) certs.push(cb.dataset.cert);
        });
        // Orphan certs (deleted definitions) are rendered as checkboxes in the edit row,
        // so they are already included in certs[] if the user kept them checked.
        const pakalIds = collectPakalIds(row, '[data-pakal]');

        store.updateParticipant(pid, { name, group, level, certifications: certs, pakalIds });

        // Process "not with" input — only when column is visible
        if (showNotWithColumn) {
          const notWithRaw = (row.querySelector('[data-field="notWith"]') as HTMLInputElement)?.value || '';
          const notWithNames = notWithRaw
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          const allParticipants = store.getAllParticipants();
          const nameToId = new Map<string, string>();
          for (const ap of allParticipants) {
            if (ap.id !== pid) nameToId.set(ap.name, ap.id);
          }
          // Determine desired set of partner IDs
          const desiredIds = new Set<string>();
          for (const n of notWithNames) {
            const id = nameToId.get(n);
            if (id) desiredIds.add(id);
          }
          // Sync: remove pairs no longer listed, add new ones
          const currentIds = new Set(store.getNotWithIds(pid));
          for (const id of currentIds) {
            if (!desiredIds.has(id)) store.removeNotWith(pid, id);
          }
          for (const id of desiredIds) {
            if (!currentIds.has(id)) store.addNotWith(pid, id);
          }
        }

        // Process task preferences
        const prefSelect = row.querySelector('[data-field="preferredTask"]') as HTMLSelectElement | null;
        const lessSelect = row.querySelector('[data-field="lessPreferredTask"]') as HTMLSelectElement | null;
        const preferred = prefSelect?.value || undefined;
        const lessPreferred = lessSelect?.value || undefined;
        if (preferred && lessPreferred && preferred === lessPreferred) {
          showToast('משימה מועדפת ומשימה פחות מועדפת לא יכולות להיות זהות', { type: 'error' });
          return;
        }
        store.setTaskNamePreference(pid, preferred, lessPreferred);

        editingId = null;
        rerender();
        break;
      }
      case 'cancel-edit': {
        editingId = null;
        rerender();
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
            store.removeParticipant(pid);
            showToast(`${p.name} הוסר/ה`, { type: 'success' });
            rerender();
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
        const pid = actionButton?.closest('[data-pid]')?.getAttribute('data-pid') || actionButton?.dataset.pid!;
        expandedBlackoutId = expandedBlackoutId === pid ? null : pid;
        rerender();
        break;
      }
      case 'add-unified-constraint': {
        const pid = actionButton?.dataset.pid!;
        const panel = (actionButton?.closest('.blackout-panel') || actionButton?.closest('.inline-unavail-editor'))!;
        const reason = (panel.querySelector('[data-field="bo-reason"]') as HTMLInputElement)?.value || undefined;
        const errEl = panel.querySelector('.du-validation-error') as HTMLElement;
        if (errEl) errEl.classList.add('hidden');

        const allDay = (panel.querySelector('[data-field="du-allday"]') as HTMLInputElement)?.checked ?? false;
        const startStr = (panel.querySelector('[data-field="bo-start"]') as HTMLInputElement)?.value || '00:00';
        const endStr = (panel.querySelector('[data-field="bo-end"]') as HTMLInputElement)?.value || '00:00';
        const startHour = parseInt(startStr.split(':')[0]);
        const endHour = parseInt(endStr.split(':')[0]);

        if (!allDay && startHour === endHour) {
          if (errEl) {
            errEl.textContent = 'שעת התחלה ושעת סיום לא יכולות להיות זהות. השתמש ב"כל היום".';
            errEl.classList.remove('hidden');
          }
          return;
        }

        const dow = parseInt((panel.querySelector('[data-field="du-dow"]') as HTMLSelectElement)?.value || '0');
        store.addDateUnavailability(pid, { dayOfWeek: dow, allDay, startHour, endHour, reason });
        rerender();
        break;
      }
      case 'remove-date-unavail': {
        const pid = target.dataset.pid!;
        const rid = target.dataset.rid!;
        store.removeDateUnavailability(pid, rid);
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
      case 'bulk-delete-dismiss':
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
        showToast(`${deleted} משתתפים נמחקו בהצלחה.`, { type: 'success' });
        break;
      }
      case 'bulk-dialog-dismiss':
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

        const rule: Omit<import('../models/types').DateUnavailability, 'id'> = {
          dayOfWeek: parseInt((dialog.querySelector('[data-field="bulk-dow"]') as HTMLSelectElement).value),
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
      showToast('הסט נמחק', { type: 'success' });
      rerender();
      break;
    }
  }
}
