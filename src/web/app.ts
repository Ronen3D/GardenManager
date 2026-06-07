/**
 * Browser Entry Point — Tabbed UI with Daily Focus + Weekly Context
 *
 * Layout: Day 1–7 navigation with a focused 24h grid per day,
 * a sticky Weekly Dashboard header showing global fairness & KPIs,
 * and a Participant Status sidebar with cumulative orange workload bars
 * and per-participant workload indicators.
 *
 * Every manual change triggers full 7-day re-validation so cross-day
 * conflicts are caught immediately.
 */

import './fonts.css';
import './style.css';
import './style-mobile.css';
import './style-swimlane.css';
import './style-tutorial.css';
import { getRecoveryWindow } from '../constraints/sleep-recovery';
import {
  findCertAffectedAssignments,
  generateCapabilityChangePlans,
  upsertCapabilityLoss,
} from '../engine/capability-change';
import {
  type AffectedAssignment,
  computeEffectiveUnavailabilityWindows,
  findAffectedAssignments,
  generateBatchRescuePlans,
  upsertScheduleUnavailability,
} from '../engine/future-sos';
import { buildPhantomContext } from '../engine/phantom';
import {
  freezeAssignments,
  getAnchorDayIndex,
  isDayFrozen,
  isDayPartiallyFrozen,
  isFutureTask,
  unfreezeAll,
} from '../engine/temporal';
import { getEligibleParticipantsForSlot, getRejectionReason, REJECTION_REASONS_HE } from '../engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  type ConstraintViolation,
  Level,
  type Participant,
  type Schedule,
  SchedulingEngine,
  type SlotRequirement,
  type Task,
  ViolationSeverity,
} from '../index';
import type { ContinuitySnapshot } from '../models/continuity-schema';
import { computeTemplateSectionKey, oneTimeSectionKey } from '../shared/layout-key';
import { generateShiftBlocks, hourInOpDay } from '../shared/utils/time-utils';
import { scheduleToGantt } from '../ui/gantt-bridge';
import { computeAllCapacities } from '../utils/capacity';
import { describeTaskBidi, operationalDateKey, taskOpDayStart } from '../utils/date-utils';
import { register as registerTutorialHooks } from './app-tutorial-hooks';
import { runAutoTune, setAutoTunerTaskFactory, type TuneRecommendation } from './auto-tuner';
import { showCapabilityChangePicker } from './capability-change-modal';
import * as store from './config-store';
import { exportDaySnapshot } from './continuity-export';
import { parseContinuitySnapshot } from './continuity-import';
import { routeImportFromString, wireDataTransferEvents } from './data-transfer-ui';
import { buildDay0Schedule } from './day0-adapter';
import { exportDailyExcel, exportWeeklyExcel } from './excel-export';
import { installFocusTrap } from './focus-trap';
import {
  closeLoadingOverlay,
  openBatchPlansModal,
  openConfirmModal,
  openInfeasibleModal,
  openLoadingOverlay,
} from './future-sos-modal';
import { closeInjectTaskModal, initInjectTaskModal, openInjectTaskModal } from './inject-task-modal';
import { getEffectivePakalDefinitions } from './pakal-utils';
import { renderParticipantCard } from './participant-card';
import { exportDailyDetail, exportDailyImage, exportWeeklyOverview } from './pdf-export';
import { type PointInTimeContext, renderPointInTimeView, wirePointInTimeEvents } from './point-in-time-view';
import { runPreflight } from './preflight';
import { initPwaInstallCapture, runInstallPrompt } from './pwa-install';
import { showRangePicker } from './range-picker-modal';
import { closeRescueModal, initRescue, openRescueModal } from './rescue-modal';
import { initResponsive, isSmallScreen, isTouchDevice, onSmallScreenChange } from './responsive';
import { renderScheduleGrid } from './schedule-grid-view';
import {
  anchorToPickerDefaults,
  computeDefaultLiveAnchor,
  computePerDayHours,
  filterVisibleViolations,
  fmtRecoveryWindow,
  formatLiveClock,
  getDayWindow,
  getVisibleDayIndices,
  hasDay0,
  operationalHalfHourLabels,
  operationalHourOrder,
  resolveLogicalDayTimestamp,
  taskDayIndex,
  taskEndsAfter,
  taskIntersectsDay,
  taskStartsBefore,
  violationLabel,
} from './schedule-utils';
import { attachTripleClickOpener, clearAttemptScoreHistory, pushAttemptScore } from './score-breakdown-panel';
import { openSplitPicker } from './split-picker';
import { openSwapPicker } from './swap-picker';
import { initSwimlane, renderSwimlaneView, wireSwimlaneEvents } from './swimlane-view';
import { getWeightFieldLabel, renderAlgorithmTab, wireAlgorithmEvents } from './tab-algorithm';
import { type HomeNavTarget, renderHomeTab, wireHomeEvents } from './tab-home';
import {
  canLeaveParticipantsTab,
  clearParticipantSelection,
  formatWorkloadMultiplier,
  renderParticipantsTab,
  resetParticipantsTabViewState,
  wireParticipantsEvents,
} from './tab-participants';
import { type ProfileContext, renderProfileView, wireProfileEvents } from './tab-profile';
import { renderTaskPanel, TASK_PANEL_EMPTY, type TaskPanelContext, wireTaskPanelEvents } from './tab-task-panel';
import { renderTaskRulesTab, resetTaskRulesTabViewState, wireTaskRulesEvents } from './tab-task-rules';
import { hideTaskTooltip, hideTooltip, initTooltips, wireParticipantTooltip, wireTaskTooltip } from './tooltips';
import {
  exposeWindowApi as exposeTutorialWindowApi,
  isHomeWelcomeSeen,
  isBannerDismissed as isTutorialBannerDismissed,
  markBannerDismissed,
  markHomeWelcomeSeen,
  showTutorialBanner,
  startTutorial,
  type TutorialContext,
} from './tutorial';
import { restoreTutorialBackupIfPresent } from './tutorial-demo';
import {
  applyTheme,
  certBadges,
  escAttr,
  escHtml,
  fmt,
  getStoredDefaultAttempts,
  getStoredTheme,
  groupBadge,
  levelBadge,
  SVG_ICONS,
  stripDayPrefix,
} from './ui-helpers';
import {
  renderCustomSelect,
  showAlert,
  showBottomSheet,
  showConfirm,
  showContinuationModal,
  showContinuityImport,
  showPrompt,
  showTimePicker,
  showToast,
  wireCustomSelect,
} from './ui-modal';
import { initWorkloadPopup, openWorkloadPopup } from './workload-popup';
import { computeWeeklyWorkloads } from './workload-utils';

// ─── Globals ─────────────────────────────────────────────────────────────────

type TabId = 'home' | 'participants' | 'task-rules' | 'schedule' | 'algorithm';
const VALID_TABS = new Set<TabId>(['home', 'participants', 'task-rules', 'schedule', 'algorithm']);

let currentTab: TabId = 'home';
let engine: SchedulingEngine | null = null;
let currentSchedule: Schedule | null = null;
let scheduleElapsed = 0;
let scheduleActualAttempts = 0;
/** Currently viewed day (1–7). Always a specific day when schedule is shown. */
let currentDay = 1;

/** Stable context handed to the tutorial engine. Curated demo state means
 *  the engine no longer evaluates per-step preconditions or runs fallback
 *  actions; the context is kept around as a stable identity for the tour
 *  banner/launcher wiring but has no fields to read. */
const tutorialContext: TutorialContext = {};

// ─── URL hash ↔ tab/day sync ────────────────────────────────────────────────

function pushHash(replace = false): void {
  const day = currentTab === 'schedule' ? `/${currentDay}` : '';
  const hash = `#${currentTab}${day}`;
  if (location.hash === hash) return;
  if (replace) {
    history.replaceState(null, '', hash);
  } else {
    history.pushState(null, '', hash);
  }
}

function readHash(): void {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;
  const [tabPart, dayPart] = raw.split('/');
  if (VALID_TABS.has(tabPart as TabId)) currentTab = tabPart as TabId;
  if (dayPart) {
    const d = parseInt(dayPart, 10);
    // Allow d=0 for the Day 0 (continuity context) view; the renderer guards
    // visibility on `hasDay0(currentSchedule)` and falls back to day 1 when
    // continuity isn't attached.
    if (d >= 0 && d <= 7) currentDay = d;
  }
}
/** True while multi-attempt optimization is running */
let _isOptimizing = false;
/** True while a *continuation* of a prior run is in flight (vs. a fresh generation). Drives the overlay title swap. */
let _isContinuation = false;
/** Consecutive no-improvement continuations on the current schedule, drives the modal's diminishing-returns hint. Reset on fresh generate or on improvement. */
let _noImprovementStreak = 0;
/** AbortController for cancelling a running optimization */
let _optimAbortController: AbortController | null = null;
/** AbortController for stopping early and accepting the best result so far */
let _optimEarlyStopController: AbortController | null = null;
/** True while undo/redo is executing — prevents onStoreChanged from reconciling */
let _undoRedoInProgress = false;
/** True while tutorial-demo is bulk-loading or restoring state — prevents
 *  onStoreChanged from piling undo entries onto every individual mutation. */
let _suppressOnStoreChanged = false;
/** Parallel schedule snapshots kept in sync with the store's undo/redo stacks */
interface ScheduleSnapshot {
  schedule: Schedule | null;
  dirty: boolean;
}
const _scheduleUndoStack: ScheduleSnapshot[] = [];
const _scheduleRedoStack: ScheduleSnapshot[] = [];
/** Assignment IDs to animate after the next renderAll() — consumed once. */
let _pendingSwapAnimIds: Set<string> = new Set();
/**
 * True when the config store has been mutated after the latest schedule
 * generation.  Signals that the current schedule may be out of sync with
 * participants / rules.
 */
let _scheduleDirty = false;

/** True when the current schedule differs from the active snapshot */
let _snapshotDirty = false;

/**
 * Build a frozen cert-id → label snapshot from the live store. Called once
 * at engine construction so the engine's resolver never consults the store
 * again — edits to cert labels after generation do not leak into tooltips.
 */
function buildCertLabelSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const def of store.getCertificationDefinitions()) {
    snapshot[def.id] = def.label;
  }
  return snapshot;
}

/**
 * A persisted Schedule produced before the frozen-snapshot schema change
 * won't have `algorithmSettings` / `restRuleSnapshot` / `certLabelSnapshot`.
 * Rather than crashing on init, we detect that case and drop the schedule —
 * the user sees no schedule and regenerates. Pre-release: no migration.
 */
function hasFrozenFields(sched: Schedule | null | undefined): boolean {
  if (!sched) return false;
  const s = sched as Partial<Schedule>;
  return (
    !!s.algorithmSettings &&
    !!s.algorithmSettings.config &&
    s.restRuleSnapshot !== undefined &&
    s.certLabelSnapshot !== undefined &&
    s.periodStart instanceof Date &&
    typeof s.periodDays === 'number'
  );
}

/**
 * True if the schedule references a participant whose id is no longer in the
 * live store, or a task whose source template / one-time task is gone.
 * Drives the dirty warning on snapshot load and page reload.
 */
function scheduleHasOrphans(sched: Schedule): boolean {
  const liveParticipantIds = new Set(store.getAllParticipants().map((p) => p.id));
  if (sched.participants.some((p) => !liveParticipantIds.has(p.id))) return true;
  const liveSources = new Set<string>();
  for (const t of store.getAllTaskTemplates()) liveSources.add(t.name);
  for (const ot of store.getAllOneTimeTasks()) liveSources.add(ot.name);
  return sched.tasks.some(
    (t) => t.sourceName !== undefined && !t.injectedPostGeneration && !liveSources.has(t.sourceName),
  );
}
/** State for inline snapshot forms */
let _snapshotFormMode: 'none' | 'save-as' | 'rename' = 'none';
let _snapshotFormError = '';
/** Whether the snapshot panel is expanded */
let _snapshotPanelOpen = false;
/** Whether the workload sidebar is collapsed */
let _sidebarCollapsed = (() => {
  try {
    return localStorage.getItem('gm-sidebar-collapsed') === '1';
  } catch {
    return false;
  }
})();
let _availabilityInlineOpen = false;

// Range selection (replaces single-point _availabilityInlineTimeMs)
let _availabilityRangeStartMs: number | null = null;
let _availabilityRangeEndMs: number | null = null;

/** Continuity feature: pasted or auto-populated JSON from previous schedule */
let _continuityJson = '';
let _availabilityInspectorDay: number | null = null;
let _availabilityInspectorDayEnd: number | null = null;
let _availabilityInspectorTimeStart = '05:00';
let _availabilityInspectorTimeEnd = '06:00';
// Inline validation message for the strip's range pickers. When non-null the
// strip shows a small warning (and keeps the last successfully-committed
// _availabilityRange*Ms so results don't flash empty mid-edit).
let _availabilityRangeError: string | null = null;

// Margin toggle + values
let _availabilityMarginEnabled = false;
let _availabilityPreMarginHours = 2;
let _availabilityPostMarginHours = 1;
// Sleep-recovery view mode. `all` = today's default (everyone available, recovery
// participants tagged with 😴). `hide` = exclude recovery participants (the old
// "ללא השלמות שינה והתאוששות" checkbox behavior). `only` = invert — show ONLY
// participants whose recovery window overlaps the picked range, with their
// actual recovery times rendered inline and sorted chronologically.
type SleepRecoveryMode = 'all' | 'hide' | 'only';
let _availabilitySleepRecoveryMode: SleepRecoveryMode = 'all';

// Grouping mode for the availability bucket list. Default = פק"ל so the
// initial view matches the historical behavior; user can switch via the tab
// strip above the bucket list.
type AvailabilityGroupingMode = 'pakal' | 'group' | 'level' | 'cert';
let _availabilityGroupingMode: AvailabilityGroupingMode = 'pakal';

// Multi-select chip filters applied BEFORE bucketing. Empty set = no filter
// for that kind. AND across kinds, OR within each kind.
const _availabilityLevelFilter: Set<Level> = new Set();
const _availabilityCertFilter: Set<string> = new Set();
const _availabilityGroupFilter: Set<string> = new Set();

// Two-click cell range selection
let _timeCellSelectionPhase: 'idle' | 'start-selected' = 'idle';
let _timeCellSelectionStartMs: number | null = null;
let _liveClockInterval: ReturnType<typeof setInterval> | null = null;

// ─── View Router ─────────────────────────────────────────────────────────────

type ViewMode = 'SCHEDULE_VIEW' | 'PROFILE_VIEW' | 'TASK_PANEL_VIEW' | 'POINT_IN_TIME_VIEW';
let _viewMode: ViewMode = 'SCHEDULE_VIEW';
let _profileParticipantId: string | null = null;
/** Source name of the task currently shown in the per-task panel (null when not in TASK_PANEL_VIEW). */
let _taskPanelSourceName: string | null = null;
/** Selected timestamp for the point-in-time view (null when not in POINT_IN_TIME_VIEW). */
let _pointInTimeTimestamp: Date | null = null;
/** Whether the "פנויים" section is collapsed in the point-in-time view (default: collapsed). */
let _pointInTimeFreeCollapsed = true;
/** Saved scroll position of the schedule view for seamless return */
let _scheduleScrollY = 0;
/** When true, renderAll() will restore _scheduleScrollY after DOM replacement */
let _restoreScheduleScroll = false;
/** Progress state for the optimization overlay */
let _optimProgress: {
  attempt: number;
  totalAttempts: number;
  bestScore: number;
  bestUnfilled: number;
  lastImproved: boolean;
} | null = null;

/** The 24h window boundary hour (05:00–05:00 by default) */
// Day boundary hour is now configurable via store.getDayStartHour()

// ─── Manual Build Mode State ────────────────────────────────────────────────

let _manualBuildActive = false;
/** Swimlane "תצוגה כללית" section collapsed state — persists across re-renders. */
let _swimlaneCollapsed = true;
/** Currently selected slot in manual-build mode */
let _manualSelectedTaskId: string | null = null;
let _manualSelectedSlotId: string | null = null;
/** Cached eligible participant IDs for the selected slot */
let _eligibleForSelectedSlot: Set<string> | null = null;
/**
 * Manual-build undo stack — scoped to the manual-build strip's own
 * ↩ button. Post-generation swap undo flows through the store's undo
 * stack + `_scheduleUndoStack` so it lights up the header undo button.
 */
interface UndoEntry {
  kind: 'manual';
  assignments: Assignment[];
  label: string;
}
let _undoStack: UndoEntry[] = [];

function pushUndo(kind: UndoEntry['kind'], label: string): void {
  if (!currentSchedule) return;
  _undoStack.push({
    kind,
    assignments: currentSchedule.assignments.map((a) => ({ ...a })),
    label,
  });
  // Cap stack depth so long sessions don't balloon.
  if (_undoStack.length > 20) _undoStack.shift();
}

function popUndoByKind(kind: UndoEntry['kind']): UndoEntry | null {
  const top = _undoStack[_undoStack.length - 1];
  if (!top || top.kind !== kind) return null;
  _undoStack.pop();
  return top;
}

function applyUndoEntry(entry: UndoEntry): void {
  if (!currentSchedule || !engine) return;
  currentSchedule.assignments = entry.assignments;
  engine.importSchedule(currentSchedule);
  revalidateAndRefresh();
}
/** Warehouse search filter text */
let _warehouseFilter = '';

function clearManualSelection(): void {
  _manualSelectedTaskId = null;
  _manualSelectedSlotId = null;
  _eligibleForSelectedSlot = null;
}

function renderAvailabilityInspectorInline(): string {
  if (!currentSchedule) return '';
  const numDays = currentSchedule.periodDays;
  const dayStartHour = currentSchedule.algorithmSettings.dayStartHour;
  const selectedDayStart =
    _availabilityInspectorDay && _availabilityInspectorDay >= 1 && _availabilityInspectorDay <= numDays
      ? _availabilityInspectorDay
      : currentDay;
  _availabilityInspectorDay = selectedDayStart;
  const selectedDayEnd =
    _availabilityInspectorDayEnd && _availabilityInspectorDayEnd >= 1 && _availabilityInspectorDayEnd <= numDays
      ? _availabilityInspectorDayEnd
      : selectedDayStart;
  _availabilityInspectorDayEnd = selectedDayEnd;

  const normalizeHourLabel = (v: string): string => {
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    const h = m ? Math.max(0, Math.min(23, parseInt(m[1], 10))) : dayStartHour;
    const minRaw = m ? parseInt(m[2], 10) : 0;
    const min = minRaw >= 30 ? 30 : 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  _availabilityInspectorTimeStart = normalizeHourLabel(_availabilityInspectorTimeStart);
  _availabilityInspectorTimeEnd = normalizeHourLabel(_availabilityInspectorTimeEnd);

  const makeDayOptions = (selectedDay: number) => {
    const opts: { value: string; label: string; selected: boolean }[] = [];
    for (let d = 1; d <= numDays; d++) {
      opts.push({
        value: String(d),
        label: `יום ${d}`,
        selected: d === selectedDay,
      });
    }
    return opts;
  };

  const makeHourOptions = (selectedTime: string) =>
    operationalHalfHourLabels(dayStartHour).map((label) => ({
      value: label,
      label,
      selected: label === selectedTime,
    }));

  const marginDisplay = _availabilityMarginEnabled ? '' : ' style="display:none"';
  const hc15Disabled = new Set(currentSchedule.algorithmSettings.disabledHardConstraints).has('HC-15');

  // Chip filters — each kind is OR within the kind, AND across kinds.
  // Empty filter set = no constraint of that kind.
  const chip = (kind: 'level' | 'cert' | 'group', value: string, label: string, active: boolean): string =>
    `<button type="button" class="avail-strip-chip ${active ? 'avail-strip-chip-active' : ''}" data-chip-kind="${kind}" data-chip-value="${escAttr(value)}" data-no-swipe>${escHtml(label)}</button>`;

  const levelChips = [Level.L4, Level.L3, Level.L2, Level.L0]
    .map((lv) => chip('level', String(lv), `L${lv}`, _availabilityLevelFilter.has(lv)))
    .join('');
  const certEntries = Object.entries(currentSchedule.certLabelSnapshot);
  const certChips = certEntries
    .map(([cid, label]) => chip('cert', cid, label, _availabilityCertFilter.has(cid)))
    .join('');
  const groupSet = new Set<string>();
  for (const p of currentSchedule.participants) {
    const g = (p.group || '').trim();
    if (g) groupSet.add(g);
  }
  const groupChips = Array.from(groupSet)
    .sort((a, b) => a.localeCompare(b, 'he'))
    .map((g) => chip('group', g, g, _availabilityGroupFilter.has(g)))
    .join('');

  // Prune chip filter values whose chip is no longer rendered (e.g. cert
  // removed from the schedule, group eliminated by a regeneration). Otherwise
  // the filter would silently drop participants with no visible way to opt out
  // beyond the "נקה" link.
  const validCertIds = new Set(certEntries.map(([id]) => id));
  for (const id of _availabilityCertFilter) {
    if (!validCertIds.has(id)) _availabilityCertFilter.delete(id);
  }
  for (const g of _availabilityGroupFilter) {
    if (!groupSet.has(g)) _availabilityGroupFilter.delete(g);
  }
  const hasAnyFilter = _availabilityLevelFilter.size + _availabilityCertFilter.size + _availabilityGroupFilter.size > 0;

  return `
    <div class="avail-strip-inputs-row">
      <span class="avail-strip-range-label">מ:</span>
      ${renderCustomSelect({ id: 'gm-availability-day-start', options: makeDayOptions(selectedDayStart), className: 'input-sm availability-day-select' })}
      ${renderCustomSelect({ id: 'gm-availability-time-start', options: makeHourOptions(_availabilityInspectorTimeStart), className: 'input-sm availability-time-input' })}
      <span class="avail-strip-range-sep">—</span>
      <span class="avail-strip-range-label">עד:</span>
      ${renderCustomSelect({ id: 'gm-availability-day-end', options: makeDayOptions(selectedDayEnd), className: 'input-sm availability-day-select' })}
      ${renderCustomSelect({ id: 'gm-availability-time-end', options: makeHourOptions(_availabilityInspectorTimeEnd), className: 'input-sm availability-time-input' })}
    </div>
    ${_availabilityRangeError ? `<div class="avail-strip-range-error" role="status">⚠ ${escHtml(_availabilityRangeError)}</div>` : ''}
    <div class="avail-strip-margin-row">
      <label class="avail-strip-margin-toggle">
        <input type="checkbox" id="gm-availability-margin-toggle" ${_availabilityMarginEnabled ? 'checked' : ''} />
        <span>פנויים במרווח</span>
      </label>
      <div class="avail-strip-margin-fields"${marginDisplay}>
        <label>לפני: <input type="number" id="gm-availability-pre-margin" class="input-sm avail-margin-input" value="${_availabilityPreMarginHours}" min="0" max="24" step="0.5" /> שעות</label>
        <label>אחרי: <input type="number" id="gm-availability-post-margin" class="input-sm avail-margin-input" value="${_availabilityPostMarginHours}" min="0" max="24" step="0.5" /> שעות</label>
      </div>
    </div>
    <div class="avail-strip-chips-row">
      <div class="avail-strip-chip-group"><span class="avail-strip-chip-label">דרגה:</span>${levelChips}</div>
      ${certChips ? `<div class="avail-strip-chip-group"><span class="avail-strip-chip-label">הסמכות:</span>${certChips}</div>` : ''}
      ${groupChips ? `<div class="avail-strip-chip-group"><span class="avail-strip-chip-label">קבוצות:</span>${groupChips}</div>` : ''}
      ${hasAnyFilter ? `<button type="button" class="avail-strip-chip-clear" data-action="clear-availability-filters">נקה</button>` : ''}
    </div>
    ${
      hc15Disabled
        ? ''
        : (
            () => {
              const m = _availabilitySleepRecoveryMode;
              const modeChip = (value: SleepRecoveryMode, label: string): string =>
                `<button type="button" class="avail-strip-chip ${m === value ? 'avail-strip-chip-active' : ''}" data-recovery-mode="${value}">${label}</button>`;
              return `<div class="avail-strip-chips-row">
      <div class="avail-strip-chip-group"><span class="avail-strip-chip-label">השלמות שינה והתאוששות:</span>${modeChip('all', 'הכל')}${modeChip('hide', 'הסתר')}${modeChip('only', 'רק הם')}</div>
    </div>`;
            }
          )()
    }
  `;
}

/**
 * Round a timestamp down to the nearest half-hour so picked defaults align
 * with the strip's HH:00/HH:30 dropdown grid. Avoids "off-by-N-minutes"
 * dropdown labels that don't match the underlying range.
 */
function floorToHalfHour(ms: number): number {
  return ms - (ms % (30 * 60_000));
}

/**
 * The strip's grammar can address any timestamp from `[periodStart + dayStartHour]`
 * up to (but not including) the next op-day's start, since `_availabilityInspectorDayEnd`
 * is bounded by `periodDays`. The end of the very last op-day (`getDayWindow(periodDays).end`)
 * has dayIndex = `periodDays + 1` which is unrepresentable. Clamp endMs to the
 * last half-hour bucket BEFORE that boundary so the dropdowns always agree
 * with the underlying range — otherwise a subsequent "חשב מחדש" click would
 * read the clamped dropdowns and produce `tsEnd <= tsStart`.
 */
function clampToRepresentableHalfHour(ms: number, schedule: Schedule): number {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const lastValidEnd = getDayWindow(schedule.periodDays, dsh, schedule.periodStart).end.getTime() - 30 * 60_000;
  return Math.min(ms, lastValidEnd);
}

/**
 * Compute a sensible default range for the availability strip the first time
 * the user opens it on a given schedule:
 *   - Live mode on  → [now, now + 1h] rounded down to half-hour grid
 *   - Live mode off → the currently-selected day's op-day window (last half-hour
 *     trimmed so it stays inside the strip's day/time grammar — see
 *     clampToRepresentableHalfHour)
 * Also mirrors the result onto the strip's day/time dropdowns so the user
 * can see what was picked.
 */
function applySmartDefaultAvailabilityRange(): void {
  if (!currentSchedule) return;
  const schedule = currentSchedule;
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const lm = store.getLiveModeState();

  let startMs: number;
  let endMs: number;
  if (lm.enabled) {
    startMs = floorToHalfHour(lm.currentTimestamp.getTime());
    endMs = startMs + 60 * 60_000;
  } else {
    const win = getDayWindow(currentDay, dsh, base);
    startMs = win.start.getTime();
    endMs = win.end.getTime();
  }
  endMs = clampToRepresentableHalfHour(endMs, schedule);
  if (endMs <= startMs) {
    // Pathological case: live anchor right at the period boundary. Fall back
    // to a 30-min window ending at the last representable bucket.
    startMs = endMs - 30 * 60_000;
  }

  _availabilityRangeStartMs = startMs;
  _availabilityRangeEndMs = endMs;

  // Mirror onto the strip dropdowns so the inputs reflect the picked range.
  const anchor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), dsh, 0).getTime();
  const toDayIndex = (ms: number) => Math.max(1, Math.floor((ms - anchor) / 86400000) + 1);
  const toHourLabel = (ms: number) => {
    const d = new Date(ms);
    const min = d.getMinutes() >= 30 ? 30 : 0;
    return `${String(d.getHours()).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  _availabilityInspectorDay = toDayIndex(startMs);
  _availabilityInspectorDayEnd = toDayIndex(endMs);
  _availabilityInspectorTimeStart = toHourLabel(startMs);
  _availabilityInspectorTimeEnd = toHourLabel(endMs);
  _availabilityRangeError = null;
}

/**
 * Resolve the strip's day/time dropdown values into a concrete range and
 * commit it to `_availabilityRangeStartMs/EndMs`. On invalid input (e.g. end ≤
 * start) we set `_availabilityRangeError` instead and keep the last valid
 * committed range — that lets the user adjust dropdowns without the result
 * panel flashing empty mid-edit.
 *
 * Caller is responsible for triggering a re-render afterwards.
 */
function tryCommitDropdownRange(): void {
  if (!currentSchedule) return;
  const dayStart = _availabilityInspectorDay ?? currentDay;
  const dayEnd = _availabilityInspectorDayEnd ?? dayStart;
  const dsh = currentSchedule.algorithmSettings.dayStartHour;
  const base = currentSchedule.periodStart;
  const tsStart = resolveLogicalDayTimestamp(dayStart, _availabilityInspectorTimeStart, dsh, base);
  const tsEnd = resolveLogicalDayTimestamp(dayEnd, _availabilityInspectorTimeEnd, dsh, base);
  if (!tsStart || !tsEnd) {
    _availabilityRangeError = 'טווח לא תקין';
    return;
  }
  if (tsEnd.getTime() <= tsStart.getTime()) {
    _availabilityRangeError =
      dayEnd < dayStart
        ? 'יום הסיום חייב להיות זהה ליום ההתחלה או אחריו'
        : dayEnd === dayStart
          ? 'שעת סיום חייבת להיות אחרי שעת התחלה'
          : 'מועד הסיום חייב להיות אחרי מועד ההתחלה';
    return;
  }
  _availabilityRangeStartMs = tsStart.getTime();
  _availabilityRangeEndMs = tsEnd.getTime();
  _availabilityRangeError = null;
}

/** Collapsible availability strip between schedule grid and gantt */
function renderAvailabilityStrip(): string {
  if (!currentSchedule) return '';

  // Collapsed state — just the bar
  if (!_availabilityInlineOpen) {
    return `<div class="avail-strip" data-action="open-avail-strip">
      <span class="avail-strip-icon">🕐</span>
      <span class="avail-strip-label">בדיקת עתודה פנויה</span>
      <span class="avail-strip-arrow">◂</span>
    </div>`;
  }

  // Expanded state — inputs + results
  let html = `<div class="avail-strip avail-strip-open">`;
  html += `<div class="avail-strip-header" data-action="close-avail-strip">
    <span class="avail-strip-icon">🕐</span>
    <span class="avail-strip-label">בדיקת עתודה פנויה</span>
    <span class="avail-strip-arrow">▾</span>
  </div>`;

  html += `<div class="avail-strip-body">`;
  html += `<div class="avail-strip-inputs">${renderAvailabilityInspectorInline()}</div>`;

  if (_availabilityRangeStartMs !== null && _availabilityRangeEndMs !== null) {
    const preMs = _availabilityMarginEnabled ? _availabilityPreMarginHours * 3600000 : 0;
    const postMs = _availabilityMarginEnabled ? _availabilityPostMarginHours * 3600000 : 0;
    html += `<div class="avail-strip-results">${buildAvailabilityPopoverContent(_availabilityRangeStartMs, _availabilityRangeEndMs, preMs, postMs, _availabilitySleepRecoveryMode)}</div>`;
  }

  html += `</div></div>`;
  return html;
}

// ─── Template → Task Conversion ──────────────────────────────────────────────

let _tSlotCounter = 0;
let _tTaskCounter = 0;

function generateTasksFromTemplates(): Task[] {
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const dayStartHour = store.getDayStartHour();
  const templates = store.getAllTaskTemplates();
  const visuals = store.getTemplateVisualMap();
  // Effective split gate: a task is splittable for THIS run only if the
  // template opted in AND the per-run mode is not 'off'. Frozen onto the
  // task so the optimizer needs no separate run flag and reload is coherent.
  const splitEnabled = (store.getAlgorithmSettings().splittingMode ?? 'quality') !== 'off';
  const allTasks: Task[] = [];
  _tSlotCounter = 0;
  _tTaskCounter = 0;

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) {
        console.warn(
          `Template "${tpl.name}" has invalid shiftsPerDay (${tpl.shiftsPerDay}) or durationHours (${tpl.durationHours}) — skipping`,
        );
        continue;
      }
      // hourInOpDay handles the case where startHour < dayStartHour (post-midnight tail).
      const startDate = new Date(hourInOpDay(baseDate, dayStartHour, dayIdx + 1, tpl.startHour));

      const shifts: { start: Date; end: Date }[] =
        tpl.shiftsPerDay === 1
          ? [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }]
          : generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams) {
          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) {
              console.warn(`Slot "${s.label}" in template "${tpl.name}" has no acceptable levels — skipping`);
              continue;
            }
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              label: s.label,
              subTeamLabel: st.name,
              subTeamId: st.id,
            });
          }
        }

        for (const s of tpl.slots) {
          if (s.acceptableLevels.length === 0) {
            console.warn(`Slot "${s.label}" in template "${tpl.name}" has no acceptable levels — skipping`);
            continue;
          }
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_tSlotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        const v = visuals[tpl.name];
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_tTaskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          restRuleId: tpl.restRuleId,
          sleepRecovery: tpl.sleepRecovery
            ? { ...tpl.sleepRecovery, triggerShifts: [...tpl.sleepRecovery.triggerShifts] }
            : undefined,
          shiftIndex: si + 1,
          sectionKey: computeTemplateSectionKey(tpl),
          color: tpl.color || v?.color || '#7f8c8d',
          splittable: splitEnabled && (tpl.splittable ?? false),
        });
      }
    }
  }

  // ── One-Time Tasks ───────────────────────────────────────────────────────
  const allOneTimeTasks = store.getAllOneTimeTasks();
  const windowStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const windowEnd = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + numDays);

  for (const ot of allOneTimeTasks) {
    const otDay = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());

    // Range filter: skip if outside scheduling window
    if (otDay < windowStart || otDay >= windowEnd) continue;

    const dayIdx = Math.round((otDay.getTime() - windowStart.getTime()) / 86400000);
    const dayLabel = `D${dayIdx + 1}`;

    const startMs = hourInOpDay(baseDate, dayStartHour, dayIdx + 1, ot.startHour) + (ot.startMinute || 0) * 60_000;
    const start = new Date(startMs);
    const end = new Date(startMs + ot.durationHours * 3600000);

    // Build slots (same logic as template slot building above)
    const slots: SlotRequirement[] = [];
    for (const st of ot.subTeams) {
      for (const s of st.slots) {
        if (s.acceptableLevels.length === 0) continue;
        slots.push({
          slotId: `ot-slot-${++_tSlotCounter}`,
          acceptableLevels: [...s.acceptableLevels],
          requiredCertifications: [...s.requiredCertifications],
          forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
          label: s.label,
          subTeamLabel: st.name,
          subTeamId: st.id,
        });
      }
    }
    for (const s of ot.slots) {
      if (s.acceptableLevels.length === 0) continue;
      slots.push({
        slotId: `ot-slot-${++_tSlotCounter}`,
        acceptableLevels: [...s.acceptableLevels],
        requiredCertifications: [...s.requiredCertifications],
        forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        label: s.label,
      });
    }

    allTasks.push({
      id: `ot-${ot.id}-d${dayIdx + 1}-${++_tTaskCounter}`,
      name: `${dayLabel} ${ot.name}`,
      sourceName: ot.name,
      timeBlock: { start, end },
      requiredCount: slots.length,
      slots,
      baseLoadWeight: ot.baseLoadWeight,
      loadWindows: (ot.loadWindows ?? []).map((w) => ({ ...w })),
      sameGroupRequired: ot.sameGroupRequired,
      blocksConsecutive: ot.blocksConsecutive,
      schedulingPriority: ot.schedulingPriority,
      togethernessRelevant: ot.togethernessRelevant,
      restRuleId: ot.restRuleId,
      sleepRecovery: ot.sleepRecovery
        ? { ...ot.sleepRecovery, triggerShifts: [...ot.sleepRecovery.triggerShifts] }
        : undefined,
      shiftIndex: 1,
      sectionKey: oneTimeSectionKey(ot.id),
      color: ot.color || '#7f8c8d',
      splittable: splitEnabled && (ot.splittable ?? false),
    });
  }

  return allTasks;
}

// ─── Day Filtering ───────────────────────────────────────────────────────────

/** Get tasks that intersect the current day's window (uses schedule's frozen period). */
function getFilteredTasks(schedule: Schedule): Task[] {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  return schedule.tasks.filter((t) => taskIntersectsDay(t, currentDay, dsh, base));
}

/** Get assignments for tasks visible in the current day */
function getFilteredAssignments(schedule: Schedule): Assignment[] {
  const filteredTaskIds = new Set(getFilteredTasks(schedule).map((t) => t.id));
  return schedule.assignments.filter((a) => filteredTaskIds.has(a.taskId));
}

// ─── Day Navigator ───────────────────────────────────────────────────────────

/** Render the day navigation tabs (Day 0 if continuity is attached, then 1..periodDays). */
function renderDayNavigator(): string {
  // Display path: prefer the frozen schedule's period so the navigator stays
  // consistent with the rendered schedule even if the live store drifts.
  const numDays = currentSchedule?.periodDays ?? store.getScheduleDays();
  const baseDate = currentSchedule?.periodStart ?? store.getScheduleDate();
  const liveMode = store.getLiveModeState();

  // Day 0 is shown only when the schedule has continuity context attached
  // and we're not in manual-build mode (manual edits target real days only).
  const showDay0 = !!currentSchedule && hasDay0(currentSchedule) && !_manualBuildActive;
  const visibleDays: number[] = [];
  if (showDay0) visibleDays.push(0);
  for (let d = 1; d <= numDays; d++) visibleDays.push(d);

  type DayMeta = { violationCount: number; frozenTag: string; frozenClass: string };
  const metaByDay = new Map<number, DayMeta>();

  for (const d of visibleDays) {
    let violationCount = 0;
    let frozenTag = '';
    let frozenClass = '';
    // Day 0 is read-only context: no violations and no live-mode freeze badge.
    if (d !== 0 && currentSchedule) {
      const dsh = currentSchedule.algorithmSettings.dayStartHour;
      const frozenDisabled = new Set(currentSchedule.algorithmSettings.disabledHardConstraints);
      const dayTaskIds = new Set(
        currentSchedule.tasks.filter((t) => taskIntersectsDay(t, d, dsh, baseDate)).map((t) => t.id),
      );
      violationCount = filterVisibleViolations(currentSchedule.violations, frozenDisabled).filter(
        (v) => v.severity === ViolationSeverity.Error && v.taskId && dayTaskIds.has(v.taskId),
      ).length;

      if (liveMode.enabled) {
        if (isDayFrozen(d, baseDate, liveMode.currentTimestamp, store.getDayStartHour())) {
          frozenTag = `<span class="day-frozen-badge" title="היום הזה מוקפא כי הוא בעבר">🧊</span>`;
          frozenClass = ' day-tab-frozen';
        } else if (isDayPartiallyFrozen(d, baseDate, liveMode.currentTimestamp, store.getDayStartHour())) {
          frozenTag = `<span class="day-frozen-badge day-frozen-partial" title="מוקפא חלקית לפי שעה נוכחית">⏳</span>`;
          frozenClass = ' day-tab-partial-frozen';
        }
      }
    }
    metaByDay.set(d, { violationCount, frozenTag, frozenClass });
  }

  let tabs = `<div class="day-navigator">`;
  for (const d of visibleDays) {
    const m = metaByDay.get(d)!;
    const isDay0 = d === 0;
    const day0Cls = isDay0 ? ' day-tab-day0' : '';
    const violationDot =
      m.violationCount > 0 ? `<span class="day-violation-dot" title="${m.violationCount} הפרות">!</span>` : '';
    const label = isDay0 ? `📋 יום 0 · הקשר` : `יום ${d}`;
    const ariaLabel = isDay0 ? 'יום 0 — הקשר זמני, קריאה בלבד' : `יום ${d}`;
    tabs += `<button class="day-tab ${currentDay === d ? 'day-tab-active' : ''}${m.frozenClass}${day0Cls}" data-day="${d}" aria-label="${ariaLabel}">
      <span class="day-tab-label">${label}</span>
      ${violationDot}
      ${m.frozenTag}
    </button>`;
  }
  tabs += `</div>`;

  const minDay = visibleDays[0] ?? 1;
  const maxDay = visibleDays[visibleDays.length - 1] ?? numDays;
  const cur = Math.min(Math.max(currentDay, minDay), maxDay);
  const curMeta = metaByDay.get(cur)!;
  const canPrev = cur > minDay;
  const canNext = cur < maxDay;
  const heroViolation =
    curMeta.violationCount > 0
      ? `<span class="day-hero-violation" title="${curMeta.violationCount} הפרות">!${curMeta.violationCount}</span>`
      : '';

  let dots = '';
  for (const d of visibleDays) {
    const m = metaByDay.get(d)!;
    const isDay0 = d === 0;
    const activeCls = d === cur ? ' day-hero-dot-active' : '';
    const violCls = m.violationCount > 0 ? ' day-hero-dot-violation' : '';
    const day0Cls = isDay0 ? ' day-hero-dot-day0' : '';
    const dotLabel = isDay0
      ? 'יום 0 — הקשר זמני, קריאה בלבד'
      : `יום ${d}${m.violationCount > 0 ? ` (${m.violationCount} הפרות)` : ''}`;
    dots += `<button class="day-hero-dot${activeCls}${violCls}${m.frozenClass}${day0Cls}" data-day="${d}" aria-label="${dotLabel}">
      <span class="day-hero-dot-num">${isDay0 ? '0' : d}</span>
    </button>`;
  }

  const heroLabel = cur === 0 ? '📋 יום 0 · הקשר' : `יום ${cur}`;
  const hero = `<div class="day-hero">
    <div class="day-hero-main">
      <button class="day-hero-step" data-day-step="-1" aria-label="יום קודם"${canPrev ? '' : ' disabled'}>‹</button>
      <div class="day-hero-title">
        <span class="day-hero-label">${heroLabel}</span>
        ${heroViolation}${curMeta.frozenTag}
      </div>
      <button class="day-hero-step" data-day-step="1" aria-label="יום הבא"${canNext ? '' : ' disabled'}>›</button>
    </div>
    <div class="day-hero-dots">${dots}</div>
  </div>`;

  return `<div class="day-nav-wrap">${tabs}${hero}</div>`;
}

function stepDay(delta: number): void {
  if (!delta) return;
  const numDays = currentSchedule?.periodDays ?? store.getScheduleDays();
  const minDay = currentSchedule && hasDay0(currentSchedule) ? 0 : 1;
  const next = currentDay + delta;
  if (next < minDay || next > numDays) return;
  currentDay = next;
  pushHash(true);
  renderAll();
}

function wireScheduleSwipe(container: HTMLElement): void {
  const body = container.querySelector<HTMLElement>('.schedule-main');
  if (!body) return;
  const heroDots = container.querySelector<HTMLElement>('.day-hero-dots');

  type Ctx = {
    startX: number;
    startY: number;
    startT: number;
    scrollerStart: Map<HTMLElement, number>;
  };
  let ctx: Ctx | null = null;

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      ctx = null;
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.assignment-card, button, input, textarea, select, a, [data-no-swipe]')) {
      ctx = null;
      return;
    }
    // Remember scrollLeft on any horizontally-scrollable ancestor so we can
    // bail from the day-swipe if the grid absorbed the gesture as a scroll.
    const scrollerStart = new Map<HTMLElement, number>();
    let node: HTMLElement | null = target;
    const stopAt = body.parentElement;
    while (node && node !== stopAt) {
      const cs = getComputedStyle(node);
      const ox = cs.overflowX;
      if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth) {
        scrollerStart.set(node, node.scrollLeft);
      }
      node = node.parentElement;
    }
    ctx = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      startT: Date.now(),
      scrollerStart,
    };
  };

  const onEnd = (e: TouchEvent) => {
    if (!ctx) return;
    const c = ctx;
    ctx = null;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - c.startX;
    const dy = t.clientY - c.startY;
    const dt = Date.now() - c.startT;
    if (dt > 600) return;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < 60 || ax < ay * 1.5) return;
    for (const [el, origScroll] of c.scrollerStart) {
      if (el.scrollLeft !== origScroll) return;
    }
    // In RTL, advancing through the week is a left→right finger motion (dx>0).
    stepDay(dx < 0 ? -1 : 1);
  };

  const onCancel = () => {
    ctx = null;
  };

  body.addEventListener('touchstart', onStart, { passive: true });
  body.addEventListener('touchend', onEnd, { passive: true });
  body.addEventListener('touchcancel', onCancel, { passive: true });

  if (heroDots) {
    heroDots.addEventListener('touchstart', onStart, { passive: true });
    heroDots.addEventListener('touchend', onEnd, { passive: true });
    heroDots.addEventListener('touchcancel', onCancel, { passive: true });
  }
}

// ─── Weekly Dashboard (Always Visible Header) ────────────────────────────────

/** Render the sticky weekly performance dashboard that stays visible across day tabs */
function renderWeeklyDashboard(schedule: Schedule): string {
  const score = schedule.score;
  const frozenDisabled = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const visibleViolations = filterVisibleViolations(schedule.violations, frozenDisabled);
  const totalViolations = visibleViolations.filter((v) => v.severity === ViolationSeverity.Error).length;
  const warnings = visibleViolations.filter((v) => v.severity === ViolationSeverity.Warning).length;
  const feasibleClass = schedule.feasible ? 'kpi-ok' : 'kpi-error';

  const heroIcon = schedule.feasible ? '✓' : '✗';
  const heroLabel = schedule.feasible ? 'ישים' : 'לא ישים';
  const scoreText = score.compositeScore.toFixed(1);
  const isClean = schedule.feasible && totalViolations === 0 && warnings === 0;

  const violationsCell =
    totalViolations > 0
      ? `<div class="kpi-cell kpi-error">
          <span class="kpi-value" id="kpi-violations" data-target="${totalViolations}">${totalViolations}</span>
          <span class="kpi-label">הפרות</span>
        </div>`
      : '';
  const warningsCell =
    warnings > 0
      ? `<div class="kpi-cell kpi-warn kpi-cell-clickable" data-action="jump-to-violations" role="button" tabindex="0" title="עבור לאזהרות והפרות" aria-label="עבור לאזהרות והפרות">
          <span class="kpi-value" id="kpi-warnings" data-target="${warnings}">${warnings}</span>
          <span class="kpi-label">אזהרות</span>
        </div>`
      : '';

  const heroBlock = isClean
    ? `<div class="kpi-hero kpi-ok kpi-hero-combined">
        <div class="kpi-hero-status">
          <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
          <span class="kpi-hero-label" id="kpi-feasible">${heroLabel}</span>
        </div>
        <span class="kpi-hero-divider" aria-hidden="true"></span>
        <div class="kpi-hero-score">
          <span class="kpi-value" id="kpi-score" data-target="${scoreText}">${scoreText}</span>
          <span class="kpi-label">ציון</span>
        </div>
      </div>`
    : `<div class="kpi-hero ${feasibleClass}">
        <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
        <span class="kpi-hero-label" id="kpi-feasible">${heroLabel}</span>
      </div>`;

  const kpiStrip = isClean
    ? ''
    : `<div class="kpi-strip" role="group" aria-label="ציונים">
        <div class="kpi-cell">
          <span class="kpi-value" id="kpi-score" data-target="${scoreText}">${scoreText}</span>
          <span class="kpi-label">ציון</span>
        </div>
        ${violationsCell}
        ${warningsCell}
      </div>`;

  return `<div class="weekly-dashboard">
    <div class="dashboard-row">
      ${heroBlock}

      ${kpiStrip}
    </div>
    <div class="dashboard-meta">
      ${
        scheduleActualAttempts > 0
          ? `התוצאה הטובה ביותר מתוך ${scheduleActualAttempts} ניסיונות, בזמן חישוב של ${(scheduleElapsed / 1000).toFixed(1)} שניות.`
          : 'שבצ"ק נבנה ידנית.'
      }
    </div>
  </div>`;
}

// ─── Participant Status Sidebar ──────────────────────────────────────────────

/** Build a single sidebar entry's HTML.
 *
 * Bar widths are in *utilization space*: how much of the participant's actual
 * available hours (period-total and per-day) is consumed by their assignments.
 * The `100/60` factor saturates the bar at 60% utilization — typical
 * fully-booked participants render near full bar width on the new scale.
 */
function renderSidebarEntry(entry: {
  p: Participant;
  w: { totalHours: number; effectiveHours: number; hotHours: number; coldHours: number; loadBearingCount: number };
  pctOfCapacity: number;
  perDay: Map<number, number>;
  todayCap: number;
}): string {
  const p = entry.p;
  const barWidth = Math.min(entry.pctOfCapacity * (100 / 60), 100);

  const todayHrs = entry.perDay.get(currentDay) || 0;
  const todayUtilPct = entry.todayCap > 0 ? (todayHrs / entry.todayCap) * 100 : 0;
  const todayBarWidth = Math.min(todayUtilPct * (100 / 60), barWidth);

  const mult = p.workloadMultiplier ?? 1;
  const hasMult = Math.abs(mult - 1) > 1e-9;
  const multDisplay = formatWorkloadMultiplier(mult);
  const multBadge = hasMult
    ? ` <span class="sidebar-mult-badge" title="מקדם עומס ${multDisplay} — היעד הוגנות מותאם בהתאם.">×${multDisplay}</span>`
    : '';
  const hoverTitle = `${escHtml(p.name)} — ${entry.w.effectiveHours.toFixed(1)} שעות עומס (${entry.pctOfCapacity.toFixed(1)}% מהזמינות)${hasMult ? ` · מקדם עומס ×${multDisplay}` : ''}`;

  return `<div class="sidebar-entry">
    <div class="sidebar-name">
      <span class="participant-hover" data-pid="${p.id}">${escHtml(p.name)}</span>${multBadge}
      <span class="sidebar-meta">${groupBadge(p.group)} ${levelBadge(p.level)}</span>
    </div>
    <div class="sidebar-bar-row">
      <div class="sidebar-bar-bg" title="${hoverTitle}" data-pid="${p.id}">
        <div class="sidebar-bar-fill" style="width:${barWidth}%"></div>
        <div class="sidebar-bar-today" style="width:${todayBarWidth}%"></div>
        <span class="sidebar-bar-label">${entry.w.effectiveHours.toFixed(1)} שעות עומס (${entry.pctOfCapacity.toFixed(1)}%)</span>
      </div>
      <span class="sidebar-today-tag" title="היום (יום ${currentDay}): ${todayHrs.toFixed(1)} שע'">
        יום ${currentDay}: ${todayHrs.toFixed(1)} שע'
      </span>
    </div>
  </div>`;
}

/**
 * Render the participant sidebar with split pools:
 * - L0 workload shown by default (primary focus)
 * - Senior (L2-L4) workload hidden behind a toggle button
 */
function renderParticipantSidebar(schedule: Schedule): string {
  const numDays = schedule.periodDays;

  // Capacity-aware: build per-participant capacities once and feed them to
  // computeWeeklyWorkloads so each WeeklyWorkload carries availableHours +
  // loadRatio. The sidebar bar then renders in utilization space (effective
  // hours / available hours), matching the participant-card and the new
  // SC-8 scoring semantics.
  let schedStart = schedule.tasks[0]?.timeBlock.start ?? schedule.periodStart;
  let schedEnd = schedule.tasks[0]?.timeBlock.end ?? schedule.periodStart;
  for (const t of schedule.tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const dsh = schedule.algorithmSettings.dayStartHour;
  const capacities = computeAllCapacities(schedule.participants, schedStart, schedEnd, dsh);
  const workloads = computeWeeklyWorkloads(schedule.participants, schedule.assignments, schedule.tasks, capacities);

  // Op-day key for the currently-displayed day, used to look up each
  // participant's capacity for "today".
  const todayDate = new Date(
    schedule.periodStart.getFullYear(),
    schedule.periodStart.getMonth(),
    schedule.periodStart.getDate() + currentDay - 1,
    dsh,
    0,
    0,
    0,
  );
  const todayKey = operationalDateKey(todayDate, dsh);

  const sidebarTaskMap = new Map<string, Task>(schedule.tasks.map((t) => [t.id, t]));

  // Build all entries
  const allEntries = schedule.participants.map((p) => {
    const w = workloads.get(p.id) || {
      totalHours: 0,
      effectiveHours: 0,
      hotHours: 0,
      coldHours: 0,
      loadBearingCount: 0,
    };
    const cap = capacities.get(p.id);
    const pctOfCapacity = w.availableHours && w.availableHours > 0 ? (w.effectiveHours / w.availableHours) * 100 : 0;
    const perDay = computePerDayHours(p.id, schedule, sidebarTaskMap);
    const todayCap = cap?.dailyAvailableHours.get(todayKey) ?? 0;
    return { p, w, pctOfCapacity, perDay, todayCap };
  });

  // Split into L0 and Senior pools
  const l0Entries = allEntries
    .filter((e) => e.p.level === Level.L0)
    .sort((a, b) => b.w.effectiveHours - a.w.effectiveHours);
  const seniorEntries = allEntries
    .filter((e) => e.p.level !== Level.L0)
    .sort((a, b) => b.w.effectiveHours - a.w.effectiveHours);

  // L0 stats
  const l0Total = l0Entries.reduce((s, e) => s + e.w.effectiveHours, 0);
  const l0Avg = l0Entries.length > 0 ? l0Total / l0Entries.length : 0;
  const l0Var =
    l0Entries.length > 0 ? l0Entries.reduce((s, e) => s + (e.w.effectiveHours - l0Avg) ** 2, 0) / l0Entries.length : 0;
  const _l0Sigma = Math.sqrt(l0Var);

  // Senior stats
  const seniorTotal = seniorEntries.reduce((s, e) => s + e.w.effectiveHours, 0);
  const seniorAvg = seniorEntries.length > 0 ? seniorTotal / seniorEntries.length : 0;
  const seniorVar =
    seniorEntries.length > 0
      ? seniorEntries.reduce((s, e) => s + (e.w.effectiveHours - seniorAvg) ** 2, 0) / seniorEntries.length
      : 0;
  const seniorSigma = Math.sqrt(seniorVar);

  // ── L0 Section (always visible) ──
  let html = `<div class="participant-sidebar${_sidebarCollapsed ? ' sidebar-collapsed' : ''}">`;

  // Always render the toggle button
  html += `<button class="sidebar-toggle" data-action="sidebar-toggle" title="${_sidebarCollapsed ? 'הרחב סרגל עומס' : 'כווץ סרגל עומס'}">${_sidebarCollapsed ? '◀' : '▶'}</button>`;

  if (_sidebarCollapsed) {
    // Mini bars — tiny workload indicators for each L0 participant
    html += `<div class="sidebar-mini">`;
    for (const entry of l0Entries) {
      html += `<div class="sidebar-mini-bar" title="${entry.p.name}: ${entry.w.effectiveHours.toFixed(1)} שעות עומס"></div>`;
    }
    html += `</div></div>`;
    return html;
  }

  html += `<div class="sidebar-header">
      <div class="sidebar-header-row">
        <h3>השוואת עומס</h3>
      </div>
      <div class="sidebar-avg">ממוצע: ${l0Avg.toFixed(1)} שעות עומס · ${l0Entries.length} משתתפים · ${numDays} ימים</div>
    </div>
    <div class="sidebar-entries">`;

  for (const entry of l0Entries) {
    html += renderSidebarEntry(entry);
  }

  html += `</div>`;

  // ── Senior Section (hidden by default) ──
  html += `
    <div class="sidebar-senior-divider">
      <button class="btn-senior-toggle" id="btn-senior-toggle" title="הצג / הסתר עומס סגל (L2-L4)">
        👤 עומס סגל (${seniorEntries.length})
        <span class="senior-toggle-arrow" id="senior-toggle-arrow">▶</span>
      </button>
    </div>
    <div class="sidebar-senior-panel hidden" id="sidebar-senior-panel">
      <div class="sidebar-header sidebar-header-senior">
        <h3>עומס סגל (L2-L4)</h3>
        <div class="sidebar-avg">ממוצע: ${seniorAvg.toFixed(1)} שעות עומס · σ ${seniorSigma.toFixed(2)} · ${seniorEntries.length} משתתפים</div>
      </div>
      <div class="sidebar-entries">`;

  for (const entry of seniorEntries) {
    html += renderSidebarEntry(entry);
  }

  html += `</div></div></div>`;
  return html;
}

// ─── Schedule Tab ────────────────────────────────────────────────────────────

function renderScheduleTab(preflight: ReturnType<typeof runPreflight>): string {
  const liveMode = store.getLiveModeState();
  // Display count follows the frozen schedule when one exists so the header
  // label and Live Mode options match what's rendered. The `input-days`
  // control below separately reflects the live default for the *next* run.
  const displayNumDays = currentSchedule?.periodDays ?? store.getScheduleDays();
  const inputNumDays = store.getScheduleDays();

  // Build Live Mode day/hour options
  let liveModeControls = '';
  if (currentSchedule) {
    const baseDate = currentSchedule.periodStart;
    const daySelectOpts: { value: string; label: string; selected: boolean }[] = [];
    for (let d = 1; d <= displayNumDays; d++) {
      const label = `יום ${d}`;
      let selected = false;
      if (liveMode.enabled) {
        const anchor = liveMode.currentTimestamp;
        const dayStart = new Date(
          baseDate.getFullYear(),
          baseDate.getMonth(),
          baseDate.getDate() + d - 1,
          store.getDayStartHour(),
          0,
        );
        const dayEnd = new Date(
          baseDate.getFullYear(),
          baseDate.getMonth(),
          baseDate.getDate() + d,
          store.getDayStartHour(),
          0,
        );
        selected = anchor.getTime() >= dayStart.getTime() && anchor.getTime() < dayEnd.getTime();
      }
      daySelectOpts.push({ value: String(d), label, selected });
    }
    // Fallback: if no day matched (anchor outside schedule range), select day 1
    if (liveMode.enabled && !daySelectOpts.some((o) => o.selected) && daySelectOpts.length > 0) {
      daySelectOpts[0].selected = true;
    }

    const frozenDayStartHour = currentSchedule.algorithmSettings.dayStartHour;
    const anchorHour = liveMode.enabled ? liveMode.currentTimestamp.getHours() : frozenDayStartHour;
    const hourSelectOpts: { value: string; label: string; selected: boolean }[] = operationalHourOrder(
      frozenDayStartHour,
    ).map((h) => ({
      value: String(h),
      label: `${String(h).padStart(2, '0')}:00`,
      selected: h === anchorHour,
    }));

    liveModeControls = `
      <div class="live-mode-controls">
        <label class="live-mode-toggle" title="Enable Live Mode to freeze past assignments">
          <input type="checkbox" id="chk-live-mode" ${liveMode.enabled ? 'checked' : ''} />
          <span class="live-toggle-label">🔴 מצב חי</span>
        </label>
        ${
          liveMode.enabled
            ? `
          <div class="live-mode-picker">
            <span class="live-picker-label">זמן נוכחי:</span>
            ${renderCustomSelect({ id: 'gm-live-day', options: daySelectOpts, className: 'input-sm' })}
            ${renderCustomSelect({ id: 'gm-live-hour', options: hourSelectOpts, className: 'input-sm' })}
          </div>
        `
            : ''
        }
      </div>`;
  }

  let html = `<div class="tab-toolbar schedule-toolbar${_manualBuildActive ? ' schedule-toolbar-manual' : ''}">
    <div class="toolbar-left"><h2>תצוגת שבצ"ק</h2>
      <span class="text-muted" style="margin-inline-start:12px">שבצ"ק ל-${displayNumDays} ימים</span>
    </div>
    <div class="toolbar-right">
      ${liveModeControls}
      <span class="toolbar-group toolbar-group--generate">
        <label class="scenarios-label" for="input-days" title="מספר ימים בשבצ"ק">ימים
          <input type="number" id="input-days" class="input-scenarios" min="1" max="7" step="1" value="${inputNumDays}" ${_isOptimizing ? 'disabled' : ''} />
        </label>
        <label class="scenarios-label" for="input-scenarios" title="מספר ניסיונות אופטימיזציה לבדיקה">ניסיונות
          <input type="number" id="input-scenarios" class="input-scenarios" min="1" step="1" value="${OPTIM_ATTEMPTS}" ${_isOptimizing ? 'disabled' : ''} />
        </label>
        <button class="btn-primary ${_scheduleDirty && currentSchedule ? 'btn-generate-dirty' : ''}" id="btn-generate" ${!preflight.canGenerate || _isOptimizing ? 'disabled' : ''}
          ${!preflight.canGenerate ? 'title="תקן בעיות קריטיות בכללי המשימות תחילה"' : ''}>
          ${_isOptimizing ? '⏳ מייעל…' : currentSchedule ? '🔄 צור מחדש' : '⚡ צור שבצ"ק'}
        </button>
      </span>
      <span class="toolbar-group toolbar-group--state">
        ${currentSchedule ? `<button class="btn-sm ${_manualBuildActive ? 'btn-primary' : 'btn-outline'}" id="btn-manual-build" title="${_manualBuildActive ? 'יציאה ממצב בנייה ידנית' : 'בנייה ידנית של שבצ"ק'}">${_manualBuildActive ? '✕ יציאה מבנייה ידנית' : '✏️ בנייה ידנית'}</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-reset-schedule" title="אפס את מסך השבצ&quot;ק וחזור למצב שלפני יצירת השבצ&quot;ק (המשתתפים והמשימות יישמרו)">🔄 אפס</button>` : ''}
        <button class="btn-sm ${_snapshotPanelOpen ? 'btn-primary' : 'btn-outline'}" id="btn-snap-toggle" title="תמונות מצב שמורות">💾 שמירת שבצקים${store.getAllSnapshots().length > 0 ? ` (${store.getAllSnapshots().length})` : ''}</button>
        ${renderContinuityChip()}
        ${!currentSchedule && !_continuityJson.trim() ? `<button class="btn-sm btn-outline" id="btn-continuity-import" title="חיבור לשבצ"ק קודם — ייבוא נתוני המשכיות">📋 חיבור לשבצ"ק קודם</button>` : ''}
      </span>
      <span class="toolbar-group toolbar-group--day-actions">
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-where-is-everyone" title="הצג היכן כל המשתתפים בנקודת זמן נבחרת">👥 תמונת מצב</button>` : ''}
        ${currentSchedule && currentDay !== 0 ? `<button class="btn-sm btn-outline btn-inject-task" id="btn-inject-task" title="הוספת משימת חירום לתמונת המצב הנוכחית" ${_isOptimizing ? 'disabled' : ''}>🚨 הוסף משימת חירום</button>` : ''}
        ${currentSchedule && currentDay !== 0 ? `<button class="btn-sm btn-outline" id="btn-export-day-json" title="ייצוא מצב יום ${currentDay} כ-JSON להמשכיות">📋 ייצוא יום</button>` : ''}
        ${currentSchedule && currentDay !== 0 ? `<button class="btn-sm btn-outline" id="btn-generate-from-day" title="צור שבצ"ק חדש מסוף יום ${currentDay}">🔗 המשך מכאן</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-export-pdf" title="ייצוא">📤 ייצוא</button>` : ''}
      </span>
    </div>
  </div>`;

  // ── Snapshot Library Panel (collapsible) ──
  if (_snapshotPanelOpen) {
    html += renderSnapshotPanel();
  }

  if (_scheduleDirty && currentSchedule) {
    html += `<div class="dirty-notice">⚠ השיבוץ לא מעודכן. מומלץ ליצור אותו מחדש.</div>`;
  }

  if (!preflight.canGenerate) {
    const crits = preflight.findings.filter((f) => f.severity === 'Critical');
    html += `<div class="alert alert-error">
      <strong>לא ניתן ליצור שיבוץ - נמצאו ${crits.length} בעיות קריטיות:</strong>
      <ul>${crits.map((f) => `<li>${f.message}</li>`).join('')}</ul>
      <p>עבור ל<strong>מסך פירוט משימות</strong> כדי לתקן אותן.</p>
    </div>`;
  }

  if (!currentSchedule) {
    if (preflight.canGenerate) {
      html += `<div class="empty-state">
        <div class="empty-icon">${SVG_ICONS.tasks}</div>
        <p>טרם נוצר שבצ"ק.</p>
        <p class="text-muted">הגדר משתתפים ומשימות, ואז לחץ על "צור שבצ"ק" או בנה ידנית.</p>
        <button class="btn-sm btn-outline" id="btn-create-manual-empty" title="צור שבצ"ק ריק לבנייה ידנית" style="margin-top:12px">✏️ התחל בנייה ידנית</button>
      </div>`;
    }
    return html;
  }

  const s = currentSchedule;

  // Weekly Dashboard — hide in manual build mode on mobile to save space
  if (!_manualBuildActive) {
    html += renderWeeklyDashboard(s);
  }

  // Day Navigator tabs
  html += renderDayNavigator();
  // Manual-build undo strip
  if (_manualBuildActive) {
    const totalSlots = s.tasks.reduce((sum, t) => sum + t.slots.length, 0);
    const filledSlots = s.assignments.length;
    html += `<div class="manual-build-strip">
      <span class="manual-build-status">מצב בנייה ידנית — ${filledSlots}/${totalSlots} משבצות מלאות</span>
      <button class="btn-sm btn-outline" id="btn-manual-undo" ${_undoStack.filter((e) => e.kind === 'manual').length === 0 ? 'disabled' : ''} title="ביטול פעולה אחרונה">↩ ביטול</button>
    </div>`;
  }

  // Main layout: content + sidebar
  const manualCtx = {
    active: _manualBuildActive,
    selectedTaskId: _manualSelectedTaskId ?? undefined,
    selectedSlotId: _manualSelectedSlotId ?? undefined,
  };
  // Day 0 (continuity context): swap in a synthetic Schedule built from the
  // attached continuitySnapshot so the existing grid + swimlane render the
  // prior day's tasks unchanged. Read-only — see initSwimlane / initTooltips
  // wiring for action suppression.
  const day0Schedule = currentDay === 0 ? buildDay0Schedule(s) : null;
  const dayScopeSchedule = day0Schedule ?? s;
  html += `<div class="schedule-layout">`;
  html += `<div class="schedule-main">`;
  if (currentDay === 0) {
    html += `<div class="day0-banner" role="status">📋 יום 0 — הקשר מהשבצ"ק הקודם · קריאה בלבד · נתונים אלה היו ידועים למתכנן ושימשו לאכיפת רציפות בין שבצ"קים</div>`;
  }
  // Use the schedule's frozen dayStartHour so day grouping stays consistent
  // with how the schedule was generated, even if the live setting was edited.
  const sectionHeader =
    currentDay === 0
      ? `<h2>הקשר מהיום הקודם <span class="count">${getFilteredAssignments(dayScopeSchedule).length}</span></h2>`
      : `<h2>שיבוצים <span class="count">${getFilteredAssignments(s).length}</span></h2>`;
  // Manual-build context only applies to real days; on Day 0 always pass an inert ctx.
  const day0ManualCtx = { active: false } as typeof manualCtx;
  html += `<section${currentDay === 0 ? ' class="schedule-section--day0"' : ''}>${sectionHeader}${renderScheduleGrid(dayScopeSchedule, currentDay, store.getLiveModeState(), currentDay === 0 ? day0ManualCtx : manualCtx, s.algorithmSettings.dayStartHour)}</section>`;
  // Participant warehouse — only on real days during manual-build.
  if (_manualBuildActive && currentDay !== 0) {
    html += renderParticipantWarehouse(s);
  }
  // Availability inspector strip — between schedule grid and gantt
  // (skip on Day 0 since availability data isn't meaningful for context-only view)
  if (currentDay !== 0) {
    html += renderAvailabilityStrip();
  }

  // "תצוגה כללית" — swimlane view, person-first timeline. Whole section is
  // collapsible (click the heading); expanded by default.
  if (!_manualBuildActive) {
    const swimlaneHtml = renderSwimlaneView(dayScopeSchedule, currentDay, store.getLiveModeState());
    const collapsed = _swimlaneCollapsed;
    html += `<section class="swimlane-section${collapsed ? ' swimlane-section--collapsed' : ''}">
      <button class="swimlane-section-toggle" data-action="toggle-swimlane" aria-expanded="${collapsed ? 'false' : 'true'}">
        <h2>תצוגה כללית</h2>
        <span class="swimlane-section-chevron">${SVG_ICONS.chevronDown}</span>
      </button>
      <div class="swimlane-section-body">${swimlaneHtml}</div>
    </section>`;
  }
  // Gantt chart — desktop-only secondary view. Hidden on mobile, where the
  // swimlane replaces it entirely.
  if (!isSmallScreen) {
    const ganttExpanded = !_manualBuildActive;
    html += `<section class="gantt-section">`;
    html += `<button class="gantt-mobile-toggle" aria-expanded="${ganttExpanded}" data-action="toggle-gantt">${SVG_ICONS.chart} תצוגת גאנט</button>`;
    html += `<div class="gantt-section-content"${_manualBuildActive ? ' style="display:none"' : ''}><h2 class="gantt-desktop-title">תצוגת גאנט</h2>${renderGanttChart(s)}</div>`;
    html += `</section>`;
  }
  // In manual build mode, collapse violations by default (empty schedule generates hundreds)
  const violationCount = filterVisibleViolations(
    s.violations,
    new Set(s.algorithmSettings.disabledHardConstraints),
  ).length;
  if (_manualBuildActive) {
    html += `<section id="violations-section" class="violations-section violations-collapsed">
      <button class="violations-toggle" data-action="toggle-violations" aria-expanded="false">
        <h2>אזהרות והפרות <span class="count">${violationCount}</span></h2>
        <span class="violations-toggle-icon">▸</span>
      </button>
    </section>`;
  } else {
    html += `<section id="violations-section"><h2>אזהרות והפרות <span class="count">${violationCount}</span></h2>${renderViolations(s)}</section>`;
  }
  html += `</div>`;
  html += renderParticipantSidebar(s);
  // Mobile-only FAB to toggle sidebar drawer
  html += `<button class="sidebar-fab" title="עומס עבודה" aria-label="הצג סרגל עומס">${SVG_ICONS.chart}<span class="sidebar-fab-label">עומסים</span></button>`;
  html += `</div>`;

  // Optimization overlay (rendered inside tab so it covers the schedule board)
  html += renderOptimOverlay();

  return html;
}

// ─── Manual Build: Participant Warehouse ────────────────────────────────────

function renderParticipantWarehouse(schedule: Schedule): string {
  const participants = schedule.participants;
  const l0Pool = participants.filter((p) => p.level === Level.L0);
  const seniorPool = participants.filter((p) => p.level !== Level.L0);

  // Count current-day assignments per participant (schedule's frozen period)
  const { start: dayStart, end: dayEnd } = getDayWindow(
    currentDay,
    schedule.algorithmSettings.dayStartHour,
    schedule.periodStart,
  );
  const dayTaskIds = new Set(
    schedule.tasks
      .filter((t) => {
        // Split fragments count toward their occurrence's op-day (non-split
        // unchanged) so the warehouse "today" tally matches the grid.
        const s = taskOpDayStart(t).getTime();
        return s >= dayStart.getTime() && s < dayEnd.getTime();
      })
      .map((t) => t.id),
  );
  const dayAssignmentCounts = new Map<string, number>();
  for (const a of schedule.assignments) {
    if (dayTaskIds.has(a.taskId)) {
      dayAssignmentCounts.set(a.participantId, (dayAssignmentCounts.get(a.participantId) || 0) + 1);
    }
  }

  const filterText = _warehouseFilter.trim().toLowerCase();

  function renderPool(pool: Participant[], label: string): string {
    let filtered = pool;
    if (filterText) {
      filtered = pool.filter((p) => p.name.toLowerCase().includes(filterText));
    }

    // Sort: eligible first (if slot selected), then by name
    if (_eligibleForSelectedSlot) {
      filtered.sort((a, b) => {
        const aElig = _eligibleForSelectedSlot?.has(a.id) ? 0 : 1;
        const bElig = _eligibleForSelectedSlot?.has(b.id) ? 0 : 1;
        if (aElig !== bElig) return aElig - bElig;
        return a.name.localeCompare(b.name, 'he');
      });
    }

    const cards = filtered
      .map((p) => {
        const eligible = _eligibleForSelectedSlot ? _eligibleForSelectedSlot.has(p.id) : true;
        return renderParticipantCard({
          participant: p,
          eligible,
          dayAssignmentCount: dayAssignmentCounts.get(p.id) || 0,
        });
      })
      .join('');

    return `<div class="warehouse-pool">
      <div class="warehouse-pool-header">${label} (${filtered.length})</div>
      <div class="warehouse-pool-cards">${cards || '<span class="text-muted">אין משתתפים</span>'}</div>
    </div>`;
  }

  // Manual-build split entry point (desktop inline). Visible only when a
  // splittable, non-already-split slot is selected and the global splitting
  // mode is not 'off' — gated by `canSplitSelectedSlot` (same gate as the
  // mobile bottom-sheet button).
  let splitButton = '';
  if (_manualSelectedTaskId && _manualSelectedSlotId) {
    const selTask = schedule.tasks.find((t) => t.id === _manualSelectedTaskId);
    const selAsg = schedule.assignments.find(
      (a) => a.taskId === _manualSelectedTaskId && a.slotId === _manualSelectedSlotId,
    );
    if (selTask && canSplitSelectedSlot(selTask, selAsg)) {
      splitButton = `<button class="btn-manual-split-inline" data-action="manual-split">✂ פצל משבצת לשני אנשים</button>`;
    }
  }

  return `<section class="manual-warehouse" id="manual-warehouse">
    <div class="warehouse-header">
      <h3>מאגר משתתפים</h3>
      <input type="search" class="warehouse-filter" id="warehouse-filter" placeholder="🔍 חפש..." value="${escHtml(_warehouseFilter)}" />
    </div>
    ${splitButton}
    ${renderPool(l0Pool, 'דרגה 0')}
    ${renderPool(seniorPool, 'סגל (דרגה 2–4)')}
  </section>`;
}

/**
 * Manual-build gate for the ✂ split button. The button is visible only when:
 *   - The slot's parent task is `splittable` (frozen at generation; already
 *     reflects the global `splittingMode !== 'off'` setting).
 *   - The task itself is not a split half (`splitGroupId === undefined`).
 *   - The engine's splitting mode is not 'off' (defense-in-depth).
 *   - If the slot is filled, the assignment is not frozen.
 * Returns true when all gates pass.
 */
function canSplitSelectedSlot(task: Task, existingAssignment: Assignment | undefined): boolean {
  if (!task.splittable) return false;
  if (task.splitGroupId !== undefined) return false;
  if (engine && engine.getSplittingMode() === 'off') return false;
  if (existingAssignment && existingAssignment.status === AssignmentStatus.Frozen) return false;
  return true;
}

/**
 * Build warehouse HTML for use inside a mobile bottom sheet.
 * Includes a header with slot context and a remove button if the slot is filled.
 */
function buildWarehouseSheetContent(schedule: Schedule): string {
  const task = schedule.tasks.find((t) => t.id === _manualSelectedTaskId);
  if (!task || !_manualSelectedSlotId) return '';
  const slot = task.slots.find((s) => s.slotId === _manualSelectedSlotId);
  if (!slot) return '';

  const existingAssignment = schedule.assignments.find(
    (a) => a.taskId === task.id && a.slotId === _manualSelectedSlotId,
  );
  const existingParticipant = existingAssignment
    ? schedule.participants.find((p) => p.id === existingAssignment.participantId)
    : undefined;

  const levels = slot.acceptableLevels.map((l) => l.level).join('/');
  const cleanTaskName = task.sourceName ?? stripDayPrefix(task.name);
  const slotLabel = slot.label ? ` — ${slot.label}` : '';
  const timeRange = `<span dir="ltr">${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}</span>`;
  let header = `<div class="warehouse-sheet-header">
    <div class="warehouse-sheet-title">בחר משתתף ל-${escHtml(cleanTaskName)}${escHtml(slotLabel)}</div>
    <div class="warehouse-sheet-reqs">${timeRange} ${levels ? `${levels}` : ''} ${certBadges(slot.requiredCertifications, '')}</div>
  </div>`;

  if (existingAssignment && existingParticipant) {
    header += `<button class="btn-manual-remove-sheet" data-action="manual-remove" data-assignment-id="${existingAssignment.id}">✕ הסר שיבוץ של ${escHtml(existingParticipant.name)}</button>`;
  }

  if (canSplitSelectedSlot(task, existingAssignment)) {
    header += `<button class="btn-manual-split-sheet" data-action="manual-split">✂ פצל משבצת לשני אנשים</button>`;
  }

  // Render participant cards
  const participants = schedule.participants;
  const filterText = _warehouseFilter.trim().toLowerCase();
  const filtered = filterText
    ? participants.filter((p) => p.name.toLowerCase().includes(filterText))
    : [...participants];

  // Sort eligible first
  if (_eligibleForSelectedSlot) {
    filtered.sort((a, b) => {
      const aElig = _eligibleForSelectedSlot?.has(a.id) ? 0 : 1;
      const bElig = _eligibleForSelectedSlot?.has(b.id) ? 0 : 1;
      if (aElig !== bElig) return aElig - bElig;
      return a.name.localeCompare(b.name, 'he');
    });
  }

  const cards = filtered
    .map((p) => {
      const eligible = _eligibleForSelectedSlot ? _eligibleForSelectedSlot.has(p.id) : true;
      return renderParticipantCard({
        participant: p,
        eligible,
        extraClass: 'warehouse-card-sheet',
      });
    })
    .join('');

  return `${header}
    <div class="warehouse-sheet-filter">
      <input type="search" class="warehouse-sheet-search" id="warehouse-sheet-search" placeholder="🔍 חפש..." autocomplete="off" />
    </div>
    <div class="warehouse-sheet-cards">${cards}</div>`;
}

// ─── Manual Build: Interaction Handlers ─────────────────────────────────────

function handleManualSlotClick(taskId: string, slotId: string): void {
  if (!currentSchedule) return;

  // Toggle off if already selected
  if (_manualSelectedTaskId === taskId && _manualSelectedSlotId === slotId) {
    clearManualSelection();
    renderAll();
    return;
  }

  // Check if the slot is frozen
  const task = currentSchedule.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const lm = store.getLiveModeState();
  if (lm.enabled && !isFutureTask(task, lm.currentTimestamp)) {
    showToast('המשימה מוקפאת — לא ניתן לערוך', { type: 'error' });
    return;
  }

  // Select slot + compute eligible
  _manualSelectedTaskId = taskId;
  _manualSelectedSlotId = slotId;

  const allTasks = currentSchedule.tasks;
  // Use engine's frozen state so external edits don't change eligibility.
  const disabledHC = engine ? engine.getDisabledHC() : undefined;
  const restRuleMap = engine ? engine.getRestRuleMap() : undefined;
  const eligible = getEligibleParticipantsForSlot(
    task,
    slotId,
    currentSchedule.participants,
    currentSchedule.assignments,
    allTasks,
    disabledHC,
    restRuleMap,
    currentSchedule.scheduleUnavailability,
    engine?.getScheduleContext(),
  );
  _eligibleForSelectedSlot = new Set(eligible.map((p) => p.id));

  if (isSmallScreen) {
    openWarehouseSheet();
  } else {
    renderAll();
    // Desktop has no modal — scroll the inline warehouse into view and flash
    // it briefly so the user sees where the eligible participants are.
    requestAnimationFrame(() => {
      const warehouse = document.getElementById('manual-warehouse');
      if (!warehouse) return;
      warehouse.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      warehouse.classList.remove('flash');
      void warehouse.offsetWidth;
      warehouse.classList.add('flash');
      window.setTimeout(() => warehouse.classList.remove('flash'), 600);
    });
  }
}

async function handleManualParticipantClick(participantId: string): Promise<boolean> {
  if (!currentSchedule || !engine || !_manualSelectedTaskId || !_manualSelectedSlotId) return false;

  const task = currentSchedule.tasks.find((t) => t.id === _manualSelectedTaskId);
  if (!task) return false;
  const slot = task.slots.find((s) => s.slotId === _manualSelectedSlotId);
  if (!slot) return false;
  const participant = currentSchedule.participants.find((p) => p.id === participantId);
  if (!participant) return false;

  // Build assignment context for eligibility check
  const taskMap = new Map(currentSchedule.tasks.map((t) => [t.id, t]));
  const pMap = new Map(currentSchedule.participants.map((p) => [p.id, p]));
  const existingAssignment = currentSchedule.assignments.find(
    (a) => a.taskId === task.id && a.slotId === _manualSelectedSlotId,
  );

  // Build participant's other assignments (everything except the target slot).
  // Mirrors getEligibleParticipantsForSlot (validator.ts) so HC-5/HC-7 still
  // fire when the participant is already in a DIFFERENT slot of the same task.
  const pAssignmentsAddBoth = currentSchedule.assignments.filter(
    (a) => a.participantId === participantId && !(a.taskId === task.id && a.slotId === _manualSelectedSlotId),
  );

  const taskAssignments = currentSchedule.assignments.filter((a) => a.taskId === task.id);
  const disabledHC = engine.getDisabledHC() ?? new Set();
  const validateOpts = {
    checkSameGroup: true,
    taskAssignments,
    participantMap: pMap,
    disabledHC,
    restRuleMap: engine.getRestRuleMap(),
    extraUnavailability: currentSchedule.scheduleUnavailability,
  };

  // Try add-both first: keep the participant's existing assignments and add
  // this one. Matches optimizer semantics — a participant can hold multiple
  // slots whenever HC permits (e.g. two non-overlapping shifts of the same task).
  const reasonAddBoth = getRejectionReason(participant, task, slot, pAssignmentsAddBoth, taskMap, validateOpts);
  if (reasonAddBoth === null) {
    executeManualAssignment(participantId, existingAssignment, null);
    return true;
  }

  // Add-both violates a hard constraint. If the participant has another
  // assignment, see whether removing it (i.e., a move) would resolve the
  // violation — and if so, ask the user to confirm the move.
  const otherAssignment = pAssignmentsAddBoth[0];
  if (otherAssignment) {
    const pAssignmentsMove = pAssignmentsAddBoth.filter((a) => a.id !== otherAssignment.id);
    const reasonMove = getRejectionReason(participant, task, slot, pAssignmentsMove, taskMap, validateOpts);
    if (reasonMove === null) {
      const otherTask = currentSchedule.tasks.find((t) => t.id === otherAssignment.taskId);
      const otherDesc = otherTask ? describeTaskBidi(otherTask) : '?';
      const reasonText = REJECTION_REASONS_HE[reasonAddBoth] || `אילוץ ${reasonAddBoth}`;
      const confirmed = await showConfirm(
        `${participant.name} משובץ ב-"${otherDesc}" — שיבוץ נוסף יפר אילוץ (${reasonText}). להעביר לכאן?`,
      );
      if (!confirmed) return false;
      executeManualAssignment(participantId, existingAssignment, otherAssignment);
      return true;
    }
  }

  showToast(REJECTION_REASONS_HE[reasonAddBoth] || `אילוץ ${reasonAddBoth}`, { type: 'error' });
  return false;
}

function executeManualAssignment(
  participantId: string,
  existingInSlot: Assignment | undefined,
  moveFrom: Assignment | null,
): void {
  if (!currentSchedule || !engine) return;

  // Hard-constraint invariant: a manual assignment must never persist a new
  // HC violation. The pre-assignment check at getRejectionReason catches
  // per-participant violations; this snapshot lets us detect global HCs
  // (HC-8 group integrity in particular) that only surface after the mutation.
  const frozenDisabled = new Set(currentSchedule.algorithmSettings.disabledHardConstraints);
  const hardBefore = filterVisibleViolations(currentSchedule.violations, frozenDisabled).filter(
    (v) => v.severity === ViolationSeverity.Error,
  ).length;

  // Push undo snapshot
  pushUndo('manual', 'שיבוץ ידני');

  // Remove from source slot if moving
  if (moveFrom) {
    currentSchedule.assignments = currentSchedule.assignments.filter((a) => a.id !== moveFrom.id);
  }

  if (existingInSlot) {
    // Replace existing occupant
    existingInSlot.participantId = participantId;
    existingInSlot.status = AssignmentStatus.Manual;
    existingInSlot.updatedAt = new Date();
  } else {
    // New assignment
    currentSchedule.assignments.push({
      id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      taskId: _manualSelectedTaskId!,
      slotId: _manualSelectedSlotId!,
      participantId,
      status: AssignmentStatus.Manual,
      updatedAt: new Date(),
    } as Assignment);
  }

  // Capture info for feedback before clearing selection
  const assignedParticipant = currentSchedule.participants.find((p) => p.id === participantId);
  const assignedTask = currentSchedule.tasks.find((t) => t.id === _manualSelectedTaskId);
  const assignedSlotId = _manualSelectedSlotId;

  engine.importSchedule(currentSchedule);
  clearManualSelection();
  revalidateAndRefresh();

  // If the manual assignment introduced a new hard violation (one that
  // per-participant gating cannot see), roll back via the undo entry we
  // pushed above so HC stays truly absolute.
  const hardAfter = currentSchedule
    ? filterVisibleViolations(currentSchedule.violations, frozenDisabled).filter(
        (v) => v.severity === ViolationSeverity.Error,
      ).length
    : hardBefore;
  if (hardAfter > hardBefore) {
    const undo = popUndoByKind('manual');
    if (undo) applyUndoEntry(undo);
    showToast('השיבוץ חורג מאילוץ קשיח — בוצע שחזור למצב הקודם.', { type: 'error', duration: 5000 });
    return;
  }

  // Descriptive toast with participant + task name
  const pName = assignedParticipant?.name || '';
  const tName = assignedTask ? (assignedTask.sourceName ?? stripDayPrefix(assignedTask.name)) : '';
  showToast(`${pName} שובץ/ה ל${tName}`, { type: 'success' });

  // Highlight the just-assigned slot with a pulse animation
  if (assignedTask && assignedSlotId) {
    requestAnimationFrame(() => {
      const card = document.querySelector(
        `.assignment-card[data-task-id="${assignedTask.id}"][data-slot-id="${assignedSlotId}"]`,
      );
      if (card) {
        card.classList.add('assignment-flash');
        card.addEventListener('animationend', () => card.classList.remove('assignment-flash'), { once: true });
      }
    });
  }
}

function handleManualRemove(assignmentId: string): void {
  if (!currentSchedule || !engine) return;
  const a = currentSchedule.assignments.find((a) => a.id === assignmentId);
  if (!a) return;

  if (a.status === AssignmentStatus.Frozen) {
    showToast('השיבוץ מוקפא — לא ניתן לשנות', { type: 'error' });
    return;
  }

  // Push undo snapshot
  pushUndo('manual', 'הסרת שיבוץ');

  currentSchedule.assignments = currentSchedule.assignments.filter((x) => x.id !== assignmentId);
  engine.importSchedule(currentSchedule);
  clearManualSelection();
  revalidateAndRefresh();
  showToast('השיבוץ הוסר', { type: 'info' });
}

function handleManualUndo(): void {
  if (!currentSchedule || !engine) return;
  const entry = popUndoByKind('manual');
  if (!entry) return;
  applyUndoEntry(entry);
  clearManualSelection();
  showToast('הפעולה בוטלה', { type: 'info' });
}

/**
 * Manual-build split flow: opens the split picker for the currently selected
 * slot. Pushes a manual-build undo snapshot before applyPlanOps; pops it if
 * the engine rejects (HC violation). On success, refreshes the schedule and
 * animates the two new halves.
 */
async function handleManualSplitClick(): Promise<void> {
  if (!currentSchedule || !engine || !_manualSelectedTaskId || !_manualSelectedSlotId) return;
  const task = currentSchedule.tasks.find((t) => t.id === _manualSelectedTaskId);
  if (!task) return;
  const existingAssignment = currentSchedule.assignments.find(
    (a) => a.taskId === task.id && a.slotId === _manualSelectedSlotId,
  );
  if (!canSplitSelectedSlot(task, existingAssignment)) return;

  const result = await openSplitPicker({
    engine,
    schedule: currentSchedule,
    taskId: _manualSelectedTaskId,
    slotId: _manualSelectedSlotId,
    disabledHC: engine.getDisabledHC() ?? new Set<string>(),
    restRuleMap: engine.getRestRuleMap(),
    pushUndo: () => pushUndo('manual', 'פיצול משבצת'),
    popUndo: () => {
      popUndoByKind('manual');
    },
  });

  if (!result.applied || !result.halfAssignmentIds) {
    // Cancelled, dismissed, or apply failed inside the picker.
    return;
  }

  for (const id of result.halfAssignmentIds) {
    if (id) _pendingSwapAnimIds.add(id);
  }
  clearManualSelection();
  revalidateAndRefresh();
  showToast('המשבצת פוצלה לשני אנשים', { type: 'success' });
}

/** Open warehouse as a bottom sheet on mobile */
function openWarehouseSheet(): void {
  if (!currentSchedule) return;
  const content = buildWarehouseSheetContent(currentSchedule);
  const handle = showBottomSheet(content, {
    title: 'בחר משתתף',
  });

  // Wire participant card clicks and search inside the sheet
  // Use requestAnimationFrame to ensure DOM is painted
  requestAnimationFrame(() => {
    const sheetBody = document.querySelector('.gm-bs-body');
    if (!sheetBody) return;

    // Wire search/filter
    const searchInput = sheetBody.querySelector('#warehouse-sheet-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim().toLowerCase();
        const cards = sheetBody.querySelectorAll('.warehouse-card[data-pid]');
        cards.forEach((card) => {
          const name = card.querySelector('.wc-name')?.textContent?.toLowerCase() || '';
          (card as HTMLElement).style.display = name.includes(query) ? '' : 'none';
        });
      });
      searchInput.focus();
    }

    sheetBody.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const card = target.closest('.warehouse-card[data-pid]') as HTMLElement | null;
      if (card) {
        e.stopPropagation();
        const pid = card.dataset.pid!;
        handleManualParticipantClick(pid).then((assigned) => {
          if (assigned) handle.close();
        });
        return;
      }
      // Remove button
      const removeBtn = target.closest('[data-action="manual-remove"]') as HTMLElement | null;
      if (removeBtn) {
        e.stopPropagation();
        const aid = removeBtn.dataset.assignmentId;
        if (aid) {
          handleManualRemove(aid);
          handle.close();
        }
        return;
      }
      // Split button: close this sheet and open the split picker.
      const splitBtn = target.closest('[data-action="manual-split"]') as HTMLElement | null;
      if (splitBtn) {
        e.stopPropagation();
        handle.close();
        handleManualSplitClick();
      }
    });
  });
}

// ─── Snapshot Panel ─────────────────────────────────────────────────────────

// ─── Continuity Panel ───────────────────────────────────────────────────────

function renderContinuityChip(): string {
  // Post-generation: prefer the frozen snapshot on the schedule so the chip
  // survives page reload (when the ephemeral _continuityJson is empty).
  // Click navigates to the Day 0 view; no edit / clear once frozen.
  if (currentSchedule?.continuitySnapshot) {
    const snap = currentSchedule.continuitySnapshot;
    const pCount = snap.participants.length;
    const aCount = snap.participants.reduce((sum, p) => sum + p.assignments.length, 0);
    return `<a class="continuity-chip continuity-chip--frozen" href="#schedule/0" title="לחץ לצפייה ביום 0 — הקשר מהשבצ&quot;ק הקודם">
      <span class="continuity-chip-dot"></span>
      📋 הקשר זמין · יום 0 (${pCount} משתתפים, ${aCount} שיבוצים)
    </a>`;
  }

  const json = _continuityJson.trim();
  if (!json) return '';

  const parsed = parseContinuitySnapshot(_continuityJson);
  if ('error' in parsed) {
    return `<span class="continuity-chip continuity-chip-error" id="continuity-chip" title="${escHtml(parsed.error)}">
      <span class="continuity-chip-dot"></span>
      המשכיות: שגיאה
      <button class="continuity-chip-clear" id="btn-continuity-clear" title="נקה">✕</button>
    </span>`;
  }

  const pCount = parsed.participants.length;
  const aCount = parsed.participants.reduce((sum, p) => sum + p.assignments.length, 0);
  return `<span class="continuity-chip" id="continuity-chip" title="לחץ לצפייה/עריכה">
    <span class="continuity-chip-dot"></span>
    המשכיות: יום ${parsed.dayIndex}, ${pCount} משתתפים, ${aCount} שיבוצים
    <button class="continuity-chip-clear" id="btn-continuity-clear" title="נקה">✕</button>
  </span>`;
}

function validateContinuityJson(json: string): { ok: true; summary: string } | { ok: false; error: string } {
  const parsed = parseContinuitySnapshot(json);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const pCount = parsed.participants.length;
  const aCount = parsed.participants.reduce((sum, p) => sum + p.assignments.length, 0);
  return { ok: true, summary: `${pCount} משתתפים, ${aCount} שיבוצים (יום ${parsed.dayIndex})` };
}

function openContinuityImportModal(): void {
  showContinuityImport({
    defaultValue: _continuityJson,
    validate: validateContinuityJson,
  }).then((result) => {
    if (result !== null) {
      _continuityJson = result;
    }
    renderAll();
  });
}

function renderSnapshotPanel(): string {
  const snapshots = store.getAllSnapshots();
  const activeId = store.getActiveSnapshotId();
  const hasSchedule = !!currentSchedule;
  const maxSnaps = store.getMaxSnapshots();
  const nameFieldInvalid = _snapshotFormError ? ' aria-invalid="true" aria-describedby="snap-error"' : '';

  let html = `<div class="snapshot-panel">`;

  // ── Header row ──
  html += `<div class="snapshot-panel-header">
    <h3>💾 תמונות מצב שמורות <span class="count">${snapshots.length}/${maxSnaps}</span></h3>
    <button class="btn-xs btn-outline" id="btn-snap-close" title="סגור">✕</button>
  </div>`;

  // ── Save-as form / rename form ──
  if (_snapshotFormMode === 'save-as') {
    html += `<div class="snapshot-inline-form" id="snap-form">
      <div class="snapshot-form-row">
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" placeholder="לדוגמה: טיוטה 1" maxlength="100" autofocus${nameFieldInvalid} /></label>
        <label>תיאור: <input class="snapshot-desc-input" type="text" id="snap-desc" placeholder="אופציונלי" /></label>
        <button class="btn-sm btn-primary" id="btn-snap-confirm-save">שמור</button>
        <button class="btn-sm btn-outline" id="btn-snap-cancel">ביטול</button>
      </div>
      <div class="snapshot-validation-error" id="snap-error">${_snapshotFormError}</div>
    </div>`;
  } else if (_snapshotFormMode === 'rename' && activeId) {
    const active = snapshots.find((s) => s.id === activeId);
    html += `<div class="snapshot-inline-form" id="snap-form">
      <div class="snapshot-form-row">
        <label>שם: <input class="snapshot-name-input" type="text" id="snap-name" value="${active?.name || ''}" maxlength="100"${nameFieldInvalid} /></label>
        <label>תיאור: <input class="snapshot-desc-input" type="text" id="snap-desc" value="${active?.description || ''}" /></label>
        <button class="btn-sm btn-primary" id="btn-snap-confirm-rename">שמור</button>
        <button class="btn-sm btn-outline" id="btn-snap-cancel">ביטול</button>
      </div>
      <div class="snapshot-validation-error" id="snap-error">${_snapshotFormError}</div>
    </div>`;
  } else {
    // Primary action: Save current schedule
    html += `<div class="snapshot-actions-primary">
      <button class="btn-sm btn-primary" id="btn-snap-save-as" ${!hasSchedule ? 'disabled' : ''}>+ שמור תמונת מצב חדשה</button>
    </div>`;
  }

  // ── Snapshot list ──
  if (snapshots.length === 0) {
    html += `<div class="snapshot-empty">
      <span class="text-muted">אין תמונות מצב שמורות. צור שיבוץ ואז שמור תמונת מצב.</span>
    </div>`;
  } else {
    html += `<div class="snapshot-list">`;
    for (const snap of snapshots) {
      const isActive = snap.id === activeId;
      const date = new Date(snap.createdAt);
      const dateStr = date.toLocaleDateString('he-IL', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      html += `<div class="snapshot-item ${isActive ? 'snapshot-item-active' : ''}" data-snap-id="${snap.id}">
        <div class="snapshot-item-main">
          <span class="snapshot-item-name">${escHtml(snap.name)}</span>
          ${isActive && _snapshotDirty ? '<span class="snapshot-dirty-badge">שונה</span>' : ''}
          <span class="snapshot-item-date text-muted">${dateStr}</span>
        </div>
        ${snap.description ? `<div class="snapshot-item-desc text-muted">${escHtml(snap.description)}</div>` : ''}
        <div class="snapshot-item-actions">
          <button class="btn-xs btn-primary" data-snap-action="load" data-snap-id="${snap.id}" title="טען תמונת מצב זו">▶ טען</button>
          ${isActive && _snapshotDirty ? `<button class="btn-xs btn-outline" data-snap-action="update" data-snap-id="${snap.id}" title="עדכן עם השבצ\\"ק הנוכחי">עדכן</button>` : ''}
          <button class="btn-xs btn-outline" data-snap-action="rename" data-snap-id="${snap.id}" title="שנה שם">✎</button>
          <button class="btn-xs btn-outline" data-snap-action="duplicate" data-snap-id="${snap.id}" title="שכפל">⧉</button>
          <button class="btn-xs btn-danger-outline" data-snap-action="delete" data-snap-id="${snap.id}" title="מחק">${SVG_ICONS.trash}</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Snapshot Load Logic ─────────────────────────────────────────────────────

function loadScheduleSnapshot(snapshotId: string): void {
  const snapshot = store.getSnapshotById(snapshotId);
  if (!snapshot) return;

  // Reject pre-schema snapshots (missing frozen fields) — pre-release, no migration.
  if (!hasFrozenFields(snapshot.schedule)) {
    showToast('תמונת מצב ישנה — יש ליצור תמונה חדשה לאחר יצירת שבצ"ק.', {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  // 1. Restore algorithm settings from the frozen snapshot embedded in the
  //    schedule itself, so day grouping/scoring/engine all match what was saved.
  const frozen = snapshot.schedule.algorithmSettings;
  store.setAlgorithmSettings({
    config: frozen.config,
    disabledHardConstraints: frozen.disabledHardConstraints,
    dayStartHour: frozen.dayStartHour,
  });

  // 2. Use the snapshot's embedded data as-is — no filtering against the
  //    live store. Orphaned participants/tasks remain visible in the grid;
  //    the dirty warning communicates regeneration is needed.
  const loadedSchedule = snapshot.schedule;

  // 3. Create engine from the schedule's embedded frozen settings.
  engine = new SchedulingEngine(
    frozen.config,
    new Set(frozen.disabledHardConstraints),
    new Map(Object.entries(loadedSchedule.restRuleSnapshot)),
    frozen.dayStartHour,
    frozen.splittingMode ?? 'quality',
  );
  engine.setCertLabelSnapshot(loadedSchedule.certLabelSnapshot);
  engine.setPeriod(loadedSchedule.periodStart, loadedSchedule.periodDays);

  // 4. Load the schedule's own data into the engine (including any
  //    participants/tasks no longer present in the live store).
  engine.addParticipants(loadedSchedule.participants);
  engine.addTasks(loadedSchedule.tasks);
  engine.importSchedule(loadedSchedule);

  // 5. Re-validate
  engine.revalidateFull();
  closeRescueModal();
  closeInjectTaskModal();
  currentSchedule = engine.getSchedule()!;
  currentDay = 1;
  _snapshotDirty = false;

  // 6. Detect orphans against the live store; mark dirty if any are present.
  _scheduleDirty = scheduleHasOrphans(loadedSchedule);

  // 7. Apply live mode freeze if active
  const liveMode = store.getLiveModeState();
  if (liveMode.enabled && currentSchedule) {
    freezeAssignments(currentSchedule, liveMode.currentTimestamp);
  }

  // 8. Persist as current schedule
  if (!store.saveSchedule(currentSchedule)) {
    showToast('טעינת התמונה הצליחה אך השמירה נכשלה — נפח האחסון מלא.', { type: 'warning', duration: 6000 });
  }
  store.setActiveSnapshotId(snapshotId);

  // 9. Re-render
  renderAll();
}

/**
 * Reset only the schedule screen back to the state it had *before* the user
 * clicked "צור שבצ"ק" (the empty state). This is a *local* reset — it never
 * touches the store's master data (participants, task templates, algorithm
 * presets, participant/task sets) nor the named snapshot library. Contrast
 * with the danger-zone "⚠ איפוס מערכת" button, which does a full factory reset.
 *
 * In-memory only (no location.reload) so `_continuityJson` is preserved.
 */
function resetScheduleScreen(): void {
  // Schedule-scoped store state only — none of these touch master data.
  store.clearSchedule(); // remove persisted gardenmanager_schedule (only that key)
  store.setActiveSnapshotId(null); // deselect active snapshot (does NOT delete it)
  store.setLiveModeEnabled(false); // per product decision: reset turns Live Mode off

  // Drop the live engine + frozen schedule.
  engine = null;
  currentSchedule = null;
  scheduleElapsed = 0;
  scheduleActualAttempts = 0;
  currentDay = 1;
  _scheduleDirty = false;
  _snapshotDirty = false;

  // Clear schedule-scoped undo/redo + animation state.
  _scheduleUndoStack.length = 0;
  _scheduleRedoStack.length = 0;
  _undoStack = [];
  _pendingSwapAnimIds.clear();

  // Exit manual-build mode and any overlay view.
  _manualBuildActive = false;
  _manualSelectedTaskId = null;
  _manualSelectedSlotId = null;
  _eligibleForSelectedSlot = null;
  _viewMode = 'SCHEDULE_VIEW';
  _profileParticipantId = null;
  _taskPanelSourceName = null;
  _pointInTimeTimestamp = null;

  // Collapse the snapshot panel / clear its inline form.
  _snapshotPanelOpen = false;
  _snapshotFormMode = 'none';
  _snapshotFormError = '';

  // `_continuityJson` is intentionally preserved (input set before generation).

  closeRescueModal();
  closeInjectTaskModal();

  showToast('מסך השבצ"ק אופס. המשתתפים, המשימות וההגדרות נשמרו.', { type: 'success' });
  renderAll();
}

// ─── Violations ──────────────────────────────────────────────────────────────

function renderViolations(schedule: Schedule): string {
  const visible = filterVisibleViolations(
    schedule.violations,
    new Set(schedule.algorithmSettings.disabledHardConstraints),
  );
  const hard = visible.filter((v) => v.severity === ViolationSeverity.Error);
  const warn = visible.filter((v) => v.severity === ViolationSeverity.Warning);

  if (hard.length === 0 && warn.length === 0) {
    return `<div class="alert alert-ok">✓ אין אזהרות או הפרות בכל ${schedule.periodDays} הימים.</div>`;
  }

  // Derive day index from the task's start timestamp relative to the
  // schedule's frozen period anchor. Returns null for violations without a
  // resolvable task (e.g., schedule-level errors) so they can fall into a
  // 'no day' bucket.
  const taskById = new Map(schedule.tasks.map((t) => [t.id, t]));
  const dsh = schedule.algorithmSettings.dayStartHour;
  const periodStart = schedule.periodStart;
  const dayOf = (v: ConstraintViolation): number | null => {
    if (!v.taskId) return null;
    const t = taskById.get(v.taskId);
    if (!t) return null;
    const d = taskDayIndex(t, dsh, periodStart);
    return d >= 1 && d <= schedule.periodDays ? d : null;
  };

  const renderItem = (v: ConstraintViolation): string =>
    `<li dir="rtl"><code>${violationLabel(v.code)}</code> · ${v.message}</li>`;

  const renderOtherDays = (items: ConstraintViolation[]): string => {
    const byDay = new Map<number | null, ConstraintViolation[]>();
    for (const v of items) {
      const d = dayOf(v);
      const bucket = byDay.get(d);
      if (bucket) bucket.push(v);
      else byDay.set(d, [v]);
    }
    const sortedDays = [...byDay.keys()].filter((d): d is number => d !== null).sort((a, b) => a - b);
    let out = '';
    for (const d of sortedDays) {
      out += `<div class="violation-day"><em>יום ${d}:</em><ul>`;
      for (const v of byDay.get(d)!) out += renderItem(v);
      out += '</ul></div>';
    }
    const unassigned = byDay.get(null);
    if (unassigned) {
      out += '<ul>';
      for (const v of unassigned) out += renderItem(v);
      out += '</ul>';
    }
    return out;
  };

  // Separate into current-day and other-day violations
  const dayTaskIds = new Set(getFilteredTasks(schedule).map((t) => t.id));

  const renderCategorized = (items: ConstraintViolation[]): string => {
    const byCode = new Map<string, ConstraintViolation[]>();
    for (const v of items) {
      const arr = byCode.get(v.code);
      if (arr) arr.push(v);
      else byCode.set(v.code, [v]);
    }
    const cats = [...byCode.entries()].sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return violationLabel(a[0]).localeCompare(violationLabel(b[0]), 'he');
    });
    let out = '';
    for (const [code, catItems] of cats) {
      const today = catItems.filter((v) => v.taskId && dayTaskIds.has(v.taskId));
      const other = catItems.filter((v) => !v.taskId || !dayTaskIds.has(v.taskId));
      out += `<div class="violation-category violation-category-collapsed">
        <button class="violation-category-toggle" data-action="toggle-violation-category" aria-expanded="false" type="button">
          <span class="violation-category-label">${violationLabel(code)}</span>
          <span class="violation-category-count">${catItems.length}</span>
          <span class="violation-category-icon">▸</span>
        </button>
        <div class="violation-category-content" style="display:none">`;
      // On Day 0 (continuity context) `today` is always empty since the
      // schedule's real tasks never intersect the prior 24h window — guard
      // anyway so we never emit a "יום 0:" violations heading.
      if (today.length > 0 && currentDay !== 0) {
        out += `<div class="violation-section"><em>יום ${currentDay}:</em><ul>`;
        for (const v of today) out += renderItem(v);
        out += `</ul></div>`;
      }
      if (other.length > 0) {
        out += `<div class="violation-section violation-other"><em>ימים אחרים:</em>`;
        out += renderOtherDays(other);
        out += `</div>`;
      }
      out += `</div></div>`;
    }
    return out;
  };

  let html = '';
  if (hard.length > 0) {
    html += `<div class="alert alert-error"><strong>הפרות חמורות (${hard.length})</strong>`;
    html += renderCategorized(hard);
    html += '</div>';
  }
  if (warn.length > 0) {
    html += `<div class="alert alert-warn"><strong>אזהרות (${warn.length})</strong>`;
    html += renderCategorized(warn);
    html += '</div>';
  }
  return html;
}

// ─── Assignments Table ───────────────────────────────────────────────────────

/*
function renderAssignmentsTable(schedule: Schedule): string {
  const filteredTasks = getFilteredTasks(schedule);
  const filteredAssignments = getFilteredAssignments(schedule);
  const liveMode = store.getLiveModeState();

  const taskMap = new Map<string, Task>();
  for (const t of filteredTasks) taskMap.set(t.id, t);
  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  const groupedByTask = new Map<string, Assignment[]>();
  for (const a of filteredAssignments) {
    const arr = groupedByTask.get(a.taskId) || [];
    arr.push(a);
    groupedByTask.set(a.taskId, arr);
  }

  // Sort tasks by start time
  const sortedTasks = [...filteredTasks].sort(
    (a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime()
  );

  let html = `<div class="table-responsive"><table class="table">
    <thead><tr><th>משימה</th><th>סוג</th><th>זמן</th><th>עמדה</th><th>משתתף</th>
    <th>דרגה</th><th>קבוצה</th><th>סטטוס</th><th>פעולות</th></tr></thead><tbody>`;

  for (const task of sortedTasks) {
    const taskAssignments = groupedByTask.get(task.id) || [];
    const taskIsFrozen = liveMode.enabled && !isFutureTask(task, liveMode.currentTimestamp);

    // Cross-day indicators
    const contFromPrev = taskStartsBefore(task, currentDay);
    const contToNext = taskEndsAfter(task, currentDay);
    let crossDayTag = '';
    if (contFromPrev && contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-both" title="ממשיך מיום ${currentDay - 1} ליום ${currentDay + 1}">◀ ▶</span>`;
    } else if (contFromPrev) {
      crossDayTag = `<span class="cross-day-badge cross-from" title="המשך מיום ${currentDay - 1}">▶ מיום ${currentDay - 1}</span>`;
    } else if (contToNext) {
      crossDayTag = `<span class="cross-day-badge cross-to" title="ממשיך ליום ${currentDay + 1}">◀ ליום ${currentDay + 1}</span>`;
    }

    if (taskAssignments.length === 0) {
      html += `<tr class="row-warning"><td><strong>${task.name}</strong> ${crossDayTag}</td><td>${taskBadge(task)}</td>
        <td><span dir="ltr">${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</span></td>
        <td colspan="6"><em class="text-danger">⚠ אין שיבוצים</em></td></tr>`;
      continue;
    }

    taskAssignments.forEach((a, i) => {
      const p = pMap.get(a.participantId);
      const slot = task.slots.find(s => s.slotId === a.slotId);
      const isFrozen = a.status === AssignmentStatus.Frozen;
      const rowClass = a.status === AssignmentStatus.Conflict ? 'row-error' : isFrozen ? 'row-frozen' : '';
      html += `<tr class="${rowClass}" data-assignment-id="${a.id}">`;
      if (i === 0) {
        html += `<td rowspan="${taskAssignments.length}" class="task-cell task-tooltip-hover${taskIsFrozen ? ' task-cell-frozen' : ''}" data-task-id="${task.id}" style="border-inline-start:4px solid ${task.color || '#7f8c8d'}">
          <strong>${task.name}</strong> ${crossDayTag}
          ${taskIsFrozen ? '<span class="frozen-label">🧊 מוקפא</span>' : ''}</td>
          <td rowspan="${taskAssignments.length}">${taskBadge(task)}</td>
          <td rowspan="${taskAssignments.length}"><span dir="ltr">${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</span></td>`;
      }
      html += `<td><small>${slot?.label || task.name}</small></td>
        <td><strong class="participant-hover" data-pid="${p?.id || ''}">${p?.name || '???'}</strong></td>
        <td>${p ? levelBadge(p.level) : '—'}</td>
        <td>${p ? groupBadge(p.group) : '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td>
          ${isFrozen
            ? `<span class="frozen-action-icon" title="מוקפא — לא ניתן לשנות שיבוצי עבר">🧊</span>`
            : `<button class="btn-swap" data-assignment-id="${a.id}" data-task-id="${task.id}" title="החלפה">⇄</button>
               ${liveMode.enabled ? `<button class="btn-rescue" data-assignment-id="${a.id}" title="תוכניות חילוץ">🆘</button>` : ''}`
          }
        </td></tr>`;
    });
  }
  html += '</tbody></table></div>';
  return html;
}
*/

// ─── Gantt Chart ─────────────────────────────────────────────────────────────

function renderGanttChart(schedule: Schedule): string {
  // Build a filtered schedule for gantt rendering (only current day)
  const filteredTasks = getFilteredTasks(schedule);
  const filteredAssignments = getFilteredAssignments(schedule);
  const filteredSchedule: Schedule = {
    ...schedule,
    tasks: filteredTasks,
    assignments: filteredAssignments,
  };
  const ganttData = scheduleToGantt(filteredSchedule);
  const totalMs = ganttData.timelineEndMs - ganttData.timelineStartMs;
  if (totalMs <= 0) return '<p>אין נתוני ציר זמן ליום זה.</p>';

  const totalHours = totalMs / 3600000;
  // 2-hour labelled ticks for readability; 1-hour subtle gridlines
  const tickInterval = 2;

  let html = `<div class="gantt-container"><div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-timeline-col">`;

  // Subtle gridlines for every hour
  for (let h = 0; h <= totalHours; h += 1) {
    const pos = (h / totalHours) * 100;
    html += `<span class="gantt-gridline" style="left:${pos}%"></span>`;
  }

  // Labelled hour marks every 2 hours
  for (let h = 0; h <= totalHours; h += tickInterval) {
    const pos = (h / totalHours) * 100;
    const d = new Date(ganttData.timelineStartMs + h * 3600000);
    html += `<span class="gantt-hour-mark" style="left:${pos}%">${d.getHours().toString().padStart(2, '0')}:00</span>`;
  }
  html += `</div></div>`;

  for (const row of ganttData.rows) {
    // Skip rows with no blocks on this day
    if (row.blocks.length === 0) continue;

    html += `<div class="gantt-row"><div class="gantt-label-col">
      <span class="gantt-name participant-hover" data-pid="${row.participantId}">${row.participantName}</span>
      <span class="gantt-meta">${row.group} · ${row.level}</span>
    </div><div class="gantt-timeline-col">`;

    for (const block of row.blocks) {
      const left = ((block.startMs - ganttData.timelineStartMs) / totalMs) * 100;
      const width = (block.durationMs / totalMs) * 100;

      // Cross-day indicator on gantt blocks (schedule's frozen dayStartHour)
      const task = filteredTasks.find((t) => t.id === block.taskId);
      const dsh = schedule.algorithmSettings.dayStartHour;
      const crossFrom = task && taskStartsBefore(task, currentDay, dsh);
      const crossTo = task && taskEndsAfter(task, currentDay, dsh);
      const crossClass = crossFrom ? 'gantt-cross-from' : crossTo ? 'gantt-cross-to' : '';

      // Browser title tooltips render as plain text (no HTML), so we use
      // U+2066 LRI + U+2069 PDI to force the time range into an LTR isolate
      // inside the surrounding RTL tooltip — otherwise "05:00 – 13:00" flips.
      const tooltip = `${escHtml(block.taskName)}&#10;\u2066${new Date(block.startMs).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} – ${new Date(block.endMs).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}\u2069${crossFrom ? '&#10;▶ המשך מהיום הקודם' : ''}${crossTo ? '&#10;◀ ממשיך ליום הבא' : ''}`;
      const shortName = task?.sourceName ?? stripDayPrefix(block.taskName);
      html += `<div class="gantt-block task-tooltip-hover ${block.isZeroLoad ? 'gantt-zero-load' : ''} ${crossClass}" data-task-id="${block.taskId}" style="left:${left}%;width:${width}%;background:${block.color}" title="${tooltip}">
        <span class="gantt-block-text">${crossFrom ? '▶ ' : ''}${escHtml(shortName)}${crossTo ? ' ◀' : ''}</span></div>`;
    }
    html += `</div></div>`;
  }
  html += `</div>`;
  return html;
}

// ─── Schedule Generation ─────────────────────────────────────────────────────

/** Number of optimization attempts per generation (user-configurable) */
let OPTIM_ATTEMPTS = getStoredDefaultAttempts();

/**
 * Render the optimization overlay that covers the schedule board
 * while multi-attempt optimization is running.
 */
function renderOptimOverlay(): string {
  if (!_isOptimizing || !_optimProgress) return '';

  const { attempt, totalAttempts, bestScore, bestUnfilled, lastImproved } = _optimProgress;
  const pct = Math.round((attempt / totalAttempts) * 100);
  const titleText = _isContinuation ? 'ממשיך לחפש שבצ"ק טוב יותר' : 'מחפש את השיבוץ האיכותי ביותר';

  return `<div class="optim-overlay">
    <div class="optim-card">
      <div class="cube-loader-wrapper optim-cube">
        <div class="cube-loader">
          <div class="cube-cell" style="--cell-color:#4A90D9"></div>
          <div class="cube-cell" style="--cell-color:#E74C3C"></div>
          <div class="cube-cell" style="--cell-color:#F39C12"></div>
          <div class="cube-cell" style="--cell-color:#27AE60"></div>
          <div class="cube-cell" style="--cell-color:#8E44AD"></div>
          <div class="cube-cell" style="--cell-color:#1ABC9C"></div>
          <div class="cube-cell" style="--cell-color:#3498db"></div>
          <div class="cube-cell" style="--cell-color:#e67e22"></div>
          <div class="cube-cell" style="--cell-color:#2ecc71"></div>
        </div>
      </div>
      <h3>${titleText}</h3>
      <div class="optim-progress-bar">
        <div class="optim-progress-fill" style="width:${pct}%"></div>
      </div>
      <div class="optim-status">
        ניסיון <strong>${attempt}</strong> / ${totalAttempts}
        ${lastImproved ? '<span class="optim-improved">★ שיפור!</span>' : ''}
      </div>
      <div class="optim-metrics">
        <div class="optim-metric">
          <span class="optim-metric-label">ציון הטוב ביותר</span>
          <span class="optim-metric-value">${bestScore.toFixed(1)}</span>
        </div>
        ${
          bestUnfilled > 0
            ? `<div class="optim-metric">
          <span class="optim-metric-label">משבצות לא מאוישות</span>
          <span class="optim-metric-value optim-warn">${bestUnfilled}</span>
        </div>`
            : ''
        }
      </div>
      <div class="optim-actions">
        <button class="btn-accept-best" id="btn-accept-best" ${attempt < 1 ? 'disabled' : ''}>לשבצ"ק (סיים עכשיו)</button>
        <button class="btn-cancel-optim" id="btn-cancel-optim">ביטול</button>
      </div>
    </div>
  </div>`;
}

/** Wire the cancel button inside the optimization overlay (idempotent). */
function wireOptimCancelButton(): void {
  const btn = document.getElementById('btn-cancel-optim') as HTMLButtonElement | null;
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => _optimAbortController?.abort());
  }
}

/** Wire the "accept best so far" button inside the optimization overlay (idempotent). */
function wireOptimAcceptBestButton(): void {
  const btn = document.getElementById('btn-accept-best') as HTMLButtonElement | null;
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => _optimEarlyStopController?.abort());
  }
}

/**
 * Update ONLY the optimization overlay without touching the rest of the DOM.
 * This avoids a full renderAll cycle during optimization.
 */
function updateOverlay(): void {
  const overlay = document.querySelector('.optim-overlay') as HTMLElement | null;

  if (!_isOptimizing || !_optimProgress) {
    overlay?.remove();
    return;
  }

  const { attempt, totalAttempts, bestScore, bestUnfilled, lastImproved } = _optimProgress;
  const pct = Math.round((attempt / totalAttempts) * 100);

  if (overlay) {
    // Surgically update only the changing parts — keep the cube animation running
    const fill = overlay.querySelector('.optim-progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;
    const status = overlay.querySelector('.optim-status') as HTMLElement | null;
    if (status)
      status.innerHTML = `ניסיון <strong>${attempt}</strong> / ${totalAttempts} ${lastImproved ? '<span class="optim-improved">★ שיפור!</span>' : ''}`;
    const scoreVal = overlay.querySelector('.optim-metric-value') as HTMLElement | null;
    if (scoreVal) scoreVal.textContent = bestScore.toFixed(1);
    const unfilledVal = overlay.querySelectorAll('.optim-metric-value')[1] as HTMLElement | null;
    if (unfilledVal) {
      unfilledVal.textContent = String(bestUnfilled);
      unfilledVal.className = `optim-metric-value ${bestUnfilled === 0 ? 'optim-ok' : 'optim-warn'}`;
    }
    // Enable accept-best once at least one attempt has produced a best result
    const acceptBtn = overlay.querySelector('#btn-accept-best') as HTMLButtonElement | null;
    if (acceptBtn) acceptBtn.disabled = attempt < 1;
  } else {
    // First render — insert full overlay with cube
    const html = renderOptimOverlay();
    const content = document.getElementById('tab-content');
    if (content) {
      content.insertAdjacentHTML('beforeend', html);
      wireOptimCancelButton();
      wireOptimAcceptBestButton();
    }
  }
}

async function doGenerate(): Promise<void> {
  // Prevent double-click
  if (_isOptimizing) return;
  if (_isAutoTuningApp) {
    showToast('לא ניתן ליצור שבצ"ק בזמן כיול אוטומטי.', { type: 'warning' });
    return;
  }
  // Fresh generation — discard any continuation history from a prior schedule.
  _noImprovementStreak = 0;

  // Defensive re-run: the button's disabled state was set at last render, so a
  // user edit between render and click could have introduced a Critical
  // finding. Re-running takes ~10–50ms and avoids spending a full optimization
  // run on a config the engine will reject.
  const pf = runPreflight();
  if (!pf.canGenerate) {
    const crits = pf.findings.filter((f) => f.severity === 'Critical');
    showToast(`לא ניתן ליצור שיבוץ — ${crits.length} בעיות קריטיות. עבור למסך פירוט משימות לתיקון.`, { type: 'error' });
    renderAll();
    return;
  }

  // Read user-configured scenario count
  const scenarioInput = document.getElementById('input-scenarios') as HTMLInputElement | null;
  if (scenarioInput) {
    const val = parseInt(scenarioInput.value, 10);
    if (val > 0) OPTIM_ATTEMPTS = val;
  }

  const participants = store.getAllParticipants();
  const tasks = generateTasksFromTemplates();

  const algoSettings = store.getAlgorithmSettings();
  engine = new SchedulingEngine(
    algoSettings.config,
    store.getDisabledHCSet(),
    store.buildRestRuleMap(),
    store.getDayStartHour(),
    algoSettings.splittingMode,
  );
  engine.setCertLabelSnapshot(buildCertLabelSnapshot());
  engine.setPeriod(store.getScheduleDate(), store.getScheduleDays());
  engine.addParticipants(participants);
  engine.addTasks(tasks);

  // Continuity: if previous-schedule JSON is present, build phantom context.
  // Capture the parsed snapshot so we can attach it to the resulting
  // schedule for post-generation Day 0 display.
  let parsedContinuity: ContinuitySnapshot | null = null;
  if (_continuityJson.trim()) {
    const parsed = parseContinuitySnapshot(_continuityJson);
    if ('error' in parsed) {
      showToast(parsed.error, { type: 'error' });
      return;
    }
    parsedContinuity = parsed;
    const phantom = buildPhantomContext(parsed, participants);
    if (phantom.phantomAssignments.length > 0) {
      engine.setPhantomContext(phantom);
    }
  }

  // Switch to schedule tab and show overlay (keep old schedule visible behind it)
  currentTab = 'schedule';
  pushHash();
  _isOptimizing = true;
  _optimAbortController = new AbortController();
  _optimEarlyStopController = new AbortController();
  _optimProgress = {
    attempt: 0,
    totalAttempts: OPTIM_ATTEMPTS,
    bestScore: -Infinity,
    bestUnfilled: Infinity,
    lastImproved: false,
  };
  // Reset per-attempt score history for the score-breakdown panel.
  // Push happens inside the existing onProgress callback below.
  clearAttemptScoreHistory();

  // Render the tab (with old schedule or empty state) + overlay
  renderAll();
  wireOptimCancelButton();
  wireOptimAcceptBestButton();

  // Disable generate button during optimization
  const genBtn = document.getElementById('btn-generate') as HTMLButtonElement | null;
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.textContent = '⏳ מייעל…';
  }

  const t0 = performance.now();
  let scheduleSaved = false;
  let wasCancelled = false;
  let wasEarlyStopped = false;

  // Coalesce per-batch progress events via rAF, OR-ing `improved` so an
  // early-batch improvement isn't clobbered by a non-improving later attempt
  // in the same synchronous batch (ASYNC_BATCH_SIZE = 4 in optimizer.ts).
  let pendingProgress: {
    attempt: number;
    totalAttempts: number;
    bestScore: number;
    bestUnfilled: number;
    lastImproved: boolean;
  } | null = null;
  let progressRafId = 0;

  try {
    const schedule = await engine.generateScheduleAsync(
      OPTIM_ATTEMPTS,
      (info) => {
        // Capture this attempt's final score for the breakdown sparkline.
        // Push-only into a small array (~60 numbers/run) — free.
        pushAttemptScore(info.attemptScore);

        // Merge into the pending event: take latest counters/scores, but
        // OR `lastImproved` so any improvement in the frame survives to paint.
        pendingProgress = {
          attempt: info.attempt,
          totalAttempts: info.totalAttempts,
          bestScore: info.currentBestScore,
          bestUnfilled: info.currentBestUnfilled,
          lastImproved: (pendingProgress?.lastImproved ?? false) || info.improved,
        };

        if (progressRafId === 0) {
          progressRafId = requestAnimationFrame(() => {
            progressRafId = 0;
            if (!pendingProgress) return;
            _optimProgress = pendingProgress;
            pendingProgress = null;
            updateOverlay();
          });
        }
      },
      _optimAbortController?.signal,
      _optimEarlyStopController?.signal,
    );
    wasEarlyStopped = _optimEarlyStopController?.signal.aborted === true;

    // ── Atomic commit: update state in one go, then render once ──
    closeRescueModal();
    closeInjectTaskModal();
    // Attach the parsed continuity snapshot to the frozen schedule so the UI
    // can render it as a virtual Day 0 post-generation. The engine itself
    // never sees this field — it stays a UI concern.
    if (parsedContinuity) {
      schedule.continuitySnapshot = parsedContinuity;
    }
    currentSchedule = schedule;
    scheduleElapsed = Math.round(performance.now() - t0);
    scheduleActualAttempts = schedule.actualAttempts ?? OPTIM_ATTEMPTS;
    currentDay = 1;
    _scheduleDirty = false;
    _snapshotDirty = true;
    store.setActiveSnapshotId(null);

    // Persist schedule to localStorage
    scheduleSaved = store.saveSchedule(schedule);

    // Apply live mode freeze if active
    const liveMode = store.getLiveModeState();
    if (liveMode.enabled) {
      freezeAssignments(currentSchedule, liveMode.currentTimestamp);
    }
  } catch (err) {
    // User cancelled — clean up without error display
    if (_optimAbortController?.signal.aborted) {
      wasCancelled = true;
    } else {
      // Safety buffer: if all attempts fail, show error without clearing board
      console.error('[Scheduler] All optimization attempts failed:', err);
      const errDiv = document.querySelector('.optim-overlay .optim-card');
      if (errDiv) {
        errDiv.innerHTML = `
          <div class="optim-error">
            <h3>⚠ האופטימיזציה נכשלה</h3>
            <p>לא נמצא פתרון תקין ב-${OPTIM_ATTEMPTS} ניסיונות.</p>
            <p>בדוק את האילוצים ואת זמינות המשתתפים.</p>
            <button class="btn-primary" id="btn-dismiss-error">סגור</button>
          </div>`;
        const dismissBtn = document.getElementById('btn-dismiss-error');
        if (dismissBtn) {
          dismissBtn.addEventListener('click', () => {
            _isOptimizing = false;
            _optimProgress = null;
            _optimAbortController = null;
            renderAll();
          });
        }
        return; // Don't remove overlay yet
      }
    }
  } finally {
    if (progressRafId !== 0) {
      cancelAnimationFrame(progressRafId);
      progressRafId = 0;
    }
    pendingProgress = null;
    _isOptimizing = false;
    _optimProgress = null;
    _optimAbortController = null;
    _optimEarlyStopController = null;
  }

  if (wasCancelled) {
    renderAll();
    showToast('יצירת השבצ"ק בוטלה', { type: 'info' });
    return;
  }

  // Final atomic render with the winning schedule
  renderAll();
  if (scheduleSaved) {
    if (wasEarlyStopped) {
      showToast(`שבצ"ק נוצר מתוך ${scheduleActualAttempts} ניסיונות (${(scheduleElapsed / 1000).toFixed(1)} שניות)`, {
        type: 'success',
      });
    } else {
      showToast(`שבצ"ק נוצר בהצלחה (${(scheduleElapsed / 1000).toFixed(1)} שניות)`, { type: 'success' });
    }
  } else {
    showToast('השבצ"ק נוצר אך לא נשמר — נפח האחסון בדפדפן מלא. בטעינה מחדש הוא יאבד.', {
      type: 'warning',
      duration: 8000,
    });
  }

  // Skip the "run more attempts?" prompt when the user explicitly stopped
  // early — they already chose to take the current best.
  if (!wasEarlyStopped) {
    await maybePromptContinuation();
  }
}

/** Count slots reported as infeasible (unfilled) on the current schedule. */
function countInfeasibleSlots(schedule: Schedule): number {
  let n = 0;
  for (const v of schedule.violations) {
    if (v.code === 'INFEASIBLE_SLOT') n++;
  }
  return n;
}

/**
 * After a generation or continuation completes, ask the user whether to run
 * additional optimization attempts seeded from the current best. Idempotent
 * to call repeatedly; bails out when nothing is unfilled, when the schedule
 * is dirty, or when the engine has no cached optimization result.
 */
async function maybePromptContinuation(): Promise<void> {
  if (!currentSchedule || !engine || _scheduleDirty) return;
  if (!engine.hasOptimizationResultForContinuation()) return;
  const unfilled = countInfeasibleSlots(currentSchedule);
  if (unfilled === 0) {
    // Solved — clear the streak so a future continuation chain starts fresh.
    _noImprovementStreak = 0;
    return;
  }
  const additional = await showContinuationModal({
    unfilledCount: unfilled,
    originalAttempts: scheduleActualAttempts,
    diminishingReturnsHint: _noImprovementStreak >= 2,
  });
  if (additional === null) return;
  await runContinuation(additional);
}

/**
 * Run `additional` more optimization attempts seeded from the engine's
 * cached prior result. Reuses the existing optimization overlay (with the
 * title swapped to indicate continuation) and the existing abort / early-
 * stop controllers. On strict improvement the new schedule replaces the
 * old one; otherwise the schedule is left untouched except for the
 * cumulative attempt count.
 */
async function runContinuation(additional: number): Promise<void> {
  if (_isOptimizing || !engine || !currentSchedule) return;
  if (!engine.hasOptimizationResultForContinuation()) return;

  const prevScheduleRef = currentSchedule;
  const prevUnfilled = countInfeasibleSlots(currentSchedule);
  const baselineAttempts = scheduleActualAttempts;

  _isOptimizing = true;
  _isContinuation = true;
  _optimAbortController = new AbortController();
  _optimEarlyStopController = new AbortController();
  _optimProgress = {
    attempt: baselineAttempts,
    totalAttempts: baselineAttempts + additional,
    bestScore: currentSchedule.score.compositeScore,
    bestUnfilled: prevUnfilled,
    lastImproved: false,
  };
  clearAttemptScoreHistory();

  // Switch to schedule tab if not already there, and show overlay.
  currentTab = 'schedule';
  pushHash();
  renderAll();
  wireOptimCancelButton();
  wireOptimAcceptBestButton();

  // Disable generate button while continuation runs.
  const genBtn = document.getElementById('btn-generate') as HTMLButtonElement | null;
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.textContent = '⏳ ממשיך…';
  }

  const t0 = performance.now();
  let wasCancelled = false;
  let wasEarlyStopped = false;
  let scheduleSaved = false;

  // Same rAF-coalescing pattern as doGenerate — preserves improvement flashes
  // even when multiple progress events land in the same paint frame.
  let pendingProgress: {
    attempt: number;
    totalAttempts: number;
    bestScore: number;
    bestUnfilled: number;
    lastImproved: boolean;
  } | null = null;
  let progressRafId = 0;

  try {
    const schedule = await engine.continueOptimizationAsync(
      additional,
      (info) => {
        pushAttemptScore(info.attemptScore);
        pendingProgress = {
          attempt: info.attempt,
          totalAttempts: info.totalAttempts,
          bestScore: info.currentBestScore,
          bestUnfilled: info.currentBestUnfilled,
          lastImproved: (pendingProgress?.lastImproved ?? false) || info.improved,
        };
        if (progressRafId === 0) {
          progressRafId = requestAnimationFrame(() => {
            progressRafId = 0;
            if (!pendingProgress) return;
            _optimProgress = pendingProgress;
            pendingProgress = null;
            updateOverlay();
          });
        }
      },
      _optimAbortController.signal,
      _optimEarlyStopController.signal,
    );
    wasEarlyStopped = _optimEarlyStopController.signal.aborted;

    currentSchedule = schedule;
    scheduleElapsed = Math.round(performance.now() - t0);
    scheduleActualAttempts = schedule.actualAttempts ?? baselineAttempts + additional;
    _snapshotDirty = true;
    store.setActiveSnapshotId(null);

    scheduleSaved = store.saveSchedule(schedule);

    const liveMode = store.getLiveModeState();
    if (liveMode.enabled) {
      freezeAssignments(currentSchedule, liveMode.currentTimestamp);
    }
  } catch (err) {
    if (_optimAbortController?.signal.aborted) {
      wasCancelled = true;
    } else {
      console.error('[Scheduler] Continuation failed:', err);
      showToast('שגיאה במהלך ההמשך.', { type: 'error' });
    }
  } finally {
    if (progressRafId !== 0) {
      cancelAnimationFrame(progressRafId);
      progressRafId = 0;
    }
    pendingProgress = null;
    _isOptimizing = false;
    _isContinuation = false;
    _optimProgress = null;
    _optimAbortController = null;
    _optimEarlyStopController = null;
  }

  renderAll();

  if (wasCancelled) {
    showToast('ההמשך בוטל', { type: 'info' });
    return;
  }

  const improved = currentSchedule !== prevScheduleRef;
  if (improved) {
    _noImprovementStreak = 0;
    const newUnfilled = countInfeasibleSlots(currentSchedule!);
    const diff = prevUnfilled - newUnfilled;
    const msg = diff > 0 ? `שבצ"ק שופר: ${prevUnfilled} → ${newUnfilled} משבצות לא מאוישות` : 'שבצ"ק שופר בציון הכולל';
    showToast(msg, { type: 'success' });
    if (!scheduleSaved) {
      showToast('השבצ"ק שופר אך לא נשמר — נפח האחסון בדפדפן מלא.', { type: 'warning', duration: 8000 });
    }
  } else {
    _noImprovementStreak++;
    const ranLabel = wasEarlyStopped
      ? `${scheduleActualAttempts - baselineAttempts} ניסיונות נוספים שבוצעו`
      : `${additional} ניסיונות נוספים`;
    showToast(`לא נמצא שיפור ב-${ranLabel}. השבצ"ק נותר כפי שהוא.`, { type: 'info' });
  }

  // Re-prompt while slots remain unfilled — unless the user explicitly
  // stopped early, in which case they've already chosen to stop searching.
  if (!wasEarlyStopped) {
    await maybePromptContinuation();
  }
}

// ─── Create Empty Manual Schedule ──────────────────────────────────────────

function doCreateManualSchedule(): void {
  const participants = store.getAllParticipants();
  const tasks = generateTasksFromTemplates();

  if (tasks.length === 0) {
    showToast('אין משימות להציג — הגדר תחילה כללי משימות', { type: 'error' });
    return;
  }

  // Initialize engine (same as doGenerate) so revalidateAndRefresh() works
  const algoSettings = store.getAlgorithmSettings();
  engine = new SchedulingEngine(
    algoSettings.config,
    store.getDisabledHCSet(),
    store.buildRestRuleMap(),
    store.getDayStartHour(),
    algoSettings.splittingMode,
  );
  engine.setCertLabelSnapshot(buildCertLabelSnapshot());
  engine.setPeriod(store.getScheduleDate(), store.getScheduleDays());
  engine.addParticipants(participants);
  engine.addTasks(tasks);

  // Build empty schedule — tasks populated, no assignments
  const emptySchedule: Schedule = {
    id: `manual-${Date.now()}`,
    tasks,
    participants,
    assignments: [],
    feasible: false,
    score: {
      minRestHours: 0,
      avgRestHours: 0,
      workloadStdDev: 0,
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
      config: { ...algoSettings.config },
      disabledHardConstraints: [...algoSettings.disabledHardConstraints],
      dayStartHour: algoSettings.dayStartHour,
      splittingMode: algoSettings.splittingMode,
    },
    periodStart: store.getScheduleDate(),
    periodDays: store.getScheduleDays(),
    restRuleSnapshot: Object.fromEntries(store.buildRestRuleMap()),
    certLabelSnapshot: buildCertLabelSnapshot(),
    scheduleUnavailability: [],
  };

  engine.importSchedule(emptySchedule);
  engine.revalidateFull();
  closeRescueModal();
  closeInjectTaskModal();
  currentSchedule = engine.getSchedule()!;

  currentDay = 1;
  _scheduleDirty = false;
  _snapshotDirty = true;
  store.setActiveSnapshotId(null);

  // Activate manual build mode immediately
  _manualBuildActive = true;
  clearManualSelection();
  _undoStack = _undoStack.filter((e) => e.kind !== 'manual');
  _warehouseFilter = '';

  scheduleElapsed = 0;
  scheduleActualAttempts = 0;

  const manualSaved = store.saveSchedule(currentSchedule);
  renderAll();

  // Auto-scroll to the grid so slots are immediately visible
  requestAnimationFrame(() => {
    const grid = document.querySelector('.schedule-grid-container');
    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  if (manualSaved) {
    showToast('שבצ"ק ריק נוצר — בחר משבצת ואז משתתף', { type: 'success' });
  } else {
    showToast('השבצ"ק נוצר אך לא נשמר — נפח האחסון בדפדפן מלא.', { type: 'warning', duration: 8000 });
  }
}

// ─── Interactive Handlers ────────────────────────────────────────────────────

/**
 * After every manual change we re-validate the ENTIRE 7-day schedule
 * and refresh all stats so cross-day conflicts surface immediately.
 */
function revalidateAndRefresh(): void {
  if (!engine || !currentSchedule) return;

  // C1+R6: Full 7-day re-validation — recomputes hard constraints,
  // soft warnings, AND schedule score so nothing is stale.
  engine.revalidateFull();
  currentSchedule = engine.getSchedule();

  // Mark snapshot as dirty (schedule was modified since last save/load)
  _snapshotDirty = true;

  // Re-apply freeze if live mode is active
  const liveMode = store.getLiveModeState();
  if (liveMode.enabled && currentSchedule) {
    freezeAssignments(currentSchedule, liveMode.currentTimestamp);
  }

  // Persist updated schedule
  if (currentSchedule) {
    if (!store.saveSchedule(currentSchedule)) {
      showToast('השינוי בוצע אך לא נשמר — נפח האחסון מלא.', { type: 'warning', duration: 6000 });
    }
  }

  renderAll();
}

// ─── Auto-Tuner ──────────────────────────────────────────────────────────────

let _isAutoTuningApp = false;

async function handleAutoTune(): Promise<void> {
  if (_isAutoTuningApp) return;
  if (_isOptimizing) {
    showToast('לא ניתן לכייל בזמן יצירת שבצ"ק.', { type: 'warning' });
    return;
  }
  const splittingMode = store.getAlgorithmSettings().splittingMode ?? 'quality';
  const hasSplittableTask =
    store.getAllTaskTemplates().some((t) => t.splittable) || store.getAllOneTimeTasks().some((t) => t.splittable);
  const splitPenaltyTuned = splittingMode === 'quality' && hasSplittableTask;
  const splitNoteHtml = splitPenaltyTuned
    ? '<p style="margin: 0.75em 0 0 0;">הכיול <b>כולל</b> את עונש הפיצול.</p>'
    : '<p style="margin: 0.75em 0 0 0;">הכיול <b>לא כולל</b> את עונש הפיצול.</p>';
  const ok = await showConfirm(
    'הכיול יבחן עשרות סטים של משקלות מול הנתונים שלך, ועשוי להימשך מספר דקות. ההגדרות הנוכחיות לא ישונו — תקבל המלצה שתוכל ליישם.',
    { title: 'כיול אוטומטי של הגדרות', confirmLabel: 'התחל כיול', extraBodyHtml: splitNoteHtml },
  );
  if (!ok) return;

  _isAutoTuningApp = true;
  try {
    const recommendation = await runAutoTune();
    if (!recommendation) {
      // User cancelled or the tuner bailed out before any verdict.
      showToast('הכיול בוטל.', { type: 'warning' });
      return;
    }
    showTuneResultModal(recommendation);
  } catch (err) {
    console.error('[AutoTuner] failure:', err);
    const msg = err instanceof Error ? err.message : 'שגיאה לא צפויה בכיול אוטומטי.';
    showToast(msg, { type: 'error', duration: 6000 });
  } finally {
    _isAutoTuningApp = false;
  }
}

function formatWeightKey(key: string): string {
  // Use the exact slider label from the Algorithm Settings UI (single source of
  // truth in WEIGHT_GROUPS) so the auto-tune change table names match the
  // controls the user actually edits.
  return getWeightFieldLabel(key);
}

function showTuneResultModal(rec: TuneRecommendation): void {
  const deltaSign = rec.medianDelta >= 0 ? '+' : '';
  const deltaClass = rec.medianDelta >= 0 ? 'tune-delta-good' : 'tune-delta-bad';
  const diffRows = rec.diff
    .map((d) => {
      const arrow = d.tuned > d.baseline ? '↑' : '↓';
      return `<tr>
        <td class="tune-diff-key">${escHtml(formatWeightKey(String(d.key)))}</td>
        <td class="tune-diff-baseline">${d.baseline}</td>
        <td class="tune-diff-arrow">${arrow}</td>
        <td class="tune-diff-tuned">${d.tuned}</td>
      </tr>`;
    })
    .join('');

  const diffTable = rec.diff.length
    ? `<table class="tune-diff-table">
        <thead><tr><th>משקל</th><th>נוכחי</th><th></th><th>מומלץ</th></tr></thead>
        <tbody>${diffRows}</tbody>
      </table>`
    : `<p class="tune-result-note">אין הבדלים מול ההגדרות הנוכחיות.</p>`;

  const html = `
    <div class="tune-result-modal">
      <div class="tune-result-header">
        <h3>${rec.recommend ? 'נמצאה המלצה' : 'אין צורך בשינוי'}</h3>
        <p class="tune-result-reason">${escHtml(rec.reason)}</p>
      </div>
      <p class="tune-result-fingerprint">${escHtml(rec.fingerprintSummary)}</p>
      <div class="tune-result-stats">
        <div class="tune-stat">
          <span class="tune-stat-label">ציון ההגדרות הנוכחיות</span>
          <span class="tune-stat-value">${rec.baselineMedian.toFixed(1)}</span>
          <span class="tune-stat-sub" title="טווח הפיזור בין ריצות חוזרות — נמוך יותר משמעו תוצאות יציבות יותר">טווח פיזור ${rec.baselineIQR.toFixed(1)}</span>
        </div>
        <div class="tune-stat">
          <span class="tune-stat-label">ציון ההגדרות המומלצות</span>
          <span class="tune-stat-value">${rec.winnerMedian.toFixed(1)}</span>
          <span class="tune-stat-sub" title="טווח הפיזור בין ריצות חוזרות — נמוך יותר משמעו תוצאות יציבות יותר">טווח פיזור ${rec.winnerIQR.toFixed(1)}</span>
        </div>
        <div class="tune-stat">
          <span class="tune-stat-label">שיפור</span>
          <span class="tune-stat-value ${deltaClass}">${deltaSign}${rec.medianDelta.toFixed(1)}</span>
          <span class="tune-stat-sub">${(rec.durationMs / 1000).toFixed(0)} שניות</span>
        </div>
      </div>
      ${diffTable}
      <div class="tune-result-actions">
        ${rec.recommend ? '<button class="btn-sm btn-primary" data-action="tune-apply">החל הגדרות מומלצות</button>' : ''}
        <button class="btn-sm btn-outline" data-action="tune-close">סגור</button>
      </div>
    </div>`;

  const sheet = showBottomSheet(html, { title: 'תוצאות הכיול האוטומטי' });
  sheet.el.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'tune-close') {
      sheet.close();
    } else if (btn.dataset.action === 'tune-apply') {
      store.setAlgorithmSettings({ config: rec.config });
      sheet.close();
      showToast('ההגדרות המומלצות הוחלו. צור שבצ"ק חדש כדי לראות את ההשפעה.', { type: 'success' });
      if (currentTab === 'algorithm') renderAll();
      await offerSaveTuneAsPreset();
    }
  });
}

/**
 * After the user applies a tuned config, offer to save it as a named preset.
 * Retries the name prompt on collision; a null prompt result (user cancelled)
 * ends the flow silently. The applied config stays in effect either way.
 */
async function offerSaveTuneAsPreset(): Promise<void> {
  const wantsSave = await showConfirm('לשמור את ההגדרות הללו כסט הגדרות בעל שם, כדי לחזור אליהן בקלות בעתיד?', {
    title: 'שמירת ההגדרות',
    confirmLabel: 'שמור כסט',
    cancelLabel: 'לא עכשיו',
  });
  if (!wantsSave) return;

  const todayHe = new Date().toLocaleDateString('he-IL');
  const defaultName = `כיול אוטומטי ${todayHe}`;
  const description = `נוצר מכיול אוטומטי בתאריך ${todayHe}`;

  // Loop until the user supplies an unused name or cancels.
  let pendingDefault = defaultName;
  while (true) {
    const name = await showPrompt('בחר שם לסט:', {
      title: 'שמירת סט הגדרות',
      placeholder: 'שם הסט',
      defaultValue: pendingDefault,
    });
    if (name == null) return; // user cancelled
    const trimmed = name.trim();
    if (!trimmed) {
      await showAlert('שם הסט לא יכול להיות ריק.', { icon: '⚠️' });
      pendingDefault = defaultName;
      continue;
    }
    const saved = store.saveCurrentAsPreset(trimmed, description);
    if (saved) {
      showToast(`ההגדרות נשמרו כסט "${saved.name}".`, { type: 'success' });
      if (currentTab === 'algorithm') renderAll();
      return;
    }
    // saveCurrentAsPreset returns null only on name collision (empty name is
    // already guarded above). Surface a clear prompt and retry.
    await showAlert('שם זה כבר בשימוש על ידי סט אחר. בחר שם אחר.', { icon: '⚠️' });
    pendingDefault = trimmed;
  }
}

async function handleSwap(assignmentId: string): Promise<void> {
  if (!currentSchedule || !engine) return;
  const assignment = currentSchedule.assignments.find((a) => a.id === assignmentId);
  if (!assignment) return;
  if (assignment.status === AssignmentStatus.Frozen) {
    await showAlert('השיבוץ הזה מוקפא כי הוא בעבר. אי אפשר לשנות אותו.', { icon: '🧊' });
    return;
  }

  // Read frozen engine state — external store edits don't leak into swap previews.
  const disabledHC = engine.getDisabledHC() ?? new Set();
  const restRuleMap = engine.getRestRuleMap() ?? new Map();

  await openSwapPicker(assignmentId, {
    engine,
    schedule: currentSchedule,
    disabledHC,
    restRuleMap,
    dayStartHour: engine.getDayStartHour(),
    onCommit: ({ label, preCommitAssignments, swappedAssignmentIds, recordVacatedSlots }) => {
      if (!currentSchedule) return;
      // Record a pre-commit schedule snapshot on the parallel stack and push
      // a (no-op) checkpoint onto the store's undo stack so the header
      // undo/redo buttons light up and `doUndoRedo('undo')` restores the
      // pre-swap state. The engine mutated `currentSchedule.assignments` in
      // place (shared reference), so we clone the schedule and substitute
      // the pre-commit assignments. The clone happens before the
      // `scheduleUnavailability` upsert below so a single undo also rolls
      // back the new unavailability entries.
      const preCommitSchedule: Schedule = {
        ...currentSchedule,
        assignments: preCommitAssignments,
      };
      _scheduleUndoStack.push({
        schedule: structuredClone(preCommitSchedule),
        dirty: _scheduleDirty,
      });
      if (_scheduleUndoStack.length > 80) _scheduleUndoStack.shift();
      _scheduleRedoStack.length = 0;
      store.pushUndoCheckpoint();

      // Record the optional "mark vacated participant(s) unavailable for the
      // vacated slot's time window" entries. Past slots are skipped.
      if (recordVacatedSlots.length > 0) {
        const liveAnchor = store.getLiveModeState().currentTimestamp ?? new Date();
        let next = currentSchedule.scheduleUnavailability;
        for (let i = 0; i < recordVacatedSlots.length; i++) {
          const r = recordVacatedSlots[i];
          if (r.end.getTime() <= liveAnchor.getTime()) continue;
          next = upsertScheduleUnavailability(next, {
            id: `replaced-${Date.now()}-${i}-${r.participantId}`,
            participantId: r.participantId,
            start: r.start,
            end: r.end,
            createdAt: new Date(),
            anchorAtCreation: liveAnchor,
            appliedSwapCount: swappedAssignmentIds.length,
            reason: r.reason,
          });
        }
        currentSchedule.scheduleUnavailability = next;
      }

      for (const id of swappedAssignmentIds) _pendingSwapAnimIds.add(id);
      revalidateAndRefresh();

      showToast(label, {
        type: 'success',
        duration: 5000,
        action: {
          label: 'בטל',
          callback: () => {
            doUndoRedo('undo');
          },
        },
      });
    },
  });
}

// ─── Rescue Modal ────────────────────────────────────────────────────────────

/**
 * Ensure live mode is enabled with a valid anchor. If off, prompt the user to
 * pick one via the existing day+hour picker. Returns the anchor timestamp or
 * null if the user cancelled.
 *
 * `taskGate`, when provided, enforces that the picked anchor leaves the task
 * modifiable (used by single-slot SOS). Future-SOS callers omit it because
 * the range picker validates the anchor against the chosen window instead.
 */
async function ensureLiveModeAnchor(taskGate?: Task | null): Promise<Date | null> {
  const lm = store.getLiveModeState();
  if (lm.enabled) return lm.currentTimestamp;

  if (!currentSchedule) return null;

  // Read from the frozen schedule, not the live store — the anchor picker must
  // match the schedule the user is acting on.
  const numDays = currentSchedule.periodDays;
  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    days.push({ value: String(d), label: `יום ${d}` });
  }
  const dayStartHour = currentSchedule.algorithmSettings.dayStartHour;
  const hours: Array<{ value: string; label: string }> = operationalHourOrder(dayStartHour).map((h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  }));

  const { defaultDay, defaultHour } = anchorToPickerDefaults(
    computeDefaultLiveAnchor(currentSchedule),
    currentSchedule,
  );
  const result = await showTimePicker('כדי להמשיך, יש להגדיר את הזמן הנוכחי במצב חי.', {
    title: 'הפעלת מצב חי',
    days,
    hours,
    defaultDay,
    defaultHour,
  });
  if (!result) return null;

  const dayIdx = parseInt(result.day, 10);
  const hour = parseInt(result.hour, 10);
  const base = currentSchedule.periodStart;
  // hourInOpDay maps tail hours (< dayStartHour) onto the op-day's post-midnight
  // tail, matching the tail-aware toDate helper used in handleProfileFutureSos.
  const ts = new Date(hourInOpDay(base, dayStartHour, dayIdx, hour));

  if (taskGate && !isFutureTask(taskGate, ts)) {
    await showAlert('הזמן שנבחר הופך את המשימה למוקפאת (בעבר). לא ניתן להפעיל חילוץ על משימה שכבר חלפה.', {
      title: 'לא ניתן להמשיך',
      icon: '⚠️',
    });
    return null;
  }

  store.setLiveModeEnabled(true);
  store.setLiveModeTimestamp(ts);
  freezeAssignments(currentSchedule, ts);
  return ts;
}

async function handleSosRescue(assignmentId: string): Promise<void> {
  if (!currentSchedule) return;
  const assignment = currentSchedule.assignments.find((a) => a.id === assignmentId);
  if (!assignment) return;
  const task = currentSchedule.tasks.find((t) => t.id === assignment.taskId);
  if (!task) return;

  const anchor = await ensureLiveModeAnchor(task);
  if (!anchor) return;
  openRescueModal(assignmentId);
}

interface FutureSosEntryOpts {
  defaultStartDay?: string;
  defaultStartHour?: string;
  defaultEndDay?: string;
  defaultEndHour?: string;
  defaultReason?: string;
}

interface PreExistingUnavailabilityOverlap {
  kind: 'availability-gap' | 'date-unavailability' | 'schedule-unavailability';
  label: string;
  start: Date;
  end: Date;
}

/**
 * Detect portions of a future-SOS window that are already marked unavailable
 * for the participant via any of three sources:
 *   1. Gaps in `participant.availability` (participants screen)
 *   2. `participant.dateUnavailability` recurring rules (participants screen)
 *   3. Existing `schedule.scheduleUnavailability` entries (prior Future-SOS)
 *
 * Used to warn the user before a redundant window is recorded.
 */
function findPreExistingUnavailabilityOverlaps(
  participant: Participant,
  schedule: Schedule,
  window: { start: Date; end: Date },
): PreExistingUnavailabilityOverlap[] {
  const overlaps: PreExistingUnavailabilityOverlap[] = [];
  const wStart = window.start.getTime();
  const wEnd = window.end.getTime();

  if (participant.availability && participant.availability.length > 0) {
    const clipped = participant.availability
      .map((av) => ({
        start: Math.max(av.start.getTime(), wStart),
        end: Math.min(av.end.getTime(), wEnd),
      }))
      .filter((c) => c.start < c.end)
      .sort((a, b) => a.start - b.start);
    let cursor = wStart;
    for (const c of clipped) {
      if (c.start > cursor) {
        overlaps.push({
          kind: 'availability-gap',
          label: 'מחוץ לחלון הזמינות הקבוע של המשתתף',
          start: new Date(cursor),
          end: new Date(c.start),
        });
      }
      if (c.end > cursor) cursor = c.end;
    }
    if (cursor < wEnd) {
      overlaps.push({
        kind: 'availability-gap',
        label: 'מחוץ לחלון הזמינות הקבוע של המשתתף',
        start: new Date(cursor),
        end: new Date(wEnd),
      });
    }
  }

  const rules = participant.dateUnavailability ?? [];
  if (rules.length > 0) {
    // Instantiate each rule once in op-day space — matches the engine's
    // `isBlockedByDateUnavailability` so the UI preview agrees with HC-3.
    const baseDate = schedule.periodStart;
    const scheduleDays = schedule.periodDays;
    const hBoundary = schedule.algorithmSettings.dayStartHour;
    const baseY = baseDate.getFullYear();
    const baseM = baseDate.getMonth();
    const baseD = baseDate.getDate();
    for (const rule of rules) {
      // Defensive guard — malformed rules must not corrupt the overlap preview.
      if (!Number.isInteger(rule.dayIndex)) continue;
      const startIdx = Math.max(1, rule.dayIndex);
      const endIdx = Math.min(scheduleDays, rule.endDayIndex ?? rule.dayIndex);
      if (endIdx < 1 || startIdx > scheduleDays || endIdx < startIdx) continue;

      let rStart: number;
      let rEnd: number;
      if (rule.allDay) {
        rStart = new Date(baseY, baseM, baseD + startIdx - 1, hBoundary, 0).getTime();
        rEnd = new Date(baseY, baseM, baseD + endIdx, hBoundary, 0).getTime();
      } else {
        rStart = hourInOpDay(baseDate, hBoundary, startIdx, rule.startHour);
        rEnd = hourInOpDay(baseDate, hBoundary, endIdx, rule.endHour);
        if (rEnd <= rStart) rEnd += 24 * 3600 * 1000;
      }

      const oStart = Math.max(rStart, wStart);
      const oEnd = Math.min(rEnd, wEnd);
      if (oStart < oEnd) {
        const dayLabel = startIdx === endIdx ? `יום ${startIdx}` : `יום ${startIdx}–יום ${endIdx}`;
        const timeLabel = rule.allDay
          ? 'כל היום'
          : `${String(rule.startHour).padStart(2, '0')}:00–${String(rule.endHour).padStart(2, '0')}:00`;
        const reasonTail = rule.reason ? ` · ${rule.reason}` : '';
        overlaps.push({
          kind: 'date-unavailability',
          label: `כלל קבוע: ${dayLabel} ${timeLabel}${reasonTail}`,
          start: new Date(oStart),
          end: new Date(oEnd),
        });
      }
    }
  }

  const fsos = schedule.scheduleUnavailability ?? [];
  for (const entry of fsos) {
    if (entry.participantId !== participant.id) continue;
    const oStart = Math.max(entry.start.getTime(), wStart);
    const oEnd = Math.min(entry.end.getTime(), wEnd);
    if (oStart < oEnd) {
      const reasonTail = entry.reason ? ` · ${entry.reason}` : '';
      overlaps.push({
        kind: 'schedule-unavailability',
        label: `חלון אי זמינות עתידית שכבר נרשם${reasonTail}`,
        start: new Date(oStart),
        end: new Date(oEnd),
      });
    }
  }

  return overlaps;
}

function formatOverlapRange(o: PreExistingUnavailabilityOverlap, schedule: Schedule): string {
  const base = schedule.periodStart;
  const dsh = schedule.algorithmSettings.dayStartHour;
  const toDayIndex = (d: Date): number => {
    const shifted = new Date(d.getTime());
    if (shifted.getHours() < dsh) shifted.setDate(shifted.getDate() - 1);
    shifted.setHours(0, 0, 0, 0);
    const baseMidnight = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    return Math.floor((shifted.getTime() - baseMidnight) / (24 * 3600 * 1000)) + 1;
  };
  const startDay = toDayIndex(o.start);
  const endDay = toDayIndex(o.end);
  if (startDay === endDay) return `יום ${startDay} ${fmt(o.start)}–${fmt(o.end)}`;
  return `יום ${startDay} ${fmt(o.start)} → יום ${endDay} ${fmt(o.end)}`;
}

async function handleProfileFutureSos(participantId: string, entryOpts: FutureSosEntryOpts = {}): Promise<void> {
  if (!currentSchedule || !engine) return;
  const schedule = currentSchedule;
  const participant = schedule.participants.find((p) => p.id === participantId);
  if (!participant) return;

  // Read from the frozen schedule, not the live store — the picker must match
  // the schedule the user is acting on, even if scheduleDays/scheduleDate were
  // edited in settings after generation.
  const numDays = schedule.periodDays;
  const baseDate = schedule.periodStart;
  const dayStartHour = schedule.algorithmSettings.dayStartHour;

  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    days.push({ value: String(d), label: `יום ${d}` });
  }
  const hours: Array<{ value: string; label: string }> = operationalHourOrder(dayStartHour).map((h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  }));

  // Operational-day interpretation: hours before dayStartHour belong to the
  // previous op-day's tail (e.g. day 7 + 04:00 → calendar day 8 04:00). Mirrors
  // resolveLogicalDayTimestamp so day-chip semantics are consistent across the UI.
  const toDate = (day: string, hour: string): Date => {
    const dIdx = parseInt(day, 10);
    const hr = parseInt(hour, 10);
    const dayOffset = hr < dayStartHour ? dIdx : dIdx - 1;
    return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, hr, 0);
  };

  // Anchor: live-mode timestamp if on, else a deferred candidate the user
  // can tweak in the range-picker banner. Live mode is only activated on
  // apply, so a cancel leaves the schedule untouched.
  const lm = store.getLiveModeState();
  let anchor: Date = lm.enabled ? lm.currentTimestamp : computeDefaultLiveAnchor(schedule);
  const liveModeInitiallyOn = lm.enabled;

  // Smart default: use next modifiable upcoming assignment if no override provided.
  const smartDefault = computeSmartDefaultWindow(schedule, participantId, anchor, dayStartHour);
  const initial: RangePickerDefaults = {
    startDay: entryOpts.defaultStartDay ?? smartDefault.startDay,
    startHour: entryOpts.defaultStartHour ?? smartDefault.startHour,
    endDay: entryOpts.defaultEndDay ?? smartDefault.endDay,
    endHour: entryOpts.defaultEndHour ?? smartDefault.endHour,
  };

  const anchorLabel = (a: Date) => {
    const shifted = new Date(a.getTime());
    if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
    const baseMidnight = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();
    const dIdx =
      Math.floor(
        (new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime() - baseMidnight) /
          (24 * 3600 * 1000),
      ) + 1;
    return `יום ${dIdx} ${fmt(a)}`;
  };

  const range = await showRangePicker({
    title: `אי זמינות עתידית — חלון · ${participant.name}`,
    days,
    hours,
    defaultStartDay: initial.startDay,
    defaultStartHour: initial.startHour,
    defaultEndDay: initial.endDay,
    defaultEndHour: initial.endHour,
    defaultReason: entryOpts.defaultReason,
    anchor: {
      currentLabel: anchorLabel(anchor),
      changeButtonLabel: 'שנה',
      onChange: async () => {
        const { defaultDay: defDay, defaultHour: defHour } = anchorToPickerDefaults(
          computeDefaultLiveAnchor(schedule),
          schedule,
        );
        const result = await showTimePicker('בחר את נקודת ההקפאה. שיבוצים לפני נקודה זו ייחשבו כעבר.', {
          title: 'נקודת הקפאה',
          days,
          hours,
          defaultDay: defDay,
          defaultHour: defHour,
        });
        if (!result) return null;
        const ts = toDate(result.day, result.hour);
        anchor = ts;
        // When live mode is already ON, persist the new anchor immediately so the
        // schedule's frozen/future split updates — matches the Live Mode panel
        // pattern. When OFF, persistence is deferred to the apply paths below.
        if (liveModeInitiallyOn) {
          store.setLiveModeTimestamp(ts);
          freezeAssignments(schedule, ts);
          requestAnimationFrame(() => renderAll());
        }
        return { label: anchorLabel(ts) };
      },
    },
    validate: (v) => {
      const s = toDate(v.startDay, v.startHour);
      const e = toDate(v.endDay, v.endHour);
      if (e.getTime() <= s.getTime()) return 'זמן הסיום חייב להיות אחרי זמן ההתחלה.';
      if (s.getTime() < anchor.getTime()) return 'ההתחלה חייבת להיות אחרי נקודת ההקפאה.';
      return null;
    },
    onPreview: (v) => {
      const s = toDate(v.startDay, v.startHour);
      const e = toDate(v.endDay, v.endHour);
      if (e.getTime() <= s.getTime() || s.getTime() < anchor.getTime()) return '';
      const { affected } = findAffectedAssignments(schedule, participantId, { start: s, end: e }, anchor);
      if (affected.length === 0) return 'אין שיבוצים בחלון זה.';
      const dayKeys = new Set(affected.map((a) => a.task.timeBlock.start.toDateString()));
      return `יעודכנו ${affected.length} שיבוצים ב־${dayKeys.size} ימים.`;
    },
  });
  if (!range) return;

  const windowStart = toDate(range.startDay, range.startHour);
  const windowEnd = toDate(range.endDay, range.endHour);
  const reason = range.reason;

  // Warn when the window overlaps an existing unavailability source
  // (participant availability gap, recurring date-unavailability rule, or a
  // prior Future-SOS entry). Recording is still allowed — overlapping
  // scheduleUnavailability entries are merged by upsertScheduleUnavailability.
  const preOverlaps = findPreExistingUnavailabilityOverlaps(participant, schedule, {
    start: windowStart,
    end: windowEnd,
  });
  if (preOverlaps.length > 0) {
    const lines = preOverlaps.map((o) => `• ${o.label}: ${formatOverlapRange(o, schedule)}`);
    const proceed = await showConfirm(
      `החלון שבחרת חופף לזמן שכבר סומן כלא־זמין עבור ${participant.name}:\n\n${lines.join('\n')}\n\nניתן להמשיך — חלון אי זמינות עתידית חדש יאוחד עם חלונות קיימים, וכללי אי־זמינות אחרים יישארו כפי שהם. להמשיך בכל זאת?`,
      { title: 'חפיפה עם אי־זמינות קיימת', confirmLabel: 'המשך', cancelLabel: 'ביטול' },
    );
    if (!proceed) return;
  }

  const { affected, lockedInPast } = findAffectedAssignments(
    schedule,
    participantId,
    { start: windowStart, end: windowEnd },
    anchor,
  );

  const config = engine.getEffectiveConfig();
  const scoreCtx = engine.buildScoreContext();
  if (!scoreCtx) return;

  // Confirm → plan loop. When no plan is HC-clean and complete, the
  // infeasibility modal can send the user back to the confirm step with the
  // unsolvable assignments pre-unchecked.
  let preExcluded: ReadonlySet<string> = new Set();
  let excludedIds: Set<string>;
  let result: ReturnType<typeof generateBatchRescuePlans>;
  // biome-ignore lint/correctness/noConstantCondition: loop exits via return / break
  while (true) {
    const confirmResult = await openConfirmModal({
      participantName: participant.name,
      window: { start: windowStart, end: windowEnd },
      affected,
      lockedInPast,
      dayStartHour,
      periodStart: schedule.periodStart,
      preExcludedIds: preExcluded,
    });
    if (!confirmResult.confirmed) return;

    excludedIds = new Set(confirmResult.excludedIds);
    const effectiveAffected = affected.filter((a) => !excludedIds.has(a.assignment.id));

    // If nothing to rescue (either no overlap or user opted out of everything),
    // just record the unavailability entry and return. Activate live mode now
    // so the anchor is persisted with the entry.
    if (effectiveAffected.length === 0) {
      if (!liveModeInitiallyOn) activateLiveModeWithAnchor(anchor);
      // Punch holes around any kept in-window assignments — those remain "available"
      // so HC-3 doesn't fire on them. If the user opted out of literally everything
      // and the kept tasks cover the whole window, effective is [] and no entry is
      // persisted (the window is effectively a no-op, matching opt-out intent).
      // Punch holes around BOTH user-kept (opt-out) and lockedInPast (in-progress/
      // frozen) in-window assignments, so the persisted window matches what the
      // planner validated and revalidateFull doesn't re-fire HC-3 on a shift the
      // focal is intrinsically committed to. Mirrors the FSOS planner's keptTaskBlocks.
      const keptBlocks = [...affected.filter((a) => excludedIds.has(a.assignment.id)), ...lockedInPast].map(
        (a) => a.task.timeBlock,
      );
      const effectiveWindows = computeEffectiveUnavailabilityWindows(
        { start: windowStart, end: windowEnd },
        keptBlocks,
      );
      let updated = currentSchedule.scheduleUnavailability;
      const baseId = `fsos-${Date.now()}`;
      for (let i = 0; i < effectiveWindows.length; i++) {
        const w = effectiveWindows[i];
        updated = upsertScheduleUnavailability(updated, {
          id: effectiveWindows.length === 1 ? baseId : `${baseId}-${i}`,
          participantId,
          start: w.start,
          end: w.end,
          reason,
          createdAt: new Date(),
          anchorAtCreation: anchor,
          appliedSwapCount: 0,
        });
      }
      currentSchedule.scheduleUnavailability = updated;
      store.saveSchedule(currentSchedule);
      renderAll();
      showToast('חלון אי־זמינות נרשם (אין שיבוצים להחלפה).', { type: 'info', duration: 4000 });
      return;
    }

    await openLoadingOverlay();
    try {
      result = generateBatchRescuePlans(
        currentSchedule,
        { participantId, window: { start: windowStart, end: windowEnd } },
        anchor,
        {
          config,
          scoreCtx,
          disabledHC: engine.getDisabledHC(),
          restRuleMap: engine.getRestRuleMap(),
          certLabelResolver: engine.getCertLabelResolver(),
          maxPlans: 3,
          excludedAssignmentIds: excludedIds,
          scheduleContext: engine.getScheduleContext(),
        },
      );
    } finally {
      closeLoadingOverlay();
    }

    const hasApplicablePlan = result.plans.some((p) => p.violations.length === 0 && !p.isPartial);
    if (hasApplicablePlan) break;

    const infeasibleSet = new Set(result.infeasibleAssignmentIds);
    const unsolvable = result.affected.filter((a) => infeasibleSet.has(a.assignment.id));
    const decision = await openInfeasibleModal({
      participantName: participant.name,
      affected: result.affected,
      unsolvable,
      timedOut: result.timedOut,
      dayStartHour,
      periodStart: schedule.periodStart,
    });
    if (decision === 'cancel') return;
    if (decision === 'narrow-window') {
      const narrowed = suggestNarrowerWindow(result.affected, range, schedule.periodStart, dayStartHour);
      void handleProfileFutureSos(participantId, {
        defaultStartDay: narrowed.startDay,
        defaultStartHour: narrowed.startHour,
        defaultEndDay: narrowed.endDay,
        defaultEndHour: narrowed.endHour,
        defaultReason: reason,
      });
      return;
    }
    // 'remove-and-retry': pre-uncheck unsolvables (additive to current
    // exclusions) and loop back to the confirm modal so the user can adjust.
    preExcluded = new Set([...excludedIds, ...result.infeasibleAssignmentIds]);
  }

  openBatchPlansModal({
    result,
    schedule: currentSchedule,
    participantName: participant.name,
    onNarrowWindow: () => {
      // Re-enter the flow with a window tightened to the affected slots' span
      // (never re-pin the identical failed window). Provably covers all affected
      // slots; the picker stays editable so the user can shave further.
      const narrowed = suggestNarrowerWindow(result.affected, range, schedule.periodStart, dayStartHour);
      void handleProfileFutureSos(participantId, {
        defaultStartDay: narrowed.startDay,
        defaultStartHour: narrowed.startHour,
        defaultEndDay: narrowed.endDay,
        defaultEndHour: narrowed.endHour,
        defaultReason: reason,
      });
    },
    onApply: (plan) => {
      if (!currentSchedule || !engine) return;

      if (!liveModeInitiallyOn) activateLiveModeWithAnchor(anchor);

      // Capture the reverse swap map BEFORE mutating, to support undo.
      const reverseSwaps = plan.swaps.map((sw) => {
        const assn = currentSchedule?.assignments.find((a) => a.id === sw.assignmentId);
        return {
          assignmentId: sw.assignmentId,
          prevParticipantId: assn?.participantId ?? sw.fromParticipantId ?? '',
        };
      });

      const prevUnavailability = currentSchedule.scheduleUnavailability;
      const fsosEntryId = `fsos-${Date.now()}`;
      // Punch holes around kept (excluded) in-window assignments so the persisted
      // entry matches the planner's effective windows — otherwise downstream
      // revalidation fires HC-3 on assignments the user chose to keep.
      // Punch holes around BOTH user-kept (opt-out) and lockedInPast (in-progress/
      // frozen) in-window assignments, so the persisted window matches what the
      // planner validated and revalidateFull doesn't re-fire HC-3 on a shift the
      // focal is intrinsically committed to. Mirrors the FSOS planner's keptTaskBlocks.
      const keptBlocks = [...affected.filter((a) => excludedIds.has(a.assignment.id)), ...lockedInPast].map(
        (a) => a.task.timeBlock,
      );
      const effectiveWindows = computeEffectiveUnavailabilityWindows(
        { start: windowStart, end: windowEnd },
        keptBlocks,
      );
      let nextUnavail = prevUnavailability;
      for (let i = 0; i < effectiveWindows.length; i++) {
        const w = effectiveWindows[i];
        nextUnavail = upsertScheduleUnavailability(nextUnavail, {
          id: effectiveWindows.length === 1 ? fsosEntryId : `${fsosEntryId}-${i}`,
          participantId,
          start: w.start,
          end: w.end,
          reason,
          createdAt: new Date(),
          anchorAtCreation: anchor,
          appliedSwapCount: plan.swaps.length,
        });
      }
      currentSchedule.scheduleUnavailability = nextUnavail;

      const requests = plan.swaps.map((sw) => ({
        assignmentId: sw.assignmentId,
        newParticipantId: sw.toParticipantId,
      }));
      const hasSplitOps = (plan.splitOps?.length ?? 0) > 0;
      // For split plans the apply mutates tasks + assignments structurally;
      // reverseSwaps alone can't undo task-set changes. Capture a full clone
      // BEFORE applyPlanOps for use by undoFutureSos.
      const preApplySnapshot = hasSplitOps ? structuredClone(currentSchedule) : undefined;
      // The clone is taken AFTER scheduleUnavailability was set to nextUnavail
      // above, so it embeds the NEW window. Undo must restore the PRE-FSOS window
      // — overwrite the snapshot's copy so importSchedule on undo brings it back.
      if (preApplySnapshot) preApplySnapshot.scheduleUnavailability = prevUnavailability;
      const applyResult = hasSplitOps
        ? engine.applyPlanOps({ swaps: requests, splitOps: plan.splitOps })
        : engine.swapParticipantChain(requests);
      if (!applyResult.valid) {
        currentSchedule.scheduleUnavailability = prevUnavailability;
        showToast('החלת התוכנית נכשלה — בוצע שחזור למצב הקודם.', { type: 'error', duration: 5000 });
        return;
      }

      const updated = engine.getSchedule()!;
      currentSchedule = updated;
      store.saveSchedule(updated);
      renderAll();
      showFutureSosAppliedStrip(participantId, plan.swaps.length + (plan.splitOps?.length ?? 0), {
        reverseSwaps,
        prevUnavailability,
        fsosEntryId,
        preApplySnapshot,
      });
    },
  });
}

interface RangePickerDefaults {
  startDay: string;
  startHour: string;
  endDay: string;
  endHour: string;
}

function computeSmartDefaultWindow(
  schedule: Schedule,
  participantId: string,
  anchor: Date,
  dayStartHour: number,
): RangePickerDefaults {
  // Anchor on the frozen schedule's periodStart, not the live store — the
  // computed default day-chip must match the day axis the FSOS picker shows.
  const baseDate = schedule.periodStart;
  // Return the op-day index of a timestamp: early-morning hours (< dayStartHour)
  // belong to the prior op-day's tail, so the day-chip offered to the user
  // matches the operational grouping used in the schedule view.
  const opDayIndexOf = (d: Date): number => {
    const ms = d.getTime() - new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate()).getTime();
    const calendarIdx = Math.floor(ms / 86400000) + 1;
    return d.getHours() < dayStartHour ? calendarIdx - 1 : calendarIdx;
  };

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const upcoming = schedule.assignments
    .filter((a) => a.participantId === participantId)
    .map((a) => ({ a, task: taskMap.get(a.taskId) }))
    .filter((x): x is { a: Assignment; task: Task } => !!x.task && x.task.timeBlock.start.getTime() >= anchor.getTime())
    .sort((x, y) => x.task.timeBlock.start.getTime() - y.task.timeBlock.start.getTime());

  if (upcoming.length > 0) {
    const { task } = upcoming[0];
    return {
      startDay: String(Math.max(1, opDayIndexOf(task.timeBlock.start))),
      startHour: String(task.timeBlock.start.getHours()),
      endDay: String(Math.max(1, opDayIndexOf(task.timeBlock.end))),
      endHour: String(task.timeBlock.end.getHours()),
    };
  }
  return {
    startDay: '1',
    startHour: String(dayStartHour),
    endDay: '1',
    endHour: String((dayStartHour + 1) % 24),
  };
}

/**
 * Suggest a tighter window for the "narrow window" re-entry instead of
 * re-pinning the identical window that just failed. Tightens to the op-day span
 * of the affected assignments, reusing the exact op-day→picker mapping that
 * `computeSmartDefaultWindow` uses.
 *
 * Coverage guarantee: the suggested window FULLY COVERS every affected task —
 * the start floors to its whole hour and the end ceils to the next whole hour,
 * so a fragment ending at a non-whole-hour (e.g. a split half at :30) is still
 * inside the window rather than silently dropped by the hour-granular picker.
 *
 * It is NOT guaranteed to be strictly narrower than the failed window:
 * `findAffectedAssignments` classifies by overlap (not containment), so an
 * affected task straddling a window boundary may push the suggested edge
 * slightly past the original on that side (affected tasks must be rescued in
 * full). The picker stays editable; per-slot opt-out (remove-and-retry) remains
 * the precise tool for excising a mid-window bottleneck.
 */
function suggestNarrowerWindow(
  affected: AffectedAssignment[],
  fallback: RangePickerDefaults,
  periodStart: Date,
  dayStartHour: number,
): RangePickerDefaults {
  if (affected.length === 0) return fallback;
  const opDayIndexOf = (d: Date): number => {
    const ms =
      d.getTime() - new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()).getTime();
    const calendarIdx = Math.floor(ms / 86400000) + 1;
    return d.getHours() < dayStartHour ? calendarIdx - 1 : calendarIdx;
  };
  let minStart = affected[0].task.timeBlock.start;
  let maxEnd = affected[0].task.timeBlock.end;
  for (const a of affected) {
    if (a.task.timeBlock.start < minStart) minStart = a.task.timeBlock.start;
    if (a.task.timeBlock.end > maxEnd) maxEnd = a.task.timeBlock.end;
  }
  // Ceil the end to the next whole hour when it carries sub-hour minutes (split
  // halves can end at e.g. :30). The picker is hour-granular, so without this the
  // reconstructed window would end one hour short and silently drop that fragment.
  // Deriving endDay/endHour from the ceiled timestamp also rolls the op-day
  // correctly when ceiling crosses the day-start boundary.
  const maxEndCeil = new Date(maxEnd);
  if (maxEndCeil.getMinutes() !== 0 || maxEndCeil.getSeconds() !== 0 || maxEndCeil.getMilliseconds() !== 0) {
    maxEndCeil.setMinutes(0, 0, 0);
    maxEndCeil.setHours(maxEndCeil.getHours() + 1);
  }
  return {
    startDay: String(Math.max(1, opDayIndexOf(minStart))),
    startHour: String(minStart.getHours()),
    endDay: String(Math.max(1, opDayIndexOf(maxEndCeil))),
    endHour: String(maxEndCeil.getHours()),
  };
}

function activateLiveModeWithAnchor(anchor: Date): void {
  if (!currentSchedule) return;
  store.setLiveModeEnabled(true);
  store.setLiveModeTimestamp(anchor);
  freezeAssignments(currentSchedule, anchor);
}

interface UndoContext {
  reverseSwaps: Array<{ assignmentId: string; prevParticipantId: string }>;
  prevUnavailability: Schedule['scheduleUnavailability'];
  fsosEntryId: string;
  /**
   * Full pre-apply schedule clone — present only when the FSOS plan included
   * `splitOps`. Pure swap chains use the existing `reverseSwaps` path; split
   * plans need a full restoration because the task set and assignment set
   * both change (halves added, originals removed). Undo restores tasks +
   * assignments by reference-swap from this snapshot.
   */
  preApplySnapshot?: Schedule;
}

function showFutureSosAppliedStrip(participantId: string, swapCount: number, undoCtx: UndoContext): void {
  const strip = document.createElement('div');
  strip.className = 'fsos-applied-strip';
  const participant = currentSchedule?.participants.find((p) => p.id === participantId);
  const name = participant?.name ?? '';
  strip.innerHTML = `<span class="fsos-applied-strip-icon">✅</span>
    <span class="fsos-applied-strip-text">הוחלה תוכנית עם <strong>${swapCount}</strong> החלפות. ${escHtml(name)} סומן כלא־זמין.</span>
    <button class="fsos-applied-strip-undo">בטל</button>
    <button class="fsos-applied-strip-close" aria-label="סגור">✕</button>`;

  document.body.appendChild(strip);
  const remove = () => {
    strip.classList.add('fsos-applied-strip--leaving');
    setTimeout(() => strip.remove(), 250);
  };
  const timer = window.setTimeout(remove, 30000);
  strip.querySelector('.fsos-applied-strip-close')?.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });
  strip.querySelector('.fsos-applied-strip-undo')?.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
    undoFutureSos(undoCtx);
  });
}

function undoFutureSos(undoCtx: UndoContext): void {
  if (!currentSchedule || !engine) return;

  // Split-plan undo: the apply mutated tasks + assignments structurally,
  // so plain reverseSwaps can't restore the state. Re-import the captured
  // pre-apply snapshot wholesale; it carries the original tasks, assignments,
  // and `scheduleUnavailability` together.
  if (undoCtx.preApplySnapshot) {
    engine.importSchedule(undoCtx.preApplySnapshot);
    engine.addParticipants(undoCtx.preApplySnapshot.participants);
    engine.revalidateFull();
    currentSchedule = engine.getSchedule()!;
    store.saveSchedule(currentSchedule);
    renderAll();
    showToast('התוכנית בוטלה. השיבוצים וחלון אי־הזמינות שוחזרו.', { type: 'info', duration: 4000 });
    return;
  }

  // Pure swap-chain undo (no splitOps): the in-place participantId mutations
  // are reversible via `swapParticipantChain` with the reverse request set.
  // Restore the exact pre-FSOS window first so HC-3 doesn't block the reverse
  // swap. We assign prevUnavailability wholesale rather than filtering by
  // fsosEntryId: a hole-punched window persists suffixed `${id}-${i}` entries the
  // bare-id filter can't match, and upsert may have merged-away a pre-existing
  // overlapping entry an id-filter could never bring back.
  currentSchedule.scheduleUnavailability = undoCtx.prevUnavailability;

  const requests = undoCtx.reverseSwaps.map((s) => ({
    assignmentId: s.assignmentId,
    newParticipantId: s.prevParticipantId,
  }));
  const res = engine.swapParticipantChain(requests);
  if (!res.valid) {
    // Restore the FSOS entry on failure.
    currentSchedule.scheduleUnavailability = undoCtx.prevUnavailability;
    showToast('ביטול התוכנית נכשל — המצב נשמר כפי שהיה.', { type: 'error', duration: 5000 });
    return;
  }
  const updated = engine.getSchedule()!;
  currentSchedule = updated;
  store.saveSchedule(updated);
  renderAll();
  showToast('התוכנית בוטלה. השיבוצים וחלון אי־הזמינות שוחזרו.', { type: 'info', duration: 4000 });
}

function handleRemoveFutureSosEntry(entryId: string): void {
  if (!currentSchedule) return;
  const before = currentSchedule.scheduleUnavailability ?? [];
  const after = before.filter((e) => e.id !== entryId);
  if (after.length === before.length) return;
  // scheduleUnavailability is schedule-scoped state; mutating it does NOT
  // diverge from master-data, so _scheduleDirty must remain unchanged.
  currentSchedule.scheduleUnavailability = after;
  store.saveSchedule(currentSchedule);
  renderAll();
  showToast('חלון אי זמינות עתידית הוסר.', { type: 'info', duration: 3000 });
}

interface CapabilityChangeUndoContext {
  reverseSwaps: Array<{ assignmentId: string; prevParticipantId: string }>;
  prevCapabilityLoss: Schedule['capabilityLoss'];
  capLossEntryId: string;
  /**
   * Full pre-apply schedule clone — present only when the cap-change plan
   * included `splitOps`. Same rationale as `UndoContext.preApplySnapshot`:
   * task-set mutations are not reversible via reverseSwaps alone.
   */
  preApplySnapshot?: Schedule;
}

async function handleProfileCapabilityChange(participantId: string): Promise<void> {
  if (!currentSchedule || !engine) return;
  const schedule = currentSchedule;
  const participant = schedule.participants.find((p) => p.id === participantId);
  if (!participant) return;
  if (participant.certifications.length === 0) {
    showToast('למשתתף זה אין הסמכות במאגר השבצ"ק הנוכחי.', { type: 'info', duration: 3000 });
    return;
  }

  // Read from the frozen schedule, not the live store — see handleProfileFutureSos.
  const numDays = schedule.periodDays;
  const baseDate = schedule.periodStart;
  const dayStartHour = schedule.algorithmSettings.dayStartHour;

  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    days.push({ value: String(d), label: `יום ${d}` });
  }
  const hours: Array<{ value: string; label: string }> = operationalHourOrder(dayStartHour).map((h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  }));

  const toDate = (day: string, hour: string): Date => {
    const dIdx = parseInt(day, 10);
    const hr = parseInt(hour, 10);
    const dayOffset = hr < dayStartHour ? dIdx : dIdx - 1;
    return new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, hr, 0);
  };

  const lm = store.getLiveModeState();
  const liveModeInitiallyOn = lm.enabled;
  const anchor: Date = lm.enabled ? lm.currentTimestamp : computeDefaultLiveAnchor(schedule);

  const certResolver = engine.getCertLabelResolver();
  const availableCerts = participant.certifications.map((id) => ({
    value: id,
    label: certResolver(id),
  }));

  // Anchor the default window on the participant's next upcoming assignment so
  // the picker doesn't open with a window straddling the live anchor (which
  // would always fail the `start >= anchor` validator). Falls back to a 1-hour
  // post-anchor window when the participant has no future assignments.
  const smartDefault = computeSmartDefaultWindow(schedule, participantId, anchor, dayStartHour);

  const picker = await showCapabilityChangePicker({
    participantName: participant.name,
    availableCerts,
    days,
    hours,
    defaultStartDay: smartDefault.startDay,
    defaultStartHour: smartDefault.startHour,
    defaultEndDay: smartDefault.endDay,
    defaultEndHour: smartDefault.endHour,
    validate: (v) => {
      const s = toDate(v.startDay, v.startHour);
      const e = toDate(v.endDay, v.endHour);
      if (e.getTime() <= s.getTime()) return 'זמן הסיום חייב להיות אחרי זמן ההתחלה.';
      if (s.getTime() < anchor.getTime()) return 'ההתחלה חייבת להיות אחרי נקודת ההקפאה.';
      return null;
    },
    onPreview: (v) => {
      if (v.lostCertifications.length === 0) return '';
      const s = toDate(v.startDay, v.startHour);
      const e = toDate(v.endDay, v.endHour);
      if (e.getTime() <= s.getTime() || s.getTime() < anchor.getTime()) return '';
      const { affected } = findCertAffectedAssignments(
        schedule,
        {
          participantId,
          lostCertifications: v.lostCertifications,
          window: { start: s, end: e },
        },
        anchor,
      );
      if (affected.length === 0) return 'אין שיבוצים מושפעים מאובדן ההסמכה.';
      const dayKeys = new Set(affected.map((a) => a.task.timeBlock.start.toDateString()));
      return `יעודכנו ${affected.length} שיבוצים ב־${dayKeys.size} ימים.`;
    },
  });
  if (!picker) return;

  const windowStart = toDate(picker.startDay, picker.startHour);
  const windowEnd = toDate(picker.endDay, picker.endHour);
  const reason = picker.reason;
  const lostCertifications = picker.lostCertifications;

  const { affected, lockedInPast } = findCertAffectedAssignments(
    schedule,
    { participantId, lostCertifications, window: { start: windowStart, end: windowEnd } },
    anchor,
  );

  const certsLabel = lostCertifications.map(certResolver).join(', ');

  const config = engine.getEffectiveConfig();
  const scoreCtx = engine.buildScoreContext();
  if (!scoreCtx) return;

  let preExcluded: ReadonlySet<string> = new Set();
  let excludedIds: Set<string>;
  let result: ReturnType<typeof generateCapabilityChangePlans>;
  // biome-ignore lint/correctness/noConstantCondition: loop exits via return / break
  while (true) {
    const confirmResult = await openConfirmModal({
      participantName: participant.name,
      window: { start: windowStart, end: windowEnd },
      affected,
      lockedInPast,
      dayStartHour,
      periodStart: schedule.periodStart,
      preExcludedIds: preExcluded,
      headerIcon: '📜',
      headerTitlePrefix: 'שינוי הסמכה — השפעה',
      affectedSectionTitle: 'שיבוצים שדורשים את ההסמכה שאבדה',
      preambleHtml: `<div class="fsos-window-sentence">הסמכות שאבדו: <strong>${escHtml(certsLabel)}</strong></div>`,
    });
    if (!confirmResult.confirmed) return;

    excludedIds = new Set(confirmResult.excludedIds);
    const effectiveAffected = affected.filter((a) => !excludedIds.has(a.assignment.id));

    if (effectiveAffected.length === 0) {
      // Nothing to rescue — record the capability-loss entry and return.
      if (!liveModeInitiallyOn) activateLiveModeWithAnchor(anchor);
      const baseId = `capch-${Date.now()}`;
      currentSchedule.capabilityLoss = upsertCapabilityLoss(currentSchedule.capabilityLoss, {
        id: baseId,
        participantId,
        lostCertifications,
        start: windowStart,
        end: windowEnd,
        reason,
        createdAt: new Date(),
        anchorAtCreation: anchor,
        appliedSwapCount: 0,
      });
      store.saveSchedule(currentSchedule);
      engine.revalidateFull();
      const refreshed = engine.getSchedule();
      if (refreshed) {
        currentSchedule = refreshed;
        store.saveSchedule(currentSchedule);
      }
      renderAll();
      showToast('שינוי הסמכה נרשם (אין שיבוצים להחלפה).', { type: 'info', duration: 4000 });
      return;
    }

    await openLoadingOverlay();
    try {
      result = generateCapabilityChangePlans(
        currentSchedule,
        { participantId, lostCertifications, window: { start: windowStart, end: windowEnd }, reason },
        anchor,
        {
          config,
          scoreCtx,
          disabledHC: engine.getDisabledHC(),
          restRuleMap: engine.getRestRuleMap(),
          certLabelResolver: engine.getCertLabelResolver(),
          maxPlans: 3,
          excludedAssignmentIds: excludedIds,
          scheduleContext: engine.getScheduleContext(),
        },
      );
    } finally {
      closeLoadingOverlay();
    }

    const hasApplicablePlan = result.plans.some((p) => p.violations.length === 0 && !p.isPartial);
    if (hasApplicablePlan) break;

    const infeasibleSet = new Set(result.infeasibleAssignmentIds);
    const unsolvable = result.affected.filter((a) => infeasibleSet.has(a.assignment.id));
    const decision = await openInfeasibleModal({
      participantName: participant.name,
      affected: result.affected,
      unsolvable,
      timedOut: result.timedOut,
      dayStartHour,
      periodStart: schedule.periodStart,
      headerIcon: '⚠️',
      headerTitlePrefix: 'לא נמצאה תוכנית להחלפת הסמכה',
    });
    if (decision === 'cancel') return;
    if (decision === 'narrow-window') {
      void handleProfileCapabilityChange(participantId);
      return;
    }
    preExcluded = new Set([...excludedIds, ...result.infeasibleAssignmentIds]);
  }

  openBatchPlansModal({
    result,
    schedule: currentSchedule,
    participantName: participant.name,
    headerIcon: '📜',
    headerTitlePrefix: 'שינוי הסמכה — תוכניות',
    onNarrowWindow: () => {
      void handleProfileCapabilityChange(participantId);
    },
    onApply: (plan) => {
      if (!currentSchedule || !engine) return;
      if (!liveModeInitiallyOn) activateLiveModeWithAnchor(anchor);

      const reverseSwaps = plan.swaps.map((sw) => {
        const assn = currentSchedule?.assignments.find((a) => a.id === sw.assignmentId);
        return {
          assignmentId: sw.assignmentId,
          prevParticipantId: assn?.participantId ?? sw.fromParticipantId ?? '',
        };
      });

      const prevCapabilityLoss = currentSchedule.capabilityLoss;
      const capLossEntryId = `capch-${Date.now()}`;
      currentSchedule.capabilityLoss = upsertCapabilityLoss(prevCapabilityLoss, {
        id: capLossEntryId,
        participantId,
        lostCertifications,
        start: windowStart,
        end: windowEnd,
        reason,
        createdAt: new Date(),
        anchorAtCreation: anchor,
        appliedSwapCount: plan.swaps.length,
      });

      const requests = plan.swaps.map((sw) => ({
        assignmentId: sw.assignmentId,
        newParticipantId: sw.toParticipantId,
      }));
      const hasSplitOps = (plan.splitOps?.length ?? 0) > 0;
      // Capture full pre-apply snapshot for split plans (see undoCapabilityChange).
      const preApplySnapshot = hasSplitOps ? structuredClone(currentSchedule) : undefined;
      // The clone is taken AFTER capabilityLoss was set to the new entry above, so
      // it embeds the NEW loss. Undo must restore the PRE-change capabilityLoss —
      // overwrite the snapshot's copy so importSchedule on undo brings it back.
      if (preApplySnapshot) preApplySnapshot.capabilityLoss = prevCapabilityLoss;
      const applyResult = hasSplitOps
        ? engine.applyPlanOps({ swaps: requests, splitOps: plan.splitOps })
        : engine.swapParticipantChain(requests);
      if (!applyResult.valid) {
        currentSchedule.capabilityLoss = prevCapabilityLoss;
        showToast('החלת התוכנית נכשלה — בוצע שחזור למצב הקודם.', { type: 'error', duration: 5000 });
        return;
      }

      const updated = engine.getSchedule()!;
      currentSchedule = updated;
      store.saveSchedule(updated);
      renderAll();
      showCapabilityChangeAppliedStrip(participantId, plan.swaps.length + (plan.splitOps?.length ?? 0), {
        reverseSwaps,
        prevCapabilityLoss,
        capLossEntryId,
        preApplySnapshot,
      });
    },
  });
}

function showCapabilityChangeAppliedStrip(
  participantId: string,
  swapCount: number,
  undoCtx: CapabilityChangeUndoContext,
): void {
  const strip = document.createElement('div');
  strip.className = 'fsos-applied-strip';
  const participant = currentSchedule?.participants.find((p) => p.id === participantId);
  const name = participant?.name ?? '';
  strip.innerHTML = `<span class="fsos-applied-strip-icon">✅</span>
    <span class="fsos-applied-strip-text">הוחלה תוכנית עם <strong>${swapCount}</strong> החלפות. שינוי הסמכה ל־${escHtml(name)} נרשם.</span>
    <button class="fsos-applied-strip-undo">בטל</button>
    <button class="fsos-applied-strip-close" aria-label="סגור">✕</button>`;
  document.body.appendChild(strip);
  const remove = () => {
    strip.classList.add('fsos-applied-strip--leaving');
    setTimeout(() => strip.remove(), 250);
  };
  const timer = window.setTimeout(remove, 30000);
  strip.querySelector('.fsos-applied-strip-close')?.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
  });
  strip.querySelector('.fsos-applied-strip-undo')?.addEventListener('click', () => {
    window.clearTimeout(timer);
    remove();
    undoCapabilityChange(undoCtx);
  });
}

function undoCapabilityChange(undoCtx: CapabilityChangeUndoContext): void {
  if (!currentSchedule || !engine) return;

  // Split-plan undo: re-import the captured pre-apply snapshot wholesale.
  // The reverseSwaps mechanism alone can't roll back task-set mutations.
  if (undoCtx.preApplySnapshot) {
    engine.importSchedule(undoCtx.preApplySnapshot);
    engine.addParticipants(undoCtx.preApplySnapshot.participants);
    engine.revalidateFull();
    currentSchedule = engine.getSchedule()!;
    store.saveSchedule(currentSchedule);
    renderAll();
    showToast('התוכנית בוטלה. השיבוצים ושינוי ההסמכה שוחזרו.', { type: 'info', duration: 4000 });
    return;
  }

  // Restore the exact pre-change capabilityLoss wholesale (not an id-filter):
  // upsertCapabilityLoss may have merged-away a pre-existing overlapping entry
  // that a bare-id filter could never bring back. Symmetric with the apply-
  // failure path below and with the FSOS pure-swap undo.
  currentSchedule.capabilityLoss = undoCtx.prevCapabilityLoss;
  const requests = undoCtx.reverseSwaps.map((s) => ({
    assignmentId: s.assignmentId,
    newParticipantId: s.prevParticipantId,
  }));
  const res = engine.swapParticipantChain(requests);
  if (!res.valid) {
    currentSchedule.capabilityLoss = undoCtx.prevCapabilityLoss;
    showToast('ביטול התוכנית נכשל — המצב נשמר כפי שהיה.', { type: 'error', duration: 5000 });
    return;
  }
  const updated = engine.getSchedule()!;
  currentSchedule = updated;
  store.saveSchedule(updated);
  renderAll();
  showToast('התוכנית בוטלה. השיבוצים ושינוי ההסמכה שוחזרו.', { type: 'info', duration: 4000 });
}

function handleRemoveCapabilityLossEntry(entryId: string): void {
  if (!currentSchedule) return;
  const before = currentSchedule.capabilityLoss ?? [];
  const after = before.filter((e) => e.id !== entryId);
  if (after.length === before.length) return;
  // capabilityLoss is schedule-scoped; mutating it does NOT diverge from
  // master-data, so _scheduleDirty must remain unchanged.
  currentSchedule.capabilityLoss = after;
  if (engine) engine.revalidateFull();
  const refreshed = engine?.getSchedule();
  if (refreshed) currentSchedule = refreshed;
  store.saveSchedule(currentSchedule);
  renderAll();
  showToast('שינוי הסמכה הוסר.', { type: 'info', duration: 3000 });
}

// ─── Main Render ─────────────────────────────────────────────────────────────

/**
 * Scroll the schedule grid to the row closest to the current live-mode timestamp.
 * Highlights the target row briefly with an animation.
 */
function scrollToNow(storeRef: typeof store, scroll = true): void {
  const liveState = storeRef.getLiveModeState();
  if (!liveState.enabled) return;

  const target = liveState.currentTimestamp.getTime();
  const container = document.querySelector('.schedule-grid-container');
  if (!container) return;

  const rows = container.querySelectorAll<HTMLTableRowElement>('tr[data-time]');
  if (rows.length === 0) return;

  // Remove previous now-row highlights
  container.querySelectorAll('.now-row, .now-row-animate').forEach((el) => {
    el.classList.remove('now-row', 'now-row-animate');
  });

  // Find the row with the largest data-time <= target (current or most recent shift)
  let bestRow: HTMLTableRowElement | null = null;
  let bestTime = -Infinity;

  rows.forEach((row) => {
    const t = Number(row.dataset.time);
    if (t <= target && t > bestTime) {
      bestTime = t;
      bestRow = row;
    }
  });

  // If no row <= target, pick the first row (earliest time)
  if (!bestRow) bestRow = rows[0];

  // Highlight all rows with the same time across all tables
  container.querySelectorAll<HTMLTableRowElement>(`tr[data-time="${bestRow.dataset.time}"]`).forEach((r) => {
    r.classList.add('now-row', 'now-row-animate');
  });

  // Scroll the first matching row into view (only on initial live-mode activation)
  if (scroll) {
    bestRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderAll(): void {
  const app = document.getElementById('app')!;

  // Always hide tooltips on re-render to avoid stale state
  hideTooltip();
  hideTaskTooltip();

  // ── Profile View: completely different layout, no re-optimization ──
  if (_viewMode === 'PROFILE_VIEW' && _profileParticipantId && currentSchedule) {
    const p = currentSchedule.participants.find((pp) => pp.id === _profileParticipantId);
    if (!p) {
      _viewMode = 'SCHEDULE_VIEW';
      _profileParticipantId = null; /* fall through */
    } else {
      const lmProfile = store.getLiveModeState();
      const frozenIds = new Set<string>();
      if (lmProfile.enabled) {
        const tMap = new Map(currentSchedule.tasks.map((t) => [t.id, t]));
        for (const a of currentSchedule.assignments) {
          const t = tMap.get(a.taskId);
          if (t && !isFutureTask(t, lmProfile.currentTimestamp)) frozenIds.add(a.id);
        }
      }

      const ctx: ProfileContext = {
        participant: p,
        schedule: currentSchedule,
        frozenAssignmentIds: frozenIds,
        showSosButtons: true,
      };

      app.innerHTML = `<div class="profile-view-root">${renderProfileView(ctx)}</div>`;
      const root = app.querySelector('.profile-view-root') as HTMLElement;
      wireProfileEvents(root, {
        onBackToSchedule: () => {
          // Back to schedule: restore scroll position
          _viewMode = 'SCHEDULE_VIEW';
          _profileParticipantId = null;
          _restoreScheduleScroll = true;
          renderAll();
        },
        onSosClick: handleSosRescue,
        onFutureSosClick: handleProfileFutureSos,
        onRemoveFutureSosEntry: handleRemoveFutureSosEntry,
        onCapabilityChangeClick: handleProfileCapabilityChange,
        onRemoveCapabilityLossEntry: handleRemoveCapabilityLossEntry,
      });
      // Wire task tooltip in profile view too
      wireTaskTooltip(root, () => currentSchedule);
      return;
    }
  }

  // ── Task Panel View: per-task weekly dashboard ──
  if (_viewMode === 'TASK_PANEL_VIEW' && _taskPanelSourceName && currentSchedule) {
    const lmPanel = store.getLiveModeState();
    const frozenIds = new Set<string>();
    if (lmPanel.enabled) {
      const tMap = new Map(currentSchedule.tasks.map((t) => [t.id, t]));
      for (const a of currentSchedule.assignments) {
        const t = tMap.get(a.taskId);
        if (t && !isFutureTask(t, lmPanel.currentTimestamp)) frozenIds.add(a.id);
      }
    }

    const panelCtx: TaskPanelContext = {
      sourceName: _taskPanelSourceName,
      schedule: currentSchedule,
      // Read from the frozen schedule so the week timeline lanes match the
      // schedule the user is viewing, not whatever the live store now holds.
      numDays: currentSchedule.periodDays,
      baseDate: currentSchedule.periodStart,
      frozenAssignmentIds: frozenIds,
      showSosButtons: true,
      isSmallScreen,
    };
    const rendered = renderTaskPanel(panelCtx);
    if (rendered === TASK_PANEL_EMPTY) {
      // Source name no longer resolves — drop back to schedule.
      _viewMode = 'SCHEDULE_VIEW';
      _taskPanelSourceName = null;
      _restoreScheduleScroll = true;
      // Fall through to normal render
    } else {
      app.innerHTML = `<div class="task-panel-view-root">${rendered}</div>`;
      const root = app.querySelector('.task-panel-view-root') as HTMLElement;
      wireTaskPanelEvents(
        root,
        () => {
          _viewMode = 'SCHEDULE_VIEW';
          _taskPanelSourceName = null;
          _restoreScheduleScroll = true;
          renderAll();
        },
        handleSwap,
        openRescueModal,
      );
      wireParticipantTooltip(root, () => currentSchedule);
      wireTaskTooltip(root, () => currentSchedule);
      if (!isTouchDevice) {
        root.addEventListener('click', (e) => {
          const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
          if (!target) return;
          const pid = target.dataset.pid;
          if (pid) navigateToProfile(pid);
        });
      }
      return;
    }
  }

  // ── Point-in-Time View: "Where is everyone now?" ──
  if (_viewMode === 'POINT_IN_TIME_VIEW' && _pointInTimeTimestamp && currentSchedule) {
    const pitCtx: PointInTimeContext = {
      schedule: currentSchedule,
      timestamp: _pointInTimeTimestamp,
      freeCollapsed: _pointInTimeFreeCollapsed,
      onTimestampChange: (t) => {
        _pointInTimeTimestamp = t;
        renderAll();
      },
      onToggleFreeCollapsed: () => {
        _pointInTimeFreeCollapsed = !_pointInTimeFreeCollapsed;
      },
      onBack: () => {
        _viewMode = 'SCHEDULE_VIEW';
        _pointInTimeTimestamp = null;
        _restoreScheduleScroll = true;
        renderAll();
      },
      onNavigateToProfile: navigateToProfile,
      onNavigateToTaskPanel: navigateToTaskPanel,
    };
    app.innerHTML = `<div class="point-in-time-view-root">${renderPointInTimeView(pitCtx)}</div>`;
    const root = app.querySelector('.point-in-time-view-root') as HTMLElement;
    wirePointInTimeEvents(root, pitCtx);
    return;
  }

  const participants = store.getAllParticipants();
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  let html = `
  <header>
    <div class="header-top">
      <h1 id="app-title" role="button" tabindex="0" aria-label="השבצקיסט — מעבר למסך הבית"><img class="app-logo-img" src="./logo-header.png" alt="" aria-hidden="true" draggable="false">השבצקיסט</h1><span class="beta-badge">v3.9.2</span>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${!store.getUndoRedoState().canUndo ? 'disabled' : ''}
          title="ביטול">↪<span class="btn-label"> ביטול${store.getUndoRedoState().undoDepth ? ` (${store.getUndoRedoState().undoDepth})` : ''}</span></button>
        <button class="btn-sm btn-outline" id="btn-redo" ${!store.getUndoRedoState().canRedo ? 'disabled' : ''}
          title="שחזור">↩<span class="btn-label"> שחזור${store.getUndoRedoState().redoDepth ? ` (${store.getUndoRedoState().redoDepth})` : ''}</span></button>
      </div>
    </div>
    <p class="subtitle">
      <span id="live-clock">${formatLiveClock()}</span>
      · שבצ"ק ל-${currentSchedule?.periodDays ?? store.getScheduleDays()} ימים
      · ${participants.length} משתתפים
      · ${templates.length} משימות
    </p>
    <div class="header-credit">
      <span class="credit-left">פותח על ידי אייל צמיר</span>
      <span class="credit-right">כי עוד אאמין באדם, גם ברוחו, רוח עז.</span>
    </div>
  </header>

  <nav class="tab-nav" role="tablist">
    <button class="tab-btn ${currentTab === 'participants' ? 'tab-active' : ''}" data-tab="participants" aria-label="משתתפים" role="tab" aria-selected="${currentTab === 'participants'}">
      <span class="tab-icon">${SVG_ICONS.participants}</span>
      <span class="tab-label">משתתפים</span>
      <span class="tab-badge-count" data-count="${participants.length}" aria-hidden="true"></span>
      <span class="tab-dot" aria-hidden="true"></span>
    </button>
    <button class="tab-btn ${currentTab === 'task-rules' ? 'tab-active' : ''}" data-tab="task-rules" aria-label="משימות${!preflight.canGenerate ? ' (יש בעיות)' : ''}" role="tab" aria-selected="${currentTab === 'task-rules'}">
      <span class="tab-icon">${SVG_ICONS.tasks}</span>
      <span class="tab-label">משימות</span>
      <span class="tab-badge-count" data-count="${templates.length}" aria-hidden="true"></span>
      <span class="tab-badge-dot tab-badge-warn ${!preflight.canGenerate ? '' : 'is-hidden'}" aria-hidden="true"></span>
      <span class="tab-dot" aria-hidden="true"></span>
    </button>
    <button class="tab-btn tab-fab ${currentTab === 'schedule' ? 'tab-active' : ''}" data-tab="schedule" aria-label="שבצ&quot;ק" role="tab" aria-selected="${currentTab === 'schedule'}">
      <span class="tab-fab-surface">
        <span class="tab-icon">${SVG_ICONS.lightbulb}</span>
        <span class="tab-badge-dot tab-badge-ok ${currentSchedule ? '' : 'is-hidden'}" aria-hidden="true"></span>
      </span>
      <span class="tab-label tab-fab-label">שבצ"ק</span>
    </button>
    <button class="tab-btn ${currentTab === 'algorithm' ? 'tab-active' : ''}" data-tab="algorithm" aria-label="הגדרות" role="tab" aria-selected="${currentTab === 'algorithm'}">
      <span class="tab-icon">${SVG_ICONS.settings}</span>
      <span class="tab-label">הגדרות</span>
      <span class="tab-dot" aria-hidden="true"></span>
    </button>
    <button class="tab-btn ${currentTab === 'home' ? 'tab-active' : ''}" data-tab="home" aria-label="ראשי" role="tab" aria-selected="${currentTab === 'home'}">
      <span class="tab-icon">${SVG_ICONS.home}</span>
      <span class="tab-label">ראשי</span>
      <span class="tab-dot" aria-hidden="true"></span>
    </button>
  </nav>

  <div class="tab-content" id="tab-content">`;

  // First-run welcome on Home: only a genuine newcomer (tour never engaged and
  // the welcome never shown) sees it — once ever, not on header-title return or
  // app reopen (markHomeWelcomeSeen() below makes it one-time).
  const homeFirstRun = currentTab === 'home' && !isTutorialBannerDismissed() && !isHomeWelcomeSeen();

  switch (currentTab) {
    case 'home':
      html += renderHomeTab({
        schedule: currentSchedule,
        scheduleDirty: _scheduleDirty,
        preflight,
        firstRun: homeFirstRun,
      });
      break;
    case 'participants':
      html += renderParticipantsTab();
      break;
    case 'task-rules':
      html += renderTaskRulesTab(preflight);
      break;
    case 'schedule':
      html += renderScheduleTab(preflight);
      break;
    case 'algorithm':
      html += renderAlgorithmTab(tutorialContext);
      break;
  }

  html += '</div>';

  // Preserve scroll position during schedule re-renders (manual build,
  // returning from profile view, or any re-render while on schedule tab)
  const shouldPreserveScroll = (currentTab === 'schedule' && _manualBuildActive) || _restoreScheduleScroll;
  if (currentTab === 'schedule' && _manualBuildActive) {
    _scheduleScrollY = window.scrollY;
  }
  const savedScrollY = shouldPreserveScroll ? _scheduleScrollY : 0;
  _restoreScheduleScroll = false;

  app.innerHTML = html;

  if (savedScrollY > 0) {
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
  }

  // Wire events
  wireTabNav(app);
  wireUndoRedo(app);
  wireEasterEgg(app);
  // MUST stay after wireEasterEgg — see wireHomeTitle() doc comment.
  wireHomeTitle(app);
  wireFactoryReset(app);

  const content = document.getElementById('tab-content')!;
  if (currentTab === 'home') {
    // Consume the one-time welcome now that it has painted (if it was shown).
    if (homeFirstRun) markHomeWelcomeSeen();
    wireHomeEvents(content, {
      onOpenSchedule: () => void goToTab('schedule'),
      onGenerate: () => void doGenerate(),
      onNavigate: (t: HomeNavTarget) => void goToTab(t),
      onHelp: () => void startTutorial('full-tour', tutorialContext),
      onDeepTour: () => void startTutorial('deep-tour', tutorialContext),
      onDismissWelcome: () => {
        markBannerDismissed();
        renderAll();
      },
      onInstall: () => {
        // runInstallPrompt nulls the deferred prompt synchronously, so the
        // immediate re-render drops the banner regardless of the native
        // prompt's (async) outcome. The appinstalled-driven onChange
        // re-render then keeps it gone permanently on accept.
        void runInstallPrompt();
        renderAll();
      },
    });
  } else if (currentTab === 'participants') {
    wireParticipantsEvents(content, renderAll);
  } else if (currentTab === 'task-rules') {
    wireTaskRulesEvents(content, renderAll, () => void goToTab('participants'));
  } else if (currentTab === 'schedule') {
    wireScheduleEvents(content);
    const swimlane = content.querySelector('.swimlane-view') as HTMLElement | null;
    if (swimlane) wireSwimlaneEvents(swimlane);
  } else if (currentTab === 'algorithm') {
    wireAlgorithmEvents(content, renderAll, tutorialContext);
    wireDataTransferEvents(content);
  }

  // Run KPI count-up animations when on schedule tab
  if (currentTab === 'schedule' && currentSchedule) {
    requestAnimationFrame(runKpiAnimations);
  }

  // Animate swapped slots (post-render crossfade-slide)
  if (_pendingSwapAnimIds.size > 0) {
    requestAnimationFrame(applySwapAnimations);
  }
}

function applySwapAnimations(): void {
  if (_pendingSwapAnimIds.size === 0) return;
  const ids = _pendingSwapAnimIds;
  _pendingSwapAnimIds = new Set();
  for (const id of ids) {
    const els = document.querySelectorAll(`[data-assignment-id="${id}"]`);
    for (const el of els) {
      (el as HTMLElement).classList.add('swap-anim-in');
    }
  }
}

/**
 * Centralised tab navigation. Encapsulates the participants-tab
 * unsaved-changes guard so every exit path — the bottom-nav buttons, the
 * header-title → Home button, and Home's quick-links — behaves identically.
 * No-ops when already on `tab`.
 */
async function goToTab(tab: TabId): Promise<void> {
  if (tab === currentTab) return;
  if (currentTab === 'participants') {
    // Guard: if table-edit mode has unsaved changes, confirm before leaving
    const canLeave = await canLeaveParticipantsTab();
    if (!canLeave) return;
    clearParticipantSelection();
  }
  // The header title is only clickable in SCHEDULE_VIEW (overlay modes return
  // before the header renders), but reset defensively so navigation always
  // lands on the standard tabbed layout.
  _viewMode = 'SCHEDULE_VIEW';
  currentTab = tab;
  pushHash();
  renderAll();
}

function wireTabNav(container: HTMLElement): void {
  container.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as TabId;
      if (tab) void goToTab(tab);
    });
  });
}

/**
 * The header brand title doubles as the Home button — Home is the default
 * landing view, not a bottom-nav tab. Wired AFTER wireEasterEgg() so the
 * easter-egg click counter still increments on every tap (3 rapid taps still
 * open the egg); a single tap navigates Home, and goToTab() no-ops once
 * already there. _easterEggClicks is module-global and survives the re-render.
 */
function wireHomeTitle(container: HTMLElement): void {
  const title = container.querySelector('#app-title');
  if (!title) return;
  title.addEventListener('click', () => {
    void goToTab('home');
  });
  title.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ') {
      ke.preventDefault();
      void goToTab('home');
    }
  });
}

function doUndoRedo(action: 'undo' | 'redo'): void {
  _undoRedoInProgress = true;
  const ok = action === 'undo' ? store.undo() : store.redo();
  _undoRedoInProgress = false;
  if (!ok) return;

  const sourceStack = action === 'undo' ? _scheduleUndoStack : _scheduleRedoStack;
  const targetStack = action === 'undo' ? _scheduleRedoStack : _scheduleUndoStack;

  if (sourceStack.length > 0) {
    // Save current schedule to the opposite stack
    targetStack.push({
      schedule: currentSchedule ? structuredClone(currentSchedule) : null,
      dirty: _scheduleDirty,
    });
    const snap = sourceStack.pop()!;
    _scheduleDirty = snap.dirty;
    const restored = snap.schedule;
    if (restored) {
      currentSchedule = restored;
      // Re-apply the "past is closed" freeze on the restored snapshot so an
      // anchor-advance + undo can't resurrect past assignments as editable.
      const lm = store.getLiveModeState();
      if (lm.enabled) freezeAssignments(currentSchedule, lm.currentTimestamp);
      // Re-wire the engine so violations/scoring stay consistent
      if (engine) {
        engine.importSchedule(currentSchedule);
        engine.addParticipants(currentSchedule.participants);
        engine.revalidateFull();
        currentSchedule = engine.getSchedule()!;
      }
      if (!store.saveSchedule(currentSchedule)) {
        showToast('השינוי בוצע אך לא נשמר — נפח האחסון מלא.', { type: 'warning', duration: 6000 });
      }
    } else {
      // No schedule existed before this mutation — clear it
      currentSchedule = null;
      engine = null;
      store.clearSchedule();
    }
  }

  renderAll();
}

function wireUndoRedo(container: HTMLElement): void {
  const undoBtn = container.querySelector('#btn-undo');
  const redoBtn = container.querySelector('#btn-redo');
  if (undoBtn) undoBtn.addEventListener('click', () => doUndoRedo('undo'));
  if (redoBtn) redoBtn.addEventListener('click', () => doUndoRedo('redo'));
}

// ─── Easter Egg ─────────────────────────────────────────────────────────────

let _easterEggClicks = 0;
let _easterEggTimer: ReturnType<typeof setTimeout> | null = null;

function wireEasterEgg(container: HTMLElement): void {
  const title = container.querySelector('#app-title');
  if (!title) return;
  title.addEventListener('click', () => {
    _easterEggClicks++;
    if (_easterEggTimer) clearTimeout(_easterEggTimer);
    _easterEggTimer = setTimeout(() => {
      _easterEggClicks = 0;
    }, 2500);
    if (_easterEggClicks >= 3) {
      _easterEggClicks = 0;
      if (_easterEggTimer) {
        clearTimeout(_easterEggTimer);
        _easterEggTimer = null;
      }
      showEasterEgg();
    }
  });
}

function showEasterEgg(): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'gm-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gm-egg-dialog" role="dialog" aria-modal="true">
      <div class="gm-egg-page">
        <div class="gm-egg-quote">
          <blockquote>החרטה היחידה בלבי היא שלא חלמתי חלומות רבים וגדולים עוד יותר</blockquote>
          <cite>— שמעון פרס</cite>
        </div>
        <div class="gm-egg-ornament" aria-hidden="true"><span>✦</span><span>❦</span><span>✦</span></div>
        <div class="gm-egg-quote">
          <blockquote>אם ברצונך ללמוד להכיר אדם, שים לב איך הוא מתייחס לזוטרים ממנו, לא לשווים לו.</blockquote>
          <cite>— סיריוס בלק, הארי פוטר וגביע האש</cite>
        </div>
      </div>
      <div class="gm-egg-seal-wrap">
        <button class="gm-egg-seal" aria-label="סגור" title="סגור"></button>
      </div>
    </div>`;

  const close = () => {
    const dialog = backdrop.querySelector('.gm-egg-dialog');
    if (dialog) dialog.classList.add('closing');
    backdrop.classList.add('closing');
    backdrop.addEventListener('animationend', () => backdrop.remove(), { once: true });
  };
  backdrop.querySelector('.gm-egg-seal')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  });
  document.body.appendChild(backdrop);
  (backdrop.querySelector('.gm-egg-seal') as HTMLElement).focus();
}

// ─── Console-hint Easter Egg (empty-state icon) ─────────────────────────────

let _consoleHintClicks = 0;
let _consoleHintTimer: ReturnType<typeof setTimeout> | null = null;

function attachConsoleHintEasterEgg(container: HTMLElement): void {
  const icon = container.querySelector('.empty-icon') as HTMLElement | null;
  if (!icon) return;
  icon.addEventListener('click', () => {
    _consoleHintClicks++;
    if (_consoleHintTimer) clearTimeout(_consoleHintTimer);
    _consoleHintTimer = setTimeout(() => {
      _consoleHintClicks = 0;
    }, 1500);
    if (_consoleHintClicks >= 3) {
      _consoleHintClicks = 0;
      if (_consoleHintTimer) {
        clearTimeout(_consoleHintTimer);
        _consoleHintTimer = null;
      }
      showConsoleHint();
    }
  });
}

function showConsoleHint(): void {
  const entries: Array<{ cmd: string; desc: string }> = [
    { cmd: "toggleSchedulerDiag('on')", desc: 'התחל לאסוף נתוני אבחון' },
    { cmd: "toggleSchedulerDiag('verbose')", desc: 'מצב מפורט — כולל דחיות זכאות' },
    { cmd: "toggleSchedulerDiag('show')", desc: 'הדפס את הדו"ח של ההרצה האחרונה' },
    { cmd: "toggleSchedulerDiag('off')", desc: 'הפסק איסוף' },
  ];

  const rowsHtml = entries
    .map(
      ({ cmd, desc }) => `
      <div class="gm-console-hint-row">
        <div class="gm-console-hint-row-text">
          <code class="gm-console-hint-cmd">${escHtml(cmd)}</code>
          <div class="gm-console-hint-desc">${escHtml(desc)}</div>
        </div>
        <button type="button" class="gm-console-hint-copy" data-cmd="${escAttr(cmd)}" aria-label="העתק פקודה" title="העתק">
          <span class="gm-console-hint-copy-icon">📋</span>
        </button>
      </div>`,
    )
    .join('');

  const backdrop = document.createElement('div');
  backdrop.className = 'gm-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gm-modal-dialog gm-console-hint" role="dialog" aria-modal="true" aria-labelledby="gm-console-hint-title">
      <div class="gm-console-hint-header">
        <div class="gm-console-hint-title-row">
          <span class="gm-console-hint-icon" aria-hidden="true">🛠️</span>
          <h3 id="gm-console-hint-title" class="gm-console-hint-title">אבחון מתזמן</h3>
          <button type="button" class="gm-console-hint-close" aria-label="סגור" title="סגור">×</button>
        </div>
        <div class="gm-console-hint-subtitle">פתח את ה-Console (F12) והדבק אחת מהפקודות:</div>
      </div>
      <div class="gm-console-hint-list">${rowsHtml}</div>
    </div>`;

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const copyBtns = backdrop.querySelectorAll<HTMLButtonElement>('.gm-console-hint-copy');
  copyBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd ?? '';
      if (!cmd) return;
      void navigator.clipboard?.writeText(cmd).then(
        () => {
          btn.classList.add('is-copied');
          const icon = btn.querySelector('.gm-console-hint-copy-icon');
          if (icon) icon.textContent = '✓';
          setTimeout(() => {
            btn.classList.remove('is-copied');
            if (icon) icon.textContent = '📋';
          }, 1200);
        },
        () => {
          const icon = btn.querySelector('.gm-console-hint-copy-icon');
          if (icon) icon.textContent = '✗';
        },
      );
    });
  });

  const closeBtn = backdrop.querySelector('.gm-console-hint-close') as HTMLButtonElement | null;
  closeBtn?.addEventListener('click', close);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
}

// ─── KPI Count-Up Animation ─────────────────────────────────────────────────

const _prevKpiValues: Record<string, number> = {};

function animateCountUp(el: HTMLElement, target: number, decimals: number, duration = 600): void {
  const start = performance.now();
  const from = 0;
  const step = (now: number) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const eased = 1 - (1 - progress) ** 3;
    const current = from + (target - from) * eased;
    el.textContent = decimals > 0 ? current.toFixed(decimals) : Math.round(current).toString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function runKpiAnimations(): void {
  const ids: Array<{ id: string; decimals: number }> = [
    { id: 'kpi-score', decimals: 1 },
    { id: 'kpi-violations', decimals: 0 },
    { id: 'kpi-warnings', decimals: 0 },
  ];
  for (const { id, decimals } of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const target = parseFloat(el.dataset.target || '0');
    const prev = _prevKpiValues[id];
    // Animate on first render or when value changes
    if (prev === undefined || prev !== target) {
      animateCountUp(el, target, decimals);
      // Flash green briefly if value improved (score up, violations/warnings down)
      if (prev !== undefined) {
        const improved = id === 'kpi-score' ? target > prev : target < prev;
        if (improved) {
          const kpiDiv = el.closest('.kpi');
          if (kpiDiv) {
            (kpiDiv as HTMLElement).classList.add('kpi-improved');
            setTimeout(() => (kpiDiv as HTMLElement).classList.remove('kpi-improved'), 800);
          }
        }
      }
    }
    _prevKpiValues[id] = target;
  }
  // Feasible KPI: just fade in
  const feasEl = document.getElementById('kpi-feasible');
  if (feasEl) {
    feasEl.style.animation = 'none';
    feasEl.offsetHeight; // trigger reflow
    feasEl.style.animation = 'kpiFadeIn 0.3s ease';
  }
}

function wireFactoryReset(container: HTMLElement): void {
  const btn = container.querySelector('#btn-factory-reset');
  if (btn) {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm(
        'פעולה זו תמחק את כל הנתונים במערכת:\n' +
          '• כל המשתתפים והגדרותיהם\n' +
          '• כל המשימות והשיבוצים\n' +
          '• כל הגדרות האלגוריתם וסטים שמורים\n' +
          '• כל תמונות המצב השמורות\n' +
          '• כל סטי המשתתפים וסטי המשימות\n\n' +
          'המערכת תחזור למצב ההתחלתי כאילו הותקנה מחדש.\n' +
          'לא ניתן לבטל פעולה זו!',
        {
          danger: true,
          title: '⚠ איפוס מערכת מלא',
          confirmLabel: 'כן, אפס הכל',
          cancelLabel: 'ביטול',
        },
      );
      if (ok) {
        store.factoryReset();
        location.reload();
      }
    });
  }
}

// ─── Snapshot Event Wiring ───────────────────────────────────────────────────

function wireSnapshotEvents(container: HTMLElement): void {
  container.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.id !== 'snap-name') return;
    if (!_snapshotFormError) return;
    _snapshotFormError = '';
    target.removeAttribute('aria-invalid');
    const errorEl = container.querySelector('#snap-error') as HTMLElement | null;
    if (errorEl) errorEl.textContent = '';
  });

  // Toggle panel open/close
  const toggleBtn = container.querySelector('#btn-snap-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      _snapshotPanelOpen = !_snapshotPanelOpen;
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // ── Continuity chip + import modal events ──
  const continuityChip = container.querySelector('#continuity-chip');
  if (continuityChip) {
    continuityChip.addEventListener('click', (e) => {
      // Don't open modal if the clear button was clicked
      if ((e.target as HTMLElement).closest('.continuity-chip-clear')) return;
      openContinuityImportModal();
    });
  }
  const continuityClear = container.querySelector('#btn-continuity-clear');
  if (continuityClear) {
    continuityClear.addEventListener('click', (e) => {
      e.stopPropagation();
      _continuityJson = '';
      renderAll();
    });
  }
  const continuityImportBtn = container.querySelector('#btn-continuity-import');
  if (continuityImportBtn) {
    continuityImportBtn.addEventListener('click', () => {
      openContinuityImportModal();
    });
  }

  // Close button inside panel
  const closeBtn = container.querySelector('#btn-snap-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      _snapshotPanelOpen = false;
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Save As → show form
  const saveAsBtn = container.querySelector('#btn-snap-save-as');
  if (saveAsBtn) {
    saveAsBtn.addEventListener('click', () => {
      _snapshotFormMode = 'save-as';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Confirm Save As
  const confirmSaveBtn = container.querySelector('#btn-snap-confirm-save');
  if (confirmSaveBtn) {
    confirmSaveBtn.addEventListener('click', () => {
      if (!currentSchedule) return;
      const nameInput = document.getElementById('snap-name') as HTMLInputElement | null;
      const descInput = document.getElementById('snap-desc') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || '';
      const desc = descInput?.value.trim() || '';
      if (!name) {
        _snapshotFormError = 'השם לא יכול להיות ריק';
        renderAll();
        return;
      }
      const result = store.saveScheduleAsSnapshot(currentSchedule, name, desc);
      if (result === 'storage-full') {
        const hasSnapshots = store.getAllSnapshots().length > 0;
        _snapshotFormError = store.isStorageWedged()
          ? hasSnapshots
            ? 'נפח האחסון בדפדפן מלא — מחק תמונות מצב ישנות ונסה שוב'
            : 'נפח האחסון בדפדפן מלא — נסה לפנות מקום בהגדרות הדפדפן'
          : 'שמירת תמונת המצב נכשלה — בדוק את לוג השגיאות במסוף הדפדפן (F12)';
        renderAll();
        return;
      }
      if (!result) {
        _snapshotFormError = 'שם זה כבר תפוס או שהגעת למגבלת תמונות המצב';
        renderAll();
        return;
      }
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      _snapshotDirty = false;
      renderAll();
    });
  }

  // Confirm Rename
  const confirmRenameBtn = container.querySelector('#btn-snap-confirm-rename');
  if (confirmRenameBtn) {
    confirmRenameBtn.addEventListener('click', () => {
      const activeId = store.getActiveSnapshotId();
      if (!activeId) return;
      const nameInput = document.getElementById('snap-name') as HTMLInputElement | null;
      const descInput = document.getElementById('snap-desc') as HTMLInputElement | null;
      const name = nameInput?.value.trim() || '';
      const desc = descInput?.value.trim() || '';
      if (!name) {
        _snapshotFormError = 'השם לא יכול להיות ריק';
        renderAll();
        return;
      }
      const err = store.renameSnapshot(activeId, name, desc);
      if (err) {
        _snapshotFormError = err;
        renderAll();
        return;
      }
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Cancel form
  const cancelBtn = container.querySelector('#btn-snap-cancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      _snapshotFormMode = 'none';
      _snapshotFormError = '';
      renderAll();
    });
  }

  // Delegated click handler for snapshot item actions
  container.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('[data-snap-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.snapAction;
    const snapId = btn.dataset.snapId;
    if (!action || !snapId) return;

    switch (action) {
      case 'load': {
        if (_snapshotDirty && currentSchedule) {
          const ok = await showConfirm('השיבוץ הנוכחי השתנה. לטעון את תמונת המצב ולאבד את השינויים?', {
            title: 'טעינת תמונת מצב',
          });
          if (!ok) return;
        }
        loadScheduleSnapshot(snapId);
        showToast('תמונת מצב נטענה', { type: 'success' });
        break;
      }
      case 'update': {
        if (!currentSchedule) return;
        const ok = store.updateSnapshot(snapId, currentSchedule);
        if (ok) {
          _snapshotDirty = false;
          showToast('תמונת מצב עודכנה', { type: 'success' });
          renderAll();
        } else {
          showToast('עדכון תמונת מצב נכשל — נפח האחסון מלא.', { type: 'warning', duration: 6000 });
        }
        break;
      }
      case 'rename': {
        store.setActiveSnapshotId(snapId);
        _snapshotFormMode = 'rename';
        _snapshotFormError = '';
        renderAll();
        break;
      }
      case 'duplicate': {
        const dup = store.duplicateSnapshot(snapId);
        if (dup) {
          store.setActiveSnapshotId(dup.id);
          showToast('תמונת מצב שוכפלה', { type: 'success' });
          renderAll();
        } else if (store.getAllSnapshots().length >= store.getMaxSnapshots()) {
          await showAlert(`אי אפשר לשכפל: הגעת למגבלה של ${store.getMaxSnapshots()} תמונות מצב.`, { icon: '⚠️' });
        } else {
          showToast('שכפול נכשל — נפח האחסון בדפדפן מלא.', { type: 'warning', duration: 6000 });
        }
        break;
      }
      case 'delete': {
        const snap = store.getSnapshotById(snapId);
        if (!snap) break;
        const ok = await showConfirm(`למחוק את תמונת המצב "${snap.name}"?`, { danger: true, title: 'מחיקת תמונת מצב' });
        if (ok) {
          const deleted = store.deleteSnapshot(snapId);
          _snapshotFormMode = 'none';
          if (deleted) {
            showToast('תמונת מצב נמחקה', { type: 'success' });
          } else {
            showToast('מחיקה נכשלה — נפח האחסון בדפדפן מלא.', { type: 'warning', duration: 6000 });
          }
          renderAll();
        }
        break;
      }
    }
  });
}

function closeOpenTaskPanelMenus(_root: ParentNode = document): void {
  // Menus are portaled to <body> on open, so query at document level.
  document.querySelectorAll<HTMLElement>('body > .task-panel-menu:not([hidden])').forEach((menu) => {
    menu.hidden = true;
    const triggerId = menu.dataset.triggerId;
    const trigger = triggerId ? document.getElementById(triggerId) : null;
    trigger?.setAttribute('aria-expanded', 'false');
    // Restore the menu to its original wrap so layout-engine re-renders don't lose it.
    const wrapId = menu.dataset.wrapId;
    const wrap = wrapId ? document.getElementById(wrapId) : null;
    if (wrap) wrap.appendChild(menu);
  });
}

function openTaskPanelMenu(menu: HTMLElement, trigger: HTMLElement): void {
  // Portal the menu to <body> so its `position: fixed` escapes any ancestor
  // stacking context (e.g. the schedule section's sticky/transform parents
  // would otherwise render TH/TD cells on top of the popover).
  const wrap = menu.parentElement as HTMLElement | null;
  if (wrap && wrap !== document.body) {
    if (!wrap.id) wrap.id = `task-panel-wrap-${Math.random().toString(36).slice(2, 9)}`;
    if (!trigger.id) trigger.id = `task-panel-trigger-${Math.random().toString(36).slice(2, 9)}`;
    menu.dataset.wrapId = wrap.id;
    menu.dataset.triggerId = trigger.id;
    document.body.appendChild(menu);
  }

  // Set visibility:hidden BEFORE unhiding so we can measure without flicker.
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.width = '';
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');

  const margin = 4;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();

  // Vertical: prefer below; flip above if not enough room and there's more above.
  const spaceBelow = viewportH - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  const flipUp = spaceBelow < menuRect.height + margin && spaceAbove > spaceBelow;
  let top: number;
  if (flipUp) {
    top = Math.max(4, triggerRect.top - margin - menuRect.height);
  } else {
    top = triggerRect.bottom + margin;
    if (top + menuRect.height > viewportH - 4) {
      top = Math.max(4, viewportH - menuRect.height - 4);
    }
  }

  // Horizontal: align inline-end of menu to inline-end of trigger.
  // RTL → inline-end is the left side; LTR → right side.
  const isRTL = getComputedStyle(trigger).direction === 'rtl';
  let left = isRTL ? triggerRect.left : triggerRect.right - menuRect.width;
  if (left + menuRect.width > viewportW - 4) left = viewportW - menuRect.width - 4;
  if (left < 4) left = 4;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';
}

function wireScheduleEvents(container: HTMLElement): void {
  const genBtn = container.querySelector('#btn-generate');
  if (genBtn) genBtn.addEventListener('click', doGenerate);

  // Score-breakdown easter egg: triple-click on the score chip opens a modal
  // showing how the composite score is built. No visual affordance — the
  // chip looks identical to today.
  const scoreChip = container.querySelector('#kpi-score') as HTMLElement | null;
  if (scoreChip) attachTripleClickOpener(scoreChip, () => currentSchedule);

  const createManualEmptyBtn = container.querySelector('#btn-create-manual-empty');
  if (createManualEmptyBtn) createManualEmptyBtn.addEventListener('click', doCreateManualSchedule);

  attachConsoleHintEasterEgg(container);

  const daysInput = container.querySelector('#input-days') as HTMLInputElement | null;
  if (daysInput) {
    daysInput.addEventListener('change', () => {
      const val = parseInt(daysInput.value, 10);
      if (val >= 1 && val <= 7) {
        store.setScheduleDays(val);
        if (currentDay > val) currentDay = 1;
        renderAll();
      } else {
        daysInput.value = String(store.getScheduleDays());
      }
    });
  }

  // ── Snapshot Library Events ──
  wireSnapshotEvents(container);

  // Day navigator tabs (desktop) + hero dots (phone) — both use data-day.
  // Allow day=0 only when continuity context is attached to the schedule.
  container.querySelectorAll('.day-tab, .day-hero-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = parseInt((btn as HTMLElement).dataset.day || '1', 10);
      const minDay = currentSchedule && hasDay0(currentSchedule) ? 0 : 1;
      if (day !== currentDay && day >= minDay) {
        currentDay = day;
        pushHash(true);
        renderAll();
      }
    });
  });

  // Hero chevrons (phone) — step +/- 1 day
  container.querySelectorAll<HTMLButtonElement>('.day-hero-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const step = parseInt(btn.dataset.dayStep || '0', 10);
      stepDay(step);
    });
  });

  // Horizontal swipe on schedule body (phone) — left = prev day, right = next
  wireScheduleSwipe(container);

  // ── Availability strip: open / close / results ──
  const availStrip = container.querySelector('.avail-strip') as HTMLElement | null;
  if (availStrip) {
    availStrip.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (action?.dataset.action === 'open-avail-strip') {
        _availabilityInlineOpen = true;
        // Pre-fill a useful range so the user sees results on first open
        // instead of an empty results panel.
        if (_availabilityRangeStartMs === null || _availabilityRangeEndMs === null) {
          applySmartDefaultAvailabilityRange();
        }
        renderAll();
        return;
      }
      if (action?.dataset.action === 'close-avail-strip') {
        _availabilityInlineOpen = false;
        _availabilityRangeStartMs = null;
        _availabilityRangeEndMs = null;
        _availabilityRangeError = null;
        renderAll();
        return;
      }
      // Close button inside results
      const closeTarget = (e.target as HTMLElement).closest('[data-action="close-availability-popover"]');
      if (closeTarget) {
        _availabilityRangeStartMs = null;
        _availabilityRangeEndMs = null;
        _availabilityRangeError = null;
        renderAll();
        return;
      }
      // Grouping switcher click
      const tabTarget = (e.target as HTMLElement).closest('[data-grouping-mode]') as HTMLElement | null;
      if (tabTarget) {
        const mode = tabTarget.dataset.groupingMode as AvailabilityGroupingMode | undefined;
        if (mode && mode !== _availabilityGroupingMode) {
          _availabilityGroupingMode = mode;
          renderAll();
        }
        return;
      }
      // Chip filter click
      const chipTarget = (e.target as HTMLElement).closest('[data-chip-kind]') as HTMLElement | null;
      if (chipTarget) {
        const kind = chipTarget.dataset.chipKind as 'level' | 'cert' | 'group' | undefined;
        const value = chipTarget.dataset.chipValue;
        if (kind && value !== undefined) {
          if (kind === 'level') {
            const lv = Number(value) as Level;
            if (_availabilityLevelFilter.has(lv)) _availabilityLevelFilter.delete(lv);
            else _availabilityLevelFilter.add(lv);
          } else if (kind === 'cert') {
            if (_availabilityCertFilter.has(value)) _availabilityCertFilter.delete(value);
            else _availabilityCertFilter.add(value);
          } else if (kind === 'group') {
            if (_availabilityGroupFilter.has(value)) _availabilityGroupFilter.delete(value);
            else _availabilityGroupFilter.add(value);
          }
          renderAll();
        }
        return;
      }
      // Clear-all-filters link
      if ((e.target as HTMLElement).closest('[data-action="clear-availability-filters"]')) {
        _availabilityLevelFilter.clear();
        _availabilityCertFilter.clear();
        _availabilityGroupFilter.clear();
        renderAll();
        return;
      }
      // Participant click
      const participantTarget = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (participantTarget?.dataset.pid) {
        navigateToProfile(participantTarget.dataset.pid);
      }
    });
    wireParticipantTooltip(availStrip, () => currentSchedule);
  }

  // ── Inject emergency task into current snapshot ──
  const injectBtn = container.querySelector('#btn-inject-task');
  if (injectBtn && currentSchedule) {
    injectBtn.addEventListener('click', async () => {
      if (!currentSchedule || _isOptimizing) return;
      const anchor = await ensureLiveModeAnchor();
      if (!anchor) return;
      if (!currentSchedule || _isOptimizing) return;
      openInjectTaskModal();
    });
  }

  // ── Where-is-everyone (point-in-time status view) ──
  const whereBtn = container.querySelector('#btn-where-is-everyone');
  if (whereBtn && currentSchedule) {
    whereBtn.addEventListener('click', () => {
      if (!currentSchedule) return;
      navigateToPointInTime();
    });
  }

  // ── Continuity: Export day JSON ──
  const exportDayBtn = container.querySelector('#btn-export-day-json');
  if (exportDayBtn && currentSchedule) {
    exportDayBtn.addEventListener('click', () => {
      if (!currentSchedule) return;
      const snapshot = exportDaySnapshot(
        currentSchedule,
        currentDay,
        store.getScheduleDate(),
        currentSchedule.algorithmSettings.dayStartHour,
        new Map(Object.entries(currentSchedule.restRuleSnapshot)),
      );
      const json = JSON.stringify(snapshot, null, 2);
      navigator.clipboard
        .writeText(json)
        .then(() => {
          showToast(`יום ${currentDay} הועתק ללוח — הדבק בשבצ"ק הבא`, { type: 'success' });
        })
        .catch(() => {
          // Fallback: populate via import modal
          _continuityJson = json;
          showToast('לא ניתן להעתיק ללוח — הנתונים נשמרו בזיכרון', { type: 'warning' });
          renderAll();
        });
    });
  }

  // ── Continuity: Generate from end of day X ──
  const genFromDayBtn = container.querySelector('#btn-generate-from-day');
  if (genFromDayBtn && currentSchedule) {
    genFromDayBtn.addEventListener('click', async () => {
      if (!currentSchedule) return;
      const numDaysNow = currentSchedule.periodDays;
      const remainingDays = numDaysNow - currentDay;

      // 1. Export snapshot for the current day (read the schedule's own frozen period)
      const snapshot = exportDaySnapshot(
        currentSchedule,
        currentDay,
        currentSchedule.periodStart,
        currentSchedule.algorithmSettings.dayStartHour,
        new Map(Object.entries(currentSchedule.restRuleSnapshot)),
      );
      _continuityJson = JSON.stringify(snapshot, null, 2);

      // 2. Update schedule start date to end of current day (frozen period)
      const dayWindow = getDayWindow(
        currentDay,
        currentSchedule.algorithmSettings.dayStartHour,
        currentSchedule.periodStart,
      );
      store.setScheduleDate(dayWindow.end);
      // Last day: start a fresh full-cycle schedule; otherwise only remaining days
      store.setScheduleDays(remainingDays > 0 ? remainingDays : numDaysNow);

      // 3. Trigger generation
      currentDay = 1;
      renderAll();
      await doGenerate();
    });
  }

  // ── Gantt mobile accordion toggle ──
  const ganttToggle = container.querySelector('[data-action="toggle-gantt"]');
  if (ganttToggle) {
    const ganttContent = container.querySelector('.gantt-section-content') as HTMLElement | null;
    // Default: collapsed on mobile, expanded on desktop
    if (isSmallScreen && ganttContent) {
      ganttContent.style.display = 'none';
      ganttToggle.setAttribute('aria-expanded', 'false');
    }
    ganttToggle.addEventListener('click', () => {
      if (!ganttContent) return;
      const expanded = ganttToggle.getAttribute('aria-expanded') === 'true';
      ganttToggle.setAttribute('aria-expanded', String(!expanded));
      ganttContent.style.display = expanded ? 'none' : '';
    });
  }

  // ── Swimlane "תצוגה כללית" section toggle ──
  const swimlaneToggle = container.querySelector('[data-action="toggle-swimlane"]');
  if (swimlaneToggle) {
    swimlaneToggle.addEventListener('click', () => {
      const section = swimlaneToggle.closest('.swimlane-section');
      if (!section) return;
      _swimlaneCollapsed = !_swimlaneCollapsed;
      section.classList.toggle('swimlane-section--collapsed', _swimlaneCollapsed);
      swimlaneToggle.setAttribute('aria-expanded', _swimlaneCollapsed ? 'false' : 'true');
    });
  }

  // ── Jump-to-violations (clicking the warnings KPI tile scrolls to the violations section) ──
  const jumpToViolations = (target: HTMLElement) => {
    const section = container.querySelector('#violations-section') as HTMLElement | null;
    if (!section) return;
    // If we're in manual-build mode the section is collapsed by default — expand it first
    // so the user lands on actual content rather than a closed header.
    const collapsedToggle = section.querySelector<HTMLElement>('.violations-toggle[aria-expanded="false"]');
    if (collapsedToggle) collapsedToggle.click();
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Brief highlight pulse so the user sees where they landed.
    section.classList.add('violations-section-pulse');
    setTimeout(() => section.classList.remove('violations-section-pulse'), 1500);
    target.blur();
  };
  container.addEventListener('click', (e) => {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-action="jump-to-violations"]');
    if (!tile) return;
    e.preventDefault();
    jumpToViolations(tile);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tile = (e.target as HTMLElement).closest<HTMLElement>('[data-action="jump-to-violations"]');
    if (!tile) return;
    e.preventDefault();
    jumpToViolations(tile);
  });

  // ── Violations toggle (manual build mode) ──
  const violationsToggle = container.querySelector('[data-action="toggle-violations"]');
  if (violationsToggle) {
    violationsToggle.addEventListener('click', () => {
      const section = violationsToggle.closest('.violations-section');
      if (!section) return;
      const expanded = violationsToggle.getAttribute('aria-expanded') === 'true';
      if (!expanded) {
        // Lazy-render violations content
        let content = section.querySelector('.violations-content') as HTMLElement | null;
        if (!content && currentSchedule) {
          content = document.createElement('div');
          content.className = 'violations-content';
          content.innerHTML = renderViolations(currentSchedule);
          section.appendChild(content);
        }
        if (content) content.style.display = '';
        section.classList.remove('violations-collapsed');
      } else {
        const content = section.querySelector('.violations-content') as HTMLElement | null;
        if (content) content.style.display = 'none';
        section.classList.add('violations-collapsed');
      }
      violationsToggle.setAttribute('aria-expanded', String(!expanded));
      const icon = violationsToggle.querySelector('.violations-toggle-icon');
      if (icon) icon.textContent = expanded ? '▸' : '▾';
    });
  }

  // ── Violation category toggles ──
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action="toggle-violation-category"]');
    if (!btn) return;
    const cat = btn.closest<HTMLElement>('.violation-category');
    if (!cat) return;
    const content = cat.querySelector<HTMLElement>('.violation-category-content');
    const icon = btn.querySelector<HTMLElement>('.violation-category-icon');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    if (expanded) {
      cat.classList.add('violation-category-collapsed');
      if (content) content.style.display = 'none';
      if (icon) icon.textContent = '▸';
    } else {
      cat.classList.remove('violation-category-collapsed');
      if (content) content.style.display = '';
      if (icon) icon.textContent = '▾';
    }
  });

  // ── Participant Tooltip (event delegation) ──
  wireParticipantTooltip(container, () => currentSchedule);

  // ── Task Tooltip (event delegation) ──
  wireTaskTooltip(container, () => currentSchedule);

  // ── Participant click → Profile View (desktop only; touch uses bottom sheet / long-press) ──
  if (!isTouchDevice) {
    container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      if (pid) navigateToProfile(pid);
    });
  }

  // ── Task source chip → Task Panel View (desktop + touch) ──
  // Uses document-level delegation because multi-source popover menus are
  // portaled to <body> on open (to escape ancestor stacking contexts), so
  // their chip clicks would not bubble back to `container`.
  document.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.task-panel-hover[data-source-name]') as HTMLElement | null;
    if (!chip?.dataset.sourceName) return;
    navigateToTaskPanel(chip.dataset.sourceName);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = (e.target as HTMLElement).closest('.task-panel-hover[data-source-name]') as HTMLElement | null;
    if (!chip?.dataset.sourceName) return;
    e.preventDefault();
    navigateToTaskPanel(chip.dataset.sourceName);
  });

  // ── Multi-source title trigger → toggle dropdown menu ──
  container.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.task-panel-menu')) return;
    const trigger = target.closest('[data-task-panel-menu="true"]') as HTMLButtonElement | null;
    if (!trigger) {
      closeOpenTaskPanelMenus(container);
      return;
    }
    const wrap = trigger.closest('.task-panel-menu-wrap');
    const menu = wrap?.querySelector<HTMLElement>(':scope > .task-panel-menu') ?? null;
    if (!menu) return;
    const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
    closeOpenTaskPanelMenus(container);
    if (!wasOpen) openTaskPanelMenu(menu, trigger);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOpenTaskPanelMenus(container);
  });
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as Node;
      if (container.contains(target)) return;
      // Portaled menus live on <body> — keep them open when clicking inside.
      if ((target as HTMLElement).closest?.('.task-panel-menu')) return;
      closeOpenTaskPanelMenus(container);
    },
    true,
  );
  // Fixed-positioned popover anchors to the trigger rect at open time; close on
  // scroll/resize rather than recompute (anchor would otherwise drift).
  window.addEventListener('scroll', () => closeOpenTaskPanelMenus(container), true);
  window.addEventListener('resize', () => closeOpenTaskPanelMenus(container));

  // ── Time-cell two-click range selection ──
  const handleTimeCellSelect = (target: HTMLElement) => {
    const timeMs = Number(target.dataset.timeMs || target.closest('tr[data-time]')?.getAttribute('data-time'));
    if (!Number.isFinite(timeMs)) return;

    if (_timeCellSelectionPhase === 'idle') {
      _timeCellSelectionPhase = 'start-selected';
      _timeCellSelectionStartMs = timeMs;
      container
        .querySelectorAll('.time-cell-range-start')
        .forEach((el) => el.classList.remove('time-cell-range-start'));
      target.classList.add('time-cell-range-start');
      showToast('לחץ על תא נוסף לבחירת סוף הטווח', { type: 'info' });
    } else {
      // Second click — finalize range
      if (timeMs === _timeCellSelectionStartMs) {
        // Same cell → cancel
        _timeCellSelectionPhase = 'idle';
        _timeCellSelectionStartMs = null;
        container
          .querySelectorAll('.time-cell-range-start')
          .forEach((el) => el.classList.remove('time-cell-range-start'));
        showToast('בחירה בוטלה', { type: 'info' });
        return;
      }
      let startMs = _timeCellSelectionStartMs!;
      let endMs = timeMs;
      if (startMs > endMs) {
        const tmp = startMs;
        startMs = endMs;
        endMs = tmp;
      }

      _availabilityRangeStartMs = startMs;
      _availabilityRangeEndMs = endMs;
      _availabilityInlineOpen = true;
      _timeCellSelectionPhase = 'idle';
      _timeCellSelectionStartMs = null;

      // Sync the strip dropdowns with the picked timestamps so that a
      // subsequent click on "הצג זמינות" doesn't silently overwrite the
      // cell-picked range with stale dropdown values (Bug 4).
      if (currentSchedule) {
        const dsh = currentSchedule.algorithmSettings.dayStartHour;
        const base = currentSchedule.periodStart;
        const anchor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), dsh, 0).getTime();
        const toDayIndex = (ms: number) => Math.floor((ms - anchor) / 86400000) + 1;
        const toHourLabel = (ms: number) => {
          const d = new Date(ms);
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        };
        _availabilityInspectorDay = toDayIndex(startMs);
        _availabilityInspectorDayEnd = toDayIndex(endMs);
        _availabilityInspectorTimeStart = toHourLabel(startMs);
        _availabilityInspectorTimeEnd = toHourLabel(endMs);
      }

      container
        .querySelectorAll('.time-cell-range-start')
        .forEach((el) => el.classList.remove('time-cell-range-start'));
      renderAll();
    }
  };

  container.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.time-cell-inspectable[data-time-ms]') as HTMLElement | null;
    if (!target) return;
    handleTimeCellSelect(target);
  });

  container.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement).closest('.time-cell-inspectable[data-time-ms]') as HTMLElement | null;
    if (!target) return;
    if (e.key === 'Escape' && _timeCellSelectionPhase === 'start-selected') {
      _timeCellSelectionPhase = 'idle';
      _timeCellSelectionStartMs = null;
      container
        .querySelectorAll('.time-cell-range-start')
        .forEach((el) => el.classList.remove('time-cell-range-start'));
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    handleTimeCellSelect(target);
  });

  // Range dropdowns: each change attempts to commit immediately. Invalid
  // ranges leave the last valid commit in place and surface a small inline
  // warning instead of a toast (less noisy mid-edit).
  const onRangeDropdownChange = () => {
    tryCommitDropdownRange();
    renderAll();
  };
  wireCustomSelect(container, 'gm-availability-day-start', (value) => {
    const day = parseInt(value, 10);
    if (!Number.isNaN(day)) _availabilityInspectorDay = day;
    onRangeDropdownChange();
  });
  wireCustomSelect(container, 'gm-availability-day-end', (value) => {
    const day = parseInt(value, 10);
    if (!Number.isNaN(day)) _availabilityInspectorDayEnd = day;
    onRangeDropdownChange();
  });
  wireCustomSelect(container, 'gm-availability-time-start', (value) => {
    if (value) _availabilityInspectorTimeStart = value;
    onRangeDropdownChange();
  });
  wireCustomSelect(container, 'gm-availability-time-end', (value) => {
    if (value) _availabilityInspectorTimeEnd = value;
    onRangeDropdownChange();
  });

  // ── Margin toggle + fields ──
  const marginToggle = container.querySelector('#gm-availability-margin-toggle') as HTMLInputElement | null;
  if (marginToggle) {
    marginToggle.addEventListener('change', () => {
      _availabilityMarginEnabled = marginToggle.checked;
      renderAll();
    });
  }
  const MARGIN_MIN_HOURS = 0;
  const MARGIN_MAX_HOURS = 24;
  const clampMarginHours = (v: number) => Math.max(MARGIN_MIN_HOURS, Math.min(MARGIN_MAX_HOURS, v));
  const wireMarginInput = (input: HTMLInputElement | null, getState: () => number, setState: (v: number) => void) => {
    if (!input) return;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) setState(clampMarginHours(v));
    });
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        const clamped = clampMarginHours(v);
        setState(clamped);
        input.value = String(clamped);
      } else {
        input.value = String(getState());
      }
      renderAll();
    });
  };
  wireMarginInput(
    container.querySelector('#gm-availability-pre-margin') as HTMLInputElement | null,
    () => _availabilityPreMarginHours,
    (v) => {
      _availabilityPreMarginHours = v;
    },
  );
  wireMarginInput(
    container.querySelector('#gm-availability-post-margin') as HTMLInputElement | null,
    () => _availabilityPostMarginHours,
    (v) => {
      _availabilityPostMarginHours = v;
    },
  );

  // ── Sleep-recovery tri-state mode (all / hide / only) ──
  container.querySelectorAll<HTMLButtonElement>('[data-recovery-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.recoveryMode as SleepRecoveryMode | undefined;
      if (!m || m === _availabilitySleepRecoveryMode) return;
      _availabilitySleepRecoveryMode = m;
      renderAll();
    });
  });

  // ── Senior toggle button ──
  const seniorToggle = container.querySelector('#btn-senior-toggle');
  if (seniorToggle) {
    seniorToggle.addEventListener('click', () => {
      const panel = document.getElementById('sidebar-senior-panel');
      const arrow = document.getElementById('senior-toggle-arrow');
      if (panel) {
        const visible = !panel.classList.contains('hidden');
        panel.classList.toggle('hidden', visible);
        if (arrow) arrow.textContent = visible ? '▶' : '▼';
      }
    });
  }

  // ── Sidebar collapse toggle ──
  const sidebarToggle = container.querySelector('[data-action="sidebar-toggle"]');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      _sidebarCollapsed = !_sidebarCollapsed;
      try {
        localStorage.setItem('gm-sidebar-collapsed', _sidebarCollapsed ? '1' : '0');
      } catch (err) {
        console.warn('[app] Failed to persist sidebar-collapsed:', err);
      }
      renderAll();
    });
  }

  // ── Mobile sidebar drawer (FAB toggle) ──
  if (isSmallScreen) {
    const fab = container.querySelector('.sidebar-fab');
    if (fab) {
      fab.addEventListener('click', () => {
        const sidebar = container.querySelector('.participant-sidebar');
        const existingBackdrop = document.querySelector('.sidebar-drawer-backdrop');
        if (sidebar?.classList.contains('sidebar-mobile-open')) {
          sidebar.classList.remove('sidebar-mobile-open');
          existingBackdrop?.remove();
        } else if (sidebar) {
          sidebar.classList.add('sidebar-mobile-open');
          const bd = document.createElement('div');
          bd.className = 'sidebar-drawer-backdrop';
          bd.addEventListener('click', () => {
            sidebar.classList.remove('sidebar-mobile-open');
            bd.remove();
          });
          document.body.appendChild(bd);
        }
      });
    }
  }

  // ── Workload bar click/tap → structured popup (desktop + mobile) ──
  container.addEventListener('click', (e) => {
    const bar = (e.target as HTMLElement).closest('.sidebar-bar-bg[data-pid]') as HTMLElement | null;
    if (!bar) return;
    const pid = bar.dataset.pid;
    if (!pid || !currentSchedule) return;
    openWorkloadPopup(bar, pid, currentSchedule, currentDay);
  });

  // ── Live Mode toggle ──
  const liveModeChk = container.querySelector('#chk-live-mode') as HTMLInputElement | null;
  if (liveModeChk) {
    liveModeChk.addEventListener('change', () => {
      store.setLiveModeEnabled(liveModeChk.checked);
      if (liveModeChk.checked && currentSchedule) {
        // setLiveModeEnabled stores raw new Date(), which may fall outside the
        // schedule window; clamp it onto the op-day grid so the day-select
        // resolves to a real day instead of silently falling back to יום 1.
        const clamped = computeDefaultLiveAnchor(currentSchedule);
        store.setLiveModeTimestamp(clamped);
        freezeAssignments(currentSchedule, clamped);
      } else if (currentSchedule) {
        unfreezeAll(currentSchedule);
      }
      renderAll();
      if (liveModeChk.checked) {
        requestAnimationFrame(() => scrollToNow(store, false));
      }
    });
  }

  // ── Live Mode day/hour pickers ──
  let _liveDayVal = '';
  let _liveHourVal = '';
  const liveDayEl = container.querySelector('#gm-live-day') as HTMLElement | null;
  const liveHourEl = container.querySelector('#gm-live-hour') as HTMLElement | null;
  if (liveDayEl) _liveDayVal = liveDayEl.dataset.value || '';
  if (liveHourEl) _liveHourVal = liveHourEl.dataset.value || '';
  const updateLiveTimestamp = () => {
    const dayIdx = parseInt(_liveDayVal, 10);
    const hour = parseInt(_liveHourVal, 10);
    if (Number.isNaN(dayIdx) || Number.isNaN(hour)) return;
    // Anchor on the frozen schedule so the timestamp lands on the same op-day
    // grid the user sees. Fall back to the live store only when no schedule
    // exists (live-mode controls are themselves gated on currentSchedule, so
    // this fallback is defensive).
    const base = currentSchedule?.periodStart ?? store.getScheduleDate();
    const numDays = currentSchedule?.periodDays ?? store.getScheduleDays();
    const ts = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIdx - 1, hour, 0);
    store.setLiveModeTimestamp(ts);
    if (currentSchedule && store.getLiveModeState().enabled) {
      freezeAssignments(currentSchedule, ts);
    }
    // Navigate the schedule view to the selected live-mode day
    if (dayIdx >= 1 && dayIdx <= numDays) {
      currentDay = dayIdx;
      pushHash(true);
    }
    const savedScrollY = window.scrollY;
    renderAll();
    requestAnimationFrame(() => {
      scrollToNow(store, false);
      window.scrollTo(0, savedScrollY);
    });
  };
  wireCustomSelect(container, 'gm-live-day', (v) => {
    _liveDayVal = v;
    updateLiveTimestamp();
  });
  wireCustomSelect(container, 'gm-live-hour', (v) => {
    _liveHourVal = v;
    updateLiveTimestamp();
  });

  // ── Reset schedule-screen button ──
  const resetBtn = container.querySelector('#btn-reset-schedule');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const ok = await showConfirm(
        'פעולה זו תמחק את השבצ"ק שנוצר ותחזיר את המסך למצב שלפני יצירתו.\n' +
          'המשתתפים, כללי המשימות, ההגדרות והשבצקים השמורים — יישמרו.\n' +
          'לא ניתן לבטל פעולה זו.',
        {
          danger: true,
          title: 'איפוס מסך השבצ"ק',
          confirmLabel: 'אפס מסך',
          cancelLabel: 'ביטול',
        },
      );
      if (ok) {
        resetScheduleScreen();
      }
    });
  }

  // ── Export PDF button ──
  const exportBtn = container.querySelector('#btn-export-pdf');
  if (exportBtn) exportBtn.addEventListener('click', openExportModal);

  // ── Manual Build Mode ──
  const manualBuildBtn = container.querySelector('#btn-manual-build');
  if (manualBuildBtn) {
    manualBuildBtn.addEventListener('click', () => {
      _manualBuildActive = !_manualBuildActive;
      clearManualSelection();
      _undoStack = _undoStack.filter((e) => e.kind !== 'manual');
      _warehouseFilter = '';
      renderAll();
    });
  }

  const manualUndoBtn = container.querySelector('#btn-manual-undo');
  if (manualUndoBtn) {
    manualUndoBtn.addEventListener('click', handleManualUndo);
  }

  // Manual-build: slot click delegation on schedule grid
  if (_manualBuildActive) {
    container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Handle remove button click
      const removeBtn = target.closest('[data-action="manual-remove"]') as HTMLElement | null;
      if (removeBtn) {
        e.stopPropagation();
        const card = removeBtn.closest('.assignment-card') as HTMLElement | null;
        const aid = card?.dataset.assignmentId;
        if (aid) handleManualRemove(aid);
        return;
      }

      // Handle slot card click
      const card = target.closest('.assignment-card[data-task-id]') as HTMLElement | null;
      if (card) {
        const taskId = card.dataset.taskId;
        const slotId = card.dataset.slotId;
        if (taskId && slotId) {
          handleManualSlotClick(taskId, slotId);
        }
        return;
      }

      // Handle warehouse participant card click (desktop)
      const warehouseCard = target.closest('.warehouse-card[data-pid]') as HTMLElement | null;
      if (warehouseCard) {
        const pid = warehouseCard.dataset.pid;
        if (pid) handleManualParticipantClick(pid);
        return;
      }

      // Handle inline split button click (desktop)
      const splitBtn = target.closest('[data-action="manual-split"]') as HTMLElement | null;
      if (splitBtn) {
        e.stopPropagation();
        handleManualSplitClick();
        return;
      }
    });

    // Warehouse search filter
    const filterInput = container.querySelector('#warehouse-filter') as HTMLInputElement | null;
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        _warehouseFilter = filterInput.value;
        renderAll();
      });
    }

    // Escape key to clear selection
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && _manualBuildActive && (_manualSelectedTaskId || _manualSelectedSlotId)) {
        clearManualSelection();
        renderAll();
      }
    };
    document.addEventListener('keydown', escHandler);
  }
}

// ─── Export PDF Modal ────────────────────────────────────────────────────────

function openExportModal(): void {
  if (!currentSchedule) return;

  // Bound the day picker on the frozen schedule so the user can't pick a day
  // that doesn't exist in what's being exported.
  const numDays = currentSchedule.periodDays;
  const showDay0 = hasDay0(currentSchedule);

  // Build day options for the daily picker. When continuity context is
  // attached, prepend "יום 0" so the user can export just the prior day.
  const exportDayOpts: { value: string; label: string; selected: boolean }[] = [];
  if (showDay0) {
    exportDayOpts.push({ value: '0', label: '📋 יום 0 · הקשר', selected: currentDay === 0 });
  }
  for (let d = 1; d <= numDays; d++) {
    exportDayOpts.push({ value: String(d), label: `יום ${d}`, selected: d === currentDay });
  }

  const day0CheckboxRow = showDay0
    ? `<div class="export-day0-row" id="export-day0-row">
        <label class="export-day0-label">
          <input type="checkbox" id="export-include-day0" checked />
          <span>📋 כלול יום 0 (הקשר מהשבצ"ק הקודם)</span>
        </label>
        <div class="export-day0-help">בייצוא שבועי נוסף עמוד/גיליון יום 0 בתחילה. גיליון הסיכום תמיד ללא יום 0.</div>
      </div>`
    : '';

  const html = `
    <div class="export-backdrop" id="export-modal-backdrop">
      <div class="export-modal">
        <div class="export-header">
          <h3>📤 ייצוא</h3>
          <button class="export-close" id="export-close">✕</button>
        </div>
        <div class="export-body">
          <div class="export-format-group" id="export-format-group">
            <label class="export-format-option selected" id="fmt-pdf">
              <input type="radio" name="export-format" value="pdf" checked />
              <span class="export-format-label">📄 PDF</span>
            </label>
            <label class="export-format-option" id="fmt-excel">
              <input type="radio" name="export-format" value="excel" />
              <span class="export-format-label">📊 Excel</span>
            </label>
            <label class="export-format-option" id="fmt-image">
              <input type="radio" name="export-format" value="image" />
              <span class="export-format-label">🖼️ תמונה</span>
            </label>
          </div>
          <div class="export-mode-group">
            <label class="export-mode-option selected" id="opt-weekly">
              <input type="radio" name="export-mode" value="weekly" checked />
              <div>
                <div class="export-mode-label">סיכום כללי</div>
                <div class="export-mode-desc">טבלת סיכום מרוכזת של כל השבצ"ק — משתתפים × ימים</div>
              </div>
            </label>
            <label class="export-mode-option" id="opt-daily">
              <input type="radio" name="export-mode" value="daily" />
              <div>
                <div class="export-mode-label">פירוט יומי</div>
                <div class="export-mode-desc">טבלאות מפורטות לפי סוג משימה ליום ספציפי</div>
              </div>
            </label>
          </div>
          ${day0CheckboxRow}
          <div class="export-day-picker hidden" id="export-day-picker">
            <label>בחר יום:</label>
            ${renderCustomSelect({ id: 'gm-export-day-select', options: exportDayOpts, className: 'export-day-select' })}
          </div>
        </div>
        <div class="export-footer">
          <button class="btn-primary" id="export-do">📤 ייצוא</button>
          <button class="btn-sm btn-outline" id="export-cancel">ביטול</button>
          <span class="export-status" id="export-status"></span>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
  wireExportModalEvents();
}

function wireExportModalEvents(): void {
  const backdrop = document.getElementById('export-modal-backdrop');
  if (!backdrop) return;

  // Escape key handler — must be declared before closeModal so it can be cleaned up
  const onEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };

  const closeModal = () => {
    document.removeEventListener('keydown', onEscape);
    backdrop.remove();
  };

  // Close buttons
  backdrop.querySelector('#export-close')?.addEventListener('click', closeModal);
  backdrop.querySelector('#export-cancel')?.addEventListener('click', closeModal);

  // Click outside modal closes
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  document.addEventListener('keydown', onEscape);

  // Format + mode element refs
  const fmtPdf = backdrop.querySelector('#fmt-pdf') as HTMLElement;
  const fmtExcel = backdrop.querySelector('#fmt-excel') as HTMLElement;
  const fmtImage = backdrop.querySelector('#fmt-image') as HTMLElement;
  const optWeekly = backdrop.querySelector('#opt-weekly') as HTMLElement;
  const optDaily = backdrop.querySelector('#opt-daily') as HTMLElement;
  const weeklyRadio = backdrop.querySelector('input[name="export-mode"][value="weekly"]') as HTMLInputElement;
  const dailyRadio = backdrop.querySelector('input[name="export-mode"][value="daily"]') as HTMLInputElement;
  const dayPicker = backdrop.querySelector('#export-day-picker') as HTMLElement;
  const day0Row = backdrop.querySelector('#export-day0-row') as HTMLElement | null;

  // Day picker and the "כלול יום 0" checkbox are mode-exclusive: the day
  // picker (choose a specific day, incl. יום 0) is for daily/image; the
  // day-0 inclusion toggle ONLY affects the weekly export, so it must be
  // hidden in daily/image mode where it would do nothing.
  const setModeSections = (isDaily: boolean) => {
    dayPicker.classList.toggle('hidden', !isDaily);
    dayPicker.style.display = isDaily ? 'flex' : '';
    if (day0Row) day0Row.style.display = isDaily ? 'none' : '';
  };

  // Image export is single-day only. The "תמונה" pill stays *always
  // clickable* — selecting it auto-switches to daily (the modal opens on
  // weekly by default, so a greyed image pill would look broken). While
  // image is active the weekly option is greyed, which explains the lock.
  const applyImageConstraints = () => {
    const fmt = (backdrop.querySelector('input[name="export-format"]:checked') as HTMLInputElement)?.value;
    const mode = (backdrop.querySelector('input[name="export-mode"]:checked') as HTMLInputElement)?.value;

    if (fmt === 'image' && mode !== 'daily') {
      dailyRadio.checked = true;
      weeklyRadio.checked = false;
      optWeekly.classList.remove('selected');
      optDaily.classList.add('selected');
      setModeSections(true);
    }

    const imageSelected = fmt === 'image';
    weeklyRadio.disabled = imageSelected;
    optWeekly.classList.toggle('disabled', imageSelected);
  };

  // Format radio toggle
  const formatRadios = backdrop.querySelectorAll('input[name="export-format"]');
  formatRadios.forEach((r) => {
    r.addEventListener('change', () => {
      const fmt = (r as HTMLInputElement).value;
      fmtPdf.classList.toggle('selected', fmt === 'pdf');
      fmtExcel.classList.toggle('selected', fmt === 'excel');
      fmtImage.classList.toggle('selected', fmt === 'image');
      applyImageConstraints();
    });
  });

  // Mode radio toggle
  const radios = backdrop.querySelectorAll('input[name="export-mode"]');
  radios.forEach((r) => {
    r.addEventListener('change', () => {
      const mode = (r as HTMLInputElement).value;
      optWeekly.classList.toggle('selected', mode === 'weekly');
      optDaily.classList.toggle('selected', mode === 'daily');
      setModeSections(mode === 'daily');
      applyImageConstraints();
    });
  });

  // Initial pass: default state is pdf + weekly ⇒ show the day-0 checkbox,
  // hide the day picker (kept in sync with mode from here on).
  applyImageConstraints();
  setModeSections((backdrop.querySelector('input[name="export-mode"]:checked') as HTMLInputElement)?.value === 'daily');

  // Wire custom select for export day picker
  wireCustomSelect(backdrop, 'gm-export-day-select', () => {});

  // Export action
  backdrop.querySelector('#export-do')?.addEventListener('click', async () => {
    if (!currentSchedule) return;
    const status = backdrop.querySelector('#export-status') as HTMLElement;

    const selectedFormat = (backdrop.querySelector('input[name="export-format"]:checked') as HTMLInputElement)?.value;
    const selectedMode = (backdrop.querySelector('input[name="export-mode"]:checked') as HTMLInputElement)?.value;
    // Export uses the schedule's frozen dayStartHour so grouping matches the grid.
    const dayStartHour = currentSchedule.algorithmSettings.dayStartHour;
    const getSelectedDay = (): number => {
      const daySelectEl = backdrop.querySelector('#gm-export-day-select') as HTMLElement | null;
      return parseInt(daySelectEl?.dataset.value || '1', 10);
    };

    // Day 0 inclusion in weekly exports — checkbox is rendered only when
    // the schedule has a continuity snapshot. Default-on (checkbox `checked`).
    const day0Checkbox = backdrop.querySelector('#export-include-day0') as HTMLInputElement | null;
    const includeDay0 = day0Checkbox ? day0Checkbox.checked : false;

    try {
      status.textContent = 'מייצא…';
      status.style.color = '';
      if (selectedFormat === 'excel') {
        if (selectedMode === 'weekly') {
          await exportWeeklyExcel(currentSchedule, dayStartHour, includeDay0);
        } else {
          await exportDailyExcel(currentSchedule, getSelectedDay(), dayStartHour);
        }
      } else if (selectedFormat === 'image') {
        // Single-day only — enforced by the modal constraints above.
        await exportDailyImage(currentSchedule, getSelectedDay(), dayStartHour);
      } else {
        if (selectedMode === 'weekly') {
          exportWeeklyOverview(currentSchedule, dayStartHour, includeDay0);
        } else {
          exportDailyDetail(currentSchedule, getSelectedDay(), dayStartHour);
        }
      }
      status.textContent = '✓ הייצוא הושלם';
      setTimeout(closeModal, 1200);
    } catch (err) {
      console.error('Export error:', err);
      status.textContent = '✗ שגיאה בייצוא';
      status.style.color = '#e74c3c';
    }
  });
}

/** Navigate to a participant's profile view from any clickable name. */
function navigateToProfile(participantId: string): void {
  if (!currentSchedule) return;
  // Save current scroll position for seamless return
  _scheduleScrollY = window.scrollY;
  _viewMode = 'PROFILE_VIEW';
  _profileParticipantId = participantId;
  hideTooltip();
  renderAll();
  window.scrollTo(0, 0);
}

/** Navigate to the per-task panel (grouped by task sourceName). */
function navigateToTaskPanel(sourceName: string): void {
  if (!currentSchedule) return;
  _scheduleScrollY = window.scrollY;
  _viewMode = 'TASK_PANEL_VIEW';
  _taskPanelSourceName = sourceName;
  hideTooltip();
  hideTaskTooltip();
  renderAll();
  window.scrollTo(0, 0);
}

/**
 * Default timestamp for the point-in-time view: live-mode anchor when
 * Live Mode is active AND the anchor falls inside this schedule's op-day
 * range (so it maps to a real day index). Otherwise, day 1 at the
 * schedule's dayStartHour.
 *
 * The fall-back matters because the live-mode anchor is set to "now" at
 * Live Mode toggle time and persists in the live store; a schedule
 * generated for a future date will see that anchor sit before its own
 * periodStart, which would otherwise open the panel on a moment with no
 * meaningful data.
 */
function computeDefaultPointInTime(schedule: Schedule): Date {
  const dsh = schedule.algorithmSettings.dayStartHour;
  const lm = store.getLiveModeState();
  if (lm.enabled) {
    const idx = getAnchorDayIndex(schedule.periodStart, schedule.periodDays, lm.currentTimestamp, dsh);
    if (idx >= 1 && idx <= schedule.periodDays) {
      return new Date(lm.currentTimestamp.getTime());
    }
  }
  const ms = hourInOpDay(schedule.periodStart, dsh, 1, dsh);
  return new Date(ms);
}

/** Open the "Where is everyone now?" point-in-time status view. */
function navigateToPointInTime(): void {
  if (!currentSchedule) return;
  _scheduleScrollY = window.scrollY;
  _pointInTimeTimestamp = computeDefaultPointInTime(currentSchedule);
  _viewMode = 'POINT_IN_TIME_VIEW';
  hideTooltip();
  hideTaskTooltip();
  renderAll();
  window.scrollTo(0, 0);
}

function getAvailableParticipantsInRange(
  schedule: Schedule,
  rangeStartMs: number,
  rangeEndMs: number,
  preMarginMs = 0,
  postMarginMs = 0,
  sleepRecoveryMode: SleepRecoveryMode = 'all',
): {
  participants: Participant[];
  sleepRecoveryIds: Set<string>;
  recoveryWindowsByPid: Map<string, { start: Date; end: Date }[]>;
} {
  const disabledHC = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const hc3Disabled = disabledHC.has('HC-3');
  const hc15Disabled = disabledHC.has('HC-15');
  const taskMap = new Map(schedule.tasks.map((task) => [task.id, task]));
  const participantWindows = new Map<string, { startMs: number; endMs: number }[]>();
  // participantTasks is only used by the HC-15 recovery-window scan; skip
  // building it when HC-15 is disabled.
  const participantTasks = hc15Disabled ? null : new Map<string, Task[]>();
  let orphanAssignments = 0;
  for (const assignment of schedule.assignments) {
    const task = taskMap.get(assignment.taskId);
    if (!task) {
      orphanAssignments++;
      continue;
    }
    if (!participantWindows.has(assignment.participantId)) {
      participantWindows.set(assignment.participantId, []);
    }
    participantWindows.get(assignment.participantId)?.push({
      startMs: task.timeBlock.start.getTime(),
      endMs: task.timeBlock.end.getTime(),
    });
    if (participantTasks) {
      if (!participantTasks.has(assignment.participantId)) {
        participantTasks.set(assignment.participantId, []);
      }
      participantTasks.get(assignment.participantId)?.push(task);
    }
  }
  const effectiveStart = rangeStartMs - preMarginMs;
  const effectiveEnd = rangeEndMs + postMarginMs;
  const effectiveWindow = { start: new Date(effectiveStart), end: new Date(effectiveEnd) };
  const sleepRecoveryIds = new Set<string>();
  const recoveryWindowsByPid = new Map<string, { start: Date; end: Date }[]>();
  const participants: Participant[] = [];

  // Collect every recovery window for `pid` that overlaps [effectiveStart, effectiveEnd).
  const getOverlappingRecoveryWindows = (pid: string): { start: Date; end: Date }[] => {
    if (hc15Disabled || !participantTasks) return [];
    const tasks = participantTasks.get(pid);
    if (!tasks) return [];
    const out: { start: Date; end: Date }[] = [];
    for (const task of tasks) {
      const rw = getRecoveryWindow(task);
      if (!rw) continue;
      if (rw.start.getTime() < effectiveEnd && rw.end.getTime() > effectiveStart) out.push(rw);
    }
    return out;
  };

  for (const participant of schedule.participants) {
    if (sleepRecoveryMode === 'only') {
      // 'only' mode answers "who is in recovery during this range" — busy/HC-3
      // filters don't apply (a participant's triggering task itself can sit at
      // the head of the range). HC-15 disabled → nothing to show.
      if (hc15Disabled) continue;
      const windows = getOverlappingRecoveryWindows(participant.id);
      if (windows.length === 0) continue;
      sleepRecoveryIds.add(participant.id);
      recoveryWindowsByPid.set(participant.id, windows);
      participants.push(participant);
      continue;
    }
    const windows = participantWindows.get(participant.id);
    if (windows?.some((w) => w.startMs < effectiveEnd && w.endMs > effectiveStart)) continue;
    // HC-3: master availability + recurring rules + Future-SOS unavailability.
    // Skipped when HC-3 is in disabledHardConstraints so the inspector mirrors
    // what the engine/manual-build actually allow.
    if (!hc3Disabled && findPreExistingUnavailabilityOverlaps(participant, schedule, effectiveWindow).length > 0) {
      continue;
    }
    // HC-15 sleep-recovery: 😴 tag (or strict drop) for participants whose
    // recovery window overlaps the queried range. Skipped entirely when HC-15
    // is disabled — no tag, no strict-filter effect.
    if (!hc15Disabled && participantTasks) {
      const overlapping = getOverlappingRecoveryWindows(participant.id);
      if (overlapping.length > 0) {
        if (sleepRecoveryMode === 'hide') continue;
        sleepRecoveryIds.add(participant.id);
        recoveryWindowsByPid.set(participant.id, overlapping);
      }
    }
    participants.push(participant);
  }
  if (participants.length === schedule.participants.length && schedule.assignments.length > 0) {
    console.debug('[עתודה] all participants marked free despite existing assignments:', {
      tasks: schedule.tasks.length,
      assignments: schedule.assignments.length,
      participants: schedule.participants.length,
      orphanAssignments,
      rangeStart: new Date(rangeStartMs).toString(),
      rangeEnd: new Date(rangeEndMs).toString(),
    });
  }
  return { participants, sleepRecoveryIds, recoveryWindowsByPid };
}

interface AvailabilityBucket {
  label: string;
  participants: Participant[];
  count: number;
  preview: string;
  className: string;
}

/**
 * Pure bucket builder. Returns the ordered list of buckets to display under
 * the active grouping mode, and a flag for whether the "מופיעים בכמה" overlap
 * section should be rendered (only modes where overlap is possible: pakal,
 * cert).
 *
 * Inputs come from the caller — no live-store reads, no DOM, no module state.
 */
function bucketAvailableParticipants(
  available: Participant[],
  mode: AvailabilityGroupingMode,
  schedule: Schedule,
  pakalDefs: ReturnType<typeof store.getPakalDefinitions>,
  emptyPreviewLabel = 'אין פנויים בטווח',
): { buckets: AvailabilityBucket[]; allowsOverlap: boolean; multiBucketIds: Set<string> } {
  const summarize = (participants: Participant[]): string => {
    if (participants.length === 0) return emptyPreviewLabel;
    const leading = participants.slice(0, 2).map((p) => p.name);
    const remaining = participants.length - leading.length;
    return remaining > 0 ? `${leading.join(', ')} +${remaining}` : leading.join(', ');
  };
  const make = (label: string, ps: Participant[], cls = 'availability-bucket'): AvailabilityBucket => ({
    label,
    participants: ps,
    count: ps.length,
    preview: summarize(ps),
    className: cls,
  });

  if (mode === 'pakal') {
    const pakalsByPid = new Map(available.map((p) => [p.id, getEffectivePakalDefinitions(p, pakalDefs)]));
    const buckets = pakalDefs
      .filter((def) => !def.deleted)
      .map((def) =>
        make(
          def.label,
          available.filter((p) => (pakalsByPid.get(p.id) || []).some((d) => d.id === def.id)),
        ),
      );
    const noPakal = available.filter((p) => (pakalsByPid.get(p.id)?.length ?? 0) === 0);
    const multiIds = new Set(available.filter((p) => (pakalsByPid.get(p.id)?.length ?? 0) > 1).map((p) => p.id));
    const visible = buckets
      .filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'he'));
    const empty = buckets.filter((b) => b.count === 0);
    return {
      buckets: [...visible, make('ללא שיוך לפק"ל', noPakal, 'availability-bucket availability-bucket-none'), ...empty],
      allowsOverlap: true,
      multiBucketIds: multiIds,
    };
  }

  if (mode === 'group') {
    const byKey = new Map<string, Participant[]>();
    for (const p of available) {
      const key = (p.group || '').trim() || '(ללא קבוצה)';
      const arr = byKey.get(key) ?? [];
      arr.push(p);
      byKey.set(key, arr);
    }
    const buckets = Array.from(byKey, ([label, ps]) => make(label, ps)).sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'he'),
    );
    return { buckets, allowsOverlap: false, multiBucketIds: new Set() };
  }

  if (mode === 'level') {
    const order: { level: Level; label: string }[] = [
      { level: Level.L4, label: 'L4' },
      { level: Level.L3, label: 'L3' },
      { level: Level.L2, label: 'L2' },
      { level: Level.L0, label: 'L0' },
    ];
    const buckets = order.map(({ level, label }) =>
      make(
        label,
        available.filter((p) => p.level === level),
      ),
    );
    return { buckets, allowsOverlap: false, multiBucketIds: new Set() };
  }

  // mode === 'cert'
  const certIds = Object.keys(schedule.certLabelSnapshot);
  const certCountByPid = new Map<string, number>();
  for (const p of available) {
    const valid = (p.certifications ?? []).filter((c) => certIds.includes(c));
    certCountByPid.set(p.id, valid.length);
  }
  const buckets = certIds.map((cid) =>
    make(
      schedule.certLabelSnapshot[cid] || cid,
      available.filter((p) => (p.certifications ?? []).includes(cid)),
    ),
  );
  const noCert = available.filter((p) => (certCountByPid.get(p.id) ?? 0) === 0);
  const multiIds = new Set(available.filter((p) => (certCountByPid.get(p.id) ?? 0) > 1).map((p) => p.id));
  const visible = buckets
    .filter((b) => b.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'he'));
  const empty = buckets.filter((b) => b.count === 0);
  return {
    buckets: [...visible, make('ללא הסמכות', noCert, 'availability-bucket availability-bucket-none'), ...empty],
    allowsOverlap: true,
    multiBucketIds: multiIds,
  };
}

const GROUPING_MODE_LABELS: Record<AvailabilityGroupingMode, string> = {
  pakal: 'פק"ל',
  group: 'קבוצה',
  level: 'דרגה',
  cert: 'הסמכה',
};
const GROUPING_MODE_ORDER: AvailabilityGroupingMode[] = ['pakal', 'group', 'level', 'cert'];

function buildAvailabilityPopoverContent(
  startMs: number,
  endMs: number,
  preMarginMs = 0,
  postMarginMs = 0,
  sleepRecoveryMode: SleepRecoveryMode = 'all',
): string {
  if (!currentSchedule) return '';
  const schedule = currentSchedule;
  const pakalDefs = store.getPakalDefinitions();
  const {
    participants: rawAvailable,
    sleepRecoveryIds,
    recoveryWindowsByPid,
  } = getAvailableParticipantsInRange(schedule, startMs, endMs, preMarginMs, postMarginMs, sleepRecoveryMode);
  const onlyMode = sleepRecoveryMode === 'only';
  const emptyPreviewLabel = onlyMode ? 'אין משתתפים בהשלמות בטווח' : 'אין פנויים בטווח';
  const emptyListLabel = onlyMode ? 'אין משתתפים בהשלמות בקבוצה זו.' : 'אין פנויים בקבוצה הזאת.';

  // Apply chip filters BEFORE bucketing. Empty filter set = no constraint;
  // OR within each kind, AND across kinds.
  const available = rawAvailable.filter((p) => {
    if (_availabilityLevelFilter.size > 0 && !_availabilityLevelFilter.has(p.level)) return false;
    if (_availabilityCertFilter.size > 0) {
      const ok = (p.certifications ?? []).some((c) => _availabilityCertFilter.has(c));
      if (!ok) return false;
    }
    if (_availabilityGroupFilter.size > 0) {
      const key = (p.group || '').trim();
      if (!_availabilityGroupFilter.has(key)) return false;
    }
    return true;
  });

  const pakalsByPid = new Map(available.map((p) => [p.id, getEffectivePakalDefinitions(p, pakalDefs)]));
  const { buckets, allowsOverlap, multiBucketIds } = bucketAvailableParticipants(
    available,
    _availabilityGroupingMode,
    schedule,
    pakalDefs,
    emptyPreviewLabel,
  );
  const multiBucketParticipants = available.filter((p) => multiBucketIds.has(p.id));

  // In 'only' mode, sort participants chronologically by their earliest
  // overlapping recovery start. Stable secondary sort by name (Hebrew locale).
  const recoveryStartByPid = new Map<string, number>();
  if (onlyMode) {
    for (const [pid, wins] of recoveryWindowsByPid) {
      let earliest = Infinity;
      for (const w of wins) {
        const t = w.start.getTime();
        if (t < earliest) earliest = t;
      }
      recoveryStartByPid.set(pid, earliest);
    }
  }
  const sortForRender = (list: Participant[]): Participant[] => {
    if (!onlyMode) return list;
    return [...list].sort((a, b) => {
      const sa = recoveryStartByPid.get(a.id) ?? Infinity;
      const sb = recoveryStartByPid.get(b.id) ?? Infinity;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name, 'he');
    });
  };

  const renderParticipantList = (participants: Participant[]): string => {
    if (participants.length === 0) return `<div class="availability-empty">${escHtml(emptyListLabel)}</div>`;
    const ordered = sortForRender(participants);
    return `<div class="availability-name-list">${ordered
      .map((p) => {
        const pakalCount = pakalsByPid.get(p.id)?.length ?? 0;
        const inRecovery = sleepRecoveryIds.has(p.id);
        const recoveryBadge = inRecovery
          ? `<span class="badge badge-sm availability-sleep-tag" title="בהשלמות שינה והתאוששות">😴</span>`
          : '';
        const pakalBadge =
          pakalCount > 1 ? `<span class="badge badge-sm availability-multi-tag">${pakalCount} פק"לים</span>` : '';
        const levelBadge = `<span class="badge badge-sm avail-row-level">L${p.level}</span>`;
        const groupLabel = p.group ? `<span class="avail-row-group">${escHtml(p.group)}</span>` : '';
        // Inline recovery-window label only in 'only' mode — in 'all' the 😴
        // badge is enough; piling the times on every row clutters that view.
        let recoveryWindowLabel = '';
        if (onlyMode) {
          const wins = recoveryWindowsByPid.get(p.id);
          if (wins && wins.length > 0) {
            const text = wins.map((w) => fmtRecoveryWindow(w, schedule)).join(', ');
            recoveryWindowLabel = `<span class="availability-recovery-window" dir="ltr" title="חלון השלמת שינה והתאוששות">${escHtml(text)}</span>`;
          }
        }
        return `<div class="availability-name-row"><span class="participant-hover" data-pid="${p.id}">${escHtml(p.name)}</span>${levelBadge}${groupLabel}${recoveryBadge}${recoveryWindowLabel}${pakalBadge}</div>`;
      })
      .join('')}</div>`;
  };

  const renderBucket = (bucket: AvailabilityBucket): string => {
    const bucketLabel = escHtml(bucket.label);
    const preview = escHtml(bucket.preview);
    if (bucket.count === 0) {
      return `<div class="${bucket.className} availability-bucket-empty availability-bucket-zero"><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">${escHtml(emptyPreviewLabel)}</span></span><span class="availability-bucket-count">0</span></div>`;
    }
    return `<details class="${bucket.className}">
      <summary><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">${preview}</span></span><span class="availability-bucket-count">${bucket.count}</span></summary>
      ${renderParticipantList(bucket.participants)}
    </details>`;
  };

  const modeLabel = GROUPING_MODE_LABELS[_availabilityGroupingMode];
  const groupingTabs = GROUPING_MODE_ORDER.map(
    (m) =>
      `<button class="avail-strip-group-tab ${m === _availabilityGroupingMode ? 'avail-strip-group-tab-active' : ''}" data-grouping-mode="${m}" role="tab">${GROUPING_MODE_LABELS[m]}</button>`,
  ).join('');

  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const subtitle = `${fmt(startDate)} — ${fmt(endDate)}`;

  const overlapSection =
    allowsOverlap && multiBucketParticipants.length > 0
      ? `<details class="availability-overlap">
        <summary><span class="availability-bucket-main"><span class="availability-bucket-label">מופיעים בכמה ${modeLabel === 'הסמכה' ? 'הסמכות' : 'פק"לים'}</span><span class="availability-bucket-preview">כדאי לבדוק אותם קודם</span></span><span class="availability-bucket-count">${multiBucketParticipants.length}</span></summary>
        <div class="availability-overlap-note">המשתתפים כאן כבר נספרו בפירוט שלמעלה. הרשימה הזאת עוזרת לזהות חפיפות.</div>
        ${renderParticipantList(multiBucketParticipants)}
      </details>`
      : '';

  const headerTitle = onlyMode ? `בהשלמות שינה לפי ${modeLabel}` : `פנויים לפי ${modeLabel}`;
  const totalStrong = onlyMode
    ? available.length === 0
      ? 'אין משתתפים בהשלמות'
      : 'משתתפים בהשלמות שינה'
    : available.length === 0
      ? 'אין עתודה פנויה'
      : 'עתודה פנויה';
  const totalSub = onlyMode ? 'מספר המשתתפים שחלון ההשלמה שלהם חופף לטווח.' : 'מספר המשתתפים שפנויים לאורך כל הטווח.';

  return `
    <div class="availability-popover-header">
      <div>
        <h3>${headerTitle}</h3>
        <div class="availability-popover-subtitle">${subtitle}</div>
        ${preMarginMs > 0 || postMarginMs > 0 ? `<div class="availability-popover-margin-note">מרווח: ${preMarginMs / 3600000} שעות לפני, ${postMarginMs / 3600000} שעות אחרי</div>` : ''}
      </div>
      <button class="btn-sm btn-outline availability-close" data-action="close-availability-popover">סגור</button>
    </div>
    <div class="availability-popover-body">
      <div class="availability-overview">
        <div class="availability-total-card">
          <span class="availability-total-count">${available.length}</span>
          <div class="availability-total-copy">
            <strong>${totalStrong}</strong>
            <span>${totalSub}</span>
          </div>
        </div>
      </div>
      <div class="avail-strip-group-tabs" role="tablist">${groupingTabs}</div>
      <div class="availability-bucket-list">
        ${buckets.map(renderBucket).join('')}
      </div>
      ${overlapSection}
    </div>
  `;
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Store-change subscriber — called by config-store.notify() after every
 * mutation. The displayed schedule is a frozen snapshot: we never mutate
 * its data here. External edits only flip the dirty flag so the existing
 * warning prompts the user to regenerate.
 */
function onStoreChanged(): void {
  // Never mess with schedule during optimization
  if (_isOptimizing) return;

  // During undo/redo the schedule is restored from the parallel stack
  // in doUndoRedo(), so skip here.
  if (_undoRedoInProgress) return;

  // Tutorial demo bulk-loads/restores by calling store APIs in a loop;
  // the snapshot+restore flow handles undo state itself.
  if (_suppressOnStoreChanged) return;

  // Push pre-change schedule so undo can restore it alongside the store's
  // undo stack. Capture dirty flag pre-mutation.
  _scheduleUndoStack.push({
    schedule: currentSchedule ? structuredClone(currentSchedule) : null,
    dirty: _scheduleDirty,
  });
  if (_scheduleUndoStack.length > 80) _scheduleUndoStack.shift();
  _scheduleRedoStack.length = 0;

  if (!currentSchedule) return;

  _scheduleDirty = true;
}

// ─── Tutorial demo-mode hooks ────────────────────────────────────────────────

/** Reconstruct (or clear) the live engine + schedule from a saved frozen
 *  snapshot. Mirrors the loader path inside `init()`. Passing `null` clears
 *  both — used on tour exit when the user had no schedule before. */
function loadScheduleFromFrozen(saved: Schedule | null): void {
  if (!saved || !hasFrozenFields(saved)) {
    engine = null;
    currentSchedule = null;
    return;
  }
  const frozen = saved.algorithmSettings;
  engine = new SchedulingEngine(
    frozen.config,
    new Set(frozen.disabledHardConstraints),
    new Map(Object.entries(saved.restRuleSnapshot)),
    frozen.dayStartHour,
    frozen.splittingMode ?? 'quality',
  );
  engine.setCertLabelSnapshot(saved.certLabelSnapshot);
  engine.setPeriod(saved.periodStart, saved.periodDays);
  engine.addParticipants(saved.participants);
  engine.addTasks(saved.tasks);
  engine.importSchedule(saved);
  engine.revalidateFull();
  currentSchedule = engine.getSchedule()!;
  const liveMode = store.getLiveModeState();
  if (liveMode.enabled) freezeAssignments(currentSchedule, liveMode.currentTimestamp);
}

interface AppStateSnapshotJson {
  currentTab: TabId;
  currentDay: number;
  viewMode: ViewMode;
  profileParticipantId: string | null;
  taskPanelSourceName: string | null;
  continuityJson: string;
  sidebarCollapsed: boolean;
  scheduleDirty: boolean;
  snapshotDirty: boolean;
  hash: string;
}

function getAppStateSnapshot(): AppStateSnapshotJson {
  return {
    currentTab,
    currentDay,
    viewMode: _viewMode,
    profileParticipantId: _profileParticipantId,
    taskPanelSourceName: _taskPanelSourceName,
    continuityJson: _continuityJson,
    sidebarCollapsed: _sidebarCollapsed,
    scheduleDirty: _scheduleDirty,
    snapshotDirty: _snapshotDirty,
    hash: location.hash,
  };
}

function applyAppStateSnapshot(s: AppStateSnapshotJson): void {
  currentTab = s.currentTab;
  currentDay = s.currentDay;
  _viewMode = s.viewMode;
  _profileParticipantId = s.profileParticipantId;
  _taskPanelSourceName = s.taskPanelSourceName;
  _continuityJson = s.continuityJson;
  _sidebarCollapsed = s.sidebarCollapsed;
  _scheduleDirty = s.scheduleDirty;
  _snapshotDirty = s.snapshotDirty;
  // Reset per-tab view state so demo-time interactions (filter on "קבוצה 1",
  // expanded template card, open snapshot panel) don't leak into the
  // post-tour view of the user's real data.
  resetParticipantsTabViewState();
  resetTaskRulesTabViewState();
  // Replace, don't push — we don't want the demo→user transition to leave
  // a back-stack entry pointing at the demo url.
  if (s.hash && s.hash !== location.hash) {
    history.replaceState(null, '', s.hash);
  }
}

function setUiForDemo(): void {
  currentTab = 'schedule';
  currentDay = 1;
  _viewMode = 'SCHEDULE_VIEW';
  _profileParticipantId = null;
  _taskPanelSourceName = null;
  _continuityJson = '';
  _scheduleDirty = false;
  _snapshotDirty = false;
  _manualBuildActive = false;
  clearManualSelection();
  _undoStack = [];
  _scheduleUndoStack.length = 0;
  _scheduleRedoStack.length = 0;
  // Reset per-tab view state so a filter/sort/expansion left from the user's
  // pre-tour session doesn't carry into the demo view (e.g. the participants
  // tab showing only "קבוצה 1" because the user filtered there earlier).
  resetParticipantsTabViewState();
  resetTaskRulesTabViewState();
  // Drop URL hash entirely while in demo — restore on exit overrides it.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

/**
 * Android Web Share Target consumer. When a user shares an exported file to
 * the installed PWA, the service worker (public/sw.js) stashes the file text
 * in Cache Storage and redirects here with `?share-target=pending`. Pull the
 * stashed text, delete it, strip the query param, then run the normal import
 * routing — identical to the user picking the file via the in-app Import
 * button. Invalid/empty/missing payloads degrade silently or via the existing
 * Hebrew validation error in `routeImportFromString`. One-shot: the URL param
 * is cleared on every path and the cache key deleted, so a refresh or
 * back/forward cannot replay the import.
 */
async function consumePendingSharedImport(): Promise<void> {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('share-target') !== 'pending') return;

    // Inverse of the setUiForDemo() precedent: there the hash is dropped and
    // search kept; here the query param is dropped and the hash kept.
    const clearUrl = () => history.replaceState(null, '', location.pathname + location.hash);

    if (!('caches' in window)) {
      clearUrl();
      return;
    }

    const resp = await caches.match('./__shared_import__');
    if (!resp) {
      clearUrl();
      return; // SW didn't stash (no SW yet / failed) — silent no-op
    }

    const text = await resp.text();
    try {
      const cache = await caches.open('garden-manager-v3');
      await cache.delete(new Request('./__shared_import__'));
    } catch {
      /* best-effort cleanup — a stale entry is harmless, key is overwritten next share */
    }
    clearUrl();

    if (!text?.trim()) return; // empty payload — silent no-op
    await routeImportFromString(text);
  } catch (e) {
    console.error('Shared import failed:', e);
  }
}

function init(): void {
  // --- Global error safety net ---
  window.onerror = (_msg, _src, _line, _col, err) => {
    console.error('Unhandled error:', err ?? _msg);
    showToast('שגיאה לא צפויה — נסה לרענן את הדף', { type: 'error', duration: 6000 });
  };

  window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled promise rejection:', e.reason);
    showToast('שגיאה לא צפויה — נסה לרענן את הדף', { type: 'error', duration: 6000 });
  });

  try {
    // Capture beforeinstallprompt as early as possible — it's a one-shot
    // event and powers both the "install to receive shared files" nudge
    // and the persistent Home install panel. The onChange callback re-renders
    // Home immediately when the deferred prompt arrives late or when the
    // user finishes installing — otherwise the panel would lag behind real
    // install state until the next user-triggered render.
    initPwaInstallCapture(() => {
      if (currentTab === 'home') renderAll();
    });

    // Set .touch-device / .pointer-device on <html> before first render
    initResponsive();

    // Trap keyboard focus inside any element carrying aria-modal="true".
    // Modals all bear that attribute; this is the single shared mechanism
    // — no per-modal wiring needed.
    installFocusTrap();

    // Keyboard activation for `.participant-hover` spans. They are rendered
    // with role="button" tabindex="0" (layout-engine.ts) so they take focus,
    // but the multiple click handlers across app.ts are click-only. One
    // document-level Enter/Space → navigateToProfile listener restores
    // keyboard parity site-wide without touching every click site.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = (e.target as HTMLElement | null)?.closest('.participant-hover[data-pid]') as HTMLElement | null;
      if (!target?.dataset.pid) return;
      e.preventDefault();
      navigateToProfile(target.dataset.pid);
    });

    // Re-render when crossing the phone breakpoint so the schedule swaps
    // between mobile (swimlane-only) and desktop (swimlane + Gantt) layouts.
    onSmallScreenChange(() => renderAll());

    // Day 0 is read-only context. Wrap mutating callbacks so any swimlane or
    // tooltip path that funnels through them is no-op'd with a toast — covers
    // swap, rescue, future-SOS, drag-equivalent flows.
    const guardDay0 = <T extends unknown[]>(fn: (...args: T) => void) => {
      return (...args: T): void => {
        if (currentDay === 0) {
          showToast('פעולה לא זמינה ביום 0 — תצוגת הקשר בלבד', { type: 'info' });
          return;
        }
        fn(...args);
      };
    };

    // Swimlane callbacks — same handlers the schedule grid uses, so taps in
    // the swimlane invoke identical flows (rescue, swap, profile, task panel).
    initSwimlane({
      onSwap: guardDay0(handleSwap),
      onRescue: guardDay0(handleSosRescue),
      onNavigateToProfile: navigateToProfile,
      onNavigateToTaskPanel: navigateToTaskPanel,
      getSchedule: () => currentSchedule,
      getDayIndex: () => currentDay,
      getLiveMode: () => store.getLiveModeState(),
    });

    // Initialize tooltip callbacks before first render
    initTooltips({
      onSwap: guardDay0(handleSwap),
      onRescue: guardDay0(handleSosRescue),
      onNavigateToProfile: navigateToProfile,
    });

    initWorkloadPopup({
      onNavigateToProfile: navigateToProfile,
    });

    // Inject the live template-expansion into the auto-tuner so it can
    // build identical tasks without importing app.ts (avoids a cycle).
    setAutoTunerTaskFactory(() => generateTasksFromTemplates());

    // Listen for auto-tune button clicks from the algorithm tab.
    document.addEventListener('gm:auto-tune-request', () => {
      void handleAutoTune();
    });

    // Listen for "open task panel" requests from the mobile task tooltip CTA.
    document.addEventListener('gm:open-task-panel', (e: Event) => {
      const detail = (e as CustomEvent<{ sourceName?: string }>).detail;
      if (detail?.sourceName) navigateToTaskPanel(detail.sourceName);
    });

    // Initialize emergency-task injection modal callbacks
    initInjectTaskModal({
      getSchedule: () => currentSchedule,
      getEngine: () => engine,
      onCommit: (updatedSchedule, _report, saveToStore, spec) => {
        // Push undo snapshot BEFORE committing — includes the injected task so
        // a single undo reverts the injection cleanly.
        if (currentSchedule) {
          _scheduleUndoStack.push({
            schedule: structuredClone(currentSchedule),
            dirty: _scheduleDirty,
          });
          if (_scheduleUndoStack.length > 80) _scheduleUndoStack.shift();
          _scheduleRedoStack.length = 0;
          store.pushUndoCheckpoint();
        }

        // Optionally persist to the live store so future regenerations
        // include this task. We intentionally do NOT mark _scheduleDirty —
        // the injected task in the snapshot already has sourceName matching
        // the new OT, and scheduleHasOrphans() ignores injectedPostGeneration.
        if (saveToStore) {
          const day = new Date(
            updatedSchedule.periodStart.getFullYear(),
            updatedSchedule.periodStart.getMonth(),
            updatedSchedule.periodStart.getDate() + (spec.dayIndex - 1),
          );
          store.addOneTimeTask({
            name: spec.name,
            scheduledDate: day,
            startHour: spec.startHour,
            startMinute: spec.startMinute,
            durationHours: spec.durationHours,
            subTeams: spec.subTeams,
            slots: spec.slots,
            sameGroupRequired: spec.sameGroupRequired,
            blocksConsecutive: spec.blocksConsecutive,
            baseLoadWeight: spec.baseLoadWeight,
            loadWindows: spec.loadWindows,
            schedulingPriority: spec.schedulingPriority,
            togethernessRelevant: spec.togethernessRelevant,
            restRuleId: spec.restRuleId,
            color: spec.color,
            description: spec.description,
          });
        }

        // Commit: revalidateFull, persist schedule, re-render. onStoreChanged
        // would have set _scheduleDirty=true if we added an OT — but the
        // injected task in the snapshot covers it, so clear it back.
        const dirtyBefore = _scheduleDirty;
        currentSchedule = updatedSchedule;
        revalidateAndRefresh();
        _scheduleDirty = dirtyBefore;

        showToast(`משימת חירום "${spec.name}" נוספה לשבצ״ק${saveToStore ? ' ונשמרה במסך המשימות' : ''}.`, {
          type: 'success',
          duration: 5000,
          action: {
            label: 'בטל',
            callback: () => doUndoRedo('undo'),
          },
        });
      },
    });

    // Initialize rescue modal callbacks
    initRescue({
      getSchedule: () => currentSchedule,
      getEngine: () => engine,
      onPlanApplied: (updatedSchedule, swapLabels, swappedAssignmentIds, recordVacatedSlot) => {
        if (currentSchedule) {
          _scheduleUndoStack.push({
            schedule: structuredClone(currentSchedule),
            dirty: _scheduleDirty,
          });
          if (_scheduleUndoStack.length > 80) _scheduleUndoStack.shift();
          _scheduleRedoStack.length = 0;
          store.pushUndoCheckpoint();
        }
        currentSchedule = updatedSchedule;
        // After the undo snapshot is pushed (so undo restores the pre-record
        // unavailability set), upsert the optional "mark vacated participant
        // unavailable for this slot's time" entry. Skipped automatically when
        // the slot is fully in the past — past windows can't constrain
        // future planning.
        if (recordVacatedSlot && currentSchedule) {
          const liveAnchor = store.getLiveModeState().currentTimestamp ?? new Date();
          if (recordVacatedSlot.end.getTime() > liveAnchor.getTime()) {
            currentSchedule.scheduleUnavailability = upsertScheduleUnavailability(
              currentSchedule.scheduleUnavailability,
              {
                id: `replaced-${Date.now()}-${recordVacatedSlot.participantId}`,
                participantId: recordVacatedSlot.participantId,
                start: recordVacatedSlot.start,
                end: recordVacatedSlot.end,
                createdAt: new Date(),
                anchorAtCreation: liveAnchor,
                appliedSwapCount: swappedAssignmentIds.length,
                reason: recordVacatedSlot.reason,
              },
            );
          }
        }
        for (const id of swappedAssignmentIds) _pendingSwapAnimIds.add(id);
        revalidateAndRefresh();

        for (const sl of swapLabels) {
          showToast(sl.label, {
            type: 'success',
            duration: 5000,
            action: {
              label: 'בטל',
              callback: () => {
                doUndoRedo('undo');
              },
            },
          });
        }
      },
      onPlanFailed: () => {
        revalidateAndRefresh();
      },
    });

    // Apply saved theme before first render to prevent flash
    applyTheme(getStoredTheme());

    // Register the cross-module hooks that `tutorial-demo.ts` reaches into
    // (snapshot/restore app state, swap out the live schedule, etc.). Done
    // before `initStore` so a backup-restore is in place if needed.
    registerTutorialHooks({
      getAppStateSnapshot,
      applyAppStateSnapshot,
      loadScheduleFromFrozen,
      generateTasksFromTemplates,
      setSuppressOnStoreChanged: (v: boolean) => {
        _suppressOnStoreChanged = v;
      },
      isManualBuildActive: () => _manualBuildActive,
      hasFrozenFields,
      setUiForDemo,
      renderAll,
    });

    // Mid-tour reload: if the previous session was interrupted while the
    // tutorial demo state was loaded, restore the user's snapshot before
    // any code below reads from localStorage. The user sees their own
    // data — no toast, no friction.
    restoreTutorialBackupIfPresent();

    store.initStore();
    store.subscribe(onStoreChanged);
    store.subscribeAlgorithmChange(() => {
      if (currentSchedule) _scheduleDirty = true;
    });
    store.setSaveErrorHandler((_err, info) => {
      // reportSaveError() in config-store already throttles invocations to at
      // most once per ~15s, so this is safe to call directly. Use a distinct
      // message for quota-exceeded so the user knows what action to take.
      if (info.isQuota) {
        showToast('נפח האחסון בדפדפן מלא — מחק תמונות-מצב או סטים ישנים כדי להמשיך לשמור.', {
          type: 'error',
          duration: 8000,
        });
      } else {
        showToast('שמירת נתונים נכשלה — ייתכן שהדפדפן חסם אחסון מקומי', { type: 'error', duration: 5000 });
      }
    });

    // Restore tab/day from URL hash so mid-work reloads keep context
    readHash();

    // Restore persisted schedule (if any) so it survives page reloads
    const savedSchedule = store.loadSchedule();

    // First-launch seed of the Day 0 continuity buffer: if there's no saved
    // schedule and the user hasn't pasted/cleared a snapshot yet, populate
    // _continuityJson from the bundled default so HC-5/HC-12/HC-14 cross-
    // boundary phantom enforcement is exercised out of the box. The snapshot
    // is embedded into Schedule.continuitySnapshot at generation time.
    if (!savedSchedule && _continuityJson === '') {
      const defaultJson = store.getDefaultContinuityJson();
      if (defaultJson) _continuityJson = defaultJson;
    }
    if (savedSchedule && !hasFrozenFields(savedSchedule)) {
      // Stale pre-schema schedule: drop it and tell the user to regenerate.
      // Pre-release; no migration path supported.
      store.clearSchedule();
      showToast('שבצ"ק ישן זוהה ונמחק. יש ליצור שבצ"ק חדש.', { type: 'warning', duration: 6000 });
    } else if (savedSchedule) {
      // Use the schedule's embedded frozen settings — never consult the live
      // store here. External edits since the last generation are captured by
      // the orphan check below and surface via the dirty warning.
      const frozen = savedSchedule.algorithmSettings;
      engine = new SchedulingEngine(
        frozen.config,
        new Set(frozen.disabledHardConstraints),
        new Map(Object.entries(savedSchedule.restRuleSnapshot)),
        frozen.dayStartHour,
        frozen.splittingMode ?? 'quality',
      );
      engine.setCertLabelSnapshot(savedSchedule.certLabelSnapshot);
      engine.setPeriod(savedSchedule.periodStart, savedSchedule.periodDays);
      engine.addParticipants(savedSchedule.participants);
      engine.addTasks(savedSchedule.tasks);
      engine.importSchedule(savedSchedule);
      engine.revalidateFull();
      currentSchedule = engine.getSchedule()!;
      currentDay = 1;
      _scheduleDirty = scheduleHasOrphans(savedSchedule);

      // Apply live mode freeze if active
      const liveMode = store.getLiveModeState();
      if (liveMode.enabled) {
        freezeAssignments(currentSchedule, liveMode.currentTimestamp);
      }
    }

    renderAll();

    // Expose programmatic tutorial entry (used by Playwright specs and deep links).
    exposeTutorialWindowApi(tutorialContext);

    // First-launch tutorial banner. The Home screen has its own integrated
    // first-run welcome (see renderHomeTab firstRun), so the generic banner is
    // suppressed when Home is the landing tab — it only appears if the app
    // deep-links straight to another tab on first run. Dismissed-flag rationale:
    // seedDefaults() writes state synchronously on first launch, so "no state"
    // is an unreliable "new user" proxy. Factory reset clears the flag.
    if (currentTab !== 'home' && !isTutorialBannerDismissed()) {
      showTutorialBanner(tutorialContext);
    }

    // Web Share Target: if the app was launched by sharing an exported file to
    // it, run the import now (store + schedule loaded, UI rendered → bottom
    // sheet renders correctly). Fire-and-forget; it self-clears the URL flag.
    void consumePendingSharedImport();

    // Update the live clock every 30 seconds without a full re-render
    if (_liveClockInterval) clearInterval(_liveClockInterval);
    _liveClockInterval = setInterval(() => {
      const el = document.getElementById('live-clock');
      if (el) el.textContent = formatLiveClock();
    }, 30_000);

    // Sync tab/day when user navigates with browser back/forward, or when
    // an in-page link (e.g. the continuity chip → #schedule/0) changes the
    // hash without going through pushHash().
    window.addEventListener('popstate', () => {
      readHash();
      renderAll();
    });
    window.addEventListener('hashchange', () => {
      readHash();
      renderAll();
    });

    // Flush any pending debounced save on page unload to prevent data loss
    window.addEventListener('beforeunload', (e) => {
      store.flushPendingSave();
      if (_isOptimizing) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  } catch (err) {
    console.error('Init failed:', err);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML =
        '<div style="text-align:center;padding:2rem;font-size:1.2rem;color:#b00">שגיאה באתחול האפליקציה — נסה לרענן את הדף</div>';
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
