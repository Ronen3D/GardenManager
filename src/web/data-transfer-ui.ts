/**
 * Data Transfer UI — rendering and event wiring for the export/import
 * accordion panel inside the settings tab.  Uses bottom sheets for
 * mobile-friendly multi-step flows.
 */

import type { ParticipantSet } from '../models/types';
import * as store from './config-store';
import * as transfer from './data-transfer';
import {
  generateParticipantSetXlsx,
  generateXlsxFilename,
  MAX_FILE_BYTES,
  parseParticipantSetXlsx,
  type XlsxImportError,
  type XlsxImportMeta,
} from './participant-set-xlsx';
import { escHtml } from './ui-helpers';
import { showAlert, showBottomSheet, showConfirm, showToast } from './ui-modal';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ─── Accordion Body ─────────────────────────────────────────────────────────

/** Returns the HTML for the accordion body content. */
export function renderDataTransferContent(): string {
  return `
    <div class="transfer-panel">
      <button class="transfer-action-btn" data-action="transfer-export">
        <span class="transfer-action-icon">📤</span>
        <span class="transfer-action-text">
          <span class="transfer-action-title">ייצוא נתונים</span>
          <span class="transfer-action-desc">שמור נתונים לקובץ לשיתוף</span>
        </span>
      </button>
      <button class="transfer-action-btn" data-action="transfer-import">
        <span class="transfer-action-icon">📥</span>
        <span class="transfer-action-text">
          <span class="transfer-action-title">ייבוא נתונים</span>
          <span class="transfer-action-desc">טען נתונים מקובץ שהתקבל</span>
        </span>
      </button>
      <button class="transfer-action-btn" data-action="transfer-import-xlsx">
        <span class="transfer-action-icon">📊</span>
        <span class="transfer-action-text">
          <span class="transfer-action-title">ייבוא סט משתתפים מ-Excel</span>
          <span class="transfer-action-desc">טען סט משתתפים מקובץ .xlsx</span>
        </span>
      </button>
    </div>`;
}

// ─── Event Wiring ───────────────────────────────────────────────────────────

/** Wire click handlers for the export/import buttons. */
export function wireDataTransferEvents(container: HTMLElement): void {
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'transfer-export') openExportSheet();
    if (action === 'transfer-import') openImportFlow();
    if (action === 'transfer-import-xlsx') openXlsxImportFlow();
  });
}

// ─── Export Flow ────────────────────────────────────────────────────────────

function openExportSheet(): void {
  const taskSets = store.getAllTaskSets();
  const participantSets = store.getAllParticipantSets();
  const snapshots = store.getAllSnapshots();

  const html = `
    <div class="transfer-scope-list">
      <button class="transfer-scope-item" data-export-type="algorithm">
        <span class="transfer-scope-icon">⚙</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">הגדרות אלגוריתם</span>
          <span class="transfer-scope-desc">הגדרות נוכחיות + פריסטים שמורים</span>
        </span>
      </button>
      <button class="transfer-scope-item" data-export-type="taskSet" ${taskSets.length === 0 ? 'disabled' : ''}>
        <span class="transfer-scope-icon">📋</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">סט משימות</span>
          <span class="transfer-scope-desc">${taskSets.length === 0 ? '(אין סטים שמורים)' : `${taskSets.length} סטים זמינים`}</span>
        </span>
      </button>
      <button class="transfer-scope-item" data-export-type="participantSet" ${participantSets.length === 0 ? 'disabled' : ''}>
        <span class="transfer-scope-icon">👥</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">סט משתתפים</span>
          <span class="transfer-scope-desc">${participantSets.length === 0 ? '(אין סטים שמורים)' : `${participantSets.length} סטים זמינים`}</span>
        </span>
      </button>
      <button class="transfer-scope-item" data-export-type="scheduleSnapshot" ${snapshots.length === 0 ? 'disabled' : ''}>
        <span class="transfer-scope-icon">📊</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">שבצ"ק (תמונת מצב)</span>
          <span class="transfer-scope-desc">${snapshots.length === 0 ? '(אין תמונות מצב שמורות)' : `${snapshots.length} תמונות זמינות`}</span>
        </span>
      </button>
      <button class="transfer-scope-item transfer-scope-item--full" data-export-type="fullBackup">
        <span class="transfer-scope-icon">💾</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">הכל (גיבוי מלא)</span>
          <span class="transfer-scope-desc">כל הנתונים במערכת לקובץ אחד</span>
        </span>
      </button>
    </div>`;

  const sheet = showBottomSheet(html, { title: '📤 ייצוא — מה לייצא?' });

  // Delegate clicks inside the bottom sheet
  sheet.el.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-export-type]');
    if (!item || item.hasAttribute('disabled')) return;
    const type = item.dataset.exportType!;

    switch (type) {
      case 'algorithm':
        await handleExportAlgorithm();
        sheet.close();
        break;
      case 'taskSet':
        if (taskSets.length === 1) {
          await handleExportTaskSet(taskSets[0].id, taskSets[0].name);
          sheet.close();
        } else {
          sheet.close();
          openSetPicker(
            'taskSet',
            taskSets.map((s) => ({ id: s.id, name: s.name, desc: `${s.templates.length} תבניות` })),
          );
        }
        break;
      case 'participantSet':
        if (participantSets.length === 1) {
          sheet.close();
          openParticipantSetFormatSheet(participantSets[0].id, participantSets[0].name);
        } else {
          sheet.close();
          openSetPicker(
            'participantSet',
            participantSets.map((s) => ({ id: s.id, name: s.name, desc: `${s.participants.length} משתתפים` })),
          );
        }
        break;
      case 'scheduleSnapshot':
        if (snapshots.length === 1) {
          await handleExportSnapshot(snapshots[0].id, snapshots[0].name);
          sheet.close();
        } else {
          sheet.close();
          openSetPicker(
            'scheduleSnapshot',
            snapshots.map((s) => ({
              id: s.id,
              name: s.name,
              desc: `${s.schedule.tasks.length} משימות, ${s.schedule.participants.length} משתתפים`,
            })),
          );
        }
        break;
      case 'fullBackup':
        sheet.close();
        await handleExportFullBackup();
        break;
    }
  });
}

interface PickerItem {
  id: string;
  name: string;
  desc: string;
}

function openSetPicker(type: 'taskSet' | 'participantSet' | 'scheduleSnapshot', items: PickerItem[]): void {
  const typeLabel = type === 'taskSet' ? 'סט משימות' : type === 'participantSet' ? 'סט משתתפים' : 'תמונת מצב';

  const html = `
    <div class="transfer-scope-list">
      ${items
        .map(
          (item) => `
        <button class="transfer-scope-item" data-picker-id="${escHtml(item.id)}">
          <span class="transfer-scope-text">
            <span class="transfer-scope-title">${escHtml(item.name)}</span>
            <span class="transfer-scope-desc">${escHtml(item.desc)}</span>
          </span>
        </button>`,
        )
        .join('')}
    </div>`;

  const sheet = showBottomSheet(html, { title: `📤 בחר ${typeLabel} לייצוא` });

  sheet.el.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-picker-id]');
    if (!item) return;
    const id = item.dataset.pickerId!;
    const name = items.find((i) => i.id === id)?.name ?? '';

    switch (type) {
      case 'taskSet':
        await handleExportTaskSet(id, name);
        break;
      case 'participantSet':
        sheet.close();
        openParticipantSetFormatSheet(id, name);
        return;
      case 'scheduleSnapshot':
        await handleExportSnapshot(id, name);
        break;
    }
    sheet.close();
  });
}

async function handleExportAlgorithm(): Promise<void> {
  const content = transfer.exportAlgorithmSettings();
  const filename = transfer.generateExportFilename('algorithm');
  await transfer.triggerShareOrDownload(content, filename);
  showToast('הגדרות אלגוריתם יוצאו בהצלחה', { type: 'success' });
}

async function handleExportTaskSet(id: string, name: string): Promise<void> {
  const content = transfer.exportTaskSet(id);
  if (!content) {
    await showAlert('סט המשימות לא נמצא.');
    return;
  }
  const filename = transfer.generateExportFilename('taskSet', name);
  await transfer.triggerShareOrDownload(content, filename);
  showToast('סט המשימות יוצא בהצלחה', { type: 'success' });
}

async function handleExportParticipantSet(id: string, name: string): Promise<void> {
  const content = transfer.exportParticipantSet(id);
  if (!content) {
    await showAlert('סט המשתתפים לא נמצא.');
    return;
  }
  const filename = transfer.generateExportFilename('participantSet', name);
  await transfer.triggerShareOrDownload(content, filename);
  showToast('סט המשתתפים יוצא בהצלחה', { type: 'success' });
}

// ─── Participant set — format sub-sheet (JSON / xlsx / template) ───────────

/**
 * Opens the "export format" sub-sheet (JSON / xlsx / template) for a saved
 * participant set. Exported so the Participants tab can trigger it directly
 * from the sets panel.
 */
export function openParticipantSetFormatSheet(id: string, name: string): void {
  const html = `
    <div class="transfer-scope-list">
      <button class="transfer-scope-item" data-format="json">
        <span class="transfer-scope-icon">📄</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">JSON (.gm.json)</span>
          <span class="transfer-scope-desc">פורמט ייצוא/ייבוא רגיל בין מכשירים</span>
        </span>
      </button>
      <button class="transfer-scope-item" data-format="xlsx">
        <span class="transfer-scope-icon">📊</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">Excel (.xlsx)</span>
          <span class="transfer-scope-desc">קובץ גיליון אלקטרוני לעריכה ידנית</span>
        </span>
      </button>
      <button class="transfer-scope-item" data-format="xlsx-template">
        <span class="transfer-scope-icon">📄</span>
        <span class="transfer-scope-text">
          <span class="transfer-scope-title">תבנית Excel ריקה</span>
          <span class="transfer-scope-desc">קובץ ריק עם הקטלוגים הנוכחיים</span>
        </span>
      </button>
    </div>`;
  const sheet = showBottomSheet(html, { title: `📤 '${name}' — בחר פורמט` });
  sheet.el.addEventListener('click', async (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-format]');
    if (!item) return;
    const format = item.dataset.format!;
    sheet.close();
    if (format === 'json') {
      await handleExportParticipantSet(id, name);
    } else if (format === 'xlsx') {
      await handleExportParticipantSetXlsx(id, name);
    } else if (format === 'xlsx-template') {
      await handleDownloadXlsxTemplate();
    }
  });
}

async function handleExportParticipantSetXlsx(id: string, name: string): Promise<void> {
  const pset = store.getParticipantSetById(id);
  if (!pset) {
    await showAlert('סט המשתתפים לא נמצא.');
    return;
  }
  try {
    const blob = await generateParticipantSetXlsx(pset);
    await transfer.triggerShareOrDownload(blob, generateXlsxFilename(name), XLSX_MIME);
    showToast('סט המשתתפים יוצא ל-Excel', { type: 'success' });
  } catch (err) {
    await showAlert(`ייצוא Excel נכשל: ${err instanceof Error ? err.message : String(err)}`, {
      title: 'שגיאת ייצוא',
      icon: '❌',
    });
  }
}

async function handleDownloadXlsxTemplate(): Promise<void> {
  // Build a minimal set that carries only the current catalogs.
  const templatePset: ParticipantSet = {
    id: 'template',
    name: '',
    description: '',
    participants: [],
    certificationCatalog: store.getCertificationDefinitions(),
    pakalCatalog: store.getPakalDefinitions(),
    createdAt: Date.now(),
  };
  try {
    const blob = await generateParticipantSetXlsx(templatePset, { templateMode: true });
    await transfer.triggerShareOrDownload(blob, generateXlsxFilename('template'), XLSX_MIME);
    showToast('תבנית Excel הורדה', { type: 'success' });
  } catch (err) {
    await showAlert(`הורדת תבנית נכשלה: ${err instanceof Error ? err.message : String(err)}`, {
      title: 'שגיאת תבנית',
      icon: '❌',
    });
  }
}

async function handleExportSnapshot(id: string, name: string): Promise<void> {
  const content = transfer.exportScheduleSnapshot(id);
  if (!content) {
    await showAlert('תמונת המצב לא נמצאה.');
    return;
  }
  const filename = transfer.generateExportFilename('scheduleSnapshot', name);
  await transfer.triggerShareOrDownload(content, filename);
  showToast('שבצ"ק יוצא בהצלחה', { type: 'success' });
}

async function handleExportFullBackup(): Promise<void> {
  const confirmed = await showConfirm('פעולה זו תייצא את כל הנתונים במערכת לקובץ אחד. להמשיך?', {
    title: 'גיבוי מלא',
    confirmLabel: 'ייצא הכל',
  });
  if (!confirmed) return;
  const content = transfer.exportFullBackup();
  const filename = transfer.generateExportFilename('fullBackup');
  await transfer.triggerShareOrDownload(content, filename);
  showToast('גיבוי מלא יוצא בהצלחה', { type: 'success' });
}

// ─── Import Flow ────────────────────────────────────────────────────────────

async function openImportFlow(): Promise<void> {
  const json = await transfer.openFilePicker();
  if (!json) return; // user cancelled

  const validation = transfer.validateImportFile(json);
  if (!validation.ok) {
    await showAlert(validation.error!, { title: 'שגיאת ייבוא', icon: '❌' });
    return;
  }

  switch (validation.exportType) {
    case 'algorithm':
      openAlgorithmImportSheet(json, validation.summary!);
      break;
    case 'taskSet':
      openSetImportSheet('taskSet', json, validation.summary!);
      break;
    case 'participantSet':
      openSetImportSheet('participantSet', json, validation.summary!);
      break;
    case 'scheduleSnapshot':
      openSnapshotImportSheet(json, validation.summary!);
      break;
    case 'fullBackup':
      await handleFullBackupImport(json);
      break;
  }
}

function openAlgorithmImportSheet(json: string, summary: string): void {
  const html = `
    <div class="transfer-import-summary">${escHtml(summary)}</div>
    <div class="transfer-import-options">
      <button class="transfer-import-option" data-import-mode="replace">
        <span class="transfer-import-option-icon">🔄</span>
        <span class="transfer-import-option-text">
          <span class="transfer-import-option-title">החלף הגדרות נוכחיות</span>
          <span class="transfer-import-option-desc">כל ההגדרות והפריסטים יוחלפו</span>
        </span>
      </button>
      <button class="transfer-import-option" data-import-mode="add-preset">
        <span class="transfer-import-option-icon">➕</span>
        <span class="transfer-import-option-text">
          <span class="transfer-import-option-title">הוסף כפריסט חדש</span>
          <span class="transfer-import-option-desc">ההגדרות ישמרו כפריסט נוסף</span>
        </span>
      </button>
    </div>`;

  const sheet = showBottomSheet(html, { title: '📥 ייבוא הגדרות אלגוריתם' });

  sheet.el.addEventListener('click', async (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-import-mode]');
    if (!opt) return;
    const mode = opt.dataset.importMode as 'replace' | 'add-preset';
    sheet.close();
    const result = transfer.importAlgorithm(json, mode);
    if (result.ok) {
      showToast('הגדרות אלגוריתם יובאו בהצלחה', { type: 'success' });
    } else {
      await showAlert(result.error!, { title: 'שגיאת ייבוא', icon: '❌' });
    }
  });
}

function openSetImportSheet(type: 'taskSet' | 'participantSet', json: string, summary: string): void {
  const typeLabel = type === 'taskSet' ? 'סט משימות' : 'סט משתתפים';
  const existingSets =
    type === 'taskSet'
      ? store.getAllTaskSets().filter((s) => !s.builtIn)
      : store.getAllParticipantSets().filter((s) => !s.builtIn);

  let replaceHtml = '';
  if (existingSets.length > 0) {
    replaceHtml = `
      <div class="transfer-replace-section">
        <div class="transfer-replace-label">🔄 החלף סט קיים:</div>
        <div class="transfer-replace-list">
          ${existingSets
            .map(
              (s) => `
            <button class="transfer-replace-item" data-replace-id="${escHtml(s.id)}">
              ${escHtml(s.name)}
            </button>`,
            )
            .join('')}
        </div>
      </div>`;
  }

  const html = `
    <div class="transfer-import-summary">${escHtml(summary)}</div>
    <div class="transfer-import-options">
      <button class="transfer-import-option" data-import-mode="add-new">
        <span class="transfer-import-option-icon">➕</span>
        <span class="transfer-import-option-text">
          <span class="transfer-import-option-title">הוסף כסט חדש</span>
        </span>
      </button>
    </div>
    ${replaceHtml}`;

  const sheet = showBottomSheet(html, { title: `📥 ייבוא ${typeLabel}` });

  sheet.el.addEventListener('click', async (e) => {
    // "Add new" button
    const addBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-import-mode="add-new"]');
    if (addBtn) {
      sheet.close();
      const result =
        type === 'taskSet' ? transfer.importTaskSet(json, 'add-new') : transfer.importParticipantSet(json, 'add-new');
      if (result.ok) {
        showToast(`${typeLabel} יובא בהצלחה`, { type: 'success' });
      } else {
        await showAlert(result.error!, { title: 'שגיאת ייבוא', icon: '❌' });
      }
      return;
    }

    // "Replace" item
    const replaceBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-replace-id]');
    if (replaceBtn) {
      const replaceId = replaceBtn.dataset.replaceId!;
      const replaceName = replaceBtn.textContent?.trim() ?? '';
      sheet.close();
      const confirmed = await showConfirm(`הסט '${replaceName}' יוחלף לחלוטין בנתונים מהקובץ. להמשיך?`, {
        title: 'החלפת סט',
        danger: true,
        confirmLabel: 'החלף',
      });
      if (!confirmed) return;
      const result =
        type === 'taskSet'
          ? transfer.importTaskSet(json, 'replace', replaceId)
          : transfer.importParticipantSet(json, 'replace', replaceId);
      if (result.ok) {
        showToast(`${typeLabel} הוחלף בהצלחה`, { type: 'success' });
      } else {
        await showAlert(result.error!, { title: 'שגיאת ייבוא', icon: '❌' });
      }
    }
  });
}

function openSnapshotImportSheet(json: string, summary: string): void {
  const html = `
    <div class="transfer-import-summary">${escHtml(summary)}</div>
    <div class="transfer-import-options">
      <button class="transfer-import-option" data-import-mode="add">
        <span class="transfer-import-option-icon">📊</span>
        <span class="transfer-import-option-text">
          <span class="transfer-import-option-title">ייבא כתמונת מצב חדשה</span>
        </span>
      </button>
    </div>`;

  const sheet = showBottomSheet(html, { title: '📥 ייבוא שבצ"ק' });

  sheet.el.addEventListener('click', async (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('[data-import-mode]');
    if (!opt) return;
    sheet.close();
    const result = transfer.importScheduleSnapshot(json);
    if (result.ok) {
      showToast('שבצ"ק יובא בהצלחה', { type: 'success' });
    } else {
      await showAlert(result.error!, { title: 'שגיאת ייבוא', icon: '❌' });
    }
  });
}

// ─── xlsx import flow ──────────────────────────────────────────────────────

/**
 * Entry point for the xlsx import flow. Exported so the Participants tab can
 * trigger it directly from the sets panel. The optional `onComplete` callback
 * is invoked after a successful import and can be used by the caller to
 * refresh its UI.
 */
export async function openXlsxImportFlow(onComplete?: () => void): Promise<void> {
  const picked = await transfer.openBinaryFilePicker('.xlsx');
  if (!picked) return;
  if (!picked.name.toLowerCase().endsWith('.xlsx')) {
    await showAlert('רק קבצי .xlsx נתמכים. קבצי .xls או .xlsm נדחים.', {
      title: 'שגיאת ייבוא',
      icon: '❌',
    });
    return;
  }
  if (picked.buffer.byteLength > MAX_FILE_BYTES) {
    await showAlert(`הקובץ גדול מ-${MAX_FILE_BYTES / 1024 / 1024}MB ונדחה.`, {
      title: 'שגיאת ייבוא',
      icon: '❌',
    });
    return;
  }

  let result: Awaited<ReturnType<typeof parseParticipantSetXlsx>>;
  try {
    result = await parseParticipantSetXlsx(picked.buffer);
  } catch (err) {
    await showAlert(`קריאת הקובץ נכשלה: ${err instanceof Error ? err.message : String(err)}`, {
      title: 'שגיאת ייבוא',
      icon: '❌',
    });
    return;
  }

  if (!result.ok) {
    openXlsxImportErrorSheet(result.errors);
    return;
  }

  openXlsxImportPreviewSheet(result.pset, result.meta, onComplete);
}

function openXlsxImportErrorSheet(errors: XlsxImportError[]): void {
  const items = errors
    .map((e) => {
      const locParts: string[] = [escHtml(e.sheet)];
      if (e.cellRef) locParts.push(escHtml(e.cellRef));
      else if (e.rowNumber !== undefined) locParts.push(`שורה ${e.rowNumber}`);
      return `<li><span class="xlsx-err-loc">${locParts.join(' · ')}</span> — ${escHtml(e.message)}</li>`;
    })
    .join('');
  const html = `
    <div class="xlsx-error-list">
      <p class="xlsx-error-intro">נמצאו ${errors.length} שגיאות. תקן את הקובץ וייבא שוב:</p>
      <ol class="xlsx-error-items">${items}</ol>
    </div>`;
  showBottomSheet(html, { title: '📊 שגיאות בייבוא Excel' });
}

function openXlsxImportPreviewSheet(pset: ParticipantSet, meta: XlsxImportMeta, onComplete?: () => void): void {
  const existingSets = store.getAllParticipantSets().filter((s) => !s.builtIn);
  const atCap = store.getAllParticipantSets().length >= 30;

  const newCertsHtml =
    meta.newCertsForApp.length > 0
      ? `<div class="xlsx-preview-row">הסמכות בקובץ: ${meta.newCertsForApp.map((c) => escHtml(c.label)).join(', ')}</div>`
      : '';
  const newPakalsHtml =
    meta.newPakalsForApp.length > 0
      ? `<div class="xlsx-preview-row">פק"לים בקובץ: ${meta.newPakalsForApp.map((p) => escHtml(p.label)).join(', ')}</div>`
      : '';

  const replaceHtml =
    existingSets.length > 0
      ? `<div class="transfer-replace-section">
         <div class="transfer-replace-label">🔄 החלף סט קיים:</div>
         <div class="transfer-replace-list">
           ${existingSets
             .map(
               (s) =>
                 `<button class="transfer-replace-item" data-replace-id="${escHtml(s.id)}">${escHtml(s.name)}</button>`,
             )
             .join('')}
         </div>
       </div>`
      : '';

  const html = `
    <div class="transfer-import-summary">
      <div class="xlsx-preview-row"><strong>${escHtml(meta.name)}</strong></div>
      ${meta.description ? `<div class="xlsx-preview-row">${escHtml(meta.description)}</div>` : ''}
      <div class="xlsx-preview-row">${meta.participantCount} משתתפים · ${meta.rulesCount} כללי אי-זמינות</div>
      ${newCertsHtml}
      ${newPakalsHtml}
    </div>
    <div class="transfer-import-options">
      <button class="transfer-import-option" data-import-mode="add-new" ${atCap ? 'disabled title="הגעת למגבלת 30 סטים"' : ''}>
        <span class="transfer-import-option-icon">➕</span>
        <span class="transfer-import-option-text">
          <span class="transfer-import-option-title">הוסף כסט חדש</span>
        </span>
      </button>
    </div>
    ${replaceHtml}`;
  const sheet = showBottomSheet(html, { title: '📊 אישור ייבוא Excel' });
  sheet.el.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    const addBtn = target.closest<HTMLElement>('[data-import-mode="add-new"]');
    if (addBtn && !addBtn.hasAttribute('disabled')) {
      sheet.close();
      commitXlsxImport(pset, 'add-new', undefined, onComplete);
      return;
    }

    const replaceBtn = target.closest<HTMLElement>('[data-replace-id]');
    if (replaceBtn) {
      const replaceId = replaceBtn.dataset.replaceId!;
      const replaceName = replaceBtn.textContent?.trim() ?? '';
      sheet.close();
      const confirmed = await showConfirm(
        `הסט '${replaceName}' יוחלף לחלוטין בנתונים מהקובץ. פעולה זו לא ניתנת לביטול.`,
        { title: 'החלפת סט', danger: true, confirmLabel: 'החלף' },
      );
      if (!confirmed) return;
      commitXlsxImport(pset, 'replace', replaceId, onComplete);
    }
  });
}

function commitXlsxImport(
  pset: ParticipantSet,
  mode: 'add-new' | 'replace',
  replaceId: string | undefined,
  onComplete: (() => void) | undefined,
): void {
  // Merge any new cert/pakal definitions into the app catalog.
  if (pset.certificationCatalog.length > 0) {
    store.ensureCertificationDefinitions(pset.certificationCatalog);
  }
  if (pset.pakalCatalog && pset.pakalCatalog.length > 0) {
    store.ensurePakalDefinitions(pset.pakalCatalog);
  }
  const result = transfer.importParticipantSetFromObject(pset, mode, replaceId);
  if (result.ok) {
    showToast('סט המשתתפים יובא בהצלחה', { type: 'success' });
    onComplete?.();
  } else {
    void showAlert(result.error ?? 'שמירה נכשלה.', { title: 'שגיאת ייבוא', icon: '❌' });
  }
}

async function handleFullBackupImport(json: string): Promise<void> {
  const confirmed = await showConfirm(
    'פעולה זו תמחק את כל הנתונים הקיימים במערכת ותחליף אותם בנתונים מהקובץ. לא ניתן לבטל פעולה זו!',
    { title: 'ייבוא גיבוי מלא', danger: true, confirmLabel: 'כן, החלף הכל' },
  );
  if (!confirmed) return;
  const result = transfer.importFullBackup(json);
  if (!result.ok) {
    await showAlert(result.error!, { title: 'שגיאת ייבוא', icon: '❌' });
  }
  // On success: importFullBackup triggers location.reload()
}
