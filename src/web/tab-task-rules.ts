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
const CERT_OPTIONS = [Certification.Nitzan, Certification.Hamama, Certification.Salsala];
const TASK_TYPE_OPTIONS = Object.values(TaskType);

const TASK_COLORS: Record<string, string> = {
  Adanit: '#4A90D9', Hamama: '#E74C3C', Shemesh: '#F39C12',
  Mamtera: '#27AE60', Karov: '#8E44AD', Karovit: '#BDC3C7', Aruga: '#1ABC9C',
};

function taskTypeBadge(type: string): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${type}</span>`;
}

function levelBadge(level: Level): string {
  const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
  return `<span class="badge badge-sm" style="background:${colors[level]}">L${level}</span>`;
}

function certBadge(cert: Certification): string {
  const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
  return `<span class="badge badge-sm" style="background:${colors[cert] || '#7f8c8d'}">${cert}</span>`;
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

  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>Task Rules <span class="count">${templates.length}</span></h2>
    </div>
    <div class="toolbar-right">
      <button class="btn-primary btn-sm" data-action="toggle-add-template">+ New Task Template</button>
    </div>
  </div>`;

  // Preflight panel
  html += renderPreflightPanel(preflight);

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

function renderPreflightPanel(pf: PreflightResult): string {
  const criticals = pf.findings.filter(f => f.severity === PreflightSeverity.Critical);
  const warnings = pf.findings.filter(f => f.severity === PreflightSeverity.Warning);
  const infos = pf.findings.filter(f => f.severity === PreflightSeverity.Info);

  const cs = pf.utilizationSummary;
  const utilizationClass = cs.utilizationPercent > 100 ? 'text-danger'
    : cs.utilizationPercent > 90 ? 'text-warn' : '';

  let html = `<div class="preflight-panel">
    <h3>Pre-Flight Check</h3>
    <div class="preflight-summary">
      <div class="score-grid" style="margin-bottom:12px;">
        <div class="score-card ${criticals.length > 0 ? 'status-error' : 'status-ok'}">
          <div class="score-value">${criticals.length > 0 ? '✗ Blocked' : '✓ Ready'}</div>
          <div class="score-label">Generate Status</div>
        </div>
        <div class="score-card">
          <div class="score-value">${cs.totalRequiredSlots}</div>
          <div class="score-label">Total Slots/Day</div>
        </div>
        <div class="score-card">
          <div class="score-value">${cs.totalRequiredHours.toFixed(0)}h</div>
          <div class="score-label">Required Hours</div>
        </div>
        <div class="score-card">
          <div class="score-value">${cs.totalAvailableParticipantHours.toFixed(0)}h</div>
          <div class="score-label">Available Hours</div>
        </div>
        <div class="score-card">
          <div class="score-value ${utilizationClass}">${cs.utilizationPercent.toFixed(1)}%</div>
          <div class="score-label">Utilization</div>
        </div>
      </div>`;

  if (criticals.length > 0) {
    html += `<div class="alert alert-error"><strong>Critical Issues (${criticals.length})</strong><ul>`;
    for (const f of criticals) html += `<li><code>${f.code}</code> ${f.message}</li>`;
    html += '</ul></div>';
  }
  if (warnings.length > 0) {
    html += `<div class="alert alert-warn"><strong>Warnings (${warnings.length})</strong><ul>`;
    for (const f of warnings) html += `<li><code>${f.code}</code> ${f.message}</li>`;
    html += '</ul></div>';
  }
  if (criticals.length === 0 && warnings.length === 0) {
    html += '<div class="alert alert-ok">All pre-flight checks passed. Ready to generate schedule.</div>';
  }

  html += `</div></div>`;
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
        <span class="text-muted"> · ${tpl.durationHours}h × ${tpl.shiftsPerDay} shifts · ${totalSlots} slots/shift · ${totalPeople} people/day</span>
        ${hasCritical ? '<span class="badge badge-sm" style="background:var(--danger)">!</span>' : ''}
        ${hasWarning && !hasCritical ? '<span class="badge badge-sm" style="background:var(--warning)">⚠</span>' : ''}
      </div>
      <div class="template-toggles">
        ${tpl.sameGroupRequired ? '<span class="badge badge-sm badge-outline">Same Group</span>' : ''}
        ${tpl.isLight ? '<span class="badge badge-sm badge-outline">Light</span>' : ''}
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
      <label>Duration (h): <input class="input-sm" type="number" step="0.5" min="0.5" data-tpl-field="durationHours" value="${tpl.durationHours}" data-tid="${tpl.id}" /></label>
      <label>Shifts/Day: <input class="input-sm" type="number" min="1" max="12" data-tpl-field="shiftsPerDay" value="${tpl.shiftsPerDay}" data-tid="${tpl.id}" /></label>
      <label>Start Hour: <input class="input-sm" type="number" min="0" max="23" data-tpl-field="startHour" value="${tpl.startHour}" data-tid="${tpl.id}" /></label>
      <label>Base Load (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-tpl-field="baseLoadWeight" value="${(tpl.baseLoadWeight ?? (tpl.isLight ? 0 : 1)).toFixed(2)}" data-tid="${tpl.id}" /></label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="sameGroupRequired" data-tid="${tpl.id}" ${tpl.sameGroupRequired ? 'checked' : ''} /> Same Group</label>
      <label class="checkbox-label"><input type="checkbox" data-tpl-field="isLight" data-tid="${tpl.id}" ${tpl.isLight ? 'checked' : ''} /> Light Task</label>
      <button class="btn-sm btn-primary" data-action="save-template-props" data-tid="${tpl.id}">Apply</button>
    </div>`;

    html += renderLoadWindowsEditor(tpl);

    // Sub-teams
    if (tpl.subTeams.length > 0) {
      html += '<h4 style="margin:12px 0 8px;">Sub-Teams</h4>';
      for (const st of tpl.subTeams) {
        html += renderSubTeam(tpl.id, st, pf);
      }
    }

    // Top-level slots
    if (tpl.slots.length > 0 || tpl.subTeams.length === 0) {
      html += `<h4 style="margin:12px 0 8px;">${tpl.subTeams.length > 0 ? 'Additional' : ''} Slots</h4>`;
      html += renderSlotTable(tpl.id, tpl.slots, undefined, pf);
    }

    // Add sub-team / slot buttons
    html += `<div class="template-actions">
      <button class="btn-sm btn-outline" data-action="add-subteam" data-tid="${tpl.id}">+ Sub-Team</button>
      <button class="btn-sm btn-outline" data-action="add-slot" data-tid="${tpl.id}">+ Slot</button>
      <button class="btn-sm btn-danger-outline" data-action="remove-template" data-tid="${tpl.id}">Remove Template</button>
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
  let html = `<h4 style="margin:12px 0 8px;">Load Windows (Hot Zones)</h4>`;

  if (windows.length === 0) {
    html += '<p class="text-muted" style="padding:4px 0;">No hot windows. Base load applies to the whole task.</p>';
  } else {
    html += `<table class="table table-slots" style="margin-bottom:8px;">
      <thead><tr><th>Window</th><th>Weight</th><th></th></tr></thead>
      <tbody>`;
    for (const w of windows) {
      html += `<tr>
        <td>
          <input class="input-sm" type="time" data-field="lw-edit-start" data-lwid="${w.id}" value="${fmtHm(w.startHour, w.startMinute)}" />
          -
          <input class="input-sm" type="time" data-field="lw-edit-end" data-lwid="${w.id}" value="${fmtHm(w.endHour, w.endMinute)}" />
        </td>
        <td><input class="input-sm" type="number" step="0.05" min="0" max="1" data-field="lw-edit-weight" data-lwid="${w.id}" value="${w.weight.toFixed(2)}" /></td>
        <td>
          <button class="btn-sm btn-primary" data-action="update-load-window" data-tid="${tpl.id}" data-lwid="${w.id}">Save</button>
          <button class="btn-sm btn-danger-outline" data-action="remove-load-window" data-tid="${tpl.id}" data-lwid="${w.id}">✕</button>
        </td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  html += `<div class="add-slot-form" style="margin-top:8px;">
    <div class="form-row">
      <label>Start <input class="input-sm" type="time" data-field="lw-start" value="05:00" /></label>
      <label>End <input class="input-sm" type="time" data-field="lw-end" value="06:30" /></label>
      <label>Weight (0-1) <input class="input-sm" type="number" step="0.05" min="0" max="1" data-field="lw-weight" value="1" /></label>
      <button class="btn-sm btn-primary" data-action="add-load-window" data-tid="${tpl.id}">Add Hot Window</button>
    </div>
  </div>`;

  return html;
}

function renderSubTeam(templateId: string, st: SubTeamTemplate, pf: PreflightResult): string {
  let html = `<div class="subteam-card">
    <div class="subteam-header">
      <strong>${st.name}</strong>
      <span class="text-muted">(${st.slots.length} slots)</span>
      <button class="btn-sm btn-outline" data-action="add-slot-subteam" data-tid="${templateId}" data-stid="${st.id}">+ Slot</button>
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
  if (slots.length === 0) return '<p class="text-muted" style="padding:4px 0;">No slots defined.</p>';

  let html = `<table class="table table-slots">
    <thead><tr><th>Label</th><th>Levels</th><th>Certifications</th><th>Status</th><th></th></tr></thead>
    <tbody>`;

  for (const slot of slots) {
    const finding = pf.findings.find(f => f.slotId === slot.id);
    const statusHtml = finding
      ? `<span class="${finding.severity === PreflightSeverity.Critical ? 'text-danger' : 'text-warn'}">${finding.severity === PreflightSeverity.Critical ? '✗' : '⚠'} ${finding.code}</span>`
      : '<span style="color:var(--success)">✓</span>';

    html += `<tr>
      <td>${slot.label}</td>
      <td>${slot.acceptableLevels.map(l => levelBadge(l)).join(' ')}</td>
      <td>${slot.requiredCertifications.length > 0 ? slot.requiredCertifications.map(c => certBadge(c)).join(' ') : '<span class="text-muted">None</span>'}</td>
      <td>${statusHtml}</td>
      <td><button class="btn-sm btn-danger-outline" data-action="remove-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''} data-slotid="${slot.id}">✕</button></td>
    </tr>`;
  }

  html += '</tbody></table>';
  return html;
}

function renderAddSlotForm(templateId: string, subTeamId?: string): string {
  return `<div class="add-slot-form">
    <h5>Add Slot</h5>
    <div class="form-row">
      <label>Label: <input class="input-sm" type="text" data-field="slot-label" placeholder="e.g. L0 #1" /></label>
    </div>
    <div class="form-row">
      <span>Levels:</span>
      ${LEVEL_OPTIONS.map(l =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-level="${l}" checked /> L${l}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <span>Certifications:</span>
      ${CERT_OPTIONS.map(c =>
        `<label class="checkbox-label"><input type="checkbox" data-slot-cert="${c}" /> ${c}</label>`
      ).join('')}
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-slot" data-tid="${templateId}" ${subTeamId ? `data-stid="${subTeamId}"` : ''}>Add</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-slot">Cancel</button>
    </div>
  </div>`;
}

function renderAddTemplateForm(): string {
  return `<div class="add-form" id="add-template-form">
    <h4>New Task Template</h4>
    <div class="form-row">
      <label>Name: <input class="input-sm" type="text" data-field="tpl-name" placeholder="Task name" /></label>
      <label>Type:
        <select class="input-sm" data-field="tpl-type">
          ${TASK_TYPE_OPTIONS.map(t => `<option value="${t}">${t}</option>`).join('')}
          <option value="Custom">Custom</option>
        </select>
      </label>
      <label>Duration (h): <input class="input-sm" type="number" step="0.5" min="0.5" value="8" data-field="tpl-duration" /></label>
      <label>Shifts/Day: <input class="input-sm" type="number" min="1" max="12" value="1" data-field="tpl-shifts" /></label>
      <label>Start Hour: <input class="input-sm" type="number" min="0" max="23" value="6" data-field="tpl-start" /></label>
      <label>Base Load (0-1): <input class="input-sm" type="number" step="0.05" min="0" max="1" value="1" data-field="tpl-base-load" /></label>
    </div>
    <div class="form-row">
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-samegroup" /> Same Group Required</label>
      <label class="checkbox-label"><input type="checkbox" data-field="tpl-light" /> Light Task</label>
    </div>
    <div class="form-row">
      <label>Description: <input class="input-sm" type="text" data-field="tpl-desc" placeholder="Optional" style="width:300px;" /></label>
    </div>
    <div class="form-row">
      <button class="btn-sm btn-primary" data-action="confirm-add-template">Create</button>
      <button class="btn-sm btn-outline" data-action="cancel-add-template">Cancel</button>
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

        store.updateTaskTemplate(tid, {
          durationHours: dur, shiftsPerDay: shifts, startHour: startH,
          baseLoadWeight: isLight ? 0 : Math.max(0, Math.min(1, baseLoad)),
          sameGroupRequired: sameGroup, isLight,
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
        const name = prompt('Sub-team name:');
        if (!name) return;
        store.addSubTeamToTemplate(tid, name.trim());
        rerender();
        break;
      }
      case 'remove-subteam': {
        const tid = target.dataset.tid!;
        const stid = target.dataset.stid!;
        if (confirm('Remove this sub-team and all its slots?')) {
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
        const label = (form.querySelector('[data-field="slot-label"]') as HTMLInputElement)?.value.trim() || 'Slot';
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
        if (tpl && confirm(`Remove template "${tpl.name}"?`)) {
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
