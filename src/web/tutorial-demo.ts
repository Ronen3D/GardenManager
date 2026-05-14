/**
 * Tutorial demo-mode orchestrator.
 *
 * On tour start `enterTutorialDemoMode()` snapshots the user's full app state,
 * loads a curated demo (small roster, 2-day schedule with one HC-1 violation
 * and one empty future slot, live mode anchored mid-day-1), runs the tour
 * against that, and `exitTutorialDemoMode()` restores the user's snapshot on
 * exit. A durable backup in `localStorage` survives page reloads — `init()`
 * in app.ts calls `restoreTutorialBackupIfPresent()` before reading any
 * store data so an interrupted tour leaves the user's data intact.
 */

import {
  type Assignment,
  AssignmentStatus,
  freezeAssignments,
  Level,
  type Participant,
  type Schedule,
  type Task,
} from '../index';
import * as appHost from './app-tutorial-hooks';
import * as store from './config-store';
import {
  buildDemoAssignments,
  buildDemoLiveModeAnchor,
  buildDemoTaskTemplateSpecs,
  DEMO_DAY_START_HOUR,
  DEMO_ONE_TIME_TASK,
  DEMO_PARTICIPANTS,
  DEMO_PERIOD_DAYS,
  DEMO_REST_RULE,
} from './tutorial-demo-seed';

// ─── Storage / snapshot types ────────────────────────────────────────────────

// NOTE: the literal value here is also referenced as a hardcoded string in
// config-store.ts factoryReset(). If you rename the value, update both
// places — the persistence test in src/test-persistence.ts asserts they
// match and will fail loudly on drift.
export const BACKUP_KEY = 'gardenmanager_pre_tutorial_snapshot';

/** UI-pref keys outside `store.getAllStorageKeys()` that the tour may touch. */
const EXTRA_PREF_KEYS = ['gardenmanager_theme', 'gardenmanager_default_attempts', 'gm-sidebar-collapsed'];

export interface TutorialBackup {
  version: 1;
  storageEntries: Record<string, string | null>;
  appState: appHost.AppStateSnapshotJson;
}

let _inMemorySnapshot: TutorialBackup | null = null;

// ─── Pre-tour gate ───────────────────────────────────────────────────────────

export class TutorialPreflightError extends Error {
  constructor(public readonly reason: 'manual-build' | 'modal-open' | 'sheet-dirty') {
    super(reason);
    this.name = 'TutorialPreflightError';
  }
}

/** Throws `TutorialPreflightError` if entering demo mode would discard
 *  unsaved in-memory work. Caller (tutorial.ts) shows the appropriate toast. */
function assertSafeToEnterDemo(): void {
  if (appHost.isManualBuildActive()) {
    throw new TutorialPreflightError('manual-build');
  }
  // Check the participant editor sheet BEFORE the generic modal check. The
  // sheet element carries both `.gm-edit-sheet-v2` and `.gm-modal-dialog`, so a
  // selector-order swap would route the sheet's open state to the generic
  // "modal open" toast instead of the more specific sheet-dirty message.
  if (document.querySelector('.gm-edit-sheet-v2')) {
    throw new TutorialPreflightError('sheet-dirty');
  }
  // Block when any non-tutorial modal dialog is open (snapshot rename, BALTAM,
  // swap picker, etc.). The tour engine's own popover is a `.tutorial-*` class
  // and is excluded.
  if (document.querySelector('.gm-modal-dialog, .gm-modal')) {
    throw new TutorialPreflightError('modal-open');
  }
}

// ─── Snapshot capture / restore primitives ───────────────────────────────────

function captureStorageEntries(): Record<string, string | null> {
  const keys = [...store.getAllStorageKeys(), ...EXTRA_PREF_KEYS];
  const entries: Record<string, string | null> = {};
  for (const key of keys) {
    try {
      entries[key] = localStorage.getItem(key);
    } catch {
      entries[key] = null;
    }
  }
  return entries;
}

function applyStorageEntries(entries: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(entries)) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Quota exhaustion during restore is fatal in spirit but we keep going so
      // the rest of the keys land; user can re-import later.
    }
  }
}

// ─── Enter / Exit ────────────────────────────────────────────────────────────

export function enterTutorialDemoMode(): void {
  assertSafeToEnterDemo();

  // Flush any pending debounced save before reading so the snapshot reflects
  // the user's latest mutation.
  store.flushPendingSave();

  const snapshot: TutorialBackup = {
    version: 1,
    storageEntries: captureStorageEntries(),
    appState: appHost.getAppStateSnapshot(),
  };
  _inMemorySnapshot = snapshot;
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify(snapshot));
  } catch {
    // If we can't write the backup, the in-memory copy still covers the
    // try/finally path. The user just loses the page-reload safety net.
  }

  appHost.setSuppressOnStoreChanged(true);
  try {
    loadDemoStateIntoStore();

    const periodStart = store.getScheduleDate();
    const dayStartHour = store.getDayStartHour();
    const tasks = appHost.generateTasksFromTemplates();
    const participants = store.getAllParticipants();
    const assignments = buildDemoAssignments(tasks, participants, periodStart, dayStartHour);
    const schedule = buildDemoScheduleLiteral(tasks, participants, assignments, periodStart);
    const anchor = buildDemoLiveModeAnchor(periodStart, dayStartHour);
    store.setLiveModeEnabled(true);
    store.setLiveModeTimestamp(anchor);
    freezeAssignments(schedule, anchor);
    appHost.loadScheduleFromFrozen(schedule);
    appHost.setUiForDemo();
  } finally {
    appHost.setSuppressOnStoreChanged(false);
  }

  appHost.renderAll();
}

export function exitTutorialDemoMode(): void {
  const snapshot = _inMemorySnapshot ?? readDurableSnapshot();
  if (!snapshot) return;
  _inMemorySnapshot = null;

  appHost.setSuppressOnStoreChanged(true);
  try {
    applyStorageEntries(snapshot.storageEntries);
    store.initStore();
    // Reload schedule from the restored frozen snapshot (mirrors init()).
    const restored = store.loadSchedule();
    if (restored && appHost.hasFrozenFields(restored)) {
      appHost.loadScheduleFromFrozen(restored);
    } else {
      appHost.loadScheduleFromFrozen(null);
    }
    appHost.applyAppStateSnapshot(snapshot.appState);
  } finally {
    appHost.setSuppressOnStoreChanged(false);
    try {
      localStorage.removeItem(BACKUP_KEY);
    } catch {
      /* ignore */
    }
  }

  appHost.renderAll();
}

/**
 * Called from `init()` in app.ts BEFORE it reads store / schedule data.
 * If a backup blob is present from an interrupted previous session,
 * write the user's state back to the matching localStorage keys and return
 * — the regular init flow then loads the just-restored data. Returns true
 * when a restore actually happened.
 *
 * We deliberately do NOT delete the backup here. If another tab still has a
 * live tour in progress, deleting the backup would strand that tab without a
 * recovery path. The backup is cleaned up by `exitTutorialDemoMode` on the
 * tour's clean exit, or overwritten by the next `enterTutorialDemoMode`.
 * Restoring twice from the same backup is idempotent (the user's data simply
 * gets re-written on top of itself), so leaving the key in place is safe.
 */
export function restoreTutorialBackupIfPresent(): boolean {
  const snapshot = readDurableSnapshot();
  if (!snapshot) return false;
  applyStorageEntries(snapshot.storageEntries);
  return true;
}

function readDurableSnapshot(): TutorialBackup | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BACKUP_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TutorialBackup;
    if (parsed?.version !== 1 || typeof parsed.storageEntries !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Demo state population ───────────────────────────────────────────────────

/**
 * Replace the live store contents with the demo seed. Called inside the
 * suppressOnStoreChanged window so the many small `notify()` callbacks
 * triggered by add/remove ops don't pile up undo entries.
 */
function loadDemoStateIntoStore(): void {
  // ── Wipe existing entities ─────────────────────────────────────────────
  for (const p of store.getAllParticipants()) {
    store.removeParticipant(p.id);
  }
  for (const tpl of store.getAllTaskTemplates()) {
    store.removeTaskTemplate(tpl.id);
  }
  for (const ot of store.getAllOneTimeTasks()) {
    store.removeOneTimeTask(ot.id);
  }
  for (const rr of store.getRestRules()) {
    store.removeRestRule(rr.id);
  }
  // Live-mode reset; demo anchor is set after schedule construction.
  store.setLiveModeEnabled(false);

  // ── Set schedule window first so `getDefaultAvailability` (called inside
  //    `addParticipant`) covers the full demo period.
  store.setScheduleDate(buildDemoPeriodStart());
  store.setScheduleDays(DEMO_PERIOD_DAYS);

  // ── Rest rule ──────────────────────────────────────────────────────────
  const restRule = store.addRestRule(DEMO_REST_RULE.label, DEMO_REST_RULE.durationHours);

  // ── Participants ───────────────────────────────────────────────────────
  for (const spec of DEMO_PARTICIPANTS) {
    store.addParticipant({
      name: spec.name,
      level: spec.level,
      group: spec.group,
      certifications: [...spec.certifications],
    });
  }

  // ── Templates (insertion order = render order = task generation order) ─
  let slotCounter = 0;
  const templateSpecs = buildDemoTaskTemplateSpecs();
  for (const spec of templateSpecs) {
    store.addTaskTemplate({
      name: spec.name,
      durationHours: spec.durationHours,
      shiftsPerDay: spec.shiftsPerDay,
      startHour: spec.startHour,
      sameGroupRequired: spec.sameGroupRequired,
      blocksConsecutive: spec.blocksConsecutive,
      baseLoadWeight: spec.baseLoadWeight,
      loadWindows: [],
      subTeams: [],
      slots: spec.slots.map((s) => ({
        id: `demo-slot-${++slotCounter}`,
        label: s.label,
        acceptableLevels: s.levels.map((l) => ({ level: l.level, ...(l.lowPriority ? { lowPriority: true } : {}) })),
        requiredCertifications: [...s.requiredCertifications],
      })),
      restRuleId: restRule.id,
      ...(spec.sleepRecovery
        ? {
            sleepRecovery: {
              triggerShifts: [...spec.sleepRecovery.triggerShifts],
              recoveryHours: spec.sleepRecovery.recoveryHours,
            },
          }
        : {}),
      color: spec.color,
    });
  }

  // ── One-time task (after templates so periodStart is set) ──────────────
  const periodStart = store.getScheduleDate();
  const otDate = new Date(
    periodStart.getFullYear(),
    periodStart.getMonth(),
    periodStart.getDate() + (DEMO_ONE_TIME_TASK.dayIndex - 1),
  );
  store.addOneTimeTask({
    name: DEMO_ONE_TIME_TASK.name,
    scheduledDate: otDate,
    startHour: DEMO_ONE_TIME_TASK.startHour,
    startMinute: DEMO_ONE_TIME_TASK.startMinute,
    durationHours: DEMO_ONE_TIME_TASK.durationHours,
    sameGroupRequired: false,
    blocksConsecutive: false,
    baseLoadWeight: 0.5,
    loadWindows: [],
    subTeams: [],
    slots: DEMO_ONE_TIME_TASK.slots.map((s) => ({
      id: `demo-slot-${++slotCounter}`,
      label: s.label,
      acceptableLevels: s.levels.map((l) => ({ level: l.level, ...(l.lowPriority ? { lowPriority: true } : {}) })),
      requiredCertifications: [...s.requiredCertifications],
    })),
    color: DEMO_ONE_TIME_TASK.color,
  });
}

/** Start the demo at midnight of today's local date — anchor math in the
 *  seed reads `periodStart + dayStartHour` so this aligns the live anchor
 *  with the visible "today" in the live-mode badge. */
function buildDemoPeriodStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function buildDemoScheduleLiteral(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  periodStart: Date,
): Schedule {
  const algo = store.getAlgorithmSettings();
  return {
    id: `demo-${Date.now()}`,
    tasks,
    participants,
    assignments,
    feasible: false,
    score: {
      minRestHours: 0,
      avgRestHours: 0,
      restStdDev: 0,
      totalPenalty: 0,
      compositeScore: 0,
      l0StdDev: 0,
      l0AvgEffective: 0,
      seniorStdDev: 0,
      seniorAvgEffective: 0,
      dailyPerParticipantStdDev: 0,
      dailyGlobalStdDev: 0,
      restPerGapBonus: 0,
    },
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: {
      config: { ...algo.config },
      disabledHardConstraints: [...algo.disabledHardConstraints],
      dayStartHour: DEMO_DAY_START_HOUR,
    },
    periodStart,
    periodDays: DEMO_PERIOD_DAYS,
    restRuleSnapshot: Object.fromEntries(store.buildRestRuleMap()),
    certLabelSnapshot: Object.fromEntries(store.getCertificationDefinitions().map((d) => [d.id, d.label])),
    scheduleUnavailability: [],
  };
}

// Re-export the types so app-tutorial-hooks consumers can use them.
export type { Participant, Schedule, Task };

// Re-export Level/AssignmentStatus to keep the import surface in this module
// stable (only used internally below — silence unused warnings if any).
void Level;
void AssignmentStatus;
