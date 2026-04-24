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

import './style.css';
import './style-mobile.css';
import { getRecoveryWindow } from '../constraints/sleep-recovery';
import {
  computeEffectiveUnavailabilityWindows,
  findAffectedAssignments,
  generateBatchRescuePlans,
  upsertScheduleUnavailability,
} from '../engine/future-sos';
import { buildPhantomContext } from '../engine/phantom';
import {
  freezeAssignments,
  isDayFrozen,
  isDayPartiallyFrozen,
  isFutureTask,
  isModifiableAssignment,
  unfreezeAll,
} from '../engine/temporal';
import { getEligibleParticipantsForSlot, getRejectionReason, REJECTION_REASONS_HE } from '../engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  Level,
  LiveModeState,
  type Participant,
  type Schedule,
  SchedulingEngine,
  type SlotRequirement,
  type Task,
  ViolationSeverity,
} from '../index';
import { generateShiftBlocks } from '../shared/utils/time-utils';
import { scheduleToGantt } from '../ui/gantt-bridge';
import { hebrewDayName } from '../utils/date-utils';
import { runAutoTune, setAutoTunerTaskFactory, type TuneRecommendation } from './auto-tuner';
import * as store from './config-store';
import { exportDaySnapshot } from './continuity-export';
import { parseContinuitySnapshot } from './continuity-import';
import { wireDataTransferEvents } from './data-transfer-ui';
import { exportDailyExcel, exportWeeklyExcel } from './excel-export';
import { openBatchPlansModal, openConfirmModal } from './future-sos-modal';
import { closeInjectTaskModal, initInjectTaskModal, openInjectTaskModal } from './inject-task-modal';
import { getEffectivePakalDefinitions } from './pakal-utils';
import { renderParticipantCard } from './participant-card';
import { exportDailyDetail, exportWeeklyOverview } from './pdf-export';
import { runPreflight } from './preflight';
import { showRangePicker } from './range-picker-modal';
import { closeRescueModal, initRescue, openRescueModal, type RescueSwapLabel } from './rescue-modal';
import { initResponsive, isSmallScreen, isTouchDevice } from './responsive';
import { renderScheduleGrid } from './schedule-grid-view';
import {
  computePerDayHours,
  filterVisibleViolations,
  fmtDate,
  formatLiveClock,
  getDayWindow,
  operationalHourOrder,
  resolveLogicalDayTimestamp,
  statusBadge,
  taskEndsAfter,
  taskIntersectsDay,
  taskStartsBefore,
  violationLabel,
} from './schedule-utils';
import { openSwapPicker } from './swap-picker';
import { renderAlgorithmTab, wireAlgorithmEvents } from './tab-algorithm';
import {
  canLeaveParticipantsTab,
  clearParticipantSelection,
  renderParticipantsTab,
  wireParticipantsEvents,
} from './tab-participants';
import { type ProfileContext, renderProfileView, wireProfileEvents } from './tab-profile';
import { renderTaskPanel, TASK_PANEL_EMPTY, type TaskPanelContext, wireTaskPanelEvents } from './tab-task-panel';
import { renderTaskRulesTab, wireTaskRulesEvents } from './tab-task-rules';
import { hideTaskTooltip, hideTooltip, initTooltips, wireParticipantTooltip, wireTaskTooltip } from './tooltips';
import {
  applyTheme,
  certBadges,
  escHtml,
  fmt,
  getStoredDefaultAttempts,
  getStoredTheme,
  groupBadge,
  levelBadge,
  SVG_ICONS,
  taskBadge,
} from './ui-helpers';
import {
  renderCustomSelect,
  showAlert,
  showBottomSheet,
  showConfirm,
  showContinuityImport,
  showPrompt,
  showTimePicker,
  showToast,
  wireCustomSelect,
} from './ui-modal';
import { openWorkloadPopup } from './workload-popup';
import { computeWeeklyWorkloads } from './workload-utils';

// ─── Globals ─────────────────────────────────────────────────────────────────

type TabId = 'participants' | 'task-rules' | 'schedule' | 'algorithm';
const VALID_TABS = new Set<TabId>(['participants', 'task-rules', 'schedule', 'algorithm']);

let currentTab: TabId = 'participants';
let engine: SchedulingEngine | null = null;
let currentSchedule: Schedule | null = null;
let scheduleElapsed = 0;
let scheduleActualAttempts = 0;
/** Currently viewed day (1–7). Always a specific day when schedule is shown. */
let currentDay = 1;

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
    if (d >= 1 && d <= 7) currentDay = d;
  }
}
/** True while multi-attempt optimization is running */
let _isOptimizing = false;
/** AbortController for cancelling a running optimization */
let _optimAbortController: AbortController | null = null;
/** AbortController for stopping early and accepting the best result so far */
let _optimEarlyStopController: AbortController | null = null;
/** True while undo/redo is executing — prevents onStoreChanged from reconciling */
let _undoRedoInProgress = false;
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
let _availabilityPopoverEl: HTMLElement | null = null;
let _availabilityPopoverKeyHandler: ((e: KeyboardEvent) => void) | null = null;
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

// Margin toggle + values
let _availabilityMarginEnabled = false;
let _availabilityPreMarginHours = 2;
let _availabilityPostMarginHours = 1;
// Strict sleep-recovery filter (off by default — resting participants are shown
// with a 😴 badge so SOS/rescue triage can still see them).
let _availabilityHideSleepRecovery = false;

// Two-click cell range selection
let _timeCellSelectionPhase: 'idle' | 'start-selected' = 'idle';
let _timeCellSelectionStartMs: number | null = null;
let _liveClockInterval: ReturnType<typeof setInterval> | null = null;

// ─── View Router ─────────────────────────────────────────────────────────────

type ViewMode = 'SCHEDULE_VIEW' | 'PROFILE_VIEW' | 'TASK_PANEL_VIEW';
let _viewMode: ViewMode = 'SCHEDULE_VIEW';
let _profileParticipantId: string | null = null;
/** Source name of the task currently shown in the per-task panel (null when not in TASK_PANEL_VIEW). */
let _taskPanelSourceName: string | null = null;
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
  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const dayStartHour = store.getDayStartHour();
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
    const m = v.match(/^(\d{1,2}):/);
    const h = m ? Math.max(0, Math.min(23, parseInt(m[1], 10))) : dayStartHour;
    return `${String(h).padStart(2, '0')}:00`;
  };
  _availabilityInspectorTimeStart = normalizeHourLabel(_availabilityInspectorTimeStart);
  _availabilityInspectorTimeEnd = normalizeHourLabel(_availabilityInspectorTimeEnd);

  const makeDayOptions = (selectedDay: number) => {
    const opts: { value: string; label: string; selected: boolean }[] = [];
    for (let d = 1; d <= numDays; d++) {
      const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
      opts.push({
        value: String(d),
        label: `יום ${d} · ${hebrewDayName(date)}`,
        selected: d === selectedDay,
      });
    }
    return opts;
  };

  const makeHourOptions = (selectedTime: string) =>
    operationalHourOrder(dayStartHour).map((h) => {
      const label = `${String(h).padStart(2, '0')}:00`;
      return { value: label, label, selected: label === selectedTime };
    });

  const marginDisplay = _availabilityMarginEnabled ? '' : ' style="display:none"';

  return `
    <div class="avail-strip-inputs-row">
      <span class="avail-strip-range-label">מ:</span>
      ${renderCustomSelect({ id: 'gm-availability-day-start', options: makeDayOptions(selectedDayStart), className: 'input-sm availability-day-select' })}
      ${renderCustomSelect({ id: 'gm-availability-time-start', options: makeHourOptions(_availabilityInspectorTimeStart), className: 'input-sm availability-time-input' })}
      <span class="avail-strip-range-sep">—</span>
      <span class="avail-strip-range-label">עד:</span>
      ${renderCustomSelect({ id: 'gm-availability-day-end', options: makeDayOptions(selectedDayEnd), className: 'input-sm availability-day-select' })}
      ${renderCustomSelect({ id: 'gm-availability-time-end', options: makeHourOptions(_availabilityInspectorTimeEnd), className: 'input-sm availability-time-input' })}
      <button class="btn-sm btn-primary" id="btn-open-availability-inspector" title="בדיקת זמינות לפי טווח">הצג זמינות</button>
    </div>
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
    <div class="avail-strip-margin-row">
      <label class="avail-strip-margin-toggle">
        <input type="checkbox" id="gm-availability-hide-sleep-recovery" ${_availabilityHideSleepRecovery ? 'checked' : ''} />
        <span>ללא השלמות שינה והתאוששות</span>
      </label>
    </div>
  `;
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
    html += `<div class="avail-strip-results">${buildAvailabilityPopoverContent(_availabilityRangeStartMs, _availabilityRangeEndMs, preMs, postMs, _availabilityHideSleepRecovery)}</div>`;
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
  const templates = store.getAllTaskTemplates();
  const visuals = store.getTemplateVisualMap();
  const allTasks: Task[] = [];
  _tSlotCounter = 0;
  _tTaskCounter = 0;

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) {
        console.warn(
          `Template "${tpl.name}" has invalid shiftsPerDay (${tpl.shiftsPerDay}) or durationHours (${tpl.durationHours}) — skipping`,
        );
        continue;
      }
      const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);

      let shifts: { start: Date; end: Date }[];
      if (tpl.eveningStartHour !== undefined && tpl.shiftsPerDay === 2) {
        const morningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);
        const morningEnd = new Date(morningStart.getTime() + tpl.durationHours * 3600000);
        const eveHour = tpl.eveningStartHour ?? 17;
        const eveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eveHour, 0);
        const eveningEnd = new Date(eveningStart.getTime() + tpl.durationHours * 3600000);
        shifts = [
          { start: morningStart, end: morningEnd },
          { start: eveningStart, end: eveningEnd },
        ];
      } else if (tpl.shiftsPerDay === 1) {
        shifts = [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }];
      } else {
        shifts = generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);
      }

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
          sleepRecovery: tpl.sleepRecovery ? { ...tpl.sleepRecovery } : undefined,
          displayCategory: tpl.displayCategory,
          color: tpl.color || v?.color || '#7f8c8d',
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

    const start = new Date(otDay.getFullYear(), otDay.getMonth(), otDay.getDate(), ot.startHour, ot.startMinute || 0);
    const end = new Date(start.getTime() + ot.durationHours * 3600000);

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
      sleepRecovery: ot.sleepRecovery ? { ...ot.sleepRecovery } : undefined,
      displayCategory: ot.displayCategory,
      color: ot.color || '#7f8c8d',
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

/** Render the day navigation tabs (Day 1 – Day 7) */
function renderDayNavigator(): string {
  // Display path: prefer the frozen schedule's period so the navigator stays
  // consistent with the rendered schedule even if the live store drifts.
  const numDays = currentSchedule?.periodDays ?? store.getScheduleDays();
  const baseDate = currentSchedule?.periodStart ?? store.getScheduleDate();
  const liveMode = store.getLiveModeState();

  let html = `<div class="day-navigator">`;

  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    const dayName = hebrewDayName(date);

    let violationCount = 0;
    if (currentSchedule) {
      const dsh = currentSchedule.algorithmSettings.dayStartHour;
      const frozenDisabled = new Set(currentSchedule.algorithmSettings.disabledHardConstraints);
      const dayTaskIds = new Set(
        currentSchedule.tasks.filter((t) => taskIntersectsDay(t, d, dsh, baseDate)).map((t) => t.id),
      );
      violationCount = filterVisibleViolations(currentSchedule.violations, frozenDisabled).filter(
        (v) => v.severity === ViolationSeverity.Error && v.taskId && dayTaskIds.has(v.taskId),
      ).length;
    }

    const violationDot =
      violationCount > 0 ? `<span class="day-violation-dot" title="${violationCount} הפרות">!</span>` : '';

    let frozenTag = '';
    let frozenClass = '';
    if (liveMode.enabled) {
      if (isDayFrozen(d, baseDate, liveMode.currentTimestamp, store.getDayStartHour())) {
        frozenTag = `<span class="day-frozen-badge" title="היום הזה מוקפא כי הוא בעבר">🧊</span>`;
        frozenClass = ' day-tab-frozen';
      } else if (isDayPartiallyFrozen(d, baseDate, liveMode.currentTimestamp, store.getDayStartHour())) {
        frozenTag = `<span class="day-frozen-badge day-frozen-partial" title="מוקפא חלקית לפי שעה נוכחית">⏳</span>`;
        frozenClass = ' day-tab-partial-frozen';
      }
    }

    html += `<button class="day-tab ${currentDay === d ? 'day-tab-active' : ''}${frozenClass}" data-day="${d}">
      <span class="day-tab-name">${dayName}</span>
      <span class="day-tab-label">יום ${d}</span>
      ${violationDot}
      ${frozenTag}
    </button>`;
  }

  html += `</div>`;
  return html;
}

// ─── Weekly Dashboard (Always Visible Header) ────────────────────────────────

/** Render the sticky weekly performance dashboard that stays visible across day tabs */
function renderWeeklyDashboard(schedule: Schedule): string {
  const score = schedule.score;
  const numDays = schedule.periodDays;
  const dsh = schedule.algorithmSettings.dayStartHour;
  const base = schedule.periodStart;
  const frozenDisabled = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const visibleViolations = filterVisibleViolations(schedule.violations, frozenDisabled);
  const totalViolations = visibleViolations.filter((v) => v.severity === ViolationSeverity.Error).length;
  const warnings = visibleViolations.filter((v) => v.severity === ViolationSeverity.Warning).length;
  const feasibleClass = schedule.feasible ? 'kpi-ok' : 'kpi-error';

  // Per-day task counts — parallel dot + numeric-label rows
  let dayDots = '';
  let dayNums = '';
  for (let d = 1; d <= numDays; d++) {
    const count = schedule.tasks.filter((t) => taskIntersectsDay(t, d, dsh, base)).length;
    const dayViolations = visibleViolations.filter((v) => {
      if (v.severity !== ViolationSeverity.Error || !v.taskId) return false;
      const task = schedule.tasks.find((t) => t.id === v.taskId);
      return task ? taskIntersectsDay(task, d, dsh, base) : false;
    }).length;
    const dotClass = dayViolations > 0 ? 'dot-error' : count > 0 ? 'dot-ok' : 'dot-empty';
    const title = `יום ${d}: ${count} משימות, ${dayViolations} הפרות`;
    dayDots += `<span class="week-dot ${dotClass}" title="${title}"></span>`;
    dayNums += `<span class="week-num ${dayViolations > 0 ? 'num-error' : ''}" title="${title}">${d}</span>`;
  }

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
      ? `<div class="kpi-cell kpi-warn">
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

  return `<div class="weekly-dashboard${isClean ? ' dashboard-clean' : ''}">
    <div class="dashboard-row">
      ${heroBlock}

      ${kpiStrip}

      <div class="week-strip" aria-label="ימי השבוע">
        <div class="week-strip-dots">${dayDots}</div>
        <div class="week-strip-nums">${dayNums}</div>
        <span class="week-strip-caption">ימי השבוע</span>
      </div>
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

/** Build a single sidebar entry's HTML */
function renderSidebarEntry(
  entry: {
    p: Participant;
    w: { totalHours: number; effectiveHours: number; hotHours: number; coldHours: number; loadBearingCount: number };
    pctOfPeriod: number;
    perDay: Map<number, number>;
  },
  totalPeriodHours: number,
): string {
  const p = entry.p;
  const barPct = Math.min(entry.pctOfPeriod * (100 / 30), 100);
  const barWidth = barPct;

  const todayHrs = entry.perDay.get(currentDay) || 0;
  const todayRatio = totalPeriodHours > 0 ? todayHrs / totalPeriodHours : 0;
  const todayBarWidth = Math.min(todayRatio * 100 * (100 / 30), barWidth);

  const hoverTitle = `${escHtml(p.name)} — ${entry.w.effectiveHours.toFixed(1)} שעות עומס (${entry.pctOfPeriod.toFixed(1)}%)`;

  return `<div class="sidebar-entry">
    <div class="sidebar-name">
      <span class="participant-hover" data-pid="${p.id}">${escHtml(p.name)}</span>
      <span class="sidebar-meta">${groupBadge(p.group)} ${levelBadge(p.level)}</span>
    </div>
    <div class="sidebar-bar-row">
      <div class="sidebar-bar-bg" title="${hoverTitle}" data-pid="${p.id}">
        <div class="sidebar-bar-fill" style="width:${barWidth}%"></div>
        <div class="sidebar-bar-today" style="width:${todayBarWidth}%"></div>
        <span class="sidebar-bar-label">${entry.w.effectiveHours.toFixed(1)} שעות עומס (${entry.pctOfPeriod.toFixed(1)}%)</span>
      </div>
      <span class="sidebar-today-tag" title="היום (יום ${currentDay}): ${todayHrs.toFixed(1)} שע'">
        ${hebrewDayName(new Date(store.getScheduleDate().getFullYear(), store.getScheduleDate().getMonth(), store.getScheduleDate().getDate() + currentDay - 1))}: ${todayHrs.toFixed(1)} שע'
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
  const workloads = computeWeeklyWorkloads(schedule.participants, schedule.assignments, schedule.tasks);
  const numDays = schedule.periodDays;
  const totalPeriodHours = numDays * 24;

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
    const pctOfPeriod = totalPeriodHours > 0 ? (w.effectiveHours / totalPeriodHours) * 100 : 0;
    const perDay = computePerDayHours(p.id, schedule, sidebarTaskMap);
    return { p, w, pctOfPeriod, perDay };
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
  const l0Sigma = Math.sqrt(l0Var);

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
    html += renderSidebarEntry(entry, totalPeriodHours);
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
    html += renderSidebarEntry(entry, totalPeriodHours);
  }

  html += `</div></div></div>`;
  return html;
}

// ─── Schedule Tab ────────────────────────────────────────────────────────────

function renderScheduleTab(): string {
  const preflight = runPreflight();
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
      const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
      const label = `יום ${hebrewDayName(date)}`;
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
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-reset-storage" title="אפס להגדרות ברירת מחדל ומחק נתונים שמורים">🔄 אפס</button>` : ''}
        <button class="btn-sm ${_snapshotPanelOpen ? 'btn-primary' : 'btn-outline'}" id="btn-snap-toggle" title="תמונות מצב שמורות">💾 שמירת שבצקים${store.getAllSnapshots().length > 0 ? ` (${store.getAllSnapshots().length})` : ''}</button>
        ${renderContinuityChip()}
        ${!currentSchedule && !_continuityJson.trim() ? `<button class="btn-sm btn-outline" id="btn-continuity-import" title="חיבור לשבצ"ק קודם — ייבוא נתוני המשכיות">📋 חיבור לשבצ"ק קודם</button>` : ''}
      </span>
      <span class="toolbar-group toolbar-group--day-actions">
        ${currentSchedule ? `<button class="btn-sm btn-outline btn-inject-task" id="btn-inject-task" title="הוספת משימת חירום לתמונת המצב הנוכחית" ${_isOptimizing ? 'disabled' : ''}>🚨 הוסף משימת חירום</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-export-day-json" title="ייצוא מצב יום ${currentDay} כ-JSON להמשכיות">📋 ייצוא יום</button>` : ''}
        ${currentSchedule ? `<button class="btn-sm btn-outline" id="btn-generate-from-day" title="צור שבצ"ק חדש מסוף יום ${currentDay}">🔗 המשך מכאן</button>` : ''}
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
  html += `<div class="schedule-layout">`;
  html += `<div class="schedule-main">`;
  // Use the schedule's frozen dayStartHour so day grouping stays consistent
  // with how the schedule was generated, even if the live setting was edited.
  html += `<section><h2>שיבוצים <span class="count">${getFilteredAssignments(s).length}</span></h2>${renderScheduleGrid(s, currentDay, store.getLiveModeState(), manualCtx, s.algorithmSettings.dayStartHour)}</section>`;
  // Participant warehouse (desktop: inline; mobile: hidden, shown via bottom sheet)
  if (_manualBuildActive) {
    html += renderParticipantWarehouse(s);
  }
  // Availability inspector strip — between schedule grid and gantt
  html += renderAvailabilityStrip();

  // Gantt chart: wrapped in mobile-toggleable accordion
  const ganttExpanded = !_manualBuildActive;
  html += `<section class="gantt-section">`;
  html += `<button class="gantt-mobile-toggle" aria-expanded="${ganttExpanded}" data-action="toggle-gantt">${SVG_ICONS.chart} מערכת שעות כללית</button>`;
  html += `<div class="gantt-section-content"${_manualBuildActive ? ' style="display:none"' : ''}><h2 class="gantt-desktop-title">מערכת שעות כללית</h2>${renderGanttChart(s)}</div>`;
  html += `</section>`;
  // In manual build mode, collapse violations by default (empty schedule generates hundreds)
  const violationCount = filterVisibleViolations(
    s.violations,
    new Set(s.algorithmSettings.disabledHardConstraints),
  ).length;
  if (_manualBuildActive) {
    html += `<section class="violations-section violations-collapsed">
      <button class="violations-toggle" data-action="toggle-violations" aria-expanded="false">
        <h2>אזהרות והפרות <span class="count">${violationCount}</span></h2>
        <span class="violations-toggle-icon">▸</span>
      </button>
    </section>`;
  } else {
    html += `<section><h2>אזהרות והפרות <span class="count">${violationCount}</span></h2>${renderViolations(s)}</section>`;
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
        const s = new Date(t.timeBlock.start).getTime();
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
        const aElig = _eligibleForSelectedSlot!.has(a.id) ? 0 : 1;
        const bElig = _eligibleForSelectedSlot!.has(b.id) ? 0 : 1;
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

  return `<section class="manual-warehouse" id="manual-warehouse">
    <div class="warehouse-header">
      <h3>מאגר משתתפים</h3>
      <input type="search" class="warehouse-filter" id="warehouse-filter" placeholder="🔍 חפש..." value="${escHtml(_warehouseFilter)}" />
    </div>
    ${renderPool(l0Pool, 'דרגה 0')}
    ${renderPool(seniorPool, 'סגל (דרגה 2–4)')}
  </section>`;
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
  const cleanTaskName = (task.sourceName || task.name).replace(/^D\d+\s+/, '');
  const slotLabel = slot.label ? ` — ${slot.label}` : '';
  const timeRange = `<span dir="ltr">${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}</span>`;
  let header = `<div class="warehouse-sheet-header">
    <div class="warehouse-sheet-title">בחר משתתף ל-${escHtml(cleanTaskName)}${escHtml(slotLabel)}</div>
    <div class="warehouse-sheet-reqs">${timeRange} ${levels ? `${levels}` : ''} ${certBadges(slot.requiredCertifications, '')}</div>
  </div>`;

  if (existingAssignment && existingParticipant) {
    header += `<button class="btn-manual-remove-sheet" data-action="manual-remove" data-assignment-id="${existingAssignment.id}">✕ הסר שיבוץ של ${escHtml(existingParticipant.name)}</button>`;
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
      const aElig = _eligibleForSelectedSlot!.has(a.id) ? 0 : 1;
      const bElig = _eligibleForSelectedSlot!.has(b.id) ? 0 : 1;
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
      const reasonText = REJECTION_REASONS_HE[reasonAddBoth] || `אילוץ ${reasonAddBoth}`;
      const confirmed = await showConfirm(
        `${participant.name} משובץ ב-"${otherTask?.name || '?'}" — שיבוץ נוסף יפר אילוץ (${reasonText}). להעביר לכאן?`,
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

  // Descriptive toast with participant + task name
  const pName = assignedParticipant?.name || '';
  const tName = assignedTask ? (assignedTask.sourceName || assignedTask.name).replace(/^D\d+\s+/, '') : '';
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
      }
    });
  });
}

// ─── Snapshot Panel ─────────────────────────────────────────────────────────

// ─── Continuity Panel ───────────────────────────────────────────────────────

function renderContinuityChip(): string {
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

  // Separate into current-day and other-day violations
  const dayTaskIds = new Set(getFilteredTasks(schedule).map((t) => t.id));

  let html = '';
  if (hard.length > 0) {
    const today = hard.filter((v) => v.taskId && dayTaskIds.has(v.taskId));
    const other = hard.filter((v) => !v.taskId || !dayTaskIds.has(v.taskId));

    html += `<div class="alert alert-error"><strong>הפרות חמורות (${hard.length})</strong>`;
    if (today.length > 0) {
      html += `<div class="violation-section"><em>יום ${currentDay}:</em><ul>`;
      for (const v of today) html += `<li dir="rtl"><code>${violationLabel(v.code)}</code> · ${v.message}</li>`;
      html += `</ul></div>`;
    }
    if (other.length > 0) {
      html += `<div class="violation-section violation-other"><em>ימים אחרים:</em><ul>`;
      for (const v of other) html += `<li dir="rtl"><code>${violationLabel(v.code)}</code> · ${v.message}</li>`;
      html += `</ul></div>`;
    }
    html += '</div>';
  }
  if (warn.length > 0) {
    html += `<div class="alert alert-warn"><strong>אזהרות (${warn.length})</strong><ul>`;
    for (const w of warn) html += `<li dir="rtl"><code>${violationLabel(w.code)}</code> · ${w.message}</li>`;
    html += '</ul></div>';
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
        <td><span dir="ltr">${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</span></td>
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
          <td rowspan="${taskAssignments.length}"><span dir="ltr">${fmtDate(task.timeBlock.start)}–${fmtDate(task.timeBlock.end)}</span></td>`;
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
      const shortName = block.taskName.replace(/^D\d+\s+/, '').replace(/\s+משמרת\s+\d+$/, '');
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
      <h3>מחפש את השיבוץ האיכותי ביותר…</h3>
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
  );
  engine.setCertLabelSnapshot(buildCertLabelSnapshot());
  engine.setPeriod(store.getScheduleDate(), store.getScheduleDays());
  engine.addParticipants(participants);
  engine.addTasks(tasks);

  // Continuity: if previous-schedule JSON is present, build phantom context
  if (_continuityJson.trim()) {
    const parsed = parseContinuitySnapshot(_continuityJson);
    if ('error' in parsed) {
      showToast(parsed.error, { type: 'error' });
      return;
    }
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

  try {
    const schedule = await engine.generateScheduleAsync(
      OPTIM_ATTEMPTS,
      (info) => {
        // Update progress state (in-memory only, no DOM thrash on renderAll)
        _optimProgress = {
          attempt: info.attempt,
          totalAttempts: info.totalAttempts,
          bestScore: info.currentBestScore,
          bestUnfilled: info.currentBestUnfilled,
          lastImproved: info.improved,
        };
        // Surgically update just the overlay
        updateOverlay();
      },
      _optimAbortController!.signal,
      _optimEarlyStopController!.signal,
    );
    wasEarlyStopped = _optimEarlyStopController?.signal.aborted === true;

    // ── Atomic commit: update state in one go, then render once ──
    closeRescueModal();
    closeInjectTaskModal();
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
      restStdDev: 0,
      totalPenalty: 0,
      compositeScore: 0,
      l0StdDev: 0,
      l0AvgEffective: 0,
      seniorStdDev: 0,
      seniorAvgEffective: 0,
      dailyPerParticipantStdDev: 0,
      dailyGlobalStdDev: 0,
    },
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: {
      config: { ...algoSettings.config },
      disabledHardConstraints: [...algoSettings.disabledHardConstraints],
      dayStartHour: algoSettings.dayStartHour,
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
  const ok = await showConfirm(
    'הכיול יבחן עשרות סטים של משקלות מול הנתונים שלך, ועשוי להימשך מספר דקות. ההגדרות הנוכחיות לא ישונו — תקבל המלצה שתוכל ליישם.',
    { title: 'כיול אוטומטי של הגדרות', confirmLabel: 'התחל כיול' },
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
  const labels: Record<string, string> = {
    minRestWeight: 'משקל מנוחה מינימלית',
    l0FairnessWeight: 'שיוויוניות כללי',
    seniorFairnessWeight: 'שיוויוניות סגל',
    lowPriorityLevelPenalty: 'עונש דרגה בעדיפות נמוכה',
    dailyBalanceWeight: 'איזון יומי',
    notWithPenalty: 'עונש "אי התאמה"',
    taskNamePreferencePenalty: 'עונש אי-קיום העדפה',
    taskNameAvoidancePenalty: 'עונש שיבוץ לא-מועדף',
    taskNamePreferenceBonus: 'בונוס שיבוץ מועדף',
  };
  return labels[key] ?? key;
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
    onCommit: ({ label, preCommitAssignments, swappedAssignmentIds }) => {
      if (!currentSchedule) return;
      // Record a pre-commit schedule snapshot on the parallel stack and push
      // a (no-op) checkpoint onto the store's undo stack so the header
      // undo/redo buttons light up and `doUndoRedo('undo')` restores the
      // pre-swap state. The engine mutated `currentSchedule.assignments` in
      // place (shared reference), so we clone the schedule and substitute
      // the pre-commit assignments.
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

  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    days.push({ value: String(d), label: `יום ${hebrewDayName(date)}` });
  }
  const dayStartHour = currentSchedule.algorithmSettings.dayStartHour;
  const hours: Array<{ value: string; label: string }> = operationalHourOrder(dayStartHour).map((h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
  }));

  const result = await showTimePicker('כדי להמשיך, יש להגדיר את הזמן הנוכחי במצב חי.', {
    title: 'הפעלת מצב חי',
    days,
    hours,
    defaultDay: '1',
    defaultHour: String(dayStartHour),
  });
  if (!result) return null;

  const dayIdx = parseInt(result.day, 10);
  const hour = parseInt(result.hour, 10);
  const ts = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx - 1, hour, 0);

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

async function handleProfileSos(assignmentId: string): Promise<void> {
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
    // Iterate operational days (Day 1..N) inside the schedule window, mirroring
    // `isBlockedByDateUnavailability` so the UI pre-existing-overlap preview
    // agrees with HC-3. Days outside the schedule window intentionally produce
    // no overlap — weekly rules only bind to the operational days the user
    // actually scheduled.
    const baseDate = schedule.periodStart;
    const scheduleDays = schedule.periodDays;
    const hBoundary = schedule.algorithmSettings.dayStartHour;
    const baseY = baseDate.getFullYear();
    const baseM = baseDate.getMonth();
    const baseD = baseDate.getDate();
    for (let dayIdx = 0; dayIdx < scheduleDays; dayIdx++) {
      const opDayBase = new Date(baseY, baseM, baseD + dayIdx);
      const opDayStartMs = new Date(baseY, baseM, baseD + dayIdx, hBoundary, 0).getTime();
      const opDayEndMs = new Date(baseY, baseM, baseD + dayIdx + 1, hBoundary, 0).getTime();
      if (opDayEndMs <= wStart || opDayStartMs >= wEnd) continue;
      const dow = opDayBase.getDay();
      for (const rule of rules) {
        if (rule.dayOfWeek !== dow) continue;
        let rStart: number;
        let rEnd: number;
        if (rule.allDay) {
          rStart = opDayStartMs;
          rEnd = opDayEndMs;
        } else {
          rStart = new Date(baseY, baseM, baseD + dayIdx, rule.startHour, 0).getTime();
          rEnd =
            rule.endHour <= rule.startHour
              ? new Date(baseY, baseM, baseD + dayIdx + 1, rule.endHour, 0).getTime()
              : new Date(baseY, baseM, baseD + dayIdx, rule.endHour, 0).getTime();
        }
        const oStart = Math.max(rStart, wStart);
        const oEnd = Math.min(rEnd, wEnd);
        if (oStart < oEnd) {
          const dayName = hebrewDayName(opDayBase);
          const timeLabel = rule.allDay
            ? 'כל היום'
            : `${String(rule.startHour).padStart(2, '0')}:00–${String(rule.endHour).padStart(2, '0')}:00`;
          const reasonTail = rule.reason ? ` · ${rule.reason}` : '';
          overlaps.push({
            kind: 'date-unavailability',
            label: `כלל שבועי: יום ${dayName} ${timeLabel}${reasonTail}`,
            start: new Date(oStart),
            end: new Date(oEnd),
          });
        }
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

function formatOverlapRange(o: PreExistingUnavailabilityOverlap): string {
  const startDay = hebrewDayName(o.start);
  const endDay = hebrewDayName(o.end);
  if (startDay === endDay) return `יום ${startDay} ${fmt(o.start)}–${fmt(o.end)}`;
  return `יום ${startDay} ${fmt(o.start)} → יום ${endDay} ${fmt(o.end)}`;
}

async function handleProfileFutureSos(participantId: string, entryOpts: FutureSosEntryOpts = {}): Promise<void> {
  if (!currentSchedule || !engine) return;
  const participant = currentSchedule.participants.find((p) => p.id === participantId);
  if (!participant) return;

  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();
  const dayStartHour = currentSchedule.algorithmSettings.dayStartHour;

  const days: Array<{ value: string; label: string }> = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    days.push({ value: String(d), label: `יום ${hebrewDayName(date)}` });
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
  let anchor: Date = lm.enabled
    ? lm.currentTimestamp
    : new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), dayStartHour, 0);
  const liveModeInitiallyOn = lm.enabled;

  // Smart default: use next modifiable upcoming assignment if no override provided.
  const smartDefault = computeSmartDefaultWindow(currentSchedule, participantId, anchor, dayStartHour);
  const initial: RangePickerDefaults = {
    startDay: entryOpts.defaultStartDay ?? smartDefault.startDay,
    startHour: entryOpts.defaultStartHour ?? smartDefault.startHour,
    endDay: entryOpts.defaultEndDay ?? smartDefault.endDay,
    endHour: entryOpts.defaultEndHour ?? smartDefault.endHour,
  };

  const anchorLabel = (a: Date) => `יום ${hebrewDayName(a)} ${fmt(a)}`;

  const range = await showRangePicker({
    title: `אי זמינות עתידית — חלון · ${participant.name}`,
    days,
    hours,
    defaultStartDay: initial.startDay,
    defaultStartHour: initial.startHour,
    defaultEndDay: initial.endDay,
    defaultEndHour: initial.endHour,
    anchor: {
      currentLabel: anchorLabel(anchor),
      changeButtonLabel: 'שנה',
      onChange: async () => {
        const result = await showTimePicker('בחר את נקודת ההקפאה. שיבוצים לפני נקודה זו ייחשבו כעבר.', {
          title: 'נקודת הקפאה',
          days,
          hours,
          defaultDay: '1',
          defaultHour: String(dayStartHour),
        });
        if (!result) return null;
        const ts = toDate(result.day, result.hour);
        anchor = ts;
        // When live mode is already ON, persist the new anchor immediately so the
        // schedule's frozen/future split updates — matches the Live Mode panel
        // pattern. When OFF, persistence is deferred to the apply paths below.
        if (liveModeInitiallyOn && currentSchedule) {
          store.setLiveModeTimestamp(ts);
          freezeAssignments(currentSchedule, ts);
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
      if (!currentSchedule) return '';
      const s = toDate(v.startDay, v.startHour);
      const e = toDate(v.endDay, v.endHour);
      if (e.getTime() <= s.getTime() || s.getTime() < anchor.getTime()) return '';
      const { affected } = findAffectedAssignments(currentSchedule, participantId, { start: s, end: e }, anchor);
      if (affected.length === 0) return 'אין שיבוצים בחלון זה.';
      const dayKeys = new Set(affected.map((a) => a.task.timeBlock.start.toDateString()));
      return `יעודכנו ${affected.length} שיבוצים ב־${dayKeys.size} ימים.`;
    },
  });
  if (!range) return;

  const windowStart = toDate(range.startDay, range.startHour);
  const windowEnd = toDate(range.endDay, range.endHour);

  // Warn when the window overlaps an existing unavailability source
  // (participant availability gap, recurring date-unavailability rule, or a
  // prior Future-SOS entry). Recording is still allowed — overlapping
  // scheduleUnavailability entries are merged by upsertScheduleUnavailability.
  const preOverlaps = findPreExistingUnavailabilityOverlaps(participant, currentSchedule, {
    start: windowStart,
    end: windowEnd,
  });
  if (preOverlaps.length > 0) {
    const lines = preOverlaps.map((o) => `• ${o.label}: ${formatOverlapRange(o)}`);
    const proceed = await showConfirm(
      `החלון שבחרת חופף לזמן שכבר סומן כלא־זמין עבור ${participant.name}:\n\n${lines.join('\n')}\n\nניתן להמשיך — חלון אי זמינות עתידית חדש יאוחד עם חלונות קיימים, וכללי אי־זמינות אחרים יישארו כפי שהם. להמשיך בכל זאת?`,
      { title: 'חפיפה עם אי־זמינות קיימת', confirmLabel: 'המשך', cancelLabel: 'ביטול' },
    );
    if (!proceed) return;
  }

  const { affected, lockedInPast } = findAffectedAssignments(
    currentSchedule,
    participantId,
    { start: windowStart, end: windowEnd },
    anchor,
  );

  const confirmResult = await openConfirmModal({
    participantName: participant.name,
    window: { start: windowStart, end: windowEnd },
    affected,
    lockedInPast,
    dayStartHour,
  });
  if (!confirmResult.confirmed) return;

  const excludedIds = new Set(confirmResult.excludedIds);
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
    const keptBlocks = affected.filter((a) => excludedIds.has(a.assignment.id)).map((a) => a.task.timeBlock);
    const effectiveWindows = computeEffectiveUnavailabilityWindows({ start: windowStart, end: windowEnd }, keptBlocks);
    let updated = currentSchedule.scheduleUnavailability;
    const baseId = `fsos-${Date.now()}`;
    for (let i = 0; i < effectiveWindows.length; i++) {
      const w = effectiveWindows[i];
      updated = upsertScheduleUnavailability(updated, {
        id: effectiveWindows.length === 1 ? baseId : `${baseId}-${i}`,
        participantId,
        start: w.start,
        end: w.end,
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

  const config = engine.getConfig();
  const scoreCtx = engine.buildScoreContext();
  if (!scoreCtx) return;
  const result = generateBatchRescuePlans(
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

  openBatchPlansModal({
    result,
    schedule: currentSchedule,
    participantName: participant.name,
    onNarrowWindow: () => {
      // Re-enter the flow preserving the current window values as defaults.
      void handleProfileFutureSos(participantId, {
        defaultStartDay: range.startDay,
        defaultStartHour: range.startHour,
        defaultEndDay: range.endDay,
        defaultEndHour: range.endHour,
      });
    },
    onApply: (plan) => {
      if (!currentSchedule || !engine) return;

      if (!liveModeInitiallyOn) activateLiveModeWithAnchor(anchor);

      // Capture the reverse swap map BEFORE mutating, to support undo.
      const reverseSwaps = plan.swaps.map((sw) => {
        const assn = currentSchedule!.assignments.find((a) => a.id === sw.assignmentId);
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
      const keptBlocks = affected.filter((a) => excludedIds.has(a.assignment.id)).map((a) => a.task.timeBlock);
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
      const applyResult = engine.swapParticipantChain(requests);
      if (!applyResult.valid) {
        currentSchedule.scheduleUnavailability = prevUnavailability;
        showToast('החלת התוכנית נכשלה — בוצע שחזור למצב הקודם.', { type: 'error', duration: 5000 });
        return;
      }

      const updated = engine.getSchedule()!;
      currentSchedule = updated;
      store.saveSchedule(updated);
      renderAll();
      showFutureSosAppliedStrip(participantId, plan.swaps.length, {
        reverseSwaps,
        prevUnavailability,
        fsosEntryId,
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
  const baseDate = store.getScheduleDate();
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
  const timer = window.setTimeout(remove, 10000);
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
  // Remove the FSOS entry first so HC-5 doesn't block the reverse swap.
  const before = currentSchedule.scheduleUnavailability ?? [];
  currentSchedule.scheduleUnavailability = before.filter((e) => e.id !== undoCtx.fsosEntryId);

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
  hideAvailabilityPopover();

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
        onSosClick: handleProfileSos,
        onFutureSosClick: handleProfileFutureSos,
        onRemoveFutureSosEntry: handleRemoveFutureSosEntry,
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
      numDays: store.getScheduleDays(),
      baseDate: store.getScheduleDate(),
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

  const participants = store.getAllParticipants();
  const templates = store.getAllTaskTemplates();
  const preflight = runPreflight();

  let html = `
  <header>
    <div class="header-top">
      <h1 id="app-title"><img class="app-logo-img" src="./logo-header.png" alt="" aria-hidden="true" draggable="false">השבצקיסט</h1><span class="beta-badge">v2.7.2</span>
      <div class="undo-redo-group">
        <button class="btn-sm btn-outline" id="btn-undo" ${!store.getUndoRedoState().canUndo ? 'disabled' : ''}
          title="ביטול">↪<span class="btn-label"> ביטול${store.getUndoRedoState().undoDepth ? ' (' + store.getUndoRedoState().undoDepth + ')' : ''}</span></button>
        <button class="btn-sm btn-outline" id="btn-redo" ${!store.getUndoRedoState().canRedo ? 'disabled' : ''}
          title="שחזור">↩<span class="btn-label"> שחזור${store.getUndoRedoState().redoDepth ? ' (' + store.getUndoRedoState().redoDepth + ')' : ''}</span></button>
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
      <span class="credit-right">כי עוד אאמין גם באדם גם ברוחו רוח עז</span>
    </div>
  </header>

  <nav class="tab-nav">
    <button class="tab-btn ${currentTab === 'participants' ? 'tab-active' : ''}" data-tab="participants" aria-label="משתתפים">
      <span class="tab-icon">${SVG_ICONS.participants}</span>
      <span class="tab-label">משתתפים <span class="count">${participants.length}</span></span>
    </button>
    <button class="tab-btn ${currentTab === 'task-rules' ? 'tab-active' : ''}" data-tab="task-rules" aria-label="משימות">
      <span class="tab-icon">${SVG_ICONS.tasks}</span>
      <span class="tab-label">משימות <span class="count">${templates.length}</span>
      ${!preflight.canGenerate ? '<span class="badge badge-sm" style="background:var(--danger);margin-inline-start:4px">!</span>' : ''}</span>
    </button>
    <button class="tab-btn ${currentTab === 'schedule' ? 'tab-active' : ''}" data-tab="schedule" aria-label="שבצ&quot;ק">
      <span class="tab-icon">${SVG_ICONS.chart}</span>
      <span class="tab-label">שבצ"ק
      ${currentSchedule ? '<span class="badge badge-sm" style="background:var(--success);margin-inline-start:4px">✓</span>' : ''}</span>
    </button>
    <button class="tab-btn ${currentTab === 'algorithm' ? 'tab-active' : ''}" data-tab="algorithm" aria-label="הגדרות">
      <span class="tab-icon">${SVG_ICONS.settings}</span>
      <span class="tab-label">הגדרות</span>
    </button>
  </nav>

  <div class="tab-content" id="tab-content">`;

  switch (currentTab) {
    case 'participants':
      html += renderParticipantsTab();
      break;
    case 'task-rules':
      html += renderTaskRulesTab();
      break;
    case 'schedule':
      html += renderScheduleTab();
      break;
    case 'algorithm':
      html += renderAlgorithmTab();
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
  wireFactoryReset(app);

  const content = document.getElementById('tab-content')!;
  if (currentTab === 'participants') {
    wireParticipantsEvents(content, renderAll);
  } else if (currentTab === 'task-rules') {
    wireTaskRulesEvents(content, renderAll);
  } else if (currentTab === 'schedule') {
    wireScheduleEvents(content);
  } else if (currentTab === 'algorithm') {
    wireAlgorithmEvents(content, renderAll);
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

function wireTabNav(container: HTMLElement): void {
  container.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tab = (btn as HTMLElement).dataset.tab as typeof currentTab;
      if (tab && tab !== currentTab) {
        // Guard: if table-edit mode has unsaved changes, confirm before leaving
        if (currentTab === 'participants') {
          const canLeave = await canLeaveParticipantsTab();
          if (!canLeave) return;
          clearParticipantSelection();
        }
        currentTab = tab;
        pushHash();
        renderAll();
      }
    });
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
  backdrop.querySelector('.gm-egg-seal')!.addEventListener('click', close);
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

function wireScheduleEvents(container: HTMLElement): void {
  const genBtn = container.querySelector('#btn-generate');
  if (genBtn) genBtn.addEventListener('click', doGenerate);

  const createManualEmptyBtn = container.querySelector('#btn-create-manual-empty');
  if (createManualEmptyBtn) createManualEmptyBtn.addEventListener('click', doCreateManualSchedule);

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

  // Day navigator tabs
  container.querySelectorAll('.day-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const day = parseInt((btn as HTMLElement).dataset.day || '1', 10);
      if (day !== currentDay && day >= 1) {
        currentDay = day;
        pushHash(true);
        renderAll();
      }
    });
  });

  // ── Availability strip: open / close / results ──
  const availStrip = container.querySelector('.avail-strip') as HTMLElement | null;
  if (availStrip) {
    availStrip.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (action?.dataset.action === 'open-avail-strip') {
        _availabilityInlineOpen = true;
        renderAll();
        return;
      }
      if (action?.dataset.action === 'close-avail-strip') {
        _availabilityInlineOpen = false;
        _availabilityRangeStartMs = null;
        _availabilityRangeEndMs = null;
        renderAll();
        return;
      }
      // Close button inside results
      const closeTarget = (e.target as HTMLElement).closest('[data-action="close-availability-popover"]');
      if (closeTarget) {
        _availabilityRangeStartMs = null;
        _availabilityRangeEndMs = null;
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

  // ── BALTAM: Inject emergency task into current snapshot ──
  const injectBtn = container.querySelector('#btn-inject-task');
  if (injectBtn && currentSchedule) {
    injectBtn.addEventListener('click', () => {
      if (!currentSchedule || _isOptimizing) return;
      openInjectTaskModal();
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
  container.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest('.task-panel-hover[data-source-name]') as HTMLElement | null;
    if (!chip?.dataset.sourceName) return;
    navigateToTaskPanel(chip.dataset.sourceName);
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = (e.target as HTMLElement).closest('.task-panel-hover[data-source-name]') as HTMLElement | null;
    if (!chip?.dataset.sourceName) return;
    e.preventDefault();
    navigateToTaskPanel(chip.dataset.sourceName);
  });

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

  wireCustomSelect(container, 'gm-availability-day-start', (value) => {
    const day = parseInt(value, 10);
    if (!Number.isNaN(day)) _availabilityInspectorDay = day;
  });
  wireCustomSelect(container, 'gm-availability-day-end', (value) => {
    const day = parseInt(value, 10);
    if (!Number.isNaN(day)) _availabilityInspectorDayEnd = day;
  });
  wireCustomSelect(container, 'gm-availability-time-start', (value) => {
    if (value) _availabilityInspectorTimeStart = value;
  });
  wireCustomSelect(container, 'gm-availability-time-end', (value) => {
    if (value) _availabilityInspectorTimeEnd = value;
  });

  // ── Margin toggle + fields ──
  const marginToggle = container.querySelector('#gm-availability-margin-toggle') as HTMLInputElement | null;
  if (marginToggle) {
    marginToggle.addEventListener('change', () => {
      _availabilityMarginEnabled = marginToggle.checked;
      const fields = container.querySelector('.avail-strip-margin-fields') as HTMLElement | null;
      if (fields) fields.style.display = _availabilityMarginEnabled ? '' : 'none';
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

  // ── Sleep-recovery strict filter toggle ──
  const sleepToggle = container.querySelector('#gm-availability-hide-sleep-recovery') as HTMLInputElement | null;
  if (sleepToggle) {
    sleepToggle.addEventListener('change', () => {
      _availabilityHideSleepRecovery = sleepToggle.checked;
      renderAll();
    });
  }

  const availabilityBtn = container.querySelector('#btn-open-availability-inspector') as HTMLElement | null;
  if (availabilityBtn) {
    availabilityBtn.addEventListener('click', () => {
      const selectedDayStart = _availabilityInspectorDay ?? currentDay;
      const selectedDayEnd = _availabilityInspectorDayEnd ?? selectedDayStart;
      const tsStart = resolveLogicalDayTimestamp(selectedDayStart, _availabilityInspectorTimeStart);
      const tsEnd = resolveLogicalDayTimestamp(selectedDayEnd, _availabilityInspectorTimeEnd);
      if (!tsStart || !tsEnd) return;
      if (tsEnd.getTime() <= tsStart.getTime()) {
        const message =
          selectedDayEnd < selectedDayStart
            ? 'יום הסיום חייב להיות זהה ליום ההתחלה או אחריו'
            : selectedDayEnd === selectedDayStart
              ? 'שעת סיום חייבת להיות אחרי שעת התחלה'
              : 'מועד הסיום חייב להיות אחרי מועד ההתחלה';
        showToast(message, { type: 'error' });
        return;
      }
      _availabilityRangeStartMs = tsStart.getTime();
      _availabilityRangeEndMs = tsEnd.getTime();
      renderAll();
    });
  }

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
        freezeAssignments(currentSchedule, store.getLiveModeState().currentTimestamp);
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
    if (isNaN(dayIdx) || isNaN(hour)) return;
    const base = store.getScheduleDate();
    const ts = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayIdx - 1, hour, 0);
    store.setLiveModeTimestamp(ts);
    if (currentSchedule && store.getLiveModeState().enabled) {
      freezeAssignments(currentSchedule, ts);
    }
    // Navigate the schedule view to the selected live-mode day
    if (dayIdx >= 1 && dayIdx <= 7) {
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

  // ── Reset storage button ──
  const resetBtn = container.querySelector('#btn-reset-storage');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const ok = await showConfirm('למחוק את כל הנתונים השמורים ולטעון מחדש? לא ניתן לבטל פעולה זו.', {
        danger: true,
        title: 'איפוס נתונים',
        confirmLabel: 'אפס הכל',
      });
      if (ok) {
        store.clearStorage();
        location.reload();
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

  const numDays = store.getScheduleDays();
  const baseDate = store.getScheduleDate();

  // Build day options for the daily picker
  const exportDayOpts: { value: string; label: string; selected: boolean }[] = [];
  for (let d = 1; d <= numDays; d++) {
    const date = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + d - 1);
    exportDayOpts.push({ value: String(d), label: `יום ${hebrewDayName(date)}`, selected: d === currentDay });
  }

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

  // Format radio toggle
  const fmtPdf = backdrop.querySelector('#fmt-pdf') as HTMLElement;
  const fmtExcel = backdrop.querySelector('#fmt-excel') as HTMLElement;
  const formatRadios = backdrop.querySelectorAll('input[name="export-format"]');
  formatRadios.forEach((r) => {
    r.addEventListener('change', () => {
      const fmt = (r as HTMLInputElement).value;
      fmtPdf.classList.toggle('selected', fmt === 'pdf');
      fmtExcel.classList.toggle('selected', fmt === 'excel');
    });
  });

  // Mode radio toggle
  const optWeekly = backdrop.querySelector('#opt-weekly') as HTMLElement;
  const optDaily = backdrop.querySelector('#opt-daily') as HTMLElement;
  const dayPicker = backdrop.querySelector('#export-day-picker') as HTMLElement;
  const radios = backdrop.querySelectorAll('input[name="export-mode"]');

  radios.forEach((r) => {
    r.addEventListener('change', () => {
      const mode = (r as HTMLInputElement).value;
      optWeekly.classList.toggle('selected', mode === 'weekly');
      optDaily.classList.toggle('selected', mode === 'daily');
      if (mode === 'daily') {
        dayPicker.classList.remove('hidden');
        dayPicker.style.display = 'flex';
      } else {
        dayPicker.classList.add('hidden');
        dayPicker.style.display = '';
      }
    });
  });

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

    try {
      status.textContent = 'מייצא…';
      status.style.color = '';
      if (selectedFormat === 'excel') {
        if (selectedMode === 'weekly') {
          await exportWeeklyExcel(currentSchedule, dayStartHour);
        } else {
          await exportDailyExcel(currentSchedule, getSelectedDay(), dayStartHour);
        }
      } else {
        if (selectedMode === 'weekly') {
          exportWeeklyOverview(currentSchedule, dayStartHour);
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

function hideAvailabilityPopover(): void {
  if (_availabilityPopoverKeyHandler) {
    document.removeEventListener('keydown', _availabilityPopoverKeyHandler);
    _availabilityPopoverKeyHandler = null;
  }
  if (_availabilityPopoverEl) {
    _availabilityPopoverEl.remove();
    _availabilityPopoverEl = null;
  }
}

function getAvailableParticipantsInRange(
  schedule: Schedule,
  rangeStartMs: number,
  rangeEndMs: number,
  preMarginMs = 0,
  postMarginMs = 0,
  hideSleepRecovery = false,
): { participants: Participant[]; sleepRecoveryIds: Set<string> } {
  const taskMap = new Map(schedule.tasks.map((task) => [task.id, task]));
  const participantWindows = new Map<string, { startMs: number; endMs: number }[]>();
  const participantTasks = new Map<string, Task[]>();
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
    participantWindows.get(assignment.participantId)!.push({
      startMs: task.timeBlock.start.getTime(),
      endMs: task.timeBlock.end.getTime(),
    });
    if (!participantTasks.has(assignment.participantId)) {
      participantTasks.set(assignment.participantId, []);
    }
    participantTasks.get(assignment.participantId)!.push(task);
  }
  const effectiveStart = rangeStartMs - preMarginMs;
  const effectiveEnd = rangeEndMs + postMarginMs;
  const effectiveWindow = { start: new Date(effectiveStart), end: new Date(effectiveEnd) };
  const sleepRecoveryIds = new Set<string>();
  const participants: Participant[] = [];
  for (const participant of schedule.participants) {
    const windows = participantWindows.get(participant.id);
    if (windows?.some((w) => w.startMs < effectiveEnd && w.endMs > effectiveStart)) continue;
    // Also exclude participants marked unavailable for any portion of the range
    // via availability gaps, recurring weekly rules, or schedule-level
    // unavailability entries (🆘 Future SOS).
    if (findPreExistingUnavailabilityOverlaps(participant, schedule, effectiveWindow).length > 0) {
      continue;
    }
    // HC-15 sleep-recovery: reports whether any finished task produces a
    // recovery window that overlaps the effective range. When the strict
    // filter is on, these participants are excluded; otherwise they stay in
    // the list and the caller renders a 😴 badge.
    let inRecovery = false;
    const tasks = participantTasks.get(participant.id);
    if (tasks) {
      for (const task of tasks) {
        const rw = getRecoveryWindow(task);
        if (!rw) continue;
        if (rw.start.getTime() < effectiveEnd && rw.end.getTime() > effectiveStart) {
          inRecovery = true;
          break;
        }
      }
    }
    if (inRecovery) {
      if (hideSleepRecovery) continue;
      sleepRecoveryIds.add(participant.id);
    }
    participants.push(participant);
  }
  // Warn if suspiciously all participants are available despite assignments existing
  if (participants.length === schedule.participants.length && schedule.assignments.length > 0) {
    console.warn('[עתודה] כל המשתתפים מסומנים כפנויים למרות שיש שיבוצים. מידע לאבחון:', {
      tasks: schedule.tasks.length,
      assignments: schedule.assignments.length,
      participants: schedule.participants.length,
      orphanAssignments,
      participantWindowsCount: participantWindows.size,
      rangeStart: new Date(rangeStartMs).toString(),
      rangeEnd: new Date(rangeEndMs).toString(),
      sampleTask: schedule.tasks[0]
        ? {
            start: schedule.tasks[0].timeBlock.start.toString(),
            end: schedule.tasks[0].timeBlock.end.toString(),
          }
        : null,
      sampleAssignment: schedule.assignments[0],
      sampleParticipantId: schedule.participants[0]?.id,
      participantIdInWindows: participantWindows.has(schedule.participants[0]?.id ?? ''),
    });
  }
  return { participants, sleepRecoveryIds };
}

function buildAvailabilityPopoverContent(
  startMs: number,
  endMs: number,
  preMarginMs = 0,
  postMarginMs = 0,
  hideSleepRecovery = false,
): string {
  if (!currentSchedule) return '';
  const isRange = startMs !== endMs;
  const definitions = store.getPakalDefinitions();
  const { participants: available, sleepRecoveryIds } = getAvailableParticipantsInRange(
    currentSchedule,
    startMs,
    endMs,
    preMarginMs,
    postMarginMs,
    hideSleepRecovery,
  );
  const pakalimByParticipantId = new Map(
    available.map((participant) => [participant.id, getEffectivePakalDefinitions(participant, definitions)]),
  );

  const summarizeParticipants = (participants: Participant[]): string => {
    if (participants.length === 0) return 'אין פנויים כרגע';
    const leadingNames = participants.slice(0, 2).map((participant) => participant.name);
    const remaining = participants.length - leadingNames.length;
    return remaining > 0 ? `${leadingNames.join(', ')} +${remaining}` : leadingNames.join(', ');
  };

  const buckets = definitions.map((def) => {
    const participants = available.filter((participant) =>
      (pakalimByParticipantId.get(participant.id) || []).some((item) => item.id === def.id),
    );
    return {
      label: def.label,
      participants,
      count: participants.length,
      preview: summarizeParticipants(participants),
      className: 'availability-bucket',
    };
  });

  const noPakalParticipants = available.filter(
    (participant) => (pakalimByParticipantId.get(participant.id)?.length ?? 0) === 0,
  );
  const multiPakalParticipants = available.filter(
    (participant) => (pakalimByParticipantId.get(participant.id)?.length ?? 0) > 1,
  );
  const totalWithPakal = available.length - noPakalParticipants.length;
  const noPakalBucket = {
    label: 'ללא שיוך לפק"ל',
    participants: noPakalParticipants,
    count: noPakalParticipants.length,
    preview: summarizeParticipants(noPakalParticipants),
    className: 'availability-bucket availability-bucket-none',
  };
  const visibleBuckets = buckets
    .filter((bucket) => bucket.count > 0)
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'he'));
  const emptyBuckets = buckets.filter((bucket) => bucket.count === 0);
  const displayBuckets = [...visibleBuckets, noPakalBucket, ...emptyBuckets];

  const renderParticipantList = (participants: Participant[]): string => {
    if (participants.length === 0) return '<div class="availability-empty">כרגע אין פנויים בקבוצה הזאת.</div>';
    return `<div class="availability-name-list">${participants
      .map((participant) => {
        const pakalCount = pakalimByParticipantId.get(participant.id)?.length ?? 0;
        const inRecovery = sleepRecoveryIds.has(participant.id);
        const recoveryBadge = inRecovery
          ? `<span class="badge badge-sm availability-sleep-tag" title="בהשלמות שינה והתאוששות">😴</span>`
          : '';
        const pakalBadge =
          pakalCount > 1 ? `<span class="badge badge-sm availability-multi-tag">${pakalCount} פק"לים</span>` : '';
        return `<div class="availability-name-row"><span class="participant-hover" data-pid="${participant.id}">${escHtml(participant.name)}</span>${recoveryBadge}${pakalBadge}</div>`;
      })
      .join('')}</div>`;
  };

  const renderBucket = (bucket: {
    label: string;
    participants: Participant[];
    count: number;
    preview: string;
    className: string;
  }): string => {
    const bucketLabel = escHtml(bucket.label);
    const preview = escHtml(bucket.preview);
    if (bucket.count === 0) {
      return `<div class="${bucket.className} availability-bucket-empty availability-bucket-zero"><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">אין פנויים כרגע</span></span><span class="availability-bucket-count">0</span></div>`;
    }
    return `<details class="${bucket.className}">
      <summary><span class="availability-bucket-main"><span class="availability-bucket-label">${bucketLabel}</span><span class="availability-bucket-preview">${preview}</span></span><span class="availability-bucket-count">${bucket.count}</span></summary>
      ${renderParticipantList(bucket.participants)}
    </details>`;
  };

  const quickStats = [
    { label: 'עם פק"ל', value: totalWithPakal },
    { label: 'ללא פק"ל', value: noPakalParticipants.length },
    { label: 'בכמה פק"לים', value: multiPakalParticipants.length },
  ];

  const startDate = new Date(startMs);
  const endDate = new Date(endMs);
  const sameDay = hebrewDayName(startDate) === hebrewDayName(endDate);
  const rangeLabel = sameDay
    ? `${fmtDate(startDate)} — ${fmt(endDate)}`
    : `${fmtDate(startDate)} — ${fmtDate(endDate)}`;
  const subtitle = isRange ? rangeLabel : `נכון ל${fmtDate(startDate)}`;

  return `
    <div class="availability-popover-header">
      <div>
        <h3>פנויים לפי פק"ל</h3>
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
            <strong>${available.length === 0 ? 'אין עתודה פנויה' : 'עתודה פנויה'}</strong>
            <span>${isRange ? 'מספר המשתתפים שפנויים לאורך כל הטווח.' : 'מספר המשתתפים שלא נמצאים כרגע במשימה.'}</span>
          </div>
        </div>
        <div class="availability-quick-stats">
          ${quickStats.map((stat) => `<div class="availability-quick-stat"><span class="availability-quick-stat-value">${stat.value}</span><span class="availability-quick-stat-label">${stat.label}</span></div>`).join('')}
        </div>
      </div>
      <div class="availability-summary-note">למטה מופיע פירוט לפי פק"ל. משתתף עם יותר מפק"ל אחד יכול להופיע ביותר מקבוצה אחת.</div>
      <div class="availability-section-title">פירוט מהיר לפי פק"ל</div>
      <div class="availability-bucket-list">
        ${displayBuckets.map(renderBucket).join('')}
      </div>
      ${
        multiPakalParticipants.length > 0
          ? `<details class="availability-overlap">
        <summary><span class="availability-bucket-main"><span class="availability-bucket-label">מופיעים בכמה פק"לים</span><span class="availability-bucket-preview">כדאי לבדוק אותם קודם</span></span><span class="availability-bucket-count">${multiPakalParticipants.length}</span></summary>
        <div class="availability-overlap-note">המשתתפים כאן כבר נספרו בפירוט שלמעלה. הרשימה הזאת רק עוזרת לזהות במהירות חפיפות בין פק"לים.</div>
        ${renderParticipantList(multiPakalParticipants)}
      </details>`
          : ''
      }
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
    // Set .touch-device / .pointer-device on <html> before first render
    initResponsive();

    // Initialize tooltip callbacks before first render
    initTooltips({
      onSwap: handleSwap,
      onRescue: openRescueModal,
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

    // Initialize BALTAM injection modal callbacks
    initInjectTaskModal({
      getSchedule: () => currentSchedule,
      getEngine: () => engine,
      onCommit: (updatedSchedule, report, saveToStore, spec) => {
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
            displayCategory: spec.displayCategory,
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
      onPlanApplied: (updatedSchedule, swapLabels, swappedAssignmentIds) => {
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

    // Update the live clock every 30 seconds without a full re-render
    if (_liveClockInterval) clearInterval(_liveClockInterval);
    _liveClockInterval = setInterval(() => {
      const el = document.getElementById('live-clock');
      if (el) el.textContent = formatLiveClock();
    }, 30_000);

    // Sync tab/day when user navigates with browser back/forward
    window.addEventListener('popstate', () => {
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
