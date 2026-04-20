/**
 * Stage 0 Configuration Store
 *
 * In-memory reactive store for participants, task templates,
 * and availability rules. Provides CRUD operations and change
 * notifications so UI can re-render on mutations.
 */

import {
  type AlgorithmPreset,
  type AlgorithmSettings,
  type AvailabilityWindow,
  type CertificationDefinition,
  type DateUnavailability,
  DEFAULT_ALGORITHM_SETTINGS,
  DEFAULT_CERTIFICATION_DEFINITIONS,
  DEFAULT_PRESET,
  type HardConstraintCode,
  Level,
  LevelEntry,
  type LiveModeState,
  type OneTimeTask,
  type PakalDefinition,
  type Participant,
  type ParticipantSet,
  type ParticipantSnapshot,
  type RestRule,
  type Schedule,
  SchedulerConfig,
  type ScheduleSnapshot,
  type SlotTemplate,
  type SubTeamTemplate,
  type TaskSet,
  type TaskTemplate,
} from '../models/types';
import { normalizeCertificationDefinitions, sanitizeCertificationIds } from './certification-utils';
import {
  clonePakalDefinitions,
  DEFAULT_PAKAL_DEFINITIONS,
  HORESH_PAKAL_ID,
  normalizePakalDefinitions,
  sanitizePakalIds,
} from './pakal-utils';

// ─── ID Generation ───────────────────────────────────────────────────────────

let _idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++_idCounter}-${Date.now().toString(36)}`;
}

export { uid };

// ─── Save Error Handler / Storage Health ────────────────────────────────────

/**
 * Persistence errors are funnelled through `reportSaveError()` so the UI sees
 * them at most once per `SAVE_ERROR_TOAST_COOLDOWN_MS`, and so that a single
 * quota failure latches `_storageWedged = true`. While wedged, the **debounced
 * auto-save** (`saveToStorage()` via `debouncedSave()`) is skipped — preventing
 * the toast flood that used to fire on every downstream mutation once the
 * quota was exhausted.
 *
 * Explicit user-triggered writes (saveSchedule, _saveSnapshots, _savePresets,
 * …) are still attempted regardless of the wedge, because they may be *smaller*
 * than the blob they replace (e.g., a snapshot delete) and would succeed,
 * clearing the wedge via `onSaveSuccess()`.
 */
let _onSaveError: ((err: unknown, info: { isQuota: boolean }) => void) | null = null;
export function setSaveErrorHandler(handler: (err: unknown, info: { isQuota: boolean }) => void): void {
  _onSaveError = handler;
}

const SAVE_ERROR_TOAST_COOLDOWN_MS = 15_000;
let _lastSaveErrorAt = 0;
let _storageWedged = false;

/**
 * True if the last persistence attempt exhausted the browser's localStorage
 * quota. While wedged, `debouncedSave()` is a no-op until a save succeeds
 * (e.g., after the user deletes snapshots). UI code can call this to surface
 * a prominent banner.
 */
export function isStorageWedged(): boolean {
  return _storageWedged;
}

/**
 * Recognise a "quota exceeded" error across browsers:
 *  - Chrome / modern Safari: `DOMException` with `name === 'QuotaExceededError'` (code 22)
 *  - Firefox:                `DOMException` with `name === 'NS_ERROR_DOM_QUOTA_REACHED'` (code 1014)
 *  - Old WebKit:             `name === 'QUOTA_EXCEEDED_ERR'`
 *  - Safari private mode:    plain `Error` whose message contains "quota"
 */
function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    if (err.code === 22 || err.code === 1014) return true;
    if (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.name === 'QUOTA_EXCEEDED_ERR'
    )
      return true;
  }
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg === 'string' && /quota|storage/i.test(msg)) return true;
  return false;
}

function reportSaveError(err: unknown): void {
  const isQuota = isQuotaExceededError(err);
  if (isQuota) _storageWedged = true;

  const now = Date.now();
  if (now - _lastSaveErrorAt < SAVE_ERROR_TOAST_COOLDOWN_MS) return;
  _lastSaveErrorAt = now;
  _onSaveError?.(err, { isQuota });
}

function onSaveSuccess(): void {
  if (_storageWedged) {
    _storageWedged = false;
    console.log('[Store] Storage quota recovered — resuming persistence.');
  }
}

/**
 * Diagnostic: returns the approximate byte size of every persistence key this
 * module owns, plus the grand total. Useful for an in-app "storage usage"
 * inspector or for debugging the "storage full" symptom.
 */
export function getStorageUsage(): { key: string; bytes: number }[] & { total: number } {
  const keys = [
    STORAGE_KEY_STATE,
    STORAGE_KEY_SCHEDULE,
    STORAGE_KEY_LIVE_MODE,
    STORAGE_KEY_ALGORITHM,
    STORAGE_KEY_PRESETS,
    STORAGE_KEY_ACTIVE_PRESET,
    STORAGE_KEY_SNAPSHOTS,
    STORAGE_KEY_ACTIVE_SNAPSHOT,
    STORAGE_KEY_PSETS,
    STORAGE_KEY_ACTIVE_PSET,
    STORAGE_KEY_TASK_SETS,
    STORAGE_KEY_ACTIVE_TASK_SET,
  ];
  const rows = keys.map((key) => {
    let bytes = 0;
    try {
      const raw = localStorage.getItem(key);
      // UTF-16 code units ≈ 2 bytes each; approximate since most chars are ASCII.
      if (raw) bytes = key.length + raw.length;
    } catch {
      bytes = 0;
    }
    return { key, bytes };
  }) as { key: string; bytes: number }[] & { total: number };
  rows.total = rows.reduce((s, r) => s + r.bytes, 0);
  return rows;
}

// ─── Listener System ─────────────────────────────────────────────────────────

type Listener = () => void;
const listeners: Set<Listener> = new Set();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[Store] Listener threw:', err);
    }
  }
  // Auto-persist state to localStorage (debounced)
  debouncedSave();
}

// ─── Algorithm-change listeners (lightweight — no undo/reconciliation) ───────

const _algoListeners: Set<Listener> = new Set();

/**
 * Subscribe to algorithm-setting mutations (weights, HC toggles, presets).
 * Unlike the main `subscribe()`, this does NOT trigger schedule reconciliation
 * or undo snapshots — it only lets the UI mark the schedule as stale.
 */
export function subscribeAlgorithmChange(fn: Listener): () => void {
  _algoListeners.add(fn);
  return () => _algoListeners.delete(fn);
}

function notifyAlgorithmChanged(): void {
  for (const fn of _algoListeners) {
    try {
      fn();
    } catch (err) {
      console.error('[Store] Algorithm listener threw:', err);
    }
  }
}

// ─── Undo / Redo System ──────────────────────────────────────────────────────

interface StoreSnapshot {
  participants: Array<{ p: Participant; dateUnavails: DateUnavailability[] }>;
  taskTemplates: TaskTemplate[];
  oneTimeTasks: OneTimeTask[];
  notWithPairs: Array<[string, string[]]>;
  pakalDefinitions: PakalDefinition[];
  certificationDefinitions: CertificationDefinition[];
  restRules: RestRule[];
}

const MAX_HISTORY = 80;
const undoStack: StoreSnapshot[] = [];
const redoStack: StoreSnapshot[] = [];
let _suppressSnapshot = false;

/**
 * Capture the current state as a deep-cloned snapshot.
 *
 * Uses structuredClone when available (all modern browsers & Node 17+)
 * for a single C++ pass instead of manually spreading every field.
 * Falls back to a manual clone only for environments that lack it.
 */
function captureSnapshot(): StoreSnapshot {
  const useStructured = typeof structuredClone === 'function';
  const ps: StoreSnapshot['participants'] = [];
  for (const [id, p] of participants) {
    // Date objects survive structuredClone; avoid per-field spreading
    const clonedP = useStructured
      ? structuredClone(p)
      : {
          ...p,
          certifications: [...p.certifications],
          availability: p.availability.map((w) => ({
            start: new Date(w.start.getTime()),
            end: new Date(w.end.getTime()),
          })),
          dateUnavailability: [...(p.dateUnavailability || [])].map((r) => ({ ...r })),
        };
    const rawDus = dateUnavailabilities.get(id) || [];
    ps.push({
      p: clonedP,
      dateUnavails: useStructured ? structuredClone(rawDus) : rawDus.map((r) => ({ ...r })),
    });
  }
  const tpls: TaskTemplate[] = useStructured
    ? structuredClone([...taskTemplates.values()])
    : [...taskTemplates.values()].map((tpl) => ({
        ...tpl,
        loadWindows: (tpl.loadWindows || []).map((w) => ({ ...w })),
        slots: tpl.slots.map((s) => ({
          ...s,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        })),
        subTeams: tpl.subTeams.map((st) => ({
          ...st,
          slots: st.slots.map((s) => ({
            ...s,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          })),
        })),
      }));
  const ots: OneTimeTask[] = useStructured
    ? structuredClone([...oneTimeTasks.values()])
    : [...oneTimeTasks.values()].map((ot) => ({
        ...ot,
        scheduledDate: new Date(ot.scheduledDate.getTime()),
        loadWindows: (ot.loadWindows || []).map((w) => ({ ...w })),
        slots: ot.slots.map((s) => ({
          ...s,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        })),
        subTeams: ot.subTeams.map((st) => ({
          ...st,
          slots: st.slots.map((s) => ({
            ...s,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          })),
        })),
      }));
  const nwPairs: Array<[string, string[]]> = [];
  for (const [pid, set] of notWithPairs) {
    nwPairs.push([pid, [...set]]);
  }
  return {
    participants: ps,
    taskTemplates: tpls,
    oneTimeTasks: ots,
    notWithPairs: nwPairs,
    pakalDefinitions: clonePakalDefinitions(pakalDefinitions),
    certificationDefinitions: certificationDefinitions.map((d) => ({ ...d })),
    restRules: _restRules.map((r) => ({ ...r })),
  };
}

/** Replace live state with a snapshot (restoring original IDs). */
function restoreSnapshot(snap: StoreSnapshot): void {
  participants.clear();
  dateUnavailabilities.clear();
  notWithPairs.clear();

  const useStructured = typeof structuredClone === 'function';

  for (const entry of snap.participants) {
    const p: Participant = useStructured
      ? structuredClone(entry.p)
      : {
          ...entry.p,
          certifications: [...entry.p.certifications],
          availability: entry.p.availability.map((w) => ({
            start: new Date(w.start.getTime()),
            end: new Date(w.end.getTime()),
          })),
          dateUnavailability: (entry.dateUnavails || []).map((r) => ({ ...r })),
        };
    if (!useStructured) {
      p.dateUnavailability = (entry.dateUnavails || []).map((r) => ({ ...r }));
    }
    participants.set(p.id, p);
    if (entry.dateUnavails && entry.dateUnavails.length > 0) {
      dateUnavailabilities.set(
        p.id,
        useStructured ? structuredClone(entry.dateUnavails) : entry.dateUnavails.map((r) => ({ ...r })),
      );
    }
  }

  // Ensure participant inline dateUnavailability shares the same array
  // reference as the dateUnavailabilities Map entry.
  for (const [id, p] of participants) {
    p.dateUnavailability = dateUnavailabilities.get(id) || [];
  }

  // Restore notWithPairs and sync to participant objects
  if (snap.notWithPairs) {
    for (const [pid, targets] of snap.notWithPairs) {
      notWithPairs.set(pid, new Set(targets));
    }
  }
  syncNotWithToParticipants();

  pakalDefinitions = normalizePakalDefinitions(snap.pakalDefinitions);
  certificationDefinitions = snap.certificationDefinitions.map((d) => ({ ...d }));
  for (const p of participants.values()) {
    p.pakalIds = sanitizePakalIds(p.pakalIds, pakalDefinitions);
  }

  // Recompute availability from canonical data — the snapshot does not
  // capture scheduleDate/scheduleDays, so restored availability windows
  // may be stale relative to the current scheduling window.
  recalcAllAvailability();

  taskTemplates.clear();
  if (useStructured) {
    for (const tpl of snap.taskTemplates) {
      taskTemplates.set(tpl.id, structuredClone(tpl));
    }
  } else {
    for (const tpl of snap.taskTemplates) {
      taskTemplates.set(tpl.id, {
        ...tpl,
        loadWindows: (tpl.loadWindows || []).map((w) => ({ ...w })),
        slots: tpl.slots.map((s) => ({
          ...s,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        })),
        subTeams: tpl.subTeams.map((st) => ({
          ...st,
          slots: st.slots.map((s) => ({
            ...s,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          })),
        })),
      });
    }
  }

  oneTimeTasks.clear();
  if (useStructured) {
    for (const ot of snap.oneTimeTasks || []) {
      oneTimeTasks.set(ot.id, structuredClone(ot));
    }
  } else {
    for (const ot of snap.oneTimeTasks || []) {
      oneTimeTasks.set(ot.id, {
        ...ot,
        scheduledDate: new Date(ot.scheduledDate.getTime()),
        loadWindows: (ot.loadWindows || []).map((w) => ({ ...w })),
        slots: ot.slots.map((s) => ({
          ...s,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        })),
        subTeams: ot.subTeams.map((st) => ({
          ...st,
          slots: st.slots.map((s) => ({
            ...s,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          })),
        })),
      });
    }
  }

  _restRules = (snap.restRules || []).map((r) => ({ ...r }));
}

/**
 * Save current state to the undo stack before a mutation.
 * Called at the START of every mutating operation.
 */
function pushSnapshot(): void {
  if (_suppressSnapshot) return;
  undoStack.push(captureSnapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  // Any new mutation clears the redo future
  redoStack.length = 0;
}

/** Undo the last action. Returns true if successful. */
export function undo(): boolean {
  if (undoStack.length === 0) return false;
  // Save current state to redo before restoring
  redoStack.push(captureSnapshot());
  const snap = undoStack.pop()!;
  restoreSnapshot(snap);
  notify();
  return true;
}

/** Redo the last undone action. Returns true if successful. */
export function redo(): boolean {
  if (redoStack.length === 0) return false;
  // Save current state to undo before restoring
  undoStack.push(captureSnapshot());
  const snap = redoStack.pop()!;
  restoreSnapshot(snap);
  notify();
  return true;
}

/** Query undo/redo availability for UI button states. */
export function getUndoRedoState(): { canUndo: boolean; canRedo: boolean; undoDepth: number; redoDepth: number } {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
  };
}

/**
 * Push a no-op checkpoint onto the undo stack for actions that live outside
 * the store (e.g. swap-picker commits mutate the schedule directly through
 * the engine). The snapshot captures the current — unchanged — store state,
 * so restoring it during undo is a no-op; its sole purpose is to enable the
 * header undo/redo buttons so the parallel schedule undo stack in app.ts
 * stays wired to them. Does NOT call notify() — callers are expected to
 * manage their own schedule-level snapshot and refresh.
 */
export function pushUndoCheckpoint(): void {
  pushSnapshot();
}

// ─── Participant Store ───────────────────────────────────────────────────────

const participants: Map<string, Participant> = new Map();
const dateUnavailabilities: Map<string, DateUnavailability[]> = new Map(); // participantId -> rules
const notWithPairs: Map<string, Set<string>> = new Map(); // participantId -> set of partner IDs
let pakalDefinitions: PakalDefinition[] = clonePakalDefinitions(DEFAULT_PAKAL_DEFINITIONS);

// ─── Certification Definitions ──────────────────────────────────────────────

let certificationDefinitions: CertificationDefinition[] = DEFAULT_CERTIFICATION_DEFINITIONS.map((d) => ({ ...d }));

export function getCertificationDefinitions(): CertificationDefinition[] {
  return certificationDefinitions.filter((d) => !d.deleted).map((d) => ({ ...d }));
}

export function getCertificationById(id: string): CertificationDefinition | undefined {
  const def = certificationDefinitions.find((d) => d.id === id);
  return def ? { ...def } : undefined;
}

export function getCertLabel(certId: string): string {
  return certificationDefinitions.find((d) => d.id === certId)?.label ?? certId;
}

export function getCertColor(certId: string): string {
  return certificationDefinitions.find((d) => d.id === certId)?.color ?? '#7f8c8d';
}

export function addCertification(label: string, color: string): CertificationDefinition {
  const trimmed = label.trim();
  if (!trimmed) throw new Error('Certification label cannot be empty');
  if (trimmed.length > 100) throw new Error('Certification label too long (max 50 characters)');
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid hex color');
  if (certificationDefinitions.some((d) => !d.deleted && d.label === trimmed)) {
    throw new Error(`Certification "${trimmed}" already exists`);
  }
  pushSnapshot();
  const def: CertificationDefinition = { id: uid('cert'), label: trimmed, color };
  certificationDefinitions.push(def);
  notify();
  return { ...def };
}

export function renameCertification(id: string, label: string): string | null {
  const trimmed = label.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'שם הסמכה לא יכול להיות ריק';
  if (trimmed.length > 100) return 'שם הסמכה ארוך מדי (מקסימום 100 תווים)';
  const def = certificationDefinitions.find((d) => d.id === id && !d.deleted);
  if (!def) return 'הסמכה לא נמצאה';
  if (def.label === trimmed) return null;
  const duplicate = certificationDefinitions.find(
    (d) => d.id !== id && !d.deleted && d.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) return 'הסמכה כזאת כבר קיימת';
  pushSnapshot();
  def.label = trimmed;
  notify();
  return null;
}

export function updateCertificationColor(id: string, color: string): void {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('Invalid hex color');
  const def = certificationDefinitions.find((d) => d.id === id && !d.deleted);
  if (!def) return;
  if (def.color === color) return;
  pushSnapshot();
  def.color = color;
  notify();
}

export function removeCertification(id: string): void {
  const def = certificationDefinitions.find((d) => d.id === id && !d.deleted);
  if (!def) return;
  pushSnapshot();
  def.deleted = true;
  notify();
}

export function getCertificationUsage(id: string): { participantCount: number; slotCount: number } {
  let participantCount = 0;
  let slotCount = 0;
  for (const p of participants.values()) {
    if (p.certifications.includes(id)) participantCount++;
  }
  for (const tpl of taskTemplates.values()) {
    for (const s of [...tpl.slots, ...tpl.subTeams.flatMap((st) => st.slots)]) {
      if (s.requiredCertifications.includes(id) || s.forbiddenCertifications?.includes(id)) slotCount++;
    }
  }
  for (const ot of oneTimeTasks.values()) {
    for (const s of [...ot.slots, ...ot.subTeams.flatMap((st) => st.slots)]) {
      if (s.requiredCertifications.includes(id) || s.forbiddenCertifications?.includes(id)) slotCount++;
    }
  }
  return { participantCount, slotCount };
}

function normalizePakalLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function ensurePakalDefinitions(definitions: PakalDefinition[]): void {
  pakalDefinitions = normalizePakalDefinitions([...pakalDefinitions, ...definitions]);
  for (const participant of participants.values()) {
    participant.pakalIds = sanitizePakalIds(participant.pakalIds, pakalDefinitions);
  }
}

export function ensureCertificationDefinitions(definitions: CertificationDefinition[]): void {
  certificationDefinitions = normalizeCertificationDefinitions([...certificationDefinitions, ...definitions]);
}

export function getPakalDefinitions(): PakalDefinition[] {
  return clonePakalDefinitions(pakalDefinitions.filter((d) => !d.deleted));
}

export function getAllPakalDefinitionsIncludeDeleted(): PakalDefinition[] {
  return clonePakalDefinitions(pakalDefinitions);
}

export function getPakalById(id: string): PakalDefinition | undefined {
  const def = pakalDefinitions.find((d) => d.id === id);
  return def ? { ...def } : undefined;
}

export function getPakalLabel(pakalId: string): string {
  return pakalDefinitions.find((d) => d.id === pakalId)?.label ?? pakalId;
}

export function addPakal(label: string): { definition?: PakalDefinition; error?: string } {
  const normalizedLabel = normalizePakalLabel(label);
  if (!normalizedLabel) return { error: 'שם פק"ל לא יכול להיות ריק' };
  const duplicate = pakalDefinitions.find(
    (def) => !def.deleted && def.label.toLowerCase() === normalizedLabel.toLowerCase(),
  );
  if (duplicate) return { error: 'פק"ל כזה כבר קיים' };

  pushSnapshot();
  const definition: PakalDefinition = {
    id: uid('pakal'),
    label: normalizedLabel,
  };
  pakalDefinitions = [...pakalDefinitions, definition];
  notify();
  return { definition };
}

export function renamePakal(id: string, label: string): string | null {
  const normalizedLabel = normalizePakalLabel(label);
  if (!normalizedLabel) return 'שם פק"ל לא יכול להיות ריק';
  const definition = pakalDefinitions.find((def) => def.id === id && !def.deleted);
  if (!definition) return 'פק"ל לא נמצא';

  const duplicate = pakalDefinitions.find(
    (def) => def.id !== id && !def.deleted && def.label.toLowerCase() === normalizedLabel.toLowerCase(),
  );
  if (duplicate) return 'פק"ל כזה כבר קיים';

  pushSnapshot();
  definition.label = normalizedLabel;
  notify();
  return null;
}

export function getPakalUsageCount(id: string): number {
  let count = 0;
  for (const participant of participants.values()) {
    const selected = new Set(sanitizePakalIds(participant.pakalIds, pakalDefinitions));
    if (selected.has(id)) count += 1;
  }
  return count;
}

export function removePakal(id: string): void {
  const def = pakalDefinitions.find((d) => d.id === id && !d.deleted);
  if (!def) return;
  pushSnapshot();
  def.deleted = true;
  notify();
}

function normalizeDateUnavailabilityRule(
  rule: Partial<Omit<DateUnavailability, 'id'>> | null | undefined,
): Omit<DateUnavailability, 'id'> | null {
  if (!rule) return null;
  const dayOfWeek = typeof rule.dayOfWeek === 'number' ? Math.trunc(rule.dayOfWeek) : NaN;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;

  const allDay = !!rule.allDay;
  const startHour = allDay ? 0 : Math.trunc(rule.startHour ?? 0);
  const endHour = allDay ? 24 : Math.trunc(rule.endHour ?? 0);
  if (!allDay && (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23)) return null;

  return {
    dayOfWeek,
    allDay,
    startHour,
    endHour,
    reason: rule.reason?.trim() || undefined,
  };
}

/** Default schedule date: next upcoming Sunday from today. */
function defaultScheduleDate(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSunday);
}
let scheduleDate: Date = defaultScheduleDate();
let scheduleDays: number = 7;

export function getScheduleDate(): Date {
  return scheduleDate;
}
export function getScheduleDays(): number {
  return scheduleDays;
}
export function setScheduleDate(d: Date): void {
  pushSnapshot();
  scheduleDate = d;
  recalcAllAvailability();
  notify();
}
export function setScheduleDays(n: number): void {
  pushSnapshot();
  scheduleDays = Math.max(1, Math.min(7, n));
  recalcAllAvailability();
  notify();
}

// ─── HC-14 Rest Rules ───────────────────────────────────────────────────────

let _restRules: RestRule[] = [];

/** Return all non-deleted rest rules. */
export function getRestRules(): RestRule[] {
  return _restRules.filter((r) => !r.deleted);
}

/** Return all rest rules including soft-deleted tombstones (for orphan display). */
export function getAllRestRules(): RestRule[] {
  return _restRules;
}

/** Look up a rest rule by ID (includes tombstones). */
export function getRestRuleById(id: string): RestRule | undefined {
  return _restRules.find((r) => r.id === id);
}

/** Create a new rest rule. Returns the created rule. */
export function addRestRule(label: string, durationHours: number): RestRule {
  pushSnapshot();
  const rule: RestRule = {
    id: uid('rr'),
    label: label.trim(),
    durationHours: Math.max(0.5, Math.min(24, durationHours)),
  };
  _restRules.push(rule);
  notify();
  return rule;
}

/** Update an existing non-deleted rest rule. */
export function updateRestRule(id: string, updates: { label?: string; durationHours?: number }): void {
  const rule = _restRules.find((r) => r.id === id && !r.deleted);
  if (!rule) return;
  pushSnapshot();
  if (updates.label !== undefined) rule.label = updates.label.trim();
  if (updates.durationHours !== undefined) rule.durationHours = Math.max(0.5, Math.min(24, updates.durationHours));
  notify();
}

/** Soft-delete a rest rule. Tasks referencing it become orphans. */
export function removeRestRule(id: string): void {
  const rule = _restRules.find((r) => r.id === id && !r.deleted);
  if (!rule) return;
  pushSnapshot();
  rule.deleted = true;
  notify();
}

/** Build a Map<ruleId, durationMs> for non-deleted rules (engine consumption). */
export function buildRestRuleMap(): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of _restRules) {
    if (!r.deleted) map.set(r.id, r.durationHours * 3600000);
  }
  return map;
}

function getDefaultAvailability(): AvailabilityWindow[] {
  const d = scheduleDate;
  // Cover the full multi-day window plus buffer for overnight tasks
  return [
    {
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + scheduleDays, 12, 0),
    },
  ];
}

function computeAvailability(participantId: string): AvailabilityWindow[] {
  const full = getDefaultAvailability();
  const dateRules = dateUnavailabilities.get(participantId) || [];

  // Expand recurring weekday rules into concrete blackout-style windows.
  const expandedBlackouts: Array<{ start: Date; end: Date }> = [];

  const schedStart = scheduleDate;
  for (const rule of dateRules) {
    for (let dayOff = 0; dayOff < scheduleDays; dayOff++) {
      const dayDate = new Date(schedStart.getFullYear(), schedStart.getMonth(), schedStart.getDate() + dayOff);
      if (dayDate.getDay() === rule.dayOfWeek) {
        if (rule.allDay) {
          expandedBlackouts.push({
            start: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0),
            end: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1, 0, 0),
          });
        } else {
          const endH = rule.endHour;
          let endDay = dayDate.getDate();
          if (endH < rule.startHour) {
            endDay += 1;
          } // crosses midnight
          expandedBlackouts.push({
            start: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), rule.startHour, 0),
            end: new Date(dayDate.getFullYear(), dayDate.getMonth(), endDay, endH, 0),
          });
        }
      }
    }
  }

  if (expandedBlackouts.length === 0) return full;

  // Subtract all blackout windows from the full availability
  let windows = [...full];
  for (const bout of expandedBlackouts) {
    const next: AvailabilityWindow[] = [];
    for (const w of windows) {
      if (bout.end <= w.start || bout.start >= w.end) {
        // No overlap
        next.push(w);
      } else {
        // Overlap — split
        if (bout.start > w.start) {
          next.push({ start: w.start, end: bout.start });
        }
        if (bout.end < w.end) {
          next.push({ start: bout.end, end: w.end });
        }
      }
    }
    windows = next;
  }
  return windows;
}

function recalcAllAvailability(): void {
  for (const [id, p] of participants) {
    p.availability = computeAvailability(id);
  }
}

/** Case-insensitive trimmed name duplicate check for participants. */
export function isParticipantNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  if (!norm) return false;
  for (const p of participants.values()) {
    if (p.id === excludeId) continue;
    if (p.name.trim().toLowerCase() === norm) return true;
  }
  return false;
}

// ── Internal no-snapshot helpers (used by public functions & bulkMutateParticipants) ──

function _addParticipantNoSnapshot(data: {
  name: string;
  level?: Level;
  certifications?: string[];
  pakalIds?: string[];
  group: string;
}): Participant {
  const id = uid('p');
  const firstActiveId = certificationDefinitions.find((d) => !d.deleted)?.id;
  const certs = data.certifications ?? (firstActiveId ? [firstActiveId] : []);
  const pIds = sanitizePakalIds(data.pakalIds, pakalDefinitions);
  const p: Participant = {
    id,
    name: data.name,
    level: data.level ?? Level.L0,
    certifications: certs,
    pakalIds: pIds,
    group: data.group,
    availability: getDefaultAvailability(),
    dateUnavailability: [],
  };
  participants.set(id, p);
  return p;
}

function _updateParticipantNoSnapshot(id: string, patch: Partial<Omit<Participant, 'id' | 'availability'>>): void {
  const p = participants.get(id);
  if (!p) return;
  const nextPatch = { ...patch };
  // biome-ignore lint/suspicious/noPrototypeBuiltins: ES2020 target doesn't support Object.hasOwn
  if (Object.prototype.hasOwnProperty.call(nextPatch, 'pakalIds')) {
    nextPatch.pakalIds = sanitizePakalIds(nextPatch.pakalIds, pakalDefinitions);
  }
  Object.assign(p, nextPatch);
  p.availability = computeAvailability(id);
}

function _removeParticipantNoSnapshot(id: string): void {
  participants.delete(id);
  dateUnavailabilities.delete(id);
  cleanupNotWith(id);
}

function _setTaskNamePreferenceNoSnapshot(pid: string, preferred?: string, lessPreferred?: string): void {
  const p = participants.get(pid);
  if (!p) return;
  p.preferredTaskName = preferred;
  p.lessPreferredTaskName = lessPreferred;
}

// ── Public CRUD (delegate to helpers, wrapping with snapshot + notify) ──

export function addParticipant(data: {
  name: string;
  level?: Level;
  certifications?: string[];
  pakalIds?: string[];
  group: string;
}): Participant {
  pushSnapshot();
  const p = _addParticipantNoSnapshot(data);
  notify();
  return p;
}

export function updateParticipant(id: string, patch: Partial<Omit<Participant, 'id' | 'availability'>>): void {
  const p = participants.get(id);
  if (!p) return;
  pushSnapshot();
  _updateParticipantNoSnapshot(id, patch);
  notify();
}

export function removeParticipant(id: string): void {
  if (!participants.has(id)) return;
  pushSnapshot();
  _removeParticipantNoSnapshot(id);
  syncNotWithToParticipants();
  notify();
}

/**
 * Remove multiple participants and all their associated data in one
 * undo-able action.  Uses a Set for O(1) membership checks and deletes
 * participants and unavailability entries in a single pass.
 * Returns the number of participants actually removed.
 */
export function removeParticipantsBulk(ids: string[]): number {
  const removeSet = new Set(ids);
  const validIds: string[] = [];
  for (const id of removeSet) {
    if (participants.has(id)) validIds.push(id);
  }
  if (validIds.length === 0) return 0;
  pushSnapshot();
  for (const id of validIds) {
    participants.delete(id);
    dateUnavailabilities.delete(id);
    cleanupNotWith(id);
  }
  syncNotWithToParticipants();
  notify();
  return validIds.length;
}

export function getParticipant(id: string): Participant | undefined {
  return participants.get(id);
}

export function getAllParticipants(): Participant[] {
  return [...participants.values()];
}

export function getGroups(): string[] {
  const groups = new Set<string>();
  for (const p of participants.values()) groups.add(p.group);
  return [...groups].sort();
}

// ─── Date Unavailability Management ──────────────────────────────────────────

export function addDateUnavailability(
  participantId: string,
  rule: Omit<DateUnavailability, 'id'>,
): DateUnavailability | null {
  if (!participants.has(participantId)) return null;
  const normalized = normalizeDateUnavailabilityRule(rule);
  if (!normalized) return null;
  pushSnapshot();
  const du: DateUnavailability = { ...normalized, id: uid('du') };
  const arr = dateUnavailabilities.get(participantId) || [];
  arr.push(du);
  dateUnavailabilities.set(participantId, arr);
  const p = participants.get(participantId)!;
  p.dateUnavailability = arr;
  p.availability = computeAvailability(participantId);
  notify();
  return du;
}

export function removeDateUnavailability(participantId: string, ruleId: string): void {
  const arr = dateUnavailabilities.get(participantId);
  if (!arr) return;
  const idx = arr.findIndex((r) => r.id === ruleId);
  if (idx < 0) return;
  pushSnapshot();
  arr.splice(idx, 1);
  const p = participants.get(participantId);
  if (p) {
    p.dateUnavailability = arr;
    p.availability = computeAvailability(participantId);
  }
  notify();
}

export function getDateUnavailabilities(participantId: string): DateUnavailability[] {
  return dateUnavailabilities.get(participantId) || [];
}

/**
 * Add the same DateUnavailability rule to multiple participants in one
 * undo-able action.  Returns the count of successfully added entries.
 */
export function addDateUnavailabilityBulk(participantIds: string[], rule: Omit<DateUnavailability, 'id'>): number {
  const normalized = normalizeDateUnavailabilityRule(rule);
  if (!normalized) return 0;
  const validIds = participantIds.filter((id) => participants.has(id));
  if (validIds.length === 0) return 0;
  pushSnapshot();
  _suppressSnapshot = true;
  let count = 0;
  try {
    for (const pid of validIds) {
      const du: DateUnavailability = { ...normalized, id: uid('du') };
      const arr = dateUnavailabilities.get(pid) || [];
      arr.push(du);
      dateUnavailabilities.set(pid, arr);
      const p = participants.get(pid)!;
      p.dateUnavailability = arr;
      p.availability = computeAvailability(pid);
      count++;
    }
  } finally {
    _suppressSnapshot = false;
  }
  notify();
  return count;
}

// ─── Not-With Preference Management ─────────────────────────────────────────

/** Sync the notWithPairs map to each participant's notWithIds field. */
function syncNotWithToParticipants(): void {
  for (const p of participants.values()) {
    const set = notWithPairs.get(p.id);
    p.notWithIds = set && set.size > 0 ? [...set] : undefined;
  }
}

export function addNotWith(pidA: string, pidB: string): void {
  if (pidA === pidB) return;
  if (!participants.has(pidA) || !participants.has(pidB)) return;
  // Check if already exists
  const setA = notWithPairs.get(pidA);
  if (setA?.has(pidB)) return;
  pushSnapshot();
  // Symmetric add
  if (!notWithPairs.has(pidA)) notWithPairs.set(pidA, new Set());
  if (!notWithPairs.has(pidB)) notWithPairs.set(pidB, new Set());
  notWithPairs.get(pidA)!.add(pidB);
  notWithPairs.get(pidB)!.add(pidA);
  syncNotWithToParticipants();
  notify();
}

export function removeNotWith(pidA: string, pidB: string): void {
  const setA = notWithPairs.get(pidA);
  const setB = notWithPairs.get(pidB);
  if (!setA?.has(pidB)) return;
  pushSnapshot();
  setA.delete(pidB);
  if (setA.size === 0) notWithPairs.delete(pidA);
  if (setB) {
    setB.delete(pidA);
    if (setB.size === 0) notWithPairs.delete(pidB);
  }
  syncNotWithToParticipants();
  notify();
}

export function getNotWithIds(pid: string): string[] {
  const set = notWithPairs.get(pid);
  return set ? [...set] : [];
}

/** Remove a participant from all notWithPairs entries. */
function cleanupNotWith(pid: string): void {
  const set = notWithPairs.get(pid);
  if (set) {
    for (const partnerId of set) {
      const partnerSet = notWithPairs.get(partnerId);
      if (partnerSet) {
        partnerSet.delete(pid);
        if (partnerSet.size === 0) notWithPairs.delete(partnerId);
      }
    }
    notWithPairs.delete(pid);
  }
}

// ─── Task Preference Accessors ──────────────────────────────────────────────

/** Get a participant's task name preferences. */
export function getTaskNamePreference(pid: string): { preferred?: string; lessPreferred?: string } {
  const p = participants.get(pid);
  if (!p) return {};
  return { preferred: p.preferredTaskName, lessPreferred: p.lessPreferredTaskName };
}

/** Set a participant's task name preferences. Pass undefined to clear. */
export function setTaskNamePreference(pid: string, preferred?: string, lessPreferred?: string): void {
  const p = participants.get(pid);
  if (!p) return;
  if (p.preferredTaskName === preferred && p.lessPreferredTaskName === lessPreferred) return;
  pushSnapshot();
  _setTaskNamePreferenceNoSnapshot(pid, preferred, lessPreferred);
  notify();
}

// ─── Bulk Participant Mutations ─────────────────────────────────────────────

export interface BulkParticipantOp {
  type: 'add' | 'update' | 'delete';
  /** For 'update' and 'delete': existing participant ID */
  id?: string;
  /** For 'add' and 'update': the field values */
  data?: {
    name: string;
    group: string;
    level?: Level;
    certifications?: string[];
    pakalIds?: string[];
    preferredTaskName?: string;
    lessPreferredTaskName?: string;
  };
}

/**
 * Apply multiple participant add/update/delete operations in one undo-able action.
 * A single snapshot is pushed before all mutations, and notify() is called once at the end.
 */
export function bulkMutateParticipants(ops: BulkParticipantOp[]): { added: number; updated: number; deleted: number } {
  if (ops.length === 0) return { added: 0, updated: 0, deleted: 0 };
  pushSnapshot();
  _suppressSnapshot = true;
  let added = 0;
  let updated = 0;
  let deleted = 0;
  try {
    for (const op of ops) {
      switch (op.type) {
        case 'add': {
          const p = _addParticipantNoSnapshot(op.data!);
          if (op.data!.preferredTaskName || op.data!.lessPreferredTaskName) {
            _setTaskNamePreferenceNoSnapshot(p.id, op.data!.preferredTaskName, op.data!.lessPreferredTaskName);
          }
          added++;
          break;
        }
        case 'update': {
          const existing = participants.get(op.id!);
          if (existing) {
            _updateParticipantNoSnapshot(op.id!, op.data!);
            _setTaskNamePreferenceNoSnapshot(op.id!, op.data!.preferredTaskName, op.data!.lessPreferredTaskName);
            updated++;
          }
          break;
        }
        case 'delete': {
          if (participants.has(op.id!)) {
            _removeParticipantNoSnapshot(op.id!);
            deleted++;
          }
          break;
        }
      }
    }
    syncNotWithToParticipants();
  } finally {
    _suppressSnapshot = false;
  }
  notify();
  return { added, updated, deleted };
}

// ─── Task Template Store ─────────────────────────────────────────────────────

const taskTemplates: Map<string, TaskTemplate> = new Map();

/**
 * Clamp task-template numeric fields to valid ranges.
 * Returns a sanitized shallow copy of only the numeric fields present in `raw`.
 *   durationHours  → 0.5 … 24   (NaN → 8)
 *   shiftsPerDay   → 1 … 12     (NaN → 1, rounded to integer)
 *   startHour      → 0 … 23     (NaN → 6, rounded to integer)
 *   eveningStartHour → 0 … 23   (NaN → 17, rounded to integer)
 */
export function sanitizeTemplateNumericFields<
  T extends Partial<Pick<TaskTemplate, 'durationHours' | 'shiftsPerDay' | 'startHour' | 'eveningStartHour'>>,
>(raw: T): T {
  const out = { ...raw };
  if (out.durationHours !== undefined) {
    let v = Number(out.durationHours);
    if (Number.isNaN(v)) v = 8;
    out.durationHours = Math.max(0.5, Math.min(24, v));
  }
  if (out.shiftsPerDay !== undefined) {
    let v = Number(out.shiftsPerDay);
    if (Number.isNaN(v)) v = 1;
    out.shiftsPerDay = Math.max(1, Math.min(12, Math.round(v)));
  }
  if (out.startHour !== undefined) {
    let v = Number(out.startHour);
    if (Number.isNaN(v)) v = 6;
    out.startHour = Math.max(0, Math.min(23, Math.round(v)));
  }
  if (out.eveningStartHour !== undefined) {
    let v = Number(out.eveningStartHour);
    if (Number.isNaN(v)) v = 17;
    out.eveningStartHour = Math.max(0, Math.min(23, Math.round(v)));
  }
  return out;
}

function cloneLoadFormula(f: TaskTemplate['loadFormula']): TaskTemplate['loadFormula'] {
  if (!f) return undefined;
  const sc = (globalThis as { structuredClone?: <T>(v: T) => T }).structuredClone;
  if (typeof sc === 'function') return sc(f);
  return {
    computedValue: f.computedValue,
    computedAt: f.computedAt,
    targetHours: f.targetHours,
    components: f.components.map((c) => ({ ...c, refRate: { ...c.refRate } })),
    snapshot: f.snapshot.map((s) => ({ ...s, rate: { ...s.rate } })),
    lhsExtras: f.lhsExtras?.map((c) => ({ ...c, refRate: { ...c.refRate } })),
    lhsExtrasSnapshot: f.lhsExtrasSnapshot?.map((s) => ({ ...s, rate: { ...s.rate } })),
  };
}

export function addTaskTemplate(tpl: Omit<TaskTemplate, 'id'>): TaskTemplate {
  pushSnapshot();
  const id = uid('tpl');
  const sanitized = sanitizeTemplateNumericFields(tpl);
  const full: TaskTemplate = {
    ...sanitized,
    id,
    color: sanitized.color || getNextAvailableColor(),
    baseLoadWeight: sanitized.baseLoadWeight ?? 1,
    loadFormula: cloneLoadFormula(sanitized.loadFormula),
    loadWindows: (sanitized.loadWindows || []).map((w) => ({
      ...w,
      loadFormula: cloneLoadFormula(w.loadFormula),
    })),
  };
  taskTemplates.set(id, full);
  notify();
  return full;
}

export function updateTaskTemplate(id: string, patch: Partial<Omit<TaskTemplate, 'id'>>): void {
  const tpl = taskTemplates.get(id);
  if (!tpl) return;
  pushSnapshot();
  const sanitized = sanitizeTemplateNumericFields(patch);
  patch = sanitized;
  Object.assign(tpl, patch);
  if (patch.loadWindows) {
    tpl.loadWindows = patch.loadWindows.map((w) => ({
      ...w,
      loadFormula: cloneLoadFormula(w.loadFormula),
    }));
  }
  if (patch.baseLoadWeight !== undefined) {
    tpl.baseLoadWeight = Math.max(0, Math.min(1, patch.baseLoadWeight));
  }
  // Invariant: if a formula was set in the patch, base weight must match its computedValue.
  if ('loadFormula' in patch) {
    if (patch.loadFormula) {
      const cloned = cloneLoadFormula(patch.loadFormula);
      tpl.loadFormula = cloned;
      tpl.baseLoadWeight = cloned!.computedValue;
    } else {
      tpl.loadFormula = undefined;
    }
  } else if (
    patch.baseLoadWeight !== undefined &&
    tpl.loadFormula &&
    Math.abs(tpl.baseLoadWeight! - tpl.loadFormula.computedValue) > 1e-9
  ) {
    // Manual edit to baseLoadWeight that diverges from the formula → drop formula.
    tpl.loadFormula = undefined;
  }
  notify();
}

export function removeTaskTemplate(id: string): void {
  if (!taskTemplates.has(id)) return;
  pushSnapshot();
  taskTemplates.delete(id);
  notify();
}

export function getTaskTemplate(id: string): TaskTemplate | undefined {
  return taskTemplates.get(id);
}

export function getAllTaskTemplates(): TaskTemplate[] {
  return [...taskTemplates.values()];
}

// ─── Config-Derived Helpers (task-name-agnostic) ───────────────────────────

/** Auto-palette for templates that lack an explicit color. */
const AUTO_PALETTE = [
  '#3498db',
  '#e74c3c',
  '#f39c12',
  '#27ae60',
  '#8e44ad',
  '#1abc9c',
  '#e67e22',
  '#34495e',
  '#16a085',
  '#c0392b',
];

/**
 * Return the next available unique color for a new task.
 * Prefers AUTO_PALETTE colors not currently used by any template or one-time task.
 * When the palette is exhausted, generates a new HSL-based color that is visually
 * distinct from all currently used colors.
 */
export function getNextAvailableColor(): string {
  const usedColors = new Set<string>();
  for (const tpl of taskTemplates.values()) {
    if (tpl.color) usedColors.add(tpl.color.toLowerCase());
  }
  for (const ot of oneTimeTasks.values()) {
    if (ot.color) usedColors.add(ot.color.toLowerCase());
  }

  // Try palette first
  for (const c of AUTO_PALETTE) {
    if (!usedColors.has(c.toLowerCase())) return c;
  }

  // Palette exhausted — generate a distinct HSL color
  const usedHues = [...usedColors].map((hex) => hexToHue(hex));
  let bestHue = 0;
  let bestDist = -1;
  for (let h = 0; h < 360; h += 5) {
    const minDist = usedHues.reduce((min, uh) => {
      const d = Math.min(Math.abs(h - uh), 360 - Math.abs(h - uh));
      return Math.min(min, d);
    }, 360);
    if (minDist > bestDist) {
      bestDist = minDist;
      bestHue = h;
    }
  }
  return hslToHex(bestHue, 65, 55);
}

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round(h * 60);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Build a displayCategory → displayOrder map from current templates.
 * Takes the minimum displayOrder among templates sharing a category.
 */
export function getDisplayOrderMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const tpl of taskTemplates.values()) {
    const cat = tpl.displayCategory;
    if (cat && tpl.displayOrder != null) {
      map[cat] = Math.min(map[cat] ?? Infinity, tpl.displayOrder);
    }
  }
  return map;
}

/**
 * Build a displayCategory → color map from current templates.
 * Takes the first color found for each category.
 */
export function getCategoryColorMap(): Record<string, string> {
  const map: Record<string, string> = {};
  let autoIdx = 0;
  for (const tpl of taskTemplates.values()) {
    const cat = tpl.displayCategory;
    if (cat && !map[cat]) {
      map[cat] = tpl.color || AUTO_PALETTE[autoIdx++ % AUTO_PALETTE.length];
    }
  }
  return map;
}

/**
 * Build a template-name → visual attributes map.
 * Keyed by template `name` (= `sourceName` on Task), not by taskType.
 * Replaces all type-keyed map functions.
 */
export function getTemplateVisualMap(): Record<
  string,
  { color: string; displayOrder: number; displayCategory: string }
> {
  const map: Record<string, { color: string; displayOrder: number; displayCategory: string }> = {};
  let autoIdx = 0;
  for (const tpl of taskTemplates.values()) {
    if (!map[tpl.name]) {
      map[tpl.name] = {
        color: tpl.color || AUTO_PALETTE[autoIdx++ % AUTO_PALETTE.length],
        displayOrder: tpl.displayOrder ?? 100,
        displayCategory: tpl.displayCategory || tpl.name.toLowerCase(),
      };
    }
  }
  return map;
}

// ─── One-Time Task Store ────────────────────────────────────────────────────

const oneTimeTasks: Map<string, OneTimeTask> = new Map();

export function addOneTimeTask(task: Omit<OneTimeTask, 'id'>): OneTimeTask {
  pushSnapshot();
  const id = uid('ot');
  const full: OneTimeTask = {
    ...task,
    id,
    color: task.color || getNextAvailableColor(),
    baseLoadWeight: task.baseLoadWeight ?? 1,
    loadWindows: (task.loadWindows || []).map((w) => ({ ...w })),
  };
  oneTimeTasks.set(id, full);
  notify();
  return full;
}

export function updateOneTimeTask(id: string, patch: Partial<Omit<OneTimeTask, 'id'>>): void {
  const ot = oneTimeTasks.get(id);
  if (!ot) return;
  pushSnapshot();
  Object.assign(ot, patch);
  if (patch.loadWindows) {
    ot.loadWindows = patch.loadWindows.map((w) => ({ ...w }));
  }
  if (patch.baseLoadWeight !== undefined) {
    ot.baseLoadWeight = Math.max(0, Math.min(1, patch.baseLoadWeight));
  }
  notify();
}

export function removeOneTimeTask(id: string): void {
  if (!oneTimeTasks.has(id)) return;
  pushSnapshot();
  oneTimeTasks.delete(id);
  notify();
}

export function getOneTimeTask(id: string): OneTimeTask | undefined {
  return oneTimeTasks.get(id);
}

export function getAllOneTimeTasks(): OneTimeTask[] {
  return [...oneTimeTasks.values()];
}

// ─── Slot / Sub-Team helpers ─────────────────────────────────────────────────

export function addSlotToTemplate(templateId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromTemplate(templateId: string, slotId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.slots = tpl.slots.filter((s) => s.id !== slotId);
  notify();
}

export function addSubTeamToTemplate(templateId: string, name: string): SubTeamTemplate {
  const tpl = taskTemplates.get(templateId);
  const st: SubTeamTemplate = { id: uid('st'), name, slots: [] };
  if (tpl) {
    pushSnapshot();
    tpl.subTeams.push(st);
    notify();
  }
  return st;
}

export function removeSubTeamFromTemplate(templateId: string, subTeamId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.subTeams = tpl.subTeams.filter((s) => s.id !== subTeamId);
  notify();
}

export function addSlotToSubTeam(templateId: string, subTeamId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  const st = tpl.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromSubTeam(templateId: string, subTeamId: string, slotId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  const st = tpl.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots = st.slots.filter((s) => s.id !== slotId);
  notify();
}

// ─── One-Time Task Slot / Sub-Team helpers ──────────────────────────────────

export function addSlotToOneTimeTask(otId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  pushSnapshot();
  ot.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromOneTimeTask(otId: string, slotId: string): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  pushSnapshot();
  ot.slots = ot.slots.filter((s) => s.id !== slotId);
  notify();
}

export function addSubTeamToOneTimeTask(otId: string, name: string): SubTeamTemplate {
  const ot = oneTimeTasks.get(otId);
  const st: SubTeamTemplate = { id: uid('st'), name, slots: [] };
  if (ot) {
    pushSnapshot();
    ot.subTeams.push(st);
    notify();
  }
  return st;
}

export function removeSubTeamFromOneTimeTask(otId: string, subTeamId: string): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  pushSnapshot();
  ot.subTeams = ot.subTeams.filter((s) => s.id !== subTeamId);
  notify();
}

export function addSlotToOneTimeSubTeam(otId: string, subTeamId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  const st = ot.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromOneTimeSubTeam(otId: string, subTeamId: string, slotId: string): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  const st = ot.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots = st.slots.filter((s) => s.id !== slotId);
  notify();
}

// ─── Slot Update helpers ─────────────────────────────────────────────────────

type SlotPatch = Omit<SlotTemplate, 'id'>;

function replaceSlotIfExists(slots: SlotTemplate[], slotId: string, patch: SlotPatch): boolean {
  const idx = slots.findIndex((s) => s.id === slotId);
  if (idx === -1) return false;
  pushSnapshot();
  slots[idx] = { ...patch, id: slotId };
  notify();
  return true;
}

export function updateSlotInTemplate(templateId: string, slotId: string, patch: SlotPatch): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  replaceSlotIfExists(tpl.slots, slotId, patch);
}

export function updateSlotInSubTeam(templateId: string, subTeamId: string, slotId: string, patch: SlotPatch): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  const st = tpl.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  replaceSlotIfExists(st.slots, slotId, patch);
}

export function updateSlotInOneTimeTask(otId: string, slotId: string, patch: SlotPatch): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  replaceSlotIfExists(ot.slots, slotId, patch);
}

export function updateSlotInOneTimeSubTeam(otId: string, subTeamId: string, slotId: string, patch: SlotPatch): void {
  const ot = oneTimeTasks.get(otId);
  if (!ot) return;
  const st = ot.subTeams.find((s) => s.id === subTeamId);
  if (!st) return;
  replaceSlotIfExists(st.slots, slotId, patch);
}

// ─── Seed Default Data ───────────────────────────────────────────────────────

const defaultNames: string[] = [
  'איתי לוין',
  'נועה אברהמי',
  'עידו כהן',
  'מאיה ישראלי',
  'יונתן רפאלי',
  'עדי מזרחי',
  'רועי שפירא',
  'מיכל אשכנזי',
  'עומר דרוקר',
  'ענבר חזן',
  'אורי גבאי',
  'טל בן-דור',
  'דניאל וייס',
  'שירה אדרי',
  'אסף גרינברג',
  'ליאור פלד',
  'נדב הראל',
  'רוני סגל',
  'גיא מור',
  'יעל שלום',
  'אלון ברק',
  'הילה חדד',
  'מתן אלוני',
  'שחר עמר',
  'איתן דהן',
  'עמית מלכה',
  'יובל קליין',
  'נטע לביא',
  'דורון פרידמן',
  'קרן אורן',
  'אריאל נחום',
  'דנה צור',
  'אביב סוויסה',
  'גלית שדה',
  'תומר גולן',
  'ספיר מלמד',
  'אופיר ביטון',
  'נועם פרץ',
  'אייל רוזנפלד',
  'ליהי כץ',
  'בועז נאמן',
  'תמר יוספי',
  'יואב פולק',
  'סיון ריבלין',
  'אוהד שטרן',
  'רותם גנות',
  'ברק אוריון',
  'נעמה שקד',
];

const DEFAULT_L0_PAKAL_ASSIGNMENTS_BY_GROUP: Record<string, string[]> = {
  //                    L0idx: 0             1              2             3                4                5               6              7(unused)
  // Horesh cert at L0 indices 3,4 (template 8,9) — must align with HORESH_PAKAL_ID positions
  'קבוצה 1': [
    'pakal-matol',
    'pakal-negev',
    'pakal-kala',
    HORESH_PAKAL_ID,
    HORESH_PAKAL_ID,
    'pakal-rahpan',
    'pakal-matol',
    'pakal-negev',
  ],
  // Horesh cert at L0 index 3 (template 8)
  'קבוצה 2': [
    'pakal-matol',
    'pakal-negev',
    'pakal-kala',
    HORESH_PAKAL_ID,
    'pakal-mag',
    'pakal-matol',
    'pakal-kala',
    'pakal-til-lao',
  ],
  // Horesh cert at L0 index 3 (template 8)
  'קבוצה 3': [
    'pakal-matol',
    'pakal-negev',
    'pakal-kala',
    HORESH_PAKAL_ID,
    'pakal-matol',
    'pakal-negev',
    'pakal-mag',
    'pakal-matol',
  ],
  // No Horesh cert
  'קבוצה 4': [
    'pakal-matol',
    'pakal-negev',
    'pakal-kala',
    'pakal-rahpan',
    'pakal-til-lao',
    'pakal-matol',
    'pakal-kala',
    'pakal-matol',
  ],
};

function isDefaultParticipantRoster(entries: Array<{ name: string }>): boolean {
  return entries.length === defaultNames.length && entries.every((entry, index) => entry.name === defaultNames[index]);
}

function hasDesiredDefaultL0PakalSeed(
  entries: Array<{ name: string; level: Level; group: string; pakalIds?: string[] }>,
): boolean {
  if (!isDefaultParticipantRoster(entries)) return false;

  const groupIndices = new Map<string, number>();
  for (const entry of entries) {
    if (entry.level !== Level.L0) {
      if ((entry.pakalIds?.length ?? 0) > 0) return false;
      continue;
    }

    const nextIndex = groupIndices.get(entry.group) ?? 0;
    const expectedPakalId = DEFAULT_L0_PAKAL_ASSIGNMENTS_BY_GROUP[entry.group]?.[nextIndex];
    const actualPakalIds = entry.pakalIds || [];
    if (!expectedPakalId || actualPakalIds.length !== 1 || actualPakalIds[0] !== expectedPakalId) return false;
    groupIndices.set(entry.group, nextIndex + 1);
  }

  return true;
}

function needsDefaultL0PakalSeed(
  entries: Array<{ name: string; level: Level; group: string; pakalIds?: string[] }>,
): boolean {
  return isDefaultParticipantRoster(entries) && !hasDesiredDefaultL0PakalSeed(entries);
}

function applyDefaultL0PakalSeed<T extends { name: string; level: Level; group: string; pakalIds?: string[] }>(
  entries: T[],
): T[] {
  const groupIndices = new Map<string, number>();

  return entries.map((entry) => {
    if (entry.level !== Level.L0) return entry;
    const nextIndex = groupIndices.get(entry.group) ?? 0;
    const pakalId = DEFAULT_L0_PAKAL_ASSIGNMENTS_BY_GROUP[entry.group]?.[nextIndex];
    groupIndices.set(entry.group, nextIndex + 1);
    return {
      ...entry,
      pakalIds: pakalId ? [pakalId] : [],
    };
  });
}

export function seedDefaultParticipants(): void {
  // 4 Departments × 12 participants = 48 total
  // Per department:
  //   1× L4 (Nitzan)
  //   1× L3 (Nitzan)
  //   3× L2 (Nitzan)
  //   1× L0 (Nitzan)
  //   2× L0 + Hamama (Nitzan)
  //   4× L0 standard (Nitzan)
  // All have Nitzan. 2 Hamama-certified L0.
  //
  // Horesh certification defaults:
  //   Dept A: 2 standard L0 participants (indices 8,9)
  //   Dept B: 1 standard L0 participant  (index 8)
  //   Dept C: 1 standard L0 participant  (index 8)
  //   Dept D: none

  const deptNames = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];

  interface MemberSpec {
    level: Level;
    certs: string[];
    tag: string;
  }
  const template: MemberSpec[] = [
    { level: Level.L4, certs: ['Nitzan', 'Hamama'], tag: 'L4' },
    { level: Level.L3, certs: ['Nitzan', 'Hamama'], tag: 'L3' },
    { level: Level.L2, certs: ['Nitzan', 'Hamama'], tag: 'L2' },
    { level: Level.L2, certs: ['Nitzan', 'Hamama'], tag: 'L2' },
    { level: Level.L2, certs: ['Nitzan', 'Hamama'], tag: 'L2' },
    { level: Level.L0, certs: ['Nitzan'], tag: 'L0' },
    { level: Level.L0, certs: ['Nitzan', 'Hamama'], tag: 'L0-Hamama' },
    { level: Level.L0, certs: ['Nitzan', 'Hamama'], tag: 'L0-Hamama' },
    { level: Level.L0, certs: ['Nitzan'], tag: 'L0' },
    { level: Level.L0, certs: ['Nitzan'], tag: 'L0' },
    { level: Level.L0, certs: ['Nitzan'], tag: 'L0' },
    { level: Level.L0, certs: ['Nitzan'], tag: 'L0' },
  ];

  // Horesh certification per department: set of template indices
  const horeshByDept: Record<string, Set<number>> = {
    'קבוצה 1': new Set([8, 9]), // 2 standard L0 participants
    'קבוצה 2': new Set([8]), // 1 standard L0 participant
    'קבוצה 3': new Set([8]), // 1 standard L0 participant
  };

  let nameIdx = 0;
  const l0PakalIndexByDept = new Map<string, number>();
  for (const dept of deptNames) {
    const horeshIndices = horeshByDept[dept];
    template.forEach((spec, i) => {
      const id = uid('p');
      const certs = [...spec.certs];
      if (horeshIndices?.has(i)) certs.push('Horesh');
      const nextL0Index = l0PakalIndexByDept.get(dept) ?? 0;
      const pakalId = spec.level === Level.L0 ? DEFAULT_L0_PAKAL_ASSIGNMENTS_BY_GROUP[dept]?.[nextL0Index] : undefined;
      if (spec.level === Level.L0) l0PakalIndexByDept.set(dept, nextL0Index + 1);
      const p: Participant = {
        id,
        name: defaultNames[nameIdx++],
        level: spec.level,
        certifications: certs,
        pakalIds: pakalId ? [pakalId] : [],
        group: dept,
        availability: getDefaultAvailability(),
        dateUnavailability: [],
      };
      participants.set(id, p);
    });
  }
  notify();
}

export function seedDefaultTaskTemplates(): void {
  // Seed default rest rule (HC-14) — 5-hour minimum gap
  const defaultRestRule: RestRule = { id: uid('rr'), label: 'הפסקה מינימלית', durationHours: 5 };
  _restRules.push(defaultRestRule);

  // Adanit
  addTaskTemplate({
    name: 'אדנית',

    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: true,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [
      {
        id: uid('st'),
        name: 'סגול ראשי',
        slots: [
          {
            id: uid('slot'),
            label: 'משתתף בסגול א',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: ['Nitzan'],
          },
          {
            id: uid('slot'),
            label: 'משתתף בסגול א',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: ['Nitzan'],
          },
          {
            id: uid('slot'),
            label: 'סגל בסגול א',
            acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
            requiredCertifications: ['Nitzan'],
          },
        ],
      },
      {
        id: uid('st'),
        name: 'סגול משני',
        slots: [
          {
            id: uid('slot'),
            label: 'משתתף בסגול ב',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: ['Nitzan'],
          },
          {
            id: uid('slot'),
            label: 'משתתף בסגול ב',
            acceptableLevels: [{ level: Level.L0 }],
            requiredCertifications: ['Nitzan'],
          },
          {
            id: uid('slot'),
            label: "בכיר בסגול ב'",
            acceptableLevels: [{ level: Level.L2 }],
            requiredCertifications: ['Nitzan'],
          },
        ],
      },
    ],
    slots: [],
    restRuleId: defaultRestRule.id,
    displayCategory: 'patrol',
    color: '#4A90D9',
    displayOrder: 0,
  });

  // Hamama
  addTaskTemplate({
    name: 'חממה',

    durationHours: 12,
    shiftsPerDay: 2,
    startHour: 6,
    sameGroupRequired: false,
    baseLoadWeight: 5 / 6,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'חממה מפעיל',
        acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
        requiredCertifications: ['Hamama'],
      },
    ],
    displayCategory: 'hamama',
    color: '#E74C3C',
    displayOrder: 1,
  });

  // Shemesh
  addTaskTemplate({
    name: 'שמש',

    durationHours: 4,
    shiftsPerDay: 6,
    startHour: 5,
    sameGroupRequired: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'משתתף בשמש',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בשמש',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    restRuleId: defaultRestRule.id,
    displayCategory: 'shemesh',
    color: '#F39C12',
    displayOrder: 4,
  });

  // Mamtera
  addTaskTemplate({
    name: 'ממטרה',

    durationHours: 14,
    shiftsPerDay: 1,
    startHour: 9,
    sameGroupRequired: false,
    baseLoadWeight: 0.64,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'משתתף בממטרה',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: ['Horesh'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בממטרה',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: ['Horesh'],
      },
    ],
    displayCategory: 'mamtera',
    color: '#27AE60',
    displayOrder: 3,
  });

  // Karov
  addTaskTemplate({
    name: 'כרוב',

    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: true,
    baseLoadWeight: 1 / 3,
    blocksConsecutive: false,
    loadWindows: [
      {
        id: uid('lw'),
        startHour: 5,
        startMinute: 0,
        endHour: 6,
        endMinute: 30,
        weight: 1,
      },
      {
        id: uid('lw'),
        startHour: 17,
        startMinute: 0,
        endHour: 18,
        endMinute: 30,
        weight: 1,
      },
    ],
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'מפקד כרוב (דרגה 2/3/4)',
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בכרוב',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בקרוב',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    displayCategory: 'patrol',
    color: '#8E44AD',
    displayOrder: 0,
  });

  // Karovit
  addTaskTemplate({
    name: 'כרובית',

    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: true,
    baseLoadWeight: 0,
    loadWindows: [],
    blocksConsecutive: false,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'סגל כרובית',
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בכרובית',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בכרובית',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בכרובית',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    displayCategory: 'patrol',
    color: '#BDC3C7',
    displayOrder: 0,
  });

  // ערוגת בוקר
  addTaskTemplate({
    name: 'ערוגת בוקר',

    durationHours: 1.5,
    shiftsPerDay: 1,
    startHour: 5,
    sameGroupRequired: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'משתתף בערוגת בוקר',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בערוגת בוקר',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    displayCategory: 'aruga',
    color: '#1ABC9C',
    displayOrder: 2,
  });

  // ערוגת ערב
  addTaskTemplate({
    name: 'ערוגת ערב',

    durationHours: 1.5,
    shiftsPerDay: 1,
    startHour: 17,
    sameGroupRequired: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      {
        id: uid('slot'),
        label: 'משתתף בערוגת ערב',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
      {
        id: uid('slot'),
        label: 'משתתף בערוגת ערב',
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    displayCategory: 'aruga',
    color: '#1ABC9C',
    displayOrder: 2,
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────

let _initRunning = false;

export function initStore(): void {
  if (_initRunning) {
    console.warn('[Store] initStore() re-entrance blocked');
    return;
  }
  _initRunning = true;
  try {
    participants.clear();
    dateUnavailabilities.clear();
    taskTemplates.clear();
    oneTimeTasks.clear();
    pakalDefinitions = clonePakalDefinitions(DEFAULT_PAKAL_DEFINITIONS);
    undoStack.length = 0;
    redoStack.length = 0;
    // Reset lazy-loaded participant sets so they re-initialise
    _participantSets = null;
    _activeParticipantSetId = undefined;
    // Reset lazy-loaded task sets so they re-initialise
    _taskSets = null;
    _activeTaskSetId = undefined;
    // Try to load from storage first
    if (loadFromStorage()) {
      console.log('[Store] Restored state from localStorage');
      // Ensure participant sets are initialised (first-load seeding)
      _initParticipantSets();
      _initTaskSets();
      return;
    }
    // Suppress snapshots during seed (initial state shouldn't be undoable)
    _suppressSnapshot = true;
    seedDefaultParticipants();
    seedDefaultTaskTemplates();
    // Seed built-in participant set from demo data
    _initParticipantSets();
    _initTaskSets();
  } finally {
    _suppressSnapshot = false;
    _initRunning = false;
  }
}

// ─── Live Mode State ─────────────────────────────────────────────────────────

let liveModeState: LiveModeState = {
  enabled: false,
  currentTimestamp: new Date(),
};

export function getLiveModeState(): LiveModeState {
  return { ...liveModeState, currentTimestamp: new Date(liveModeState.currentTimestamp.getTime()) };
}

export function setLiveModeEnabled(enabled: boolean): void {
  liveModeState.enabled = enabled;
  // Always refresh timestamp to "now" so the day picker reflects the current day
  liveModeState.currentTimestamp = new Date();
  // Persist to the dedicated tiny key rather than rewriting the full state
  // blob. The live-mode checkbox handler in app.ts already calls renderAll().
  _saveLiveMode();
}

export function setLiveModeTimestamp(timestamp: Date): void {
  liveModeState.currentTimestamp = timestamp;
  // Persist to the dedicated tiny key rather than rewriting the full state
  // blob. The caller already triggers renderAll() when needed.
  _saveLiveMode();
}

/**
 * Persist live-mode state to its own small localStorage key.
 * Kept separate from `saveToStorage()` so that live-mode ticks (which can
 * happen every few seconds) don't rewrite the much larger full-state blob.
 */
function _saveLiveMode(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY_LIVE_MODE,
      JSON.stringify({
        enabled: liveModeState.enabled,
        currentTimestamp: liveModeState.currentTimestamp.toISOString(),
      }),
    );
    onSaveSuccess();
  } catch (err) {
    console.warn('[Store] Failed to save live mode:', err);
    reportSaveError(err);
  }
}

function _loadLiveMode(): LiveModeState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LIVE_MODE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { enabled?: unknown; currentTimestamp?: unknown };
    const ts = typeof parsed.currentTimestamp === 'string' ? new Date(parsed.currentTimestamp) : new Date();
    return {
      enabled: !!parsed.enabled,
      currentTimestamp: Number.isNaN(ts.getTime()) ? new Date() : ts,
    };
  } catch (err) {
    console.warn('[Store] Failed to load live mode:', err);
    return null;
  }
}

// ─── localStorage Persistence ────────────────────────────────────────────────

const STORAGE_KEY_STATE = 'gardenmanager_state';
const STORAGE_KEY_SCHEDULE = 'gardenmanager_schedule';
const STORAGE_KEY_LIVE_MODE = 'gardenmanager_live_mode';

let _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

/**
 * Deep-serialize dates to ISO strings in a JSON-compatible way.
 * Uses a replacer function so Date objects in nested structures are handled.
 *
 * NOTE: This serializer (with its `{ __date__: ... }` markers and matching
 * `jsonDeserialize` reviver) is used only for the Schedule blob, whose
 * shape has Dates at arbitrary nesting depths.  The state blob
 * (`saveToStorage`) uses manual `.toISOString()` + plain `JSON.parse`
 * because its structure is flat and well-known.  The two persistence
 * paths are intentionally separate — do not unify without updating both
 * the save and load sides.
 */
export function jsonSerialize(obj: unknown): string {
  // Must use a regular function (not arrow) so `this` is the holder object.
  // JSON.stringify calls Date.toJSON() *before* the replacer sees the value,
  // so `value` is already a string for Dates.  `this[key]` gives the raw Date.
  return JSON.stringify(obj, function (key, value) {
    const raw = this[key];
    if (raw instanceof Date) {
      return { __date__: raw.toISOString() };
    }
    return value;
  });
}

/**
 * Deep-deserialize ISO date strings back to Date objects.
 * Uses a reviver function that matches the serialization format.
 */
export function jsonDeserialize<T>(json: string): T {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && '__date__' in value) {
      return new Date(value.__date__);
    }
    return value;
  }) as T;
}

/**
 * Save the full store state to localStorage.
 * Called automatically (debounced) after every store mutation.
 */
export function saveToStorage(): void {
  // When the quota is exhausted, _storageWedged is true. We still attempt the
  // write so that onSaveSuccess() can clear the wedge once space is freed.
  // Toast flooding is prevented by the cooldown in reportSaveError().
  try {
    const state = {
      version: 7,
      scheduleDate: scheduleDate.toISOString(),
      scheduleDays,
      restRules: _restRules,
      // Live mode is persisted separately via STORAGE_KEY_LIVE_MODE; keeping
      // it out of the big blob means clock ticks don't rewrite everything.
      pakalDefinitions,
      certificationDefinitions,
      // Omit inline dateUnavailability from participant serialization —
      // the dateUnavailabilities Map is the single source of truth
      // (serialized separately below).
      participants: Array.from(participants.values()).map((p) => {
        const { dateUnavailability: _, ...rest } = p;
        return {
          ...rest,
          availability: p.availability.map((w) => ({
            start: w.start.toISOString(),
            end: w.end.toISOString(),
          })),
        };
      }),
      dateUnavailabilities: Array.from(dateUnavailabilities.entries()).map(([pid, rules]) => ({
        pid,
        rules: rules.map(({ id: _, ...rest }) => rest),
      })),
      taskTemplates: Array.from(taskTemplates.values()),
      oneTimeTasks: Array.from(oneTimeTasks.values()).map((ot) => ({
        ...ot,
        scheduledDate: ot.scheduledDate.toISOString(),
      })),
      notWithPairs: Array.from(notWithPairs.entries()).map(([pid, set]) => ({
        pid,
        targets: [...set],
      })),
    };
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
    onSaveSuccess();
  } catch (err) {
    console.warn('[Store] Failed to save to localStorage:', err);
    reportSaveError(err);
  }
}

/**
 * Load the full store state from localStorage.
 * Returns true if state was successfully restored.
 */
export function loadFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    if (!raw) return false;

    const state = JSON.parse(raw);
    if (!state || state.version !== 7) return false;

    // Restore schedule date/days
    scheduleDate = new Date(state.scheduleDate);
    scheduleDays = state.scheduleDays || 7;
    _restRules = Array.isArray(state.restRules) ? state.restRules : [];

    // Reset stale schedule dates to the next upcoming Sunday:
    // (a) Non-Sunday dates can result from continuity replanning ("generate from
    //     day X"), which shifts scheduleDate mid-week. Since the schedule output
    //     is cleared on every app restart, this mid-week date is no longer relevant.
    // (b) Schedule dates whose entire window has elapsed are also outdated.
    const schedEndForStaleness = new Date(
      scheduleDate.getFullYear(),
      scheduleDate.getMonth(),
      scheduleDate.getDate() + scheduleDays,
    );
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    if (scheduleDate.getDay() !== 0 || schedEndForStaleness < todayMidnight) {
      scheduleDate = defaultScheduleDate();
    }

    // Restore live mode state — prefer the dedicated key (written by
    // _saveLiveMode); fall back to the legacy inlined value for users whose
    // state blob was persisted before the split.
    const dedicatedLive = _loadLiveMode();
    if (dedicatedLive) {
      liveModeState = dedicatedLive;
    } else if (state.liveMode) {
      liveModeState = {
        enabled: state.liveMode.enabled || false,
        currentTimestamp: new Date(state.liveMode.currentTimestamp),
      };
    }

    // Restore participants
    participants.clear();
    dateUnavailabilities.clear();
    pakalDefinitions = state.pakalDefinitions?.length
      ? normalizePakalDefinitions(state.pakalDefinitions)
      : clonePakalDefinitions(DEFAULT_PAKAL_DEFINITIONS);
    certificationDefinitions = (
      state.certificationDefinitions?.length ? state.certificationDefinitions : DEFAULT_CERTIFICATION_DEFINITIONS
    ).map((d: CertificationDefinition) => ({ ...d }));

    for (const pData of Array.isArray(state.participants) ? state.participants : []) {
      const p: Participant = {
        ...pData,
        pakalIds: sanitizePakalIds(pData.pakalIds, pakalDefinitions),
        availability: (pData.availability || []).map((w: { start: string; end: string }) => ({
          start: new Date(w.start),
          end: new Date(w.end),
        })),
        dateUnavailability: [],
      };
      participants.set(p.id, p);
    }

    // Restore date unavailabilities
    const duList = Array.isArray(state.dateUnavailabilities) ? state.dateUnavailabilities : [];
    for (const entry of duList) {
      const rules: DateUnavailability[] = (entry.rules || [])
        .map((rule: Partial<Omit<DateUnavailability, 'id'>>) => normalizeDateUnavailabilityRule(rule))
        .filter((rule: Omit<DateUnavailability, 'id'> | null): rule is Omit<DateUnavailability, 'id'> => !!rule)
        .map((rule: Omit<DateUnavailability, 'id'>) => ({ ...rule, id: uid('du') }));
      if (rules.length > 0) {
        dateUnavailabilities.set(entry.pid, rules);
      }
    }

    // Sync participant inline dateUnavailability to the canonical Map
    // so both references stay aligned.
    for (const [id, p] of participants) {
      p.dateUnavailability = dateUnavailabilities.get(id) || [];
    }

    // Restore task templates
    taskTemplates.clear();
    for (const tpl of Array.isArray(state.taskTemplates) ? state.taskTemplates : []) {
      taskTemplates.set(tpl.id, tpl);
    }

    // Restore one-time tasks
    oneTimeTasks.clear();
    for (const ot of Array.isArray(state.oneTimeTasks) ? state.oneTimeTasks : []) {
      oneTimeTasks.set(ot.id, {
        ...ot,
        scheduledDate: new Date(ot.scheduledDate),
        loadWindows: (ot.loadWindows || []).map((w: any) => ({ ...w })),
        slots: (ot.slots || []).map((s: any) => ({
          ...s,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
        })),
        subTeams: (ot.subTeams || []).map((st: any) => ({
          ...st,
          slots: st.slots.map((s: any) => ({
            ...s,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
          })),
        })),
      });
    }

    // Restore notWithPairs
    notWithPairs.clear();
    for (const entry of Array.isArray(state.notWithPairs) ? state.notWithPairs : []) {
      if (entry.pid && Array.isArray(entry.targets) && entry.targets.length > 0) {
        notWithPairs.set(entry.pid, new Set(entry.targets));
      }
    }
    syncNotWithToParticipants();

    // Recompute availability from canonical inputs instead of using the
    // stale windows that were serialized at save time.
    recalcAllAvailability();

    return true;
  } catch (err) {
    console.warn('[Store] Failed to load from localStorage:', err);
    return false;
  }
}

/**
 * Save a full Schedule object to localStorage.
 * Called after generation, swaps, locks, and rescue-apply operations.
 */
export function saveSchedule(schedule: Schedule): boolean {
  try {
    localStorage.setItem(STORAGE_KEY_SCHEDULE, jsonSerialize(schedule));
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save schedule to localStorage:', err);
    reportSaveError(err);
    return false;
  }
}

export function clearSchedule(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_SCHEDULE);
  } catch (err) {
    console.warn('[Store] Failed to clear schedule from localStorage:', err);
  }
}

/**
 * Load a saved Schedule from localStorage.
 * Returns null if no schedule is saved or deserialization fails.
 */
export function loadSchedule(): Schedule | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SCHEDULE);
    if (!raw) return null;
    return jsonDeserialize<Schedule>(raw);
  } catch (err) {
    console.warn('[Store] Failed to load schedule from localStorage:', err);
    return null;
  }
}

/**
 * Clear all persisted state (reset to defaults on next load).
 * Delegates to factoryReset() so every reset path is comprehensive.
 */
export function clearStorage(): void {
  factoryReset();
}

/**
 * Full factory reset: clear ALL persisted data and in-memory caches,
 * including UI preferences (theme, sidebar, default attempts).
 * After calling this, a page reload will re-seed default data via initStore().
 */
export function factoryReset(): void {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  try {
    localStorage.removeItem(STORAGE_KEY_STATE);
    localStorage.removeItem(STORAGE_KEY_SCHEDULE);
    localStorage.removeItem(STORAGE_KEY_LIVE_MODE);
    localStorage.removeItem(STORAGE_KEY_ALGORITHM);
    localStorage.removeItem(STORAGE_KEY_PRESETS);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET);
    localStorage.removeItem(STORAGE_KEY_SNAPSHOTS);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_SNAPSHOT);
    localStorage.removeItem(STORAGE_KEY_PSETS);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_PSET);
    localStorage.removeItem(STORAGE_KEY_TASK_SETS);
    localStorage.removeItem(STORAGE_KEY_ACTIVE_TASK_SET);
    localStorage.removeItem('gardenmanager_default_attempts');
    localStorage.removeItem('gardenmanager_theme');
    localStorage.removeItem('gm-sidebar-collapsed');
    // A factory reset frees space, so clear the wedge latch to resume saves.
    onSaveSuccess();
  } catch (err) {
    console.warn('[Store] Failed to clear localStorage:', err);
  }
  participants.clear();
  dateUnavailabilities.clear();
  notWithPairs.clear();
  taskTemplates.clear();
  oneTimeTasks.clear();
  pakalDefinitions = clonePakalDefinitions(DEFAULT_PAKAL_DEFINITIONS);
  certificationDefinitions = DEFAULT_CERTIFICATION_DEFINITIONS.map((d) => ({ ...d }));
  undoStack.length = 0;
  redoStack.length = 0;
  _algorithmSettings = null;
  _presets = null;
  _activePresetId = undefined;
  _snapshots = null;
  _activeSnapshotId = undefined;
  _participantSets = null;
  _activeParticipantSetId = undefined;
  _taskSets = null;
  _activeTaskSetId = undefined;
  _restRules = [];
  scheduleDate = defaultScheduleDate();
  scheduleDays = 7;
  liveModeState = { enabled: false, currentTimestamp: new Date() };
}

/**
 * Schedule a debounced save to localStorage.
 * Called from notify() so every store mutation triggers persistence.
 */
function debouncedSave(): void {
  // While wedged, skip debounced auto-saves to avoid repeated serialization
  // of data that will fail anyway. The wedge is cleared when an explicit
  // saveToStorage() call (or saveSchedule, etc.) succeeds.
  if (_storageWedged) return;
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    saveToStorage();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced save immediately.
 * Used by beforeunload to avoid losing the last mutation.
 */
export function flushPendingSave(): void {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
    saveToStorage();
  }
}

// ─── Algorithm Settings (separate from undo/redo) ────────────────────────────

const STORAGE_KEY_ALGORITHM = 'gardenmanager_algorithm';

let _algorithmSettings: AlgorithmSettings | null = null;

/**
 * Get current algorithm settings (lazy-loaded from localStorage).
 * Returns a deep copy so mutations don't leak.
 */
export function getAlgorithmSettings(): AlgorithmSettings {
  if (!_algorithmSettings) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ALGORITHM);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AlgorithmSettings>;
        // Merge with defaults to handle any newly-added fields
        _algorithmSettings = {
          config: { ...DEFAULT_ALGORITHM_SETTINGS.config, ...(parsed.config || {}) },
          disabledHardConstraints: Array.isArray(parsed.disabledHardConstraints)
            ? (parsed.disabledHardConstraints as HardConstraintCode[])
            : [],
          dayStartHour:
            typeof parsed.dayStartHour === 'number'
              ? Math.max(0, Math.min(23, Math.floor(parsed.dayStartHour)))
              : DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
        };
      } else {
        _algorithmSettings = {
          config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
          disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
          dayStartHour: DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
        };
      }
    } catch {
      _algorithmSettings = {
        config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
        disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
        dayStartHour: DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
      };
    }
  }
  return {
    config: { ..._algorithmSettings.config },
    disabledHardConstraints: [..._algorithmSettings.disabledHardConstraints],
    dayStartHour: _algorithmSettings.dayStartHour,
  };
}

/**
 * Update algorithm settings (partial merge). Persists immediately.
 * Does NOT fire notify() — changes take effect on next generate/revalidate.
 * Fires notifyAlgorithmChanged() so the UI can mark the schedule as stale.
 */
export function setAlgorithmSettings(patch: Partial<AlgorithmSettings>): void {
  const current = getAlgorithmSettings();
  _algorithmSettings = {
    config: patch.config ? { ...current.config, ...patch.config } : current.config,
    disabledHardConstraints:
      patch.disabledHardConstraints !== undefined
        ? [...patch.disabledHardConstraints]
        : current.disabledHardConstraints,
    dayStartHour: patch.dayStartHour !== undefined ? patch.dayStartHour : current.dayStartHour,
  };
  _saveAlgorithmSettings();
  notifyAlgorithmChanged();
}

/**
 * Reset algorithm settings to factory defaults. Persists immediately.
 * Also sets the active preset to the built-in Default.
 */
export function resetAlgorithmSettings(): void {
  _algorithmSettings = {
    config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
    disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
    dayStartHour: DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
  };
  _saveAlgorithmSettings();
  // Also switch active preset to Default
  _initPresets(); // ensure loaded
  _activePresetId = DEFAULT_PRESET.id;
  _saveActivePresetId();
  notifyAlgorithmChanged();
}

/**
 * Get the configured day-start hour (0-23). Convenience shorthand for
 * `getAlgorithmSettings().dayStartHour`.
 */
export function getDayStartHour(): number {
  return getAlgorithmSettings().dayStartHour;
}

/**
 * Build a Set of disabled hard constraint codes for efficient lookup.
 */
export function getDisabledHCSet(): Set<string> {
  const settings = getAlgorithmSettings();
  return new Set(settings.disabledHardConstraints);
}

function _saveAlgorithmSettings(): boolean {
  if (!_algorithmSettings) return false;
  try {
    localStorage.setItem(STORAGE_KEY_ALGORITHM, JSON.stringify(_algorithmSettings));
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save algorithm settings:', err);
    reportSaveError(err);
    return false;
  }
}

// ─── Algorithm Presets ───────────────────────────────────────────────────────

const STORAGE_KEY_PRESETS = 'gardenmanager_algorithm_presets';
const STORAGE_KEY_ACTIVE_PRESET = 'gardenmanager_active_preset_id';

let _presets: AlgorithmPreset[] | null = null;
let _activePresetId: string | null | undefined; // undefined = not yet loaded

/**
 * Hook for tab-algorithm to register its debounce-flush function.
 * Called before any save/update operation to ensure pending slider
 * changes are applied to the working copy first.
 */
let _flushPendingWeightUpdate: (() => void) | null = null;

export function registerWeightFlush(fn: () => void): void {
  _flushPendingWeightUpdate = fn;
}

function _flushWeights(): void {
  if (_flushPendingWeightUpdate) _flushPendingWeightUpdate();
}

/** Lazily initialise presets from localStorage, with first-load migration. */
function _initPresets(): AlgorithmPreset[] {
  if (_presets) return _presets;

  const raw = localStorage.getItem(STORAGE_KEY_PRESETS);
  if (raw) {
    try {
      _presets = JSON.parse(raw) as AlgorithmPreset[];
      // Ensure the built-in Default preset always exists
      if (!_presets.find((p) => p.id === DEFAULT_PRESET.id)) {
        _presets.unshift(_deepCopyPreset(DEFAULT_PRESET));
      }
    } catch {
      _presets = [_deepCopyPreset(DEFAULT_PRESET)];
    }
  } else {
    _presets = [_deepCopyPreset(DEFAULT_PRESET)];
    _activePresetId = DEFAULT_PRESET.id;
    _savePresets();
    _saveActivePresetId();
  }

  // Load active preset id if not already set by migration
  if (_activePresetId === undefined) {
    _activePresetId = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET) || DEFAULT_PRESET.id;
  }

  return _presets;
}

function _deepCopyPreset(p: AlgorithmPreset): AlgorithmPreset {
  return {
    ...p,
    settings: {
      config: { ...p.settings.config },
      disabledHardConstraints: [...p.settings.disabledHardConstraints],
      dayStartHour: p.settings.dayStartHour ?? DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
    },
  };
}

function _savePresets(): boolean {
  if (!_presets) return false;
  try {
    localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(_presets));
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save algorithm presets:', err);
    reportSaveError(err);
    return false;
  }
}

function _saveActivePresetId(): boolean {
  try {
    if (_activePresetId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, _activePresetId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET);
    }
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save active preset id:', err);
    reportSaveError(err);
    return false;
  }
}

/** Case-insensitive trimmed name duplicate check */
function _isPresetNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  const presets = _initPresets();
  return presets.some((p) => p.name.trim().toLowerCase() === norm && p.id !== excludeId);
}

// ─── Preset Public API ──────────────────────────────────────────────────────

/** Get all presets (built-in first, then by createdAt) */
export function getAllPresets(): AlgorithmPreset[] {
  const presets = _initPresets();
  return presets
    .slice()
    .sort((a, b) => {
      if (a.builtIn && !b.builtIn) return -1;
      if (!a.builtIn && b.builtIn) return 1;
      return a.createdAt - b.createdAt;
    })
    .map((p) => _deepCopyPreset(p));
}

/** Get a single preset by id */
export function getPresetById(id: string): AlgorithmPreset | undefined {
  const presets = _initPresets();
  const found = presets.find((p) => p.id === id);
  return found ? _deepCopyPreset(found) : undefined;
}

/** Get the active preset id (may be null if none) */
export function getActivePresetId(): string | null {
  _initPresets(); // ensure loaded
  return _activePresetId ?? null;
}

/**
 * Load a preset into the working copy.
 * Replaces algorithm settings entirely (not a partial merge).
 */
export function loadPreset(id: string): void {
  const preset = getPresetById(id);
  if (!preset) return;
  // Full replacement — not partial merge
  _algorithmSettings = {
    config: { ...preset.settings.config },
    disabledHardConstraints: [...preset.settings.disabledHardConstraints],
    dayStartHour:
      typeof preset.settings.dayStartHour === 'number'
        ? preset.settings.dayStartHour
        : DEFAULT_ALGORITHM_SETTINGS.dayStartHour,
  };
  _saveAlgorithmSettings();
  _activePresetId = id;
  _saveActivePresetId();
  notifyAlgorithmChanged();
}

/**
 * Save the current working copy as a new preset.
 * Returns the new preset, or null if the name is taken.
 */
export function saveCurrentAsPreset(name: string, description: string): AlgorithmPreset | null {
  _flushWeights();
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (_isPresetNameTaken(trimmed)) return null;

  const preset: AlgorithmPreset = {
    id: uid('preset'),
    name: trimmed,
    description: description.trim(),
    settings: getAlgorithmSettings(), // deep copy via getter
    createdAt: Date.now(),
  };

  const presets = _initPresets();
  const prevActiveId = _activePresetId;
  presets.push(preset);
  if (!_savePresets()) {
    presets.pop(); // rollback — keep in-memory and disk in sync
    return null;
  }

  _activePresetId = preset.id;
  if (!_saveActivePresetId()) {
    _activePresetId = prevActiveId; // partial rollback
  }

  return _deepCopyPreset(preset);
}

/**
 * Overwrite an existing preset's settings with the current working copy.
 * Returns false if preset not found or is built-in.
 */
export function updatePreset(id: string): boolean {
  _flushWeights();
  const presets = _initPresets();
  const idx = presets.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  if (presets[idx].builtIn) return false;

  const prevSettings = presets[idx].settings;
  presets[idx].settings = getAlgorithmSettings(); // deep copy via getter
  if (!_savePresets()) {
    presets[idx].settings = prevSettings; // rollback
    return false;
  }
  return true;
}

/**
 * Rename a preset. Returns null on success, or an error string.
 */
export function renamePreset(id: string, name: string, description: string): string | null {
  const presets = _initPresets();
  const preset = presets.find((p) => p.id === id);
  if (!preset) return 'סט לא נמצא';
  if (preset.builtIn) return 'לא ניתן לשנות שם של סט מובנה';

  const trimmed = name.trim();
  if (!trimmed) return 'השם לא יכול להיות ריק';
  if (_isPresetNameTaken(trimmed, id)) return 'סט עם שם זה כבר קיים';

  const prevName = preset.name;
  const prevDesc = preset.description;
  preset.name = trimmed;
  preset.description = description.trim();
  if (!_savePresets()) {
    preset.name = prevName; // rollback
    preset.description = prevDesc;
    return 'שמירה נכשלה — נפח האחסון בדפדפן מלא';
  }
  return null;
}

/**
 * Duplicate a preset with a unique name.
 * Returns the new preset.
 */
export function duplicatePreset(id: string): AlgorithmPreset | null {
  const source = getPresetById(id);
  if (!source) return null;

  const presets = _initPresets();
  let newName = source.name + ' (עותק)';
  let attempt = 2;
  while (_isPresetNameTaken(newName)) {
    newName = `${source.name} (עותק ${attempt++})`;
  }

  const dup: AlgorithmPreset = {
    id: uid('preset'),
    name: newName,
    description: source.description,
    settings: source.settings, // already a deep copy from getPresetById
    builtIn: false,
    createdAt: Date.now(),
  };
  presets.push(dup);
  if (!_savePresets()) {
    presets.pop(); // rollback
    return null;
  }
  return _deepCopyPreset(dup);
}

/**
 * Delete a preset. If it was the active one, load the Default preset.
 * Returns false if preset not found or is built-in.
 */
export function deletePreset(id: string): boolean {
  const presets = _initPresets();
  const idx = presets.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  if (presets[idx].builtIn) return false;

  const [removed] = presets.splice(idx, 1);
  if (!_savePresets()) {
    presets.splice(idx, 0, removed); // rollback
    return false;
  }

  if (_activePresetId === id) {
    loadPreset(DEFAULT_PRESET.id);
  }
  return true;
}

/**
 * Compare the current working copy against the active preset.
 * Returns true if they differ (preset is "dirty").
 * Survives page reloads because both sides come from localStorage.
 */
export function isPresetDirty(): boolean {
  const activeId = getActivePresetId();
  if (!activeId) return false;
  const preset = getPresetById(activeId);
  if (!preset) return false;
  return JSON.stringify(getAlgorithmSettings()) !== JSON.stringify(preset.settings);
}

// ─── Schedule Snapshots ─────────────────────────────────────────────────────

const STORAGE_KEY_SNAPSHOTS = 'gardenmanager_schedule_snapshots';
const STORAGE_KEY_ACTIVE_SNAPSHOT = 'gardenmanager_active_snapshot_id';
const MAX_SNAPSHOTS = 15;

let _snapshots: ScheduleSnapshot[] | null = null;
let _activeSnapshotId: string | null | undefined; // undefined = not yet loaded

/** Deep-copy a snapshot using JSON serialize round-trip (handles Dates). */
function _deepCopySnapshot(s: ScheduleSnapshot): ScheduleSnapshot {
  return jsonDeserialize<ScheduleSnapshot>(jsonSerialize(s));
}

/** Lazily initialise snapshots from localStorage. */
function _initSnapshots(): ScheduleSnapshot[] {
  if (_snapshots) return _snapshots;

  const raw = localStorage.getItem(STORAGE_KEY_SNAPSHOTS);
  if (raw) {
    try {
      _snapshots = jsonDeserialize<ScheduleSnapshot[]>(raw);
    } catch {
      _snapshots = [];
    }
  } else {
    _snapshots = [];
  }

  // Load active snapshot id
  if (_activeSnapshotId === undefined) {
    _activeSnapshotId = localStorage.getItem(STORAGE_KEY_ACTIVE_SNAPSHOT) || null;
  }

  return _snapshots;
}

function _saveSnapshots(): boolean {
  if (!_snapshots) return false;
  try {
    const blob = jsonSerialize(_snapshots);
    console.log(`[Store] Persisting ${_snapshots.length} snapshot(s), ${(blob.length / 1024).toFixed(1)} KB`);
    localStorage.setItem(STORAGE_KEY_SNAPSHOTS, blob);
    onSaveSuccess();
    return true;
  } catch (err: unknown) {
    if (isQuotaExceededError(err)) {
      console.warn('[Store] localStorage quota exceeded for snapshots. Consider deleting old snapshots.');
    } else {
      console.error('[Store] Failed to save schedule snapshots:', err);
    }
    reportSaveError(err);
    return false;
  }
}

function _saveActiveSnapshotId(): boolean {
  try {
    if (_activeSnapshotId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_SNAPSHOT, _activeSnapshotId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_SNAPSHOT);
    }
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save active snapshot id:', err);
    reportSaveError(err);
    return false;
  }
}

/** Case-insensitive trimmed name duplicate check */
function _isSnapshotNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  const snapshots = _initSnapshots();
  return snapshots.some((s) => s.name.trim().toLowerCase() === norm && s.id !== excludeId);
}

// ─── Snapshot Public API ────────────────────────────────────────────────────

/** Get all snapshots sorted by createdAt descending (newest first) */
export function getAllSnapshots(): ScheduleSnapshot[] {
  const snapshots = _initSnapshots();
  return snapshots
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => _deepCopySnapshot(s));
}

/** Get a single snapshot by id */
export function getSnapshotById(id: string): ScheduleSnapshot | undefined {
  const snapshots = _initSnapshots();
  const found = snapshots.find((s) => s.id === id);
  return found ? _deepCopySnapshot(found) : undefined;
}

/** Get the active snapshot id (may be null if none) */
export function getActiveSnapshotId(): string | null {
  _initSnapshots(); // ensure loaded
  return _activeSnapshotId ?? null;
}

/** Set the active snapshot id */
export function setActiveSnapshotId(id: string | null): void {
  _initSnapshots(); // ensure loaded
  _activeSnapshotId = id;
  _saveActiveSnapshotId();
}

/**
 * Save a schedule as a new named snapshot.
 * Returns the new snapshot, or null if the name is taken or limit reached,
 * or 'storage-full' if localStorage quota was exceeded.
 */
export function saveScheduleAsSnapshot(
  schedule: Schedule,
  name: string,
  description: string,
): ScheduleSnapshot | 'storage-full' | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) return null;
  if (_isSnapshotNameTaken(trimmed)) return null;

  const snapshots = _initSnapshots();
  if (snapshots.length >= MAX_SNAPSHOTS) {
    console.warn(`[Store] Snapshot limit reached (${MAX_SNAPSHOTS}). Delete older snapshots first.`);
    return null;
  }

  // Deep-copy the schedule via JSON round-trip. This can fail if the
  // schedule contains invalid Dates (toISOString → RangeError) or other
  // non-serializable values. Catch and report rather than crashing.
  let deepCopiedSchedule: Schedule;
  try {
    const serialized = jsonSerialize(schedule);
    console.log(`[Store] Snapshot schedule serialized: ${(serialized.length / 1024).toFixed(1)} KB`);
    deepCopiedSchedule = jsonDeserialize<Schedule>(serialized);
  } catch (err) {
    console.error('[Store] Failed to deep-copy schedule for snapshot — serialization error:', err);
    reportSaveError(err);
    return 'storage-full';
  }

  const snapshot: ScheduleSnapshot = {
    id: uid('snap'),
    name: trimmed,
    description: description.trim(),
    schedule: deepCopiedSchedule,
    createdAt: Date.now(),
  };

  snapshots.push(snapshot);
  if (!_saveSnapshots()) {
    snapshots.pop(); // rollback
    return 'storage-full';
  }

  _activeSnapshotId = snapshot.id;
  _saveActiveSnapshotId();

  return _deepCopySnapshot(snapshot);
}

/**
 * Overwrite an existing snapshot's schedule. Algorithm settings are embedded
 * in the schedule itself (see Schedule.algorithmSettings).
 * Returns false if snapshot not found or is built-in.
 */
export function updateSnapshot(id: string, schedule: Schedule): boolean {
  const snapshots = _initSnapshots();
  const idx = snapshots.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (snapshots[idx].builtIn) return false;

  const oldSchedule = snapshots[idx].schedule;

  snapshots[idx].schedule = jsonDeserialize<Schedule>(jsonSerialize(schedule));
  if (!_saveSnapshots()) {
    snapshots[idx].schedule = oldSchedule; // rollback
    return false;
  }
  return true;
}

/**
 * Rename a snapshot. Returns null on success, or an error string.
 */
export function renameSnapshot(id: string, name: string, description: string): string | null {
  const snapshots = _initSnapshots();
  const snapshot = snapshots.find((s) => s.id === id);
  if (!snapshot) return 'תמונת מצב לא נמצאה';
  if (snapshot.builtIn) return 'לא ניתן לשנות שם של תמונת מצב מובנית';

  const trimmed = name.trim();
  if (!trimmed) return 'השם לא יכול להיות ריק';
  if (trimmed.length > 100) return 'השם ארוך מדי (עד 100 תווים)';
  if (_isSnapshotNameTaken(trimmed, id)) return 'תמונת מצב עם שם זה כבר קיימת';

  const oldName = snapshot.name;
  const oldDesc = snapshot.description;
  snapshot.name = trimmed;
  snapshot.description = description.trim();
  if (!_saveSnapshots()) {
    snapshot.name = oldName; // rollback
    snapshot.description = oldDesc;
    return 'שמירה נכשלה — נפח האחסון בדפדפן מלא';
  }
  return null;
}

/**
 * Duplicate a snapshot with a unique name.
 * Returns the new snapshot.
 */
export function duplicateSnapshot(id: string): ScheduleSnapshot | null {
  const source = getSnapshotById(id);
  if (!source) return null;

  const snapshots = _initSnapshots();
  if (snapshots.length >= MAX_SNAPSHOTS) return null;

  let newName = source.name + ' (עותק)';
  let attempt = 2;
  while (_isSnapshotNameTaken(newName)) {
    newName = `${source.name} (עותק ${attempt++})`;
  }

  const dup: ScheduleSnapshot = {
    id: uid('snap'),
    name: newName,
    description: source.description,
    schedule: source.schedule, // already a deep copy from getSnapshotById; embeds algorithmSettings
    builtIn: false,
    createdAt: Date.now(),
  };
  snapshots.push(dup);
  if (!_saveSnapshots()) {
    snapshots.pop(); // rollback
    return null;
  }
  return _deepCopySnapshot(dup);
}

/**
 * Delete a snapshot. If it was the active one, clears active snapshot.
 * Returns false if snapshot not found or is built-in.
 */
export function deleteSnapshot(id: string): boolean {
  const snapshots = _initSnapshots();
  const idx = snapshots.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (snapshots[idx].builtIn) return false;

  const [removed] = snapshots.splice(idx, 1);
  if (!_saveSnapshots()) {
    snapshots.splice(idx, 0, removed); // rollback
    return false;
  }

  if (_activeSnapshotId === id) {
    _activeSnapshotId = null;
    _saveActiveSnapshotId();
  }
  return true;
}

/** Get the maximum number of snapshots allowed */
export function getMaxSnapshots(): number {
  return MAX_SNAPSHOTS;
}

// ─── Participant Sets ────────────────────────────────────────────────────────

const STORAGE_KEY_PSETS = 'gardenmanager_participant_sets';
const STORAGE_KEY_ACTIVE_PSET = 'gardenmanager_active_participant_set_id';
const MAX_PARTICIPANT_SETS = 30;

let _participantSets: ParticipantSet[] | null = null;
let _activeParticipantSetId: string | null | undefined; // undefined = not yet loaded

/** Deep-copy a ParticipantSet via JSON round-trip. */
function _deepCopyPSet(s: ParticipantSet): ParticipantSet {
  return JSON.parse(JSON.stringify(s)) as ParticipantSet;
}

function _normalizeParticipantSet(pset: ParticipantSet): ParticipantSet {
  const pakalCatalog = normalizePakalDefinitions(pset.pakalCatalog);
  const certificationCatalog = normalizeCertificationDefinitions(pset.certificationCatalog);
  const participants = (pset.participants || []).map((snap) => ({
    ...snap,
    pakalIds: sanitizePakalIds(snap.pakalIds, pakalCatalog),
    certifications: sanitizeCertificationIds(snap.certifications, certificationCatalog),
  }));

  return {
    ...pset,
    pakalCatalog,
    certificationCatalog,
    participants:
      pset.id === 'pset-default' && needsDefaultL0PakalSeed(participants)
        ? applyDefaultL0PakalSeed(participants)
        : participants,
  };
}

/** Lazily initialise participant sets from localStorage. */
function _initParticipantSets(): ParticipantSet[] {
  if (_participantSets) return _participantSets;

  const raw = localStorage.getItem(STORAGE_KEY_PSETS);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ParticipantSet[];
      _participantSets = Array.isArray(parsed) ? parsed.map(_normalizeParticipantSet) : [];
      const shouldPersistMigration =
        Array.isArray(parsed) &&
        parsed.some((pset) => pset.id === 'pset-default' && needsDefaultL0PakalSeed(pset.participants || []));
      if (shouldPersistMigration) _saveParticipantSets();
    } catch {
      _participantSets = [];
    }
  } else {
    // First load — create built-in set from current participants (demo data)
    _participantSets = [];
    _seedBuiltInParticipantSet();
  }

  // Load active set id
  if (_activeParticipantSetId === undefined) {
    _activeParticipantSetId = localStorage.getItem(STORAGE_KEY_ACTIVE_PSET) || null;
  }

  return _participantSets;
}

/** Snapshot the current in-memory participants into a ParticipantSnapshot array.
 *  IDs are stripped from dateUnavailability rules so that save→load→dirty-check
 *  comparisons work correctly (loaded rules get fresh IDs). */
function _snapshotCurrentParticipants(): ParticipantSnapshot[] {
  const all = getAllParticipants();
  return all.map((p) => {
    const dateRules = getDateUnavailabilities(p.id);
    return {
      name: p.name,
      level: p.level,
      certifications: [...p.certifications],
      group: p.group,
      dateUnavailability: dateRules.map(({ id: _, ...rest }) => rest),
      notWithIds:
        getNotWithIds(p.id).length > 0
          ? getNotWithIds(p.id)
              .map((id) => participants.get(id)?.name)
              .filter((n): n is string => !!n)
          : undefined,
      pakalIds: sanitizePakalIds(p.pakalIds, pakalDefinitions),
      preferredTaskName: p.preferredTaskName,
      lessPreferredTaskName: p.lessPreferredTaskName,
    };
  });
}

function _snapshotCurrentPakalCatalog(participantSnapshots: ParticipantSnapshot[]): PakalDefinition[] {
  const referencedIds = new Set<string>();
  for (const snap of participantSnapshots) {
    for (const pakalId of snap.pakalIds || []) referencedIds.add(pakalId);
  }
  return getPakalDefinitions().filter((def) => referencedIds.has(def.id));
}

function _snapshotCurrentCertificationCatalog(participantSnapshots: ParticipantSnapshot[]): CertificationDefinition[] {
  const referencedIds = new Set<string>();
  for (const snap of participantSnapshots) {
    for (const certId of snap.certifications) referencedIds.add(certId);
  }
  return certificationDefinitions.filter((def) => referencedIds.has(def.id)).map((def) => ({ ...def }));
}

/** Create the built-in default set from whatever participants are currently loaded. */
function _seedBuiltInParticipantSet(): void {
  const sets = _participantSets!;
  if (sets.find((s) => s.id === 'pset-default')) return;
  const snap = _snapshotCurrentParticipants();
  const pakalCatalog = _snapshotCurrentPakalCatalog(snap);
  if (snap.length === 0) return; // don't seed empty
  sets.unshift({
    id: 'pset-default',
    name: 'סט ברירת מחדל',
    description: 'המשתתפים המקוריים',
    participants: snap,
    pakalCatalog,
    certificationCatalog: _snapshotCurrentCertificationCatalog(snap),
    builtIn: true,
    createdAt: 0,
  });
  _saveParticipantSets();
}

function _saveParticipantSets(): boolean {
  if (!_participantSets) return false;
  try {
    localStorage.setItem(STORAGE_KEY_PSETS, JSON.stringify(_participantSets));
    onSaveSuccess();
    return true;
  } catch (err: unknown) {
    if (isQuotaExceededError(err)) {
      console.warn('[Store] localStorage quota exceeded for participant sets.');
    } else {
      console.warn('[Store] Failed to save participant sets:', err);
    }
    reportSaveError(err);
    return false;
  }
}

function _saveActiveParticipantSetId(): boolean {
  try {
    if (_activeParticipantSetId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PSET, _activeParticipantSetId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_PSET);
    }
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save active participant set id:', err);
    reportSaveError(err);
    return false;
  }
}

/** Case-insensitive trimmed name duplicate check */
function _isPSetNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  const sets = _initParticipantSets();
  return sets.some((s) => s.name.trim().toLowerCase() === norm && s.id !== excludeId);
}

// ─── Participant Sets Public API ─────────────────────────────────────────────

/** Get all participant sets (built-in first, then by createdAt) */
export function getAllParticipantSets(): ParticipantSet[] {
  const sets = _initParticipantSets();
  return sets
    .slice()
    .sort((a, b) => {
      if (a.builtIn && !b.builtIn) return -1;
      if (!a.builtIn && b.builtIn) return 1;
      return a.createdAt - b.createdAt;
    })
    .map((s) => _deepCopyPSet(s));
}

/** Get a single participant set by id */
export function getParticipantSetById(id: string): ParticipantSet | undefined {
  const sets = _initParticipantSets();
  const found = sets.find((s) => s.id === id);
  return found ? _deepCopyPSet(found) : undefined;
}

/** Get the active participant set id (may be null) */
export function getActiveParticipantSetId(): string | null {
  _initParticipantSets();
  return _activeParticipantSetId ?? null;
}

/**
 * Save the current participants as a new named set.
 * Returns the new set, or null if the name is taken or limit reached.
 */
export function saveCurrentAsParticipantSet(name: string, description: string): ParticipantSet | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (_isPSetNameTaken(trimmed)) return null;

  const sets = _initParticipantSets();
  if (sets.length >= MAX_PARTICIPANT_SETS) {
    console.warn(`[Store] Participant set limit reached (${MAX_PARTICIPANT_SETS}).`);
    return null;
  }

  const participantsSnapshot = _snapshotCurrentParticipants();

  const pset: ParticipantSet = {
    id: uid('pset'),
    name: trimmed,
    description: description.trim(),
    participants: participantsSnapshot,
    pakalCatalog: _snapshotCurrentPakalCatalog(participantsSnapshot),
    certificationCatalog: _snapshotCurrentCertificationCatalog(participantsSnapshot),
    createdAt: Date.now(),
  };

  const prevActiveId = _activeParticipantSetId;
  sets.push(pset);
  if (!_saveParticipantSets()) {
    sets.pop(); // rollback
    return null;
  }

  _activeParticipantSetId = pset.id;
  if (!_saveActiveParticipantSetId()) {
    _activeParticipantSetId = prevActiveId;
  }

  return _deepCopyPSet(pset);
}

/**
 * Load a participant set — replaces ALL current participants.
 * This is a single undoable action.
 */
export function loadParticipantSet(id: string): void {
  const pset = getParticipantSetById(id);
  if (!pset) return;

  pushSnapshot();
  _suppressSnapshot = true;
  try {
    // Clear all current participants
    participants.clear();
    dateUnavailabilities.clear();
    ensurePakalDefinitions(pset.pakalCatalog || []);
    ensureCertificationDefinitions(pset.certificationCatalog);

    // Add participants from the set
    for (const snap of pset.participants) {
      const pid = uid('p');
      const certs = [...snap.certifications];
      const pIds = sanitizePakalIds(snap.pakalIds, pakalDefinitions);
      const p: Participant = {
        id: pid,
        name: snap.name,
        level: snap.level,
        certifications: certs,
        pakalIds: pIds,
        group: snap.group,
        availability: getDefaultAvailability(),
        dateUnavailability: [],
        preferredTaskName: snap.preferredTaskName,
        lessPreferredTaskName: snap.lessPreferredTaskName,
      };
      participants.set(pid, p);

      // Restore date unavailabilities
      if (snap.dateUnavailability && snap.dateUnavailability.length > 0) {
        const rules: DateUnavailability[] = snap.dateUnavailability
          .map((r) => normalizeDateUnavailabilityRule(r))
          .filter((rule): rule is Omit<DateUnavailability, 'id'> => !!rule)
          .map((rule) => ({
            ...rule,
            id: uid('du'),
          }));
        if (rules.length > 0) {
          dateUnavailabilities.set(pid, rules);
          p.dateUnavailability = rules;
        }
      }
    }

    // Rebuild notWithPairs from snapshot notWithIds (stored as names, resolved to new IDs)
    notWithPairs.clear();
    // Build name→newId lookup from the participants we just created
    const nameToId = new Map<string, string>();
    for (const p of participants.values()) nameToId.set(p.name, p.id);
    for (const snap of pset.participants) {
      if (!snap.notWithIds || snap.notWithIds.length === 0) continue;
      const pid = nameToId.get(snap.name);
      if (!pid) continue;
      for (const targetName of snap.notWithIds) {
        const targetId = nameToId.get(targetName);
        if (!targetId || targetId === pid) continue;
        if (!notWithPairs.has(pid)) notWithPairs.set(pid, new Set());
        if (!notWithPairs.has(targetId)) notWithPairs.set(targetId, new Set());
        notWithPairs.get(pid)!.add(targetId);
        notWithPairs.get(targetId)!.add(pid);
      }
    }
    syncNotWithToParticipants();

    recalcAllAvailability();
  } finally {
    _suppressSnapshot = false;
  }

  _activeParticipantSetId = id;
  _saveActiveParticipantSetId();
  notify();
}

/**
 * Overwrite an existing set's participants with the current state.
 * Returns false if set not found or is built-in.
 */
export function updateParticipantSet(id: string): boolean {
  const sets = _initParticipantSets();
  const idx = sets.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (sets[idx].builtIn) return false;

  const participantsSnapshot = _snapshotCurrentParticipants();
  const prevParticipants = sets[idx].participants;
  const prevPakal = sets[idx].pakalCatalog;
  const prevCerts = sets[idx].certificationCatalog;
  sets[idx].participants = participantsSnapshot;
  sets[idx].pakalCatalog = _snapshotCurrentPakalCatalog(participantsSnapshot);
  sets[idx].certificationCatalog = _snapshotCurrentCertificationCatalog(participantsSnapshot);
  if (!_saveParticipantSets()) {
    sets[idx].participants = prevParticipants; // rollback
    sets[idx].pakalCatalog = prevPakal;
    sets[idx].certificationCatalog = prevCerts;
    return false;
  }
  return true;
}

/**
 * Rename a participant set. Returns null on success, or an error string.
 */
export function renameParticipantSet(id: string, name: string, description: string): string | null {
  const sets = _initParticipantSets();
  const pset = sets.find((s) => s.id === id);
  if (!pset) return 'סט לא נמצא';
  if (pset.builtIn) return 'לא ניתן לשנות שם של סט מובנה';

  const trimmed = name.trim();
  if (!trimmed) return 'השם לא יכול להיות ריק';
  if (_isPSetNameTaken(trimmed, id)) return 'סט עם שם זה כבר קיים';

  const prevName = pset.name;
  const prevDesc = pset.description;
  pset.name = trimmed;
  pset.description = description.trim();
  if (!_saveParticipantSets()) {
    pset.name = prevName; // rollback
    pset.description = prevDesc;
    return 'שמירה נכשלה — נפח האחסון בדפדפן מלא';
  }
  return null;
}

/**
 * Duplicate a participant set with a unique name.
 */
export function duplicateParticipantSet(id: string): ParticipantSet | null {
  const source = getParticipantSetById(id);
  if (!source) return null;

  const sets = _initParticipantSets();
  if (sets.length >= MAX_PARTICIPANT_SETS) return null;

  let newName = source.name + ' (עותק)';
  let attempt = 2;
  while (_isPSetNameTaken(newName)) {
    newName = `${source.name} (עותק ${attempt++})`;
  }

  const dup: ParticipantSet = {
    id: uid('pset'),
    name: newName,
    description: source.description,
    participants: source.participants, // already deep-copied by getParticipantSetById
    pakalCatalog: source.pakalCatalog,
    certificationCatalog: source.certificationCatalog,
    builtIn: false,
    createdAt: Date.now(),
  };
  sets.push(dup);
  if (!_saveParticipantSets()) {
    sets.pop(); // rollback
    return null;
  }
  return _deepCopyPSet(dup);
}

/**
 * Delete a participant set. If it was active, clears the active id.
 * Returns false if not found or is built-in.
 */
export function deleteParticipantSet(id: string): boolean {
  const sets = _initParticipantSets();
  const idx = sets.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (sets[idx].builtIn) return false;

  const [removed] = sets.splice(idx, 1);
  if (!_saveParticipantSets()) {
    sets.splice(idx, 0, removed); // rollback
    return false;
  }

  if (_activeParticipantSetId === id) {
    _activeParticipantSetId = null;
    _saveActiveParticipantSetId();
  }
  return true;
}

/**
 * Compare the current participants against the active set.
 * Returns true if they differ (set is "dirty").
 */
export function isParticipantSetDirty(): boolean {
  const activeId = getActiveParticipantSetId();
  if (!activeId) return false;
  const pset = getParticipantSetById(activeId);
  if (!pset) return false;
  const participantsSnapshot = _snapshotCurrentParticipants();
  const current = {
    participants: participantsSnapshot,
    pakalCatalog: _snapshotCurrentPakalCatalog(participantsSnapshot),
    certificationCatalog: _snapshotCurrentCertificationCatalog(participantsSnapshot),
  };
  return (
    JSON.stringify(current) !==
    JSON.stringify({
      participants: pset.participants,
      pakalCatalog: pset.pakalCatalog || normalizePakalDefinitions(undefined),
      certificationCatalog: pset.certificationCatalog,
    })
  );
}

/** Get the maximum number of participant sets allowed */
export function getMaxParticipantSets(): number {
  return MAX_PARTICIPANT_SETS;
}

// ─── Task Sets ───────────────────────────────────────────────────────────────

const STORAGE_KEY_TASK_SETS = 'gardenmanager_task_sets';
const STORAGE_KEY_ACTIVE_TASK_SET = 'gardenmanager_active_task_set_id';
const MAX_TASK_SETS = 30;

let _taskSets: TaskSet[] | null = null;
let _activeTaskSetId: string | null | undefined; // undefined = not yet loaded

/** Deep-copy a TaskSet via JSON round-trip. */
function _deepCopyTaskSet(s: TaskSet): TaskSet {
  return JSON.parse(JSON.stringify(s)) as TaskSet;
}

function _snapshotCurrentTaskSetState(): Pick<TaskSet, 'templates' | 'oneTimeTasks' | 'restRules'> {
  return {
    templates: _snapshotCurrentTaskTemplates(),
    oneTimeTasks: _snapshotCurrentOneTimeTasks(),
    restRules: _restRules.map((r) => ({ ...r })),
  };
}

/** Lazily initialise task sets from localStorage. */
function _initTaskSets(): TaskSet[] {
  if (_taskSets) return _taskSets;

  const raw = localStorage.getItem(STORAGE_KEY_TASK_SETS);
  if (raw) {
    try {
      _taskSets = JSON.parse(raw) as TaskSet[];
    } catch {
      _taskSets = [];
    }
  } else {
    // First load — create built-in set from current templates
    _taskSets = [];
    _seedBuiltInTaskSet();
  }

  // Load active set id
  if (_activeTaskSetId === undefined) {
    _activeTaskSetId = localStorage.getItem(STORAGE_KEY_ACTIVE_TASK_SET) || null;
  }

  return _taskSets;
}

/** Snapshot the current in-memory task templates. */
function _snapshotCurrentTaskTemplates(): TaskTemplate[] {
  const all = getAllTaskTemplates();
  return JSON.parse(JSON.stringify(all)) as TaskTemplate[];
}

/** Snapshot the current in-memory one-time tasks. */
function _snapshotCurrentOneTimeTasks(): OneTimeTask[] {
  const all = getAllOneTimeTasks();
  return JSON.parse(JSON.stringify(all)) as OneTimeTask[];
}

/** Create the built-in default task set from whatever templates are currently loaded. */
function _seedBuiltInTaskSet(): void {
  const sets = _taskSets!;
  if (sets.find((s) => s.id === 'tset-default')) return;
  const snapshot = _snapshotCurrentTaskSetState();
  if (snapshot.templates.length === 0) return; // don't seed empty
  sets.unshift({
    id: 'tset-default',
    name: 'סט ברירת מחדל',
    description: 'תבניות המשימות המקוריות',
    ...snapshot,
    builtIn: true,
    createdAt: 0,
  });
  _saveTaskSets();
}

function _saveTaskSets(): boolean {
  if (!_taskSets) return false;
  try {
    localStorage.setItem(STORAGE_KEY_TASK_SETS, JSON.stringify(_taskSets));
    onSaveSuccess();
    return true;
  } catch (err: unknown) {
    if (isQuotaExceededError(err)) {
      console.warn('[Store] localStorage quota exceeded for task sets.');
    } else {
      console.warn('[Store] Failed to save task sets:', err);
    }
    reportSaveError(err);
    return false;
  }
}

function _saveActiveTaskSetId(): boolean {
  try {
    if (_activeTaskSetId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_TASK_SET, _activeTaskSetId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_TASK_SET);
    }
    onSaveSuccess();
    return true;
  } catch (err) {
    console.warn('[Store] Failed to save active task set id:', err);
    reportSaveError(err);
    return false;
  }
}

/** Case-insensitive trimmed name duplicate check */
function _isTaskSetNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  const sets = _initTaskSets();
  return sets.some((s) => s.name.trim().toLowerCase() === norm && s.id !== excludeId);
}

// ─── Task Set Public API ─────────────────────────────────────────────────────

/** Get all task sets (built-in first, then by createdAt) */
export function getAllTaskSets(): TaskSet[] {
  const sets = _initTaskSets();
  return sets
    .slice()
    .sort((a, b) => {
      if (a.builtIn && !b.builtIn) return -1;
      if (!a.builtIn && b.builtIn) return 1;
      return a.createdAt - b.createdAt;
    })
    .map((s) => _deepCopyTaskSet(s));
}

/** Get a single task set by id */
export function getTaskSetById(id: string): TaskSet | undefined {
  const sets = _initTaskSets();
  const found = sets.find((s) => s.id === id);
  return found ? _deepCopyTaskSet(found) : undefined;
}

/** Get the active task set id (may be null) */
export function getActiveTaskSetId(): string | null {
  _initTaskSets();
  return _activeTaskSetId ?? null;
}

/**
 * Save the current task templates as a new named set.
 * Returns the new set, or null if the name is taken or limit reached.
 */
export function saveCurrentAsTaskSet(name: string, description: string): TaskSet | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (_isTaskSetNameTaken(trimmed)) return null;

  const sets = _initTaskSets();
  if (sets.length >= MAX_TASK_SETS) {
    console.warn(`[Store] Task set limit reached (${MAX_TASK_SETS}).`);
    return null;
  }

  const snapshot = _snapshotCurrentTaskSetState();
  const tset: TaskSet = {
    id: uid('tset'),
    name: trimmed,
    description: description.trim(),
    ...snapshot,
    createdAt: Date.now(),
  };

  const prevActiveId = _activeTaskSetId;
  sets.push(tset);
  if (!_saveTaskSets()) {
    sets.pop(); // rollback
    return null;
  }

  _activeTaskSetId = tset.id;
  if (!_saveActiveTaskSetId()) {
    _activeTaskSetId = prevActiveId;
  }

  return _deepCopyTaskSet(tset);
}

/**
 * Load a task set — replaces task templates, one-time tasks,
 * and category-break settings as a single snapshot.
 * This is a single undoable action.
 */
export function loadTaskSet(id: string): void {
  const tset = getTaskSetById(id);
  if (!tset) return;

  pushSnapshot();
  _suppressSnapshot = true;
  try {
    // Clear all current templates
    taskTemplates.clear();

    // Add templates from the set
    for (const tpl of tset.templates) {
      const restored: TaskTemplate = JSON.parse(JSON.stringify(tpl));
      taskTemplates.set(restored.id, restored);
    }

    oneTimeTasks.clear();
    for (const ot of tset.oneTimeTasks) {
      const restored: OneTimeTask = JSON.parse(JSON.stringify(ot));
      restored.scheduledDate = new Date(restored.scheduledDate);
      oneTimeTasks.set(restored.id, restored);
    }

    _restRules = Array.isArray(tset.restRules) ? tset.restRules.map((r) => ({ ...r })) : [];
  } finally {
    _suppressSnapshot = false;
  }

  _activeTaskSetId = id;
  _saveActiveTaskSetId();
  notify();
}

/**
 * Overwrite an existing set's templates with the current state.
 * Returns false if set not found or is built-in.
 */
export function updateTaskSet(id: string): boolean {
  const sets = _initTaskSets();
  const idx = sets.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (sets[idx].builtIn) return false;

  const snapshot = _snapshotCurrentTaskSetState();
  const prevTemplates = sets[idx].templates;
  const prevOneTime = sets[idx].oneTimeTasks;
  const prevRules = sets[idx].restRules;
  sets[idx].templates = snapshot.templates;
  sets[idx].oneTimeTasks = snapshot.oneTimeTasks;
  sets[idx].restRules = snapshot.restRules;
  if (!_saveTaskSets()) {
    sets[idx].templates = prevTemplates; // rollback
    sets[idx].oneTimeTasks = prevOneTime;
    sets[idx].restRules = prevRules;
    return false;
  }
  return true;
}

/**
 * Rename a task set. Returns null on success, or an error string.
 */
export function renameTaskSet(id: string, name: string, description: string): string | null {
  const sets = _initTaskSets();
  const tset = sets.find((s) => s.id === id);
  if (!tset) return 'סט לא נמצא';
  if (tset.builtIn) return 'לא ניתן לשנות שם של סט מובנה';

  const trimmed = name.trim();
  if (!trimmed) return 'השם לא יכול להיות ריק';
  if (_isTaskSetNameTaken(trimmed, id)) return 'סט עם שם זה כבר קיים';

  const prevName = tset.name;
  const prevDesc = tset.description;
  tset.name = trimmed;
  tset.description = description.trim();
  if (!_saveTaskSets()) {
    tset.name = prevName; // rollback
    tset.description = prevDesc;
    return 'שמירה נכשלה — נפח האחסון בדפדפן מלא';
  }
  return null;
}

/**
 * Duplicate a task set with a unique name.
 */
export function duplicateTaskSet(id: string): TaskSet | null {
  const source = getTaskSetById(id);
  if (!source) return null;

  const sets = _initTaskSets();
  if (sets.length >= MAX_TASK_SETS) return null;

  let newName = source.name + ' (עותק)';
  let attempt = 2;
  while (_isTaskSetNameTaken(newName)) {
    newName = `${source.name} (עותק ${attempt++})`;
  }

  const dup: TaskSet = {
    id: uid('tset'),
    name: newName,
    description: source.description,
    templates: source.templates, // already deep-copied by getTaskSetById
    oneTimeTasks: source.oneTimeTasks, // already deep-copied by getTaskSetById
    restRules: source.restRules,
    builtIn: false,
    createdAt: Date.now(),
  };
  sets.push(dup);
  if (!_saveTaskSets()) {
    sets.pop(); // rollback
    return null;
  }
  return _deepCopyTaskSet(dup);
}

/**
 * Delete a task set. If it was active, clears the active id.
 * Returns false if not found or is built-in.
 */
export function deleteTaskSet(id: string): boolean {
  const sets = _initTaskSets();
  const idx = sets.findIndex((s) => s.id === id);
  if (idx === -1) return false;
  if (sets[idx].builtIn) return false;

  const [removed] = sets.splice(idx, 1);
  if (!_saveTaskSets()) {
    sets.splice(idx, 0, removed); // rollback
    return false;
  }

  if (_activeTaskSetId === id) {
    _activeTaskSetId = null;
    _saveActiveTaskSetId();
  }
  return true;
}

/**
 * Compare the current task templates against the active set.
 * Returns true if they differ (set is "dirty").
 */
export function isTaskSetDirty(): boolean {
  const activeId = getActiveTaskSetId();
  if (!activeId) return false;
  const tset = getTaskSetById(activeId);
  if (!tset) return false;
  const currentTemplates = _snapshotCurrentTaskTemplates();
  if (JSON.stringify(currentTemplates) !== JSON.stringify(tset.templates)) return true;
  const currentOts = _snapshotCurrentOneTimeTasks();
  if (JSON.stringify(currentOts) !== JSON.stringify(tset.oneTimeTasks)) return true;
  if (JSON.stringify(_restRules) !== JSON.stringify(tset.restRules || [])) return true;
  return false;
}

// ─── Data Transfer Helpers ──────────────────────────────────────────────────

const ALL_STORAGE_KEYS = [
  STORAGE_KEY_STATE,
  STORAGE_KEY_SCHEDULE,
  STORAGE_KEY_LIVE_MODE,
  STORAGE_KEY_ALGORITHM,
  STORAGE_KEY_PRESETS,
  STORAGE_KEY_ACTIVE_PRESET,
  STORAGE_KEY_SNAPSHOTS,
  STORAGE_KEY_ACTIVE_SNAPSHOT,
  STORAGE_KEY_PSETS,
  STORAGE_KEY_ACTIVE_PSET,
  STORAGE_KEY_TASK_SETS,
  STORAGE_KEY_ACTIVE_TASK_SET,
];

/** Return the 12 localStorage key names used by the app. */
export function getAllStorageKeys(): string[] {
  return [...ALL_STORAGE_KEYS];
}

/** Import a pre-built TaskSet directly (bypassing snapshot-from-current). */
export function importTaskSetDirect(tset: TaskSet): boolean {
  const sets = _initTaskSets();
  if (sets.length >= MAX_TASK_SETS) return false;
  // Restore OneTimeTask scheduledDate from string to Date if needed
  for (const ot of tset.oneTimeTasks) {
    if (typeof ot.scheduledDate === 'string') {
      ot.scheduledDate = new Date(ot.scheduledDate as unknown as string);
    }
  }
  sets.push(tset);
  if (!_saveTaskSets()) {
    sets.pop(); // rollback
    return false;
  }
  return true;
}

/** Import a pre-built ParticipantSet directly. */
export function importParticipantSetDirect(pset: ParticipantSet): boolean {
  const sets = _initParticipantSets();
  if (sets.length >= MAX_PARTICIPANT_SETS) return false;
  const normalized = _normalizeParticipantSet(pset);
  sets.push(normalized);
  if (!_saveParticipantSets()) {
    sets.pop(); // rollback
    return false;
  }
  return true;
}

/** Import a pre-built ScheduleSnapshot directly. */
export function importSnapshotDirect(snap: ScheduleSnapshot): boolean {
  const snapshots = _initSnapshots();
  if (snapshots.length >= MAX_SNAPSHOTS) return false;
  snapshots.push(snap);
  if (!_saveSnapshots()) {
    snapshots.pop(); // rollback
    return false;
  }
  return true;
}

/**
 * Replace current algorithm settings and all user presets in one operation.
 * The built-in Default preset is always preserved.
 */
export function replaceAlgorithmSettingsAndPresets(
  settings: AlgorithmSettings,
  presets: AlgorithmPreset[],
  activeId: string | null,
): boolean {
  // Replace working copy
  _algorithmSettings = {
    config: { ...settings.config },
    disabledHardConstraints: [...settings.disabledHardConstraints],
    dayStartHour: settings.dayStartHour,
  };
  if (!_saveAlgorithmSettings()) return false;

  // Replace presets: keep built-in Default, replace everything else
  const current = _initPresets();
  const builtIn = current.filter((p) => p.builtIn);
  const imported = presets.filter((p) => !p.builtIn);
  _presets = [...builtIn, ...imported];
  // Ensure Default always exists
  if (!_presets.find((p) => p.id === DEFAULT_PRESET.id)) {
    _presets.unshift(_deepCopyPreset(DEFAULT_PRESET));
  }
  if (!_savePresets()) return false;

  // Set active preset
  _activePresetId = activeId && _presets.find((p) => p.id === activeId) ? activeId : DEFAULT_PRESET.id;
  _saveActivePresetId();
  notifyAlgorithmChanged();
  return true;
}

/** Add a single algorithm preset directly. */
export function addAlgorithmPresetDirect(preset: AlgorithmPreset): boolean {
  const presets = _initPresets();
  presets.push(preset);
  if (!_savePresets()) {
    presets.pop(); // rollback
    return false;
  }
  return true;
}
