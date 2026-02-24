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
} from '../models/types';
import * as store from './config-store';
import { runPreflight } from './preflight';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEVEL_OPTIONS = [Level.L0, Level.L2, Level.L3, Level.L4];
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala, Certification.Horesh];
const TASK_TYPE_OPTIONS = Object.values(TaskType);

const TASK_COLORS: Record<string, string> = {
  Adanit: '#4A90D9', Hamama: '#E74C3C', Shemesh: '#F39C12',
  Mamtera: '#27AE60', Karov: '#8E44AD', Karovit: '#BDC3C7', Aruga: '#1ABC9C',
};

const TASK_TYPE_LABELS: Record<string, string> = {
  Adanit: 'אדנית', Hamama: 'חממה', Shemesh: 'שמש',
  Mamtera: 'ממטרה', Karov: 'כרוב', Karovit: 'כרובית', Aruga: 'ערוגה',
};

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
        <span class="score-label">סטטוס יצירה</span>
      </div>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="toggle-add-template">+ תבנית משימה חדשה</button>
    </div>
  </div>`;

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
        <span class="text-muted"> · ${tpl.durationHours}h × ${tpl.shiftsPerDay} משמרות · ${totalSlots} משבצות/משמרת · ${totalPeople} אנשים/יום</span>
        ${hasCritical ? '<span class="badge badge-sm" style="background:var(--danger)">!</span>' : ''}
        ${hasWarning && !hasCritical ? '<span class="badge badge-sm" style="background:var(--warning)">⚠</span>' : ''}
      </div>
      <div class="template-toggles">
        ${tpl.sameGroupRequired ? '<span class="badge badge-sm badge-outline">אותה קבוצה</span>' : ''}
        ${tpl.isLight ? '<span class="badge badge-sm badge-outline">קל</span>' : ''}
        ${(tpl.blocksConsecutive ?? !tpl.isLight) ? '' : '<span class="badge badge-sm badge-outline">ללא HC-12</span>'}
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
      <label>יחס חישוב עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-tpl-field="baseLoadWeight" value="${(tpl.baseLoadWeight ?? (tpl.isLight ? 0 : 1)).toFixed(2)}" data-tid="${tpl.id}" /></label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="sameGroupRequired" data-tid="${tpl.id}" ${tpl.sameGroupRequired ? 'checked' : ''} /> אותה קבוצה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="isLight" data-tid="${tpl.id}" ${tpl.isLight ? 'checked' : ''} /> משימה קלה</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="blocksConsecutive" data-tid="${tpl.id}" ${(tpl.blocksConsecutive ?? !tpl.isLight) ? 'checked' : ''} /> חסימה עוקבת (HC-12)</label>
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
  let html = `<h4 style="margin:12px 0 8px;">חלונות עומס (אזורים חמים)</h4>`;

  if (windows.length === 0) {
    html += '<p class="text-muted" style="padding:4px 0;">אין חלונות חמים. יחס חישוב עומס חל על כל המשימה.</p>';
  } else {
    html += `<table class="table table-slots" style="margin-bottom:8px;">
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
    html += '</tbody></table>';
  }

  html += `<div class="add-slot-form" style="margin-top:8px;">
    <div class="form-row">
      <label>התחלה <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-start" value="05:00" /></label>
      <label>סיום <input class="input-sm time-24h" type="text" maxlength="5" pattern="[0-2]?[0-9]:[0-5][0-9]" placeholder="HH:mm" data-field="lw-end" value="06:30" /></label>
      <label>משקל (0-1) <input class="input-sm" type="number" step="0.05" min="0" max="1" data-field="lw-weight" value="1" /></label>
      <button class="btn-sm btn-primary" data-action="add-load-window" data-tid="${tpl.id}">הוסף חלון חם</button>
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
  if (slots.length === 0) return '<p class="text-muted" style="padding:4px 0;">לא הוגדרו משבצות.</p>';

  let html = `<table class="table table-slots">
    <thead><tr><th>תווית</th><th>דרגות</th><th>הסמכות</th><th>סטטוס</th><th></th></tr></thead>
    <tbody>`;

  for (const slot of slots) {
    const finding = pf.findings.find(f => f.slotId === slot.id);
    const statusHtml = finding
      ? `<span class="${finding.severity === PreflightSeverity.Critical ? 'text-danger' : 'text-warn'}">${finding.severity === PreflightSeverity.Critical ? '✗' : '⚠'} ${finding.code}</span>`
      : '<span style="color:var(--success)">✓</span>';

    html += `<tr>
      <td>${stripLevelText(slot.label)}</td>
      <td>${slot.acceptableLevels.map(l => levelBadge(l)).join(' ')}</td>
      <td>${slot.requiredCertifications.length > 0 ? slot.requiredCertifications.map(c => certBadge(c)).join(' ') : '<span class="text-muted">אין</span>'}</td>
      <td>${statusHtml}</td>
      <td><button class="btn-sm btn-danger-outline" data-action="remove-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''} data-slotid="${slot.id}">✕</button></td>
    </tr>`;
  }

  html += '</tbody></table>';
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
      <span>הסמכות:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-cert="${c}" /> ${c}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''}>הוסף</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-slot">ביטול</button>
    </div>
  </div>`;
}

function renderAddTemplateForm(): string {
  return `<div class="add-form" id="add-template-form">
    <h4>תבנית משימה חדשה</h4>
    <div class="form-row">
      <label>שם: <input class="input-sm" type="text" data-field="tpl-name" placeholder="שם משימה" /></label>
      <label>סוג:
        <select class="input-sm" data-field="tpl-type">
          ${TASK_TYPE_OPTIONS.map(t => `<option value="${t}">${TASK_TYPE_LABELS[t] || t}</option>`).join('')}
          <option value="Custom">מותאם אישית</option>
        </select>
      </label>
      <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
      <label>משמרות/יום: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
      <label>שעת התחלה: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="tpl-start" /></label>
      <label>יחס חישוב עומס (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="1" data-field="tpl-base-load" /></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> אותה קבוצה</label>
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

// ─── Event Wiring ────────────────────────────────────────────────────────────

export function wireTaskRulesEvents(container: HTMLElement, rerender: () => void): void {
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const action = target.dataset.action;
    if (!action) return;

    switch (action) {
      case 'toggle-template': {
        const tid = target.closest('[data-tid]')?.getAttribute('data-tid') || target.dataset.tid!;
        expandedTemplateId = expandedTemplateId === tid ? null : tid;
        addingSlotTo = null;
        rerender();
        break;
      }
      case 'save-template-props': {
        const tid = target.dataset.tid!;
        const body = target.closest('.template-body')!;
        const dur = parseFloat((body.querySelector('[data-tpl-field="durationHours"]') as HTMLInputElement)?.value || '8');
        const shifts = parseInt((body.querySelector('[data-tpl-field="shiftsPerDay"]') as HTMLInputElement)?.value || '1');
        const startH = parseInt((body.querySelector('[data-tpl-field="startHour"]') as HTMLInputElement)?.value || '6');
        const baseLoad = parseFloat((body.querySelector('[data-tpl-field="baseLoadWeight"]') as HTMLInputElement)?.value || '1');
        const sameGroup = (body.querySelector('[data-tpl-field="sameGroupRequired"]') as HTMLInputElement)?.checked || false;
        const isLight = (body.querySelector('[data-tpl-field="isLight"]') as HTMLInputElement)?.checked || false;
        const blocksConsecutive = (body.querySelector('[data-tpl-field="blocksConsecutive"]') as HTMLInputElement)?.checked || false;

        store.updateTaskTemplate(tid, {
          durationHours: dur, shiftsPerDay: shifts, startHour: startH,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          sameGroupRequired: sameGroup, isLight, blocksConsecutive,
        });
        rerender();
        break;
      }
      case 'add-load-window': {
        const tid = target.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        const block = target.closest('.add-slot-form');
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
        const tid = target.dataset.tid!;
        const lwid = target.dataset.lwid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;

        const body = target.closest('.template-body') as HTMLElement | null;
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
        const tid = target.dataset.tid!;
        const lwid = target.dataset.lwid!;
        const tpl = store.getTaskTemplate(tid);
        if (!tpl) break;
        store.updateTaskTemplate(tid, {
          loadWindows: (tpl.loadWindows || []).filter((w) => w.id !== lwid),
        });
        rerender();
        break;
      }
      case 'add-subteam': {
        const tid = target.dataset.tid!;
        const name = prompt('שם תת-צוות:');
        if (!name) return;
        store.addSubTeamToTemplate(tid, name.trim());
        rerender();
        break;
      }
      case 'remove-subteam': {
        const tid = target.dataset.tid!;
        const stid = target.dataset.stid!;
        if (confirm('להסיר תת-צוות זה ואת כל המשבצות שלו?')) {
          store.removeSubTeamFromTemplate(tid, stid);
          rerender();
        }
        break;
      }
      case 'add-slot': {
        const tid = target.dataset.tid!;
        addingSlotTo = { templateId: tid };
        rerender();
        break;
      }
      case 'add-slot-subteam': {
        const tid = target.dataset.tid!;
        const stid = target.dataset.stid!;
        addingSlotTo = { templateId: tid, subTeamId: stid };
        rerender();
        break;
      }
      case 'confirm-add-slot': {
        const tid = target.dataset.tid!;
        const stid = target.dataset.stid;
        const form = target.closest('.add-slot-form')!;
        const label = (form.querySelector('[data-field="slot-label"]') as HTMLInputElement)?.value.trim() || 'משבצת';
        const levels: Level[] = [];
        form.querySelectorAll<HTMLInputElement>('[data-slot-level]').forEach(cb => {
          if (cb.checked) levels.push(parseInt(cb.dataset.slotLevel!) as Level);
        });
        const certs: Certification[] = [];
        form.querySelectorAll<HTMLInputElement>('[data-slot-cert]').forEach(cb => {
          if (cb.checked) certs.push(cb.dataset.slotCert as Certification);
        });

        const slot: Omit<SlotTemplate, 'id'> = {
          label, acceptableLevels: levels, requiredCertifications: certs,
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
        const tid = target.dataset.tid!;
        const stid = target.dataset.stid;
        const slotId = target.dataset.slotid!;
        if (stid) {
          store.removeSlotFromSubTeam(tid, stid, slotId);
        } else {
          store.removeSlotFromTemplate(tid, slotId);
        }
        rerender();
        break;
      }
      case 'remove-template': {
        const tid = target.dataset.tid!;
        const tpl = store.getTaskTemplate(tid);
        if (tpl && confirm(`להסיר תבנית "${tpl.name}"?`)) {
          store.removeTaskTemplate(tid);
          if (expandedTemplateId === tid) expandedTemplateId = null;
          rerender();
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
    }
  });
}
