/**
 * Service-registry shim that lets `tutorial-demo.ts` reach into `app.ts`
 * (snapshot/restore module-level state, swap out the live `Schedule`,
 * re-render) without creating a circular import.
 *
 * `app.ts` calls `register(...)` exactly once at boot, providing closures
 * that close over its private state. `tutorial-demo.ts` reads from the
 * same module via the typed getters / setters below.
 */

import type { Schedule, Task } from '../index';

/** JSON-safe snapshot of `app.ts` in-memory state captured at tour start. */
export interface AppStateSnapshotJson {
  currentTab: 'participants' | 'task-rules' | 'schedule' | 'algorithm';
  currentDay: number;
  viewMode: 'SCHEDULE_VIEW' | 'PROFILE_VIEW' | 'TASK_PANEL_VIEW' | 'POINT_IN_TIME_VIEW';
  profileParticipantId: string | null;
  taskPanelSourceName: string | null;
  continuityJson: string;
  sidebarCollapsed: boolean;
  scheduleDirty: boolean;
  snapshotDirty: boolean;
  hash: string;
}

interface Hooks {
  getAppStateSnapshot: () => AppStateSnapshotJson;
  applyAppStateSnapshot: (s: AppStateSnapshotJson) => void;
  /** Pass `null` to clear the live schedule (engine + currentSchedule). */
  loadScheduleFromFrozen: (s: Schedule | null) => void;
  generateTasksFromTemplates: () => Task[];
  /** Gate `onStoreChanged` so bulk demo seeding doesn't pile up undo entries. */
  setSuppressOnStoreChanged: (v: boolean) => void;
  isManualBuildActive: () => boolean;
  hasFrozenFields: (s: Schedule | null | undefined) => boolean;
  /** Sets currentTab=schedule, currentDay=1, viewMode=SCHEDULE_VIEW. */
  setUiForDemo: () => void;
  renderAll: () => void;
}

let _hooks: Hooks | null = null;

export function register(hooks: Hooks): void {
  _hooks = hooks;
}

function hooks(): Hooks {
  if (!_hooks) {
    throw new Error('[app-tutorial-hooks] register() must be called before any hook is invoked');
  }
  return _hooks;
}

export const getAppStateSnapshot: Hooks['getAppStateSnapshot'] = () => hooks().getAppStateSnapshot();
export const applyAppStateSnapshot: Hooks['applyAppStateSnapshot'] = (s) => hooks().applyAppStateSnapshot(s);
export const loadScheduleFromFrozen: Hooks['loadScheduleFromFrozen'] = (s) => hooks().loadScheduleFromFrozen(s);
export const generateTasksFromTemplates: Hooks['generateTasksFromTemplates'] = () =>
  hooks().generateTasksFromTemplates();
export const setSuppressOnStoreChanged: Hooks['setSuppressOnStoreChanged'] = (v) =>
  hooks().setSuppressOnStoreChanged(v);
export const isManualBuildActive: Hooks['isManualBuildActive'] = () => hooks().isManualBuildActive();
export const hasFrozenFields: Hooks['hasFrozenFields'] = (s) => hooks().hasFrozenFields(s);
export const setUiForDemo: Hooks['setUiForDemo'] = () => hooks().setUiForDemo();
export const renderAll: Hooks['renderAll'] = () => hooks().renderAll();
