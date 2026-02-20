/**
 * Algorithm Tab — Advanced Algorithm Control Panel
 *
 * Organized into logical groups with inline descriptions, collapsible
 * details, and clear explanations for every setting.
 */

import {
  SchedulerConfig,
  DEFAULT_CONFIG,
  HardConstraintCode,
  SoftWarningCode,
  ALL_HC_CODES,
  ALL_SW_CODES,
  HC_LABELS,
  SW_LABELS,
} from '../models/types';
import * as store from './config-store';

// ─── Weight field metadata ───────────────────────────────────────────────────

interface WeightField {
  key: keyof SchedulerConfig;
  label: string;
  min: number;
  max: number;
  step: number;
  description: string;
  /** Collapsible detail — shown inside a <details> element */
  detail?: string;
}

/** Group of related weight fields displayed together */
interface WeightGroup {
  title: string;
  description: string;
  fields: WeightField[];
}

const WEIGHT_GROUPS: WeightGroup[] = [
  {
    title: 'Workload Fairness',
    description: 'Controls how aggressively the optimizer equalizes workload across participants. Higher values produce more even distribution but may reduce overall scheduling flexibility.',
    fields: [
      {
        key: 'l0FairnessWeight',
        label: 'Standard participant fairness',
        min: 0, max: 200, step: 1,
        description: 'How evenly work hours are spread among standard (L0) participants. Higher = more equal distribution.',
        detail: 'If participant A works 12 effective hours and participant B works 6, the optimizer penalizes this gap. At weight 40 (default), evening out L0 workload matters more than almost any other factor. Set to 0 to ignore L0 fairness entirely.',
      },
      {
        key: 'seniorFairnessWeight',
        label: 'Senior participant fairness',
        min: 0, max: 200, step: 1,
        description: 'How evenly work hours are spread among senior (L2–L4) participants. Lower priority since the senior pool is smaller.',
        detail: 'Seniors have fewer eligible tasks (mainly Adanit), so their workload range is narrower. Default 6 is intentionally low compared to L0 fairness (40). Increase if you notice senior workload becoming lopsided.',
      },
      {
        key: 'dailyBalanceWeight',
        label: 'Day-to-day balance',
        min: 0, max: 200, step: 1,
        description: 'Discourages "heavy day / light day" patterns — aims for consistent daily workload per person and across the schedule.',
        detail: 'Two metrics are combined: (1) each participant\'s daily hours should be roughly even, and (2) the total hours across all participants per calendar day should be roughly even. Default 90 makes daily balance one of the strongest scoring factors.',
      },
    ],
  },
  {
    title: 'Rest & Safety',
    description: 'Controls how the optimizer values rest time between consecutive blocking assignments (HC-12 tasks). Non-blocking tasks like Karov are excluded from rest penalty.',
    fields: [
      {
        key: 'minRestWeight',
        label: 'Minimum rest priority',
        min: 0, max: 200, step: 1,
        description: 'How much the optimizer values rest between blocking shifts. Higher = longer gaps between a person\'s consecutive blocking tasks.',
        detail: 'Only gaps where BOTH adjacent tasks have "Blocks Consecutive" (HC-12) enabled count toward rest scoring. For example, Adanit→Shemesh gaps are penalised, but Karov→Shemesh gaps are not. The composite score adds (minRestWeight × minimum rest hours). At the default of 10, each additional hour of minimum rest is worth 10 score points.',
      },
    ],
  },
  {
    title: 'Senior Participant Policy',
    description: 'Penalty applied when an L4 participant is assigned to Hamama as a last resort. All other out-of-role assignments are hard-blocked by HC-13.',
    fields: [
      {
        key: 'seniorHamamaPenalty',
        label: 'Senior on Hamama',
        min: 0, max: 50000, step: 100,
        description: 'Heavy penalty when an L4 is placed on Hamama duty. This is an absolute last resort — only L4 can be assigned (L2/L3 are hard-blocked).',
        detail: 'At the default of 10,000, placing one L4 on Hamama costs the same as having 250 units of workload unfairness. The optimizer will try every other option before resorting to this. Only L4 can be placed here (L2/L3 are hard-blocked by HC-13).',
      },
    ],
  },
  {
    title: 'General Scoring',
    description: 'Multiplier that scales all penalty points in the final composite score.',
    fields: [
      {
        key: 'penaltyWeight',
        label: 'Overall penalty multiplier',
        min: 0, max: 100, step: 1,
        description: 'Scales all penalty points (senior Hamama, etc.) in the final score. Increase to make penalty avoidance more aggressive.',
        detail: 'The composite score subtracts (penaltyWeight × totalPenalty). At the default of 1, penalties are applied at face value. At 2, every penalty point hurts twice as much. Set to 0 to ignore all penalties (not recommended).',
      },
    ],
  },
];

const SOLVER_FIELDS: WeightField[] = [
  {
    key: 'maxIterations',
    label: 'Maximum iterations',
    min: 1000, max: 200000, step: 1000,
    description: 'How many swap attempts the optimizer explores. More iterations = potentially better results but longer run time.',
    detail: 'The simulated annealing optimizer tries swapping pairs of assignments to improve the score. Each swap attempt counts as one iteration. Default 10,000 gives good results for most schedules. For very large participant pools (30+), try 50,000+.',
  },
  {
    key: 'maxSolverTimeMs',
    label: 'Time limit (ms)',
    min: 1000, max: 120000, step: 1000,
    description: 'Maximum wall-clock time the optimizer is allowed to run. The solver stops early when this limit is reached.',
    detail: 'Even if iterations remain, the solver stops when this time limit is reached. Default 30,000ms (30 seconds) is sufficient for most cases. For very tight schedules, allowing more time (60,000+) may find better solutions.',
  },
];

// ─── HC/SW Extended Descriptions ─────────────────────────────────────────────

const HC_DESCRIPTIONS: Record<HardConstraintCode, string> = {
  'HC-1': 'Participant\'s level must match or exceed the slot\'s acceptable levels.',
  'HC-2': 'Participant must hold all certifications required by the slot.',
  'HC-3': 'Participant must be available during the entire task time window.',
  'HC-4': 'All participants in a same-group task must belong to the same group.',
  'HC-5': 'A participant cannot be assigned to two overlapping tasks.',
  'HC-6': 'Every slot in every task must have exactly one assigned participant.',
  'HC-7': 'A participant cannot fill multiple slots in the same task.',
  'HC-8': 'The chosen group must have enough qualified participants (≥4 L0, ≥1 L2, ≥1 L3/L4 with Nitzan).',
  'HC-11': 'Participants with Horesh certification cannot be assigned to Mamtera tasks.',
  'HC-12': 'Two back-to-back heavy tasks (both blocking) cannot be assigned to the same person.',
  'HC-13': 'Seniors (L2/L3/L4) can only be assigned to their natural domain; L2/L3 fully blocked from Hamama.',
};

const SW_DESCRIPTIONS: Record<SoftWarningCode, string> = {
  'HAMAMA_SENIOR': 'When enabled: warns if L4 is placed on Hamama, and applies the "Senior on Hamama" penalty to scoring. Disable to allow L4 on Hamama without penalty.',
  'GROUP_MISMATCH': 'Safety-net warning if a same-group task ends up with participants from different groups (should be caught by HC-4).',
  'DAILY_IMBALANCE': 'When enabled: warns when someone\'s busiest day is ≥2× their lightest, and applies the daily balance scoring weight. Disable to allow uneven day distribution.',
};

// Improved SW labels for clarity
const SW_LABELS_EXTENDED: Record<SoftWarningCode, string> = {
  'HAMAMA_SENIOR': 'Senior on Hamama — warning + penalty',
  'GROUP_MISMATCH': 'Group mismatch — safety warning',
  'DAILY_IMBALANCE': 'Daily workload imbalance — warning + penalty',
};

// ─── Debounce-safe pending weight state ──────────────────────────────────────

let _weightDebounce: number = 0;
let _pendingWeight: { key: string; value: number } | null = null;
let _pendingRerender: (() => void) | null = null;

/** Flush any pending (debounced) slider write immediately. */
export function flushPendingWeightUpdate(): void {
  if (_pendingWeight) {
    clearTimeout(_weightDebounce);
    const { key, value } = _pendingWeight;
    _pendingWeight = null;
    const settings = store.getAlgorithmSettings();
    const newConfig = { ...settings.config, [key]: value };
    store.setAlgorithmSettings({ config: newConfig });
    if (_pendingRerender) _pendingRerender();
  }
}

// Register flush with the config-store so preset save operations can call it
store.registerWeightFlush(flushPendingWeightUpdate);

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderAlgorithmTab(): string {
  const settings = store.getAlgorithmSettings();
  const cfg = settings.config;
  const disabledHC = new Set(settings.disabledHardConstraints);
  const disabledSW = new Set(settings.disabledSoftWarnings);

  const presets = store.getAllPresets();
  const activeId = store.getActivePresetId();
  const dirty = store.isPresetDirty();
  const activePreset = activeId ? presets.find(p => p.id === activeId) : undefined;
  const isBuiltIn = activePreset?.builtIn ?? false;

  // ── Preset Toolbar ──
  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>Algorithm Settings</h2>
    </div>
    <div class="toolbar-right">
      <select class="preset-select" data-action="algo-preset-select">
        ${presets.map(p => `<option value="${p.id}"${p.id === activeId ? ' selected' : ''}>${_escHtml(p.name)}${p.id === activeId && dirty ? ' (modified)' : ''}</option>`).join('')}
      </select>
      ${dirty ? '<span class="preset-dirty-badge">modified</span>' : ''}
      <button class="btn btn-sm btn-primary" data-action="algo-preset-save" ${(!dirty || isBuiltIn) ? 'disabled' : ''} title="${isBuiltIn ? 'Cannot overwrite built-in preset — use Save As' : 'Save changes to this preset'}">Save</button>
      <button class="btn btn-sm" data-action="algo-preset-saveas">Save As…</button>
      <button class="btn btn-sm" data-action="algo-preset-rename" ${isBuiltIn ? 'disabled' : ''}>Rename</button>
      <button class="btn btn-sm btn-danger" data-action="algo-preset-delete" ${isBuiltIn ? 'disabled' : ''}>Delete</button>
    </div>
  </div>

  <!-- Save-As inline form (hidden by default) -->
  <div class="preset-inline-form" id="preset-saveas-form" style="display:none;">
    <div class="preset-form-row">
      <label>Name: <input type="text" class="preset-name-input" data-field="saveas-name" maxlength="60" placeholder="My preset" /></label>
      <label>Description: <input type="text" class="preset-desc-input" data-field="saveas-desc" maxlength="200" placeholder="Optional description" /></label>
      <button class="btn btn-sm btn-primary" data-action="algo-preset-saveas-confirm">Confirm</button>
      <button class="btn btn-sm" data-action="algo-preset-saveas-cancel">Cancel</button>
    </div>
    <div class="preset-validation-error" id="saveas-error"></div>
  </div>

  <!-- Rename inline form (hidden by default) -->
  <div class="preset-inline-form" id="preset-rename-form" style="display:none;">
    <div class="preset-form-row">
      <label>Name: <input type="text" class="preset-name-input" data-field="rename-name" maxlength="60" /></label>
      <label>Description: <input type="text" class="preset-desc-input" data-field="rename-desc" maxlength="200" /></label>
      <button class="btn btn-sm btn-primary" data-action="algo-preset-rename-confirm">Confirm</button>
      <button class="btn btn-sm" data-action="algo-preset-rename-cancel">Cancel</button>
    </div>
    <div class="preset-validation-error" id="rename-error"></div>
  </div>`;

  // ── Grouped Scoring Weight Sections ──
  for (const group of WEIGHT_GROUPS) {
    html += `
  <div class="algo-section">
    <h3 class="algo-section-title">${group.title}</h3>
    <p class="algo-section-desc">${group.description}</p>
    <div class="algo-grid">`;

    for (const f of group.fields) {
      const val = cfg[f.key];
      const defaultVal = DEFAULT_CONFIG[f.key];
      const isCustom = val !== defaultVal;
      html += renderWeightInput(f, val, defaultVal, isCustom);
    }

    html += `
    </div>
  </div>`;
  }

  // ── Solver Parameters ──
  html += `
  <div class="algo-section">
    <h3 class="algo-section-title">Solver Tuning</h3>
    <p class="algo-section-desc">Control how long and how hard the optimizer searches for a good schedule. Higher values may produce better results but take longer.</p>
    <div class="algo-grid">`;

  for (const f of SOLVER_FIELDS) {
    const val = cfg[f.key];
    const defaultVal = DEFAULT_CONFIG[f.key];
    const isCustom = val !== defaultVal;
    html += renderWeightInput(f, val, defaultVal, isCustom);
  }

  html += `
    </div>
  </div>`;

  // ── Hard Constraint Toggles ──
  html += `
  <div class="algo-section">
    <h3 class="algo-section-title">Hard Constraints</h3>
    <p class="algo-section-desc">Rules that must be satisfied for a valid schedule. Uncheck to skip a rule everywhere — optimizer, validator, and UI warnings. <strong>Disabling constraints may produce invalid schedules.</strong></p>
    <div class="algo-toggle-list">`;

  for (const code of ALL_HC_CODES) {
    const enabled = !disabledHC.has(code);
    html += `
      <label class="algo-toggle-item${enabled ? '' : ' disabled'}">
        <input type="checkbox" data-action="algo-toggle-hc" data-code="${code}" ${enabled ? 'checked' : ''} />
        <span class="algo-toggle-code">${code}</span>
        <div class="algo-toggle-content">
          <span class="algo-toggle-label">${HC_LABELS[code]}</span>
          <span class="algo-toggle-desc">${HC_DESCRIPTIONS[code]}</span>
          ${!enabled ? '<span class="algo-toggle-warning">⚠ Disabled — the optimizer and validator will skip this check</span>' : ''}
        </div>
      </label>`;
  }

  html += `
    </div>
  </div>`;

  // ── Soft Warning Toggles ──
  html += `
  <div class="algo-section">
    <h3 class="algo-section-title">Soft Warnings</h3>
    <p class="algo-section-desc">Warnings and scoring penalties that guide the optimizer toward better schedules without making them invalid. Unchecking disables both the warning message <strong>and</strong> the associated scoring penalty.</p>
    <div class="algo-toggle-list">`;

  for (const code of ALL_SW_CODES) {
    const enabled = !disabledSW.has(code);
    html += `
      <label class="algo-toggle-item${enabled ? '' : ' disabled'}">
        <input type="checkbox" data-action="algo-toggle-sw" data-code="${code}" ${enabled ? 'checked' : ''} />
        <div class="algo-toggle-content">
          <span class="algo-toggle-label">${SW_LABELS_EXTENDED[code]}</span>
          <span class="algo-toggle-desc">${SW_DESCRIPTIONS[code]}</span>
          ${!enabled ? '<span class="algo-toggle-warning">⚠ Disabled — warning suppressed and scoring penalty removed</span>' : ''}
        </div>
      </label>`;
  }

  html += `
    </div>
  </div>`;

  return html;
}

// ─── Weight Input Renderer ───────────────────────────────────────────────────

function renderWeightInput(f: WeightField, value: number, defaultVal: number, isCustom: boolean): string {
  return `
    <div class="algo-weight-card${isCustom ? ' modified' : ''}">
      <div class="algo-weight-header">
        <label class="algo-weight-label" title="${f.description}">${f.label}</label>
        ${isCustom ? `<span class="algo-weight-default" title="Default: ${defaultVal}">↺ ${defaultVal}</span>` : ''}
      </div>
      <div class="algo-weight-controls">
        <input type="range"
               class="algo-slider"
               data-action="algo-weight-slider"
               data-key="${f.key}"
               min="${f.min}" max="${f.max}" step="${f.step}"
               value="${value}" />
        <input type="number"
               class="algo-weight-input"
               data-action="algo-weight-input"
               data-key="${f.key}"
               min="${f.min}" max="${f.max}" step="${f.step}"
               value="${value}" />
      </div>
      <p class="algo-weight-desc">${f.description}</p>
      ${f.detail ? `
      <details class="algo-weight-details">
        <summary>Learn more</summary>
        <p>${f.detail}</p>
      </details>` : ''}
    </div>`;
}

// ─── Wire Events ─────────────────────────────────────────────────────────────

export function wireAlgorithmEvents(container: HTMLElement, rerender: () => void): void {
  // Store rerender for debounce flush
  _pendingRerender = rerender;

  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    switch (action) {
      case 'algo-preset-save': {
        const activeId = store.getActivePresetId();
        if (activeId) {
          store.updatePreset(activeId);
          rerender();
        }
        break;
      }

      case 'algo-preset-saveas': {
        const form = container.querySelector<HTMLElement>('#preset-saveas-form');
        if (form) {
          form.style.display = form.style.display === 'none' ? '' : 'none';
          // Hide rename form if open
          const renameForm = container.querySelector<HTMLElement>('#preset-rename-form');
          if (renameForm) renameForm.style.display = 'none';
          // Focus name input
          const nameInput = form.querySelector<HTMLInputElement>('[data-field="saveas-name"]');
          if (nameInput) { nameInput.value = ''; nameInput.focus(); }
          const descInput = form.querySelector<HTMLInputElement>('[data-field="saveas-desc"]');
          if (descInput) descInput.value = '';
          const errEl = form.querySelector<HTMLElement>('#saveas-error');
          if (errEl) errEl.textContent = '';
        }
        break;
      }

      case 'algo-preset-saveas-confirm': {
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="saveas-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="saveas-desc"]');
        const errEl = container.querySelector<HTMLElement>('#saveas-error');
        const name = nameInput?.value.trim() ?? '';
        const desc = descInput?.value.trim() ?? '';
        if (!name) {
          if (errEl) errEl.textContent = 'Name cannot be empty';
          return;
        }
        const result = store.saveCurrentAsPreset(name, desc);
        if (!result) {
          if (errEl) errEl.textContent = 'A preset with this name already exists';
          return;
        }
        rerender();
        break;
      }

      case 'algo-preset-saveas-cancel': {
        const form = container.querySelector<HTMLElement>('#preset-saveas-form');
        if (form) form.style.display = 'none';
        break;
      }

      case 'algo-preset-rename': {
        const form = container.querySelector<HTMLElement>('#preset-rename-form');
        if (form) {
          form.style.display = form.style.display === 'none' ? '' : 'none';
          // Hide save-as form if open
          const saveAsForm = container.querySelector<HTMLElement>('#preset-saveas-form');
          if (saveAsForm) saveAsForm.style.display = 'none';
          // Pre-fill with current preset info
          const activeId = store.getActivePresetId();
          const preset = activeId ? store.getPresetById(activeId) : undefined;
          const nameInput = form.querySelector<HTMLInputElement>('[data-field="rename-name"]');
          const descInput = form.querySelector<HTMLInputElement>('[data-field="rename-desc"]');
          if (nameInput) { nameInput.value = preset?.name ?? ''; nameInput.focus(); }
          if (descInput) descInput.value = preset?.description ?? '';
          const errEl = form.querySelector<HTMLElement>('#rename-error');
          if (errEl) errEl.textContent = '';
        }
        break;
      }

      case 'algo-preset-rename-confirm': {
        const activeId = store.getActivePresetId();
        if (!activeId) return;
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="rename-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="rename-desc"]');
        const errEl = container.querySelector<HTMLElement>('#rename-error');
        const name = nameInput?.value.trim() ?? '';
        const desc = descInput?.value.trim() ?? '';
        if (!name) {
          if (errEl) errEl.textContent = 'Name cannot be empty';
          return;
        }
        const err = store.renamePreset(activeId, name, desc);
        if (err) {
          if (errEl) errEl.textContent = err;
          return;
        }
        rerender();
        break;
      }

      case 'algo-preset-rename-cancel': {
        const form = container.querySelector<HTMLElement>('#preset-rename-form');
        if (form) form.style.display = 'none';
        break;
      }

      case 'algo-preset-delete': {
        const activeId = store.getActivePresetId();
        if (!activeId) return;
        const preset = store.getPresetById(activeId);
        if (!preset || preset.builtIn) return;
        if (!confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return;
        store.deletePreset(activeId);
        rerender();
        break;
      }
    }
  });

  container.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const action = el.dataset.action;
    if (!action) return;

    switch (action) {
      case 'algo-preset-select': {
        const id = (el as HTMLSelectElement).value;
        store.loadPreset(id);
        rerender();
        break;
      }
      case 'algo-toggle-hc': {
        const code = (el as HTMLInputElement).dataset.code as HardConstraintCode;
        const settings = store.getAlgorithmSettings();
        const set = new Set(settings.disabledHardConstraints);
        if ((el as HTMLInputElement).checked) set.delete(code); else set.add(code);
        store.setAlgorithmSettings({ disabledHardConstraints: [...set] });
        rerender();
        break;
      }
      case 'algo-toggle-sw': {
        const code = (el as HTMLInputElement).dataset.code as SoftWarningCode;
        const settings = store.getAlgorithmSettings();
        const set = new Set(settings.disabledSoftWarnings);
        if ((el as HTMLInputElement).checked) set.delete(code); else set.add(code);
        store.setAlgorithmSettings({ disabledSoftWarnings: [...set] });
        rerender();
        break;
      }
    }
  });

  // Slider + numeric input sync (with flushable debounce)
  container.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const action = el.dataset.action;
    if (!action) return;
    const key = el.dataset.key as keyof SchedulerConfig | undefined;
    if (!key) return;

    if (action === 'algo-weight-slider' || action === 'algo-weight-input') {
      const numVal = parseFloat(el.value);
      if (isNaN(numVal)) return;

      // Sync the paired control (slider ↔ number input)
      const card = el.closest('.algo-weight-card');
      if (card) {
        const sibling = action === 'algo-weight-slider'
          ? card.querySelector<HTMLInputElement>('[data-action="algo-weight-input"]')
          : card.querySelector<HTMLInputElement>('[data-action="algo-weight-slider"]');
        if (sibling) sibling.value = String(numVal);
      }

      // Store pending value and debounce persist
      _pendingWeight = { key, value: numVal };
      clearTimeout(_weightDebounce);
      _weightDebounce = window.setTimeout(() => {
        if (!_pendingWeight) return;
        const { key: k, value: v } = _pendingWeight;
        _pendingWeight = null;
        const settings = store.getAlgorithmSettings();
        const newConfig = { ...settings.config, [k]: v };
        store.setAlgorithmSettings({ config: newConfig });
        rerender();
      }, 300);
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
