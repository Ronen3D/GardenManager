/**
 * Participants Tab — Stage 0 Configuration UI
 *
 * CRUD table for managing participants, with inline editing,
 * group filtering, and blackout period management.
 */

import {
  Level,
  Certification,
  Participant,
} from '../models/types';
import * as store from './config-store';
import { showConfirm, showToast } from './ui-modal';
import { levelBadge, certBadges, groupBadge, groupColor, CERT_LABELS, SVG_ICONS } from './ui-helpers';
import { HEBREW_DAYS, hebrewDayName, hebrewDayNameFromISO } from '../utils/date-utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala, Certification.Horesh];

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
    if (errorSpan) { errorSpan.textContent = result.error; errorSpan.style.display = 'block'; }
    newGroupInput?.focus();
    return null;
  }
  if (errorSpan) errorSpan.style.display = 'none';
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

/** Clear participant selection state (called on tab change) */
export function clearParticipantSelection(): void {
  selectedIds.clear();
  _lastClickedId = null;
  _bulkDialogOpen = false;
  _bulkDeleteDialogOpen = false;
}
// ─── Sort Logic ──────────────────────────────────────────────────────────────

function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
        <label>שם: <input type="text" class="preset-name-input" data-field="pset-saveas-name" maxlength="60" placeholder="הסט שלי" autofocus /></label>
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
        <label>שם: <input type="text" class="preset-name-input" data-field="pset-rename-name" maxlength="60" value="${_escHtml(target?.name ?? '')}" /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="pset-rename-desc" maxlength="200" value="${_escHtml(target?.description ?? '')}" /></label>
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
          <span class="preset-item-name">${_escHtml(s.name)}</span>
          <span class="pset-count-badge">${count} משתתפים</span>
          ${isBuiltIn ? '<span class="preset-builtin-badge">מובנה</span>' : ''}
          ${isActive && dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
        </div>
        ${s.description ? `<div class="preset-item-desc text-muted">${_escHtml(s.description)}</div>` : ''}
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
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="בחר הכל" ${selectedIds.size > 0 && selectedIds.size === sorted.length ? 'checked' : ''} /></th>
      <th>#</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="name">שם${sortIndicator('name')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="group">קבוצה${sortIndicator('group')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="level">דרגה${sortIndicator('level')}</th>
      <th>הסמכות</th>
      <th>זמינות</th><th>חסימות</th><th class="col-actions">פעולות</th>
    </tr></thead><tbody>`;

  sorted.forEach((p, i) => {
    const isEditing = editingId === p.id;
    const bouts = store.getBlackouts(p.id);
    const dateRules = store.getDateUnavailabilities(p.id);
    const isExpanded = expandedBlackoutId === p.id;
    const totalRules = bouts.length + dateRules.length;
    const isSelected = selectedIds.has(p.id);

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
        <td class="avail-cell">
          ${p.availability.map(w => `<small dir="ltr">${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
        </td>
        <td>
          <button class="btn-sm btn-outline btn-icon" data-action="toggle-blackouts" data-pid="${p.id}" title="הצג/ערוך חסימות">
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
        html += renderBlackoutRow(p.id, bouts);
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
  return `<tr class="row-editing" data-participant-id="${p.id}">
    <td class="col-select"></td>
    <td>${idx}</td>
    <td><input class="input-sm" type="text" data-field="name" value="${p.name}" /></td>
    <td>
      <select class="input-sm" data-field="group" data-group-select>
        ${groups.map(g => `<option value="${g}" ${p.group === g ? 'selected' : ''}>${g}</option>`).join('')}
        <option value="__new__">+ קבוצה חדשה…</option>
      </select>
      <input class="input-sm" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" style="display:none; margin-top:4px" />
      <span class="group-error" style="display:none; color:var(--error); font-size:0.75rem;"></span>
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
    <td colspan="2"></td>
    <td class="col-actions">
      <button class="btn-sm btn-primary" data-action="save-participant" data-pid="${p.id}">שמור</button>
      <button class="btn-sm btn-outline" data-action="cancel-edit">ביטול</button>
    </td>
  </tr>`;
}



function renderBlackoutRow(pid: string, bouts: ReturnType<typeof store.getBlackouts>): string {
  const dateRules = store.getDateUnavailabilities(pid);

  let html = `<tr class="row-blackout-expansion">
    <td colspan="9">
      <div class="blackout-panel">
        <h4>חסימות מוגדרות</h4>
        <div class="blackout-list">`;

  if (bouts.length === 0 && dateRules.length === 0) {
    html += '<p class="text-muted">אין חסימות מוגדרות.</p>';
  } else {
    html += '<ul>';
    
    // Render current shift blackouts
    for (const b of bouts) {
      html += `<li>
        <span class="constraint-type">משמרת נוכחית</span>
        <strong dir="ltr">${fmtTime(b.start)} – ${fmtTime(b.end)}</strong>
        ${b.reason ? `<span class="text-muted"> (${b.reason})</span>` : ''}
        <button class="btn-sm btn-danger-outline" data-action="remove-blackout" data-pid="${pid}" data-bid="${b.id}">✕</button>
      </li>`;
    }

    // Render date/day unavailabilities
    for (const r of dateRules) {
      let label: string;
      if (r.specificDate) {
        label = 'יום ' + hebrewDayNameFromISO(r.specificDate);
      } else if (r.dayOfWeek !== undefined) {
        label = `כל ${HEBREW_DAYS[r.dayOfWeek]}`;
      } else {
        label = 'כלל לא ידוע';
      }
      const timeLabel = r.allDay ? 'כל היום' : `<span dir="ltr">${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00</span>`;
      html += `<li>
        <span class="constraint-type">${r.specificDate ? 'תאריך ספציפי' : 'יום קבוע'}</span>
        <strong>${label}</strong> — <span>${timeLabel}</span>
        ${r.reason ? `<span class="text-muted"> (${r.reason})</span>` : ''}
        <button class="btn-sm btn-danger-outline" data-action="remove-date-unavail" data-pid="${pid}" data-rid="${r.id}">✕</button>
      </li>`;
    }
    html += '</ul>';
  }

  html += `</div>
    <h4 style="margin-top:16px">הוספת חסימה חדשה</h4>
    <div class="blackout-add unified-constraint-form">
      <select class="input-sm" data-field="constraint-type">
        <option value="current_shift">למשמרת הנוכחית</option>
        <option value="dayOfWeek">יום קבוע בשבוע</option>
        <option value="specificDate">תאריך ספציפי</option>
      </select>
      
      <select class="input-sm" data-field="du-dow" style="width:120px; display:none;">
        ${HEBREW_DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
      </select>
      
      <input type="date" class="input-sm" data-field="du-date" style="display:none;" />
      
      <div class="time-inputs-group">
        <label class="checkbox-label" style="white-space:nowrap; display:none;" data-field="du-allday-wrapper">
          <input type="checkbox" data-field="du-allday" /> כל היום
        </label>
        <input type="text" class="input-sm time-24h" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="bo-start" value="08:00" />
        <span class="time-separator">עד</span>
        <input type="text" class="input-sm time-24h" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="bo-end" value="12:00" />
      </div>
      
      <input type="text" class="input-sm" data-field="bo-reason" placeholder="סיבה (אופציונלי)" />
      <button class="btn-sm btn-primary" data-action="add-unified-constraint" data-pid="${pid}">הוסף</button>
      <span class="du-validation-error" style="display:none;color:#e74c3c;font-size:0.85em;margin-inline-start:6px"></span>
    </div>
  </div></td></tr>`;
  return html;
}

function renderAddForm(groups: string[]): string {
  return `
  <div id="add-participant-form" class="add-form" style="display:none;">
    <h4>הוסף משתתף</h4>
    <div class="form-row">
      <label>שם <input class="input-sm" type="text" data-field="new-name" placeholder="שם" /></label>
      <label>קבוצה
        <select class="input-sm" data-field="new-group" data-group-select>
          ${groups.map(g => `<option value="${g}">${g}</option>`).join('')}
          <option value="__new__">+ קבוצה חדשה…</option>
        </select>
        <input class="input-sm" type="text" data-field="new-group-name" placeholder="הכנס שם קבוצה" style="display:none; margin-top:4px" />
        <span class="group-error" style="display:none; color:var(--error); font-size:0.75rem;"></span>
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
          <label>סוג
            <select class="input-sm" data-field="bulk-type">
              <option value="specificDate">תאריך ספציפי</option>
              <option value="dayOfWeek">יום בשבוע</option>
            </select>
          </label>
          <label class="bulk-field-date">תאריך
            <input type="date" class="input-sm" data-field="bulk-date" />
          </label>
          <label class="bulk-field-dow" style="display:none">יום
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
        <button class="btn-primary btn-sm" data-action="bulk-dialog-save">שמור עבור ${selectedIds.size}</button>
      </div>
    </div>
  </div>`;
}

// ─── Bulk Delete Confirmation Dialog ─────────────────────────────────────────

function renderBulkDeleteDialog(): string {
  const n = selectedIds.size;
  return `<div class="bulk-dialog-backdrop" data-action="bulk-delete-dismiss">
    <div class="bulk-dialog bulk-delete-dialog">
      <h3>⚠️ מחק ${n} משתתפים?</h3>
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

  // ─── Bulk: Dialog live toggles (type, allDay) ───────────────────────────────
  container.addEventListener('change', (e) => {
    const field = (e.target as HTMLElement).getAttribute('data-field');
    if (field === 'bulk-type') {
      const sel = (e.target as HTMLSelectElement).value;
      const dialog = (e.target as HTMLElement).closest('.bulk-dialog')!;
      const dateLabel = dialog.querySelector('.bulk-field-date') as HTMLElement;
      const dowLabel = dialog.querySelector('.bulk-field-dow') as HTMLElement;
      if (sel === 'dayOfWeek') {
        dateLabel.style.display = 'none';
        dowLabel.style.display = '';
      } else {
        dateLabel.style.display = '';
        dowLabel.style.display = 'none';
      }
    }
    if (field === 'bulk-allday') {
      const checked = (e.target as HTMLInputElement).checked;
      const dialog = (e.target as HTMLElement).closest('.bulk-dialog')!;
      const timeFields = dialog.querySelector('.bulk-time-fields') as HTMLElement;
      if (timeFields) timeFields.style.display = checked ? 'none' : '';
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
      if (newGroupInput) { newGroupInput.style.display = 'block'; newGroupInput.value = ''; newGroupInput.focus(); }
    } else {
      if (newGroupInput) { newGroupInput.style.display = 'none'; newGroupInput.value = ''; }
      if (errorSpan) errorSpan.style.display = 'none';
    }
  });

  // Constraint type toggle (current shift vs day-of-week vs specific date)
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    if ((target as HTMLSelectElement).dataset?.field === 'constraint-type') {
      const sel = target as HTMLSelectElement;
      const panel = sel.closest('.blackout-panel')!;
      const dowSel = panel.querySelector('[data-field="du-dow"]') as HTMLElement;
      const dateInp = panel.querySelector('[data-field="du-date"]') as HTMLElement;
      const allDayWrapper = panel.querySelector('[data-field="du-allday-wrapper"]') as HTMLElement;
      
      if (sel.value === 'current_shift') {
        if (dowSel) dowSel.style.display = 'none';
        if (dateInp) dateInp.style.display = 'none';
        if (allDayWrapper) allDayWrapper.style.display = 'none';
      } else if (sel.value === 'dayOfWeek') {
        if (dowSel) dowSel.style.display = '';
        if (dateInp) dateInp.style.display = 'none';
        if (allDayWrapper) allDayWrapper.style.display = '';
      } else {
        if (dowSel) dowSel.style.display = 'none';
        if (dateInp) dateInp.style.display = '';
        if (allDayWrapper) allDayWrapper.style.display = '';
      }
    }
    
    // Handle "All Day" checkbox toggle
    if ((target as HTMLInputElement).dataset?.field === 'du-allday') {
      const cb = target as HTMLInputElement;
      const panel = cb.closest('.blackout-panel')!;
      const startInp = panel.querySelector('[data-field="bo-start"]') as HTMLInputElement;
      const endInp = panel.querySelector('[data-field="bo-end"]') as HTMLInputElement;
      const separator = panel.querySelector('.time-separator') as HTMLElement;
      
      if (cb.checked) {
        if (startInp) startInp.style.display = 'none';
        if (endInp) endInp.style.display = 'none';
        if (separator) separator.style.display = 'none';
      } else {
        if (startInp) startInp.style.display = '';
        if (endInp) endInp.style.display = '';
        if (separator) separator.style.display = '';
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
      if (errorSpan) errorSpan.style.display = 'none';
      return;
    }
    const result = validateGroupName(raw, store.getGroups());
    if (errorSpan) {
      errorSpan.textContent = result.valid ? '' : result.error;
      errorSpan.style.display = result.valid ? 'none' : 'block';
    }
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
      case 'add-participant': {
        const form = container.querySelector('#add-participant-form') as HTMLElement;
        if (form) {
          const wasHidden = form.style.display === 'none';
          form.style.display = wasHidden ? 'block' : 'none';
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

        store.addParticipant({ name, level, certifications: certs, group });
        rerender();
        break;
      }
      case 'cancel-add-participant': {
        const form = container.querySelector('#add-participant-form') as HTMLElement;
        if (form) form.style.display = 'none';
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

        store.updateParticipant(pid, { name, group, level, certifications: certs });
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
      case 'remove-blackout': {
        const pid = target.dataset.pid!;
        const bid = target.dataset.bid!;
        store.removeBlackout(pid, bid);
        rerender();
        break;
      }
      case 'add-unified-constraint': {
        const pid = target.dataset.pid!;
        const panel = target.closest('.blackout-panel')!;
        const type = (panel.querySelector('[data-field="constraint-type"]') as HTMLSelectElement)?.value;
        const reason = (panel.querySelector('[data-field="bo-reason"]') as HTMLInputElement)?.value || undefined;
        const errEl = panel.querySelector('.du-validation-error') as HTMLElement;
        if (errEl) errEl.style.display = 'none';

        if (type === 'current_shift') {
          const startStr = (panel.querySelector('[data-field="bo-start"]') as HTMLInputElement)?.value;
          const endStr = (panel.querySelector('[data-field="bo-end"]') as HTMLInputElement)?.value;
          if (!startStr || !endStr) return;

          const d = store.getScheduleDate();
          const [sh, sm] = startStr.split(':').map(Number);
          const [eh, em] = endStr.split(':').map(Number);
          const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm);
          let end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em);
          if (end <= start) end = new Date(end.getTime() + 24 * 3600000);

          store.addBlackout(pid, start, end, reason);
        } else {
          const allDay = (panel.querySelector('[data-field="du-allday"]') as HTMLInputElement)?.checked ?? false;
          const startStr = (panel.querySelector('[data-field="bo-start"]') as HTMLInputElement)?.value || '00:00';
          const endStr = (panel.querySelector('[data-field="bo-end"]') as HTMLInputElement)?.value || '00:00';
          const startHour = parseInt(startStr.split(':')[0]);
          const endHour = parseInt(endStr.split(':')[0]);

          if (!allDay && startHour === endHour) {
            if (errEl) {
              errEl.textContent = 'שעת התחלה ושעת סיום לא יכולות להיות זהות. השתמש ב"כל היום".';
              errEl.style.display = 'block';
            }
            return;
          }

          if (type === 'dayOfWeek') {
            const dow = parseInt((panel.querySelector('[data-field="du-dow"]') as HTMLSelectElement)?.value || '0');
            store.addDateUnavailability(pid, { dayOfWeek: dow, allDay, startHour, endHour, reason });
          } else if (type === 'specificDate') {
            const dateStr = (panel.querySelector('[data-field="du-date"]') as HTMLInputElement)?.value;
            if (!dateStr) return;
            store.addDateUnavailability(pid, { specificDate: dateStr, allDay, startHour, endHour, reason });
          }
        }
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
        showToast('הסט שונה בהצלחה', { type: 'success' });
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
        const typeVal = (dialog.querySelector('[data-field="bulk-type"]') as HTMLSelectElement).value;
        const allDay = (dialog.querySelector('[data-field="bulk-allday"]') as HTMLInputElement).checked;
        const startHour = parseInt((dialog.querySelector('[data-field="bulk-start"]') as HTMLInputElement).value || '0');
        const endHour = parseInt((dialog.querySelector('[data-field="bulk-end"]') as HTMLInputElement).value || '0');
        const reason = (dialog.querySelector('[data-field="bulk-reason"]') as HTMLInputElement).value || undefined;

        const rule: Omit<import('../models/types').DateUnavailability, 'id'> = {
          allDay,
          startHour: allDay ? 0 : startHour,
          endHour: allDay ? 24 : endHour,
          reason,
        };

        if (typeVal === 'dayOfWeek') {
          rule.dayOfWeek = parseInt((dialog.querySelector('[data-field="bulk-dow"]') as HTMLSelectElement).value);
        } else {
          const dateStr = (dialog.querySelector('[data-field="bulk-date"]') as HTMLInputElement).value;
          if (!dateStr) { (dialog.querySelector('[data-field="bulk-date"]') as HTMLInputElement).focus(); break; }
          rule.specificDate = dateStr;
        }

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
      const ok = await showConfirm('טעינת סט תחליף את כל המשתתפים הנוכחיים. להמשיך?', {
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
      const ok = await showConfirm('לעדכן את הסט עם המשתתפים הנוכחיים?', {
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
