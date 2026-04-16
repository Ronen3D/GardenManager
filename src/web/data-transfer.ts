/**
 * Data Transfer — core export / import logic for offline device-to-device
 * data migration.  Produces and consumes `.gm.json` files with a unified
 * envelope format.
 */

import {
  type AlgorithmExportPayload,
  type AlgorithmPreset,
  type ExportType,
  type FullBackupPayload,
  type GardenManagerExport,
  type ImportResult,
  type ImportValidationResult,
  type ParticipantSet,
  type ParticipantSetExportPayload,
  type ScheduleSnapshot,
  type ScheduleSnapshotExportPayload,
  type TaskSet,
  type TaskSetExportPayload,
} from '../models/types';
import * as store from './config-store';
import {
  validateAlgorithmPayload,
  validateFullBackupPayload,
  validateParticipantSetPayload,
  validateScheduleSnapshotPayload,
  validateTaskSetPayload,
} from './import-validators';

// ─── Envelope Helpers ───────────────────────────────────────────────────────

function buildEnvelope(exportType: ExportType, payload: GardenManagerExport['payload']): GardenManagerExport {
  return {
    _format: 'gardenmanager-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportType,
    payload,
  };
}

export function sanitizeName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function generateExportFilename(type: ExportType, name?: string, extension?: string): string {
  const typeMap: Record<ExportType, string> = {
    algorithm: 'algorithm',
    taskSet: 'tasks',
    participantSet: 'participants',
    scheduleSnapshot: 'schedule',
    fullBackup: 'backup',
  };
  const parts = ['gm', typeMap[type]];
  if (name) parts.push(sanitizeName(name));
  parts.push(dateStamp());
  const ext = extension ?? '.gm.json';
  return parts.join('-') + ext;
}

// ─── Export Functions ───────────────────────────────────────────────────────

export function exportAlgorithmSettings(): string {
  const payload: AlgorithmExportPayload = {
    currentSettings: store.getAlgorithmSettings(),
    presets: store.getAllPresets(),
    activePresetId: store.getActivePresetId(),
  };
  return store.jsonSerialize(buildEnvelope('algorithm', payload));
}

export function exportTaskSet(taskSetId: string): string | null {
  const tset = store.getTaskSetById(taskSetId);
  if (!tset) return null;
  const payload: TaskSetExportPayload = { taskSet: tset };
  return store.jsonSerialize(buildEnvelope('taskSet', payload));
}

export function exportParticipantSet(participantSetId: string): string | null {
  const pset = store.getParticipantSetById(participantSetId);
  if (!pset) return null;
  const payload: ParticipantSetExportPayload = { participantSet: pset };
  return store.jsonSerialize(buildEnvelope('participantSet', payload));
}

export function exportScheduleSnapshot(snapshotId: string): string | null {
  const snap = store.getSnapshotById(snapshotId);
  if (!snap) return null;

  // Collect all referenced cert/pakal IDs from the schedule
  const certIds = new Set<string>();
  const pakalIds = new Set<string>();

  for (const task of snap.schedule.tasks) {
    for (const slot of task.slots) {
      for (const cId of slot.requiredCertifications) certIds.add(cId);
      if (slot.forbiddenCertifications) {
        for (const cId of slot.forbiddenCertifications) certIds.add(cId);
      }
    }
  }
  for (const p of snap.schedule.participants) {
    for (const cId of p.certifications) certIds.add(cId);
    if (p.pakalIds) {
      for (const pId of p.pakalIds) pakalIds.add(pId);
    }
  }

  // Fetch matching definitions from the app catalog
  const allCerts = store.getCertificationDefinitions();
  const allPakals = store.getPakalDefinitions();
  const certCatalog = allCerts.filter((d) => certIds.has(d.id));
  const pakalCatalog = allPakals.filter((d) => pakalIds.has(d.id));

  const payload: ScheduleSnapshotExportPayload = {
    snapshot: snap,
    certificationCatalog: certCatalog,
    pakalCatalog: pakalCatalog,
  };
  return store.jsonSerialize(buildEnvelope('scheduleSnapshot', payload));
}

export function exportFullBackup(): string {
  store.flushPendingSave();
  const keys = store.getAllStorageKeys();
  const entries: Record<string, string> = {};
  for (const key of keys) {
    const val = localStorage.getItem(key);
    if (val !== null) entries[key] = val;
  }
  const payload: FullBackupPayload = { storageEntries: entries };
  // Use plain JSON.stringify — values are already raw JSON strings
  return JSON.stringify(buildEnvelope('fullBackup', payload));
}

// ─── File I/O ───────────────────────────────────────────────────────────────

export async function triggerShareOrDownload(
  content: string | Blob,
  filename: string,
  mimeType?: string,
): Promise<void> {
  const isBlob = typeof Blob !== 'undefined' && content instanceof Blob;
  const fileMime = mimeType ?? (isBlob ? (content as Blob).type || 'application/octet-stream' : 'application/json');
  const blobMime = mimeType ?? (isBlob ? fileMime : 'application/json;charset=utf-8');
  const file = isBlob
    ? new File([content as Blob], filename, { type: fileMime })
    : new File([content as string], filename, { type: fileMime });
  if (typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch {
      // User cancelled or share failed — fall through to download
    }
  }
  // Fallback: blob download
  const blob = isBlob ? (content as Blob) : new Blob([content as string], { type: blobMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function openBinaryFilePicker(accept: string): Promise<{ name: string; buffer: ArrayBuffer } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let resolved = false;
    const cleanup = () => input.remove();
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolved = true;
        cleanup();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolved = true;
        cleanup();
        resolve({ name: file.name, buffer: reader.result as ArrayBuffer });
      };
      reader.onerror = () => {
        resolved = true;
        cleanup();
        resolve(null);
      };
      reader.readAsArrayBuffer(file);
    };
    window.addEventListener(
      'focus',
      function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(null);
          }
        }, 500);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

export function openFilePicker(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.gm.json,application/json';
    let resolved = false;
    const cleanup = () => input.remove();
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolved = true;
        cleanup();
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        resolved = true;
        cleanup();
        resolve(reader.result as string);
      };
      reader.onerror = () => {
        resolved = true;
        cleanup();
        resolve(null);
      };
      reader.readAsText(file);
    };
    // Detect cancellation via focus return
    window.addEventListener(
      'focus',
      function onFocus() {
        window.removeEventListener('focus', onFocus);
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(null);
          }
        }, 500);
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateImportFile(json: string): ImportValidationResult {
  let raw: unknown;
  try {
    raw = store.jsonDeserialize(json);
  } catch {
    // Try plain JSON.parse for fullBackup files
    try {
      raw = JSON.parse(json);
    } catch {
      return { ok: false, error: 'JSON לא תקין — בדוק את הפורמט.' };
    }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'הנתון חייב להיות אובייקט JSON.' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj._format !== 'gardenmanager-export') {
    return { ok: false, error: 'הקובץ אינו קובץ ייצוא של גינה מנהלת.' };
  }

  if (obj.schemaVersion !== 1) {
    return { ok: false, error: `גרסת סכמה לא נתמכת: ${obj.schemaVersion ?? 'חסר'}.` };
  }

  const validTypes: ExportType[] = ['algorithm', 'taskSet', 'participantSet', 'scheduleSnapshot', 'fullBackup'];
  if (!validTypes.includes(obj.exportType as ExportType)) {
    return { ok: false, error: `סוג ייצוא לא מוכר: ${String(obj.exportType)}.` };
  }

  const exportType = obj.exportType as ExportType;
  const payload = obj.payload as Record<string, unknown>;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'שדה "payload" חסר או לא תקין.' };
  }

  // Type-specific shallow validation + summary
  let summary = '';
  switch (exportType) {
    case 'algorithm': {
      const deepErr = validateAlgorithmPayload(payload);
      if (deepErr) return { ok: false, error: deepErr };
      const p = payload as Partial<AlgorithmExportPayload>;
      const presetCount = Array.isArray(p.presets) ? p.presets.length : 0;
      summary = `הגדרות אלגוריתם + ${presetCount} סטים`;
      break;
    }
    case 'taskSet': {
      const deepErr = validateTaskSetPayload(payload);
      if (deepErr) return { ok: false, error: deepErr };
      const p = payload as Partial<TaskSetExportPayload>;
      const ts = p.taskSet as Partial<TaskSet>;
      const tplCount = Array.isArray(ts.templates) ? ts.templates.length : 0;
      const otCount = Array.isArray(ts.oneTimeTasks) ? ts.oneTimeTasks.length : 0;
      summary = `סט משימות: '${ts.name ?? ''}' — ${tplCount} תבניות, ${otCount} חד-פעמיות`;
      break;
    }
    case 'participantSet': {
      const deepErr = validateParticipantSetPayload(payload);
      if (deepErr) return { ok: false, error: deepErr };
      const p = payload as Partial<ParticipantSetExportPayload>;
      const ps = p.participantSet as Partial<ParticipantSet>;
      const count = Array.isArray(ps.participants) ? ps.participants.length : 0;
      const certCount = Array.isArray(ps.certificationCatalog) ? ps.certificationCatalog.length : 0;
      summary = `סט משתתפים: '${ps.name ?? ''}' — ${count} משתתפים, ${certCount} הסמכות`;
      break;
    }
    case 'scheduleSnapshot': {
      const deepErr = validateScheduleSnapshotPayload(payload);
      if (deepErr) return { ok: false, error: deepErr };
      const p = payload as Partial<ScheduleSnapshotExportPayload>;
      const s = p.snapshot as Partial<ScheduleSnapshot>;
      const sched = s.schedule as Record<string, unknown> | undefined;
      const taskCount = Array.isArray(sched?.tasks) ? (sched.tasks as unknown[]).length : 0;
      const partCount = Array.isArray(sched?.participants) ? (sched.participants as unknown[]).length : 0;
      summary = `שבצ"ק: '${s.name ?? ''}' — ${taskCount} משימות, ${partCount} משתתפים`;
      break;
    }
    case 'fullBackup': {
      const deepErr = validateFullBackupPayload(payload);
      if (deepErr) return { ok: false, error: deepErr };
      const p = payload as Partial<FullBackupPayload>;
      const keyCount = Object.keys(p.storageEntries ?? {}).length;
      summary = `גיבוי מלא — ${keyCount} רשומות`;
      break;
    }
  }

  return { ok: true, exportType, summary };
}

// ─── Import Functions ───────────────────────────────────────────────────────

function parseEnvelope(json: string): GardenManagerExport {
  // Try jsonDeserialize first (handles __date__ markers), fall back to plain parse
  try {
    return store.jsonDeserialize<GardenManagerExport>(json);
  } catch {
    return JSON.parse(json) as GardenManagerExport;
  }
}

function deduplicateName(name: string, existingNames: string[]): string {
  const lowerNames = existingNames.map((n) => n.toLowerCase());
  if (!lowerNames.includes(name.toLowerCase())) return name;
  let i = 2;
  while (lowerNames.includes(`${name} (${i})`.toLowerCase())) i++;
  return `${name} (${i})`;
}

function regenerateTaskSetIds(tset: TaskSet): TaskSet {
  const clone = JSON.parse(JSON.stringify(tset)) as TaskSet;
  clone.id = store.uid('tset');
  clone.createdAt = Date.now();
  delete (clone as unknown as Record<string, unknown>).builtIn;

  for (const tpl of clone.templates) {
    tpl.id = store.uid('tpl');
    for (const slot of tpl.slots) {
      slot.id = store.uid('slot');
    }
    for (const st of tpl.subTeams) {
      st.id = store.uid('st');
      for (const slot of st.slots) {
        slot.id = store.uid('slot');
      }
    }
    if (tpl.loadWindows) {
      for (const lw of tpl.loadWindows) {
        lw.id = store.uid('lw');
      }
    }
  }
  // Remap rest rule IDs and update template references
  const ruleIdMap = new Map<string, string>();
  if (Array.isArray(clone.restRules)) {
    for (const rule of clone.restRules) {
      const oldId = rule.id;
      rule.id = store.uid('rr');
      ruleIdMap.set(oldId, rule.id);
    }
    // Update template restRuleId references
    for (const tpl of clone.templates) {
      if (tpl.restRuleId && ruleIdMap.has(tpl.restRuleId)) {
        tpl.restRuleId = ruleIdMap.get(tpl.restRuleId);
      }
    }
  }
  for (const ot of clone.oneTimeTasks) {
    ot.id = store.uid('ot');
    for (const slot of ot.slots) {
      slot.id = store.uid('slot');
    }
    for (const st of ot.subTeams) {
      st.id = store.uid('st');
      for (const slot of st.slots) {
        slot.id = store.uid('slot');
      }
    }
    if (ot.loadWindows) {
      for (const lw of ot.loadWindows) {
        lw.id = store.uid('lw');
      }
    }
    if (ot.restRuleId && ruleIdMap.has(ot.restRuleId)) {
      ot.restRuleId = ruleIdMap.get(ot.restRuleId);
    }
  }
  return clone;
}

export function importAlgorithm(json: string, mode: 'replace' | 'add-preset'): ImportResult {
  const envelope = parseEnvelope(json);
  const payload = envelope.payload as AlgorithmExportPayload;

  if (mode === 'replace') {
    // Regenerate preset IDs to avoid collisions
    const presets = (payload.presets || []).map((p: AlgorithmPreset) => ({
      ...p,
      id: p.builtIn ? p.id : store.uid('preset'),
      settings: {
        config: { ...p.settings.config },
        disabledHardConstraints: [...p.settings.disabledHardConstraints],
        dayStartHour: p.settings.dayStartHour,
      },
    }));
    const ok = store.replaceAlgorithmSettingsAndPresets(
      payload.currentSettings,
      presets,
      null, // no meaningful active ID after replace — will default to Default
    );
    if (!ok) return { ok: false, error: 'שמירה נכשלה — ייתכן שאין מספיק מקום באחסון.' };
    return { ok: true };
  }

  // mode === 'add-preset'
  const existingNames = store.getAllPresets().map((p) => p.name);
  const name = deduplicateName(payload.currentSettings ? 'הגדרות מיובאות' : 'סט מיובא', existingNames);
  const preset: AlgorithmPreset = {
    id: store.uid('preset'),
    name,
    description: `יובא ב-${new Date().toLocaleDateString('he-IL')}`,
    settings: {
      config: { ...payload.currentSettings.config },
      disabledHardConstraints: [...payload.currentSettings.disabledHardConstraints],
      dayStartHour: payload.currentSettings.dayStartHour,
    },
    createdAt: Date.now(),
  };
  const ok = store.addAlgorithmPresetDirect(preset);
  if (!ok) return { ok: false, error: 'שמירה נכשלה — ייתכן שאין מספיק מקום באחסון.' };
  return { ok: true };
}

export function importTaskSet(json: string, mode: 'add-new' | 'replace', replaceId?: string): ImportResult {
  const envelope = parseEnvelope(json);
  const payload = envelope.payload as TaskSetExportPayload;
  const tset = regenerateTaskSetIds(payload.taskSet);

  if (mode === 'replace' && replaceId) {
    // Delete the existing set first
    store.deleteTaskSet(replaceId);
  }
  // Deduplicate name against remaining sets (after deletion if applicable)
  const existingTaskNames = store.getAllTaskSets().map((s) => s.name);
  tset.name = deduplicateName(payload.taskSet.name, existingTaskNames);

  const ok = store.importTaskSetDirect(tset);
  if (!ok) {
    return {
      ok: false,
      error:
        store.getAllTaskSets().length >= 30
          ? 'הגעת למגבלת 30 סטי משימות. מחק סטים קיימים ונסה שוב.'
          : 'שמירה נכשלה — ייתכן שאין מספיק מקום באחסון.',
    };
  }
  return { ok: true };
}

/**
 * Core participant-set import — shared between the JSON envelope path and
 * the xlsx importer. Accepts a fully-formed `ParticipantSet` object and
 * performs the final deduplication, id regeneration, optional replace, and
 * store write. Does NOT touch certification/pakal catalogs — callers that
 * need to merge external catalogs must do so before invoking this.
 */
export function importParticipantSetFromObject(
  pset: ParticipantSet,
  mode: 'add-new' | 'replace',
  replaceId?: string,
): ImportResult {
  const clone = { ...pset };
  clone.id = store.uid('pset');
  clone.createdAt = Date.now();
  delete (clone as unknown as Record<string, unknown>).builtIn;

  if (mode === 'replace' && replaceId) {
    store.deleteParticipantSet(replaceId);
  }
  const existingPsetNames = store.getAllParticipantSets().map((s) => s.name);
  clone.name = deduplicateName(pset.name, existingPsetNames);

  const ok = store.importParticipantSetDirect(clone);
  if (!ok) {
    return {
      ok: false,
      error:
        store.getAllParticipantSets().length >= 30
          ? 'הגעת למגבלת 30 סטי משתתפים. מחק סטים קיימים ונסה שוב.'
          : 'שמירה נכשלה — ייתכן שאין מספיק מקום באחסון.',
    };
  }
  return { ok: true };
}

export function importParticipantSet(json: string, mode: 'add-new' | 'replace', replaceId?: string): ImportResult {
  const envelope = parseEnvelope(json);
  const payload = envelope.payload as ParticipantSetExportPayload;
  return importParticipantSetFromObject(payload.participantSet, mode, replaceId);
}

export function importScheduleSnapshot(json: string): ImportResult {
  const envelope = parseEnvelope(json);
  const payload = envelope.payload as ScheduleSnapshotExportPayload;
  const snap = { ...payload.snapshot };
  snap.id = store.uid('snap');
  snap.createdAt = Date.now();
  delete (snap as unknown as Record<string, unknown>).builtIn;

  // Deduplicate name
  const existingNames = store.getAllSnapshots().map((s) => s.name);
  snap.name = deduplicateName(payload.snapshot.name, existingNames);

  // Merge any missing cert/pakal definitions into the app catalog
  if (payload.certificationCatalog?.length) {
    store.ensureCertificationDefinitions(payload.certificationCatalog);
  }
  if (payload.pakalCatalog?.length) {
    store.ensurePakalDefinitions(payload.pakalCatalog);
  }

  const ok = store.importSnapshotDirect(snap);
  if (!ok) {
    return {
      ok: false,
      error:
        store.getAllSnapshots().length >= 15
          ? 'הגעת למגבלת 15 תמונות מצב. מחק תמונות קיימות ונסה שוב.'
          : 'שמירה נכשלה — ייתכן שאין מספיק מקום באחסון.',
    };
  }
  return { ok: true };
}

export function importFullBackup(json: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'JSON לא תקין.' };
  }

  const envelope = raw as GardenManagerExport;
  const payload = envelope.payload as FullBackupPayload;
  if (!payload.storageEntries || typeof payload.storageEntries !== 'object') {
    return { ok: false, error: 'נתוני גיבוי לא תקינים.' };
  }

  // Full overwrite: factory reset then write all entries
  store.factoryReset();

  try {
    for (const [key, value] of Object.entries(payload.storageEntries)) {
      if (typeof value === 'string') {
        localStorage.setItem(key, value);
      }
    }
  } catch (err) {
    return { ok: false, error: 'כתיבה לאחסון נכשלה — ייתכן שאין מספיק מקום.' };
  }

  // Reload the app to reinitialize from the newly-written localStorage
  location.reload();
  return { ok: true };
}
