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
  AlgorithmPreset,
} from '../models/types';
import * as store from './config-store';
import { showConfirm, showToast, renderCustomSelect, wireCustomSelect } from './ui-modal';
import { escHtml } from './ui-helpers';

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
    title: 'שוויון עומס',
    description: 'עד כמה חשוב לאופטימייזר לחלק את העבודה באופן שוויוני בין המשתתפים. ערך גבוה יוביל לחלוקה מאוזנת יותר, אבל לפחות גמישות.',
    fields: [
      {
        key: 'l0FairnessWeight',
        label: 'משקל שיוויוניות L0',
        min: 0, max: 200, step: 1,
        description: 'עד כמה חשוב לחלק את שעות העבודה באופן שווה בין משתתפי L0. ערך גבוה = חלוקה שוויונית יותר.',
        detail: 'אם משתתף א\' עובד 12 שעות אפקטיביות ומשתתף ב\' עובד 6, האופטימייזר מעניש פער זה. במשקל 40 (ברירת מחדל), שיוויון עומס L0 חשוב יותר מכמעט כל גורם אחר. הגדר 0 כדי להתעלם משיוויוניות L0 לחלוטין.',
      },
      {
        key: 'seniorFairnessWeight',
        label: 'משקל שיוויוניות סגל',
        min: 0, max: 200, step: 1,
        description: 'עד כמה שעות העבודה מתחלקות בשווה בין משתתפי סגל (L2–L4). עדיפות נמוכה יותר כי מאגר הסגל קטן.',
        detail: 'לסגל יש פחות משימות מתאימות (בעיקר אדנית), ולכן טווח העומס שלהם מצומצם יותר. ברירת מחדל 6 נמוכה בכוונה בהשוואה לשיוויוניות L0 (40). הגדל אם אתה מבחין שעומס הסגל הופך לא מאוזן.',
      },
      {
        key: 'dailyBalanceWeight',
        label: 'משקל האיזון היומי',
        min: 0, max: 200, step: 1,
        description: 'מצמצם פערים בין ימים עמוסים לימים קלים — שואף לעומס עבודה יומי עקבי לכל אדם ולאורך כל הלו"ז.',
        detail: 'שני מדדים משולבים: (1) שעות העבודה היומיות של כל משתתף צריכות להיות אחידות בקירוב, ו-(2) סה"כ השעות של כל המשתתפים ביום קלנדרי נתון צריך להיות אחיד בקירוב. ברירת מחדל 90 הופכת את האיזון היומי לאחד מגורמי הניקוד החזקים ביותר.',
      },
    ],
  },
  {
    title: 'מנוחה בין משימות',
    description: 'עד כמה חשוב לשמור על הפסקה בין משימות חוסמות עוקבות. משימות קלות כמו כרוב לא נכללות בחישוב הזה.',
    fields: [
      {
        key: 'minRestWeight',
        label: 'משקל מנוחה מינימלית',
        min: 0, max: 200, step: 1,
        description: 'כמה חשוב לאופטימייזר לשמור על הפסקה בין משימות חוסמות. ערך גבוה = הפסקות ארוכות יותר.',
        detail: 'רק פערים שבהם לשתי המשימות הצמודות מופעל "חוסם רצף" (HC-12) נספרים. לדוגמה, אדנית→שמש נספר, אבל כרוב→שמש לא. הנוסחה: minRestWeight × שעות מנוחה מינימליות. בברירת מחדל 10, כל שעת מנוחה נוספת = 10 נקודות.',
      },
    ],
  },
  {
    title: 'מדיניות סגל',
    description: 'עונש שמופעל כש-L4 משובץ למשימה שמועדפת לצעירים, ורק כמוצא אחרון. שיבוצים חריגים אחרים נחסמים ע״י HC-13.',
    fields: [
      {
        key: 'seniorJuniorPreferencePenalty',
        label: 'עונש סגל במשימה מועדפת לצעירים',
        min: 0, max: 50000, step: 100,
        description: 'עונש כבד כש-L4 משובץ למשימה מועדפת לצעירים. מוצא אחרון בלבד — רק L4 יכול להיות משובץ (L2/L3 חסומים לגמרי).',
        detail: 'בברירת מחדל 10,000, שיבוץ L4 אחד במשימה מועדפת לצעירים עולה כמו 250 יחידות של חוסר שיוויון בעומס עבודה. האופטימייזר ינסה כל אפשרות אחרת לפני שיפנה לזה. רק L4 יכול להיות משובץ כאן (L2/L3 חסומים על ידי HC-13).',
      },
    ],
  },
  {
    title: 'אי התאמה',
    description: 'עונש כששני משתתפים עם העדפת "אי התאמה" משובצים יחד. אילוץ רך — האופטימייזר יעדיף להימנע, אך לא ישאיר משבצת ריקה.',
    fields: [
      {
        key: 'notWithPenalty',
        label: 'עונש "אי התאמה"',
        min: 0, max: 5000, step: 50,
        description: 'עונש לכל הפרה של העדפת "אי התאמה". ברירת מחדל 500.',
        detail: 'ערך גבוה = האופטימייזר נמנע בתוקף רב יותר משיבוץ זוגות "אי התאמה" יחד באותו צוות משנה. ערך 0 מבטל את האילוץ. עונש נספר בנפרד לכל הפרה.',
      },
    ],
  },
];

// ─── HC/SW Extended Descriptions ─────────────────────────────────────────────

const HC_DESCRIPTIONS: Record<HardConstraintCode, string> = {
  'HC-1': 'רמת המשתתף חייבת להתאים או לעלות על הרמות המותרות למשבצת.',
  'HC-2': 'המשתתף חייב להחזיק בכל ההסמכות הנדרשות למשבצת.',
  'HC-3': 'המשתתף חייב להיות זמין לאורך כל חלון הזמן של המשימה.',
  'HC-4': 'כל המשתתפים במשימת אדנית (קבוצה אחידה) חייבים להיות מאותה קבוצה.',
  'HC-5': 'לא ניתן לשבץ משתתף לשתי משימות חופפות.',
  'HC-6': 'כל משבצת בכל משימה חייבת להיות מאוישת במשתתף אחד בדיוק.',
  'HC-7': 'משתתף לא יכול למלא יותר ממשבצת אחת באותה משימה.',
  'HC-8': 'בקבוצה הנבחרת חייבים להיות מספיק משתתפים כשירים (≥4 L0, ≥1 L2, ≥1 L3/L4 עם ניצן).',
  'HC-11': 'משתתפים עם הסמכה אסורה (לפי הגדרת המשימה) לא ישובצו למשימה.',
  'HC-12': 'לא ניתן לשבץ אדם לשתי משימות חוסמות רצופות.',
  'HC-13': 'סגל (L2/L3/L4) משובצים רק לתחום הטבעי שלהם; L2/L3 חסומים ממשימות מועדפות לצעירים.',
};

const SW_DESCRIPTIONS: Record<SoftWarningCode, string> = {
  'SENIOR_IN_JUNIOR_PREFERRED': 'כשמופעל: אזהרה + עונש ניקוד אם L4 משובץ למשימה מועדפת לצעירים. בטל כדי לאפשר שיבוץ ללא עונש.',
  'GROUP_MISMATCH': 'רשת ביטחון: אזהרה אם משימת קבוצה אחידה כוללת משתתפים מקבוצות שונות (אמור להיתפס ע״י HC-4).',
  'NOT_WITH_VIOLATION': 'כשמופעל: עונש כששני משתתפים עם "אי התאמה" משובצים יחד באותו צוות משנה. בטל כדי להתעלם מהעדפות אלו.',
};

// Improved SW labels for clarity
const SW_LABELS_EXTENDED: Record<SoftWarningCode, string> = {
  'SENIOR_IN_JUNIOR_PREFERRED': 'סגל במשימה מועדפת לצעירים — אזהרה + עונש',
  'GROUP_MISMATCH': 'אי-התאמת קבוצה — אזהרת בטיחות',
  'NOT_WITH_VIOLATION': 'אי התאמה — עונש ניקוד',
};

// ─── Panel state (mirrors snapshot panel pattern) ────────────────────────────

let _presetPanelOpen = false;
let _presetFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _presetFormError = '';
/** When renaming a non-active preset we track its id here */
let _presetRenameTargetId: string | null = null;

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

  // ── Preset Toolbar (simplified — panel behind toggle) ──
  const presetCount = presets.length;
  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>הגדרות אלגוריתם</h2>
    </div>
    <div class="toolbar-right">
      ${renderCustomSelect({
        id: 'gm-preset-select',
        options: presets.map(p => ({ value: p.id, label: `${escHtml(p.name)}${p.id === activeId && dirty ? ' (שונה)' : ''}`, selected: p.id === activeId })),
        searchable: presets.length > 5,
        className: 'preset-select',
      })}
      ${dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
      <button class="btn btn-sm ${_presetPanelOpen ? 'btn-primary' : 'btn-outline'}" data-action="algo-preset-panel-toggle" title="ניהול הגדרות שמורות">💾${presetCount > 0 ? ` (${presetCount})` : ''}</button>
    </div>
  </div>`;

  // ── Collapsible Preset Panel ──
  if (_presetPanelOpen) {
    html += renderPresetPanel(presets, activeId, dirty, isBuiltIn);
  }

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

  // ── Hard Constraint Toggles ──
  html += `
  <div class="algo-section">
    <h3 class="algo-section-title">תנאים מחייבים</h3>
    <p class="algo-section-desc">כללים שחייבים להתקיים כדי שהלו"ז יהיה תקין. ביטול סימון משבית את הכלל בכל המערכת. <strong>ביטול אילוצים עלול לייצר לוחות לא תקינים.</strong></p>
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
          ${!enabled ? '<span class="algo-toggle-warning">⚠ מושבת — המערכת תדלג על בדיקה זו</span>' : ''}
        </div>
      </label>`;
  }

  html += `
    </div>
  </div>`;

  // ── Soft Warning Toggles ──
  html += `
  <div class="algo-section">
    <h3 class="algo-section-title">עקרונות מנחים</h3>
    <p class="algo-section-desc">אזהרות ועונשי ניקוד שמנחים את האופטימייזר לעבר לוחות טובים יותר, בלי לפסול אותם. ביטול סימון משבית את האזהרה ואת עונש הניקוד.</p>
    <div class="algo-toggle-list">`;

  for (const code of ALL_SW_CODES) {
    const enabled = !disabledSW.has(code);
    html += `
      <label class="algo-toggle-item${enabled ? '' : ' disabled'}">
        <input type="checkbox" data-action="algo-toggle-sw" data-code="${code}" ${enabled ? 'checked' : ''} />
        <div class="algo-toggle-content">
          <span class="algo-toggle-label">${SW_LABELS_EXTENDED[code]}</span>
          <span class="algo-toggle-desc">${SW_DESCRIPTIONS[code]}</span>
          ${!enabled ? '<span class="algo-toggle-warning">⚠ מושבת — האזהרה מושתקת ועונש הניקוד הוסר</span>' : ''}
        </div>
      </label>`;
  }

  html += `
    </div>
  </div>`;

  return html;
}

// ─── Preset Panel Renderer ───────────────────────────────────────────────────

function renderPresetPanel(
  presets: AlgorithmPreset[],
  activeId: string | null,
  dirty: boolean,
  _activeIsBuiltIn: boolean,
): string {
  let html = `<div class="preset-panel">`;

  // Header
  html += `<div class="preset-panel-header">
    <h3>💾 תבניות <span class="count">${presets.length}</span></h3>
    <button class="btn-xs btn-outline" data-action="algo-preset-panel-close" title="סגור">✕</button>
  </div>`;

  // Conditional form area
  if (_presetFormMode === 'save-as') {
    html += `<div class="preset-inline-form" id="preset-saveas-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="saveas-name" maxlength="60" placeholder="התבנית שלי" autofocus /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="saveas-desc" maxlength="200" placeholder="תיאור אופציונלי" /></label>
        <button class="btn btn-sm btn-primary" data-action="algo-preset-saveas-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="algo-preset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="preset-form-error">${_presetFormError}</div>
    </div>`;
  } else if (_presetFormMode === 'rename') {
    const targetId = _presetRenameTargetId ?? activeId;
    const target = targetId ? store.getPresetById(targetId) : undefined;
    html += `<div class="preset-inline-form" id="preset-rename-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="rename-name" maxlength="60" value="${escHtml(target?.name ?? '')}" /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="rename-desc" maxlength="200" value="${escHtml(target?.description ?? '')}" /></label>
        <button class="btn btn-sm btn-primary" data-action="algo-preset-rename-confirm">שמור</button>
        <button class="btn btn-sm btn-outline" data-action="algo-preset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="preset-form-error">${_presetFormError}</div>
    </div>`;
  } else {
    html += `<div class="preset-actions-primary">
      <button class="btn-sm btn-primary" data-action="algo-preset-new">+ שמור תבנית חדשה</button>
    </div>`;
  }

  // Preset list
  if (presets.length === 0) {
    html += `<div class="preset-empty"><span class="text-muted">אין תבניות שמורות.</span></div>`;
  } else {
    html += `<div class="preset-list">`;
    for (const p of presets) {
      const isActive = p.id === activeId;
      const isBuiltIn = p.builtIn ?? false;
      html += `<div class="preset-item ${isActive ? 'preset-item-active' : ''}" data-preset-id="${p.id}">
        <div class="preset-item-main">
          <span class="preset-item-name">${escHtml(p.name)}</span>
          ${isBuiltIn ? '<span class="preset-builtin-badge">מובנית</span>' : ''}
          ${isActive && dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
        </div>
        ${p.description ? `<div class="preset-item-desc text-muted">${escHtml(p.description)}</div>` : ''}
        <div class="preset-item-actions">
          ${!isActive ? `<button class="btn-xs btn-primary" data-preset-action="load" data-preset-id="${p.id}" title="טען תבנית זו">▶ טען</button>` : ''}
          ${isActive && dirty && !isBuiltIn ? `<button class="btn-xs btn-outline" data-preset-action="update" data-preset-id="${p.id}" title="עדכן עם ההגדרות הנוכחיות">עדכן</button>` : ''}
          ${!isBuiltIn ? `<button class="btn-xs btn-outline" data-preset-action="rename" data-preset-id="${p.id}" title="שנה שם">✎</button>` : ''}
          <button class="btn-xs btn-outline" data-preset-action="duplicate" data-preset-id="${p.id}" title="שכפל">⧉</button>
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-preset-action="delete" data-preset-id="${p.id}" title="מחק">✕</button>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Weight Input Renderer ───────────────────────────────────────────────────

function renderWeightInput(f: WeightField, value: number, defaultVal: number, isCustom: boolean): string {
  return `
    <div class="algo-weight-card${isCustom ? ' modified' : ''}">
      <div class="algo-weight-header">
        <label class="algo-weight-label" title="${f.description}">${f.label}</label>
        ${isCustom ? `<span class="algo-weight-default" title="ברירת מחדל: ${defaultVal}">↺ ${defaultVal}</span>` : ''}
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
        <summary>למידע נוסף</summary>
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
    if (!btn) {
      // Check delegated preset-item actions
      const itemBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-preset-action]');
      if (itemBtn) {
        _handlePresetItemAction(itemBtn, rerender);
      }
      return;
    }
    const action = btn.dataset.action;

    switch (action) {
      // ── Panel toggle ──
      case 'algo-preset-panel-toggle': {
        _presetPanelOpen = !_presetPanelOpen;
        _presetFormMode = 'none';
        _presetFormError = '';
        _presetRenameTargetId = null;
        rerender();
        break;
      }
      case 'algo-preset-panel-close': {
        _presetPanelOpen = false;
        _presetFormMode = 'none';
        _presetFormError = '';
        _presetRenameTargetId = null;
        rerender();
        break;
      }

      // ── New preset (opens save-as form) ──
      case 'algo-preset-new': {
        _presetFormMode = 'save-as';
        _presetFormError = '';
        rerender();
        break;
      }

      // ── Save-as confirm ──
      case 'algo-preset-saveas-confirm': {
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="saveas-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="saveas-desc"]');
        const name = nameInput?.value.trim() ?? '';
        const desc = descInput?.value.trim() ?? '';
        if (!name) {
          _presetFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const result = store.saveCurrentAsPreset(name, desc);
        if (!result) {
          _presetFormError = 'תבנית עם שם זה כבר קיימת';
          rerender();
          return;
        }
        _presetFormMode = 'none';
        _presetFormError = '';
        showToast(`תבנית "${name}" נשמרה`, { type: 'success' });
        rerender();
        break;
      }

      // ── Rename confirm ──
      case 'algo-preset-rename-confirm': {
        const targetId = _presetRenameTargetId ?? store.getActivePresetId();
        if (!targetId) return;
        const nameInput = container.querySelector<HTMLInputElement>('[data-field="rename-name"]');
        const descInput = container.querySelector<HTMLInputElement>('[data-field="rename-desc"]');
        const name = nameInput?.value.trim() ?? '';
        const desc = descInput?.value.trim() ?? '';
        if (!name) {
          _presetFormError = 'השם לא יכול להיות ריק';
          rerender();
          return;
        }
        const err = store.renamePreset(targetId, name, desc);
        if (err) {
          _presetFormError = err;
          rerender();
          return;
        }
        _presetFormMode = 'none';
        _presetFormError = '';
        _presetRenameTargetId = null;
        showToast('ההגדרה נשמרה בהצלחה', { type: 'success' });
        rerender();
        break;
      }

      // ── Form cancel ──
      case 'algo-preset-form-cancel': {
        _presetFormMode = 'none';
        _presetFormError = '';
        _presetRenameTargetId = null;
        rerender();
        break;
      }
    }
  });

  // ── Custom preset select wiring ──
  wireCustomSelect(container, 'gm-preset-select', (id) => {
    store.loadPreset(id);
    rerender();
  });

  container.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const action = el.dataset.action;
    if (!action) return;

    switch (action) {
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

// ─── Delegated preset-item actions ───────────────────────────────────────────

async function _handlePresetItemAction(btn: HTMLElement, rerender: () => void): Promise<void> {
  const action = btn.dataset.presetAction;
  const id = btn.dataset.presetId;
  if (!action || !id) return;

  switch (action) {
    case 'load': {
      store.loadPreset(id);
      showToast('תבנית נטענה', { type: 'success' });
      rerender();
      break;
    }
    case 'update': {
      store.updatePreset(id);
      showToast('תבנית עודכנה', { type: 'success' });
      rerender();
      break;
    }
    case 'rename': {
      _presetRenameTargetId = id;
      _presetFormMode = 'rename';
      _presetFormError = '';
      rerender();
      break;
    }
    case 'duplicate': {
      store.duplicatePreset(id);
      showToast('תבנית שוכפלה', { type: 'success' });
      rerender();
      break;
    }
    case 'delete': {
      const preset = store.getPresetById(id);
      if (!preset || preset.builtIn) return;
      const ok = await showConfirm(`למחוק את התבנית "${preset.name}"? לא ניתן לבטל פעולה זו.`, { danger: true, title: 'מחיקת תבנית', confirmLabel: 'מחק' });
      if (!ok) return;
      store.deletePreset(id);
      _presetFormMode = 'none';
      _presetFormError = '';
      _presetRenameTargetId = null;
      showToast('התבנית נמחקה', { type: 'success' });
      rerender();
      break;
    }
  }
}

