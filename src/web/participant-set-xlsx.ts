/**
 * Participant Set — Excel (xlsx) export / import.
 *
 * Full-set replace format. JSON-envelope equivalent built from six named
 * sheets:
 *
 *   1. הוראות           — human-readable instructions
 *   2. משתתפים          — one row per participant (main data)
 *   3. אי-זמינות        — recurring weekly unavailability rules
 *   4. הסמכות           — cert catalog (per-file authoritative)
 *   5. פקלים            — pakal catalog (per-file authoritative)
 *   6. מטא              — format marker, schema version, set name/description
 *
 * Design notes:
 *   - Certification and pakal columns are boolean-per-column with headers of
 *     the form `<HebrewLabel> [<id>]`. The bracketed ID is the canonical
 *     match key — Hebrew labels are only for humans.
 *   - Pakal columns are disambiguated with the `פק"ל:` prefix.
 *   - Midnight-crossing rules (endHour < startHour) are accepted.
 *   - The exporter wraps every user-controlled string through
 *     `escapeFormulaInjection` to block CSV/Excel formula injection.
 *   - The parser rejects formulas, hyperlinks, external links, images, and
 *     cell comments outright — "robustness over flexibility".
 */

import ExcelJS, { type Cell, type Row, type Workbook, type Worksheet } from 'exceljs';
import {
  type CertificationDefinition,
  type DateUnavailability,
  Level,
  type PakalDefinition,
  type ParticipantSet,
  type ParticipantSnapshot,
} from '../models/types';
import { HEBREW_DAYS } from '../utils/date-utils';
import { validateGroupName } from './group-name-rules';

// ─── Constants ──────────────────────────────────────────────────────────────

export const FORMAT_MARKER = 'gardenmanager-participant-set';
export const SCHEMA_VERSION = 1;

// Sheet names — load-bearing, checked exactly on import.
export const SHEET_INSTRUCTIONS = 'הוראות';
export const SHEET_PARTICIPANTS = 'משתתפים';
export const SHEET_UNAVAILABILITY = 'אי-זמינות';
export const SHEET_CERTS = 'הסמכות';
export const SHEET_PAKALS = 'פקלים';
export const SHEET_META = 'מטא';
export const SHEET_EXAMPLE = 'דוגמה';

const REQUIRED_SHEETS = [
  SHEET_INSTRUCTIONS,
  SHEET_PARTICIPANTS,
  SHEET_UNAVAILABILITY,
  SHEET_CERTS,
  SHEET_PAKALS,
  SHEET_META,
] as const;

// Caps — security + sanity.
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_PARTICIPANT_ROWS = 200;
export const MAX_UNAVAILABILITY_ROWS = 2000;
export const MAX_RULES_PER_PARTICIPANT = 50;
export const MAX_CATALOG_ENTRIES = 50;
export const MAX_TOTAL_CELLS = 200_000;
export const MAX_ERRORS_COLLECTED = 100;
export const MAX_RICH_TEXT_CHARS = 1024;

// Fixed (non-dynamic) header labels in משתתפים.
const HEADER_NAME = 'שם משתתף';
const HEADER_GROUP = 'קבוצה';
const HEADER_LEVEL = 'רמה';
const HEADER_NOT_WITH = 'לא עם';
const HEADER_PREFERRED = 'משימה מועדפת';
const HEADER_LESS_PREFERRED = 'משימה פחות מועדפת';

// אי-זמינות headers.
const UNAVAIL_HEADER_NAME = 'שם משתתף';
const UNAVAIL_HEADER_DAY = 'יום';
const UNAVAIL_HEADER_ALL_DAY = 'כל היום';
const UNAVAIL_HEADER_START = 'שעת התחלה';
const UNAVAIL_HEADER_END = 'שעת סיום';
const UNAVAIL_HEADER_REASON = 'סיבה';

// Catalog headers.
const CERT_HEADER_ID = 'מזהה';
const CERT_HEADER_LABEL = 'תווית';
const CERT_HEADER_COLOR = 'צבע';
const PAKAL_HEADER_ID = 'מזהה';
const PAKAL_HEADER_LABEL = 'תווית';

// Meta keys.
const META_KEY_FORMAT = 'סוג קובץ';
const META_KEY_SCHEMA = 'גרסת סכמה';
const META_KEY_NAME = 'שם הסט';
const META_KEY_DESCRIPTION = 'תיאור הסט';
const META_KEY_CREATED_AT = 'נוצר בתאריך';
const META_KEY_PARTICIPANT_COUNT = 'מספר משתתפים';
const META_KEY_WARNING = 'אזהרה';

// Truthy tokens accepted on import (NFC-normalised + lowercased + trimmed).
const TRUTHY_TOKENS = new Set(['כן', 'כ', 'true', 'yes', 'y', 'x', 'v', '✓', '1']);

// Pakal column-header prefix.
const PAKAL_HEADER_PREFIX = 'פק"ל: ';

// Header regex: `<label> [<id>]`.
/** Legacy bracket regex — accepted on import for backwards compatibility with
 *  files exported before the switch to label-only headers. */
const HEADER_ID_REGEX = /^([^\[]+?)\s*\[([^\]]+)\]\s*$/;

// Visual styling (mirrors excel-export.ts).
const HEADER_FILL_ARGB = 'FF374151';
const HEADER_FONT_ARGB = 'FFFFFFFF';
const THIN_BORDER = {
  top: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  bottom: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  left: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  right: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface XlsxImportError {
  sheet: string;
  rowNumber?: number;
  cellRef?: string;
  message: string;
}

export interface XlsxImportMeta {
  name: string;
  description: string;
  participantCount: number;
  certCount: number;
  pakalCount: number;
  rulesCount: number;
  newCertsForApp: CertificationDefinition[];
  newPakalsForApp: PakalDefinition[];
}

export type XlsxImportResult =
  | { ok: true; pset: ParticipantSet; meta: XlsxImportMeta }
  | { ok: false; errors: XlsxImportError[] };

export interface XlsxBuildOptions {
  templateMode?: boolean;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function normStr(s: string): string {
  return s.normalize('NFC').trim();
}

function normStrLowerCanonical(s: string): string {
  return normStr(s).toLowerCase();
}

const RLM = '\u200F';

/** Fix BiDi rendering for Hebrew text in Excel cells: anchor neutral
 *  characters (periods, quotes, parens) so they don't float to the wrong
 *  visual side. Prepends RLM to establish base RTL direction and inserts
 *  RLM before trailing neutral punctuation. */
function rtlFix(s: string): string {
  if (!s) return s;
  // Prepend RLM so Excel treats the paragraph as RTL from the start.
  let out = RLM + s;
  // Insert RLM before a trailing period/comma so it sticks to the text.
  out = out.replace(/([^\u200F])([.,;:!?])$/u, `$1${RLM}$2`);
  return out;
}

/** Block CSV/Excel formula injection. Prefix `'` when the value begins with
 *  any of `=`, `+`, `-`, `@`, TAB, or CR. */
function escapeFormulaInjection(raw: string): string {
  if (!raw) return raw;
  const first = raw.charCodeAt(0);
  // '=' 61, '+' 43, '-' 45, '@' 64, TAB 9, CR 13
  if (first === 61 || first === 43 || first === 45 || first === 64 || first === 9 || first === 13) {
    return `'${raw}`;
  }
  return raw;
}

function buildCertHeader(def: CertificationDefinition): string {
  return def.label;
}

function buildPakalHeader(def: PakalDefinition): string {
  return `${PAKAL_HEADER_PREFIX}${def.label}`;
}

function dayIndexToName(dow: number): string {
  return HEBREW_DAYS[dow] ?? String(dow);
}

function dayNameToIndex(raw: string): number | null {
  let v = normStr(raw);
  if (!v) return null;
  // Accept `יום X` prefix.
  if (v.startsWith('יום ')) v = v.slice(4).trim();
  const idx = HEBREW_DAYS.indexOf(v as (typeof HEBREW_DAYS)[number]);
  return idx >= 0 ? idx : null;
}

function coerceBoolean(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const token = normStrLowerCanonical(raw);
    return TRUTHY_TOKENS.has(token);
  }
  return false;
}

function coerceHour(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    const n = Math.trunc(raw);
    return n >= 0 && n <= 23 ? n : null;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const t = Math.trunc(n);
    return t >= 0 && t <= 23 ? t : null;
  }
  return null;
}

export function generateXlsxFilename(name?: string): string {
  const safeName = sanitizeFilenameFragment(name || 'participants');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `gm-participants-${safeName}-${stamp}.xlsx`;
}

function sanitizeFilenameFragment(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

// ─── Cell readers ───────────────────────────────────────────────────────────

function isFormulaCell(cell: Cell): boolean {
  if (cell.formula) return true;
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const obj = v as Record<string, unknown>;
    if ('formula' in obj || 'sharedFormula' in obj) return true;
  }
  return false;
}

function isHyperlinkCell(cell: Cell): boolean {
  // ValueType enum is numeric; Hyperlink = 9. Avoid importing the enum to keep
  // the dep surface small — equivalent structural check below.
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const obj = v as Record<string, unknown>;
    if ('hyperlink' in obj && typeof obj.hyperlink === 'string') return true;
  }
  return false;
}

function isErrorCell(cell: Cell): boolean {
  const v = cell.value as unknown;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const obj = v as Record<string, unknown>;
    if ('error' in obj && typeof obj.error === 'string') return true;
  }
  return false;
}

/** Reads a cell as a plain NFC-normalised trimmed string. Rich text is
 *  flattened. Caller is responsible for rejecting formula/hyperlink/error
 *  cells first. */
function readCellString(cell: Cell): string {
  const raw = cell.value;
  if (raw === null || raw === undefined || raw === '') return '';
  if (typeof raw === 'string') return normStr(raw).slice(0, MAX_RICH_TEXT_CHARS);
  if (typeof raw === 'number') return normStr(String(raw));
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  if (raw instanceof Date) return normStr(raw.toISOString());
  const obj = raw as unknown as Record<string, unknown>;
  if (Array.isArray(obj.richText)) {
    const parts = (obj.richText as Array<{ text?: string }>).map((r) => r.text ?? '');
    return normStr(parts.join('')).slice(0, MAX_RICH_TEXT_CHARS);
  }
  if (typeof obj.text === 'string') return normStr(obj.text).slice(0, MAX_RICH_TEXT_CHARS);
  if (typeof obj.result === 'string') return normStr(obj.result).slice(0, MAX_RICH_TEXT_CHARS);
  if (typeof obj.result === 'number') return normStr(String(obj.result));
  return '';
}

function cellHasContent(cell: Cell): boolean {
  const v = cell.value;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  return true;
}

function isEmptyRow(row: Row, maxCol: number): boolean {
  for (let c = 1; c <= maxCol; c++) {
    if (cellHasContent(row.getCell(c))) return false;
  }
  return true;
}

// ─── Exporter ───────────────────────────────────────────────────────────────

export async function generateParticipantSetXlsx(pset: ParticipantSet, options: XlsxBuildOptions = {}): Promise<Blob> {
  const templateMode = !!options.templateMode;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Garden Manager';
  wb.created = new Date();

  const certs = (pset.certificationCatalog ?? []).filter((c) => !c.deleted);
  const pakals = (pset.pakalCatalog ?? []).filter((p) => !p.deleted);

  // Sheet order mirrors the tab order users see in Excel. Insert
  // הוראות first so it's the first visible sheet.
  buildInstructionsSheet(wb, templateMode);
  buildParticipantsSheet(wb, pset, certs, pakals, templateMode);
  buildUnavailabilitySheet(wb, pset, templateMode);
  buildCertCatalogSheet(wb, certs);
  buildPakalCatalogSheet(wb, pakals);
  buildMetaSheet(wb, pset, templateMode);
  if (templateMode) buildExampleSheet(wb, certs, pakals);

  const arr = await wb.xlsx.writeBuffer();
  // exceljs types this as Node Buffer; at runtime it's a Uint8Array in the
  // browser. Cast via `unknown` to sidestep the ArrayBuffer vs SharedArrayBuffer
  // Uint8Array variance between the web and node TS configs.
  return new Blob([arr as unknown as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function applyHeaderRowStyle(row: Row): void {
  row.font = { bold: true, color: { argb: HEADER_FONT_ARGB } };
  row.alignment = { horizontal: 'center', vertical: 'middle' };
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
    cell.border = THIN_BORDER;
  });
}

function buildInstructionsSheet(wb: Workbook, templateMode: boolean): void {
  const ws = wb.addWorksheet(SHEET_INSTRUCTIONS);
  ws.views = [{ rightToLeft: true }];
  ws.getColumn(1).width = 100;

  // rtlFix() anchors neutral punctuation (periods, quotes, parens) so
  // Excel's BiDi algorithm keeps them next to the Hebrew text instead of
  // floating them to the wrong visual edge.
  const R = rtlFix;
  const lines: Array<{ text: string; heading?: boolean }> = [
    { text: R('סט משתתפים — Excel'), heading: true },
    { text: '' },
    {
      text: templateMode
        ? R('זו תבנית ריקה. מלא אותה ולאחר מכן ייבא חזרה דרך תפריט ״ייבוא נתונים״.')
        : R('זהו ייצוא מלא של סט משתתפים. ניתן לערוך את הקובץ ולייבא חזרה — הייבוא הוא החלפה מלאה של סט קיים או יצירת סט חדש.'),
    },
    { text: '' },
    { text: R('כללי זהב'), heading: true },
    { text: R('• אל תשנה את שמות הגיליונות ואל תשנה את שורת הכותרות.') },
    { text: R('• אל תשנה את כותרות העמודות של הסמכות ופק״לים — הייבוא מזהה אותן לפי השם.') },
    { text: R('• אין להשתמש בנוסחאות, בקישורים, בהערות לתא או בתמונות — הייבוא ידחה את הקובץ.') },
    { text: R('• אל תערוך את גיליון ״מטא״. הערכים שם זיהויים וחובה.') },
    { text: '' },
    { text: R('גיליון משתתפים'), heading: true },
    { text: R(`• ${HEADER_NAME} — שם המשתתף. חייב להיות ייחודי בתוך הקובץ.`) },
    { text: R(`• ${HEADER_GROUP} — שם קבוצה (2 תווים ומעלה).`) },
    { text: R(`• ${HEADER_LEVEL} — אחד מ: L0 / L2 / L3 / L4 (אין L1).`) },
    {
      text: R('• עמודות ההסמכות והפק״לים — תא ריק = לא, ״כן״ = כן. מקובלים גם true / yes / 1 / x / ✓.'),
    },
    {
      text: R(`• ${HEADER_NOT_WITH} — שמות משתתפים אחרים בקובץ, מופרדים בנקודה-פסיק (;).`),
    },
    { text: R(`• ${HEADER_PREFERRED} / ${HEADER_LESS_PREFERRED} — שם משימה חופשי.`) },
    { text: '' },
    { text: R('גיליון אי-זמינות'), heading: true },
    { text: R('• שורה אחת לכל חלון אי-זמינות שבועי חוזר.') },
    { text: R(`• ${UNAVAIL_HEADER_NAME} — חייב להיות שם הקיים בגיליון משתתפים.`) },
    {
      text: R(`• ${UNAVAIL_HEADER_DAY} — אחד מ: ${HEBREW_DAYS.join(', ')} (גם בצורת ״יום ראשון״ וכו׳).`),
    },
    { text: R(`• ${UNAVAIL_HEADER_ALL_DAY} — ״כן״ מתעלם משעות התחלה/סיום.`) },
    {
      text: R(`• ${UNAVAIL_HEADER_START} / ${UNAVAIL_HEADER_END} — שלמים בטווח 0..23. הערה: ${UNAVAIL_HEADER_END} קטן מ-${UNAVAIL_HEADER_START} מבטא חציית חצות (מותר).`),
    },
    { text: R(`• ${UNAVAIL_HEADER_REASON} — טקסט חופשי, אופציונלי.`) },
    { text: '' },
    { text: R('גיליונות הסמכות ופקלים'), heading: true },
    { text: R('• גיליונות ייחוס — הסמכות חדשות יתווספו לקטלוג האפליקציה באופן אוטומטי בייבוא.') },
    { text: R('• כותרות העמודות בגיליון משתתפים חייבות להתאים לשמות בגיליונות אלה.') },
    { text: '' },
    { text: R('ייבוא חזרה'), heading: true },
    { text: R('• בתפריט ייבוא נתונים בחר ״סט משתתפים (Excel)״ והעלה את הקובץ.') },
    { text: R('• שני מצבים בלבד: הוסף כסט חדש, או החלף סט קיים במלואו. אין מיזוג.') },
    { text: '' },
    { text: R('שגיאות נפוצות'), heading: true },
    { text: R('• שם גיליון שונה — הייבוא דורש שמות מדויקים.') },
    { text: R('• נוסחה בתא — מחק את הנוסחה והזן ערך ישיר.') },
    { text: R('• רמה לא חוקית — רק L0 / L2 / L3 / L4.') },
    { text: R('• שם ברשימת ״לא עם״ שאינו קיים בגיליון משתתפים.') },
    { text: '' },
    { text: R(`גרסת סכמה: ${SCHEMA_VERSION}`) },
  ];
  for (const line of lines) {
    const row = ws.addRow([line.text]);
    if (line.heading) {
      row.font = { bold: true };
    }
  }
}

function buildParticipantsSheet(
  wb: Workbook,
  pset: ParticipantSet,
  certs: CertificationDefinition[],
  pakals: PakalDefinition[],
  templateMode: boolean,
): void {
  const ws = wb.addWorksheet(SHEET_PARTICIPANTS);
  ws.views = [{ rightToLeft: true, state: 'frozen', xSplit: 1, ySplit: 1 }];

  const headers: string[] = [HEADER_NAME, HEADER_GROUP, HEADER_LEVEL];
  for (const c of certs) headers.push(buildCertHeader(c));
  for (const p of pakals) headers.push(buildPakalHeader(p));
  headers.push(HEADER_NOT_WITH, HEADER_PREFERRED, HEADER_LESS_PREFERRED);

  ws.addRow(headers);
  applyHeaderRowStyle(ws.getRow(1));

  // Column widths — broad defaults, name column wider.
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 8;
  for (let i = 0; i < certs.length; i++) ws.getColumn(4 + i).width = 16;
  for (let i = 0; i < pakals.length; i++) ws.getColumn(4 + certs.length + i).width = 18;
  ws.getColumn(headers.length - 2).width = 28; // לא עם
  ws.getColumn(headers.length - 1).width = 18;
  ws.getColumn(headers.length).width = 18;

  // Name column is always text (defends against numeric auto-coerce).
  ws.getColumn(1).numFmt = '@';

  // Data rows.
  const rows = templateMode ? [] : pset.participants;
  for (const p of rows) {
    const rowValues: unknown[] = [
      escapeFormulaInjection(normStr(p.name)),
      escapeFormulaInjection(normStr(p.group)),
      `L${p.level}`,
    ];
    const certIdSet = new Set(p.certifications);
    for (const c of certs) rowValues.push(certIdSet.has(c.id) ? 'כן' : '');
    const pakalIdSet = new Set(p.pakalIds ?? []);
    for (const pk of pakals) rowValues.push(pakalIdSet.has(pk.id) ? 'כן' : '');
    rowValues.push(
      escapeFormulaInjection((p.notWithIds ?? []).join('; ')),
      escapeFormulaInjection(normStr(p.preferredTaskName ?? '')),
      escapeFormulaInjection(normStr(p.lessPreferredTaskName ?? '')),
    );
    const excelRow = ws.addRow(rowValues);
    excelRow.getCell(1).numFmt = '@';
  }

  // Data validation: level dropdown.
  const levelListRef = `"L0,L2,L3,L4"`;
  // Apply to a reasonable range so dropdown appears on empty rows too.
  for (let r = 2; r <= Math.max(rows.length + 1, MAX_PARTICIPANT_ROWS + 1); r++) {
    ws.getCell(r, 3).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [levelListRef],
      showErrorMessage: true,
      errorTitle: 'רמה',
      error: 'רמה חייבת להיות L0, L2, L3 או L4',
    };
  }
  // Boolean-cell dropdowns on cert/pakal columns.
  const boolListRef = `"כן,"`;
  for (let col = 4; col < headers.length - 2; col++) {
    for (let r = 2; r <= Math.max(rows.length + 1, MAX_PARTICIPANT_ROWS + 1); r++) {
      ws.getCell(r, col).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [boolListRef],
      };
    }
  }
}

function buildUnavailabilitySheet(wb: Workbook, pset: ParticipantSet, templateMode: boolean): void {
  const ws = wb.addWorksheet(SHEET_UNAVAILABILITY);
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  const headers = [
    UNAVAIL_HEADER_NAME,
    UNAVAIL_HEADER_DAY,
    UNAVAIL_HEADER_ALL_DAY,
    UNAVAIL_HEADER_START,
    UNAVAIL_HEADER_END,
    UNAVAIL_HEADER_REASON,
  ];
  ws.addRow(headers);
  applyHeaderRowStyle(ws.getRow(1));
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 10;
  ws.getColumn(3).width = 10;
  ws.getColumn(4).width = 12;
  ws.getColumn(5).width = 12;
  ws.getColumn(6).width = 28;
  ws.getColumn(1).numFmt = '@';

  if (!templateMode) {
    for (const p of pset.participants) {
      for (const rule of p.dateUnavailability) {
        ws.addRow([
          escapeFormulaInjection(normStr(p.name)),
          dayIndexToName(rule.dayOfWeek),
          rule.allDay ? 'כן' : '',
          rule.allDay ? '' : rule.startHour,
          rule.allDay ? '' : rule.endHour,
          escapeFormulaInjection(normStr(rule.reason ?? '')),
        ]);
      }
    }
  }

  // Validations on a broad range.
  const dayList = `"${HEBREW_DAYS.join(',')}"`;
  const allDayList = `"כן,"`;
  for (let r = 2; r <= MAX_UNAVAILABILITY_ROWS + 1; r++) {
    ws.getCell(r, 2).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [dayList],
      showErrorMessage: true,
      errorTitle: 'יום',
      error: 'בחר יום מהרשימה',
    };
    ws.getCell(r, 3).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [allDayList],
    };
    ws.getCell(r, 4).dataValidation = {
      type: 'whole',
      operator: 'between',
      allowBlank: true,
      formulae: ['0', '23'],
      showErrorMessage: true,
      errorTitle: 'שעת התחלה',
      error: 'שלם בין 0 ל-23',
    };
    ws.getCell(r, 5).dataValidation = {
      type: 'whole',
      operator: 'between',
      allowBlank: true,
      formulae: ['0', '23'],
      showErrorMessage: true,
      errorTitle: 'שעת סיום',
      error: 'שלם בין 0 ל-23',
    };
  }
}

function buildCertCatalogSheet(wb: Workbook, certs: CertificationDefinition[]): void {
  const ws = wb.addWorksheet(SHEET_CERTS);
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  ws.addRow([CERT_HEADER_ID, CERT_HEADER_LABEL, CERT_HEADER_COLOR]);
  applyHeaderRowStyle(ws.getRow(1));
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 12;
  for (const c of certs) {
    ws.addRow([
      escapeFormulaInjection(normStr(c.id)),
      escapeFormulaInjection(normStr(c.label)),
      escapeFormulaInjection(normStr(c.color || '#888888')),
    ]);
  }
}

function buildPakalCatalogSheet(wb: Workbook, pakals: PakalDefinition[]): void {
  const ws = wb.addWorksheet(SHEET_PAKALS);
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  ws.addRow([PAKAL_HEADER_ID, PAKAL_HEADER_LABEL]);
  applyHeaderRowStyle(ws.getRow(1));
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 22;
  for (const p of pakals) {
    ws.addRow([escapeFormulaInjection(normStr(p.id)), escapeFormulaInjection(normStr(p.label))]);
  }
}

function buildMetaSheet(wb: Workbook, pset: ParticipantSet, templateMode: boolean): void {
  const ws = wb.addWorksheet(SHEET_META);
  ws.views = [{ rightToLeft: true }];
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 50;
  ws.getColumn(2).numFmt = '@';
  const pairs: Array<[string, string | number]> = [
    [META_KEY_FORMAT, FORMAT_MARKER],
    [META_KEY_SCHEMA, SCHEMA_VERSION],
    [META_KEY_NAME, templateMode ? '' : escapeFormulaInjection(normStr(pset.name))],
    [META_KEY_DESCRIPTION, escapeFormulaInjection(normStr(pset.description || ''))],
    [META_KEY_CREATED_AT, new Date().toISOString()],
    [META_KEY_PARTICIPANT_COUNT, templateMode ? 0 : pset.participants.length],
    [META_KEY_WARNING, 'אין לערוך גיליון זה.'],
  ];
  for (const [k, v] of pairs) {
    ws.addRow([k, v]);
  }
  // Cosmetic protection — no password, just friction.
  try {
    void ws.protect('', { selectLockedCells: true, selectUnlockedCells: true });
  } catch {
    // Ignore if not supported.
  }
}

function buildExampleSheet(wb: Workbook, certs: CertificationDefinition[], pakals: PakalDefinition[]): void {
  const ws = wb.addWorksheet(SHEET_EXAMPLE);
  ws.views = [{ rightToLeft: true }];
  const headers: string[] = [HEADER_NAME, HEADER_GROUP, HEADER_LEVEL];
  for (const c of certs) headers.push(buildCertHeader(c));
  for (const p of pakals) headers.push(buildPakalHeader(p));
  headers.push(HEADER_NOT_WITH, HEADER_PREFERRED, HEADER_LESS_PREFERRED);
  ws.addRow(headers);
  applyHeaderRowStyle(ws.getRow(1));
  ws.getColumn(1).numFmt = '@';

  // One fully-filled example row.
  const example: unknown[] = ['ישראל ישראלי', 'קבוצה א', 'L2'];
  for (let i = 0; i < certs.length; i++) example.push(i === 0 ? 'כן' : '');
  for (let i = 0; i < pakals.length; i++) example.push('');
  example.push('', 'עבודה קלה', '');
  ws.addRow(example);

  ws.addRow([]);
  ws.addRow(['שורת דוגמה בלבד. גיליון זה מתעלם בייבוא.']);
  ws.getRow(3).font = { italic: true, color: { argb: 'FF888888' } };
}

// ─── Parser ─────────────────────────────────────────────────────────────────

interface ParsedHeader {
  /** Map from column index (1-based) to logical kind. */
  kind:
    | { type: 'name' }
    | { type: 'group' }
    | { type: 'level' }
    | { type: 'notWith' }
    | { type: 'preferred' }
    | { type: 'lessPreferred' }
    | { type: 'cert'; id: string }
    | { type: 'pakal'; id: string };
}

interface ParseContext {
  errors: XlsxImportError[];
  errorBudgetExceeded: boolean;
}

function pushError(ctx: ParseContext, err: XlsxImportError): void {
  if (ctx.errorBudgetExceeded) return;
  if (ctx.errors.length >= MAX_ERRORS_COLLECTED) {
    ctx.errorBudgetExceeded = true;
    ctx.errors.push({
      sheet: '—',
      message: 'יותר מ-100 שגיאות. תקן את הראשונות וייבא שוב.',
    });
    return;
  }
  ctx.errors.push(err);
}

export async function parseParticipantSetXlsx(buffer: ArrayBuffer): Promise<XlsxImportResult> {
  const ctx: ParseContext = { errors: [], errorBudgetExceeded: false };

  // Phase 1: pre-parse byte-level rejects.
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return {
      ok: false,
      errors: [{ sheet: '(קובץ)', message: `הקובץ גדול מ-${MAX_FILE_BYTES / 1024 / 1024}MB ונדחה.` }],
    };
  }
  if (buffer.byteLength < 4) {
    return { ok: false, errors: [{ sheet: '(קובץ)', message: 'הקובץ אינו קובץ Excel תקין.' }] };
  }
  const sig = new Uint8Array(buffer, 0, 4);
  if (sig[0] !== 0x50 || sig[1] !== 0x4b || sig[2] !== 0x03 || sig[3] !== 0x04) {
    return { ok: false, errors: [{ sheet: '(קובץ)', message: 'הקובץ אינו קובץ Excel תקין.' }] };
  }

  // Phase 2: workbook load.
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          sheet: '(קובץ)',
          message: `הקובץ פגום או אינו .xlsx תקין: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  // Required sheets present.
  for (const name of REQUIRED_SHEETS) {
    if (!wb.getWorksheet(name)) {
      pushError(ctx, { sheet: name, message: `גיליון חסר: '${name}'.` });
    }
  }
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  // Reject unsupported content at the workbook level.
  const externals = (wb.model as unknown as { externals?: unknown[] }).externals;
  if (Array.isArray(externals) && externals.length > 0) {
    pushError(ctx, { sheet: '(קובץ)', message: 'קישורים חיצוניים אינם נתמכים.' });
  }
  // Reject images and cell notes/comments across all recognized sheets.
  for (const sheetName of REQUIRED_SHEETS) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) continue;
    const imgFn = (ws as unknown as { getImages?: () => unknown[] }).getImages;
    if (typeof imgFn === 'function') {
      const imgs = imgFn.call(ws);
      if (Array.isArray(imgs) && imgs.length > 0) {
        pushError(ctx, { sheet: sheetName, message: 'תמונות אינן נתמכות.' });
        break;
      }
    }
    let sawNote = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (sawNote) return;
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (sawNote) return;
        if ((cell as unknown as { note?: unknown }).note != null) sawNote = true;
      });
    });
    if (sawNote) {
      pushError(ctx, { sheet: sheetName, message: 'הערות תאים אינן נתמכות.' });
      break;
    }
  }

  // Meta sheet validation.
  const metaWs = wb.getWorksheet(SHEET_META)!;
  const metaMap = readMetaPairs(metaWs);
  if (metaMap.get(META_KEY_FORMAT) !== FORMAT_MARKER) {
    pushError(ctx, {
      sheet: SHEET_META,
      message: 'הקובץ אינו קובץ סט משתתפים של גינה מנהלת.',
    });
  }
  const schemaVal = metaMap.get(META_KEY_SCHEMA);
  if (String(schemaVal) !== String(SCHEMA_VERSION)) {
    pushError(ctx, {
      sheet: SHEET_META,
      message: `גרסת סכמה לא נתמכת: ${schemaVal ?? '(חסר)'}.`,
    });
  }
  const setName = (metaMap.get(META_KEY_NAME) ?? '').trim();
  const setDescription = (metaMap.get(META_KEY_DESCRIPTION) ?? '').trim();
  if (!setName) {
    pushError(ctx, { sheet: SHEET_META, message: 'שם הסט חסר בגיליון מטא.' });
  }

  if (ctx.errors.some((e) => e.sheet === SHEET_META || e.sheet === '(קובץ)')) {
    // Bail early on envelope-level errors — parsing further is noisy.
    return { ok: false, errors: ctx.errors };
  }

  // Count total cells as a cheap shared-strings bomb check.
  let totalCells = 0;
  for (const name of REQUIRED_SHEETS) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    totalCells += ws.actualRowCount * ws.actualColumnCount;
  }
  if (totalCells > MAX_TOTAL_CELLS) {
    return { ok: false, errors: [{ sheet: '(קובץ)', message: 'הקובץ גדול מדי.' }] };
  }

  // Phase 3: catalog parsing.
  const certCatalog = parseCertCatalog(wb, ctx);
  const pakalCatalog = parsePakalCatalog(wb, ctx);

  // Phase 4: משתתפים header parsing.
  const participantsWs = wb.getWorksheet(SHEET_PARTICIPANTS)!;
  const headerInfo = parseParticipantsHeader(participantsWs, certCatalog, pakalCatalog, ctx);
  if (ctx.errorBudgetExceeded || ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }

  // Phase 5/6: משתתפים rows.
  const snapshots = parseParticipantsRows(participantsWs, headerInfo, ctx);
  if (ctx.errorBudgetExceeded) return { ok: false, errors: ctx.errors };

  // Phase 7: אי-זמינות rows.
  const unavailWs = wb.getWorksheet(SHEET_UNAVAILABILITY)!;
  parseUnavailabilityRows(unavailWs, snapshots, ctx);
  if (ctx.errorBudgetExceeded) return { ok: false, errors: ctx.errors };

  // Phase 8: cross-row validation for notWith.
  resolveNotWithReferences(snapshots, ctx);

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };

  // Build final ParticipantSet.
  const finalSnapshots = snapshots.map((s) => s.snapshot);
  const pset: ParticipantSet = {
    id: '', // caller fills via store.uid
    name: setName,
    description: setDescription,
    participants: finalSnapshots,
    certificationCatalog: certCatalog,
    pakalCatalog,
    createdAt: 0, // caller fills
  };

  const meta: XlsxImportMeta = {
    name: setName,
    description: setDescription,
    participantCount: finalSnapshots.length,
    certCount: certCatalog.length,
    pakalCount: pakalCatalog.length,
    rulesCount: finalSnapshots.reduce((s, p) => s + p.dateUnavailability.length, 0),
    newCertsForApp: certCatalog,
    newPakalsForApp: pakalCatalog,
  };

  return { ok: true, pset, meta };
}

// ─── Parser helpers ─────────────────────────────────────────────────────────

function readMetaPairs(ws: Worksheet): Map<string, string> {
  const out = new Map<string, string>();
  const rowCount = Math.min(ws.actualRowCount, 50);
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const k = readCellString(row.getCell(1));
    if (!k) continue;
    const v = readCellString(row.getCell(2));
    out.set(k, v);
  }
  return out;
}

function parseCertCatalog(wb: Workbook, ctx: ParseContext): CertificationDefinition[] {
  const ws = wb.getWorksheet(SHEET_CERTS);
  if (!ws) return [];
  const out: CertificationDefinition[] = [];
  const seen = new Set<string>();
  const rowCount = ws.actualRowCount;
  if (rowCount - 1 > MAX_CATALOG_ENTRIES) {
    pushError(ctx, { sheet: SHEET_CERTS, message: `יותר מ-${MAX_CATALOG_ENTRIES} הסמכות.` });
    return [];
  }
  for (let r = 2; r <= rowCount; r++) {
    const row = ws.getRow(r);
    if (isEmptyRow(row, 3)) continue;
    const idCell = row.getCell(1);
    const labelCell = row.getCell(2);
    const colorCell = row.getCell(3);
    if (isFormulaCell(idCell) || isFormulaCell(labelCell) || isFormulaCell(colorCell)) {
      pushError(ctx, { sheet: SHEET_CERTS, rowNumber: r, message: `נוסחה אסורה בשורה ${r}.` });
      continue;
    }
    const id = readCellString(idCell);
    const label = readCellString(labelCell);
    const color = readCellString(colorCell) || '#888888';
    if (!id) {
      pushError(ctx, { sheet: SHEET_CERTS, rowNumber: r, message: `שורה ${r}: מזהה חסר.` });
      continue;
    }
    if (!label) {
      pushError(ctx, { sheet: SHEET_CERTS, rowNumber: r, message: `שורה ${r}: תווית חסרה.` });
      continue;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      pushError(ctx, {
        sheet: SHEET_CERTS,
        rowNumber: r,
        message: `שורה ${r}: צבע לא תקין: '${color}'.`,
      });
      continue;
    }
    if (seen.has(id)) {
      pushError(ctx, { sheet: SHEET_CERTS, rowNumber: r, message: `שורה ${r}: מזהה כפול: '${id}'.` });
      continue;
    }
    seen.add(id);
    out.push({ id, label, color });
  }
  return out;
}

function parsePakalCatalog(wb: Workbook, ctx: ParseContext): PakalDefinition[] {
  const ws = wb.getWorksheet(SHEET_PAKALS);
  if (!ws) return [];
  const out: PakalDefinition[] = [];
  const seen = new Set<string>();
  const rowCount = ws.actualRowCount;
  if (rowCount - 1 > MAX_CATALOG_ENTRIES) {
    pushError(ctx, { sheet: SHEET_PAKALS, message: `יותר מ-${MAX_CATALOG_ENTRIES} פק"לים.` });
    return [];
  }
  for (let r = 2; r <= rowCount; r++) {
    const row = ws.getRow(r);
    if (isEmptyRow(row, 2)) continue;
    const idCell = row.getCell(1);
    const labelCell = row.getCell(2);
    if (isFormulaCell(idCell) || isFormulaCell(labelCell)) {
      pushError(ctx, { sheet: SHEET_PAKALS, rowNumber: r, message: `נוסחה אסורה בשורה ${r}.` });
      continue;
    }
    const id = readCellString(idCell);
    const label = readCellString(labelCell);
    if (!id) {
      pushError(ctx, { sheet: SHEET_PAKALS, rowNumber: r, message: `שורה ${r}: מזהה חסר.` });
      continue;
    }
    if (!label) {
      pushError(ctx, { sheet: SHEET_PAKALS, rowNumber: r, message: `שורה ${r}: תווית חסרה.` });
      continue;
    }
    if (seen.has(id)) {
      pushError(ctx, {
        sheet: SHEET_PAKALS,
        rowNumber: r,
        message: `שורה ${r}: מזהה כפול: '${id}'.`,
      });
      continue;
    }
    seen.add(id);
    out.push({ id, label });
  }
  return out;
}

interface ParticipantsHeaderInfo {
  columns: Map<number, ParsedHeader['kind']>;
  colCount: number;
}

function parseParticipantsHeader(
  ws: Worksheet,
  certs: CertificationDefinition[],
  pakals: PakalDefinition[],
  ctx: ParseContext,
): ParticipantsHeaderInfo {
  const headerRow = ws.getRow(1);
  const colCount = ws.actualColumnCount;
  const columns = new Map<number, ParsedHeader['kind']>();
  const seenCertIds = new Set<string>();
  const seenPakalIds = new Set<string>();
  // Build label→id reverse maps for matching column headers by Hebrew label.
  const certLabelToId = new Map(certs.map((c) => [normStrLowerCanonical(c.label), c.id]));
  const pakalLabelToId = new Map(pakals.map((p) => [normStrLowerCanonical(p.label), p.id]));
  // Also keep id sets for legacy bracket-format fallback.
  const certIdSet = new Set(certs.map((c) => c.id));
  const pakalIdSet = new Set(pakals.map((p) => p.id));
  const required = new Set<string>([
    HEADER_NAME,
    HEADER_GROUP,
    HEADER_LEVEL,
    HEADER_NOT_WITH,
    HEADER_PREFERRED,
    HEADER_LESS_PREFERRED,
  ]);
  const seenFixed = new Set<string>();

  for (let c = 1; c <= colCount; c++) {
    const cell = headerRow.getCell(c);
    if (isFormulaCell(cell)) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        cellRef: cell.address,
        message: `נוסחה אסורה בתא הכותרת ${cell.address}.`,
      });
      continue;
    }
    const raw = readCellString(cell);
    if (!raw) continue;

    // Fixed header match first.
    if (raw === HEADER_NAME) {
      columns.set(c, { type: 'name' });
      seenFixed.add(HEADER_NAME);
      continue;
    }
    if (raw === HEADER_GROUP) {
      columns.set(c, { type: 'group' });
      seenFixed.add(HEADER_GROUP);
      continue;
    }
    if (raw === HEADER_LEVEL) {
      columns.set(c, { type: 'level' });
      seenFixed.add(HEADER_LEVEL);
      continue;
    }
    if (raw === HEADER_NOT_WITH) {
      columns.set(c, { type: 'notWith' });
      seenFixed.add(HEADER_NOT_WITH);
      continue;
    }
    if (raw === HEADER_PREFERRED) {
      columns.set(c, { type: 'preferred' });
      seenFixed.add(HEADER_PREFERRED);
      continue;
    }
    if (raw === HEADER_LESS_PREFERRED) {
      columns.set(c, { type: 'lessPreferred' });
      seenFixed.add(HEADER_LESS_PREFERRED);
      continue;
    }

    // Dynamic (cert/pakal) header — match by Hebrew label against the catalog.
    // Also accept legacy bracket format `<label> [<id>]` for older exports.
    let resolvedId: string | undefined;
    let resolvedType: 'cert' | 'pakal' | undefined;

    // Check if header starts with the pakal prefix.
    const pakalPrefix = PAKAL_HEADER_PREFIX.trim();
    if (raw.startsWith(pakalPrefix)) {
      const label = normStrLowerCanonical(raw.slice(pakalPrefix.length));
      resolvedId = pakalLabelToId.get(label);
      resolvedType = 'pakal';
    }

    // Try cert label match (only if not already matched as pakal).
    if (!resolvedId) {
      resolvedId = certLabelToId.get(normStrLowerCanonical(raw));
      if (resolvedId) resolvedType = 'cert';
    }

    // Fallback: legacy `<label> [<id>]` bracket format.
    if (!resolvedId) {
      const m = HEADER_ID_REGEX.exec(raw);
      if (m) {
        const labelPart = m[1].trim();
        const bracketId = m[2].trim();
        if (labelPart.startsWith(pakalPrefix) && pakalIdSet.has(bracketId)) {
          resolvedId = bracketId;
          resolvedType = 'pakal';
        } else if (certIdSet.has(bracketId)) {
          resolvedId = bracketId;
          resolvedType = 'cert';
        }
      }
    }

    if (!resolvedId || !resolvedType) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        cellRef: cell.address,
        message: `כותרת לא מזוהה: '${raw}'.`,
      });
      continue;
    }

    const seenSet = resolvedType === 'pakal' ? seenPakalIds : seenCertIds;
    const typeLabel = resolvedType === 'pakal' ? 'פק"ל' : 'הסמכה';
    if (seenSet.has(resolvedId)) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        cellRef: cell.address,
        message: `עמודה כפולה עבור ${typeLabel} '${resolvedId}'.`,
      });
      continue;
    }
    seenSet.add(resolvedId);
    columns.set(c, { type: resolvedType, id: resolvedId });
  }

  for (const h of required) {
    if (!seenFixed.has(h)) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        message: `כותרת חובה חסרה: '${h}'.`,
      });
    }
  }

  return { columns, colCount };
}

interface ParsedParticipantRow {
  snapshot: ParticipantSnapshot;
  rowNumber: number;
  notWithRawTokens: string[];
}

function parseParticipantsRows(
  ws: Worksheet,
  header: ParticipantsHeaderInfo,
  ctx: ParseContext,
): ParsedParticipantRow[] {
  const out: ParsedParticipantRow[] = [];
  const nameMap = new Map<string, number>(); // lowercased → row number
  const rowCount = ws.actualRowCount;
  const limit = Math.min(rowCount, MAX_PARTICIPANT_ROWS + 1);
  if (rowCount - 1 > MAX_PARTICIPANT_ROWS) {
    pushError(ctx, {
      sheet: SHEET_PARTICIPANTS,
      message: `יותר מ-${MAX_PARTICIPANT_ROWS} שורות משתתפים.`,
    });
    return [];
  }

  // Find column by kind.
  const colByKind = new Map<string, number>();
  const certCols: Array<{ col: number; id: string }> = [];
  const pakalCols: Array<{ col: number; id: string }> = [];
  for (const [col, kind] of header.columns) {
    if (kind.type === 'cert') certCols.push({ col, id: kind.id });
    else if (kind.type === 'pakal') pakalCols.push({ col, id: kind.id });
    else colByKind.set(kind.type, col);
  }

  for (let r = 2; r <= limit; r++) {
    const row = ws.getRow(r);
    if (isEmptyRow(row, header.colCount)) continue;

    // Sanitation: any forbidden cell in this row kills the whole file.
    let sanOk = true;
    for (let c = 1; c <= header.colCount; c++) {
      const cell = row.getCell(c);
      if (isFormulaCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_PARTICIPANTS,
          cellRef: cell.address,
          message: `נוסחה אסורה בתא ${cell.address}.`,
        });
        sanOk = false;
      } else if (isHyperlinkCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_PARTICIPANTS,
          cellRef: cell.address,
          message: `קישור לא נתמך בתא ${cell.address}.`,
        });
        sanOk = false;
      } else if (isErrorCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_PARTICIPANTS,
          cellRef: cell.address,
          message: `שגיאת נוסחה בתא ${cell.address}.`,
        });
        sanOk = false;
      }
    }
    if (!sanOk) continue;

    const nameCol = colByKind.get('name')!;
    const groupCol = colByKind.get('group')!;
    const levelCol = colByKind.get('level')!;
    const notWithCol = colByKind.get('notWith')!;
    const prefCol = colByKind.get('preferred')!;
    const lessCol = colByKind.get('lessPreferred')!;

    const name = readCellString(row.getCell(nameCol));
    if (!name) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: שם משתתף חסר.`,
      });
      continue;
    }
    // Control-char check.
    if (/[\x00-\x1f]/.test(name)) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: שם משתתף מכיל תווי בקרה לא חוקיים.`,
      });
      continue;
    }
    const nameKey = name.toLowerCase();
    const prev = nameMap.get(nameKey);
    if (prev !== undefined) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: שם משתתף '${name}' חוזר בשורה ${prev}.`,
      });
      continue;
    }
    nameMap.set(nameKey, r);

    const group = readCellString(row.getCell(groupCol));
    if (!group) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: שם קבוצה חסר.`,
      });
      continue;
    }
    const groupCheck = validateGroupName(group, []);
    if (!groupCheck.valid) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: שם קבוצה לא מותר: '${group}' — ${groupCheck.error}`,
      });
      continue;
    }

    const levelRaw = readCellString(row.getCell(levelCol));
    const level = parseLevel(levelRaw);
    if (level === null) {
      pushError(ctx, {
        sheet: SHEET_PARTICIPANTS,
        rowNumber: r,
        message: `שורה ${r}: רמה לא תקינה: '${levelRaw}'. ערכים מותרים: L0, L2, L3, L4.`,
      });
      continue;
    }

    const certIds: string[] = [];
    for (const { col, id } of certCols) {
      if (coerceBoolean(row.getCell(col).value)) certIds.push(id);
    }
    const pakalIds: string[] = [];
    for (const { col, id } of pakalCols) {
      if (coerceBoolean(row.getCell(col).value)) pakalIds.push(id);
    }

    const notWithRaw = readCellString(row.getCell(notWithCol));
    const notWithRawTokens = notWithRaw
      ? notWithRaw
          .split(';')
          .map((t) => normStr(t))
          .filter((t) => t.length > 0)
      : [];
    // Dedupe within this row (silent).
    const seenTok = new Set<string>();
    const dedupedTokens: string[] = [];
    for (const t of notWithRawTokens) {
      const k = t.toLowerCase();
      if (!seenTok.has(k)) {
        seenTok.add(k);
        dedupedTokens.push(t);
      }
    }

    const preferredTaskName = readCellString(row.getCell(prefCol)) || undefined;
    const lessPreferredTaskName = readCellString(row.getCell(lessCol)) || undefined;

    out.push({
      snapshot: {
        name,
        level,
        certifications: certIds,
        group,
        dateUnavailability: [],
        notWithIds: [],
        pakalIds: pakalIds.length > 0 ? pakalIds : undefined,
        preferredTaskName,
        lessPreferredTaskName,
      },
      rowNumber: r,
      notWithRawTokens: dedupedTokens,
    });
  }

  return out;
}

function parseLevel(raw: string): Level | null {
  const t = normStr(raw).toUpperCase();
  switch (t) {
    case 'L0':
      return Level.L0;
    case 'L2':
      return Level.L2;
    case 'L3':
      return Level.L3;
    case 'L4':
      return Level.L4;
  }
  return null;
}

function parseUnavailabilityRows(ws: Worksheet, snapshots: ParsedParticipantRow[], ctx: ParseContext): void {
  const rowCount = ws.actualRowCount;
  if (rowCount - 1 > MAX_UNAVAILABILITY_ROWS) {
    pushError(ctx, {
      sheet: SHEET_UNAVAILABILITY,
      message: `יותר מ-${MAX_UNAVAILABILITY_ROWS} שורות אי-זמינות.`,
    });
    return;
  }
  const limit = Math.min(rowCount, MAX_UNAVAILABILITY_ROWS + 1);

  // Name → snapshot (case/NFC insensitive).
  const nameIndex = new Map<string, ParsedParticipantRow>();
  for (const s of snapshots) nameIndex.set(normStrLowerCanonical(s.snapshot.name), s);

  const ruleCountByParticipant = new Map<string, number>();

  for (let r = 2; r <= limit; r++) {
    const row = ws.getRow(r);
    if (isEmptyRow(row, 6)) continue;

    // Sanitation sweep.
    let sanOk = true;
    for (let c = 1; c <= 6; c++) {
      const cell = row.getCell(c);
      if (isFormulaCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_UNAVAILABILITY,
          cellRef: cell.address,
          message: `נוסחה אסורה בתא ${cell.address}.`,
        });
        sanOk = false;
      } else if (isHyperlinkCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_UNAVAILABILITY,
          cellRef: cell.address,
          message: `קישור לא נתמך בתא ${cell.address}.`,
        });
        sanOk = false;
      } else if (isErrorCell(cell)) {
        pushError(ctx, {
          sheet: SHEET_UNAVAILABILITY,
          cellRef: cell.address,
          message: `שגיאת נוסחה בתא ${cell.address}.`,
        });
        sanOk = false;
      }
    }
    if (!sanOk) continue;

    const pname = readCellString(row.getCell(1));
    if (!pname) {
      pushError(ctx, {
        sheet: SHEET_UNAVAILABILITY,
        rowNumber: r,
        message: `שורה ${r}: שם משתתף חסר.`,
      });
      continue;
    }
    const target = nameIndex.get(normStrLowerCanonical(pname));
    if (!target) {
      pushError(ctx, {
        sheet: SHEET_UNAVAILABILITY,
        rowNumber: r,
        message: `שורה ${r}: משתתף '${pname}' לא נמצא בגיליון ${SHEET_PARTICIPANTS}.`,
      });
      continue;
    }

    const dayRaw = readCellString(row.getCell(2));
    const dow = dayNameToIndex(dayRaw);
    if (dow === null) {
      pushError(ctx, {
        sheet: SHEET_UNAVAILABILITY,
        rowNumber: r,
        message: `שורה ${r}: יום לא תקין: '${dayRaw}'.`,
      });
      continue;
    }

    const allDay = coerceBoolean(row.getCell(3).value);
    let startHour = 0;
    let endHour = 0;
    if (!allDay) {
      const sh = coerceHour(row.getCell(4).value);
      const eh = coerceHour(row.getCell(5).value);
      if (sh === null || eh === null) {
        pushError(ctx, {
          sheet: SHEET_UNAVAILABILITY,
          rowNumber: r,
          message: `שורה ${r}: שעת התחלה/סיום חייבת להיות שלם בין 0 ל-23.`,
        });
        continue;
      }
      if (sh === eh) {
        pushError(ctx, {
          sheet: SHEET_UNAVAILABILITY,
          rowNumber: r,
          message: `שורה ${r}: שעת התחלה וסיום זהות — השתמש ב'כל היום'.`,
        });
        continue;
      }
      startHour = sh;
      endHour = eh;
    }
    const reason = readCellString(row.getCell(6)) || undefined;

    const rule: Omit<DateUnavailability, 'id'> = {
      dayOfWeek: dow,
      allDay,
      startHour,
      endHour,
      reason,
    };
    // Dedupe identical rules silently.
    const signature = `${dow}|${allDay}|${startHour}|${endHour}|${reason ?? ''}`;
    const existingForParticipant = target.snapshot.dateUnavailability.map(
      (x) => `${x.dayOfWeek}|${x.allDay}|${x.startHour}|${x.endHour}|${x.reason ?? ''}`,
    );
    if (existingForParticipant.includes(signature)) continue;

    target.snapshot.dateUnavailability.push(rule);
    const k = normStrLowerCanonical(target.snapshot.name);
    const n = (ruleCountByParticipant.get(k) ?? 0) + 1;
    ruleCountByParticipant.set(k, n);
    if (n > MAX_RULES_PER_PARTICIPANT) {
      pushError(ctx, {
        sheet: SHEET_UNAVAILABILITY,
        rowNumber: r,
        message: `שורה ${r}: יותר מ-${MAX_RULES_PER_PARTICIPANT} כללים למשתתף '${target.snapshot.name}'.`,
      });
    }
  }
}

function resolveNotWithReferences(snapshots: ParsedParticipantRow[], ctx: ParseContext): void {
  const byKey = new Map<string, ParsedParticipantRow>();
  for (const s of snapshots) byKey.set(normStrLowerCanonical(s.snapshot.name), s);

  for (const row of snapshots) {
    const resolved: string[] = [];
    for (const token of row.notWithRawTokens) {
      const k = normStrLowerCanonical(token);
      if (k === normStrLowerCanonical(row.snapshot.name)) {
        pushError(ctx, {
          sheet: SHEET_PARTICIPANTS,
          rowNumber: row.rowNumber,
          message: `שורה ${row.rowNumber}: משתתף '${row.snapshot.name}' מופיע ברשימת 'לא עם' של עצמו.`,
        });
        continue;
      }
      const hit = byKey.get(k);
      if (!hit) {
        pushError(ctx, {
          sheet: SHEET_PARTICIPANTS,
          rowNumber: row.rowNumber,
          message: `שורה ${row.rowNumber}: 'לא עם' מפנה לשם לא ידוע: '${token}'.`,
        });
        continue;
      }
      if (!resolved.includes(hit.snapshot.name)) resolved.push(hit.snapshot.name);
    }
    row.snapshot.notWithIds = resolved.length > 0 ? resolved : undefined;
  }
}
