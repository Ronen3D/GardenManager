/**
 * Settings Tab — Collapsible accordion-based settings panel.
 *
 * Three top-level sections:
 *   1. Algorithm Settings (weights + hard constraints + presets)
 *   2. Certifications & Pakals
 *   3. Additional Settings (display + danger zone)
 *
 * Each section is a collapsible accordion, closed by default.
 */

import {
  ALL_HC_CODES,
  type AlgorithmPreset,
  DEFAULT_ALGORITHM_SETTINGS,
  DEFAULT_CONFIG,
  getHC14Label,
  type HardConstraintCode,
  HC_LABELS,
  type SchedulerConfig,
} from '../models/types';
import * as store from './config-store';
import { renderDataTransferContent } from './data-transfer-ui';
import {
  escHtml,
  getCurrentTheme,
  getStoredDefaultAttempts,
  getStoredTheme,
  SVG_ICONS,
  setDefaultAttempts,
  setTheme,
} from './ui-helpers';
import { renderCustomSelect, showConfirm, showToast, wireCustomSelect } from './ui-modal';

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
    description:
      'עד כמה חשוב לאופטימייזר לחלק את העבודה באופן שוויוני בין המשתתפים. ערך גבוה יוביל לחלוקה מאוזנת יותר, אבל לפחות גמישות.',
    fields: [
      {
        key: 'l0FairnessWeight',
        label: 'משקל שיוויוניות כללי',
        min: 0,
        max: 200,
        step: 1,
        description:
          'עד כמה חשוב לחלק את שעות העבודה באופן שווה בין משתתפים שאינם סגל. ערך גבוה = חלוקה שוויונית יותר.',
        detail:
          "אם משתתף א' עובד 12 שעות אפקטיביות ומשתתף ב' עובד 6, האופטימייזר מעניש פער זה. במשקל 40 (ברירת מחדל), שיוויון העומס של משתתפים שאינם סגל חשוב יותר מכמעט כל גורם אחר. הגדר 0 כדי להתעלם משיוויוניות זו לחלוטין.",
      },
      {
        key: 'seniorFairnessWeight',
        label: 'משקל שיוויוניות סגל',
        min: 0,
        max: 200,
        step: 1,
        description: 'עד כמה שעות העבודה מתחלקות בשווה בין משתתפי סגל (L2–L4). עדיפות נמוכה יותר כי מאגר הסגל קטן.',
        detail:
          'לסגל יש פחות משימות מתאימות (בעיקר אדנית), ולכן טווח העומס שלהם מצומצם יותר. ברירת מחדל 6 נמוכה בכוונה בהשוואה לשיוויוניות L0 (40). הגדל אם אתה מבחין שעומס הסגל הופך לא מאוזן.',
      },
      {
        key: 'dailyBalanceWeight',
        label: 'משקל האיזון היומי',
        min: 0,
        max: 200,
        step: 1,
        description: 'מצמצם פערים בין ימים עמוסים לימים קלים — שואף לעומס עבודה יומי עקבי לכל אדם ולאורך כל הלו"ז.',
        detail:
          'שני מדדים משולבים: (1) שעות העבודה היומיות של כל משתתף צריכות להיות אחידות בקירוב, ו-(2) סה"כ השעות של כל המשתתפים ביום קלנדרי נתון צריך להיות אחיד בקירוב. ברירת מחדל 90 הופכת את האיזון היומי לאחד מגורמי הניקוד החזקים ביותר.',
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
        min: 0,
        max: 200,
        step: 1,
        description: 'כמה חשוב לאופטימייזר לשמור על הפסקה בין משימות חוסמות. ערך גבוה = הפסקות ארוכות יותר.',
        detail:
          'רק פערים שבהם לשתי המשימות הצמודות מופעל "חוסם רצף" (HC-12) נספרים. לדוגמה, אדנית→שמש נספר, אבל כרוב→שמש לא. הנוסחה: minRestWeight × שעות מנוחה מינימליות. בברירת מחדל 10, כל שעת מנוחה נוספת = 10 נקודות.',
      },
    ],
  },
  {
    title: 'מדיניות סגל',
    description: 'עונש רך שמופעל כשסגל משובץ למשבצת lowPriority (מוצא אחרון). חסימת דרגה קשיחה מטופלת ע״י HC-1.',
    fields: [
      {
        key: 'lowPriorityLevelPenalty',
        label: 'עונש דרגה בעדיפות נמוכה',
        min: 0,
        max: 50000,
        step: 100,
        description: 'עונש כבד כשמשתתף משובץ במשבצת שבה דרגתו מסומנת כ"עדיפות נמוכה". מוצא אחרון בלבד.',
        detail:
          'בברירת מחדל 10,000, שיבוץ אחד של דרגה בעדיפות נמוכה עולה כמו 250 יחידות של חוסר שיוויון בעומס עבודה. האופטימייזר ינסה כל אפשרות אחרת לפני שיפנה לזה.',
      },
    ],
  },
  {
    title: 'אי התאמה',
    description:
      'עונש כששני משתתפים עם העדפת "אי התאמה" משובצים יחד. אילוץ רך — האופטימייזר יעדיף להימנע, אך לא ישאיר משבצת ריקה.',
    fields: [
      {
        key: 'notWithPenalty',
        label: 'עונש "אי התאמה"',
        min: 0,
        max: 5000,
        step: 50,
        description: 'עונש לכל הפרה של העדפת "אי התאמה". ברירת מחדל 500.',
        detail:
          'ערך גבוה = האופטימייזר נמנע בתוקף רב יותר משיבוץ זוגות "אי התאמה" יחד באותו צוות משנה. ערך 0 מבטל את האילוץ. עונש נספר בנפרד לכל הפרה.',
      },
    ],
  },
  {
    title: 'העדפות משימה',
    description:
      'העדפות אישיות של משתתפים למשימות מסוימות. אילוץ רך — האופטימייזר יעדיף לכבד העדפות אבל לא יפגע בכיסוי או שיוויון.',
    fields: [
      {
        key: 'taskNamePreferencePenalty',
        label: 'עונש אי-קיום העדפה',
        min: 0,
        max: 1000,
        step: 10,
        description: 'עונש כשמשתתף לא משובץ לאף משימה מהסוג המועדף עליו. ברירת מחדל 50.',
        detail:
          'עונש חד-פעמי למשתתף שיש לו סוג משימה מועדף אך לא שובץ אליו כלל. ערך נמוך מדי — העדפות יתעלמו. ערך גבוה מדי — יפגע בשיוויון עומס. הגדר 0 כדי לבטל.',
      },
      {
        key: 'taskNameAvoidancePenalty',
        label: 'עונש שיבוץ לא-מועדף',
        min: 0,
        max: 2000,
        step: 10,
        description: 'עונש לכל שיבוץ לסוג משימה שהמשתתף מעדיף להימנע ממנו. ברירת מחדל 80.',
        detail:
          'עונש מצטבר — כל שיבוץ לסוג הלא-מועדף מוסיף עונש. חזק יותר מהעדפה חיובית כי הימנעות ממשהו לא רצוי חשובה יותר. הגדר 0 כדי לבטל.',
      },
      {
        key: 'taskNamePreferenceBonus',
        label: 'בונוס שיבוץ מועדף',
        min: 0,
        max: 500,
        step: 5,
        description: 'בונוס (הפחתת עונש) לכל שיבוץ לסוג משימה מועדף. ברירת מחדל 25.',
        detail:
          'בונוס מצטבר — כל שיבוץ לסוג המועדף מפחית את העונש הכולל. משלים את עונש אי-קיום ההעדפה: העונש מבטיח לפחות שיבוץ אחד, הבונוס מעודד עוד. הגדר 0 כדי לבטל.',
      },
    ],
  },
];

// ─── HC/SW Extended Descriptions ─────────────────────────────────────────────

const HC_DESCRIPTIONS: Record<HardConstraintCode, string> = {
  'HC-1': 'רמת המשתתף חייבת להופיע ברשימת הרמות המותרות למשבצת.',
  'HC-2': 'המשתתף חייב להחזיק בכל ההסמכות הנדרשות למשבצת.',
  'HC-3': 'המשתתף חייב להיות זמין לאורך כל חלון הזמן של המשימה.',
  'HC-4': 'כל המשתתפים במשימה משותפת (קבוצה אחידה) חייבים להיות מאותה קבוצה.',
  'HC-5': 'לא ניתן לשבץ משתתף לשתי משימות חופפות.',
  'HC-6': 'כל משבצת בכל משימה חייבת להיות מאוישת במשתתף אחד בדיוק.',
  'HC-7': 'משתתף לא יכול למלא יותר ממשבצת אחת באותה משימה.',
  'HC-8': 'בקבוצה הנבחרת חייבים להיות מספיק משתתפים כשירים למלא את כל המשבצות.',
  'HC-11': 'משתתפים עם הסמכה אסורה (לפי הגדרת המשימה) לא ישובצו למשימה.',
  'HC-12': 'לא ניתן לשבץ אדם לשתי משימות חוסמות רצופות.',
  'HC-13': 'עונש רך לשיבוץ סגל במשבצות lowPriority (מוצא אחרון). חסימת דרגה מטופלת ע״י HC-1.',
  'HC-14': 'נדרשת הפסקה מינימלית של 5 שעות בין משימות קטגוריה לאותו משתתף.',
  'HC-15': 'כשמשימה מסתיימת בטווח השעות המוגדר, המשתתף לא ישובץ למשימה עם עומס > 0 במהלך חלון ההתאוששות.',
};

// ─── Accordion state (which sections are expanded) ──────────────────────────

/** Which accordion sections are currently expanded (empty = all collapsed). */
const _openAccordions = new Set<string>();

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

// ─── Certification Management ───────────────────────────────────────────────

const CERT_COLOR_PALETTE = [
  '#16a085',
  '#8e44ad',
  '#c0392b',
  '#27ae60',
  '#2980b9',
  '#d35400',
  '#f39c12',
  '#1abc9c',
  '#e74c3c',
  '#34495e',
];

// Relative luminance per WCAG formula (for contrast validation of custom colors).
function hexLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const toLinear = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear((n >> 16) & 0xff);
  const g = toLinear((n >> 8) & 0xff);
  const b = toLinear(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Contrast ratio of `hex` against white (#ffffff). Higher is better; 3.0 = WCAG AA large text. */
function contrastOnWhite(hex: string): number {
  return 1.05 / (hexLuminance(hex) + 0.05);
}
const MIN_CONTRAST = 3.0;

let _selectedCertColor = '';
let _certColorEditId: string | null = null;
let _customColorWarning = '';
let _pendingCertName = '';
let _certEditingId: string | null = null;
let _certError = '';

// Old renderCertificationSection / renderPakalSection removed —
// replaced by renderCertificationContent() / renderPakalContent() above.

let _pakalEditingId: string | null = null;
let _pakalError = '';

// ─── Accordion Helpers ──────────────────────────────────────────────────────

interface AccordionOpts {
  id: string;
  icon: string;
  title: string;
  summary: string;
  body: string;
  className?: string;
}

function renderAccordion(opts: AccordionOpts): string {
  const isOpen = _openAccordions.has(opts.id);
  return `
  <div class="settings-accordion ${opts.className || ''}" id="${opts.id}">
    <button class="settings-accordion-header"
            aria-expanded="${isOpen}"
            aria-controls="${opts.id}-body"
            data-action="settings-accordion-toggle"
            data-accordion="${opts.id}">
      <span class="settings-acc-icon">${opts.icon}</span>
      <span class="settings-acc-title">${opts.title}</span>
      <span class="settings-acc-summary">${opts.summary}</span>
    </button>
    <div class="settings-accordion-body ${isOpen ? 'open' : ''}"
         id="${opts.id}-body" role="region">
      <div class="settings-accordion-body-inner">
        ${opts.body}
      </div>
    </div>
  </div>`;
}

function renderNestedAccordion(opts: AccordionOpts): string {
  const isOpen = _openAccordions.has(opts.id);
  return `
  <div class="settings-nested-accordion" id="${opts.id}">
    <button class="settings-nested-header"
            aria-expanded="${isOpen}"
            aria-controls="${opts.id}-body"
            data-action="settings-accordion-toggle"
            data-accordion="${opts.id}">
      <span class="settings-nested-icon">${opts.icon}</span>
      <span class="settings-nested-title">${opts.title}</span>
      <span class="settings-nested-summary">${opts.summary}</span>
    </button>
    <div class="settings-nested-body ${isOpen ? 'open' : ''}"
         id="${opts.id}-body" role="region">
      <div class="settings-nested-body-inner">
        ${opts.body}
      </div>
    </div>
  </div>`;
}

// ─── Summary Helpers ────────────────────────────────────────────────────────

function getAlgoSummary(cfg: SchedulerConfig, disabledHC: Set<HardConstraintCode>): string {
  let modified = 0;
  for (const group of WEIGHT_GROUPS) {
    for (const f of group.fields) {
      if (cfg[f.key] !== DEFAULT_CONFIG[f.key]) modified++;
    }
  }
  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} משקלות שונו`);
  if (disabledHC.size > 0) parts.push(`${disabledHC.size} אילוצים מושבתים`);
  return parts.length > 0 ? parts.join(', ') : 'ברירת מחדל';
}

function getWeightsSummary(cfg: SchedulerConfig): string {
  let modified = 0;
  for (const group of WEIGHT_GROUPS) {
    for (const f of group.fields) {
      if (cfg[f.key] !== DEFAULT_CONFIG[f.key]) modified++;
    }
  }
  const total = WEIGHT_GROUPS.reduce((n, g) => n + g.fields.length, 0);
  return modified > 0 ? `${total} משקלות, ${modified} שונו` : `${total} משקלות, ברירת מחדל`;
}

function getConstraintsSummary(disabledHC: Set<HardConstraintCode>): string {
  if (disabledHC.size === 0) return `${ALL_HC_CODES.length} פעילים`;
  return `${disabledHC.size} מושבתים מתוך ${ALL_HC_CODES.length}`;
}

function getCertPakalSummary(): string {
  const certs = store.getCertificationDefinitions();
  const pakals = store.getPakalDefinitions();
  return `${certs.length} הסמכות, ${pakals.length} פק"לים`;
}

function getDisplaySummary(): string {
  return `ערכת נושא: ${getStoredTheme() === 'dark' ? 'כהה' : 'בהיר'} · ניסיונות: ${getStoredDefaultAttempts()}`;
}

// ─── Content Renderers ──────────────────────────────────────────────────────

// ─── General Settings (day boundary) ────────────────────────────────────────

function renderGeneralSettings(dayStartHour: number): string {
  const isCustom = dayStartHour !== DEFAULT_ALGORITHM_SETTINGS.dayStartHour;
  const defaultLabel = `${String(DEFAULT_ALGORITHM_SETTINGS.dayStartHour).padStart(2, '0')}:00`;
  const options = Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
    selected: h === dayStartHour,
  }));

  return `
    <div class="algo-grid">
      <div class="algo-weight-card${isCustom ? ' modified' : ''}">
        <div class="algo-weight-header">
          <label class="algo-weight-label" title="השעה שמגדירה את תחילת היום התפעולי">שעת תחילת יום</label>
          ${isCustom ? `<span class="algo-weight-default" title="ברירת מחדל: ${defaultLabel}">↺ ${defaultLabel}</span>` : ''}
        </div>
        <div class="algo-weight-controls">
          ${renderCustomSelect({
            id: 'gm-day-start-hour',
            options,
            className: 'input-sm',
          })}
        </div>
        <p class="algo-weight-desc">"יום" במערכת מוגדר כ-24 שעות מהשעה הנבחרת. לדוגמה, 05:00 = היום רץ מ-05:00 עד 05:00 למחרת. משפיע על תצוגת יום, הקפאת מצב חי, איזון עומס יומי וייצוא.</p>
      </div>
    </div>
    <div class="settings-autotune-row">
      <button class="btn-sm btn-primary" data-action="algo-auto-tune" title="כייל את המשקלות אוטומטית לפי הנתונים הנוכחיים">🎯 כיול אוטומטי</button>
      <span class="settings-autotune-hint">המערכת תפעל במשך מספר דקות (בערך רבע שעה) למציאת סט הגדרות האלגוריתם האופטימלי למשימות והמשתתפים המוגדרים</span>
    </div>`;
}

// ─── Weight Groups ──────────────────────────────────────────────────────────

function renderWeightGroups(cfg: SchedulerConfig): string {
  let html = '';
  for (const group of WEIGHT_GROUPS) {
    html += `
    <div class="algo-section" style="border:none;box-shadow:none;padding:0.5rem 0;margin-bottom:0.5rem;background:transparent;">
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
  return html;
}

function renderHardConstraints(disabledHC: Set<HardConstraintCode>): string {
  let html = `
    <p class="algo-section-desc">כללים שחייבים להתקיים כדי שהלו"ז יהיה תקין. ביטול סימון משבית את הכלל בכל המערכת. <strong>ביטול אילוצים עלול לייצר לוחות לא תקינים.</strong></p>
    <div class="algo-toggle-list">`;
  for (const code of ALL_HC_CODES) {
    const enabled = !disabledHC.has(code);
    html += `
      <label class="algo-toggle-item${enabled ? '' : ' disabled'}">
        <input type="checkbox" data-action="algo-toggle-hc" data-code="${code}" ${enabled ? 'checked' : ''} />
        <span class="algo-toggle-code">${code}</span>
        <div class="algo-toggle-content">
          <span class="algo-toggle-label">${code === 'HC-14' ? getHC14Label() : HC_LABELS[code]}</span>
          <span class="algo-toggle-desc">${HC_DESCRIPTIONS[code]}</span>
          ${!enabled ? '<span class="algo-toggle-warning">⚠ מושבת — המערכת תדלג על בדיקה זו</span>' : ''}
        </div>
      </label>`;
  }
  html += `
    </div>`;
  return html;
}

function renderCertificationContent(): string {
  const defs = store.getCertificationDefinitions().filter((d) => !d.deleted);
  const usedColors = new Set(defs.map((d) => d.color));
  // Color owners keyed by hex, for tooltip labels on in-use swatches.
  const colorOwner = new Map<string, string>();
  for (const d of defs) {
    if (!colorOwner.has(d.color)) colorOwner.set(d.color, d.label);
  }
  // Custom (non-palette) picks are preserved across renders. Palette picks auto-swap to the
  // next unused color if a newly-added cert claimed the one the user had selected.
  const selectedIsCustom = !!_selectedCertColor && !CERT_COLOR_PALETTE.includes(_selectedCertColor);
  if (!_selectedCertColor || (!selectedIsCustom && usedColors.has(_selectedCertColor))) {
    _selectedCertColor = CERT_COLOR_PALETTE.find((c) => !usedColors.has(c)) || CERT_COLOR_PALETTE[0];
  }

  let html = `
    <h3 class="algo-section-title">הסמכות</h3>
    <p class="algo-section-desc">הוסף או הסר הסמכות. שינויים זמינים מיד בלשוניות משתתפים ומשימות.</p>
    <div class="cert-def-list">`;
  for (const def of defs) {
    const usage = store.getCertificationUsage(def.id);
    const usageText = `${usage.participantCount} משתתפים, ${usage.slotCount} משבצות`;
    const isEditingColor = _certColorEditId === def.id;
    const editing = _certEditingId === def.id;
    html += `
      <div class="cert-def-item-wrapper">
        <div class="cert-def-item">
          <button class="cert-color-indicator" data-action="cert-change-color" data-cert-id="${def.id}" style="background:${def.color}" title="שנה צבע"></button>
          ${
            editing
              ? `<input type="text" class="input-sm cert-edit-input" data-field="cert-edit-label" data-cert-id="${def.id}" value="${escHtml(def.label)}" maxlength="100" />`
              : `<span class="badge" style="background:${def.color}">${escHtml(def.label)}</span>`
          }
          <span class="cert-usage-count">${usageText}</span>
          ${!editing ? `<button class="btn-icon btn-sm" data-action="cert-edit" data-cert-id="${def.id}" title="ערוך">✎</button>` : ''}
          ${editing ? `<button class="btn-icon btn-sm" data-action="cert-save" data-cert-id="${def.id}" title="שמור">✓</button>` : ''}
          ${editing ? `<button class="btn-icon btn-sm" data-action="cert-cancel" title="ביטול">✕</button>` : ''}
          ${!editing ? `<button class="btn-icon btn-sm" data-action="cert-remove" data-cert-id="${def.id}" title="הסר הסמכה">✕</button>` : ''}
        </div>`;
    if (isEditingColor) {
      const editSelectedIsCustom = !CERT_COLOR_PALETTE.includes(def.color);
      html += `
        <div class="cert-color-edit-palette">`;
      for (const c of CERT_COLOR_PALETTE) {
        // In edit mode, "in-use" means *another* cert owns this color (not the one being edited).
        const otherOwner = defs.find((d) => d.id !== def.id && d.color === c);
        const isSelected = c === def.color;
        const classes = ['cert-color-swatch'];
        if (isSelected) classes.push('selected');
        if (otherOwner) classes.push('in-use');
        const title = otherOwner ? `${c} (בשימוש: ${otherOwner.label})` : c;
        const disabledAttr = otherOwner ? ' disabled' : '';
        html += `<button type="button"${disabledAttr} class="${classes.join(' ')}" data-action="cert-pick-color" data-cert-id="${def.id}" data-color="${c}" style="background:${c}" title="${escHtml(title)}" aria-label="${escHtml(title)}"></button>`;
      }
      // Custom color trigger + hidden native color input, scoped to this cert.
      html += `
          <button type="button" class="cert-color-swatch cert-color-custom${editSelectedIsCustom ? ' selected' : ''}" data-action="cert-edit-custom-color" data-cert-id="${def.id}" title="צבע מותאם אישית" aria-label="צבע מותאם אישית">
            <span class="cert-color-custom-icon" aria-hidden="true">🎨</span>
          </button>
          <input type="color" class="cert-custom-color-input" data-action="cert-edit-custom-change" data-cert-id="${def.id}" value="${def.color}" tabindex="-1" aria-hidden="true" />
        </div>`;
    }
    html += `
      </div>`;
  }
  const duplicateOwner = usedColors.has(_selectedCertColor) ? colorOwner.get(_selectedCertColor) : null;
  html += `
    </div>
    ${_certError ? `<div class="preset-validation-error">${escHtml(_certError)}</div>` : ''}
    <div class="cert-add-form">
      <div class="cert-add-row">
        <input type="text" class="input-sm" data-field="cert-name" placeholder="שם הסמכה חדשה" value="${escHtml(_pendingCertName)}" maxlength="100" />
        <button class="btn-sm btn-primary" data-action="cert-add">+ הוסף</button>
      </div>
      <div class="cert-color-palette">`;
  for (const c of CERT_COLOR_PALETTE) {
    const inUse = usedColors.has(c);
    const isSelected = c === _selectedCertColor;
    const classes = ['cert-color-swatch'];
    if (isSelected) classes.push('selected');
    if (inUse) classes.push('in-use');
    const owner = inUse ? colorOwner.get(c) : null;
    const title = owner ? `${c} (בשימוש: ${owner})` : c;
    const disabledAttr = inUse ? ' disabled' : '';
    html += `<button type="button"${disabledAttr} class="${classes.join(' ')}" data-action="cert-select-color" data-color="${c}" style="background:${c}" title="${escHtml(title)}" aria-label="${escHtml(title)}"></button>`;
  }
  // Custom color trigger (native <input type="color">). Shows the picked color when a custom one is active.
  const customSwatchStyle = selectedIsCustom ? ` style="background:${_selectedCertColor}"` : '';
  html += `
        <button type="button" class="cert-color-swatch cert-color-custom${selectedIsCustom ? ' selected' : ''}" data-action="cert-custom-color-trigger" title="צבע מותאם אישית" aria-label="צבע מותאם אישית"${customSwatchStyle}>
          <span class="cert-color-custom-icon" aria-hidden="true">🎨</span>
        </button>
        <input type="color" class="cert-custom-color-input" data-action="cert-custom-color-change" value="${selectedIsCustom ? _selectedCertColor : CERT_COLOR_PALETTE[0]}" tabindex="-1" aria-hidden="true" />
      </div>`;
  if (_customColorWarning) {
    html += `<p class="cert-contrast-warning">⚠ ${escHtml(_customColorWarning)}</p>`;
  }
  if (duplicateOwner) {
    html += `<p class="cert-palette-note">הצבע הנבחר משותף עם הסמכה "${escHtml(duplicateOwner)}"</p>`;
  }
  html += `
    </div>`;
  return html;
}

function renderPakalContent(): string {
  const defs = store.getPakalDefinitions();

  let html = `
    <h3 class="algo-section-title">פק"לים</h3>
    <p class="algo-section-desc">הוסף, ערוך או הסר פק"לים. שינויים זמינים מיד בלשונית משתתפים.</p>
    <div class="pakal-def-list">`;
  for (const def of defs) {
    const usageCount = store.getPakalUsageCount(def.id);
    const usageText = `${usageCount} משתתפים`;
    const editing = _pakalEditingId === def.id;
    html += `
      <div class="pakal-def-item">
        ${
          editing
            ? `<input type="text" class="input-sm pakal-edit-input" data-field="pakal-edit-label" data-pakal-id="${def.id}" value="${escHtml(def.label)}" maxlength="40" />`
            : `<span class="badge pakal-badge" style="background:#1f6feb">${escHtml(def.label)}</span>`
        }
        <span class="pakal-usage-count">${usageText}</span>
        <div class="pakal-def-item-actions">
          ${!editing ? `<button class="btn-icon btn-sm" data-action="pakal-edit" data-pakal-id="${def.id}" title="ערוך">✎</button>` : ''}
          ${editing ? `<button class="btn-icon btn-sm" data-action="pakal-save" data-pakal-id="${def.id}" title="שמור">✓</button>` : ''}
          ${editing ? `<button class="btn-icon btn-sm" data-action="pakal-cancel" title="ביטול">✕</button>` : ''}
          ${!editing ? `<button class="btn-icon btn-sm" data-action="pakal-remove" data-pakal-id="${def.id}" title="הסר פק&quot;ל">✕</button>` : ''}
        </div>
      </div>`;
  }
  html += `
    </div>
    ${_pakalError ? `<div class="preset-validation-error">${escHtml(_pakalError)}</div>` : ''}
    <div class="pakal-add-form">
      <div class="pakal-add-row">
        <input type="text" class="input-sm" data-field="pakal-new-label" maxlength="40" placeholder="שם פק&quot;ל חדש" />
        <button class="btn-sm btn-primary" data-action="pakal-add">+ הוסף</button>
      </div>
    </div>`;
  return html;
}

function renderDisplayContent(): string {
  const theme = getStoredTheme();
  const defaultAttempts = getStoredDefaultAttempts();
  return `
    <h3 class="algo-section-title">תצוגה</h3>
    <p class="algo-section-desc">בחירת מראה כללי של המערכת.</p>
    <div class="theme-segmented">
      <button class="theme-seg-btn ${theme === 'light' ? 'theme-seg-active' : ''}" data-action="set-theme" data-theme="light">
        ${SVG_ICONS.sun} <span>בהיר</span>
      </button>
      <button class="theme-seg-btn ${theme === 'dark' ? 'theme-seg-active' : ''}" data-action="set-theme" data-theme="dark">
        ${SVG_ICONS.moon} <span>כהה</span>
      </button>
    </div>

    <h3 class="algo-section-title" style="margin-top:20px">ייצור שבצ"ק</h3>
    <p class="algo-section-desc">מספר ניסיונות ברירת מחדל ביצירת שבצ"ק. ניתן לשנות גם בעת הייצור עצמו.</p>
    <label class="scenarios-label" for="input-default-attempts" style="display:inline-flex;align-items:center;gap:8px">
      ניסיונות ברירת מחדל
      <input type="number" id="input-default-attempts" class="input-sm" data-action="set-default-attempts" min="1" step="1" value="${defaultAttempts}" style="width:100px" />
    </label>`;
}

function renderStorageUsageContent(): string {
  const usage = store.getStorageUsage();
  const QUOTA = 5 * 1024 * 1024; // 5 MB typical localStorage limit
  const pct = Math.min(100, (usage.total / QUOTA) * 100);
  const wedged = store.isStorageWedged();

  // Friendly labels for storage keys (ordered by expected size)
  const KEY_LABELS: Record<string, string> = {
    gardenmanager_schedule: 'שבצ"ק',
    gardenmanager_schedule_snapshots: 'גרסאות שמורות',
    gardenmanager_state: 'משתתפים ומשימות',
    gardenmanager_task_sets: 'סטי משימות',
    gardenmanager_participant_sets: 'סטי משתתפים',
    gardenmanager_algorithm: 'הגדרות אלגוריתם',
    gardenmanager_algorithm_presets: 'סטים של הגדרות שמורות',
    gardenmanager_live_mode: 'מצב חי',
    gardenmanager_active_preset_id: 'סט הגדרות פעיל',
    gardenmanager_active_snapshot_id: 'גרסה פעילה',
    gardenmanager_active_participant_set_id: 'סט משתתפים פעיל',
    gardenmanager_active_task_set_id: 'סט משימות פעיל',
  };

  // Sort by size descending, filter out empty
  const rows = usage.filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes);

  const maxBytes = rows.length > 0 ? rows[0].bytes : 1;

  // Color tiers for the main gauge
  const tierClass = pct >= 90 ? 'storage-tier-danger' : pct >= 70 ? 'storage-tier-warning' : 'storage-tier-ok';

  let html = `
    <hr class="settings-divider">
    <div class="storage-usage-section">
      <div class="storage-usage-header">
        <h3 class="algo-section-title">שימוש באחסון</h3>
        <button class="btn-icon btn-sm storage-refresh-btn" data-action="storage-refresh" title="רענן נתוני אחסון">⟳</button>
      </div>
      <p class="algo-section-desc">נפח האחסון המקומי של הדפדפן המשמש את המערכת.</p>`;

  if (wedged) {
    html += `
      <div class="storage-wedge-alert">
        <span class="storage-wedge-icon">⚠</span>
        <span>האחסון מלא — חלק מהנתונים לא נשמרים. מחק גרסאות שמורות או סטים לא נחוצים כדי לפנות מקום.</span>
      </div>`;
  }

  // Main gauge
  html += `
      <div class="storage-gauge">
        <div class="storage-gauge-labels">
          <span class="storage-gauge-used">${formatBytes(usage.total)}</span>
          <span class="storage-gauge-limit">${formatBytes(QUOTA)}</span>
        </div>
        <div class="storage-gauge-track">
          <div class="storage-gauge-fill ${tierClass}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="storage-gauge-pct">${pct.toFixed(1)}%</span>
      </div>`;

  // Breakdown rows
  if (rows.length > 0) {
    html += '<div class="storage-breakdown">';
    for (const row of rows) {
      const label = KEY_LABELS[row.key] || row.key;
      const rowPct = (row.bytes / maxBytes) * 100;
      html += `
        <div class="storage-breakdown-row">
          <span class="storage-breakdown-label">${escHtml(label)}</span>
          <div class="storage-breakdown-bar-bg">
            <div class="storage-breakdown-bar-fill" style="width:${rowPct.toFixed(1)}%"></div>
          </div>
          <span class="storage-breakdown-value">${formatBytes(row.bytes)}</span>
        </div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function renderDangerContent(): string {
  return `
    <div class="settings-danger-area">
      <h3 class="algo-section-title">אזור סכנה</h3>
      <p class="algo-section-desc">איפוס מלא של כל נתוני המערכת — משתתפים, משימות, שיבוצים, והגדרות.</p>
      <button class="btn-sm btn-danger-outline" id="btn-factory-reset" title="איפוס מלא של המערכת למצב התחלתי">⚠ איפוס מערכת</button>
    </div>`;
}

// ─── Render ──────────────────────────────────────────────────────────────────

export function renderAlgorithmTab(): string {
  const settings = store.getAlgorithmSettings();
  const cfg = settings.config;
  const disabledHC = new Set(settings.disabledHardConstraints);

  const presets = store.getAllPresets();
  const activeId = store.getActivePresetId();
  const dirty = store.isPresetDirty();
  const activePreset = activeId ? presets.find((p) => p.id === activeId) : undefined;
  const isBuiltIn = activePreset?.builtIn ?? false;

  // ── Tab Title ──
  let html = `
  <div class="tab-toolbar">
    <div class="toolbar-left">
      <h2>הגדרות</h2>
    </div>
  </div>`;

  // ── Section 1: Algorithm Settings ──
  const presetCount = presets.length;
  const algoBody = `
    <div class="settings-preset-toolbar">
      ${renderCustomSelect({
        id: 'gm-preset-select',
        options: presets.map((p) => ({
          value: p.id,
          label: `${escHtml(p.name)}${p.id === activeId && dirty ? ' (שונה)' : ''}`,
          selected: p.id === activeId,
        })),
        searchable: presets.length > 5,
        className: 'preset-select',
      })}
      ${dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
      <button class="btn-sm ${_presetPanelOpen ? 'btn-primary' : 'btn-outline'}" data-action="algo-preset-panel-toggle" title="ניהול הגדרות שמורות">💾${presetCount > 0 ? ` (${presetCount})` : ''}</button>
    </div>
    ${_presetPanelOpen ? renderPresetPanel(presets, activeId, dirty, isBuiltIn) : ''}
    ${renderNestedAccordion({
      id: 'acc-general',
      icon: '🕐',
      title: 'הגדרות כלליות',
      summary: `שעת תחילת יום: ${String(settings.dayStartHour).padStart(2, '0')}:00`,
      body: renderGeneralSettings(settings.dayStartHour),
    })}
    ${renderNestedAccordion({
      id: 'acc-weights',
      icon: '⚖',
      title: 'משקלות',
      summary: getWeightsSummary(cfg),
      body: renderWeightGroups(cfg),
    })}
    ${renderNestedAccordion({
      id: 'acc-constraints',
      icon: '🔒',
      title: 'תנאים מחייבים',
      summary: getConstraintsSummary(disabledHC),
      body: renderHardConstraints(disabledHC),
    })}`;

  html += renderAccordion({
    id: 'acc-algorithm',
    icon: '⚙',
    title: 'הגדרות אלגוריתם',
    summary: getAlgoSummary(cfg, disabledHC),
    body: algoBody,
  });

  // ── Section 2: Certifications & Pakals ──
  html += renderAccordion({
    id: 'acc-entities',
    icon: '🏅',
    title: 'הסמכות ופק"לים',
    summary: getCertPakalSummary(),
    body: renderCertificationContent() + '<hr class="settings-divider">' + renderPakalContent(),
  });

  // ── Section 3: Additional Settings ──
  html += renderAccordion({
    id: 'acc-additional',
    icon: '🎨',
    title: 'הגדרות נוספות',
    summary: getDisplaySummary(),
    body: renderDisplayContent() + renderStorageUsageContent() + renderDangerContent(),
  });

  // ── Section 4: Data Transfer ──
  html += renderAccordion({
    id: 'acc-transfer',
    icon: '📦',
    title: 'העברת נתונים',
    summary: 'ייבוא / ייצוא נתונים בין מכשירים',
    body: renderDataTransferContent(),
  });

  return html;
}

// ─── Preset Panel Renderer ───────────────────────────────────────────────────

function renderPresetPanel(
  presets: AlgorithmPreset[],
  activeId: string | null,
  dirty: boolean,
  _activeIsBuiltIn: boolean,
): string {
  const nameFieldInvalid = _presetFormError ? ' aria-invalid="true" aria-describedby="preset-form-error"' : '';
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
        <label>שם: <input type="text" class="preset-name-input" data-field="saveas-name" maxlength="60" placeholder="התבנית שלי" autofocus${nameFieldInvalid} /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="saveas-desc" maxlength="200" placeholder="תיאור אופציונלי" /></label>
        <button class="btn-sm btn-primary" data-action="algo-preset-saveas-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="algo-preset-form-cancel">ביטול</button>
      </div>
      <div class="preset-validation-error" id="preset-form-error">${_presetFormError}</div>
    </div>`;
  } else if (_presetFormMode === 'rename') {
    const targetId = _presetRenameTargetId ?? activeId;
    const target = targetId ? store.getPresetById(targetId) : undefined;
    html += `<div class="preset-inline-form" id="preset-rename-form">
      <div class="preset-form-row">
        <label>שם: <input type="text" class="preset-name-input" data-field="rename-name" maxlength="60" value="${escHtml(target?.name ?? '')}"${nameFieldInvalid} /></label>
        <label>תיאור: <input type="text" class="preset-desc-input" data-field="rename-desc" maxlength="200" value="${escHtml(target?.description ?? '')}" /></label>
        <button class="btn-sm btn-primary" data-action="algo-preset-rename-confirm">שמור</button>
        <button class="btn-sm btn-outline" data-action="algo-preset-form-cancel">ביטול</button>
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
          ${isBuiltIn ? '<span class="preset-builtin-badge">מובנה</span>' : ''}
          ${isActive && dirty ? '<span class="preset-dirty-badge">שונה</span>' : ''}
        </div>
        ${p.description ? `<div class="preset-item-desc text-muted">${escHtml(p.description)}</div>` : ''}
        <div class="preset-item-actions">
          ${!isActive ? `<button class="btn-xs btn-primary" data-preset-action="load" data-preset-id="${p.id}" title="טען תבנית זו">▶ טען</button>` : ''}
          ${isActive && dirty && !isBuiltIn ? `<button class="btn-xs btn-outline" data-preset-action="update" data-preset-id="${p.id}" title="עדכן עם ההגדרות הנוכחיות">עדכן</button>` : ''}
          ${!isBuiltIn ? `<button class="btn-xs btn-outline" data-preset-action="rename" data-preset-id="${p.id}" title="שנה שם">✎</button>` : ''}
          <button class="btn-xs btn-outline" data-preset-action="duplicate" data-preset-id="${p.id}" title="שכפל">⧉</button>
          ${!isBuiltIn ? `<button class="btn-xs btn-danger-outline" data-preset-action="delete" data-preset-id="${p.id}" title="מחק">${SVG_ICONS.trash}</button>` : ''}
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
      ${
        f.detail
          ? `
      <details class="algo-weight-details">
        <summary>למידע נוסף</summary>
        <p>${f.detail}</p>
      </details>`
          : ''
      }
    </div>`;
}

// ─── Wire Events ─────────────────────────────────────────────────────────────

export function wireAlgorithmEvents(container: HTMLElement, rerender: () => void): void {
  // Store rerender for debounce flush
  _pendingRerender = rerender;

  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.field === 'cert-name') {
      _pendingCertName = target.value;
      return;
    }
    if (target.dataset.field !== 'saveas-name' && target.dataset.field !== 'rename-name') return;
    if (!_presetFormError) return;
    _presetFormError = '';
    target.removeAttribute('aria-invalid');
    const errorEl = container.querySelector('#preset-form-error') as HTMLElement | null;
    if (errorEl) errorEl.textContent = '';
  });

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

      // ── Auto-tune (dispatch to app-level handler) ──
      case 'algo-auto-tune': {
        document.dispatchEvent(new CustomEvent('gm:auto-tune-request'));
        break;
      }

      // ── Theme toggle ──
      case 'set-theme': {
        const theme = btn.dataset.theme as 'dark' | 'light';
        if (theme && theme !== getCurrentTheme()) {
          setTheme(theme);
          rerender();
        }
        break;
      }

      // ── Storage refresh ──
      case 'storage-refresh': {
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

      // ── Certification management ──
      case 'cert-add': {
        const name = _pendingCertName.trim();
        if (!name) {
          showToast('יש להזין שם להסמכה', { type: 'error' });
          break;
        }
        try {
          store.addCertification(name, _selectedCertColor);
          showToast(`הסמכה "${name}" נוספה`, { type: 'success' });
          _pendingCertName = '';
        } catch (err: any) {
          showToast(err.message || 'שגיאה', { type: 'error' });
        }
        rerender();
        break;
      }
      case 'cert-edit': {
        _certEditingId = btn.dataset.certId || null;
        _certError = '';
        rerender();
        break;
      }
      case 'cert-cancel': {
        _certEditingId = null;
        _certError = '';
        rerender();
        break;
      }
      case 'cert-save': {
        const certId = btn.dataset.certId || '';
        const input = container.querySelector<HTMLInputElement>(
          `[data-field="cert-edit-label"][data-cert-id="${certId}"]`,
        );
        const error = store.renameCertification(certId, input?.value || '');
        if (error) {
          _certError = error;
          rerender();
          break;
        }
        _certEditingId = null;
        _certError = '';
        showToast('הסמכה עודכנה', { type: 'success' });
        rerender();
        break;
      }
      case 'cert-remove': {
        const certId = btn.dataset.certId;
        if (!certId) break;
        const usage = store.getCertificationUsage(certId);
        const label = store.getCertLabel(certId);
        if (usage.participantCount > 0 || usage.slotCount > 0) {
          showConfirm(
            `הסמכה "${label}" נמצאת בשימוש (${usage.participantCount} משתתפים, ${usage.slotCount} משבצות). למחוק בכל זאת? אזהרה תוצג על משתתפים ומשימות שעדיין משתמשים בה.`,
            { danger: true, title: 'מחיקת הסמכה', confirmLabel: 'מחק' },
          ).then((ok) => {
            if (ok) {
              store.removeCertification(certId);
              rerender();
            }
          });
        } else {
          store.removeCertification(certId);
          rerender();
        }
        break;
      }
      case 'cert-select-color': {
        _selectedCertColor = btn.dataset.color || CERT_COLOR_PALETTE[0];
        _customColorWarning = '';
        rerender();
        break;
      }
      case 'cert-change-color': {
        const certId = btn.dataset.certId;
        _certColorEditId = _certColorEditId === certId ? null : (certId ?? null);
        rerender();
        break;
      }
      case 'cert-pick-color': {
        const certId = btn.dataset.certId;
        const color = btn.dataset.color;
        if (certId && color) {
          store.updateCertificationColor(certId, color);
        }
        _certColorEditId = null;
        rerender();
        break;
      }
      case 'cert-custom-color-trigger': {
        // Programmatically open the native color picker paired with this swatch.
        const input = container.querySelector<HTMLInputElement>(
          'input.cert-custom-color-input[data-action="cert-custom-color-change"]',
        );
        input?.click();
        break;
      }
      case 'cert-edit-custom-color': {
        const certId = btn.dataset.certId;
        if (!certId) break;
        const input = container.querySelector<HTMLInputElement>(
          `input.cert-custom-color-input[data-action="cert-edit-custom-change"][data-cert-id="${certId}"]`,
        );
        input?.click();
        break;
      }

      // ── Pakal management ──
      case 'pakal-add': {
        const labelInput = container.querySelector<HTMLInputElement>('[data-field="pakal-new-label"]');
        const result = store.addPakal(labelInput?.value || '');
        if (result.error) {
          _pakalError = result.error;
          rerender();
          break;
        }
        _pakalError = '';
        _pakalEditingId = null;
        showToast('פק"ל נוסף', { type: 'success' });
        rerender();
        break;
      }
      case 'pakal-edit': {
        _pakalEditingId = btn.dataset.pakalId || null;
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
        const pakalId = btn.dataset.pakalId || '';
        const input = container.querySelector<HTMLInputElement>(
          `[data-field="pakal-edit-label"][data-pakal-id="${pakalId}"]`,
        );
        const error = store.renamePakal(pakalId, input?.value || '');
        if (error) {
          _pakalError = error;
          rerender();
          break;
        }
        _pakalEditingId = null;
        _pakalError = '';
        showToast('פק"ל עודכן', { type: 'success' });
        rerender();
        break;
      }
      case 'pakal-remove': {
        const pakalId = btn.dataset.pakalId;
        if (!pakalId) break;
        const usageCount = store.getPakalUsageCount(pakalId);
        const label = store.getPakalLabel(pakalId);
        if (usageCount > 0) {
          showConfirm(
            `פק"ל "${label}" נמצא בשימוש (${usageCount} משתתפים). למחוק בכל זאת? אזהרה תוצג על משתתפים שעדיין משתמשים בו.`,
            { danger: true, title: 'מחיקת פק"ל', confirmLabel: 'מחק' },
          ).then((ok) => {
            if (ok) {
              store.removePakal(pakalId);
              rerender();
            }
          });
        } else {
          store.removePakal(pakalId);
          rerender();
        }
        break;
      }

      // ── Accordion toggle ──
      case 'settings-accordion-toggle': {
        const id = btn.dataset.accordion;
        if (!id) break;
        if (_openAccordions.has(id)) {
          _openAccordions.delete(id);
        } else {
          _openAccordions.add(id);
        }
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

  // ── Day start hour select ──
  wireCustomSelect(container, 'gm-day-start-hour', (v) => {
    const hour = parseInt(v, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) return;
    store.setAlgorithmSettings({ dayStartHour: hour });
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
        if ((el as HTMLInputElement).checked) set.delete(code);
        else set.add(code);
        store.setAlgorithmSettings({ disabledHardConstraints: [...set] });
        rerender();
        break;
      }
      case 'algo-weight-input': {
        // On commit (blur / Enter), correct the displayed value to the clamped range
        const inp = el as HTMLInputElement;
        const v = parseFloat(inp.value);
        if (isNaN(v)) break;
        const lo = parseFloat(inp.min);
        const hi = parseFloat(inp.max);
        if (!isNaN(lo) && !isNaN(hi)) {
          inp.value = String(Math.min(hi, Math.max(lo, v)));
        }
        break;
      }
      case 'set-default-attempts': {
        const inp = el as HTMLInputElement;
        const val = parseInt(inp.value, 10);
        if (!Number.isInteger(val) || val <= 0) {
          inp.value = String(getStoredDefaultAttempts());
          break;
        }
        inp.value = String(val);
        setDefaultAttempts(val);
        rerender();
        break;
      }
      case 'cert-custom-color-change': {
        // Native <input type="color"> committed a value for the "add new cert" form.
        const color = ((el as HTMLInputElement).value || '').toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(color)) break;
        const ratio = contrastOnWhite(color);
        if (ratio < MIN_CONTRAST) {
          _customColorWarning = `ניגודיות נמוכה מדי (${ratio.toFixed(1)}:1) — טקסט לבן על הצבע הזה לא יהיה קריא.`;
          showToast('צבע בהיר מדי — טקסט לבן על התג לא יהיה קריא', { type: 'warning' });
          rerender();
          break;
        }
        _customColorWarning = '';
        _selectedCertColor = color;
        rerender();
        break;
      }
      case 'cert-edit-custom-change': {
        // Native <input type="color"> committed a value for an existing cert's color.
        const certId = el.dataset.certId;
        const color = ((el as HTMLInputElement).value || '').toLowerCase();
        if (!certId || !/^#[0-9a-f]{6}$/.test(color)) break;
        const ratio = contrastOnWhite(color);
        if (ratio < MIN_CONTRAST) {
          showToast(`צבע בהיר מדי — ניגודיות ${ratio.toFixed(1)}:1 מול טקסט לבן`, { type: 'warning' });
          break;
        }
        store.updateCertificationColor(certId, color);
        _certColorEditId = null;
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

      // Clamp to declared range — type="number" doesn't enforce min/max on typed input
      const lo = parseFloat(el.min);
      const hi = parseFloat(el.max);
      const clamped = !isNaN(lo) && !isNaN(hi) ? Math.min(hi, Math.max(lo, numVal)) : numVal;

      // Sync the paired control (slider ↔ number input)
      const card = el.closest('.algo-weight-card');
      if (card) {
        const sibling =
          action === 'algo-weight-slider'
            ? card.querySelector<HTMLInputElement>('[data-action="algo-weight-input"]')
            : card.querySelector<HTMLInputElement>('[data-action="algo-weight-slider"]');
        if (sibling) sibling.value = String(clamped);
      }

      // Store pending value and debounce persist
      _pendingWeight = { key, value: clamped };
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
      const ok = await showConfirm(`למחוק את התבנית "${preset.name}"? לא ניתן לבטל פעולה זו.`, {
        danger: true,
        title: 'מחיקת תבנית',
        confirmLabel: 'מחק',
      });
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
