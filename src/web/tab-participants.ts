/**
 * Participants Tab — Stage 0 Configuration UI
 *
 * CRUD table for managing participants, with inline editing,
 * group filtering, and blackout period management.
 */

import {
  Level,
  Certification,
  PakalDefinition,
  TaskType,
  Participant,
} from '../models/types';
import * as store from './config-store';
import { showConfirm, showToast } from './ui-modal';
import { levelBadge, certBadges, groupBadge, groupColor, CERT_LABELS, TASK_TYPE_LABELS, SVG_ICONS, escHtml } from './ui-helpers';
import { HORESH_PAKAL_ID, getEffectivePakalIds, renderPakalBadges } from './pakal-utils';
import { HEBREW_DAYS } from '../utils/date-utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala, Certification.Horesh];

function getNotWithNamesForEdit(pid: string): string {
  const ids = store.getNotWithIds(pid);
  return ids.map(id => {
    const p = store.getParticipant(id);
    return p ? p.name : '';
  }).filter(Boolean).join(', ');
}

function renderNotWithBadges(pid: string): string {
  const ids = store.getNotWithIds(pid);
  if (ids.length === 0) return '<span class="text-muted">—</span>';
  return ids.map(id => {
    const p = store.getParticipant(id);
    return p ? `<span class="badge badge-sm" style="background:#e74c3c">${escHtml(p.name)}</span>` : '';
  }).filter(Boolean).join(' ');
}

const TASK_TYPE_OPTIONS = Object.values(TaskType) as TaskType[];

function renderPakalCheckboxes(
  definitions: PakalDefinition[],
  explicitIds: string[],
  certifications: Certification[],
  attrName: string,
): string {
  const effectiveIds = new Set(getEffectivePakalIds({
    id: '',
    name: '',
    level: Level.L0,
    certifications,
    group: '',
    availability: [],
    dateUnavailability: [],
    pakalIds: explicitIds,
  }, definitions));
  const explicitSet = new Set(explicitIds);
  const horeshAuto = certifications.includes(Certification.Horesh);

  return `<div class="pakal-checkboxes">
    ${definitions.map(def => {
      const autoManaged = horeshAuto && def.id === HORESH_PAKAL_ID;
      const checked = effectiveIds.has(def.id);
      return `<label class="checkbox-label${autoManaged ? ' pakal-auto' : ''}" title="${autoManaged ? 'נוסף אוטומטית כשיש הסמכת חורש' : escHtml(def.label)}">
        <input type="checkbox" ${attrName}="${def.id}" ${checked ? 'checked' : ''}${autoManaged ? ' disabled data-auto-managed="1"' : ''} data-manual-checked="${explicitSet.has(def.id) ? '1' : '0'}" /> ${escHtml(def.label)}${autoManaged ? ' <span class="text-muted">(אוטומטי)</span>' : ''}
      </label>`;
    }).join('')}
  </div>`;
}

function syncAutoHoreshPakal(scope: ParentNode, certSelector: string, pakalSelector: string): void {
  const horeshCert = scope.querySelector<HTMLInputElement>(certSelector);
  const horeshPakal = scope.querySelector<HTMLInputElement>(pakalSelector);
  if (!horeshCert || !horeshPakal) return;

  const label = horeshPakal.closest('label');
  if (horeshCert.checked) {
    horeshPakal.dataset.manualChecked = horeshPakal.dataset.manualChecked || (horeshPakal.checked ? '1' : '0');
    horeshPakal.checked = true;
    horeshPakal.disabled = true;
    horeshPakal.dataset.autoManaged = '1';
    label?.classList.add('pakal-auto');
  } else {
    horeshPakal.disabled = false;
    horeshPakal.checked = horeshPakal.dataset.manualChecked === '1';
    delete horeshPakal.dataset.autoManaged;
    label?.classList.remove('pakal-auto');
  }
}

function collectPakalIds(scope: ParentNode, selector: string): string[] {
  const ids: string[] = [];
  scope.querySelectorAll<HTMLInputElement>(selector).forEach(cb => {
    const pakalId = cb.getAttribute(selector.includes('new-pakal') ? 'data-new-pakal' : 'data-pakal');
    if (!pakalId || !cb.checked) return;
    if (cb.dataset.autoManaged === '1' && cb.dataset.manualChecked !== '1') return;
    ids.push(pakalId);
  });
  return ids;
}

function renderPakalManager(): string {
  const definitions = store.getPakalDefinitions();
  return `<div class="preset-panel pakal-panel">
    <div class="preset-panel-header">
      <h3>🎒 פק"לים <span class="count">${definitions.length}</span></h3>
      <button class="btn-xs btn-outline" data-action="pakal-panel-close" title="סגור">✕</button>
    </div>
    <div class="pakal-panel-note text-muted">הערך חורש נוסף אוטומטית למשתתף שיש לו הסמכת חורש.</div>
    <div class="pakal-inline-form">
      <input type="text" class="input-sm pakal-name-input" data-field="pakal-new-label" maxlength="40" placeholder="פק"ל מותאם אישית" />
      <button class="btn-sm btn-primary" data-action="pakal-add">הוסף</button>
    </div>
    ${_pakalError ? `<div class="preset-validation-error">${escHtml(_pakalError)}</div>` : ''}
    <div class="pakal-list">
      ${definitions.map(def => {
        const usageCount = store.getPakalUsageCount(def.id);
        const editing = _pakalEditingId === def.id;
        return `<div class="pakal-item">
          <div class="pakal-item-main">
            ${editing
              ? `<input type="text" class="input-sm pakal-edit-input" data-field="pakal-edit-label" data-pakal-id="${def.id}" value="${escHtml(def.label)}" maxlength="40" />`
              : `<span class="pakal-item-label">${escHtml(def.label)}</span>`}
            <span class="pset-count-badge">${usageCount} בשימוש</span>
            ${def.builtIn ? '<span class="preset-builtin-badge">מובנה</span>' : ''}
          </div>
          <div class="pakal-item-actions">
            ${!def.builtIn && !editing ? `<button class="btn-xs btn-outline" data-action="pakal-edit" data-pakal-id="${def.id}" title="ערוך">✎</button>` : ''}
            ${!def.builtIn && editing ? `<button class="btn-xs btn-primary" data-action="pakal-save" data-pakal-id="${def.id}" title="שמור">שמור</button>` : ''}
            ${!def.builtIn && editing ? `<button class="btn-xs btn-outline" data-action="pakal-cancel" title="ביטול">ביטול</button>` : ''}
            ${!def.builtIn && !editing ? `<button class="btn-xs btn-danger-outline" data-action="pakal-delete" data-pakal-id="${def.id}" title="מחק">✕</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderPreferenceBadges(p: Participant): string {
  const parts: string[] = [];
  if (p.preferredTaskType) {
    parts.push(`<span class="badge badge-sm" style="background:#27ae60">מעדיף: ${TASK_TYPE_LABELS[p.preferredTaskType] || p.preferredTaskType}</span>`);
  }
  if (p.lessPreferredTaskType) {
    parts.push(`<span class="badge badge-sm" style="background:#e67e22">פחות: ${TASK_TYPE_LABELS[p.lessPreferredTaskType] || p.lessPreferredTaskType}</span>`);
  }
  return parts.length > 0 ? parts.join(' ') : '<span class="text-muted">—</span>';
}

function renderTaskTypeSelect(fieldName: string, value?: TaskType): string {
  return `<select class="input-sm" data-field="${fieldName}">
    <option value="">— ללא —</option>
    ${TASK_TYPE_OPTIONS.map(t =>
      `<option value="${t}" ${value === t ? 'selected' : ''}>${TASK_TYPE_LABELS[t] || t}</option>`
    ).join('')}
  </select>`;
}

// ─── Group Name Validation ───────────────────────────────────────────────────

const FORBIDDEN_GROUP_PATTERNS = [
  /^new\s*group$/i,
  /^group\s*\w$/i,       // "Group A", "Group X", "Group 1"
  /^untitled/i,
  /^default/i,
];

interface GroupValidation { valid: boolean; error: string }

function validateGroupName(raw: string, existingGroups: string[]): GroupValidation {
  const name = raw.trim();
  if (!name) return { valid: false, error: 'קבוצה לא יכולה להיות ריקה.' };
  if (name.length < 2) return { valid: false, error: 'שם קבוצה חייב להכיל לפחות 2 תווים.' };
  for (const pat of FORBIDDEN_GROUP_PATTERNS) {
    if (pat.test(name)) return { valid: false, error: `"${name}" אינו מותר כשם קבוצה.` };
  }
  // Check for near-duplicates (case-insensitive)
  const lower = name.toLowerCase();
  const dup = existingGroups.find(g => g.toLowerCase() === lower && g !== name);
  if (dup) return { valid: false, error: `קבוצה דומה "${dup}" כבר קיימת. השתמש בה.` };
  return { valid: true, error: '' };
}

/** Resolve a group select + optional new-group input into a validated group name. Returns null on failure. */
function resolveGroupInput(
  groupValue: string,
  newGroupInput: HTMLInputElement | null,
  errorSpan: HTMLElement | null,
): string | null {
  if (groupValue !== '__new__') return groupValue;
  const raw = newGroupInput?.value ?? '';
  const result = validateGroupName(raw, store.getGroups());
  if (!result.valid) {
    if (errorSpan) { errorSpan.textContent = result.error; errorSpan.classList.remove('hidden'); }
    newGroupInput?.focus();
    return null;
  }
  if (errorSpan) errorSpan.classList.add('hidden');
  // Normalize: if exact match exists already, use it
  const existing = store.getGroups().find(g => g.toLowerCase() === raw.trim().toLowerCase());
  return existing ?? raw.trim();
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
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

// ─── Participant Sets Panel State ────────────────────────────────────────────

let _setsPanelOpen = false;
let _setsFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _setsFormError = '';
let _setsRenameTargetId: string | null = null;
let _pakalPanelOpen = false;
let _pakalEditingId: string | null = null;
let _pakalError = '';

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
      case 'name': return dir * a.name.localeCompare(b.name);
      case 'group': return dir * a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
      case 'level': return dir * (a.level - b.level) || a.name.localeCompare(b.name);
      default: return 0;
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
        <button class="btn btn-sm btn-primary" data-action="pset-saveas-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="pset-form-cancel">ביטול</button>
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
        <button class="btn btn-sm btn-primary" data-action="pset-rename-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="pset-form-cancel">ביטול</button>
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
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-pset-action="delete" data-pset-id="${s.id}" title="מחק">✕</button>` : ''}
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
  const filtered = filterGroup
    ? allParticipants.filter(p => p.group === filterGroup)
    : allParticipants;
  const sorted = sortParticipants(filtered);

  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>משתתפים <span class="count">${allParticipants.length}</span></h2>
      <div class="filter-pills">
        <button class="pill ${filterGroup === '' ? 'pill-active' : ''}" data-action="filter-group" data-group="">הכל</button>
        ${groups.map(g =>
          `<button class="pill ${filterGroup === g ? 'pill-active' : ''}" data-action="filter-group" data-group="${g}">${g}</button>`
        ).join('')}
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-sm btn-outline${_setsPanelOpen ? ' pill-active' : ''}" data-action="pset-panel-toggle" title="סטים של משתתפים">📋 סטים${store.isParticipantSetDirty() ? ' <span class="dirty-dot"></span>' : ''}</button>
      <button class="btn-sm btn-outline${_pakalPanelOpen ? ' pill-active' : ''}" data-action="pakal-panel-toggle" title="ניהול פק"לים">🎒 פק"לים</button>
      <button class="btn-primary btn-sm" data-action="add-participant">+ הוסף משתתף</button>
    </div>
  </div>`;

  // Participant Sets panel
  if (_setsPanelOpen) {
    html += renderSetsPanel();
  }
  if (_pakalPanelOpen) {
    html += renderPakalManager();
  }

  // Table
  html += `<div class="table-responsive"><table class="table table-participants${showNotWithColumn ? ' notwith-visible' : ''}">
    <thead><tr>
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="בחר הכל" ${selectedIds.size > 0 && selectedIds.size === sorted.length ? 'checked' : ''} /></th>
      <th>#</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="name">שם${sortIndicator('name')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="group">קבוצה${sortIndicator('group')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="level">דרגה${sortIndicator('level')}</th>
      <th>הסמכות</th>
      <th>פק"לים</th>
      ${showNotWithColumn ? '<th>אי התאמה</th>' : ''}
      <th>העדפות</th>
      <th>זמינות</th><th>אי-זמינות</th><th class="col-actions">פעולות</th>
    </tr></thead><tbody>`;

  sorted.forEach((p, i) => {
    const isEditing = editingId === p.id;
    const dateRules = store.getDateUnavailabilities(p.id);
    const isExpanded = expandedBlackoutId === p.id;
    const totalRules = dateRules.length;
    const isSelected = selectedIds.has(p.id);
    const pakalDefs = store.getPakalDefinitions();

    if (isEditing) {
      html += renderEditRow(p, i + 1);
    } else {
      html += `<tr data-participant-id="${p.id}" class="${isSelected ? 'row-selected' : ''}">
        <td class="col-select"><input type="checkbox" class="cb-select-participant" data-pid="${p.id}" ${isSelected ? 'checked' : ''} /></td>
        <td>${i + 1}</td>
        <td title="${p.name}"><strong>${p.name}</strong></td>
        <td>${groupBadge(p.group, true)}</td>
        <td>${levelBadge(p.level)}</td>
        <td>${certBadges(p.certifications)}</td>
        <td>${renderPakalBadges(p, pakalDefs)}</td>
        ${showNotWithColumn ? `<td class="notwith-cell">${renderNotWithBadges(p.id)}</td>` : ''}
        <td>${renderPreferenceBadges(p)}</td>
        <td class="avail-cell">
          ${p.availability.map(w => `<small dir="ltr">${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
        </td>
        <td>
          <button class="btn-sm btn-outline btn-icon" data-action="toggle-blackouts" data-pid="${p.id}" title="ניהול אי-זמינות">
            ${totalRules > 0 ? `<span class="badge badge-sm" style="background:var(--warning)">${totalRules}</span>` : SVG_ICONS.block}
          </button>
        </td>
        <td class="col-actions">
          <button class="btn-sm btn-outline btn-icon" data-action="edit-participant" data-pid="${p.id}" title="עריכה">${SVG_ICONS.edit}</button>
          <button class="btn-sm btn-outline btn-danger-outline btn-icon" data-action="remove-participant" data-pid="${p.id}" title="הסרה">${SVG_ICONS.trash}</button>
        </td>
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
      <button class="btn-primary btn-sm" data-action="bulk-add-unavailability">${SVG_ICONS.calendar} הוסף חוסר זמינות</button>
      <button class="btn-danger btn-sm" data-action="bulk-delete-participants">${SVG_ICONS.trash} מחק משתתפים</button>
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
    <td>${idx}</td>
    <td><input class="input-sm" type="text" data-field="name" value="${p.name}" /></td>
    <td>
      <select class="input-sm" data-field="group" data-group-select>
        ${groups.map(g => `<option value="${g}" ${p.group === g ? 'selected' : ''}>${g}</option>`).join('')}
        <option value="__new__">+ קבוצה חדשה…</option>
      </select>
      <input class="input-sm" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" class="hidden" style="margin-top:4px" />
      <span class="group-error" class="hidden" style="color:var(--error); font-size:0.75rem;"></span>
    </td>
    <td>
      <select class="input-sm" data-field="level">
        ${LEVEL_OPTIONS.map(l => `<option value="${l}" ${p.level === l ? 'selected' : ''}>L${l}</option>`).join('')}
      </select>
    </td>
    <td>
      <div class="cert-checkboxes">
        ${CERT_OPTIONS.map(c =>
          `<label class="checkbox-label">
            <input type="checkbox" data-cert="${c}" ${p.certifications.includes(c) ? 'checked' : ''} /> ${CERT_LABELS[c] || c}
          </label>`
        ).join('')}
      </div>
    </td>
    <td>
      ${renderPakalCheckboxes(pakalDefs, p.pakalIds || [], p.certifications, 'data-pakal')}
    </td>
    ${showNotWithColumn ? `<td>
      <input class="input-sm" type="text" data-field="notWith" value="${getNotWithNamesForEdit(p.id)}" placeholder="הקלד שמות, מופרדים בפסיקים" title="שמות משתתפים מופרדים בפסיק" />
    </td>` : ''}
    <td>
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:0.75rem;margin:0">משימה מועדפת</label>
        ${renderTaskTypeSelect('preferredTask', p.preferredTaskType)}
        <label style="font-size:0.75rem;margin:0">עדיף שלא</label>
        ${renderTaskTypeSelect('lessPreferredTask', p.lessPreferredTaskType)}
      </div>
    </td>
    <td colspan="2"></td>
    <td class="col-actions">
      <button class="btn-sm btn-primary" data-action="save-participant" data-pid="${p.id}">שמור</button>
      <button class="btn-sm btn-outline" data-action="cancel-edit">ביטול</button>
    </td>
  </tr>`;
}



function renderBlackoutRow(pid: string): string {
  const dateRules = store.getDateUnavailabilities(pid);

  let html = `<tr class="row-blackout-expansion">
    <td colspan="${showNotWithColumn ? 12 : 11}">
      <div class="blackout-panel">
        <h4>כללי אי-זמינות</h4>
        <div class="blackout-list">`;

  if (dateRules.length === 0) {
    html += '<p class="text-muted">אין כללי אי-זמינות מוגדרים.</p>';
  } else {
    html += '<ul>';
    for (const r of dateRules) {
      const label = `כל ${HEBREW_DAYS[r.dayOfWeek]}`;
      const timeLabel = r.allDay ? 'כל היום' : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00</span>`;
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
        <input type="text" class="input-sm time-24h" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="bo-start" value="08:00" />
        <span class="time-separator">עד</span>
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
          ${groups.map(g => `<option value="${g}">${g}</option>`).join('')}
          <option value="__new__">+ קבוצה חדשה…</option>
        </select>
        <input class="input-sm" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" class="hidden" style="margin-top:4px" />
        <span class="group-error" class="hidden" style="color:var(--error); font-size:0.75rem;"></span>
      </label>
      <label>דרגה
        <select class="input-sm" data-field="new-level">
          ${LEVEL_OPTIONS.map(l => `<option value="${l}" ${l === Level.L0 ? 'selected' : ''}>L${l}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="form-row">
      <span>הסמכות:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label">
          <input type="checkbox" data-new-cert="${c}" ${c === Certification.Nitzan ? 'checked' : ''} /> ${CERT_LABELS[c] || c}
        </label>`
      ).join('')}
    </div>
    <div class="form-row form-row-pakalim">
      <span>פק"לים:</span>
      <div>
        ${renderPakalCheckboxes(pakalDefs, [], [Certification.Nitzan], 'data-new-pakal')}
        <small class="text-muted">חורש נוסף אוטומטית כשמסמנים הסמכת חורש.</small>
      </div>
    </div>
    <div class="form-row">
      <label>מעדיף ${renderTaskTypeSelect('new-preferredTask')}</label>
      <label>פחות מועדף ${renderTaskTypeSelect('new-lessPreferredTask')}</label>
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
        <button class="btn-sm btn-outline" data-action="bulk-delete-cancel">ביטול</button>
        <button class="btn-danger btn-sm" data-action="bulk-delete-confirm">אישור מחיקה</button>
      </div>
    </div>
  </div>`;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireParticipantsEvents(container: HTMLElement, rerender: () => void): void {
  container.querySelectorAll<HTMLElement>('tr.row-editing, #add-participant-form').forEach(scope => {
    syncAutoHoreshPakal(scope, '[data-cert="Horesh"], [data-new-cert="Horesh"]', '[data-pakal="pakal-horesh"], [data-new-pakal="pakal-horesh"]');
  });

  // ─── Easter egg: triple-click on count badge toggles "אי התאמה" column ──
  const countBadge = container.querySelector('.tab-toolbar h2 .count') as HTMLElement | null;
  if (countBadge) {
    countBadge.addEventListener('click', (e) => {
      if (e.detail === 3) {
        showNotWithColumn = !showNotWithColumn;
        rerender();
      }
    });
  }

  // ─── Bulk: Select-All checkbox ─────────────────────────────────────────────
  const selectAllCb = container.querySelector('#cb-select-all') as HTMLInputElement | null;
  if (selectAllCb) {
    selectAllCb.addEventListener('change', () => {
      const cbs = container.querySelectorAll<HTMLInputElement>('.cb-select-participant');
      if (selectAllCb.checked) {
        cbs.forEach(cb => selectedIds.add(cb.dataset.pid!));
      } else {
        selectedIds.clear();
      }
      _lastClickedId = null;
      rerender();
    });
  }

  // ─── Bulk: Individual checkboxes (Shift+Click range, Ctrl+Click toggle) ───

  // ─── Group badge click → select entire group ──────────────────────────────
  container.querySelectorAll<HTMLElement>('[data-select-group]').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = badge.dataset.selectGroup!;
      const all = store.getAllParticipants();
      const groupIds = all.filter(p => p.group === group).map(p => p.id);
      // If all group members are already selected, deselect them; otherwise select all
      const allSelected = groupIds.every(id => selectedIds.has(id));
      if (allSelected) {
        for (const id of groupIds) selectedIds.delete(id);
      } else {
        for (const id of groupIds) selectedIds.add(id);
      }
      rerender();
    });
  });

  container.querySelectorAll<HTMLInputElement>('.cb-select-participant').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const pid = cb.dataset.pid!;
      const visiblePids = Array.from(
        container.querySelectorAll<HTMLInputElement>('.cb-select-participant'),
      ).map(el => el.dataset.pid!);

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

    const changeTarget = e.target as HTMLInputElement;
    if (changeTarget.matches('[data-cert="Horesh"], [data-new-cert="Horesh"]')) {
      const scope = changeTarget.closest('tr.row-editing, #add-participant-form');
      if (scope) {
        syncAutoHoreshPakal(scope, '[data-cert="Horesh"], [data-new-cert="Horesh"]', '[data-pakal="pakal-horesh"], [data-new-pakal="pakal-horesh"]');
      }
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
      if (newGroupInput) { newGroupInput.classList.remove('hidden'); newGroupInput.value = ''; newGroupInput.focus(); }
    } else {
      if (newGroupInput) { newGroupInput.classList.add('hidden'); newGroupInput.value = ''; }
      if (errorSpan) errorSpan.classList.add('hidden');
    }
  });

  // Recurring-rule controls
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    // Handle "All Day" checkbox toggle
    if ((target as HTMLInputElement).dataset?.field === 'du-allday') {
      const cb = target as HTMLInputElement;
      const panel = cb.closest('.blackout-panel')!;
      const startInp = panel.querySelector('[data-field="bo-start"]') as HTMLInputElement;
      const endInp = panel.querySelector('[data-field="bo-end"]') as HTMLInputElement;
      const separator = panel.querySelector('.time-separator') as HTMLElement;
      
      if (cb.checked) {
        if (startInp) startInp.classList.add('hidden');
        if (endInp) endInp.classList.add('hidden');
        if (separator) separator.classList.add('hidden');
      } else {
        if (startInp) startInp.classList.remove('hidden');
        if (endInp) endInp.classList.remove('hidden');
        if (separator) separator.classList.remove('hidden');
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
      if (errorSpan) errorSpan.classList.add('hidden');
      return;
    }
    const result = validateGroupName(raw, store.getGroups());
    if (errorSpan) {
      errorSpan.textContent = result.valid ? '' : result.error;
      errorSpan.classList.toggle('hidden', result.valid);
    }
  });

  // Live validation for "not with" input — red-highlight invalid names
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field !== 'notWith') return;
    const row = target.closest('tr')!;
    const pid = row.dataset.participantId || '';
    const allParticipants = store.getAllParticipants();
    const validNames = new Set(allParticipants.filter(p => p.id !== pid).map(p => p.name));
    const names = target.value.split(',').map(n => n.trim());
    const hasInvalid = names.some(n => n !== '' && !validNames.has(n));
    target.style.color = hasInvalid ? 'var(--error, #e74c3c)' : '';
    target.title = hasInvalid ? 'שמות לא תקינים יסומנו באדום ויתעלמו בשמירה' : 'שמות משתתפים מופרדים בפסיק';
  });

  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // ── Participant Set item actions (load/update/rename/duplicate/delete) ──
    const psetAction = target.dataset.psetAction;
    if (psetAction) {
      const psetId = target.dataset.psetId;
      if (!psetId) return;
      await _handlePsetItemAction(psetAction, psetId, rerender);
      return;
    }

    const action = target.dataset.action;
    if (!action) return;

    switch (action) {
      case 'sort-column': {
        const col = target.dataset.sortCol as typeof sortColumn;
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
        filterGroup = target.dataset.group || '';
        rerender();
        break;
      }
      case 'pakal-panel-toggle': {
        _pakalPanelOpen = !_pakalPanelOpen;
        _pakalEditingId = null;
        _pakalError = '';
        rerender();
        break;
      }
      case 'pakal-panel-close': {
        _pakalPanelOpen = false;
        _pakalEditingId = null;
        _pakalError = '';
        rerender();
        break;
      }
      case 'pakal-add': {
        const labelInput = container.querySelector<HTMLInputElement>('[data-field="pakal-new-label"]');
        const result = store.addCustomPakal(labelInput?.value || '');
        if (result.error) {
          _pakalError = result.error;
          rerender();
          return;
        }
        _pakalError = '';
        _pakalEditingId = null;
        showToast('פק"ל נוסף', { type: 'success' });
        rerender();
        break;
      }
      case 'pakal-edit': {
        _pakalEditingId = target.dataset.pakalId || null;
        _pakalError = '';
        rerender();
        break;
      }
      case 'pakal-cancel': {
        _pakalEditingId = null;
        _pakalError = '';
        rerender();
        break;
      }
      case 'pakal-save': {
        const pakalId = target.dataset.pakalId || '';
        const input = container.querySelector<HTMLInputElement>(`[data-field="pakal-edit-label"][data-pakal-id="${pakalId}"]`);
        const error = store.renameCustomPakal(pakalId, input?.value || '');
        if (error) {
          _pakalError = error;
          rerender();
          return;
        }
        _pakalEditingId = null;
        _pakalError = '';
        showToast('פק"ל עודכן', { type: 'success' });
        rerender();
        break;
      }
      case 'pakal-delete': {
        const pakalId = target.dataset.pakalId || '';
        const pakal = store.getPakalDefinitions().find(def => def.id === pakalId);
        if (!pakal) return;
        const confirmed = await showConfirm(`למחוק את הפק"ל "${pakal.label}"?`, { danger: true, title: 'מחיקת פק"ל', confirmLabel: 'מחק' });
        if (!confirmed) return;
        const error = store.removeCustomPakal(pakalId);
        if (error) {
          _pakalError = error;
          rerender();
          return;
        }
        _pakalError = '';
        showToast('פק"ל נמחק', { type: 'success' });
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
        if (!name) { nameEl?.focus(); return; }

        const formEl = container.querySelector('#add-participant-form')!;
        const newGroupInput = formEl.querySelector('[data-field="new-group-name"]') as HTMLInputElement | null;
        const errorSpan = formEl.querySelector('.group-error') as HTMLElement | null;

        const group = resolveGroupInput(groupEl?.value || '', newGroupInput, errorSpan);
        if (group === null) return; // validation failed — error is shown inline

        const level = parseInt(levelEl?.value || '0') as Level;
        const certs: Certification[] = [];
        container.querySelectorAll<HTMLInputElement>('[data-new-cert]').forEach(cb => {
          if (cb.checked) certs.push(cb.dataset.newCert as Certification);
        });
        const pakalIds = collectPakalIds(container, '[data-new-pakal]');

        const newPref = (container.querySelector('[data-field="new-preferredTask"]') as HTMLSelectElement)?.value || '';
        const newLess = (container.querySelector('[data-field="new-lessPreferredTask"]') as HTMLSelectElement)?.value || '';
        if (newPref && newLess && newPref === newLess) {
          showToast('סוג מועדף וסוג פחות מועדף לא יכולים להיות זהים', { type: 'error' });
          return;
        }

        const newP = store.addParticipant({ name, level, certifications: certs, pakalIds, group });
        if (newPref || newLess) {
          store.setTaskPreference(
            newP.id,
            newPref ? (newPref as TaskType) : undefined,
            newLess ? (newLess as TaskType) : undefined,
          );
        }
        rerender();
        break;
      }
      case 'cancel-add-participant': {
        const form = container.querySelector('#add-participant-form') as HTMLElement;
        if (form) form.classList.add('hidden');
        break;
      }
      case 'edit-participant': {
        editingId = target.dataset.pid || null;
        rerender();
        break;
      }
      case 'save-participant': {
        const pid = target.dataset.pid!;
        const row = container.querySelector(`tr[data-participant-id="${pid}"]`)!;
        const name = (row.querySelector('[data-field="name"]') as HTMLInputElement)?.value.trim();
        const groupSel = row.querySelector('[data-field="group"]') as HTMLSelectElement;
        const newGroupInput = row.querySelector('[data-field="new-group-name"]') as HTMLInputElement | null;
        const errorSpan = row.querySelector('.group-error') as HTMLElement | null;

        const group = resolveGroupInput(groupSel?.value || '', newGroupInput, errorSpan);
        if (group === null) return; // validation failed

        const level = parseInt((row.querySelector('[data-field="level"]') as HTMLSelectElement)?.value || '0') as Level;
        const certs: Certification[] = [];
        row.querySelectorAll<HTMLInputElement>('[data-cert]').forEach(cb => {
          if (cb.checked) certs.push(cb.dataset.cert as Certification);
        });
        const pakalIds = collectPakalIds(row, '[data-pakal]');

        store.updateParticipant(pid, { name, group, level, certifications: certs, pakalIds });

        // Process "not with" input — only when column is visible
        if (showNotWithColumn) {
          const notWithRaw = (row.querySelector('[data-field="notWith"]') as HTMLInputElement)?.value || '';
          const notWithNames = notWithRaw.split(',').map(n => n.trim()).filter(Boolean);
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
        const preferred = prefSelect?.value ? (prefSelect.value as TaskType) : undefined;
        const lessPreferred = lessSelect?.value ? (lessSelect.value as TaskType) : undefined;
        if (preferred && lessPreferred && preferred === lessPreferred) {
          showToast('סוג מועדף וסוג פחות מועדף לא יכולים להיות זהים', { type: 'error' });
          return;
        }
        store.setTaskPreference(pid, preferred, lessPreferred);

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
        const pid = target.dataset.pid!;
        const p = store.getParticipant(pid);
        if (p) {
          const okRm = await showConfirm(`להסיר את ${p.name}?`, { danger: true, title: 'הסרת משתתף', confirmLabel: 'הסר' });
          if (okRm) {
            store.removeParticipant(pid);
            showToast(`${p.name} הוסר/ה`, { type: 'success' });
            rerender();
          }
        }
        break;
      }
      case 'toggle-blackouts': {
        const pid = target.closest('[data-pid]')?.getAttribute('data-pid') || target.dataset.pid!;
        expandedBlackoutId = expandedBlackoutId === pid ? null : pid;
        rerender();
        break;
      }
      case 'add-unified-constraint': {
        const pid = target.dataset.pid!;
        const panel = target.closest('.blackout-panel')!;
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
        const startHour = parseInt((dialog.querySelector('[data-field="bulk-start"]') as HTMLInputElement).value || '0');
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
