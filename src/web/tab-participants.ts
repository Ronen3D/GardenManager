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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L1, Level.L2, Level.L3, Level.L4];
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala];

function levelBadge(level: Level): string {
  const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
  return `<span class="badge" style="background:${colors[level]}">L${level}</span>`;
}

function certBadges(certs: Certification[]): string {
  if (certs.length === 0) return '<span class="text-muted">None</span>';
  const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
  return certs.map(c =>
    `<span class="badge" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`
  ).join(' ');
}

const GROUP_PALETTE = ['#3498db', '#e67e22', '#2ecc71', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#34495e'];
const GROUP_COLOR_CACHE: Record<string, string> = {};

function groupColor(group: string): string {
  if (!GROUP_COLOR_CACHE[group]) {
    const idx = Object.keys(GROUP_COLOR_CACHE).length % GROUP_PALETTE.length;
    GROUP_COLOR_CACHE[group] = GROUP_PALETTE[idx];
  }
  return GROUP_COLOR_CACHE[group];
}

function groupBadge(group: string): string {
  return `<span class="badge" style="background:${groupColor(group)}">${group}</span>`;
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
  if (!name) return { valid: false, error: 'Group name cannot be empty.' };
  if (name.length < 2) return { valid: false, error: 'Group name must be at least 2 characters.' };
  for (const pat of FORBIDDEN_GROUP_PATTERNS) {
    if (pat.test(name)) return { valid: false, error: `"${name}" is not allowed as a group name.` };
  }
  // Check for near-duplicates (case-insensitive)
  const lower = name.toLowerCase();
  const dup = existingGroups.find(g => g.toLowerCase() === lower && g !== name);
  if (dup) return { valid: false, error: `A similar group "${dup}" already exists. Use it instead.` };
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
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
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
      <h2>Participants <span class="count">${allParticipants.length}</span></h2>
      <div class="filter-pills">
        <button class="pill ${filterGroup === '' ? 'pill-active' : ''}" data-action="filter-group" data-group="">All</button>
        ${groups.map(g =>
          `<button class="pill ${filterGroup === g ? 'pill-active' : ''}" data-action="filter-group" data-group="${g}">${g}</button>`
        ).join('')}
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="add-participant">+ Add Participant</button>
    </div>
  </div>`;

  // Table
  html += `<div class="table-responsive"><table class="table table-participants">
    <thead><tr>
      <th class="col-select"><input type="checkbox" id="cb-select-all" title="Select all" ${selectedIds.size > 0 && selectedIds.size === sorted.length ? 'checked' : ''} /></th>
      <th>#</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="name">Name${sortIndicator('name')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="group">Group${sortIndicator('group')}</th>
      <th class="sortable-th" data-action="sort-column" data-sort-col="level">Level${sortIndicator('level')}</th>
      <th>Certifications</th>
      <th>Availability</th><th>Blackouts</th><th class="col-actions">Actions</th>
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
        <td><strong>${p.name}</strong></td>
        <td>${groupBadge(p.group)}</td>
        <td>${levelBadge(p.level)}</td>
        <td>${certBadges(p.certifications)}</td>
        <td class="avail-cell">
          ${p.availability.map(w => `<small>${fmtTime(w.start)}–${fmtTime(w.end)}</small>`).join('<br>')}
        </td>
        <td>
          <button class="btn-sm btn-outline" data-action="toggle-blackouts" data-pid="${p.id}">
            ${totalRules > 0 ? `<span class="badge badge-sm" style="background:var(--warning)">${totalRules}</span>` : '—'}
          </button>
        </td>
        <td class="col-actions">
          <button class="btn-sm btn-outline" data-action="edit-participant" data-pid="${p.id}" title="Edit">✏️</button>
          <button class="btn-sm btn-outline btn-danger-outline" data-action="remove-participant" data-pid="${p.id}" title="Remove">🗑️</button>
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
      <span class="bulk-count">${selectedIds.size} participant${selectedIds.size > 1 ? 's' : ''} selected</span>
      <button class="btn-primary btn-sm" data-action="bulk-add-unavailability">📅 Add Unavailability</button>
      <button class="btn-danger btn-sm" data-action="bulk-delete-participants">🗑️ Delete Participants</button>
      <button class="btn-sm btn-outline" data-action="bulk-clear-selection">Clear Selection</button>
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
        <option value="__new__">+ New Group…</option>
      </select>
      <input class="input-sm" type="text" data-field="new-group-name" placeholder="Enter group name" style="display:none; margin-top:4px" />
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
            <input type="checkbox" data-cert="${c}" ${p.certifications.includes(c) ? 'checked' : ''} /> ${c}
          </label>`
        ).join('')}
      </div>
    </td>
    <td colspan="2"></td>
    <td class="col-actions">
      <button class="btn-sm btn-primary" data-action="save-participant" data-pid="${p.id}">Save</button>
      <button class="btn-sm btn-outline" data-action="cancel-edit">Cancel</button>
    </td>
  </tr>`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderBlackoutRow(pid: string, bouts: ReturnType<typeof store.getBlackouts>): string {
  const dateRules = store.getDateUnavailabilities(pid);

  let html = `<tr class="row-blackout-expansion">
    <td colspan="9">
      <div class="blackout-panel">
        <h4>Blackout Periods</h4>
        <div class="blackout-list">`;

  if (bouts.length === 0) {
    html += '<p class="text-muted">No blackouts configured.</p>';
  } else {
    html += '<ul>';
    for (const b of bouts) {
      html += `<li>
        <strong>${fmtTime(b.start)} – ${fmtTime(b.end)}</strong>
        ${b.reason ? `<span class="text-muted"> (${b.reason})</span>` : ''}
        <button class="btn-sm btn-danger-outline" data-action="remove-blackout" data-pid="${pid}" data-bid="${b.id}">✕</button>
      </li>`;
    }
    html += '</ul>';
  }

  html += `</div>
    <div class="blackout-add">
      <input type="time" class="input-sm" data-field="bo-start" value="00:00" />
      <span>to</span>
      <input type="time" class="input-sm" data-field="bo-end" value="08:00" />
      <input type="text" class="input-sm" data-field="bo-reason" placeholder="Reason (optional)" />
      <button class="btn-sm btn-primary" data-action="add-blackout" data-pid="${pid}">Add</button>
    </div>

    <h4 style="margin-top:12px">Date-Specific Unavailability</h4>
    <div class="blackout-list">`;

  if (dateRules.length === 0) {
    html += '<p class="text-muted">No date-specific rules. Participant follows standard availability.</p>';
  } else {
    html += '<ul>';
    for (const r of dateRules) {
      let label: string;
      if (r.specificDate) {
        label = r.specificDate;
      } else if (r.dayOfWeek !== undefined) {
        label = `Every ${DAY_NAMES[r.dayOfWeek]}`;
      } else {
        label = 'Unknown rule';
      }
      const timeLabel = r.allDay ? 'All Day' : `${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00`;
      html += `<li>
        <strong>${label}</strong> — <span>${timeLabel}</span>
        ${r.reason ? `<span class="text-muted"> (${r.reason})</span>` : ''}
        <button class="btn-sm btn-danger-outline" data-action="remove-date-unavail" data-pid="${pid}" data-rid="${r.id}">✕</button>
      </li>`;
    }
    html += '</ul>';
  }

  html += `</div>
    <div class="blackout-add">
      <select class="input-sm" data-field="du-type">
        <option value="dayOfWeek">Day of Week</option>
        <option value="specificDate">Specific Date</option>
      </select>
      <select class="input-sm" data-field="du-dow" style="width:120px">
        ${DAY_NAMES.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
      </select>
      <input type="date" class="input-sm" data-field="du-date" style="display:none" />
      <label class="checkbox-label" style="white-space:nowrap">
        <input type="checkbox" data-field="du-allday" /> All Day
      </label>
      <input type="number" class="input-sm" data-field="du-start-hour" min="0" max="23" value="8" placeholder="Start hour" style="width:70px" />
      <span>to</span>
      <input type="number" class="input-sm" data-field="du-end-hour" min="0" max="23" value="12" placeholder="End hour" style="width:70px" />
      <input type="text" class="input-sm" data-field="du-reason" placeholder="Reason (optional)" />
      <button class="btn-sm btn-primary" data-action="add-date-unavail" data-pid="${pid}">Add</button>
    </div>
  </div></td></tr>`;
  return html;
}

function renderAddForm(groups: string[]): string {
  return `
  <div id="add-participant-form" class="add-form" style="display:none;">
    <h4>New Participant</h4>
    <div class="form-row">
      <label>Name <input class="input-sm" type="text" data-field="new-name" placeholder="Name" /></label>
      <label>Group
        <select class="input-sm" data-field="new-group" data-group-select>
          ${groups.map(g => `<option value="${g}">${g}</option>`).join('')}
          <option value="__new__">+ New Group…</option>
        </select>
        <input class="input-sm" type="text" data-field="new-group-name" placeholder="Enter group name" style="display:none; margin-top:4px" />
        <span class="group-error" style="display:none; color:var(--error); font-size:0.75rem;"></span>
      </label>
      <label>Level
        <select class="input-sm" data-field="new-level">
          ${LEVEL_OPTIONS.map(l => `<option value="${l}" ${l === Level.L0 ? 'selected' : ''}>L${l}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="form-row">
      <span>Certifications:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label">
          <input type="checkbox" data-new-cert="${c}" ${c === Certification.Nitzan ? 'checked' : ''} /> ${c}
        </label>`
      ).join('')}
    </div>
    <div class="form-row">
      <button class="btn-primary btn-sm" data-action="confirm-add-participant">Add</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-participant">Cancel</button>
    </div>
  </div>`;
}

// ─── Bulk Unavailability Dialog ──────────────────────────────────────────────

function renderBulkUnavailDialog(): string {
  const DAY_NAMES_LOCAL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `<div class="bulk-dialog-backdrop" data-action="bulk-dialog-dismiss">
    <div class="bulk-dialog">
      <h3>Add Unavailability for ${selectedIds.size} Participant${selectedIds.size > 1 ? 's' : ''}</h3>

      <div class="bulk-dialog-body">
        <div class="form-row">
          <label>Type
            <select class="input-sm" data-field="bulk-type">
              <option value="specificDate">Specific Date</option>
              <option value="dayOfWeek">Day of Week</option>
            </select>
          </label>
          <label class="bulk-field-date">Date
            <input type="date" class="input-sm" data-field="bulk-date" />
          </label>
          <label class="bulk-field-dow" style="display:none">Day
            <select class="input-sm" data-field="bulk-dow">
              ${DAY_NAMES_LOCAL.map((d, i) => `<option value="${i}">${d}</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" data-field="bulk-allday" /> All Day
          </label>
        </div>

        <div class="form-row bulk-time-fields">
          <label>Start Hour
            <input type="number" class="input-sm" data-field="bulk-start" min="0" max="23" value="8" style="width:70px" />
          </label>
          <span style="align-self:end;padding-bottom:4px">to</span>
          <label>End Hour
            <input type="number" class="input-sm" data-field="bulk-end" min="0" max="23" value="16" style="width:70px" />
          </label>
        </div>

        <div class="form-row">
          <label style="flex:1">Reason / Label
            <input type="text" class="input-sm" data-field="bulk-reason" placeholder="e.g. Team Training" style="width:100%" />
          </label>
        </div>
      </div>

      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-outline" data-action="bulk-dialog-cancel">Cancel</button>
        <button class="btn-primary btn-sm" data-action="bulk-dialog-save">Save for ${selectedIds.size}</button>
      </div>
    </div>
  </div>`;
}

// ─── Bulk Delete Confirmation Dialog ─────────────────────────────────────────

function renderBulkDeleteDialog(): string {
  const n = selectedIds.size;
  return `<div class="bulk-dialog-backdrop" data-action="bulk-delete-dismiss">
    <div class="bulk-dialog bulk-delete-dialog">
      <h3>⚠️ Delete ${n} Participant${n > 1 ? 's' : ''}?</h3>
      <p class="bulk-delete-warning">
        Are you sure you want to delete <strong>${n}</strong> participant${n > 1 ? 's' : ''}?
        This action will also remove all their associated assignments and
        unavailability records. This cannot be undone.
      </p>
      <div class="bulk-dialog-footer">
        <button class="btn-sm btn-outline" data-action="bulk-delete-cancel">Cancel</button>
        <button class="btn-danger btn-sm" data-action="bulk-delete-confirm">Confirm Delete</button>
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

  // Date-unavailability type toggle (day-of-week vs specific date)
  container.addEventListener('change', (e) => {
    const target = e.target as HTMLElement;
    if ((target as HTMLSelectElement).dataset?.field === 'du-type') {
      const sel = target as HTMLSelectElement;
      const panel = sel.closest('.blackout-panel')!;
      const dowSel = panel.querySelector('[data-field="du-dow"]') as HTMLElement;
      const dateInp = panel.querySelector('[data-field="du-date"]') as HTMLElement;
      if (sel.value === 'dayOfWeek') {
        if (dowSel) dowSel.style.display = '';
        if (dateInp) dateInp.style.display = 'none';
      } else {
        if (dowSel) dowSel.style.display = 'none';
        if (dateInp) dateInp.style.display = '';
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

  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
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
        if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
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
        if (p && confirm(`Remove ${p.name}?`)) {
          store.removeParticipant(pid);
          rerender();
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
      case 'add-blackout': {
        const pid = target.dataset.pid!;
        const panel = target.closest('.blackout-panel')!;
        const startStr = (panel.querySelector('[data-field="bo-start"]') as HTMLInputElement)?.value;
        const endStr = (panel.querySelector('[data-field="bo-end"]') as HTMLInputElement)?.value;
        const reason = (panel.querySelector('[data-field="bo-reason"]') as HTMLInputElement)?.value;
        if (!startStr || !endStr) return;

        const d = store.getScheduleDate();
        const [sh, sm] = startStr.split(':').map(Number);
        const [eh, em] = endStr.split(':').map(Number);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), sh, sm);
        let end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eh, em);
        if (end <= start) end = new Date(end.getTime() + 24 * 3600000);

        store.addBlackout(pid, start, end, reason || undefined);
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
      case 'add-date-unavail': {
        const pid = target.dataset.pid!;
        const panel = target.closest('.blackout-panel')!;
        const duType = (panel.querySelector('[data-field="du-type"]') as HTMLSelectElement)?.value;
        const allDay = (panel.querySelector('[data-field="du-allday"]') as HTMLInputElement)?.checked ?? false;
        const startHour = parseInt((panel.querySelector('[data-field="du-start-hour"]') as HTMLInputElement)?.value || '0');
        const endHour = parseInt((panel.querySelector('[data-field="du-end-hour"]') as HTMLInputElement)?.value || '0');
        const reason = (panel.querySelector('[data-field="du-reason"]') as HTMLInputElement)?.value || undefined;

        if (duType === 'dayOfWeek') {
          const dow = parseInt((panel.querySelector('[data-field="du-dow"]') as HTMLSelectElement)?.value || '0');
          store.addDateUnavailability(pid, { dayOfWeek: dow, allDay, startHour, endHour, reason });
        } else {
          const dateStr = (panel.querySelector('[data-field="du-date"]') as HTMLInputElement)?.value;
          if (!dateStr) return;
          store.addDateUnavailability(pid, { specificDate: dateStr, allDay, startHour, endHour, reason });
        }
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

        // Defer rerender to let the store settle, then show toast AFTER
        // the DOM is rebuilt so it lives in the new container.
        requestAnimationFrame(() => {
          rerender();
          // Insert toast into the NEW container
          const newContent = document.getElementById('tab-content');
          if (newContent) {
            const msg = document.createElement('div');
            msg.className = 'bulk-confirmation';
            msg.textContent = `Successfully deleted ${deleted} participant${deleted !== 1 ? 's' : ''}.`;
            newContent.prepend(msg);
            setTimeout(() => msg.remove(), 3500);
          }
        });
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

        // Defer rerender so store settles; show toast in the new container
        requestAnimationFrame(() => {
          rerender();
          const newContent = document.getElementById('tab-content');
          if (newContent) {
            const msg = document.createElement('div');
            msg.className = 'bulk-confirmation';
            msg.textContent = `Added unavailability for ${count} participant${count !== 1 ? 's' : ''}.`;
            newContent.prepend(msg);
            setTimeout(() => msg.remove(), 3500);
          }
        });
        break;
      }
    }
  });
}
