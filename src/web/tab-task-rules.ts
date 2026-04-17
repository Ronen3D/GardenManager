/**
 * Task Rules Tab — Stage 0 Configuration UI
 *
 * Edit task templates, constraint builder, sub-team management,
 * and real-time preflight validation panel.
 */

import {
  type CertificationDefinition,
  Level,
  type LoadFormula,
  type LoadWindow,
  type OneTimeTask,
  type PreflightResult,
  PreflightSeverity,
  RestRule,
  type LoadFormulaSnapshotEntry,
  type SlotTemplate,
  type SubTeamTemplate,
  type TaskSet,
  type TaskTemplate,
} from '../models/types';
import * as store from './config-store';
import { initLoadFormulaModal, openLoadFormulaModal } from './load-formula-modal';
import { runPreflight } from './preflight';
import { escHtml, SVG_ICONS } from './ui-helpers';
import { showConfirm, showPrompt, showToast } from './ui-modal';
import { detectStale } from './utils/load-formula';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  durationHours: 'משך',
  shiftsPerDay: 'משמרות/יום',
  startHour: 'שעת התחלה',
  eveningStartHour: 'שעת ערב',
};

/** Show a warning toast if any numeric field was clamped by sanitization. */
function notifyIfClamped(raw: Record<string, number | undefined>, sanitized: Record<string, number | undefined>): void {
  const corrections: string[] = [];
  for (const key of Object.keys(raw)) {
    const r = raw[key],
      s = sanitized[key];
    if (r !== undefined && s !== undefined && r !== s) {
      // Wrap the numeric "raw → sanitized" transition in an LRI/PDI bidi isolate
      // (U+2066 … U+2069) so it renders LTR inside the Hebrew toast, keeping the
      // older value on the left and the corrected value on the right.
      corrections.push(`${FIELD_LABELS[key] || key}: \u2066${r} → ${s}\u2069`);
    }
  }
  if (corrections.length) {
    showToast(`ערכים לא תקינים תוקנו: ${corrections.join(', ')}`, { type: 'warning', duration: 5000 });
  }
}

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
function getCertOptions(): CertificationDefinition[] {
  return store.getCertificationDefinitions();
}

function templateBadge(tpl: { color?: string; name: string }): string {
  const color = tpl.color || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${escHtml(tpl.name)}</span>`;
}

/** Check if any slot in a template references a deleted certification. */
function hasOrphanedSlotCerts(tpl: {
  slots: { requiredCertifications: string[]; forbiddenCertifications?: string[] }[];
  subTeams: { slots: { requiredCertifications: string[]; forbiddenCertifications?: string[] }[] }[];
}): boolean {
  const activeCertIds = new Set(getCertOptions().map((d) => d.id));
  const allSlots = [...tpl.slots, ...tpl.subTeams.flatMap((st) => st.slots)];
  return allSlots.some(
    (s) =>
      s.requiredCertifications.some((c) => !activeCertIds.has(c)) ||
      (s.forbiddenCertifications || []).some((c) => !activeCertIds.has(c)),
  );
}

function levelBadge(level: Level): string {
  const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
  return `<span class="badge badge-sm" style="background:${colors[level]}">${level}</span>`;
}

function certBadge(certId: string): string {
  const def = store.getCertificationById(certId);
  if (!def) {
    return `<span class="badge badge-sm badge-orphan" title="הסמכה שנמחקה: ${escHtml(certId)}">⚠ ${escHtml(certId)}</span>`;
  }
  if (def.deleted) {
    return `<span class="badge badge-sm badge-orphan" title="הסמכה שנמחקה: ${escHtml(def.label)}">⚠ ${escHtml(def.label)}</span>`;
  }
  return `<span class="badge badge-sm" style="background:${def.color}">${escHtml(def.label)}</span>`;
}

function forbiddenCertBadge(certId: string): string {
  const def = store.getCertificationById(certId);
  if (!def) {
    return `<span class="badge badge-sm badge-orphan" title="הסמכה אסורה שנמחקה: ${escHtml(certId)}" style="text-decoration:line-through">⚠ ${escHtml(certId)}</span>`;
  }
  if (def.deleted) {
    return `<span class="badge badge-sm badge-orphan" title="הסמכה אסורה שנמחקה: ${escHtml(def.label)}" style="text-decoration:line-through">⚠ ${escHtml(def.label)}</span>`;
  }
  return `<span class="badge badge-sm" style="background:#c0392b;text-decoration:line-through">${escHtml(def.label)}</span>`;
}

/** Badge for a rest rule assignment (header display). */
function _restRuleBadge(restRuleId?: string): string {
  if (!restRuleId) return '';
  const rule = store.getRestRuleById(restRuleId);
  if (!rule) return `<span class="badge badge-sm badge-orphan" title="כלל מרווח שנמחק">⚠ כלל חסר</span>`;
  if (rule.deleted)
    return `<span class="badge badge-sm badge-orphan" title="כלל מרווח שנמחק: ${escHtml(rule.label)}">⚠ ${escHtml(rule.label)}</span>`;
  return `<span class="badge badge-sm badge-outline">${escHtml(rule.label)} ${rule.durationHours} שע׳</span>`;
}

/** Inline orphan warning if a task references a deleted/missing rest rule. */
function _restRuleOrphanNote(restRuleId?: string): string {
  if (!restRuleId) return '';
  const rule = store.getRestRuleById(restRuleId);
  if (!rule || rule.deleted) {
    const label = rule ? rule.label : restRuleId;
    return ` <span class="badge-orphan-label" style="font-size:0.78rem;">⚠ כלל "${escHtml(label)}" נמחק — המרווח לא פעיל</span>`;
  }
  return '';
}

/** Strip English level references (L0, L3/L4, (L2+), etc.) from a slot label. */
function stripLevelText(label: string): string {
  return label
    .replace(/\s*\(?L\d[\d/+L]*\)?\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function fmtHm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parse an HH:MM string with range validation (00:00–23:59). */
function parseHm(value: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** Treat a load window as a half-open clock-time interval and return the set of
 *  minutes (mod 1440) it covers. End-touching windows (e.g. 05:00–06:30 and
 *  06:30–07:00) do not share any minute, so they don't overlap. Windows where
 *  end ≤ start are interpreted as crossing midnight. */
function loadWindowMinuteSet(w: { startHour: number; startMinute: number; endHour: number; endMinute: number }): Set<number> {
  const start = w.startHour * 60 + w.startMinute;
  let end = w.endHour * 60 + w.endMinute;
  if (end <= start) end += 1440;
  const out = new Set<number>();
  for (let m = start; m < end; m++) out.add(m % 1440);
  return out;
}

function loadWindowsOverlap(
  a: { startHour: number; startMinute: number; endHour: number; endMinute: number },
  b: { startHour: number; startMinute: number; endHour: number; endMinute: number },
): boolean {
  const aMin = loadWindowMinuteSet(a);
  for (const m of loadWindowMinuteSet(b)) if (aMin.has(m)) return true;
  return false;
}

// ─── State ───────────────────────────────────────────────────────────────────

let expandedTemplateId: string | null = null;
let expandedOtId: string | null = null;
let addingSlotTo: { templateId: string; subTeamId?: string; isOneTime?: boolean } | null = null;
let editingSlot: { templateId: string; subTeamId?: string; slotId: string; isOneTime?: boolean } | null = null;
let showAddTemplate = false;
let showAddOneTime = false;

/**
 * Pending load formulas for the "new task" forms. Populated when the user opens
 * the load-formula modal from the add form and saves a formula; cleared when
 * the add form closes (confirm or cancel) or the load-formula modal clears it.
 * Survives re-renders of the add form so reopening the modal shows the in-progress formula.
 */
let _pendingTplLoadFormula: LoadFormula | undefined;
let _pendingOtLoadFormula: LoadFormula | undefined;

// ─── Task Sets Panel State ───────────────────────────────────────────────────

let _taskSetPanelOpen = false;
let _taskSetFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _taskSetFormError = '';
let _taskSetRenameTargetId: string | null = null;

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderTaskRulesTab(): string {
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  const criticals = preflight.findings.filter((f) => f.severity === PreflightSeverity.Critical);

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
      html += renderOneTimeCard(ot, preflight);
    }
    html += '</div>';
  }

  // ── Rest Rules Management ──
  const restRules = store.getRestRules();
  html += `
  <div class="tab-toolbar" style="margin-top:24px; border-top:1px solid var(--border); padding-top:16px;">
    <div class="toolbar-left">
      <h2 style="display:flex; align-items:center; gap:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.7;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        כללי מרווחים מינימליים
        <span class="count">${restRules.length}</span>
      </h2>
    </div>
    <div class="toolbar-right">
      <button class="btn-sm btn-primary" data-action="add-rest-rule">+ הוסף כלל</button>
    </div>
  </div>
  <div class="template-card global-settings-card" style="margin-top:8px;">
    <div style="padding:14px 18px;">
      <span style="font-size:0.78rem; color:var(--text-muted);">משימות המשויכות לאותו כלל (או לכללים שונים) לא ישובצו ברצף — תישמר הפסקה מינימלית ביניהן</span>
      ${
        restRules.length === 0
          ? '<div style="padding:12px 0; color:var(--text-muted); font-size:0.88rem; text-align:center;">אין כללים מוגדרים. לחץ "הוסף כלל" ליצירת כלל חדש.</div>'
          : `
      <table style="width:100%; margin-top:10px; border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid var(--border);">
          <th style="text-align:right; padding:6px 8px; font-size:0.82rem; font-weight:500;">שם</th>
          <th style="text-align:center; padding:6px 8px; font-size:0.82rem; font-weight:500; width:90px;">שעות</th>
          <th style="width:80px;"></th>
        </tr></thead>
        <tbody>${restRules
          .map(
            (r) => `
          <tr data-rest-rule-id="${r.id}" style="border-bottom:1px solid var(--border-light, var(--border));">
            <td style="padding:8px;">
              <input type="text" class="input-sm" data-rr-field="label" value="${escHtml(r.label)}" style="width:100%;" />
            </td>
            <td style="padding:8px; text-align:center;">
              <input type="number" class="input-sm" data-rr-field="durationHours" value="${r.durationHours}" min="0.5" max="24" step="0.5" style="width:60px; text-align:center;" />
            </td>
            <td style="padding:8px; text-align:center;">
              <button class="btn-xs btn-outline" data-action="save-rest-rule" data-rr-id="${r.id}" title="שמור">✓</button>
              <button class="btn-xs btn-danger-outline" data-action="delete-rest-rule" data-rr-id="${r.id}" title="מחק">✕</button>
            </td>
          </tr>
        `,
          )
          .join('')}</tbody>
      </table>`
      }
    </div>
  </div>`;

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
        <button class="btn-sm btn-primary" data-action="tset-saveas-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="tset-form-cancel">ביטול</button>
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
        <button class="btn-sm btn-primary" data-action="tset-rename-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="tset-form-cancel">ביטול</button>
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
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-tset-action="delete" data-tset-id="${s.id}" title="מחק">${SVG_ICONS.trash}</button>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function buildTaskSetLoadConfirmMessage(taskSet: TaskSet): string {
  return `טעינת הסט תחליף את תבניות המשימות, את המשימות החד-פעמיות, ואת כללי המרווחים המינימליים. להמשיך?`;
}

function renderTemplateCard(tpl: TaskTemplate, pf: PreflightResult): string {
  const isExpanded = expandedTemplateId === tpl.id;
  const relatedFindings = pf.findings.filter((f) => f.templateId === tpl.id);
  const hasCritical = relatedFindings.some((f) => f.severity === PreflightSeverity.Critical);
  const hasWarning = relatedFindings.some((f) => f.severity === PreflightSeverity.Warning);

  const allSlots = [...tpl.slots];
  for (const st of tpl.subTeams) allSlots.push(...st.slots);
  const totalSlots = allSlots.length;
  const totalPeople = totalSlots * tpl.shiftsPerDay;

  const hasOrphans = hasOrphanedSlotCerts(tpl);
  const alertClass = hasCritical ? 'template-card-error' : hasWarning ? 'template-card-warn' : '';

  let html = `<div class="template-card ${alertClass}" data-template-id="${tpl.id}">
    <div class="template-header" data-action="toggle-template" data-tid="${tpl.id}">
      <div class="template-title">
        ${templateBadge(tpl)}
        <strong>${escHtml(tpl.name)}</strong>
        <span class="text-muted"> · ${tpl.shiftsPerDay} משמרות × ${tpl.durationHours} שע׳ — ${totalPeople} איש/יום</span>
        ${hasCritical ? '<span class="badge badge-sm" style="background:var(--danger)">!</span>' : ''}
        ${hasWarning && !hasCritical ? '<span class="badge badge-sm" style="background:var(--warning)">⚠</span>' : ''}
        ${hasOrphans ? '<span class="badge badge-sm badge-orphan">⚠</span>' : ''}
      </div>
      <div class="template-toggles">
        ${tpl.sameGroupRequired ? '<span class="badge badge-sm badge-outline">נדרשת אותה קבוצה</span>' : ''}
        ${tpl.isLight ? '<span class="badge badge-sm badge-outline">קלה</span>' : ''}
        ${(tpl.blocksConsecutive ?? !tpl.isLight) ? '' : '<span class="badge badge-sm badge-outline">ניתן לשבץ ברצף</span>'}
        ${tpl.togethernessRelevant ? '<span class="badge badge-sm badge-outline">אי התאמה</span>' : ''}
        ${_restRuleBadge(tpl.restRuleId)}
        <span class="expand-arrow">${isExpanded ? '▼' : '▶'}</span>
      </div>
    </div>`;

  if (isExpanded) {
    html += `<div class="template-body">`;

    // Template properties
    html += `<div class="template-props">
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" data-tpl-field="durationHours" value="${tpl.durationHours}" data-tid="${tpl.id}" /></label>
      <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" data-tpl-field="shiftsPerDay" value="${tpl.shiftsPerDay}" data-tid="${tpl.id}" /></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" data-tpl-field="startHour" value="${tpl.startHour}" data-tid="${tpl.id}" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-tpl-field="baseLoadWeight" value="${(tpl.baseLoadWeight ?? (tpl.isLight ? 0 : 1)).toFixed(2)}" data-tid="${tpl.id}" />${renderLoadFormulaControls({ kind: 'base', tpl, disabled: tpl.isLight })}</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="sameGroupRequired" data-tid="${tpl.id}" ${tpl.sameGroupRequired ? 'checked' : ''} /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="isLight" data-tid="${tpl.id}" ${tpl.isLight ? 'checked' : ''} /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="blocksConsecutive" data-tid="${tpl.id}" ${(tpl.blocksConsecutive ?? !tpl.isLight) ? 'checked' : ''} /> חוסם רצף משימות</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="togethernessRelevant" data-tid="${tpl.id}" ${tpl.togethernessRelevant ? 'checked' : ''} /> אי התאמה</label>
      <label>כלל מרווח: <select class="input-sm" data-tpl-field="restRuleId" data-tid="${tpl.id}">
        <option value=""${!tpl.restRuleId ? ' selected' : ''}>ללא</option>
        ${store
          .getRestRules()
          .map(
            (r) =>
              `<option value="${r.id}"${tpl.restRuleId === r.id ? ' selected' : ''}>${escHtml(r.label)} (${r.durationHours} שע׳)</option>`,
          )
          .join('')}
      </select></label>${_restRuleOrphanNote(tpl.restRuleId)}
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

type LoadFormulaControlTarget =
  | { kind: 'base'; tpl: TaskTemplate; disabled: boolean }
  | { kind: 'window'; tpl: TaskTemplate; window: LoadWindow; disabled: boolean };

function renderLoadFormulaControls(target: LoadFormulaControlTarget): string {
  const { kind, tpl, disabled } = target;
  const formula = kind === 'base' ? tpl.loadFormula : target.window.loadFormula;
  const lwid = kind === 'window' ? ` data-lwid="${target.window.id}"` : '';
  const openBtn = `<button class="btn-xs btn-outline lf-open-btn" type="button" data-action="open-load-formula" data-lf-kind="${kind}" data-tid="${tpl.id}"${lwid}${disabled ? ' disabled' : ''} title="הגדר לפי השוואה" aria-label="הגדר לפי השוואה">🧮</button>`;
  const infoBtn = formula
    ? `<button class="btn-xs btn-outline lf-info-btn" type="button" data-action="toggle-load-formula-info" data-lf-kind="${kind}" data-tid="${tpl.id}"${lwid} title="הצג הסבר" aria-label="הצג הסבר">ℹ️</button>`
    : '';
  return `<span class="lf-controls">${openBtn}${infoBtn}</span>`;
}

function renderLoadFormulaExplanation(tpl: TaskTemplate, kind: 'base' | 'window', windowId: string | null): string {
  const formula =
    kind === 'base' ? tpl.loadFormula : (tpl.loadWindows ?? []).find((w) => w.id === windowId)?.loadFormula;
  if (!formula) return '';

  const templates = new Map<string, TaskTemplate>();
  for (const t of store.getAllTaskTemplates()) templates.set(t.id, t);
  const stale = detectStale(formula, templates);

  const d = new Date(formula.computedAt);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const when = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const targetHours = formula.targetHours && formula.targetHours > 0 ? formula.targetHours : 1;
  const hoursPhrase = (n: number): string => {
    if (n === 1) return 'שעה אחת';
    if (n === 0.5) return 'חצי שעה';
    if (n === 0.25) return 'רבע שעה';
    if (n === 0.75) return 'שלושת רבעי שעה';
    if (n === 2) return 'שעתיים';
    return `${n} שעות`;
  };
  // "במצב בסיס" is only meaningful if the ref task has (or had) hot windows to distinguish from.
  // Checks current state so drifted refs read naturally.
  const rateText = (snap: LoadFormulaSnapshotEntryLocal & { templateId?: string }): string => {
    if (snap.rate.kind === 'window') {
      return `בחלון החם ${escHtml(snap.rate.windowLabel)} (קצב ${snap.rate.value.toFixed(2)} לשעה)`;
    }
    const refTpl = snap.templateId ? templates.get(snap.templateId) : undefined;
    const currentHasWindows = !!refTpl && (refTpl.loadWindows ?? []).length > 0;
    const where = currentHasWindows ? 'במצב בסיס ' : '';
    return `${where}(קצב ${snap.rate.value.toFixed(2)} לשעה)`;
  };

  // Detect ref tasks that gained hot windows since save — those now need "במצב בסיס" disambiguation
  // that wasn't needed at save time.
  const gainedWindows = (snap: LoadFormulaSnapshotEntry): boolean => {
    if (snap.rate.kind !== 'base') return false;
    if (snap.refHadLoadWindows !== false) return false;
    const refTpl = templates.get(snap.templateId);
    return !!refTpl && (refTpl.loadWindows ?? []).length > 0;
  };
  const gainedList: string[] = [];

  const lhsExtras = formula.lhsExtras ?? [];
  const lhsSnap = formula.lhsExtrasSnapshot ?? [];
  let body = `<div class="lf-info-header">עומס לשעה: <strong>${formula.computedValue.toFixed(2)}</strong></div>`;

  // Intro sentence — state the equation's left side verbally.
  const targetPhrase = hoursPhrase(targetHours) + ' של המשימה';
  if (lhsExtras.length) {
    const parts = lhsExtras
      .map((c, i) => {
        const snap = lhsSnap[i];
        if (!snap) return '';
        if (snap.missing)
          return `${hoursPhrase(c.hours)} של ${escHtml(snap.templateName)} <span class="lf-info-note">(נמחק)</span>`;
        if (gainedWindows(snap) && !gainedList.includes(snap.templateName)) gainedList.push(snap.templateName);
        return `${hoursPhrase(c.hours)} של ${escHtml(snap.templateName)} ${rateText(snap)}`;
      })
      .filter(Boolean);
    body += `<div class="lf-info-intro">${targetPhrase}, בצירוף ${parts.join(' ובצירוף ')}, שקולות בעומס לסכום של:</div>`;
  } else if (targetHours !== 1) {
    body += `<div class="lf-info-intro">${targetPhrase} שקולות בעומס לסכום של:</div>`;
  } else {
    body += `<div class="lf-info-intro">${targetPhrase} שקולה בעומס לסכום של:</div>`;
  }

  body += '<ul class="lf-info-list">';
  let rawSum = 0;
  let lhsSum = 0;
  for (let i = 0; i < formula.components.length; i++) {
    const c = formula.components[i];
    const snap = formula.snapshot[i];
    if (!snap) continue;
    if (snap.missing) {
      body += `<li class="lf-info-row lf-info-missing">${hoursPhrase(c.hours)} של ${escHtml(snap.templateName)} <span class="lf-info-note">(נמחק)</span></li>`;
      continue;
    }
    const product = c.hours * snap.rate.value;
    rawSum += product;
    const driftHint =
      stale.entries[i] &&
      stale.entries[i].currentValue !== null &&
      Math.abs((stale.entries[i].currentValue as number) - snap.rate.value) > 1e-9
        ? ` <span class="lf-info-stale">(הקצב כעת ${(stale.entries[i].currentValue as number).toFixed(2)})</span>`
        : '';
    if (gainedWindows(snap) && !gainedList.includes(snap.templateName)) gainedList.push(snap.templateName);
    body += `<li class="lf-info-row">${hoursPhrase(c.hours)} של <strong>${escHtml(snap.templateName)}</strong> ${rateText(snap)} — תרומה <strong>${product.toFixed(2)}</strong>${driftHint}</li>`;
  }
  body += '</ul>';

  // Sum LHS extras (for the arithmetic in the summary below).
  for (let i = 0; i < lhsExtras.length; i++) {
    const c = lhsExtras[i];
    const snap = lhsSnap[i];
    if (!snap || snap.missing) continue;
    lhsSum += c.hours * snap.rate.value;
  }
  const netRaw = rawSum - lhsSum;
  const perHourRaw = netRaw / targetHours;

  // Summary in plain language.
  let summary = `סך תרומות הרכיבים: <strong>${rawSum.toFixed(2)}</strong>`;
  if (lhsExtras.length) {
    summary += `. תרומת הצד העליון הנוסף מקוזזת (${lhsSum.toFixed(2)}), ונשאר ${netRaw.toFixed(2)} עבור ${hoursPhrase(targetHours)} של המשימה`;
  } else if (targetHours !== 1) {
    summary += ` עבור ${hoursPhrase(targetHours)} של המשימה`;
  }
  if (targetHours !== 1 || lhsExtras.length) {
    summary += `. לשעה בודדת: <strong>${perHourRaw.toFixed(2)}</strong>`;
  } else {
    summary += ` לשעה`;
  }
  summary += '.';
  body += `<div class="lf-info-summary">${summary}</div>`;

  if (perHourRaw > 1 + 1e-9) {
    body += `<div class="lf-info-clamp">הערך חורג מהמקסימום (1.00) ולכן נחתך ל-1.00.</div>`;
  } else if (perHourRaw < -1e-9) {
    body += `<div class="lf-info-clamp">הצד העליון גדול מסכום הרכיבים, לכן הערך נחתך ל-0.00.</div>`;
  }
  if (stale.stale) {
    body += `<div class="lf-info-warn">⚠ ערכי הקצב של רכיבי ההשוואה השתנו מאז שנשמר. פתח ושמור מחדש כדי לעדכן.</div>`;
  }
  if (gainedList.length) {
    const names = gainedList.map((n) => escHtml(n)).join(', ');
    body += `<div class="lf-info-warn">⚠ ל-${names} נוספו חלונות עומס מוגבר אחרי חישוב העומס. שמור מחדש את ההשוואה כדי לרענן.</div>`;
  }
  body += `<div class="lf-info-when">נשמר ב-${when}</div>`;
  return `<div class="lf-info-popover">${body}</div>`;
}

// Local structural alias used for the rate-text helper (avoids importing the snapshot entry type here).
type LoadFormulaSnapshotEntryLocal = {
  rate: { kind: 'base'; value: number } | { kind: 'window'; windowId: string; windowLabel: string; value: number };
};

function renderLoadWindowsEditor(tpl: TaskTemplate): string {
  const windows = tpl.loadWindows ?? [];
  let html = `<div class="lw-editor">
    <div class="lw-editor-header">
      <h4 class="lw-editor-title">חלונות עומס מוגבר</h4>
      <span class="lw-editor-count">${windows.length === 0 ? 'אין חלונות' : windows.length === 1 ? 'חלון אחד' : `${windows.length} חלונות`}</span>
    </div>
    <p class="lw-editor-help text-muted">טווחי שעות בהם המשימה נחשבת עומס מוגבר. לכל חלון משקל בין 0 ל-1.</p>`;

  if (windows.length === 0) {
    html += '<p class="lw-empty">לא הוגדרו חלונות עומס. משקל העומס חל על כל המשימה.</p>';
  } else {
    html += `<div class="lw-list" role="list">
      <div class="lw-row lw-row-head" aria-hidden="true">
        <span class="lw-col-label lw-col-time">טווח שעות</span>
        <span class="lw-col-label lw-col-weight">משקל</span>
        <span class="lw-col-label lw-col-actions">פעולות</span>
      </div>`;
    for (const w of windows) {
      html += `<div class="lw-row" role="listitem">
        <div class="lw-time">
          <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-edit-start" data-lwid="${w.id}" value="${fmtHm(w.startHour, w.startMinute)}" aria-label="שעת התחלה" />
          <span class="lw-sep" aria-hidden="true">–</span>
          <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-edit-end" data-lwid="${w.id}" value="${fmtHm(w.endHour, w.endMinute)}" aria-label="שעת סיום" />
        </div>
        <div class="lw-weight">
          <input class="input-sm lw-weight-input" type="number" step="0.05" min="0" max="1" data-field="lw-edit-weight" data-lwid="${w.id}" value="${w.weight.toFixed(2)}" aria-label="משקל" />
          ${renderLoadFormulaControls({ kind: 'window', tpl, window: w, disabled: false })}
        </div>
        <div class="lw-actions">
          <button class="lw-btn lw-save" data-action="update-load-window" data-tid="${tpl.id}" data-lwid="${w.id}" title="שמור שינויים" aria-label="שמור שינויים">✓</button>
          <button class="lw-btn lw-remove" data-action="remove-load-window" data-tid="${tpl.id}" data-lwid="${w.id}" title="מחק חלון" aria-label="מחק חלון">✕</button>
        </div>
      </div>`;
    }
    html += '</div>';
  }

  html += `<div class="lw-add-form add-slot-form">
    <div class="lw-add-caption">הוספת חלון חדש</div>
    <div class="lw-row lw-row-add" role="group" aria-label="הוספת חלון חדש">
      <div class="lw-time">
        <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-start" value="05:00" aria-label="שעת התחלה" />
        <span class="lw-sep" aria-hidden="true">–</span>
        <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-end" value="06:30" aria-label="שעת סיום" />
      </div>
      <div class="lw-weight">
        <input class="input-sm lw-weight-input" type="number" step="0.05" min="0" max="1" data-field="lw-weight" value="1" aria-label="משקל (0-1)" />
        <button class="btn-xs btn-outline lf-open-btn" type="button" data-action="add-load-window-and-compute" data-tid="${tpl.id}" title="הוסף וחשב לפי השוואה" aria-label="הוסף וחשב לפי השוואה">🧮</button>
      </div>
      <div class="lw-actions">
        <button class="lw-btn lw-save" data-action="add-load-window" data-tid="${tpl.id}" title="הוסף חלון" aria-label="הוסף חלון">+</button>
      </div>
    </div>
  </div>
  </div>`;

  return html;
}

function renderSubTeam(templateId: string, st: SubTeamTemplate, pf: PreflightResult, opts?: { isOneTime?: boolean }): string {
  const idAttr = opts?.isOneTime ? `data-ot-id="${templateId}"` : `data-tid="${templateId}"`;
  let html = `<div class="subteam-card">
    <div class="subteam-header">
      <strong>${escHtml(st.name)}</strong>
      <span class="text-muted">(${st.slots.length} משבצות)</span>
      <button class="btn-sm btn-outline" data-action="add-slot-subteam" ${idAttr} data-stid="${st.id}">+ משבצת</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-subteam" ${idAttr} data-stid="${st.id}">✕</button>
    </div>`;

  html += renderSlotTable(templateId, st.slots, st.id, pf, opts);

  const isOtMatch = opts?.isOneTime ? addingSlotTo?.isOneTime : !addingSlotTo?.isOneTime;
  if (addingSlotTo && addingSlotTo.templateId === templateId && addingSlotTo.subTeamId === st.id && isOtMatch) {
    html += renderAddSlotForm(templateId, st.id, opts);
  }

  html += `</div>`;
  return html;
}

function renderSlotTable(
  templateId: string,
  slots: SlotTemplate[],
  subTeamId: string | undefined,
  pf: PreflightResult,
  opts?: { isOneTime?: boolean },
): string {
  if (slots.length === 0) return '<p class="text-muted" style="padding:4px 0;">אין משבצות מוגדרות.</p>';

  let html = `<div class="table-responsive"><table class="table table-slots">
    <thead><tr><th>תווית</th><th>דרגות</th><th>הסמכות נדרשות</th><th>הסמכות אסורות</th><th>סטטוס</th><th></th></tr></thead>
    <tbody>`;

  const isOtMatch = opts?.isOneTime ? editingSlot?.isOneTime : !editingSlot?.isOneTime;
  const editingHere =
    editingSlot &&
    editingSlot.templateId === templateId &&
    editingSlot.subTeamId === subTeamId &&
    isOtMatch
      ? editingSlot
      : null;

  for (const slot of slots) {
    const finding = pf.findings.find((f) => f.slotId === slot.id);
    const statusHtml = finding
      ? `<span class="${finding.severity === PreflightSeverity.Critical ? 'text-danger' : 'text-warn'}">${finding.severity === PreflightSeverity.Critical ? '✗' : '⚠'} ${finding.code}</span>`
      : '<span style="color:var(--success)">✓</span>';

    const forbiddenCerts = slot.forbiddenCertifications ?? [];
    const ownerAttr = opts?.isOneTime ? `data-ot-id="${templateId}"` : `data-tid="${templateId}"`;
    const stAttr = subTeamId ? `data-stid="${subTeamId}"` : '';
    const isEditing = editingHere && editingHere.slotId === slot.id;
    const rowClass = isEditing ? ' class="slot-row-editing"' : '';

    html += `<tr${rowClass}>
      <td>${escHtml(stripLevelText(slot.label))}</td>
      <td>${slot.acceptableLevels.map((e) => levelBadge(e.level) + (e.lowPriority ? '<sup class="lp-badge" title="מוצא אחרון – הדרגה מותרת אך לא מועדפת">⚠</sup>' : '')).join(' ')}</td>
      <td>${slot.requiredCertifications.length > 0 ? slot.requiredCertifications.map((c) => certBadge(c)).join(' ') : '<span class="text-muted">אין</span>'}</td>
      <td>${forbiddenCerts.length > 0 ? forbiddenCerts.map((c) => forbiddenCertBadge(c)).join(' ') : '<span class="text-muted">אין</span>'}</td>
      <td>${statusHtml}</td>
      <td>
        ${
          isEditing
            ? ''
            : `<button class="btn-sm btn-outline" data-action="edit-slot" ${ownerAttr} ${stAttr} data-slotid="${slot.id}" title="ערוך">✎</button>`
        }
        <button class="btn-sm btn-danger-outline" data-action="remove-slot" ${ownerAttr} ${stAttr} data-slotid="${slot.id}" title="מחק">✕</button>
      </td>
    </tr>`;

    if (isEditing) {
      html += `<tr class="slot-edit-row"><td colspan="6">${renderSlotForm('edit', templateId, subTeamId, opts, slot)}</td></tr>`;
    }
  }

  html += '</tbody></table></div>';
  return html;
}

function renderAddSlotForm(templateId: string, subTeamId?: string, opts?: { isOneTime?: boolean }): string {
  return renderSlotForm('add', templateId, subTeamId, opts);
}

function readSlotFormFields(form: Element): Omit<SlotTemplate, 'id'> | null {
  const label = (form.querySelector('[data-field="slot-label"]') as HTMLInputElement)?.value.trim() || 'משבצת';
  const acceptableLevels: { level: Level; lowPriority?: boolean }[] = [];
  form.querySelectorAll<HTMLElement>('[data-slot-level]').forEach((btn) => {
    const state = btn.dataset.state;
    if (state === 'normal') acceptableLevels.push({ level: parseInt(btn.dataset.slotLevel!) as Level });
    else if (state === 'lowPriority')
      acceptableLevels.push({ level: parseInt(btn.dataset.slotLevel!) as Level, lowPriority: true });
  });
  const certs: string[] = [];
  form.querySelectorAll<HTMLInputElement>('[data-slot-cert]').forEach((cb) => {
    if (cb.checked && cb.dataset.slotCert) certs.push(cb.dataset.slotCert);
  });
  const forbiddenCerts: string[] = [];
  form.querySelectorAll<HTMLInputElement>('[data-slot-forbidden-cert]').forEach((cb) => {
    if (cb.checked && cb.dataset.slotForbiddenCert) forbiddenCerts.push(cb.dataset.slotForbiddenCert);
  });

  const overlap = certs.filter((c) => forbiddenCerts.includes(c));
  if (overlap.length > 0) {
    showToast(
      `הסמכה לא יכולה להיות גם נדרשת וגם אסורה: ${overlap.map((c) => store.getCertLabel(c)).join(', ')}`,
      { type: 'error' },
    );
    return null;
  }

  return {
    label,
    acceptableLevels,
    requiredCertifications: certs,
    forbiddenCertifications: forbiddenCerts.length > 0 ? forbiddenCerts : undefined,
  };
}

function renderSlotForm(
  mode: 'add' | 'edit',
  templateId: string,
  subTeamId?: string,
  opts?: { isOneTime?: boolean },
  initial?: SlotTemplate,
): string {
  const idAttr = opts?.isOneTime ? `data-ot-id="${templateId}"` : `data-tid="${templateId}"`;
  const stAttr = subTeamId ? `data-stid="${subTeamId}"` : '';
  const lpSup = '<sup class="lp-badge" title="מוצא אחרון – הדרגה מותרת אך לא מועדפת">⚠</sup>';

  const initLevelState = new Map<Level, 'off' | 'normal' | 'lowPriority'>();
  if (mode === 'edit' && initial) {
    for (const l of LEVEL_OPTIONS) initLevelState.set(l, 'off');
    for (const e of initial.acceptableLevels) initLevelState.set(e.level, e.lowPriority ? 'lowPriority' : 'normal');
  } else {
    for (const l of LEVEL_OPTIONS) initLevelState.set(l, 'normal');
  }

  const requiredSet = new Set(initial?.requiredCertifications ?? []);
  const forbiddenSet = new Set(initial?.forbiddenCertifications ?? []);

  const labelVal = initial ? escHtml(initial.label) : '';
  const title = mode === 'edit' ? 'ערוך משבצת' : 'הוסף משבצת';
  const confirmAction = mode === 'edit' ? 'confirm-edit-slot' : 'confirm-add-slot';
  const cancelAction = mode === 'edit' ? 'cancel-edit-slot' : 'cancel-add-slot';
  const confirmLabel = mode === 'edit' ? 'שמור' : 'הוסף';
  const slotIdAttr = mode === 'edit' && initial ? `data-slotid="${initial.id}"` : '';
  const formClass = mode === 'edit' ? 'add-slot-form edit-slot-form' : 'add-slot-form';

  return `<div class="${formClass}">
    <h5>${title}</h5>
    <div class="form-row">
      <label>תווית: <input class="input-sm" type="text" data-field="slot-label" placeholder="למשל #1" value="${labelVal}" /></label>
    </div>
    <div class="form-row">
      <span>דרגות:</span>
      ${LEVEL_OPTIONS.map((l) => {
        const state = initLevelState.get(l) ?? 'normal';
        const inner =
          state === 'off'
            ? `<span class="text-muted">L${l}</span>`
            : levelBadge(l) + (state === 'lowPriority' ? lpSup : '');
        return `<button type="button" class="level-toggle" data-action="cycle-level" data-slot-level="${l}" data-state="${state}">${inner}</button>`;
      }).join('')}
    </div>
    <div class="form-row">
      <span>הסמכות נדרשות:</span>
      ${getCertOptions()
        .map(
          (def) =>
            `<label class="checkbox-label"><input type="checkbox" data-slot-cert="${def.id}" ${requiredSet.has(def.id) ? 'checked' : ''} /> ${escHtml(def.label)}</label>`,
        )
        .join('')}
    </div>
    <div class="form-row">
      <span>הסמכות אסורות:</span>
      ${getCertOptions()
        .map(
          (def) =>
            `<label class="checkbox-label"><input type="checkbox" data-slot-forbidden-cert="${def.id}" ${forbiddenSet.has(def.id) ? 'checked' : ''} /> ${escHtml(def.label)}</label>`,
        )
        .join('')}
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="${confirmAction}" ${idAttr} ${stAttr} ${slotIdAttr}>${confirmLabel}</button>
      <button class="btn-sm btn-outline" data-action="${cancelAction}">ביטול</button>
    </div>
  </div>`;
}

function renderAddTemplateForm(): string {
  const pendingValue = _pendingTplLoadFormula?.computedValue;
  const baseLoadValue = pendingValue !== undefined ? pendingValue.toFixed(2) : '1';
  const calcBtn = `<button class="btn-xs btn-outline lf-open-btn" type="button" data-action="open-load-formula-new" data-lf-target="tpl" title="הגדר לפי השוואה" aria-label="הגדר לפי השוואה">🧮</button>`;
  return `<div class="add-form" id="add-template-form">
    <h4>משימה חדשה</h4>
    <div class="form-row">
      <label>שם: <input class="input-sm" type="text" data-field="tpl-name" placeholder="שם משימה" /></label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
      <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="tpl-start" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="${baseLoadValue}" data-field="tpl-base-load" /><span class="lf-controls">${calcBtn}</span></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-light" /> משימה קלה</label>
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
  const dayOptions = Array.from({ length: numDays }, (_, i) => `<option value="${i + 1}">יום ${i + 1}</option>`).join(
    '',
  );

  return `<div class="add-form" id="add-onetime-form">
    <h4>משימה חד-פעמית חדשה</h4>
    <div class="form-row">
      <label>שם: <input class="input-sm" type="text" data-field="ot-name" placeholder="שם משימה" /></label>
    </div>
    <div class="form-row">
      <label>יום:
        <select class="input-sm" data-field="ot-day">${dayOptions}</select>
      </label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="ot-start-hour" /></label>
      <label>דקה: <input class="input-sm" type="number" min="0" max="59" value="0" data-field="ot-start-minute" style="width:60px;" /></label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="4" data-field="ot-duration" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="${_pendingOtLoadFormula !== undefined ? _pendingOtLoadFormula.computedValue.toFixed(2) : '1'}" data-field="ot-base-load" /><span class="lf-controls"><button class="btn-xs btn-outline lf-open-btn" type="button" data-action="open-load-formula-new" data-lf-target="ot" title="הגדר לפי השוואה" aria-label="הגדר לפי השוואה">🧮</button></span></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="ot-samegroup" /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="ot-light" /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-field="ot-blocks-consecutive" checked /> חוסמת רצף</label>
      <label>כלל מרווח: <select class="input-sm" data-field="ot-rest-rule">
        <option value="">ללא</option>
        ${store
          .getRestRules()
          .map((r) => `<option value="${r.id}">${escHtml(r.label)} (${r.durationHours} שע׳)</option>`)
          .join('')}
      </select></label>
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

function renderOneTimeCard(ot: OneTimeTask, pf: PreflightResult): string {
  const isExpanded = expandedOtId === ot.id;
  const schedDate = store.getScheduleDate();
  const otDay = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());
  const schedStart = new Date(schedDate.getFullYear(), schedDate.getMonth(), schedDate.getDate());
  const dayNum = Math.round((otDay.getTime() - schedStart.getTime()) / 86400000) + 1;
  const dateStr = `יום ${dayNum}`;
  const timeStr = fmtHm(ot.startHour, ot.startMinute);
  const totalMinutes = ot.startMinute + Math.round((ot.durationHours % 1) * 60);
  const endH = ot.startHour + Math.floor(ot.durationHours) + Math.floor(totalMinutes / 60);
  const endM = totalMinutes % 60;
  const endStr = fmtHm(endH % 24, endM);

  const allSlots = [...ot.slots];
  for (const st of ot.subTeams) allSlots.push(...st.slots);
  const totalSlots = allSlots.length;

  const flags: string[] = [];
  if (ot.isLight) flags.push('קלה');
  if (ot.sameGroupRequired) flags.push('קבוצה');
  if (ot.blocksConsecutive) flags.push('חוסמת');

  const relatedFindings = pf.findings.filter((f) => {
    const slotIds = new Set(allSlots.map((s) => s.id));
    return f.slotId && slotIds.has(f.slotId);
  });
  const hasCritical = relatedFindings.some((f) => f.severity === PreflightSeverity.Critical);
  const hasWarning = relatedFindings.some((f) => f.severity === PreflightSeverity.Warning);
  const alertClass = hasCritical ? 'template-card-error' : hasWarning ? 'template-card-warn' : '';

  let html = `<div class="template-card onetime-card ${alertClass}" data-ot-id="${ot.id}">
    <div class="template-header" data-action="toggle-onetime" data-ot-id="${ot.id}">
      <div class="template-title">
        ${templateBadge({ color: ot.color, name: ot.name })}
        <strong>${escHtml(ot.name)}</strong>
        <span class="text-muted" style="font-size:0.85em;">📅 ${dateStr} <span dir="ltr">${timeStr}–${endStr}</span> (${ot.durationHours} שע')</span>
        ${hasCritical ? '<span class="badge badge-sm" style="background:var(--danger)">!</span>' : ''}
        ${hasWarning && !hasCritical ? '<span class="badge badge-sm" style="background:var(--warning)">⚠</span>' : ''}
      </div>
      <div class="template-toggles">
        ${flags.length > 0 ? flags.map((f) => `<span class="badge badge-sm badge-outline">${f}</span>`).join('') : ''}
        ${_restRuleBadge(ot.restRuleId)}
        <span class="expand-arrow">${isExpanded ? '▼' : '▶'}</span>
      </div>
    </div>`;

  if (!isExpanded) {
    html += `<div class="template-meta">
      <span class="meta-item">${totalSlots} משבצות</span>
      ${ot.description ? `<span class="meta-item text-muted">${escHtml(ot.description)}</span>` : ''}
    </div>`;
  }

  if (isExpanded) {
    html += `<div class="template-body">`;

    // Day options (1-7)
    const dayOptions = Array.from({ length: 7 }, (_, i) => {
      const d = i + 1;
      return `<option value="${d}"${d === dayNum ? ' selected' : ''}>יום ${d}</option>`;
    }).join('');

    // Properties
    html += `<div class="template-props">
      <label>שם: <input class="input-sm" type="text" data-ot-field="name" value="${escHtml(ot.name)}" data-ot-id="${ot.id}" /></label>
      <label>יום: <select class="input-sm" data-ot-field="dayNum" data-ot-id="${ot.id}">${dayOptions}</select></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" data-ot-field="startHour" value="${ot.startHour}" data-ot-id="${ot.id}" /></label>
      <label>דקת התחלה: <input class="input-sm" type="number" min="0" max="59" data-ot-field="startMinute" value="${ot.startMinute}" data-ot-id="${ot.id}" /></label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" data-ot-field="durationHours" value="${ot.durationHours}" data-ot-id="${ot.id}" /></label>
      <label>רמת עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-ot-field="baseLoadWeight" value="${(ot.baseLoadWeight ?? (ot.isLight ? 0 : 1)).toFixed(2)}" data-ot-id="${ot.id}" /></label>
      <label class="checkbox-label"><input type="checkbox" data-ot-field="sameGroupRequired" data-ot-id="${ot.id}" ${ot.sameGroupRequired ? 'checked' : ''} /> נדרשת אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-ot-field="isLight" data-ot-id="${ot.id}" ${ot.isLight ? 'checked' : ''} /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-ot-field="blocksConsecutive" data-ot-id="${ot.id}" ${(ot.blocksConsecutive ?? true) ? 'checked' : ''} /> חוסם רצף משימות</label>
      <label>כלל מרווח: <select class="input-sm" data-ot-field="restRuleId" data-ot-id="${ot.id}">
        <option value=""${!ot.restRuleId ? ' selected' : ''}>ללא</option>
        ${store
          .getRestRules()
          .map(
            (r) =>
              `<option value="${r.id}"${ot.restRuleId === r.id ? ' selected' : ''}>${escHtml(r.label)} (${r.durationHours} שע׳)</option>`,
          )
          .join('')}
      </select></label>${_restRuleOrphanNote(ot.restRuleId)}
      <label>תיאור: <input class="input-sm" type="text" data-ot-field="description" value="${escHtml(ot.description || '')}" data-ot-id="${ot.id}" /></label>
      <button class="btn-sm btn-primary" data-action="save-onetime-props" data-ot-id="${ot.id}">שמור</button>
    </div>`;

    // Sub-teams
    if (ot.subTeams.length > 0) {
      html += '<h4 style="margin:12px 0 8px;">תת-צוותים</h4>';
      for (const st of ot.subTeams) {
        html += renderSubTeam(ot.id, st, pf, { isOneTime: true });
      }
    }

    // Top-level slots
    if (ot.slots.length > 0 || ot.subTeams.length === 0) {
      html += `<h4 style="margin:12px 0 8px;">משבצות${ot.subTeams.length > 0 ? ' נוספות' : ''}</h4>`;
      html += renderSlotTable(ot.id, ot.slots, undefined, pf, { isOneTime: true });
    }

    // Add sub-team / slot / delete buttons
    html += `<div class="template-actions">
      <button class="btn-sm btn-outline" data-action="add-subteam" data-ot-id="${ot.id}">+ תת-צוות</button>
      <button class="btn-sm btn-outline" data-action="add-slot" data-ot-id="${ot.id}">+ משבצת</button>
      <button class="btn-sm btn-danger-outline" data-action="delete-onetime" data-ot-id="${ot.id}">הסר משימה</button>
    </div>`;

    // Inline add-slot form
    if (addingSlotTo && addingSlotTo.templateId === ot.id && addingSlotTo.isOneTime && !addingSlotTo.subTeamId) {
      html += renderAddSlotForm(ot.id, undefined, { isOneTime: true });
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireTaskRulesEvents(container: HTMLElement, rerender: () => void): void {
  initLoadFormulaModal({ onChanged: rerender });

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
    const target = e.target as HTMLElement;
    if ((target as HTMLSelectElement).dataset.field === 'tpl-display-category') {
      const customInput = container.querySelector<HTMLInputElement>('[data-field="tpl-display-category-custom"]');
      if (customInput) customInput.style.display = (target as HTMLSelectElement).value === '' ? 'inline-block' : 'none';
    }
    // (rest rule inline edits are saved via button action, not change event)
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

      // ─── Rest Rule actions ──────────────────────────────────────────
      case 'add-rest-rule': {
        const rule = store.addRestRule('כלל חדש', 5);
        showToast(`כלל "${rule.label}" נוצר`, { type: 'success' });
        rerender();
        break;
      }
      case 'save-rest-rule': {
        const rrId = actionButton?.dataset.rrId;
        if (!rrId) break;
        const row = container.querySelector<HTMLElement>(`[data-rest-rule-id="${rrId}"]`);
        if (!row) break;
        const label = (row.querySelector('[data-rr-field="label"]') as HTMLInputElement)?.value?.trim();
        const dur = parseFloat((row.querySelector('[data-rr-field="durationHours"]') as HTMLInputElement)?.value);
        if (!label) {
          showToast('שם הכלל לא יכול להיות ריק', { type: 'error' });
          break;
        }
        if (isNaN(dur) || dur < 0.5) {
          showToast('משך לא תקין (מינימום 0.5 שעות)', { type: 'error' });
          break;
        }
        store.updateRestRule(rrId, { label, durationHours: dur });
        showToast('הכלל עודכן', { type: 'success' });
        rerender();
        break;
      }
      case 'delete-rest-rule': {
        const rrId = actionButton?.dataset.rrId;
        if (!rrId) break;
        const rule = store.getRestRuleById(rrId);
        const confirmed = await showConfirm(
          `למחוק את הכלל "${rule?.label ?? rrId}"? משימות המשויכות אליו ייראו עם אזהרת יתום.`,
          { danger: true, confirmLabel: 'מחק' },
        );
        if (!confirmed) break;
        store.removeRestRule(rrId);
        showToast('הכלל נמחק', { type: 'success' });
        rerender();
        break;
      }

      case 'toggle-template': {
        const tid = actionButton?.closest('[data-tid]')?.getAttribute('data-tid') || actionButton?.dataset.tid!;
        expandedTemplateId = expandedTemplateId === tid ? null : tid;
        expandedOtId = null;
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'toggle-onetime': {
        const otId = actionButton?.dataset.otId!;
        expandedOtId = expandedOtId === otId ? null : otId;
        expandedTemplateId = null;
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'save-onetime-props': {
        const otId = actionButton?.dataset.otId!;
        const body = actionButton?.closest('.template-body')!;
        const name = (body.querySelector('[data-ot-field="name"]') as HTMLInputElement)?.value.trim();
        if (!name) { showToast('שם משימה נדרש', { type: 'error' }); break; }
        const dayNumVal = parseInt((body.querySelector('[data-ot-field="dayNum"]') as HTMLSelectElement)?.value || '1');
        const schedDate = store.getScheduleDate();
        const scheduledDate = new Date(schedDate.getFullYear(), schedDate.getMonth(), schedDate.getDate() + dayNumVal - 1);
        const rawStartHour = parseInt((body.querySelector('[data-ot-field="startHour"]') as HTMLInputElement)?.value || '6');
        const rawStartMinute = parseInt((body.querySelector('[data-ot-field="startMinute"]') as HTMLInputElement)?.value || '0');
        const rawDur = parseFloat((body.querySelector('[data-ot-field="durationHours"]') as HTMLInputElement)?.value || '4');
        const baseLoad = parseFloat((body.querySelector('[data-ot-field="baseLoadWeight"]') as HTMLInputElement)?.value || '1');
        const sameGroup = (body.querySelector('[data-ot-field="sameGroupRequired"]') as HTMLInputElement)?.checked || false;
        const isLight = (body.querySelector('[data-ot-field="isLight"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive = (body.querySelector('[data-ot-field="blocksConsecutive"]') as HTMLInputElement)?.checked ?? true;
        const otRestRuleId = (body.querySelector('[data-ot-field="restRuleId"]') as HTMLSelectElement)?.value || undefined;
        const desc = (body.querySelector('[data-ot-field="description"]') as HTMLInputElement)?.value.trim();

        const otSanitized = store.sanitizeTemplateNumericFields({ durationHours: rawDur, startHour: rawStartHour });
        const startMinute = Math.max(0, Math.min(59, Math.round(Number.isNaN(rawStartMinute) ? 0 : rawStartMinute)));

        store.updateOneTimeTask(otId, {
          name,
          scheduledDate,
          startHour: otSanitized.startHour,
          startMinute,
          durationHours: otSanitized.durationHours,
          sameGroupRequired: sameGroup,
          isLight,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          blocksConsecutive,
          restRuleId: otRestRuleId,
          description: desc || undefined,
          displayCategory: name.toLowerCase(),
        });
        showToast('המשימה עודכנה', { type: 'success' });
        rerender();
        break;
      }
      case 'save-template-props': {
        const tid = actionButton?.dataset.tid!;
        const body = actionButton?.closest('.template-body')!;
        const dur = parseFloat(
          (body.querySelector('[data-tpl-field="durationHours"]') as HTMLInputElement)?.value || '8',
        );
        const shifts = parseInt(
          (body.querySelector('[data-tpl-field="shiftsPerDay"]') as HTMLInputElement)?.value || '1',
        );
        const startH = parseInt((body.querySelector('[data-tpl-field="startHour"]') as HTMLInputElement)?.value || '6');
        const baseLoad = parseFloat(
          (body.querySelector('[data-tpl-field="baseLoadWeight"]') as HTMLInputElement)?.value || '1',
        );
        const sameGroup =
          (body.querySelector('[data-tpl-field="sameGroupRequired"]') as HTMLInputElement)?.checked || false;
        const isLight = (body.querySelector('[data-tpl-field="isLight"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive =
          (body.querySelector('[data-tpl-field="blocksConsecutive"]') as HTMLInputElement)?.checked || false;
        const togethernessRelevant =
          (body.querySelector('[data-tpl-field="togethernessRelevant"]') as HTMLInputElement)?.checked || false;
        const restRuleId =
          (body.querySelector('[data-tpl-field="restRuleId"]') as HTMLSelectElement)?.value || undefined;

        const sanitized = store.sanitizeTemplateNumericFields({
          durationHours: dur,
          shiftsPerDay: shifts,
          startHour: startH,
        });
        notifyIfClamped({ durationHours: dur, shiftsPerDay: shifts, startHour: startH }, sanitized);

        const clampedBaseLoad = isLight ? 0 : Math.max(0, Math.min(1, baseLoad));
        const existingTpl = store.getTaskTemplate(tid);
        const existingFormulaValue = existingTpl?.loadFormula?.computedValue;
        const formulaDroppedByManualEdit =
          !isLight && existingFormulaValue !== undefined && Math.abs(clampedBaseLoad - existingFormulaValue) > 1e-9;
        store.updateTaskTemplate(tid, {
          durationHours: sanitized.durationHours,
          shiftsPerDay: sanitized.shiftsPerDay,
          startHour: sanitized.startHour,
          baseLoadWeight: clampedBaseLoad,
          ...(isLight || formulaDroppedByManualEdit ? { loadFormula: undefined } : {}),
          sameGroupRequired: sameGroup,
          isLight,
          blocksConsecutive,
          togethernessRelevant,
          restRuleId,
        });
        rerender();
        break;
      }
      case 'open-load-formula': {
        const tid = actionButton?.dataset.tid;
        const kind = actionButton?.dataset.lfKind as 'base' | 'window' | undefined;
        if (!tid || !kind) break;
        if (kind === 'base') {
          openLoadFormulaModal({ kind: 'base', templateId: tid });
        } else {
          const lwid = actionButton?.dataset.lwid;
          if (!lwid) break;
          openLoadFormulaModal({ kind: 'window', templateId: tid, windowId: lwid });
        }
        break;
      }
      case 'open-load-formula-new': {
        // Calculator for a task that doesn't exist in the store yet (add form).
        // Reads the in-progress name from the form so the modal header is meaningful.
        const target = actionButton?.dataset.lfTarget as 'tpl' | 'ot' | undefined;
        if (!target) break;
        const form = container.querySelector(target === 'tpl' ? '#add-template-form' : '#add-onetime-form');
        if (!form) break;
        const nameField = target === 'tpl' ? 'tpl-name' : 'ot-name';
        const name = (form.querySelector(`[data-field="${nameField}"]`) as HTMLInputElement)?.value.trim() || 'משימה חדשה';
        const existingFormula = target === 'tpl' ? _pendingTplLoadFormula : _pendingOtLoadFormula;
        openLoadFormulaModal({
          kind: 'ephemeral',
          name,
          existingFormula,
          onSave: (formula) => {
            if (target === 'tpl') _pendingTplLoadFormula = formula;
            else _pendingOtLoadFormula = formula;
          },
        });
        break;
      }
      case 'toggle-load-formula-info': {
        const tid = actionButton?.dataset.tid;
        const kind = actionButton?.dataset.lfKind as 'base' | 'window' | undefined;
        if (!tid || !kind) break;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        const lwid = actionButton?.dataset.lwid ?? null;
        // Remove any existing popover; if it was anchored to this same button, we're done (toggle off).
        const existing = document.querySelector('.lf-info-popover-wrap');
        const wasSameAnchor = existing?.getAttribute('data-anchor-key') === `${tid}:${kind}:${lwid ?? ''}`;
        existing?.remove();
        if (wasSameAnchor) break;
        const html = renderLoadFormulaExplanation(tpl, kind, lwid);
        if (!html) break;
        const wrap = document.createElement('div');
        wrap.className = 'lf-info-popover-wrap';
        wrap.setAttribute('data-anchor-key', `${tid}:${kind}:${lwid ?? ''}`);
        wrap.innerHTML = html;
        document.body.appendChild(wrap);
        const btnRect = actionButton!.getBoundingClientRect();
        wrap.style.position = 'fixed';
        wrap.style.top = `${btnRect.bottom + 6}px`;
        wrap.style.left = `${Math.max(8, btnRect.left - 220)}px`;
        wrap.style.zIndex = '100';
        // Dismiss when clicking outside.
        const offClick = (ev: MouseEvent) => {
          if (wrap.contains(ev.target as Node)) return;
          if ((ev.target as HTMLElement).closest('[data-action="toggle-load-formula-info"]')) return;
          wrap.remove();
          document.removeEventListener('click', offClick, true);
          document.removeEventListener('keydown', offKey);
        };
        const offKey = (ev: KeyboardEvent) => {
          if (ev.key === 'Escape') {
            wrap.remove();
            document.removeEventListener('click', offClick, true);
            document.removeEventListener('keydown', offKey);
          }
        };
        setTimeout(() => {
          document.addEventListener('click', offClick, true);
          document.addEventListener('keydown', offKey);
        }, 0);
        break;
      }
      case 'add-load-window':
      case 'add-load-window-and-compute': {
        const tid = actionButton?.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        const block = actionButton?.closest('.add-slot-form');
        if (!block) break;

        const start = (block.querySelector('[data-field="lw-start"]') as HTMLInputElement | null)?.value || '05:00';
        const end = (block.querySelector('[data-field="lw-end"]') as HTMLInputElement | null)?.value || '06:30';
        const weight = parseFloat(
          (block.querySelector('[data-field="lw-weight"]') as HTMLInputElement | null)?.value || '1',
        );

        const ps = parseHm(start);
        const pe = parseHm(end);
        if (!ps || !pe) {
          showToast('שעה לא תקינה — יש להזין בפורמט HH:MM (00:00–23:59)', { type: 'error' });
          break;
        }

        const candidate = { startHour: ps.h, startMinute: ps.m, endHour: pe.h, endMinute: pe.m };
        const conflict = (tpl.loadWindows || []).find((w) => loadWindowsOverlap(w, candidate));
        if (conflict) {
          showToast(
            `החלון חופף לחלון קיים (${fmtHm(conflict.startHour, conflict.startMinute)}–${fmtHm(conflict.endHour, conflict.endMinute)}) — לא נוסף`,
            { type: 'error' },
          );
          break;
        }

        const newWindow: LoadWindow = {
          id: `lw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          ...candidate,
          weight: Math.max(0, Math.min(1, weight)),
        };

        store.updateTaskTemplate(tid, {
          loadWindows: [...(tpl.loadWindows || []), newWindow],
        });
        rerender();
        if (action === 'add-load-window-and-compute') {
          openLoadFormulaModal({ kind: 'window', templateId: tid, windowId: newWindow.id });
        }
        break;
      }
      case 'update-load-window': {
        const tid = actionButton?.dataset.tid!;
        const lwid = actionButton?.dataset.lwid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;

        const body = actionButton?.closest('.template-body') as HTMLElement | null;
        if (!body) break;
        const startInput = body.querySelector(
          `[data-field="lw-edit-start"][data-lwid="${lwid}"]`,
        ) as HTMLInputElement | null;
        const endInput = body.querySelector(
          `[data-field="lw-edit-end"][data-lwid="${lwid}"]`,
        ) as HTMLInputElement | null;
        const weightInput = body.querySelector(
          `[data-field="lw-edit-weight"][data-lwid="${lwid}"]`,
        ) as HTMLInputElement | null;
        if (!startInput || !endInput || !weightInput) break;

        const ps = parseHm(startInput.value);
        const pe = parseHm(endInput.value);
        const weight = parseFloat(weightInput.value || '1');
        if (!ps || !pe) {
          showToast('שעה לא תקינה — יש להזין בפורמט HH:MM (00:00–23:59)', { type: 'error' });
          break;
        }

        const candidate = { startHour: ps.h, startMinute: ps.m, endHour: pe.h, endMinute: pe.m };
        const conflict = (tpl.loadWindows || []).find((w) => w.id !== lwid && loadWindowsOverlap(w, candidate));
        if (conflict) {
          showToast(
            `החלון חופף לחלון קיים (${fmtHm(conflict.startHour, conflict.startMinute)}–${fmtHm(conflict.endHour, conflict.endMinute)}) — השינוי לא נשמר`,
            { type: 'error' },
          );
          rerender();
          break;
        }

        store.updateTaskTemplate(tid, {
          loadWindows: (tpl.loadWindows || []).map((w) => {
            if (w.id !== lwid) return w;
            const nextWeight = Math.max(0, Math.min(1, weight));
            const next: LoadWindow = {
              ...w,
              startHour: ps.h,
              startMinute: ps.m,
              endHour: pe.h,
              endMinute: pe.m,
              weight: nextWeight,
            };
            // Manual edit of window weight clears any stored formula.
            if (w.loadFormula && Math.abs(nextWeight - w.loadFormula.computedValue) > 1e-9) {
              delete next.loadFormula;
            }
            return next;
          }),
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
        const otIdSt = actionButton?.dataset.otId;
        const tidSt = otIdSt || actionButton?.dataset.tid!;
        const name = await showPrompt('הזן שם לתת-צוות:', { title: 'הוספת תת-צוות' });
        if (!name) return;
        if (otIdSt) {
          store.addSubTeamToOneTimeTask(otIdSt, name.trim());
        } else {
          store.addSubTeamToTemplate(tidSt, name.trim());
        }
        rerender();
        break;
      }
      case 'remove-subteam': {
        const otIdRst = actionButton?.dataset.otId;
        const tidRst = otIdRst || actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid!;
        const okSub = await showConfirm('למחוק את תת-הצוות הזה ואת כל המשבצות שלו?', {
          danger: true,
          title: 'מחיקת תת-צוות',
          confirmLabel: 'מחק',
        });
        if (okSub) {
          if (otIdRst) {
            store.removeSubTeamFromOneTimeTask(otIdRst, stid);
          } else {
            store.removeSubTeamFromTemplate(tidRst, stid);
          }
          rerender();
        }
        break;
      }
      case 'add-slot': {
        const otIdAs = actionButton?.dataset.otId;
        editingSlot = null;
        if (otIdAs) {
          addingSlotTo = { templateId: otIdAs, isOneTime: true };
        } else {
          const tid = actionButton?.dataset.tid!;
          addingSlotTo = { templateId: tid };
        }
        rerender();
        break;
      }
      case 'add-slot-subteam': {
        const otIdAss = actionButton?.dataset.otId;
        const stid = actionButton?.dataset.stid!;
        editingSlot = null;
        if (otIdAss) {
          addingSlotTo = { templateId: otIdAss, subTeamId: stid, isOneTime: true };
        } else {
          const tid = actionButton?.dataset.tid!;
          addingSlotTo = { templateId: tid, subTeamId: stid };
        }
        rerender();
        break;
      }
      case 'edit-slot': {
        const otIdEs = actionButton?.dataset.otId;
        const tidEs = otIdEs || actionButton?.dataset.tid!;
        const stidEs = actionButton?.dataset.stid;
        const slotIdEs = actionButton?.dataset.slotid!;
        addingSlotTo = null;
        editingSlot = {
          templateId: tidEs,
          subTeamId: stidEs,
          slotId: slotIdEs,
          isOneTime: !!otIdEs,
        };
        rerender();
        break;
      }
      case 'cancel-edit-slot': {
        editingSlot = null;
        rerender();
        break;
      }
      case 'cycle-level': {
        const btn = actionButton!;
        const cur = btn.dataset.state;
        const next = cur === 'normal' ? 'lowPriority' : cur === 'lowPriority' ? 'off' : 'normal';
        btn.dataset.state = next;
        const lvl = parseInt(btn.dataset.slotLevel!) as Level;
        const lpSup = '<sup class="lp-badge" title="מוצא אחרון – הדרגה מותרת אך לא מועדפת">⚠</sup>';
        btn.innerHTML =
          next === 'off'
            ? `<span class="text-muted">L${lvl}</span>`
            : levelBadge(lvl) + (next === 'lowPriority' ? lpSup : '');
        break;
      }
      case 'confirm-add-slot': {
        const otIdCas = actionButton?.dataset.otId;
        const tid = otIdCas || actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid;
        const form = actionButton?.closest('.add-slot-form')!;
        const slot = readSlotFormFields(form);
        if (!slot) break;

        if (otIdCas) {
          if (stid) {
            store.addSlotToOneTimeSubTeam(otIdCas, stid, slot);
          } else {
            store.addSlotToOneTimeTask(otIdCas, slot);
          }
        } else if (stid) {
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
      case 'confirm-edit-slot': {
        const otIdCes = actionButton?.dataset.otId;
        const tidCes = otIdCes || actionButton?.dataset.tid!;
        const stidCes = actionButton?.dataset.stid;
        const slotIdCes = actionButton?.dataset.slotid!;
        const form = actionButton?.closest('.add-slot-form')!;
        const patch = readSlotFormFields(form);
        if (!patch) break;

        if (otIdCes) {
          if (stidCes) {
            store.updateSlotInOneTimeSubTeam(otIdCes, stidCes, slotIdCes, patch);
          } else {
            store.updateSlotInOneTimeTask(otIdCes, slotIdCes, patch);
          }
        } else if (stidCes) {
          store.updateSlotInSubTeam(tidCes, stidCes, slotIdCes, patch);
        } else {
          store.updateSlotInTemplate(tidCes, slotIdCes, patch);
        }
        editingSlot = null;
        rerender();
        break;
      }
      case 'remove-slot': {
        const otIdRs = actionButton?.dataset.otId;
        const tidRs = otIdRs || actionButton?.dataset.tid!;
        const stid = actionButton?.dataset.stid;
        const slotId = actionButton?.dataset.slotid!;
        if (otIdRs) {
          if (stid) {
            store.removeSlotFromOneTimeSubTeam(otIdRs, stid, slotId);
          } else {
            store.removeSlotFromOneTimeTask(otIdRs, slotId);
          }
        } else if (stid) {
          store.removeSlotFromSubTeam(tidRs, stid, slotId);
        } else {
          store.removeSlotFromTemplate(tidRs, slotId);
        }
        rerender();
        break;
      }
      case 'remove-template': {
        const tid = actionButton?.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (tpl) {
          const okTpl = await showConfirm(`למחוק את התבנית "${tpl.name}"?`, {
            danger: true,
            title: 'מחיקת תבנית',
            confirmLabel: 'מחק',
          });
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
        _pendingTplLoadFormula = undefined;
        rerender();
        break;
      }
      case 'confirm-add-template': {
        const form = container.querySelector('#add-template-form')!;
        const name = (form.querySelector('[data-field="tpl-name"]') as HTMLInputElement)?.value.trim();
        if (!name) return;
        const existingNames = store.getAllTaskTemplates().map((t) => t.name.trim().toLowerCase());
        if (existingNames.includes(name.toLowerCase())) {
          showToast(`משימה בשם "${name}" כבר קיימת`, { type: 'error' });
          return;
        }
        const dur = parseFloat((form.querySelector('[data-field="tpl-duration"]') as HTMLInputElement)?.value || '8');
        const shifts = parseInt((form.querySelector('[data-field="tpl-shifts"]') as HTMLInputElement)?.value || '1');
        const startH = parseInt((form.querySelector('[data-field="tpl-start"]') as HTMLInputElement)?.value || '6');
        const baseLoad = parseFloat(
          (form.querySelector('[data-field="tpl-base-load"]') as HTMLInputElement)?.value || '1',
        );
        const sameGroup = (form.querySelector('[data-field="tpl-samegroup"]') as HTMLInputElement)?.checked || false;
        const isLight = (form.querySelector('[data-field="tpl-light"]') as HTMLInputElement)?.checked || false;

        const sanitized = store.sanitizeTemplateNumericFields({
          durationHours: dur,
          shiftsPerDay: shifts,
          startHour: startH,
        });
        notifyIfClamped({ durationHours: dur, shiftsPerDay: shifts, startHour: startH }, sanitized);

        const displayCategory = name.toLowerCase();
        const clampedBaseLoad = isLight ? 0 : Math.max(0, Math.min(1, baseLoad));
        // Drop pending formula if light OR if user manually edited the input away from the computed value.
        const keepFormula =
          !isLight &&
          _pendingTplLoadFormula !== undefined &&
          Math.abs(clampedBaseLoad - _pendingTplLoadFormula.computedValue) <= 1e-9;

        store.addTaskTemplate({
          name,
          durationHours: sanitized.durationHours,
          shiftsPerDay: sanitized.shiftsPerDay,
          startHour: sanitized.startHour,
          sameGroupRequired: sameGroup,
          isLight,
          baseLoadWeight: clampedBaseLoad,
          loadFormula: keepFormula ? _pendingTplLoadFormula : undefined,
          loadWindows: [],
          blocksConsecutive: !isLight,
          togethernessRelevant: false,
          restRuleId: undefined,
          displayCategory,
          subTeams: [],
          slots: [],
        });
        showAddTemplate = false;
        _pendingTplLoadFormula = undefined;
        rerender();
        break;
      }
      case 'cancel-add-template': {
        showAddTemplate = false;
        _pendingTplLoadFormula = undefined;
        rerender();
        break;
      }

      // ─── One-Time Task actions ────────────────────────────────────────
      case 'toggle-add-onetime': {
        showAddOneTime = !showAddOneTime;
        _pendingOtLoadFormula = undefined;
        rerender();
        break;
      }
      case 'confirm-add-onetime': {
        const form = container.querySelector('#add-onetime-form')!;
        const name = (form.querySelector('[data-field="ot-name"]') as HTMLInputElement)?.value.trim();
        if (!name) return;
        const dayNum = parseInt((form.querySelector('[data-field="ot-day"]') as HTMLSelectElement)?.value || '1');
        const schedDate = store.getScheduleDate();
        const scheduledDate = new Date(schedDate.getFullYear(), schedDate.getMonth(), schedDate.getDate() + dayNum - 1);

        const rawStartHour = parseInt(
          (form.querySelector('[data-field="ot-start-hour"]') as HTMLInputElement)?.value || '6',
        );
        const rawStartMinute = parseInt(
          (form.querySelector('[data-field="ot-start-minute"]') as HTMLInputElement)?.value || '0',
        );
        const rawDur = parseFloat((form.querySelector('[data-field="ot-duration"]') as HTMLInputElement)?.value || '4');
        const baseLoad = parseFloat(
          (form.querySelector('[data-field="ot-base-load"]') as HTMLInputElement)?.value || '1',
        );
        const sameGroup = (form.querySelector('[data-field="ot-samegroup"]') as HTMLInputElement)?.checked || false;
        const isLight = (form.querySelector('[data-field="ot-light"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive =
          (form.querySelector('[data-field="ot-blocks-consecutive"]') as HTMLInputElement)?.checked ?? true;
        const desc = (form.querySelector('[data-field="ot-desc"]') as HTMLInputElement)?.value.trim();
        const otRestRuleId =
          (form.querySelector('[data-field="ot-rest-rule"]') as HTMLSelectElement)?.value || undefined;
        const displayCategory = name.toLowerCase();

        const otSanitized = store.sanitizeTemplateNumericFields({ durationHours: rawDur, startHour: rawStartHour });
        const startMinute = Math.max(0, Math.min(59, Math.round(Number.isNaN(rawStartMinute) ? 0 : rawStartMinute)));
        notifyIfClamped(
          { durationHours: rawDur, startHour: rawStartHour },
          { durationHours: otSanitized.durationHours, startHour: otSanitized.startHour },
        );

        store.addOneTimeTask({
          name,
          scheduledDate,
          startHour: otSanitized.startHour,
          startMinute,
          durationHours: otSanitized.durationHours,
          sameGroupRequired: sameGroup,
          isLight,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          loadWindows: [],
          blocksConsecutive,
          togethernessRelevant: false,
          restRuleId: otRestRuleId,
          displayCategory,
          subTeams: [],
          slots: [],
          description: desc || undefined,
        });
        showAddOneTime = false;
        _pendingOtLoadFormula = undefined;
        rerender();
        break;
      }
      case 'cancel-add-onetime': {
        showAddOneTime = false;
        _pendingOtLoadFormula = undefined;
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
        if (expandedOtId === otId) expandedOtId = null;
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
      const tset = store.getTaskSetById(id);
      if (!tset) return;
      const ok = await showConfirm(buildTaskSetLoadConfirmMessage(tset), {
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
