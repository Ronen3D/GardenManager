/**
 * Task Rules Tab — Stage 0 Configuration UI
 *
 * Edit task templates, constraint builder, sub-team management,
 * and real-time preflight validation panel.
 */

import {
  Level,
  Certification,
  TaskType,
  TaskTemplate,
  SlotTemplate,
  SubTeamTemplate,
  PreflightSeverity,
  PreflightResult,
  LoadWindow,
  TaskSet,
  OneTimeTask,
} from '../models/types';
import * as store from './config-store';
import { showPrompt, showConfirm, showToast } from './ui-modal';
import { runPreflight } from './preflight';
import { TASK_COLORS, TASK_TYPE_LABELS, escHtml } from './ui-helpers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala, Certification.Horesh];
const TASK_TYPE_OPTIONS = Object.values(TaskType);

function taskTypeBadge(type: string): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${TASK_TYPE_LABELS[type] || type}</span>`;
}

function levelBadge(level: Level): string {
  const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
  return `<span class="badge badge-sm" style="background:${colors[level]}">L${level}</span>`;
}

function certBadge(cert: Certification): string {
  const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
  return `<span class="badge badge-sm" style="background:${colors[cert] || '#7f8c8d'}">${cert}</span>`;
}

function forbiddenCertBadge(cert: Certification): string {
  return `<span class="badge badge-sm" style="background:#c0392b;text-decoration:line-through">${cert}</span>`;
}

/** Strip English level references (L0, L3/L4, (L2+), etc.) from a slot label. */
function stripLevelText(label: string): string {
  return label.replace(/\s*\(?L\d[\d/+L]*\)?\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function fmtHm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── State ───────────────────────────────────────────────────────────────────

let expandedTemplateId: string | null = null;
let addingSlotTo: { templateId: string; subTeamId?: string } | null = null;
let showAddTemplate = false;
let showAddOneTime = false;

// ─── Task Sets Panel State ───────────────────────────────────────────────────

let _taskSetPanelOpen = false;
let _taskSetFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _taskSetFormError = '';
let _taskSetRenameTargetId: string | null = null;

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderTaskRulesTab(): string {
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  const criticals = preflight.findings.filter(f => f.severity === PreflightSeverity.Critical);

  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>פירוט משימות <span class="count">${templates.length}</span></h2>
      <div class="score-card inline-badge ${criticals.length > 0 ? 'status-error' : 'status-ok'}">
        <span class="score-value">${criticals.length > 0 ? '✗ חסום' : '✓ מוכן'}</span>
        <span class="score-label">מוכנות לשיבוץ</span>
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-sm btn-outline${_taskSetPanelOpen ? ' pill-active' : ''}" data-action="tset-panel-toggle" title="סטים של משימות">📋 סטים${store.isTaskSetDirty() ? ' <span class="dirty-dot"></span>' : ''}</button>
      <button class="btn-primary btn-sm" data-action="toggle-add-template">+ משימה חדשה</button>
    </div>
  </div>`;

  // Task Sets panel
  if (_taskSetPanelOpen) {
    html += renderTaskSetPanel();
  }

  // Template cards
  html += '<div class="template-list">';
  for (const tpl of templates) {
    html += renderTemplateCard(tpl, preflight);
  }
  html += '</div>';

  // Add template form
  if (showAddTemplate) {
    html += renderAddTemplateForm();
  }

  // ── One-Time Tasks Section ──
  const oneTimeTasks = store.getAllOneTimeTasks();
  html += `
  <div class="tab-toolbar" style="margin-top:24px; border-top:1px solid var(--border); padding-top:16px;">
    <div class="toolbar-left">
      <h2>משימות חד-פעמיות <span class="count">${oneTimeTasks.length}</span></h2>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="toggle-add-onetime">+ משימה חד-פעמית</button>
    </div>
  </div>`;

  if (showAddOneTime) {
    html += renderAddOneTimeForm();
  }

  if (oneTimeTasks.length > 0) {
    html += '<div class="template-list">';
    for (const ot of oneTimeTasks) {
      html += renderOneTimeCard(ot);
    }
    html += '</div>';
  }

  return html;
}

// ─── Task Set Panel ──────────────────────────────────────────────────────────

function renderTaskSetPanel(): string {
  const sets = store.getAllTaskSets();
  const activeId = store.getActiveTaskSetId();
  const dirty = store.isTaskSetDirty();
  const nameFieldInvalid = _taskSetFormError ? ' aria-invalid="true" aria-describedby="tset-form-error"' : '';

  let html = `<div class="preset-panel pset-panel">`;

  // Header
  html += `<div class="preset-panel-header">
    <h3>📋 סטים של משימות <span class="count">${sets.length}</span></h3>
    <button class="btn-xs btn-outline" data-action="tset-panel-close" title="סגור">✕</button>
  </div>`;

  // Form area
  if (_taskSetFormMode === 'save-as') {
    html += `<div class="preset-inline-form" id="tset-saveas-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="tset-saveas-name" maxlength="60" placeholder="הסט שלי" autofocus${nameFieldInvalid} /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="tset-saveas-desc" maxlength="200" placeholder="תיאור אופציונלי" /></label>
        <button class="btn btn-sm btn-primary" data-action="tset-saveas-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="tset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="tset-form-error">${_taskSetFormError}</div>
    </div>`;
  } else if (_taskSetFormMode === 'rename') {
    const targetId = _taskSetRenameTargetId ?? activeId;
    const target = targetId ? store.getTaskSetById(targetId) : undefined;
    html += `<div class="preset-inline-form" id="tset-rename-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="tset-rename-name" maxlength="60" value="${escHtml(target?.name ?? '')}"${nameFieldInvalid} /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="tset-rename-desc" maxlength="200" value="${escHtml(target?.description ?? '')}" /></label>
        <button class="btn btn-sm btn-primary" data-action="tset-rename-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="tset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="tset-form-error">${_taskSetFormError}</div>
    </div>`;
  } else {
    html += `<div class="preset-actions-primary">
      <button class="btn-sm btn-primary" data-action="tset-new">+ שמור סט חדש</button>
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
      const count = s.templates.length;
      html += `<div class="preset-item ${isActive ? 'preset-item-active' : ''}" data-tset-id="${s.id}">
        <div class="preset-item-main">
          <span class="preset-item-name">${escHtml(s.name)}</span>
          <span class="pset-count-badge">${count} תבניות</span>
          ${isBuiltIn ? '<span class="preset-builtin-badge">מובנה</span>' : ''}
          ${isActive && dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
        </div>
        ${s.description ? `<div class="preset-item-desc text-muted">${escHtml(s.description)}</div>` : ''}
        <div class="preset-item-actions">
          ${!isActive ? `<button class="btn-xs btn-primary" data-tset-action="load" data-tset-id="${s.id}" title="טען סט זה">▶ טען</button>` : ''}
          ${isActive && dirty && !isBuiltIn ? `<button class="btn-xs btn-outline" data-tset-action="update" data-tset-id="${s.id}" title="עדכן עם התבניות הנוכחיות">עדכן</button>` : ''}
          ${!isBuiltIn ? `<button class="btn-xs btn-outline" data-tset-action="rename" data-tset-id="${s.id}" title="שנה שם">✎</button>` : ''}
          <button class="btn-xs btn-outline" data-tset-action="duplicate" data-tset-id="${s.id}" title="שכפל">⧉</button>
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-tset-action="delete" data-tset-id="${s.id}" title="מחק">✕</button>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}


function renderTemplateCard(tpl: TaskTemplate, pf: PreflightResult): string {
  const isExpanded = expandedTemplateId === tpl.id;
  const relatedFindings = pf.findings.filter(f => f.templateId === tpl.id);
  const hasCritical = relatedFindings.some(f => f.severity === PreflightSeverity.Critical);
  const hasWarning = relatedFindings.some(f => f.severity === PreflightSeverity.Warning);

  const allSlots = [...tpl.slots];
  for (const st of tpl.subTeams) allSlots.push(...st.slots);
  const totalSlots = allSlots.length;
  const totalPeople = totalSlots * tpl.shiftsPerDay;

  const alertClass = hasCritical ? 'template-card-error' : hasWarning ? 'template-card-warn' : '';

  let html = `<div class="template-card ${alertClass}" data-template-id="${tpl.id}">
    <div class="template-header" data-action="toggle-template" data-tid="${tpl.id}">
      <div class="template-title">
        ${taskTypeBadge(tpl.taskType)}
        <strong>${tpl.name}</strong>
        <span class="text-muted"> · ${tpl.shiftsPerDay} משמרות × ${tpl.durationHours} שע׳ — ${totalPeople} איש/יום</span>
        ${hasCritical ? '<span class="badge badge-sm" style="background:var(--danger)">!</span>' : ''}
        ${hasWarning && !hasCritical ? '<span class="badge badge-sm" style="background:var(--warning)">⚠</span>' : ''}
      </div>
      <div class="template-toggles">
        ${tpl.sameGroupRequired ? '<span class="badge badge-sm badge-outline">נדרשת אותה קבוצה</span>' : ''}
        ${tpl.isLight ? '<span class="badge badge-sm badge-outline">קלה</span>' : ''}
        ${(tpl.blocksConsecutive ?? !tpl.isLight) ? '' : '<span class="badge badge-sm badge-outline">ניתן לשבץ ברצף</span>'}
        ${tpl.togethernessRelevant ? '<span class="badge badge-sm badge-outline">אי התאמה</span>' : ''}
        ${tpl.requiresCategoryBreak ? '<span class="badge badge-sm badge-outline">מינימום 5 שעות הפסקה</span>' : ''}
        <span class="expand-arrow">${isExpanded ? '▼' : '▶'}</span>
      </div>
    </div>`;

  if (isExpanded) {
    html += `<div class="template-body">`;
    if (tpl.description) {
      html += `<p class="text-muted" style="margin-bottom:12px;">${tpl.description}</p>`;
    }

    // Template properties
    html += `<div class="template-props">
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" data-tpl-field="durationHours" value="${tpl.durationHours}" data-tid="${tpl.id}" /></label>
      <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" data-tpl-field="shiftsPerDay" value="${tpl.shiftsPerDay}" data-tid="${tpl.id}" /></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" data-tpl-field="startHour" value="${tpl.startHour}" data-tid="${tpl.id}" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-tpl-field="baseLoadWeight" value="${(tpl.baseLoadWeight ?? (tpl.isLight ? 0 : 1)).toFixed(2)}" data-tid="${tpl.id}" /></label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="sameGroupRequired" data-tid="${tpl.id}" ${tpl.sameGroupRequired ? 'checked' : ''} /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="isLight" data-tid="${tpl.id}" ${tpl.isLight ? 'checked' : ''} /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="blocksConsecutive" data-tid="${tpl.id}" ${(tpl.blocksConsecutive ?? !tpl.isLight) ? 'checked' : ''} /> חוסם רצף משימות</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="togethernessRelevant" data-tid="${tpl.id}" ${tpl.togethernessRelevant ? 'checked' : ''} /> אי התאמה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="requiresCategoryBreak" data-tid="${tpl.id}" ${tpl.requiresCategoryBreak ? 'checked' : ''} /> מינימום 5 שעות הפסקה</label>
      <button class="btn-sm btn-primary" data-action="save-template-props" data-tid="${tpl.id}">שמור</button>
    </div>`;

    html += renderLoadWindowsEditor(tpl);

    // Sub-teams
    if (tpl.subTeams.length > 0) {
      html += '<h4 style="margin:12px 0 8px;">תת-צוותים</h4>';
      for (const st of tpl.subTeams) {
        html += renderSubTeam(tpl.id, st, pf);
      }
    }

    // Top-level slots
    if (tpl.slots.length > 0 || tpl.subTeams.length === 0) {
      html += `<h4 style="margin:12px 0 8px;">משבצות${tpl.subTeams.length > 0 ? ' נוספות' : ''}</h4>`;
      html += renderSlotTable(tpl.id, tpl.slots, undefined, pf);
    }

    // Add sub-team / slot buttons
    html += `<div class="template-actions">
      <button class="btn-sm btn-outline" data-action="add-subteam" data-tid="${tpl.id}">+ תת-צוות</button>
      <button class="btn-sm btn-outline" data-action="add-slot" data-tid="${tpl.id}">+ משבצת</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-template" data-tid="${tpl.id}">הסר תבנית</button>
    </div>`;

    // Inline add-slot form
    if (addingSlotTo && addingSlotTo.templateId === tpl.id && !addingSlotTo.subTeamId) {
      html += renderAddSlotForm(tpl.id);
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderLoadWindowsEditor(tpl: TaskTemplate): string {
  const windows = tpl.loadWindows ?? [];
  let html = `<h4 style="margin:12px 0 8px;">חלונות עומס מוגבר</h4>`;

  if (windows.length === 0) {
    html += '<p class="text-muted" style="padding:4px 0;">לא הוגדרו חלונות עומס. משקל העומס חל על כל המשימה.</p>';
  } else {
    html += `<div class="table-responsive"><table class="table table-slots" style="margin-bottom:8px;">
      <thead><tr><th>חלון</th><th>משקל</th><th></th></tr></thead>
      <tbody>`;
    for (const w of windows) {
      html += `<tr>
        <td>
          <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-edit-start" data-lwid="${w.id}" value="${fmtHm(w.startHour, w.startMinute)}" />
          -
          <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-edit-end" data-lwid="${w.id}" value="${fmtHm(w.endHour, w.endMinute)}" />
        </td>
        <td><input class="input-sm" type="number" step="0.05" min="0" max="1" data-field="lw-edit-weight" data-lwid="${w.id}" value="${w.weight.toFixed(2)}" /></td>
        <td>
          <button class="btn-sm btn-primary" data-action="update-load-window" data-tid="${tpl.id}" data-lwid="${w.id}">שמור</button>
          <button class="btn-sm btn-danger-outline" data-action="remove-load-window" data-tid="${tpl.id}" data-lwid="${w.id}">✕</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }

  html += `<div class="add-slot-form" style="margin-top:8px;">
    <div class="form-row">
      <label>התחלה <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-start" value="05:00" /></label>
      <label>סיום <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-end" value="06:30" /></label>
      <label>משקל (0-1) <input class="input-sm" type="number" step="0.05" min="0" max="1" data-field="lw-weight" value="1" /></label>
      <button class="btn-sm btn-primary" data-action="add-load-window" data-tid="${tpl.id}">הוסף חלון עומס מוגבר</button>
    </div>
  </div>`;

  return html;
}

function renderSubTeam(templateId: string, st: SubTeamTemplate, pf: PreflightResult): string {
  let html = `<div class="subteam-card">
    <div class="subteam-header">
      <strong>${st.name}</strong>
      <span class="text-muted">(${st.slots.length} משבצות)</span>
      <button class="btn-sm btn-outline" data-action="add-slot-subteam" data-tid="${templateId}" data-stid="${st.id}">+ משבצת</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-subteam" data-tid="${templateId}" data-stid="${st.id}">✕</button>
    </div>`;

  html += renderSlotTable(templateId, st.slots, st.id, pf);

  if (addingSlotTo && addingSlotTo.templateId === templateId && addingSlotTo.subTeamId === st.id) {
    html += renderAddSlotForm(templateId, st.id);
  }

  html += `</div>`;
  return html;
}

function renderSlotTable(templateId: string, slots: SlotTemplate[], subTeamId: string | undefined, pf: PreflightResult): string {
  if (slots.length === 0) return '<p class="text-muted" style="padding:4px 0;">אין משבצות מוגדרות.</p>';

  let html = `<div class="table-responsive"><table class="table table-slots">
    <thead><tr><th>תווית</th><th>דרגות</th><th>הסמכות נדרשות</th><th>הסמכות אסורות</th><th>סטטוס</th><th></th></tr></thead>
    <tbody>`;

  for (const slot of slots) {
    const finding = pf.findings.find(f => f.slotId === slot.id);
    const statusHtml = finding
      ? `<span class="${finding.severity === PreflightSeverity.Critical ? 'text-danger' : 'text-warn'}">${finding.severity === PreflightSeverity.Critical ? '✗' : '⚠'} ${finding.code}</span>`
      : '<span style="color:var(--success)">✓</span>';

    const forbiddenCerts = slot.forbiddenCertifications ?? [];

    html += `<tr>
      <td>${stripLevelText(slot.label)}</td>
      <td>${slot.acceptableLevels.map(e => levelBadge(e.level) + (e.lowPriority ? '<sup style="color:#e67e22;font-size:0.6rem">LP</sup>' : '')).join(' ')}</td>
      <td>${slot.requiredCertifications.length > 0 ? slot.requiredCertifications.map(c => certBadge(c)).join(' ') : '<span class="text-muted">אין</span>'}</td>
      <td>${forbiddenCerts.length > 0 ? forbiddenCerts.map(c => forbiddenCertBadge(c)).join(' ') : '<span class="text-muted">אין</span>'}</td>
      <td>${statusHtml}</td>
      <td><button class="btn-sm btn-danger-outline" data-action="remove-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''} data-slotid="${slot.id}">✕</button></td>
    </tr>`;
  }

  html += '</tbody></table></div>';
  return html;
}

function renderAddSlotForm(templateId: string, subTeamId?: string): string {
  return `<div class="add-slot-form">
    <h5>הוסף משבצת</h5>
    <div class="form-row">
      <label>תווית: <input class="input-sm" type="text" data-field="slot-label" placeholder="למשל #1" /></label>
    </div>
    <div class="form-row">
      <span>דרגות:</span>
      ${LEVEL_OPTIONS.map(l =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-level="${l}" checked /> L${l}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <span>הסמכות נדרשות:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-cert="${c}" /> ${c}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <span>הסמכות אסורות:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-forbidden-cert="${c}" /> ${c}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''}>הוסף</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-slot">ביטול</button>
    </div>
  </div>`;
}

function renderAddTemplateForm(): string {
  const categoryOptions = [
    { value: 'patrol', label: 'סיור (כרוב/אדנית)' },
    { value: 'hamama', label: 'חממה' },
    { value: 'aruga', label: 'ערוגה' },
    { value: 'mamtera', label: 'ממטרה' },
    { value: 'shemesh', label: 'שמש' },
  ];
  return `<div class="add-form" id="add-template-form">
    <h4>משימה חדשה</h4>
    <div class="form-row">
      <label>שם: <input class="input-sm" type="text" data-field="tpl-name" placeholder="שם משימה" /></label>
      <label>סוג:
        <select class="input-sm" data-field="tpl-type">
          ${TASK_TYPE_OPTIONS.map(t => `<option value="${t}">${TASK_TYPE_LABELS[t] || t}</option>`).join('')}
          <option value="Custom">מותאם אישית</option>
        </select>
      </label>
      <label>קטגוריית תצוגה:
        <select class="input-sm" data-field="tpl-display-category">
          ${categoryOptions.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
          <option value="">מותאם אישית</option>
        </select>
        <input class="input-sm" type="text" data-field="tpl-display-category-custom" placeholder="שם קטגוריה" style="width:120px; display:none;" />
      </label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
      <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="tpl-start" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="1" data-field="tpl-base-load" /></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-light" /> משימה קלה</label>
    </div>
    <div class="form-row">
      <label>תיאור: <input class="input-sm" type="text" data-field="tpl-desc" placeholder="אופציונלי" style="width:300px;" /></label>
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-template">צור</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-template">ביטול</button>
    </div>
  </div>`;
}

// ─── One-Time Task Renderers ─────────────────────────────────────────────────

function renderAddOneTimeForm(): string {
  const numDays = store.getScheduleDays();

  // Build day options: יום 1, יום 2, ... יום N
  const dayOptions = Array.from({ length: numDays }, (_, i) =>
    `<option value="${i + 1}">יום ${i + 1}</option>`
  ).join('');

  const categoryOptions = [
    { value: 'patrol', label: 'סיור (כרוב/אדנית)' },
    { value: 'hamama', label: 'חממה' },
    { value: 'aruga', label: 'ערוגה' },
    { value: 'mamtera', label: 'ממטרה' },
    { value: 'shemesh', label: 'שמש' },
  ];
  return `<div class="add-form" id="add-onetime-form">
    <h4>משימה חד-פעמית חדשה</h4>
    <div class="form-row">
      <label>שם: <input class="input-sm" type="text" data-field="ot-name" placeholder="שם משימה" /></label>
      <label>סוג:
        <select class="input-sm" data-field="ot-type">
          ${TASK_TYPE_OPTIONS.map(t => `<option value="${t}">${TASK_TYPE_LABELS[t] || t}</option>`).join('')}
          <option value="Custom">מותאם אישית</option>
        </select>
      </label>
      <label>קטגוריית תצוגה:
        <select class="input-sm" data-field="ot-display-category">
          ${categoryOptions.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
          <option value="">מותאם אישית</option>
        </select>
      </label>
    </div>
    <div class="form-row">
      <label>יום:
        <select class="input-sm" data-field="ot-day">${dayOptions}</select>
      </label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="ot-start-hour" /></label>
      <label>דקה: <input class="input-sm" type="number" min="0" max="59" value="0" data-field="ot-start-minute" style="width:60px;" /></label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="4" data-field="ot-duration" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="1" data-field="ot-base-load" /></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="ot-samegroup" /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="ot-light" /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="ot-blocks-consecutive" checked /> חוסמת רצף</label>
    </div>
    <div class="form-row">
      <label>תיאור: <input class="input-sm" type="text" data-field="ot-desc" placeholder="אופציונלי" style="width:300px;" /></label>
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-onetime">צור</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-onetime">ביטול</button>
    </div>
  </div>`;
}

function renderOneTimeCard(ot: OneTimeTask): string {
  const schedDate = store.getScheduleDate();
  const otDay = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());
  const schedStart = new Date(schedDate.getFullYear(), schedDate.getMonth(), schedDate.getDate());
  const dayNum = Math.round((otDay.getTime() - schedStart.getTime()) / 86400000) + 1;
  const dateStr = `יום ${dayNum}`;
  const timeStr = fmtHm(ot.startHour, ot.startMinute);
  const endH = ot.startHour + Math.floor(ot.durationHours);
  const endM = ot.startMinute + Math.round((ot.durationHours % 1) * 60);
  const endStr = fmtHm(endH % 24, endM % 60);

  const allSlots = [...ot.slots];
  for (const st of ot.subTeams) allSlots.push(...st.slots);
  const totalSlots = allSlots.length;

  const flags: string[] = [];
  if (ot.isLight) flags.push('קלה');
  if (ot.sameGroupRequired) flags.push('קבוצה');
  if (ot.blocksConsecutive) flags.push('חוסמת');

  return `<div class="template-card">
    <div class="template-header">
      <div class="template-title">
        ${taskTypeBadge(ot.taskType as string)}
        <strong>${escHtml(ot.name)}</strong>
        <span class="text-muted" style="font-size:0.85em;">📅 ${dateStr} ${timeStr}–${endStr} (${ot.durationHours} שע')</span>
      </div>
      <div class="template-actions">
        <button class="btn-xs btn-danger-outline" data-action="delete-onetime" data-ot-id="${ot.id}" title="מחק">✕</button>
      </div>
    </div>
    <div class="template-meta">
      <span class="meta-item">${totalSlots} משבצות</span>
      ${flags.length > 0 ? `<span class="meta-item text-muted">${flags.join(' · ')}</span>` : ''}
      ${ot.description ? `<span class="meta-item text-muted">${escHtml(ot.description)}</span>` : ''}
    </div>
  </div>`;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireTaskRulesEvents(container: HTMLElement, rerender: () => void): void {
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field !== 'tset-saveas-name' && target.dataset.field !== 'tset-rename-name') return;
    if (!_taskSetFormError) return;
    _taskSetFormError = '';
    target.removeAttribute('aria-invalid');
    const errorEl = container.querySelector('#tset-form-error') as HTMLElement | null;
    if (errorEl) errorEl.textContent = '';
  });

  container.addEventListener('change', (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.field === 'tpl-display-category') {
      const customInput = container.querySelector<HTMLInputElement>('[data-field="tpl-display-category-custom"]');
      if (customInput) customInput.style.display = target.value === '' ? 'inline-block' : 'none';
    }
  });

  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // ── Task Set item actions (load/update/rename/duplicate/delete) ──
    const tsetButton = target.closest<HTMLElement>('[data-tset-action]');
    const tsetAction = tsetButton?.dataset.tsetAction;
    if (tsetAction) {
      const tsetId = tsetButton?.dataset.tsetId;
      if (!tsetId) return;
      await _handleTaskSetItemAction(tsetAction, tsetId, rerender);
      return;
    }

    const actionButton = target.closest<HTMLElement>('[data-action]');
    const action = actionButton?.dataset.action;
    if (!action) return;

    switch (action) {
      // ─── Task Sets panel actions ───────────────────────────────────────
      case 'tset-panel-toggle': {
        _taskSetPanelOpen = !_taskSetPanelOpen;
        _taskSetFormMode = 'none';
        _taskSetFormError = '';
        _taskSetRenameTargetId = null;
        rerender();
        break;
      }
      case 'tset-panel-close': {
        _taskSetPanelOpen = false;
        _taskSetFormMode = 'none';
        _taskSetFormError = '';
        _taskSetRenameTargetId = null;
        rerender();
        break;
      }
      case 'tset-new': {
        _taskSetFormMode = 'save-as';
        _taskSetFormError = '';
        rerender();
        break;
      }
      case 'tset-saveas-confirm': {
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="tset-saveas-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="tset-saveas-desc"]');
        const tsetName = nameInput?.value.trim() ?? '';
        const tsetDesc = descInput?.value.trim() ?? '';
        if (!tsetName) {
          _taskSetFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const result = store.saveCurrentAsTaskSet(tsetName, tsetDesc);
        if (!result) {
          _taskSetFormError = 'סט עם שם זה כבר קיים';
          rerender();
          return;
        }
        _taskSetFormMode = 'none';
        _taskSetFormError = '';
        showToast(`סט "${tsetName}" נשמר`, { type: 'success' });
        rerender();
        break;
      }
      case 'tset-rename-confirm': {
        const renameId = _taskSetRenameTargetId ?? store.getActiveTaskSetId();
        if (!renameId) return;
        const rnInput = container.querySelector<HTMLInputElement>('[data-field="tset-rename-name"]');
        const rdInput = container.querySelector<HTMLInputElement>('[data-field="tset-rename-desc"]');
        const rnName = rnInput?.value.trim() ?? '';
        const rnDesc = rdInput?.value.trim() ?? '';
        if (!rnName) {
          _taskSetFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const rnErr = store.renameTaskSet(renameId, rnName, rnDesc);
        if (rnErr) {
          _taskSetFormError = rnErr;
          rerender();
          return;
        }
        _taskSetFormMode = 'none';
        _taskSetFormError = '';
        _taskSetRenameTargetId = null;
        showToast('הסט עודכן בהצלחה', { type: 'success' });
        rerender();
        break;
      }
      case 'tset-form-cancel': {
        _taskSetFormMode = 'none';
        _taskSetFormError = '';
        _taskSetRenameTargetId = null;
        rerender();
        break;
      }

      case 'toggle-template': {
        const tid = actionButton?.closest('[data-tid]')?.getAttribute('data-tid') || actionButton?.dataset.tid!;
        expandedTemplateId = expandedTemplateId === tid ? null : tid;
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'save-template-props': {
        const tid = actionButton?.dataset.tid!;
        const body = actionButton?.closest('.template-body')!;
        const dur = parseFloat((body.querySelector('[data-tpl-field="durationHours"]') as HTMLInputElement)?.value || '8');
        const shifts = parseInt((body.querySelector('[data-tpl-field="shiftsPerDay"]') as HTMLInputElement)?.value || '1');
        const startH = parseInt((body.querySelector('[data-tpl-field="startHour"]') as HTMLInputElement)?.value || '6');
        const baseLoad = parseFloat((body.querySelector('[data-tpl-field="baseLoadWeight"]') as HTMLInputElement)?.value || '1');
        const sameGroup = (body.querySelector('[data-tpl-field="sameGroupRequired"]') as HTMLInputElement)?.checked || false;
        const isLight = (body.querySelector('[data-tpl-field="isLight"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive = (body.querySelector('[data-tpl-field="blocksConsecutive"]') as HTMLInputElement)?.checked || false;
        const togethernessRelevant = (body.querySelector('[data-tpl-field="togethernessRelevant"]') as HTMLInputElement)?.checked || false;
        const requiresCategoryBreak = (body.querySelector('[data-tpl-field="requiresCategoryBreak"]') as HTMLInputElement)?.checked || false;

        store.updateTaskTemplate(tid, {
          durationHours: dur, shiftsPerDay: shifts, startHour: startH,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          sameGroupRequired: sameGroup, isLight, blocksConsecutive, togethernessRelevant, requiresCategoryBreak,
        });
        rerender();
        break;
      }
      case 'add-load-window': {
        const tid = actionButton?.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        const block = actionButton?.closest('.add-slot-form');
        if (!block) break;

        const start = (block.querySelector('[data-field="lw-start"]') as HTMLInputElement | null)?.value || '05:00';
        const end = (block.querySelector('[data-field="lw-end"]') as HTMLInputElement | null)?.value || '06:30';
        const weight = parseFloat((block.querySelector('[data-field="lw-weight"]') as HTMLInputElement | null)?.value || '1');

        const [sh, sm] = start.split(':').map((n) => parseInt(n, 10));
        const [eh, em] = end.split(':').map((n) => parseInt(n, 10));
        if ([sh, sm, eh, em].some(Number.isNaN)) break;

        const newWindow: LoadWindow = {
          id: `lw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          startHour: sh,
          startMinute: sm,
          endHour: eh,
          endMinute: em,
          weight: Math.max(0, Math.min(1, weight)),
        };

        store.updateTaskTemplate(tid, {
          loadWindows: [...(tpl.loadWindows || []), newWindow],
        });
        rerender();
        break;
      }
      case 'update-load-window': {
        const tid = actionButton?.dataset.tid!;
        const lwid = actionButton?.dataset.lwid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;

        const body = actionButton?.closest('.template-body') as HTMLElement | null;
        if (!body) break;
        const startInput = body.querySelector(`[data-field="lw-edit-start"][data-lwid="${lwid}"]`) as HTMLInputElement | null;
        const endInput = body.querySelector(`[data-field="lw-edit-end"][data-lwid="${lwid}"]`) as HTMLInputElement | null;
        const weightInput = body.querySelector(`[data-field="lw-edit-weight"][data-lwid="${lwid}"]`) as HTMLInputElement | null;
        if (!startInput || !endInput || !weightInput) break;

        const [sh, sm] = startInput.value.split(':').map((n) => parseInt(n, 10));
        const [eh, em] = endInput.value.split(':').map((n) => parseInt(n, 10));
        const weight = parseFloat(weightInput.value || '1');
        if ([sh, sm, eh, em].some(Number.isNaN)) break;

        store.updateTaskTemplate(tid, {
          loadWindows: (tpl.loadWindows || []).map((w) =>
            w.id === lwid
              ? {
                  ...w,
                  startHour: sh,
                  startMinute: sm,
                  endHour: eh,
                  endMinute: em,
                  weight: Math.max(0, Math.min(1, weight)),
                }
              : w,
          ),
        });
        rerender();
        break;
      }
      case 'remove-load-window': {
        const tid = actionButton?.dataset.tid!;
        const lwid = actionButton?.dataset.lwid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        store.updateTaskTemplate(tid, {
          loadWindows: (tpl.loadWindows || []).filter((w) => w.id !== lwid),
        });
        rerender();
        break;
      }
      case 'add-subteam': {
        const tid = actionButton?.dataset.tid!;
        const name = await showPrompt('הזן שם לתת-צוות:', { title: 'הוספת תת-צוות' });
        if (!name) return;
        store.addSubTeamToTemplate(tid, name.trim());
        rerender();
        break;
      }
      case 'remove-subteam': {
        const tid = actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid!;
        const okSub = await showConfirm('למחוק את תת-הצוות הזה ואת כל המשבצות שלו?', { danger: true, title: 'מחיקת תת-צוות', confirmLabel: 'מחק' });
        if (okSub) {
          store.removeSubTeamFromTemplate(tid, stid);
          rerender();
        }
        break;
      }
      case 'add-slot': {
        const tid = actionButton?.dataset.tid!;
        addingSlotTo = { templateId: tid };
        rerender();
        break;
      }
      case 'add-slot-subteam': {
        const tid = actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid!;
        addingSlotTo = { templateId: tid, subTeamId: stid };
        rerender();
        break;
      }
      case 'confirm-add-slot': {
        const tid = actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid;
        const form = actionButton?.closest('.add-slot-form')!;
        const label = (form.querySelector('[data-field="slot-label"]') as HTMLInputElement)?.value.trim() || 'משבצת';
        const levels: Level[] = [];
        form.querySelectorAll<HTMLInputElement>('[data-slot-level]').forEach(cb => {
          if (cb.checked) levels.push(parseInt(cb.dataset.slotLevel!) as Level);
        });
        const certs: Certification[] = [];
        form.querySelectorAll<HTMLInputElement>('[data-slot-cert]').forEach(cb => {
          if (cb.checked) certs.push(cb.dataset.slotCert as Certification);
        });
        const forbiddenCerts: Certification[] = [];
        form.querySelectorAll<HTMLInputElement>('[data-slot-forbidden-cert]').forEach(cb => {
          if (cb.checked) forbiddenCerts.push(cb.dataset.slotForbiddenCert as Certification);
        });

        // Validate: same cert cannot be both required and forbidden
        const overlap = certs.filter(c => forbiddenCerts.includes(c));
        if (overlap.length > 0) {
          showToast(`הסמכה לא יכולה להיות גם נדרשת וגם אסורה: ${overlap.join(', ')}`, { type: 'error' });
          break;
        }

        const slot: Omit<SlotTemplate, 'id'> = {
          label, acceptableLevels: levels.map(l => ({ level: l })), requiredCertifications: certs,
          forbiddenCertifications: forbiddenCerts.length > 0 ? forbiddenCerts : undefined,
        };

        if (stid) {
          store.addSlotToSubTeam(tid, stid, slot);
        } else {
          store.addSlotToTemplate(tid, slot);
        }
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'cancel-add-slot': {
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'remove-slot': {
        const tid = actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid;
        const slotId = actionButton?.dataset.slotid!;
        if (stid) {
          store.removeSlotFromSubTeam(tid, stid, slotId);
        } else {
          store.removeSlotFromTemplate(tid, slotId);
        }
        rerender();
        break;
      }
      case 'remove-template': {
        const tid = actionButton?.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (tpl) {
          const okTpl = await showConfirm(`למחוק את התבנית "${tpl.name}"?`, { danger: true, title: 'מחיקת תבנית', confirmLabel: 'מחק' });
          if (okTpl) {
            store.removeTaskTemplate(tid);
            if (expandedTemplateId === tid) expandedTemplateId = null;
            rerender();
          }
        }
        break;
      }
      case 'toggle-add-template': {
        showAddTemplate = !showAddTemplate;
        rerender();
        break;
      }
      case 'confirm-add-template': {
        const form = container.querySelector('#add-template-form')!;
        const name = (form.querySelector('[data-field="tpl-name"]') as HTMLInputElement)?.value.trim();
        if (!name) return;
        const type = (form.querySelector('[data-field="tpl-type"]') as HTMLSelectElement)?.value || 'Custom';
        const dur = parseFloat((form.querySelector('[data-field="tpl-duration"]') as HTMLInputElement)?.value || '8');
        const shifts = parseInt((form.querySelector('[data-field="tpl-shifts"]') as HTMLInputElement)?.value || '1');
        const startH = parseInt((form.querySelector('[data-field="tpl-start"]') as HTMLInputElement)?.value || '6');
        const baseLoad = parseFloat((form.querySelector('[data-field="tpl-base-load"]') as HTMLInputElement)?.value || '1');
        const sameGroup = (form.querySelector('[data-field="tpl-samegroup"]') as HTMLInputElement)?.checked || false;
        const isLight = (form.querySelector('[data-field="tpl-light"]') as HTMLInputElement)?.checked || false;
        const desc = (form.querySelector('[data-field="tpl-desc"]') as HTMLInputElement)?.value.trim();

        const catSelect = form.querySelector<HTMLSelectElement>('[data-field="tpl-display-category"]');
        const catCustom = form.querySelector<HTMLInputElement>('[data-field="tpl-display-category-custom"]');
        let displayCategory = catSelect?.value || '';
        if (!displayCategory && catCustom?.value) displayCategory = catCustom.value.trim().toLowerCase();
        if (!displayCategory) {
          // Auto-derive from type
          switch (type) {
            case 'Karov': case 'Karovit': case 'Adanit': displayCategory = 'patrol'; break;
            case 'Hamama': displayCategory = 'hamama'; break;
            case 'Aruga': displayCategory = 'aruga'; break;
            case 'Mamtera': displayCategory = 'mamtera'; break;
            case 'Shemesh': displayCategory = 'shemesh'; break;
            default: displayCategory = (type || 'custom').toLowerCase(); break;
          }
        }

        store.addTaskTemplate({
          name,
          taskType: type as TaskType,
          durationHours: dur,
          shiftsPerDay: shifts,
          startHour: startH,
          sameGroupRequired: sameGroup,
          isLight,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          loadWindows: [],
          blocksConsecutive: !isLight,
          togethernessRelevant: false,
          requiresCategoryBreak: false,
          displayCategory,
          subTeams: [],
          slots: [],
          description: desc || undefined,
        });
        showAddTemplate = false;
        rerender();
        break;
      }
      case 'cancel-add-template': {
        showAddTemplate = false;
        rerender();
        break;
      }

      // ─── One-Time Task actions ────────────────────────────────────────
      case 'toggle-add-onetime': {
        showAddOneTime = !showAddOneTime;
        rerender();
        break;
      }
      case 'confirm-add-onetime': {
        const form = container.querySelector('#add-onetime-form')!;
        const name = (form.querySelector('[data-field="ot-name"]') as HTMLInputElement)?.value.trim();
        if (!name) return;
        const type = (form.querySelector('[data-field="ot-type"]') as HTMLSelectElement)?.value || 'Custom';
        const dayNum = parseInt((form.querySelector('[data-field="ot-day"]') as HTMLSelectElement)?.value || '1');
        const schedDate = store.getScheduleDate();
        const scheduledDate = new Date(schedDate.getFullYear(), schedDate.getMonth(), schedDate.getDate() + dayNum - 1);

        const startHour = parseInt((form.querySelector('[data-field="ot-start-hour"]') as HTMLInputElement)?.value || '6');
        const startMinute = parseInt((form.querySelector('[data-field="ot-start-minute"]') as HTMLInputElement)?.value || '0');
        const dur = parseFloat((form.querySelector('[data-field="ot-duration"]') as HTMLInputElement)?.value || '4');
        const baseLoad = parseFloat((form.querySelector('[data-field="ot-base-load"]') as HTMLInputElement)?.value || '1');
        const sameGroup = (form.querySelector('[data-field="ot-samegroup"]') as HTMLInputElement)?.checked || false;
        const isLight = (form.querySelector('[data-field="ot-light"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive = (form.querySelector('[data-field="ot-blocks-consecutive"]') as HTMLInputElement)?.checked ?? true;
        const desc = (form.querySelector('[data-field="ot-desc"]') as HTMLInputElement)?.value.trim();
        const catSelect = form.querySelector<HTMLSelectElement>('[data-field="ot-display-category"]');
        let displayCategory = catSelect?.value || '';
        if (!displayCategory) {
          switch (type) {
            case 'Karov': case 'Karovit': case 'Adanit': displayCategory = 'patrol'; break;
            case 'Hamama': displayCategory = 'hamama'; break;
            case 'Aruga': displayCategory = 'aruga'; break;
            case 'Mamtera': displayCategory = 'mamtera'; break;
            case 'Shemesh': displayCategory = 'shemesh'; break;
            default: displayCategory = (type || 'custom').toLowerCase(); break;
          }
        }

        store.addOneTimeTask({
          name,
          taskType: type as TaskType,
          scheduledDate,
          startHour,
          startMinute,
          durationHours: dur,
          sameGroupRequired: sameGroup,
          isLight,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          loadWindows: [],
          blocksConsecutive,
          togethernessRelevant: false,
          requiresCategoryBreak: false,
          displayCategory,
          subTeams: [],
          slots: [],
          description: desc || undefined,
        });
        showAddOneTime = false;
        rerender();
        break;
      }
      case 'cancel-add-onetime': {
        showAddOneTime = false;
        rerender();
        break;
      }
      case 'delete-onetime': {
        const otId = actionButton?.dataset.otId;
        if (!otId) return;
        const ok = await showConfirm('למחוק את המשימה החד-פעמית?', {
          danger: true,
          title: 'מחיקת משימה',
          confirmLabel: 'מחק',
        });
        if (!ok) return;
        store.removeOneTimeTask(otId);
        rerender();
        break;
      }
    }
  });
}

// ─── Task Set Item Actions ───────────────────────────────────────────────────

async function _handleTaskSetItemAction(action: string, id: string, rerender: () => void): Promise<void> {
  switch (action) {
    case 'load': {
      const ok = await showConfirm('טעינת הסט תחליף את כל תבניות המשימות הנוכחיות. להמשיך?', {
        danger: true,
        title: 'טעינת סט משימות',
        confirmLabel: 'טען',
      });
      if (!ok) return;
      store.loadTaskSet(id);
      showToast('הסט נטען בהצלחה', { type: 'success' });
      rerender();
      break;
    }
    case 'update': {
      const ok = await showConfirm('לעדכן את הסט לפי תבניות המשימות הנוכחיות?', {
        title: 'עדכון סט',
        confirmLabel: 'עדכן',
      });
      if (!ok) return;
      store.updateTaskSet(id);
      showToast('הסט עודכן', { type: 'success' });
      rerender();
      break;
    }
    case 'rename': {
      _taskSetRenameTargetId = id;
      _taskSetFormMode = 'rename';
      _taskSetFormError = '';
      rerender();
      break;
    }
    case 'duplicate': {
      store.duplicateTaskSet(id);
      showToast('הסט שוכפל', { type: 'success' });
      rerender();
      break;
    }
    case 'delete': {
      const tset = store.getTaskSetById(id);
      if (!tset || tset.builtIn) return;
      const ok = await showConfirm(`למחוק את הסט "${tset.name}"? לא ניתן לבטל פעולה זו.`, {
        danger: true,
        title: 'מחיקת סט',
        confirmLabel: 'מחק',
      });
      if (!ok) return;
      store.deleteTaskSet(id);
      _taskSetFormMode = 'none';
      _taskSetFormError = '';
      _taskSetRenameTargetId = null;
      showToast('הסט נמחק', { type: 'success' });
      rerender();
      break;
    }
  }
}
