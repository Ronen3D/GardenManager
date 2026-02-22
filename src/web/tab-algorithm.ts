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
    title: 'שיוויוניות עומס',
    description: 'קובע עד כמה האופטימייזר משווה עומסי עבודה בין המשתתפים. ערכים גבוהים מייצרים חלוקה שוויונית יותר אך עלולים להפחית גמישות בשיבוץ.',
    fields: [
      {
        key: 'l0FairnessWeight',
        label: 'משקל שיוויוניות L0',
        min: 0, max: 200, step: 1,
        description: 'עד כמה שעות העבודה מתחלקות באופן שווה בין משתתפים רגילים (L0). ערך גבוה = חלוקה שוויונית יותר.',
        detail: 'אם משתתף א\' עובד 12 שעות אפקטיביות ומשתתף ב\' עובד 6, האופטימייזר מעניש פער זה. במשקל 40 (ברירת מחדל), שיוויון עומס L0 חשוב יותר מכמעט כל גורם אחר. הגדר 0 כדי להתעלם משיוויוניות L0 לחלוטין.',
      },
      {
        key: 'seniorFairnessWeight',
        label: 'משקל שיוויוניות בכירים',
        min: 0, max: 200, step: 1,
        description: 'עד כמה שעות העבודה מתחלקות באופן שווה בין משתתפים בכירים (L2–L4). עדיפות נמוכה יותר כי מאגר הבכירים קטן.',
        detail: 'לבכירים יש פחות משימות מתאימות (בעיקר אדנית), ולכן טווח העומס שלהם מצומצם יותר. ברירת מחדל 6 נמוכה בכוונה בהשוואה לשיוויוניות L0 (40). הגדל אם אתה מבחין שעומס הבכירים הופך לא מאוזן.',
      },
      {
        key: 'dailyBalanceWeight',
        label: 'משקל איזון יומי',
        min: 0, max: 200, step: 1,
        description: 'מונע דפוסי "יום כבד / יום קל" — שואף לעומס עבודה יומי עקבי לכל אדם ולאורך כל הלו"ז.',
        detail: 'שני מדדים משולבים: (1) שעות העבודה היומיות של כל משתתף צריכות להיות אחידות בקירוב, ו-(2) סה"כ השעות של כל המשתתפים ביום קלנדרי נתון צריך להיות אחיד בקירוב. ברירת מחדל 90 הופכת את האיזון היומי לאחד מגורמי הניקוד החזקים ביותר.',
      },
    ],
  },
  {
    title: 'מנוחה ובטיחות',
    description: 'קובע כיצד האופטימייזר מעריך זמן מנוחה בין שיבוצים חוסמים רצופים (משימות HC-12). משימות לא חוסמות כמו כרוב אינן נכללות בעונש המנוחה.',
    fields: [
      {
        key: 'minRestWeight',
        label: 'משקל מנוחה מינימלית',
        min: 0, max: 200, step: 1,
        description: 'עד כמה האופטימייזר מעריך מנוחה בין משמרות חוסמות. ערך גבוה = הפסקות ארוכות יותר בין משימות חוסמות רצופות.',
        detail: 'רק פערים שבהם לשתי המשימות הצמודות יש "חוסם רצף" (HC-12) מופעל נספרים לניקוד מנוחה. לדוגמה, פערי אדנית→שמש מועשנים, אבל פערי כרוב→שמש לא. הניקוד המשולב מוסיף (minRestWeight × שעות מנוחה מינימליות). בברירת מחדל 10, כל שעת מנוחה מינימלית נוספת שווה 10 נקודות ניקוד.',
      },
    ],
  },
  {
    title: 'מדיניות בכירים',
    description: 'עונש המוטל כאשר משתתף L4 משובץ לחממה כמוצא אחרון. כל שיבוץ חריג אחר נחסם על ידי HC-13.',
    fields: [
      {
        key: 'seniorHamamaPenalty',
        label: 'עונש בכירים בחממה',
        min: 0, max: 50000, step: 100,
        description: 'עונש כבד כאשר L4 משובץ לתפקיד חממה. זהו מוצא אחרון בלבד — רק L4 יכול להיות משובץ (L2/L3 חסומים לחלוטין).',
        detail: 'בברירת מחדל 10,000, שיבוץ L4 אחד בחממה עולה כמו 250 יחידות של חוסר שיוויון בעומס עבודה. האופטימייזר ינסה כל אפשרות אחרת לפני שיפנה לזה. רק L4 יכול להיות משובץ כאן (L2/L3 חסומים על ידי HC-13).',
      },
    ],
  },
  {
    title: 'ניקוד כללי',
    description: 'מכפיל שמשקלל את כל נקודות העונשין בניקוד המשולב הסופי.',
    fields: [
      {
        key: 'penaltyWeight',
        label: 'משקל עונשין',
        min: 0, max: 100, step: 1,
        description: 'משקלל את כל נקודות העונשין (בכירים בחממה וכו\') בניקוד הסופי. הגדל כדי להפוך את הימנעות מעונשין לאגרסיבית יותר.',
        detail: 'הניקוד המשולב מחסיר (penaltyWeight × סה"כ עונשין). בברירת מחדל 1, עונשין מוחלים בערכם הנקוב. ב-2, כל נקודת עונשין כואבת פי שניים. הגדר 0 כדי להתעלם מכל העונשין (לא מומלץ).',
      },
    ],
  },
];

const SOLVER_FIELDS: WeightField[] = [
  {
    key: 'maxIterations',
    label: 'מספר איטרציות מקסימלי',
    min: 1000, max: 200000, step: 1000,
    description: 'כמה ניסיונות החלפה האופטימייזר בוחן. יותר איטרציות = תוצאות טובות יותר פוטנציאלית אך זמן ריצה ארוך יותר.',
    detail: 'אופטימייזר הצינון המדומה מנסה להחליף זוגות שיבוצים כדי לשפר את הניקוד. כל ניסיון החלפה נחשב כאיטרציה אחת. ברירת מחדל 10,000 נותנת תוצאות טובות לרוב הלוחות. עבור מאגרי משתתפים גדולים מאוד (30+), נסה 50,000+.',
  },
  {
    key: 'maxSolverTimeMs',
    label: 'מגבלת זמן (מ"ש)',
    min: 1000, max: 120000, step: 1000,
    description: 'זמן שעון קיר מקסימלי שהאופטימייזר רשאי לרוץ. הפותר עוצר מוקדם כשמגיעים למגבלה זו.',
    detail: 'גם אם נותרו איטרציות, הפותר עוצר כשמגיעים למגבלת הזמן. ברירת מחדל 30,000 מ"ש (30 שניות) מספיקה לרוב המקרים. עבור לוחות צפופים מאוד, הקצאת זמן נוסף (60,000+) עשויה למצוא פתרונות טובים יותר.',
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
  'HC-8': 'לקבוצה הנבחרת חייבים להיות מספיק משתתפים כשירים (≥4 L0, ≥1 L2, ≥1 L3/L4 עם ניצן).',
  'HC-11': 'משתתפים עם הסמכת חורש לא יכולים להיות משובצים למשימות ממטרה.',
  'HC-12': 'לא ניתן לשבץ שתי משימות כבדות רצופות (שתיהן חוסמות) לאותו אדם.',
  'HC-13': 'בכירים (L2/L3/L4) יכולים להיות משובצים רק לתחום הטבעי שלהם; L2/L3 חסומים לחלוטין מחממה.',
};

const SW_DESCRIPTIONS: Record<SoftWarningCode, string> = {
  'HAMAMA_SENIOR': 'כאשר מופעל: מתריע אם L4 משובץ לחממה, ומחיל את עונש "בכירים בחממה" על הניקוד. בטל כדי לאפשר L4 בחממה ללא עונש.',
  'GROUP_MISMATCH': 'אזהרת רשת ביטחון אם משימת קבוצה אחידה מסתיימת עם משתתפים מקבוצות שונות (אמור להיתפס על ידי HC-4).',
};

// Improved SW labels for clarity
const SW_LABELS_EXTENDED: Record<SoftWarningCode, string> = {
  'HAMAMA_SENIOR': 'בכירים בחממה — אזהרה + עונש',
  'GROUP_MISMATCH': 'אי-התאמת קבוצה — אזהרת בטיחות',
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
      <h2>הגדרות אלגוריתם</h2>
    </div>
    <div class="toolbar-right">
      <select class="preset-select" data-action="algo-preset-select">
        ${presets.map(p => `<option value="${p.id}"${p.id === activeId ? ' selected' : ''}>${_escHtml(p.name)}${p.id === activeId && dirty ? ' (שונה)' : ''}</option>`).join('')}
      </select>
      ${dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
      <button class="btn btn-sm btn-primary" data-action="algo-preset-save" ${(!dirty || isBuiltIn) ? 'disabled' : ''} title="${isBuiltIn ? 'לא ניתן לדרוס תבנית מובנית — השתמש בשמור בשם' : 'שמור שינויים לתבנית זו'}">שמור</button>
      <button class="btn btn-sm" data-action="algo-preset-saveas">שמור בשם…</button>
      <button class="btn btn-sm" data-action="algo-preset-rename" ${isBuiltIn ? 'disabled' : ''}>שנה שם</button>
      <button class="btn btn-sm btn-danger" data-action="algo-preset-delete" ${isBuiltIn ? 'disabled' : ''}>מחק</button>
    </div>
  </div>

  <!-- Save-As inline form (hidden by default) -->
  <div class="preset-inline-form" id="preset-saveas-form" style="display:none;">
    <div class="preset-form-row">
      <label>שם: <input type="text" class="preset-name-input" data-field="saveas-name" maxlength="60" placeholder="התבנית שלי" /></label>
      <label>תיאור: <input type="text" class="preset-desc-input" data-field="saveas-desc" maxlength="200" placeholder="תיאור אופציונלי" /></label>
      <button class="btn btn-sm btn-primary" data-action="algo-preset-saveas-confirm">אשר</button>
      <button class="btn btn-sm" data-action="algo-preset-saveas-cancel">ביטול</button>
    </div>
    <div class="preset-validation-error" id="saveas-error"></div>
  </div>

  <!-- Rename inline form (hidden by default) -->
  <div class="preset-inline-form" id="preset-rename-form" style="display:none;">
    <div class="preset-form-row">
      <label>שם: <input type="text" class="preset-name-input" data-field="rename-name" maxlength="60" /></label>
      <label>תיאור: <input type="text" class="preset-desc-input" data-field="rename-desc" maxlength="200" /></label>
      <button class="btn btn-sm btn-primary" data-action="algo-preset-rename-confirm">אשר</button>
      <button class="btn btn-sm" data-action="algo-preset-rename-cancel">ביטול</button>
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
    <h3 class="algo-section-title">כוונון פותר</h3>
    <p class="algo-section-desc">שליטה בכמה זמן ובאיזו עוצמה האופטימייזר מחפש לו"ז טוב. ערכים גבוהים עשויים לייצר תוצאות טובות יותר אך לקחת יותר זמן.</p>
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
    <h3 class="algo-section-title">תנאים מחייבים</h3>
    <p class="algo-section-desc">כללים שחייבים להתקיים עבור לו"ז תקין. בטל סימון כדי לדלג על כלל בכל מקום — אופטימייזר, מאמת, ואזהרות ממשק. <strong>ביטול אילוצים עלול לייצר לוחות לא תקינים.</strong></p>
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
          ${!enabled ? '<span class="algo-toggle-warning">⚠ מושבת — האופטימייזר והמאמת ידלגו על בדיקה זו</span>' : ''}
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
    <p class="algo-section-desc">אזהרות ועונשי ניקוד שמנחים את האופטימייזר לעבר לוחות טובים יותר מבלי להפוך אותם ללא תקינים. ביטול סימון משבית גם את הודעת האזהרה <strong>וגם</strong> את עונש הניקוד המשויך.</p>
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
          if (errEl) errEl.textContent = 'השם לא יכול להיות ריק';
          return;
        }
        const result = store.saveCurrentAsPreset(name, desc);
        if (!result) {
          if (errEl) errEl.textContent = 'תבנית עם שם זה כבר קיימת';
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
          if (errEl) errEl.textContent = 'השם לא יכול להיות ריק';
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
        if (!confirm(`למחוק את התבנית "${preset.name}"? לא ניתן לבטל פעולה זו.`)) return;
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
