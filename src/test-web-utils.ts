/**
 * Web-utility unit tests (Group B — imports src/web; run under
 * tsconfig.test-persistence.json via `npm run test:persistence`).
 *
 * Covers:
 *  - C7.1  tutorial-demo enter -> mutate -> exit real-data round-trip
 *  - C7.7  certification-utils / pakal-utils pure functions + escaped badge path
 *  - C7.8  tutorial-demo.assertSafeToEnterDemo gates + sheet-vs-modal precedence
 *  - C7.9  delete-participant cascade (dateUnavailability + not-with) + undo
 *  - C7.2  escHtml / escAttr exact output + a render site does not emit raw <script>
 *  - C7.10 cross-day split day-bucketing (residual + halves share the
 *          occurrence op-day; non-split / non-boundary unchanged)
 *  - C7.11 computeDefaultLiveAnchor / anchorToPickerDefaults ("now" → op-day
 *          coordinates with before/after-window clamping)
 *  - C7.12 liveAnchorFromPicker tail-hour offset + exportDaySnapshot base date
 *  - C7.13 swimlane getParticipantTasksForDay raw-block membership (no
 *          straddling-split "ghost" row; non-split cross-day unchanged)
 *  - C7.14 computePerDayHours load-weighted per-day hours (weight 0 → 0, 0.2 →
 *          ⅕, cross-day apportionment sums to effectiveHours; swimlane chip raw)
 *
 * Convention: export `runWebUtilsTests(assert)`, injected assert, no
 * module-level counters, standalone self-exec guarded by
 * `require.main === module`.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// localStorage / DOMException / location / document shims
// (replicated from the head of src/test-persistence.ts — MUST run BEFORE any
//  src/web import; `document.querySelector` is ADDED here for
//  assertSafeToEnterDemo, which the persistence harness never exercises.)
// ═══════════════════════════════════════════════════════════════════════════════

class MemoryStorage {
  private _data = new Map<string, string>();
  getItem(key: string): string | null {
    return this._data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this._data.set(key, value);
  }
  removeItem(key: string): void {
    this._data.delete(key);
  }
  clear(): void {
    this._data.clear();
  }
  key(index: number): string | null {
    return [...this._data.keys()][index] ?? null;
  }
  get length(): number {
    return this._data.size;
  }
}

// biome-ignore lint: test shims require dynamic globalThis assignment
const _gs = globalThis as any;
if (typeof _gs.localStorage === 'undefined') {
  _gs.localStorage = new MemoryStorage();
}
if (typeof _gs.DOMException === 'undefined') {
  _gs.DOMException = class DOMException extends Error {
    code: number;
    constructor(message?: string, name?: string) {
      super(message);
      this.name = name || 'DOMException';
      this.code = name === 'QuotaExceededError' ? 22 : 0;
    }
  };
}
if (typeof _gs.location === 'undefined') {
  _gs.location = { reload: () => {}, href: 'http://localhost:5174/' };
}

// Controllable `document.querySelector` for assertSafeToEnterDemo. Tests set
// `_presentClasses` to model which DOM markers are "open". querySelector
// receives exactly two selector strings from assertSafeToEnterDemo:
//   '.gm-edit-sheet-v2'  and  '.gm-modal-dialog, .gm-modal'
const _presentClasses = new Set<string>();
function _querySelector(selector: string): unknown {
  const tokens = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
  return tokens.some((t) => _presentClasses.has(t)) ? {} : null;
}
if (typeof _gs.document === 'undefined') {
  _gs.document = {
    createElement: () => ({ click: () => {}, style: {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
    querySelector: (sel: string) => _querySelector(sel),
    documentElement: { dataset: {} },
  };
} else if (typeof _gs.document.querySelector === 'undefined') {
  _gs.document.querySelector = (sel: string) => _querySelector(sel);
}
if (typeof _gs.navigator === 'undefined') _gs.navigator = {};
if (typeof _gs.window === 'undefined') {
  _gs.window = { matchMedia: () => ({ matches: false }) };
}

// ─── Now safe to import src/web ──────────────────────────────────────────────
import {
  type DateUnavailability,
  Level,
  type PakalDefinition,
  type Participant,
  type Schedule,
  type Task,
} from './models/types';
import { taskOpDayEnd, taskOpDayStart } from './utils/date-utils';
import * as appHost from './web/app-tutorial-hooks';
import { normalizeCertificationDefinitions } from './web/certification-utils';
import * as store from './web/config-store';
import { exportDaySnapshot } from './web/continuity-export';
import { getNumDays, getTasksForDay } from './web/export-utils';
import {
  clonePakalDefinitions,
  getEffectivePakalDefinitions,
  getEffectivePakalIds,
  getPakalLabels,
  normalizePakalDefinitions,
  renderPakalBadges,
  sanitizePakalIds,
} from './web/pakal-utils';
import {
  anchorToPickerDefaults,
  computeDefaultLiveAnchor,
  computePerDayHours,
  liveAnchorFromPicker,
  taskDayIndex,
  taskIntersectsDay,
  timestampToOpDayIndex,
} from './web/schedule-utils';
import { getParticipantTasksForDay, totalAssignedHoursForDay } from './web/swimlane-utils';
import { enterTutorialDemoMode, exitTutorialDemoMode, TutorialPreflightError } from './web/tutorial-demo';
import { DEMO_PARTICIPANTS } from './web/tutorial-demo-seed';
import { escAttr, escHtml } from './web/ui-helpers';

type AssertFn = (condition: boolean, name: string) => void;

// EXTRA_PREF_KEYS is not exported from tutorial-demo.ts; mirror it so the
// round-trip comparison uses exactly the key set the orchestrator captures.
const EXTRA_PREF_KEYS = ['gardenmanager_theme', 'gardenmanager_default_attempts', 'gm-sidebar-collapsed'];
const BACKUP_KEY = 'gardenmanager_pre_tutorial_snapshot';

// ─── App-tutorial-hooks mock ─────────────────────────────────────────────────
// tutorial-demo.ts reaches into app.ts only through this registry. A faithful
// mock lets us drive the REAL enter/exit code paths without app.ts/DOM.

interface MockAppState {
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

let _mockAppState: MockAppState;
let _manualBuildActive = false;
let _lastLoadedSchedule: Schedule | null | undefined;
let _hooksRegistered = false;

// Read through a function so TS control-flow analysis does not narrow the
// module variable to `undefined` (it is reassigned inside the hook closure,
// which CFA cannot see).
function getLastLoadedSchedule(): Schedule | null | undefined {
  return _lastLoadedSchedule;
}

function realHasFrozenFields(sched: Schedule | null | undefined): boolean {
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

function registerMockHooks(): void {
  if (_hooksRegistered) return;
  _hooksRegistered = true;
  appHost.register({
    getAppStateSnapshot: () => JSON.parse(JSON.stringify(_mockAppState)),
    applyAppStateSnapshot: (s) => {
      _mockAppState = JSON.parse(JSON.stringify(s));
    },
    loadScheduleFromFrozen: (s) => {
      _lastLoadedSchedule = s;
    },
    generateTasksFromTemplates: () => [],
    setSuppressOnStoreChanged: () => {},
    isManualBuildActive: () => _manualBuildActive,
    hasFrozenFields: (s) => realHasFrozenFields(s),
    setUiForDemo: () => {},
    renderAll: () => {},
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshMockAppState(continuityJson: string): MockAppState {
  return {
    currentTab: 'participants',
    currentDay: 1,
    viewMode: 'SCHEDULE_VIEW',
    profileParticipantId: null,
    taskPanelSourceName: null,
    continuityJson,
    sidebarCollapsed: false,
    scheduleDirty: false,
    snapshotDirty: false,
    hash: '',
  };
}

/** Read the exact key set tutorial-demo.captureStorageEntries() snapshots. */
function readCaptureEntries(): Record<string, string | null> {
  const keys = [...store.getAllStorageKeys(), ...EXTRA_PREF_KEYS];
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = localStorage.getItem(k);
  return out;
}

/**
 * Canonical JSON of all user-meaningful store data. Both the pre-enter
 * baseline and the post-exit state are produced AFTER an initStore() reload,
 * so a plain string compare is a fair structural-identity check (no
 * undefined-vs-missing JSON noise).
 */
function snapshotStoreState(): string {
  const participants = store
    .getAllParticipants()
    .map((p) => ({
      ...p,
      availability: p.availability.map((w) => [w.start.getTime(), w.end.getTime()]),
      // DateUnavailability.id is intentionally NOT persisted: saveToStorage
      // strips it and loadFromStorage regenerates a fresh uid('du') on every
      // load. Two plain reloads of identical bytes therefore get different
      // ids — it is an ephemeral runtime handle, not user data. Strip it so
      // the comparison reflects structural identity of real content.
      dateUnavailability: store.getDateUnavailabilities(p.id).map(({ id: _id, ...rest }) => rest),
      notWith: store.getNotWithIds(p.id).slice().sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const live = store.getLiveModeState();
  return JSON.stringify({
    scheduleDate: store.getScheduleDate().getTime(),
    scheduleDays: store.getScheduleDays(),
    restRules: store.getRestRules(),
    certDefs: store.getCertificationDefinitions(),
    pakalDefs: store.getPakalDefinitions(),
    participants,
    templates: store.getAllTaskTemplates(),
    oneTimeTasks: store.getAllOneTimeTasks().map((o) => ({ ...o, scheduledDate: o.scheduledDate.getTime() })),
    liveMode: { enabled: live.enabled, ts: live.currentTimestamp.getTime() },
  });
}

function buildFrozenSchedule(id: string): Schedule {
  const periodStart = new Date(2026, 5, 7); // a Sunday, future-ish
  const taskStart = new Date(2026, 5, 7, 6, 0, 0);
  const taskEnd = new Date(2026, 5, 7, 14, 0, 0);
  return {
    id,
    tasks: [
      {
        id: 'wt-task-1',
        name: 'WUtilTask D1',
        sourceName: 'WUtilTask',
        timeBlock: { start: taskStart, end: taskEnd },
        requiredCount: 1,
        slots: [{ slotId: 'wt-slot-1', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
        sameGroupRequired: false,
        blocksConsecutive: false,
      },
    ],
    participants: [],
    assignments: [],
    feasible: true,
    score: {
      minRestHours: 24,
      avgRestHours: 24,
      workloadStdDev: 0,
      totalPenalty: 0,
      compositeScore: 100,
      l0StdDev: 0,
      l0AvgEffective: 8,
      seniorStdDev: 0,
      seniorAvgEffective: 0,
      dailyPerParticipantStdDev: 0,
      dailyGlobalStdDev: 0,
      restPerGapBonus: 0,
    },
    violations: [],
    generatedAt: new Date(2026, 5, 7, 12, 0, 0),
    algorithmSettings: {
      config: { ...store.getAlgorithmSettings().config },
      disabledHardConstraints: [],
      dayStartHour: 5,
    },
    periodStart,
    periodDays: 3,
    restRuleSnapshot: { 'wt-rule': 8 },
    certLabelSnapshot: { Nitzan: 'ניצן' },
    scheduleUnavailability: [],
  } as Schedule;
}

/** Build a deterministic custom roster + templates + schedule + persist it. */
function seedCustomUserState(): { p1: Participant; p2: Participant; sched: Schedule } {
  // Wipe whatever initStore() seeded.
  for (const p of store.getAllParticipants()) store.removeParticipant(p.id);
  for (const t of store.getAllTaskTemplates()) store.removeTaskTemplate(t.id);
  for (const o of store.getAllOneTimeTasks()) store.removeOneTimeTask(o.id);
  for (const r of store.getRestRules()) store.removeRestRule(r.id);

  store.setScheduleDays(3);

  const rr = store.addRestRule('מנוחת לילה ארוכה', 9);

  // p1 carries a hostile free-text name + a date-unavailability + a not-with.
  const p1 = store.addParticipant({
    name: 'Custom <b>"User"</b> & אבי',
    level: Level.L3,
    group: 'גדוד א',
    certifications: ['Nitzan', 'Hamama'],
  });
  const p2 = store.addParticipant({ name: 'בני שני', level: Level.L0, group: 'גדוד א', certifications: ['Nitzan'] });
  const p3 = store.addParticipant({ name: 'גדי שלישי', level: Level.L4, group: 'גדוד ב', certifications: [] });

  store.addDateUnavailability(p1.id, {
    dayIndex: 2,
    endDayIndex: 2,
    startHour: 8,
    endHour: 16,
    allDay: false,
    reason: 'תורנות "מיוחדת" <x>',
  });
  store.addNotWith(p1.id, p3.id);

  store.addTaskTemplate({
    name: 'משימה מותאמת',
    durationHours: 6,
    shiftsPerDay: 2,
    startHour: 6,
    sameGroupRequired: false,
    blocksConsecutive: true,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [],
    slots: [
      {
        id: 'cu-slot-1',
        label: 'אחראי',
        acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    restRuleId: rr.id,
    color: '#123456',
  });

  // Deterministic live-mode value so the round-trip exercises that key with a
  // stable persisted payload (the demo flips live mode on).
  store.setLiveModeEnabled(true);
  store.setLiveModeTimestamp(new Date(2026, 5, 7, 9, 30, 0));

  const sched = buildFrozenSchedule('user-sched-1');
  store.saveSchedule(sched);
  store.flushPendingSave();
  store.saveToStorage();
  localStorage.setItem('gardenmanager_theme', 'light');

  return { p1, p2, sched };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════════════════════════

export async function runWebUtilsTests(assert: AssertFn): Promise<void> {
  console.log('\n══════════════════════════════════════════');
  console.log('  Web-Utility Unit Tests (test-web-utils)');
  console.log('══════════════════════════════════════════');

  registerMockHooks();

  // ───────────────────────────────────────────────────────────────────────────
  // C7.1 — Tutorial demo enter -> mutate -> exit real-data round-trip (P0)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.1: tutorial-demo enter/exit round-trip ──');
  {
    localStorage.clear();
    store.initStore(); // seed defaults so we are realistic, then overwrite
    seedCustomUserState();

    // Canonicalise the in-memory baseline through the same reload path exit
    // uses, so the post-exit comparison is structural (not undefined-noise).
    store.initStore();
    const baselineStoreJson = snapshotStoreState();
    const capturedEntries = readCaptureEntries();

    _presentClasses.clear();
    _manualBuildActive = false;
    _mockAppState = freshMockAppState('USER-CONTINUITY-BLOB-v1');
    const appStateBaseline = JSON.parse(JSON.stringify(_mockAppState));
    _lastLoadedSchedule = undefined;

    const customNames = store
      .getAllParticipants()
      .map((p) => p.name)
      .sort();

    enterTutorialDemoMode();

    // Non-vacuous: the demo really replaced the user's roster.
    const demoNames = store
      .getAllParticipants()
      .map((p) => p.name)
      .sort();
    const expectedDemo = DEMO_PARTICIPANTS.map((d) => d.name).sort();
    assert(
      store.getAllParticipants().length === DEMO_PARTICIPANTS.length &&
        JSON.stringify(demoNames) === JSON.stringify(expectedDemo),
      'C7.1: enter loaded the demo roster (state actually mutated)',
    );
    assert(
      JSON.stringify(demoNames) !== JSON.stringify(customNames),
      'C7.1: demo roster differs from user roster (round-trip is meaningful)',
    );
    assert(localStorage.getItem(BACKUP_KEY) !== null, 'C7.1: durable pre-tutorial backup written on enter');

    // Simulate a walkthrough mutating demo state mid-tour.
    store.addParticipant({ name: 'WALK-TEST PHANTOM', level: Level.L0, group: 'demo' });
    _mockAppState.continuityJson = 'DEMO-CONTINUITY-MUTATED';
    _mockAppState.currentTab = 'schedule';

    exitTutorialDemoMode();

    // PRIMARY: every captured key is byte-identical after exit. This is the
    // direct "no user-data corruption" proof — all user state lives in these
    // localStorage keys and exit must restore them exactly.
    const afterEntries = readCaptureEntries();
    const mismatchedKeys: string[] = [];
    for (const k of Object.keys(capturedEntries)) {
      if (capturedEntries[k] !== afterEntries[k]) mismatchedKeys.push(k);
    }
    assert(
      mismatchedKeys.length === 0,
      `C7.1: localStorage byte-identical after exit (mismatched: ${mismatchedKeys.join(', ') || 'none'})`,
    );

    assert(localStorage.getItem(BACKUP_KEY) === null, 'C7.1: durable backup removed on clean exit');

    // SECONDARY: in-memory store after exit equals a canonical reload of the
    // restored bytes — no demo residue leaked past restore.
    const afterStoreJson = snapshotStoreState();
    assert(afterStoreJson === baselineStoreJson, 'C7.1: store state structurally identical to pre-enter baseline');

    // App-state (continuity etc.) restored via applyAppStateSnapshot.
    assert(
      JSON.stringify(_mockAppState) === JSON.stringify(appStateBaseline),
      'C7.1: app-state snapshot (continuity/tab) restored on exit',
    );
    assert(_mockAppState.continuityJson === 'USER-CONTINUITY-BLOB-v1', 'C7.1: user continuity blob restored exactly');

    // Concrete human-meaningful survival check.
    const restoredP1 = store.getAllParticipants().find((p) => p.name === 'Custom <b>"User"</b> & אבי');
    assert(!!restoredP1, 'C7.1: hostile-named custom participant restored verbatim');
    if (restoredP1) {
      const du = store.getDateUnavailabilities(restoredP1.id);
      assert(
        du.length === 1 && du[0].reason === 'תורנות "מיוחדת" <x>' && du[0].startHour === 8,
        'C7.1: custom participant dateUnavailability restored',
      );
      assert(store.getNotWithIds(restoredP1.id).length === 1, 'C7.1: custom participant not-with pair restored');
    }

    // Exit reloaded the user's frozen schedule (not the demo one).
    const ls = getLastLoadedSchedule();
    assert(!!ls && ls.id === 'user-sched-1', 'C7.1: user frozen schedule reloaded on exit');

    store.flushPendingSave(); // drain any stray debounce timer for test isolation
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.8 — assertSafeToEnterDemo gates + sheet-vs-modal precedence (P1)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.8: assertSafeToEnterDemo gates ──');
  {
    localStorage.clear();
    store.initStore();
    const pCountBefore = store.getAllParticipants().length;

    const tryEnter = (): { threw: boolean; reason?: string; isPreflight: boolean } => {
      try {
        enterTutorialDemoMode();
        return { threw: false, isPreflight: false };
      } catch (e) {
        const pf = e instanceof TutorialPreflightError;
        return { threw: true, isPreflight: pf, reason: pf ? (e as TutorialPreflightError).reason : String(e) };
      }
    };

    // Gate 1: manual build in progress.
    _presentClasses.clear();
    _manualBuildActive = true;
    let r = tryEnter();
    assert(
      r.threw && r.isPreflight && r.reason === 'manual-build',
      'C7.8: manual-build gate throws reason=manual-build',
    );

    // Gate 2: participant editor sheet open (carries BOTH .gm-edit-sheet-v2
    // AND .gm-modal-dialog, as the real DOM element does).
    _manualBuildActive = false;
    _presentClasses.clear();
    _presentClasses.add('gm-edit-sheet-v2');
    _presentClasses.add('gm-modal-dialog');
    r = tryEnter();
    assert(r.threw && r.isPreflight && r.reason === 'sheet-dirty', 'C7.8: sheet-open gate throws reason=sheet-dirty');

    // Gate 3: generic modal open (no sheet).
    _presentClasses.clear();
    _presentClasses.add('gm-modal-dialog');
    r = tryEnter();
    assert(r.threw && r.isPreflight && r.reason === 'modal-open', 'C7.8: modal-open gate throws reason=modal-open');

    // Gate 3b: alternate generic modal class.
    _presentClasses.clear();
    _presentClasses.add('gm-modal');
    r = tryEnter();
    assert(r.threw && r.isPreflight && r.reason === 'modal-open', 'C7.8: .gm-modal also triggers modal-open');

    // PRECEDENCE: sheet + modal both present, no manual build -> sheet-dirty
    // must win (order-sensitive check; comment-flagged fragile in source).
    _presentClasses.clear();
    _presentClasses.add('gm-edit-sheet-v2');
    _presentClasses.add('gm-modal-dialog');
    r = tryEnter();
    assert(
      r.threw && r.isPreflight && r.reason === 'sheet-dirty',
      'C7.8: sheet-vs-modal precedence preserved (sheet-dirty beats modal-open)',
    );

    // PRECEDENCE: manual-build is checked first of all.
    _manualBuildActive = true;
    _presentClasses.clear();
    _presentClasses.add('gm-edit-sheet-v2');
    _presentClasses.add('gm-modal-dialog');
    r = tryEnter();
    assert(
      r.threw && r.isPreflight && r.reason === 'manual-build',
      'C7.8: manual-build precedence (checked before sheet/modal)',
    );

    // A blocked enter must not mutate the store (gate runs before side effects).
    assert(store.getAllParticipants().length === pCountBefore, 'C7.8: blocked enter leaves store untouched');

    _manualBuildActive = false;
    _presentClasses.clear();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.9 — delete-participant cascade + undo (P1)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.9: delete-participant cascade + undo ──');
  {
    localStorage.clear();
    store.initStore();
    for (const p of store.getAllParticipants()) store.removeParticipant(p.id);

    const a = store.addParticipant({ name: 'Cascade-A', level: Level.L3, group: 'X', certifications: ['Nitzan'] });
    const b = store.addParticipant({ name: 'Cascade-B', level: Level.L0, group: 'X', certifications: [] });
    const c = store.addParticipant({ name: 'Cascade-C', level: Level.L4, group: 'Y', certifications: [] });

    store.addNotWith(a.id, b.id);
    store.addNotWith(a.id, c.id);
    const duRule: Omit<DateUnavailability, 'id'> = {
      dayIndex: 1,
      startHour: 6,
      endHour: 22,
      allDay: false,
      reason: 'cascade-test',
    };
    store.addDateUnavailability(a.id, duRule);

    assert(store.getDateUnavailabilities(a.id).length === 1, 'C7.9: precondition — A has a dateUnavailability');
    assert(
      store.getNotWithIds(a.id).length === 2 &&
        store.getNotWithIds(b.id).includes(a.id) &&
        store.getNotWithIds(c.id).includes(a.id),
      'C7.9: precondition — A not-with B and C (symmetric)',
    );

    store.removeParticipant(a.id);

    assert(store.getParticipant(a.id) === undefined, 'C7.9: cascade — participant removed');
    assert(store.getDateUnavailabilities(a.id).length === 0, 'C7.9: cascade — A dateUnavailability dropped');
    assert(
      store.getNotWithIds(a.id).length === 0 &&
        !store.getNotWithIds(b.id).includes(a.id) &&
        !store.getNotWithIds(c.id).includes(a.id),
      'C7.9: cascade — not-with references removed on both partners',
    );

    const undone = store.undo();
    assert(undone, 'C7.9: undo returned true');

    const restoredA = store.getParticipant(a.id);
    assert(
      !!restoredA && restoredA.name === 'Cascade-A' && restoredA.level === Level.L3,
      'C7.9: undo — participant restored with original fields',
    );
    assert(
      store.getDateUnavailabilities(a.id).length === 1 &&
        store.getDateUnavailabilities(a.id)[0].reason === 'cascade-test',
      'C7.9: undo — A dateUnavailability fully restored',
    );
    assert(
      store.getNotWithIds(a.id).slice().sort().join(',') === [b.id, c.id].sort().join(',') &&
        store.getNotWithIds(b.id).includes(a.id) &&
        store.getNotWithIds(c.id).includes(a.id),
      'C7.9: undo — not-with pairs restored on both directions',
    );
    assert(
      Array.isArray(restoredA?.notWithIds) && (restoredA?.notWithIds?.length ?? 0) === 2,
      'C7.9: undo — restored participant.notWithIds synced',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.7 — certification-utils / pakal-utils pure functions (P1)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.7: certification-utils / pakal-utils ──');
  {
    // normalizeCertificationDefinitions: trim, dedupe by id, default color,
    // skip blanks, preserve tombstone, non-array -> [].
    const certs = normalizeCertificationDefinitions([
      { id: ' c1 ', label: '  Alpha  ' },
      { id: 'c1', label: 'DuplicateIgnored', color: '#fff' }, // dup id -> skipped
      { id: 'c2', label: 'Beta', color: ' #abcdef ', deleted: true },
      { id: '', label: 'NoId' }, // skipped
      { id: 'c3', label: '' }, // skipped (blank label)
      'not-an-object',
      null,
    ]);
    assert(certs.length === 2, 'C7.7: normalizeCert dedupes & drops invalid (2 kept)');
    assert(
      certs[0].id === 'c1' && certs[0].label === 'Alpha' && certs[0].color === '#7f8c8d',
      'C7.7: normalizeCert trims id/label and applies default color',
    );
    assert(certs[1].deleted === true && certs[1].color === '#abcdef', 'C7.7: normalizeCert preserves tombstone+color');
    assert(normalizeCertificationDefinitions('nope' as unknown).length === 0, 'C7.7: normalizeCert non-array -> []');

    // pakal-utils
    const pakDefs = normalizePakalDefinitions([
      { id: 'p1', label: ' One ' },
      { id: 'p1', label: 'dupe' },
      { id: 'p2', label: 'Two', deleted: true },
      { id: 'p3' }, // blank label -> skipped
    ]);
    assert(
      pakDefs.length === 2 && pakDefs[0].id === 'p1' && pakDefs[0].label === 'One' && pakDefs[1].deleted === true,
      'C7.7: normalizePakal trims/dedupes/keeps tombstone',
    );

    const clone = clonePakalDefinitions(pakDefs);
    clone[0].label = 'MUTATED';
    assert(pakDefs[0].label === 'One', 'C7.7: clonePakalDefinitions returns independent objects');

    const fullDefs: PakalDefinition[] = [
      { id: 'pk-a', label: 'Aleph' },
      { id: 'pk-b', label: 'Bet' },
      { id: 'pk-dead', label: 'Gone', deleted: true },
    ];
    const partBase = {
      id: 'pp1',
      name: 'X',
      level: Level.L0,
      certifications: [],
      group: 'g',
      availability: [],
      dateUnavailability: [],
    };
    const part: Participant = { ...partBase, pakalIds: ['pk-b', 'pk-a', 'pk-b', 'pk-dead', 'ghost'] };
    assert(
      JSON.stringify(sanitizePakalIds(part.pakalIds, fullDefs)) === JSON.stringify(['pk-b', 'pk-a']),
      'C7.7: sanitizePakalIds dedupes, drops deleted+unknown, preserves first-seen order',
    );
    assert(
      JSON.stringify(getEffectivePakalIds(part, fullDefs)) === JSON.stringify(['pk-a', 'pk-b']),
      'C7.7: getEffectivePakalIds returns active ids in definition order',
    );
    assert(
      getEffectivePakalDefinitions(part, fullDefs)
        .map((d) => d.id)
        .join(',') === 'pk-a,pk-b',
      'C7.7: getEffectivePakalDefinitions filters to active defs',
    );
    assert(
      JSON.stringify(getPakalLabels(part, fullDefs)) === JSON.stringify(['Aleph', 'Bet']),
      'C7.7: getPakalLabels maps to active labels',
    );

    // Empty -> emptyLabel span.
    const emptyPart: Participant = { ...partBase, pakalIds: [] };
    assert(
      renderPakalBadges(emptyPart, fullDefs, 'NONE') === '<span class="text-muted">NONE</span>',
      'C7.7: renderPakalBadges empty -> emptyLabel span',
    );

    // Escaped-badge render path: active label + tombstone-orphan label + raw
    // orphan id all contain HTML/quote chars and MUST be escaped.
    const hostileDefs: PakalDefinition[] = [
      { id: 'pk-x', label: '<img src=x onerror=alert(1)>"&hi' },
      { id: 'pk-tomb', label: '"><script>tomb()</script>', deleted: true },
    ];
    const hostilePart: Participant = { ...partBase, pakalIds: ['pk-x', 'pk-tomb', 'pk-no-def<script>'] };
    const badges = renderPakalBadges(hostilePart, hostileDefs);
    assert(!badges.includes('<script>'), 'C7.7: renderPakalBadges emits no raw <script>');
    assert(!badges.includes('<img '), 'C7.7: renderPakalBadges escapes raw <img');
    assert(
      badges.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;hi'),
      'C7.7: active pakal label HTML-escaped in badge',
    );
    assert(
      badges.includes('&quot;&gt;&lt;script&gt;tomb()&lt;/script&gt;'),
      'C7.7: tombstone-orphan label HTML-escaped in badge',
    );
    assert(
      badges.includes('&lt;script&gt;') && badges.includes('pk-no-def'),
      'C7.7: raw-id orphan badge escaped (no active definition)',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.2 — escHtml / escAttr exact output + render-site no raw <script> (P1)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.2: escHtml / escAttr ──');
  {
    assert(
      escHtml('<script>alert("x")</script>') === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
      'C7.2: escHtml escapes <, >, "',
    );
    assert(escHtml('a & b') === 'a &amp; b', 'C7.2: escHtml escapes & first (no double-escape)');
    assert(
      escHtml('Tom & "Jerry" <tag>') === 'Tom &amp; &quot;Jerry&quot; &lt;tag&gt;',
      'C7.2: escHtml combined entities correct & ordered',
    );
    // Single quote is intentionally NOT escaped by escHtml.
    assert(escHtml("it's") === "it's", 'C7.2: escHtml leaves single-quote untouched (documented)');
    // Emoji + non-Latin pass through unchanged.
    assert(escHtml('שלום 🌱👍 test') === 'שלום 🌱👍 test', 'C7.2: escHtml passes emoji/Hebrew through');
    // Very long string: only specials transformed, length grows only by entities.
    const long = `${'a'.repeat(50000)}<${'b'.repeat(50000)}`; // length 100001
    const longEsc = escHtml(long);
    assert(
      longEsc.length === 100001 + 3 && longEsc.includes('a'.repeat(50000)) && longEsc.includes('&lt;'),
      'C7.2: escHtml handles very long string (single < -> &lt; adds 3 chars)',
    );
    assert(escHtml('') === '', 'C7.2: escHtml empty string');

    // escAttr: same final char set, & first then " then < then >.
    assert(escAttr('&"<>') === '&amp;&quot;&lt;&gt;', 'C7.2: escAttr escapes &, ", <, > (ampersand first)');
    assert(
      escAttr('x" onload="evil()') === 'x&quot; onload=&quot;evil()',
      'C7.2: escAttr neutralises attribute-breakout quote',
    );
    assert(escAttr("a'b") === "a'b", 'C7.2: escAttr leaves single-quote untouched (documented)');
    assert(
      escAttr('a&amp;b') === 'a&amp;amp;b',
      'C7.2: escAttr re-escapes existing entity ampersand (no special-casing)',
    );

    // Representative render site (renderPakalBadges -> escHtml) must not emit
    // a raw <script> when fed a hostile label.
    const def: PakalDefinition[] = [{ id: 'rs', label: '<script>steal()</script>' }];
    const rsPart: Participant = {
      id: 'rs-p',
      name: 'rs',
      level: Level.L0,
      certifications: [],
      group: 'g',
      availability: [],
      dateUnavailability: [],
      pakalIds: ['rs'],
    };
    const html = renderPakalBadges(rsPart, def);
    assert(
      !html.includes('<script>') && html.includes('&lt;script&gt;steal()&lt;/script&gt;'),
      'C7.2: render site escapes hostile label (no raw <script> in DOM string)',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.10 — Cross-day split bucketing: a split occurrence's residual + halves
  // share ONE op-day page (the occurrence's), never scattered onto `#b`'s
  // midpoint day. Non-split + non-boundary splits unchanged; row-key (real
  // timeBlock.start) untouched.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.10: cross-day split day-bucketing ──');
  {
    const periodStart = new Date(2026, 5, 1, 0, 0, 0, 0); // June 1; dayStartHour 5
    const dsh = 5;
    const EIGHT_H = 8 * 3600000;
    const sl = () => [{ slotId: 's', acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }];
    const base = { sourceName: 'g', requiredCount: 1, sameGroupRequired: false, blocksConsecutive: false };
    // Occurrence X: 02:00–10:00 June 2 — STARTS in the pre-dayStartHour tail
    // (op-day 1 = [Jun1 05:00, Jun2 05:00)); its midpoint 06:00 is op-day 2.
    const xStart = new Date(2026, 5, 2, 2, 0);
    const xEnd = new Date(2026, 5, 2, 10, 0);
    const xMid = new Date(2026, 5, 2, 6, 0);
    const Xr: Task = { ...base, id: 'X', name: 'X', timeBlock: { start: xStart, end: xEnd }, slots: sl() };
    const Xa: Task = {
      ...base,
      id: 'X::X-s1#a',
      name: 'X (1/2)',
      timeBlock: { start: xStart, end: xMid },
      slots: sl(),
      splitGroupId: 'X::X-s1',
      splitPart: 1,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'X',
    };
    const Xb: Task = {
      ...base,
      id: 'X::X-s1#b',
      name: 'X (2/2)',
      timeBlock: { start: xMid, end: xEnd },
      slots: sl(),
      splitGroupId: 'X::X-s1',
      splitPart: 2,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'X',
    };
    // Occurrence Y: 10:00–18:00 June 2 — fully inside op-day 2 (no boundary).
    const yStart = new Date(2026, 5, 2, 10, 0);
    const yEnd = new Date(2026, 5, 2, 18, 0);
    const yMid = new Date(2026, 5, 2, 14, 0);
    const Ya: Task = {
      ...base,
      id: 'Y::Y-s1#a',
      name: 'Y (1/2)',
      timeBlock: { start: yStart, end: yMid },
      slots: sl(),
      splitGroupId: 'Y::Y-s1',
      splitPart: 1,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'Y',
    };
    const Yb: Task = {
      ...base,
      id: 'Y::Y-s1#b',
      name: 'Y (2/2)',
      timeBlock: { start: yMid, end: yEnd },
      slots: sl(),
      splitGroupId: 'Y::Y-s1',
      splitPart: 2,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'Y',
    };
    const P: Task = {
      ...base,
      id: 'P',
      name: 'P',
      timeBlock: { start: new Date(2026, 5, 2, 12, 0), end: new Date(2026, 5, 2, 14, 0) },
      slots: sl(),
    };
    const sched = { periodStart, tasks: [Xr, Xa, Xb, Ya, Yb, P] } as unknown as Schedule;

    // Helper return values.
    assert(taskOpDayStart(Xr).getTime() === xStart.getTime(), 'C7.10: residual/non-split → timeBlock.start unchanged');
    assert(
      taskOpDayStart(Xa).getTime() === xStart.getTime(),
      'C7.10: #a → timeBlock.start (already = occurrence start)',
    );
    assert(
      taskOpDayStart(Xb).getTime() === xStart.getTime() &&
        taskOpDayStart(Xb).getTime() !== Xb.timeBlock.start.getTime(),
      'C7.10: #b re-anchored to occurrence start (≠ its midpoint timeBlock.start)',
    );
    assert(taskOpDayEnd(Xb).getTime() === xEnd.getTime(), 'C7.10: #b op-day-end = occurrence end');
    assert(taskOpDayEnd(P).getTime() === P.timeBlock.end.getTime(), 'C7.10: non-split op-day-end unchanged');
    assert(
      Xb.timeBlock.start.getTime() === xMid.getTime(),
      'C7.10: row-key untouched — #b.timeBlock.start still the midpoint',
    );

    // Export bucketing (PDF/XLSX funnel): all of X on op-day 1, none on day 2.
    const d1 = new Set(getTasksForDay(sched, 1, dsh).map((t) => t.id));
    const d2 = new Set(getTasksForDay(sched, 2, dsh).map((t) => t.id));
    assert(
      d1.has('X') && d1.has('X::X-s1#a') && d1.has('X::X-s1#b'),
      'C7.10: residual + both halves export on the occurrence op-day (1)',
    );
    assert(
      !d2.has('X') && !d2.has('X::X-s1#a') && !d2.has('X::X-s1#b'),
      'C7.10: NONE of X scattered onto the midpoint day (2) — the bug is fixed',
    );
    // Non-boundary split Y + plain P unchanged (still op-day 2, together).
    assert(
      d2.has('Y::Y-s1#a') && d2.has('Y::Y-s1#b'),
      'C7.10: non-boundary split — both halves stay together (unchanged)',
    );
    assert(d2.has('P') && !d1.has('P'), 'C7.10: non-split task bucketing unchanged');

    // Day-index + intersection: a split fragment behaves IDENTICALLY to the
    // residual / equivalent unsplit shift for day membership.
    assert(
      taskDayIndex(Xb, dsh, periodStart) === taskDayIndex(Xr, dsh, periodStart) &&
        taskDayIndex(Xa, dsh, periodStart) === taskDayIndex(Xr, dsh, periodStart),
      'C7.10: taskDayIndex — #a, #b, residual all resolve to the same op-day',
    );
    assert(
      taskIntersectsDay(Xb, 1, dsh, periodStart) === taskIntersectsDay(Xr, 1, dsh, periodStart) &&
        taskIntersectsDay(Xb, 2, dsh, periodStart) === taskIntersectsDay(Xr, 2, dsh, periodStart),
      'C7.10: taskIntersectsDay — #b ≡ residual on every op-day (fragment ≡ unsplit)',
    );
    assert(
      taskDayIndex(Yb, dsh, periodStart) === taskDayIndex(Ya, dsh, periodStart),
      'C7.10: non-boundary split — #a/#b same day index (unchanged)',
    );
    assert(
      getNumDays(sched, dsh) === 2,
      'C7.10: getNumDays counts occurrence op-days (X→1, Y/P→2) not the midpoint day',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.11 — computeDefaultLiveAnchor / anchorToPickerDefaults
  //         ("now" → schedule op-day coordinates, with out-of-window clamping)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.11: live-mode default anchor ──');
  {
    // periodStart 2020-01-05 (Sunday), 3 op-days, dayStartHour 5 ⇒ window is
    // [2020-01-05 05:00, 2020-01-08 05:00). Fixed `now` injected each call so
    // the assertions are deterministic regardless of wall-clock.
    const sched = {
      periodStart: new Date(2020, 0, 5),
      periodDays: 3,
      algorithmSettings: { dayStartHour: 5 },
    } as unknown as Schedule;

    // Before the window → day 1 at dayStartHour (nothing frozen).
    const before = computeDefaultLiveAnchor(sched, new Date(2020, 0, 4, 23, 0));
    assert(before.getTime() === new Date(2020, 0, 5, 5, 0).getTime(), 'C7.11: before window → day 1 @ dayStartHour');

    // Inside the window → exact now.
    const inside = computeDefaultLiveAnchor(sched, new Date(2020, 0, 6, 14, 0));
    assert(inside.getTime() === new Date(2020, 0, 6, 14, 0).getTime(), 'C7.11: in window → exact current moment');

    // Exactly at the op-day-1 start → treated as in-window (strict `<` before).
    const atStart = computeDefaultLiveAnchor(sched, new Date(2020, 0, 5, 5, 0));
    assert(atStart.getTime() === new Date(2020, 0, 5, 5, 0).getTime(), 'C7.11: at day-1 boundary → in window (exact)');

    // After the window, normal hour → last day at the real current hour.
    const afterNormal = computeDefaultLiveAnchor(sched, new Date(2020, 0, 10, 14, 0));
    assert(
      timestampToOpDayIndex(afterNormal, sched) === 3 && afterNormal.getHours() === 14,
      'C7.11: after window → last day (3) at real current hour (14)',
    );

    // After the window, tail hour (< dayStartHour) → last day, tail handled.
    const afterTail = computeDefaultLiveAnchor(sched, new Date(2020, 0, 10, 3, 0));
    assert(
      timestampToOpDayIndex(afterTail, sched) === 3 && afterTail.getHours() === 3,
      'C7.11: after window, tail hour → last day (3), tail hour preserved (3)',
    );

    // periodDays === 1: after-window collapses to day 1 at current hour.
    const oneDay = { ...sched, periodDays: 1 } as unknown as Schedule;
    const oneDayAfter = computeDefaultLiveAnchor(oneDay, new Date(2020, 0, 10, 14, 0));
    assert(
      timestampToOpDayIndex(oneDayAfter, oneDay) === 1 && oneDayAfter.getHours() === 14,
      'C7.11: periodDays=1 after window → day 1 at current hour',
    );

    // anchorToPickerDefaults — in-window anchor maps to its op-day + hour.
    const inDefaults = anchorToPickerDefaults(new Date(2020, 0, 6, 10, 0), sched);
    assert(
      inDefaults.defaultDay === '2' && inDefaults.defaultHour === '10',
      'C7.11: anchorToPickerDefaults — day-2 10:00 → {2, 10}',
    );

    // anchorToPickerDefaults — day-N tail anchor clamps to N, keeps real hour.
    const tailDefaults = anchorToPickerDefaults(new Date(2020, 0, 8, 3, 0), sched);
    assert(
      tailDefaults.defaultDay === '3' && tailDefaults.defaultHour === '3',
      'C7.11: anchorToPickerDefaults — op-day-3 tail (03:00) → {3, 3}',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.12 — liveAnchorFromPicker (C1) + exportDaySnapshot base-date (C4)
  //         Caller-level guards: both bugs were callers feeding a correct helper
  //         the wrong inputs — a non-tail-aware offset (C1) / a stale live base
  //         date (C4). The helpers themselves are covered elsewhere.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.12: live picker anchor + day-export base ──');
  {
    // Frozen schedule grid: periodStart 2020-01-05, dayStartHour 5.
    const sched = {
      periodStart: new Date(2020, 0, 5),
      periodDays: 3,
      algorithmSettings: { dayStartHour: 5 },
    } as unknown as Schedule;

    // Daytime hour (>= dayStartHour): calendar offset dayIdx-1 — identical to the
    // pre-fix literal, so non-tail picks are unchanged.
    assert(
      liveAnchorFromPicker(sched, 1, 10).getTime() === new Date(2020, 0, 5, 10, 0).getTime(),
      'C7.12: liveAnchorFromPicker day-1 hour-10 (daytime) → Jan-5 10:00 (== legacy offset)',
    );
    // TAIL hour (< dayStartHour): the bug case — rolls to the op-day's
    // post-midnight tail (Jan-6), NOT one calendar day early (legacy gave Jan-5).
    assert(
      liveAnchorFromPicker(sched, 1, 3).getTime() === new Date(2020, 0, 6, 3, 0).getTime(),
      'C7.12: liveAnchorFromPicker day-1 hour-3 (tail) → Jan-6 03:00 (tail of op-day 1, not Jan-5)',
    );
    // Exactly at dayStartHour → base date (boundary is not a tail); one tick below → tail.
    assert(
      liveAnchorFromPicker(sched, 1, 5).getTime() === new Date(2020, 0, 5, 5, 0).getTime() &&
        liveAnchorFromPicker(sched, 1, 4).getTime() === new Date(2020, 0, 6, 4, 0).getTime(),
      'C7.12: liveAnchorFromPicker boundary hour-5 → Jan-5 05:00; hour-4 → Jan-6 04:00 (tail)',
    );
    // dayStartHour=0 ⇒ no tail exists; every hour stays on the base date (no-op proof).
    const schedZero = { ...sched, algorithmSettings: { dayStartHour: 0 } } as unknown as Schedule;
    assert(
      liveAnchorFromPicker(schedZero, 2, 0).getTime() === new Date(2020, 0, 6, 0, 0).getTime() &&
        liveAnchorFromPicker(schedZero, 2, 23).getTime() === new Date(2020, 0, 6, 23, 0).getTime(),
      'C7.12: liveAnchorFromPicker dayStartHour=0 → no tail; day-2 hours 0 and 23 both on Jan-6',
    );
    // Non-default dayStartHour=22 ⇒ hour 0 is a tail hour.
    const sched22 = { ...sched, algorithmSettings: { dayStartHour: 22 } } as unknown as Schedule;
    assert(
      liveAnchorFromPicker(sched22, 1, 0).getTime() === new Date(2020, 0, 6, 0, 0).getTime(),
      'C7.12: liveAnchorFromPicker dayStartHour=22 day-1 hour-0 (tail) → Jan-6 00:00',
    );

    // exportDaySnapshot (C4): the day window + captured assignments follow the
    // base date passed in. Frozen periodStart selects op-day 1; a stale base
    // (one calendar day later) shifts the window and drops the day-1 assignment.
    const exSched = {
      tasks: [
        {
          id: 't1',
          name: 'T',
          sourceName: 'T',
          timeBlock: { start: new Date(2020, 0, 5, 10, 0), end: new Date(2020, 0, 5, 14, 0) },
          blocksConsecutive: false,
          baseLoadWeight: 1,
        },
      ],
      participants: [{ id: 'p1', name: 'Alice', level: 2, certifications: [], group: 'G1' }],
      assignments: [{ id: 'a1', taskId: 't1', participantId: 'p1' }],
    } as unknown as Schedule;

    const snapFrozen = exportDaySnapshot(exSched, 1, new Date(2020, 0, 5), 5);
    assert(
      snapFrozen.dayWindow.start === new Date(2020, 0, 5, 5, 0).toISOString() &&
        snapFrozen.participants.length === 1 &&
        snapFrozen.participants[0].name === 'Alice',
      'C7.12: exportDaySnapshot frozen periodStart → op-day-1 window captures Alice',
    );
    const snapStale = exportDaySnapshot(exSched, 1, new Date(2020, 0, 6), 5);
    assert(
      snapStale.dayWindow.start === new Date(2020, 0, 6, 5, 0).toISOString() && snapStale.participants.length === 0,
      'C7.12: exportDaySnapshot stale base (+1 day) shifts window and drops the assignment (why frozen base is required)',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.13 — Swimlane membership uses the RAW block (no straddling-split ghost).
  // getParticipantTasksForDay is a per-person clock-time timeline, so a split
  // half belongs to a day only where its real block overlaps — never as a 0h,
  // zero-width "ghost" on the occurrence's other op-day (which intersection by
  // occurrence-span would produce). Non-split cross-day tasks unchanged.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.13: swimlane raw-block membership (no split ghost) ──');
  {
    const periodStart = new Date(2026, 5, 1, 0, 0, 0, 0); // June 1; dayStartHour 5
    const dsh = 5;
    const EIGHT_H = 8 * 3600000;
    // Occurrence X 02:00–10:00 June 2 straddles op-day 1 ([Jun1 05:00, Jun2 05:00)).
    // Split at the 06:00 midpoint: #a [02:00,06:00] (crosses the boundary),
    // #b [06:00,10:00] (entirely op-day 2). #a→P1, #b→P2.
    const xStart = new Date(2026, 5, 2, 2, 0);
    const xEnd = new Date(2026, 5, 2, 10, 0);
    const xMid = new Date(2026, 5, 2, 6, 0);
    const Xa = {
      id: 'X#a',
      name: 'X (1/2)',
      timeBlock: { start: xStart, end: xMid },
      splitGroupId: 'X::s',
      splitPart: 1,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'X',
    } as unknown as Task;
    const Xb = {
      id: 'X#b',
      name: 'X (2/2)',
      timeBlock: { start: xMid, end: xEnd },
      splitGroupId: 'X::s',
      splitPart: 2,
      splitOriginalMs: EIGHT_H,
      splitOccurrenceId: 'X',
    } as unknown as Task;
    // Non-split cross-day task assigned to P1 (regression: must show on both days).
    const C = { id: 'C', name: 'C', timeBlock: { start: xStart, end: xEnd } } as unknown as Task;
    const sched = {
      periodStart,
      periodDays: 2,
      algorithmSettings: { dayStartHour: dsh },
      tasks: [Xa, Xb, C],
      assignments: [
        { id: 'a1', participantId: 'P1', taskId: 'X#a' },
        { id: 'a2', participantId: 'P2', taskId: 'X#b' },
        { id: 'a3', participantId: 'P1', taskId: 'C' },
      ],
    } as unknown as Schedule;
    const ids = (pid: string, day: number) => new Set(getParticipantTasksForDay(sched, pid, day).map((t) => t.id));
    const p2d1 = ids('P2', 1);
    assert(!p2d1.has('X#b'), 'C7.13: #b NOT a member of op-day 1 (raw block is entirely op-day 2 — ghost gone)');
    assert(ids('P2', 2).has('X#b'), 'C7.13: #b IS a member of op-day 2 (where its real block lives)');
    assert(
      ids('P1', 1).has('X#a') && ids('P1', 2).has('X#a'),
      'C7.13: straddling #a appears on BOTH op-days (its real block overlaps each)',
    );
    assert(
      ids('P1', 1).has('C') && ids('P1', 2).has('C'),
      'C7.13: non-split cross-day task still appears on both days (unchanged)',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C7.14 — computePerDayHours is LOAD-WEIGHTED: each task's clipped hours are
  // scaled by its load weight (weight 0 → 0, 0.2 → ⅕, 1 → full). The per-day
  // series decomposes the weekly effective load (sums to effectiveHours). The
  // swimlane chip (totalAssignedHoursForDay) stays RAW — intentionally distinct.
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n── C7.14: load-weighted per-day hours ──');
  {
    const periodStart = new Date(2026, 5, 1, 0, 0, 0, 0);
    const dsh = 5;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    const mk = (id: string, pid: string, startH: number, durH: number, weight: number) => ({
      task: {
        id,
        name: id,
        timeBlock: { start: new Date(2026, 5, 1, startH, 0), end: new Date(2026, 5, 1, startH + durH, 0) },
        baseLoadWeight: weight,
      } as unknown as Task,
      asg: { id: `a-${id}`, participantId: pid, taskId: id },
    });
    const rows = [
      mk('w10', 'PW0', 8, 8, 1), // 8h × 1   = 8
      mk('w05', 'PW1', 8, 8, 0.5), // 8h × 0.5 = 4
      mk('w00', 'PW2', 8, 8, 0), // 8h × 0   = 0 (light task — was a binary skip before)
      mk('w02', 'PW3', 8, 5, 0.2), // 5h × 0.2 = 1
    ];
    const sched = {
      periodStart,
      periodDays: 1,
      algorithmSettings: { dayStartHour: dsh },
      tasks: rows.map((r) => r.task),
      assignments: rows.map((r) => r.asg),
    } as unknown as Schedule;
    assert(near(computePerDayHours('PW0', sched).get(1) || 0, 8), 'C7.14: weight 1.0 × 8h → 8 (full)');
    assert(near(computePerDayHours('PW1', sched).get(1) || 0, 4), 'C7.14: weight 0.5 × 8h → 4 (half)');
    assert(near(computePerDayHours('PW2', sched).get(1) || 0, 0), 'C7.14: weight 0 (light) → 0 (contributes nothing)');
    assert(near(computePerDayHours('PW3', sched).get(1) || 0, 1), 'C7.14: weight 0.2 × 5h → 1 (one-fifth)');
    // Two-lens: the swimlane chip stays RAW occupancy for the same weight-0.5 task.
    assert(
      near(totalAssignedHoursForDay(sched, 'PW1', 1), 8),
      'C7.14: totalAssignedHoursForDay stays raw (8h) — occupancy lens, intentionally ≠ load',
    );

    // Cross-day weighted apportionment sums to the task's effective hours.
    const cd = {
      id: 'cd',
      name: 'cd',
      timeBlock: { start: new Date(2026, 5, 2, 2, 0), end: new Date(2026, 5, 2, 10, 0) },
      baseLoadWeight: 0.5,
    } as unknown as Task;
    const schedCd = {
      periodStart,
      periodDays: 2,
      algorithmSettings: { dayStartHour: dsh },
      tasks: [cd],
      assignments: [{ id: 'acd', participantId: 'PK', taskId: 'cd' }],
    } as unknown as Schedule;
    const m = computePerDayHours('PK', schedCd);
    assert(
      near(m.get(1) || 0, 1.5) && near(m.get(2) || 0, 2.5) && near((m.get(1) || 0) + (m.get(2) || 0), 4),
      'C7.14: cross-day weight 0.5 (02:00–10:00) → day1 1.5h + day2 2.5h = 4h (= effectiveHours)',
    );
  }

  console.log('\n── test-web-utils complete ──────────────');
}

// ─── Standalone self-exec ────────────────────────────────────────────────────
if (require.main === module) {
  let passed = 0;
  let failed = 0;
  const assert: AssertFn = (cond, name) => {
    if (cond) {
      passed++;
      console.log(`  ✓ ${name}`);
    } else {
      failed++;
      console.log(`  ✗ FAIL: ${name}`);
    }
  };
  runWebUtilsTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
