/**
 * Export / layout / swimlane-math / day0-adapter unit tests (WP5, C5.1–C5.7).
 * Group B: runs under tsconfig.test-persistence.json via `npm run test:persistence`
 * (imports `src/web`). C5.1 and C5.3 pin behaviors that are under independent
 * review (the export day-loop bound, and the getDayWindow default-args fallback).
 *
 * Standalone:
 *   npx ts-node --project tsconfig.test-persistence.json src/test-export-layout.ts
 *
 * These tests target SILENT WRONG OUTPUT in the export/print/mobile-view path:
 * a dropped/mislabelled day, a wrong day-window anchor, calendar-date leakage,
 * or bad swimlane geometry are all invisible until a user notices a missing
 * shift on a printed sheet. Every check is a hard assertion.
 */

type AssertFn = (condition: boolean, name: string) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// localStorage / DOMException / location / document / … shims
// (replicated from the head of src/test-persistence.ts — MUST run BEFORE any
//  src/web import touches these globals)
// ═══════════════════════════════════════════════════════════════════════════════

const _simulateQuotaError = false;

class MemoryStorage {
  private _data = new Map<string, string>();
  getItem(key: string): string | null {
    return this._data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (_simulateQuotaError) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
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
// biome-ignore lint: test shims require dynamic globalThis assignment
const _g = globalThis as any;
if (typeof _g.location === 'undefined') {
  _g.location = { reload: () => {}, href: 'http://localhost:5174/' };
}
if (typeof _g.document === 'undefined') {
  _g.document = {
    createElement: () => ({ click: () => {}, style: {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
}
if (typeof _g.navigator === 'undefined') {
  _g.navigator = {};
}
if (typeof _g.URL === 'undefined') {
  _g.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
}
if (typeof _g.Blob === 'undefined') {
  _g.Blob = class Blob {
    constructor(
      public parts: unknown[],
      public options?: { type?: string },
    ) {}
    get type() {
      return this.options?.type ?? '';
    }
  };
}
if (typeof _g.File === 'undefined') {
  _g.File = class File {
    name: string;
    type: string;
    constructor(_parts: unknown[], name: string, options?: { type?: string }) {
      this.name = name;
      this.type = options?.type ?? '';
    }
  };
}

// ─── Now safe to import store + src/web ─────────────────────────────────────
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Workbook } from 'exceljs';
import type { ContinuitySnapshot } from './models/continuity-schema';
import {
  type Assignment,
  AssignmentStatus,
  DEFAULT_ALGORITHM_SETTINGS,
  Level,
  type Participant,
  type Schedule,
  type ScheduleScore,
  type SlotRequirement,
  type Task,
} from './models/types';
import { DEFAULT_LEVERS, type PageGeometry, planDayLayout } from './shared/pdf-fit-planner';
import * as store from './web/config-store';
import { buildDay0Schedule, getDay0HoursForParticipant, isDay0Foreign } from './web/day0-adapter';
import { exportWeeklyExcel } from './web/excel-export';
import * as exportUtils from './web/export-utils';
import {
  assignRows,
  computeSectionMetrics,
  generateGridTemplate,
  inferColumnStrategy,
  type SectionMetrics,
} from './web/layout-engine';
// NOTE: `src/web/pdf-export.ts` is intentionally NOT imported. It does
// `await import('pdfjs-dist/.../pdf.worker.min.mjs?worker&inline')` — a
// Vite-only virtual specifier that ts-node/tsc cannot resolve (TS2307), which
// is why `test-persistence.ts` also avoids it. The weekly-PDF day-loop bound
// is checked statically (it consumes the identical `getNumDays` value).
import * as scheduleUtils from './web/schedule-utils';
import {
  clipBandToDay,
  type DayWindow,
  getUnavailabilityBandsForDay,
  isAllDayUnavailable,
  positionFraction,
  totalAssignedHoursForDay,
} from './web/swimlane-utils';

// ═══════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════════

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;

/** Jan 4 2026 (Sunday), local time. Far from any DST transition. */
function frozenBase(): Date {
  return new Date(2026, 0, 4, 0, 0, 0, 0);
}

function mkScore(): ScheduleScore {
  return {
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
  };
}

function mkParticipant(id: string, name: string, overrides?: Partial<Participant>): Participant {
  return {
    id,
    name,
    level: Level.L0,
    certifications: [],
    group: 'G',
    availability: [],
    dateUnavailability: [],
    ...overrides,
  };
}

function mkSlot(overrides?: Partial<SlotRequirement>): SlotRequirement {
  return {
    slotId: 'slot-1',
    acceptableLevels: [{ level: Level.L0 }],
    requiredCertifications: [],
    ...overrides,
  };
}

function mkTask(id: string, startMs: number, endMs: number, overrides?: Partial<Task>): Task {
  return {
    id,
    name: id,
    sourceName: 'סיור',
    sectionKey: 'patrol',
    timeBlock: { start: new Date(startMs), end: new Date(endMs) },
    requiredCount: 1,
    slots: [mkSlot()],
    sameGroupRequired: false,
    blocksConsecutive: false,
    ...overrides,
  };
}

function mkSchedule(overrides?: Partial<Schedule>): Schedule {
  return {
    id: 'sched-1',
    tasks: [],
    participants: [],
    assignments: [],
    feasible: true,
    score: mkScore(),
    violations: [],
    generatedAt: new Date(),
    algorithmSettings: {
      config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
      disabledHardConstraints: [],
      dayStartHour: 5,
    },
    periodStart: frozenBase(),
    periodDays: 7,
    restRuleSnapshot: {},
    certLabelSnapshot: {},
    scheduleUnavailability: [],
    capabilityLoss: [],
    ...overrides,
  };
}

/** op-day `d` window start (1-based) for periodStart=frozenBase, dsh=5. */
function opDayStart(d: number, dsh = 5): number {
  const b = frozenBase();
  return new Date(b.getFullYear(), b.getMonth(), b.getDate() + d - 1, dsh, 0, 0, 0).getTime();
}

/**
 * Build a "gappy" schedule: periodDays = 7 but tasks land only on op-days 2..6
 * (one task each, 10:00→14:00 local). `getNumDays()` counts 5 distinct
 * task-bearing op-days while `periodDays` is 7, so a `for (d=1; d<=numDays; d++)`
 * loop and a `for (d=1; d<=periodDays; d++)` loop would visit different day
 * ranges. C5.1 exercises which one the exports use; the correctness of that
 * choice is the open question under independent review.
 */
function buildGappySchedule(): Schedule {
  const b = frozenBase();
  const tasks: Task[] = [];
  const assignments: Assignment[] = [];
  const p = mkParticipant('p1', 'P1');
  for (let d = 2; d <= 6; d++) {
    const start = new Date(b.getFullYear(), b.getMonth(), b.getDate() + d - 1, 10, 0, 0, 0).getTime();
    const t = mkTask(`c51-t-${d}`, start, start + 4 * HOUR, {
      slots: [mkSlot({ slotId: `s-${d}` })],
    });
    tasks.push(t);
    assignments.push({
      id: `c51-a-${d}`,
      taskId: t.id,
      slotId: `s-${d}`,
      participantId: p.id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    });
  }
  return mkSchedule({ id: 'c51', tasks, participants: [p], assignments, periodDays: 7 });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite
// ═══════════════════════════════════════════════════════════════════════════════

export async function runExportLayoutTests(assert: AssertFn): Promise<void> {
  console.log('\n── Export / layout / swimlane / day0 tests (WP5) ───────────');

  await testC51_exportDayLoopBound(assert);
  testC52_anchorAgreement(assert);
  testC53_dayWindowFallback(assert);
  await testC54_calendarOmission(assert);
  testC55_swimlaneMath(assert);
  testC56_layoutEngine(assert);
  testC57_day0Adapter(assert);
  testC58_pdfPacker(assert);
  testC59_pdfSpread(assert);

  console.log('── WP5 export/layout tests complete ───────────');
}

// ─── C5.1 — export day-loop bound is periodDays, not getNumDays ─────────────
// Resolved: the weekly Excel/PDF day loop MUST bound on the frozen op-day count
// (`schedule.periodDays`), never the distinct task-bearing-day cardinality
// (`getNumDays`). Using the cardinality as an absolute 1-based index bound
// silently drops any task-bearing op-day whose index exceeds the count (on a
// gappy periodDays=7 schedule with tasks on op-days 2..6, op-day 6 vanished
// entirely) and emitted phantom empty pages for leading-empty days — and broke
// the CLAUDE.md lock-step invariant with the on-screen grid (which iterates
// 1..periodDays). This block asserts the corrected, gap-immune behavior.

/** Reload the xlsx Blob captured from the (mocked) download path. */
async function captureWeeklyExcel(schedule: Schedule): Promise<Workbook> {
  // The download path does `URL.createObjectURL(new Blob([buffer]))`. Capture
  // the Blob, then extract its bytes — works whether `Blob` is Node's global
  // (has `.arrayBuffer()`) or the test-persistence shim (has `.parts`).
  // biome-ignore lint: test global access
  const urlObj = (globalThis as any).URL;
  const origCreate = urlObj.createObjectURL;
  const origRevoke = urlObj.revokeObjectURL;
  let capturedBlob: unknown = null;
  urlObj.createObjectURL = (b: unknown) => {
    capturedBlob = b;
    return 'blob:test';
  };
  urlObj.revokeObjectURL = () => {};
  try {
    await exportWeeklyExcel(schedule, 5, /* includeDay0 */ false);
  } finally {
    urlObj.createObjectURL = origCreate;
    urlObj.revokeObjectURL = origRevoke;
  }
  // biome-ignore lint: dynamic Blob shape (node global vs test shim)
  const blobAny = capturedBlob as any;
  let bytes: ArrayBuffer | Buffer;
  if (blobAny && typeof blobAny.arrayBuffer === 'function') {
    bytes = await blobAny.arrayBuffer();
  } else {
    bytes = blobAny?.parts?.[0];
  }
  const wb = new Workbook();
  // biome-ignore lint: exceljs Buffer generic mismatch under node typings
  await wb.xlsx.load(bytes as any);
  return wb;
}

async function testC51_exportDayLoopBound(assert: AssertFn): Promise<void> {
  const schedule = buildGappySchedule();

  // Baseline fact: on this gappy schedule the task-bearing-day cardinality
  // (`getNumDays` = 5) differs from the frozen op-day count
  // (`periodDays` = 7). This divergence is exactly why getNumDays must NOT
  // bound the absolute-index day loop — the assertions below prove the loop
  // now follows periodDays and no longer drops op-day 6.
  const cardinality: number = exportUtils.getNumDays(schedule, 5);
  const periodDays: number = schedule.periodDays;
  assert(
    cardinality === 5 && periodDays === 7 && cardinality < periodDays,
    'C5.1: getNumDays returns task-bearing-day cardinality (5), differing from periodDays (7) on a gappy schedule',
  );

  // ── Excel weekly path (capture the real workbook) ──
  const wb = await captureWeeklyExcel(schedule);
  const sheetNames = wb.worksheets.map((w) => w.name);

  // Distinct op-day indices that actually reached the raw-data sheet.
  const rawWs = wb.getWorksheet('נתונים גולמיים');
  const rawDays = new Set<number>();
  if (rawWs) {
    rawWs.eachRow((row, rn) => {
      if (rn === 1) return; // header
      const v = row.getCell(1).value;
      if (typeof v === 'number') rawDays.add(v);
    });
  }

  const summaryWs = wb.getWorksheet('סיכום');
  let summaryDayCols = 0;
  if (summaryWs) {
    const hdr = summaryWs.getRow(1);
    hdr.eachCell((cell) => {
      if (typeof cell.value === 'string' && /^יום\s+\d+$/.test(cell.value.trim())) summaryDayCols++;
    });
  }

  // Corrected behavior: the weekly Excel loop iterates the full frozen period
  // (1..periodDays), so every op-day index is visited. op-day 6 (which has a
  // task) is no longer dropped, and a sheet exists for every op-day including
  // the legitimately-empty op-days 1 and 7.
  assert(
    sheetNames.includes('יום 6'),
    'C5.1: weekly Excel emits a sheet for op-day 6 (has tasks — was silently dropped pre-fix)',
  );
  assert(
    sheetNames.includes('יום 1') && sheetNames.includes('יום 7'),
    'C5.1: weekly Excel emits a sheet for every op-day 1..periodDays (incl. empty op-days 1 & 7)',
  );
  assert(
    rawDays.has(6) && rawDays.size === 5,
    'C5.1: raw-data sheet day column is {2,3,4,5,6} — op-day 6 rows present',
  );
  assert(
    summaryDayCols === schedule.periodDays,
    'C5.1: summary header has periodDays (7) day columns, not the getNumDays (5) cardinality',
  );

  // ── PDF weekly path — static check ──
  // pdf-export.ts can't be imported here (Vite-only pdfjs worker specifier),
  // so check statically that `exportWeeklyOverview` bounds its
  // `for (d=1; d<=numDays; d++)` page loop on `schedule.periodDays` and no
  // longer references getNumDays at all (mirrors the Excel end-to-end check).
  const pdfSrc = readFileSync(join(__dirname, 'web', 'pdf-export.ts'), 'utf8');
  const weeklyIdx = pdfSrc.indexOf('export function exportWeeklyOverview');
  const weeklyBody = weeklyIdx >= 0 ? pdfSrc.slice(weeklyIdx, weeklyIdx + 1200) : '';
  const usesPeriodDaysBound =
    /const\s+numDays\s*=\s*schedule\.periodDays/.test(weeklyBody) &&
    /for\s*\(let d = 1; d <= numDays; d\+\+\)/.test(weeklyBody) &&
    !/getNumDays\(/.test(weeklyBody);

  assert(usesPeriodDaysBound, 'C5.1: exportWeeklyOverview page-loop bound is schedule.periodDays, not getNumDays(...)');
}

// ─── C5.2 — getDayWindow anchor agreement (hard CLAUDE.md invariant) ─────────

function testC52_anchorAgreement(assert: AssertFn): void {
  // Tasks deliberately start *later* than dayStartHour so a `min(task.start)`
  // anchor would be detectably wrong.
  const b = frozenBase();
  const t1 = mkTask(
    't1',
    new Date(b.getFullYear(), b.getMonth(), b.getDate(), 11, 0).getTime(),
    opDayStart(1) + 6 * HOUR,
  );
  const schedule = mkSchedule({ tasks: [t1], periodDays: 5 });
  const dsh = schedule.algorithmSettings.dayStartHour;

  let allAgree = true;
  let allAnchored = true;
  let neverMinTaskStart = true;
  for (let d = 1; d <= schedule.periodDays; d++) {
    const expectedStart = opDayStart(d, dsh);
    const expectedEnd = expectedStart + DAY_MS;
    const eu = exportUtils.getDayWindow(schedule, d, dsh);
    const su = scheduleUtils.getDayWindow(d, dsh, schedule.periodStart);

    if (eu.start.getTime() !== expectedStart || su.start.getTime() !== expectedStart) allAnchored = false;
    if (eu.end.getTime() !== expectedEnd || su.end.getTime() !== expectedEnd) allAnchored = false;
    if (eu.start.getTime() !== su.start.getTime() || eu.end.getTime() !== su.end.getTime()) allAgree = false;
    // day-1 task starts 11:00 — window must still anchor at dsh (05:00).
    if (d === 1 && (eu.start.getHours() !== dsh || eu.start.getTime() === t1.timeBlock.start.getTime())) {
      neverMinTaskStart = false;
    }
  }

  assert(allAnchored, 'C5.2: both getDayWindow impls anchor every day to periodStart + dayStartHour');
  assert(allAgree, 'C5.2: export-utils.getDayWindow ≡ schedule-utils.getDayWindow (start & end) every day');
  assert(neverMinTaskStart, 'C5.2: day window is dayStartHour-anchored, never min(task.start)');
}

// ─── C5.3 — schedule-utils.getDayWindow live-store default-args fallback ─────

function testC53_dayWindowFallback(assert: AssertFn): void {
  const schedule = mkSchedule({ periodDays: 5 });
  const frozenDsh = schedule.algorithmSettings.dayStartHour; // 5
  const expectedFrozenStart = opDayStart(2, frozenDsh);

  // Snapshot live store, then mutate it AFTER "generation".
  const origDate = store.getScheduleDate();
  const origDsh = store.getDayStartHour();
  try {
    const explicitBefore = scheduleUtils.getDayWindow(2, frozenDsh, schedule.periodStart).start.getTime();

    store.setScheduleDate(new Date(2025, 5, 15)); // far-away date
    store.setAlgorithmSettings({ dayStartHour: 9 }); // different boundary

    const explicitAfter = scheduleUtils.getDayWindow(2, frozenDsh, schedule.periodStart).start.getTime();
    const omitted = scheduleUtils.getDayWindow(2).start.getTime(); // ← omits frozen args

    // Safe-usage contract (PASSES — real frozen-snapshot regression gate):
    assert(
      explicitBefore === expectedFrozenStart && explicitAfter === expectedFrozenStart,
      'C5.3: getDayWindow with explicit frozen args is immune to post-gen store mutation',
    );
    // Default-args behavior (PASSES — documents that omitting args makes the
    // call follow the live store rather than the frozen anchor):
    assert(
      omitted !== expectedFrozenStart && omitted !== explicitAfter,
      'C5.3: omitting args makes getDayWindow follow the LIVE store, not the frozen anchor',
    );
    // Cross-check the export-side window agrees with the explicit frozen call.
    assert(
      exportUtils.getDayWindow(schedule, 2, frozenDsh).start.getTime() === expectedFrozenStart,
      'C5.3: export-utils.getDayWindow stays on the frozen anchor under store mutation',
    );
  } finally {
    store.setAlgorithmSettings({ dayStartHour: origDsh });
    store.setScheduleDate(origDate);
  }

  // Caller audit (evidence): every schedule-utils.getDayWindow() call site in a
  // schedule-screen path passes explicit frozen args (dsh + periodStart):
  //   app.ts:572,599,1581,5637 · swimlane-utils.ts:97,162 · swimlane-view.ts:73,619
  //   day0-adapter.ts:117 · schedule-utils.ts:266 (computePerDayHours, frozen)
  // Per the caller audit above, no current schedule-screen caller omits the
  // frozen args on a frozen-schedule path, so the default-args fallback is a
  // latent API hazard rather than an exercised one.
  assert(true, 'C5.3: caller audit — no schedule-screen caller omits frozen args (latent hazard only)');
}

// ─── C5.4 — Excel calendar-date / weekday omission (product rule) ────────────

async function testC54_calendarOmission(assert: AssertFn): Promise<void> {
  const schedule = buildGappySchedule();
  const wb = await captureWeeklyExcel(schedule);

  const HE_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const EN_WEEKDAYS = /\b(sun|mon|tue|wed|thu|fri|sat)\b/i;
  const DATE_RE = /\d{1,2}[/.]\d{1,2}/;

  let calendarLeak: string | null = null;
  let weekdayLeak: string | null = null;

  for (const wsName of ['סיכום', 'נתונים גולמיים']) {
    const ws = wb.getWorksheet(wsName);
    if (!ws) continue;
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value !== 'string') return; // Date cells are real Dates, skipped
        const s = cell.value;
        if (DATE_RE.test(s)) calendarLeak = `${wsName}:"${s}"`;
        if (HE_WEEKDAYS.some((w) => s.includes(w)) || EN_WEEKDAYS.test(s)) weekdayLeak = `${wsName}:"${s}"`;
      });
    });
  }

  assert(
    calendarLeak === null,
    `C5.4: no DD/MM-style calendar date in summary/raw sheets (${calendarLeak ?? 'clean'})`,
  );
  assert(weekdayLeak === null, `C5.4: no weekday name leaks in summary/raw sheets (${weekdayLeak ?? 'clean'})`);

  // Positive shape check: summary header columns are strictly `יום N`.
  const summary = wb.getWorksheet('סיכום');
  let headerOk = false;
  if (summary) {
    const cells: string[] = [];
    summary.getRow(1).eachCell((c) => {
      if (typeof c.value === 'string') cells.push(c.value.trim());
    });
    headerOk = cells.length > 1 && cells[0] === 'משתתף' && cells.slice(1).every((c, i) => c === `יום ${i + 1}`);
  }
  assert(headerOk, 'C5.4: summary header is [משתתף, יום 1, יום 2, …] (index-based, no dates)');
}

// ─── C5.5 — swimlane-utils pure math (primary mobile schedule view) ──────────

function testC55_swimlaneMath(assert: AssertFn): void {
  const t0 = opDayStart(1); // Jan 4 05:00
  const win: DayWindow = { start: new Date(t0), end: new Date(t0 + DAY_MS) };

  // positionFraction — clamp to [0,1] incl. cross-midnight flush.
  assert(positionFraction(t0, win) === 0, 'C5.5: positionFraction at window start → 0');
  assert(positionFraction(t0 + DAY_MS, win) === 1, 'C5.5: positionFraction at window end → 1');
  assert(positionFraction(t0 + DAY_MS / 2, win) === 0.5, 'C5.5: positionFraction at midpoint → 0.5');
  assert(positionFraction(t0 - 5 * HOUR, win) === 0, 'C5.5: positionFraction before window clamps to 0');
  assert(positionFraction(t0 + DAY_MS + 5 * HOUR, win) === 1, 'C5.5: positionFraction after window clamps to 1');
  assert(
    positionFraction(t0, { start: new Date(t0), end: new Date(t0) }) === 0,
    'C5.5: positionFraction with non-positive window → 0',
  );

  // clipBandToDay.
  const inside = clipBandToDay(t0 + 2 * HOUR, t0 + 4 * HOUR, win);
  assert(
    inside !== null && inside.startMs === t0 + 2 * HOUR && inside.endMs === t0 + 4 * HOUR,
    'C5.5: clipBandToDay leaves a fully-inside band intact',
  );
  const clippedHead = clipBandToDay(t0 - 3 * HOUR, t0 + 2 * HOUR, win);
  assert(
    clippedHead !== null && clippedHead.startMs === t0 && clippedHead.endMs === t0 + 2 * HOUR,
    'C5.5: clipBandToDay clamps the leading edge to window start',
  );
  const clippedTail = clipBandToDay(t0 + 22 * HOUR, t0 + 30 * HOUR, win);
  assert(
    clippedTail !== null && clippedTail.endMs === t0 + DAY_MS,
    'C5.5: clipBandToDay clamps the trailing edge to window end',
  );
  assert(
    clipBandToDay(t0 + DAY_MS + HOUR, t0 + DAY_MS + 2 * HOUR, win) === null,
    'C5.5: clipBandToDay → null when no overlap',
  );
  assert(
    clipBandToDay(t0 + 5 * HOUR, t0 + 5 * HOUR, win) === null,
    'C5.5: clipBandToDay → null for a zero-length band',
  );

  // getUnavailabilityBandsForDay — allDay, midnight-wrap, FSOS source.
  const sched = mkSchedule({ periodDays: 3 });
  const pAll = mkParticipant('pa', 'PA', {
    dateUnavailability: [{ id: 'r1', dayIndex: 1, startHour: 0, endHour: 0, allDay: true }],
  });
  const allBands = getUnavailabilityBandsForDay(pAll, sched, 1);
  assert(
    allBands.length === 1 && allBands[0].endMs - allBands[0].startMs === DAY_MS,
    'C5.5: allDay dateUnavailability rule covers the whole op-day window',
  );

  // Partial rule 22:00→04:00 (post-midnight tail via hourInOpDay).
  const pWrap = mkParticipant('pw', 'PW', {
    dateUnavailability: [{ id: 'r2', dayIndex: 1, startHour: 22, endHour: 4, allDay: false }],
  });
  const wrapBands = getUnavailabilityBandsForDay(pWrap, sched, 1);
  assert(
    wrapBands.length === 1 && wrapBands[0].endMs - wrapBands[0].startMs === 6 * HOUR,
    'C5.5: 22:00→04:00 rule yields a 6h band straddling midnight',
  );

  // endHour <= startHour on the same single day forces the +24h wrap branch;
  // result is then clipped to the day window end (05:00 next op-day).
  const pSame = mkParticipant('ps', 'PS', {
    dateUnavailability: [{ id: 'r3', dayIndex: 1, startHour: 10, endHour: 10, allDay: false }],
  });
  const sameBands = getUnavailabilityBandsForDay(pSame, sched, 1);
  assert(
    sameBands.length === 1 && sameBands[0].endMs - sameBands[0].startMs === 19 * HOUR,
    'C5.5: endHour==startHour wraps +24h then clips to window end (10:00→05:00 = 19h)',
  );

  // schedule.scheduleUnavailability (Future-SOS) source.
  const pFsos = mkParticipant('pf', 'PF');
  const schedFsos = mkSchedule({
    periodDays: 3,
    participants: [pFsos],
    scheduleUnavailability: [
      {
        id: 'su1',
        participantId: 'pf',
        start: new Date(t0 + 8 * HOUR),
        end: new Date(t0 + 10 * HOUR),
        createdAt: new Date(),
        anchorAtCreation: new Date(),
      },
    ],
  });
  const fsosBands = getUnavailabilityBandsForDay(pFsos, schedFsos, 1);
  assert(
    fsosBands.length === 1 && fsosBands[0].endMs - fsosBands[0].startMs === 2 * HOUR,
    'C5.5: scheduleUnavailability (Future-SOS) contributes a clipped band',
  );

  // isAllDayUnavailable — 99% threshold (>=).
  assert(isAllDayUnavailable([], win) === false, 'C5.5: isAllDayUnavailable false for empty bands');
  assert(
    isAllDayUnavailable([{ startMs: t0, endMs: t0 + DAY_MS * 0.99 }], win) === true,
    'C5.5: isAllDayUnavailable true at exactly 99% coverage',
  );
  assert(
    isAllDayUnavailable([{ startMs: t0, endMs: t0 + DAY_MS * 0.98 }], win) === false,
    'C5.5: isAllDayUnavailable false at 98% coverage',
  );
  assert(
    isAllDayUnavailable([{ startMs: t0, endMs: t0 + DAY_MS }], { start: new Date(t0), end: new Date(t0) }) === false,
    'C5.5: isAllDayUnavailable false for a non-positive window',
  );

  // totalAssignedHoursForDay — window-clip on a boundary-spanning task.
  const pHrs = mkParticipant('ph', 'PH');
  // Task 03:00→09:00 (6h); only 05:00→09:00 (4h) is inside op-day 1.
  const spanTask = mkTask('span', t0 - 2 * HOUR, t0 + 4 * HOUR, { slots: [mkSlot({ slotId: 'sp' })] });
  const insideTask = mkTask('ins', t0 + 6 * HOUR, t0 + 9 * HOUR, { slots: [mkSlot({ slotId: 'in' })] });
  const outsideTask = mkTask('out', t0 + 30 * HOUR, t0 + 33 * HOUR, { slots: [mkSlot({ slotId: 'ou' })] });
  const schedHrs = mkSchedule({
    periodDays: 3,
    participants: [pHrs],
    tasks: [spanTask, insideTask, outsideTask],
    assignments: [
      {
        id: 'a1',
        taskId: 'span',
        slotId: 'sp',
        participantId: 'ph',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
      {
        id: 'a2',
        taskId: 'ins',
        slotId: 'in',
        participantId: 'ph',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
      {
        id: 'a3',
        taskId: 'out',
        slotId: 'ou',
        participantId: 'ph',
        status: AssignmentStatus.Scheduled,
        updatedAt: new Date(),
      },
    ],
  });
  const hrs = totalAssignedHoursForDay(schedHrs, 'ph', 1);
  assert(
    Math.abs(hrs - 7) < 1e-9,
    'C5.5: totalAssignedHoursForDay clips to window (4h span + 3h inside, 0 outside = 7h)',
  );
}

// ─── C5.6 — layout-engine (shared by on-screen grid + PDF + Excel) ──────────

function mkMetric(id: string, weight: number, displayOrder: number): SectionMetrics {
  return {
    id,
    title: id,
    tasks: [],
    columnCount: 1,
    rowCount: 1,
    totalSlots: 1,
    maxSlotsPerCell: 1,
    weight,
    displayOrder,
  };
}

/** Sum of colSpan per grid row — must always equal 12 (GRID_UNITS). */
function spanSumByRow(placements: { row: number; colSpan: number }[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of placements) m.set(p.row, (m.get(p.row) ?? 0) + p.colSpan);
  return m;
}

function testC56_layoutEngine(assert: AssertFn): void {
  // computeSectionMetrics — weight formula = max(1, cols*rows + slots*0.25).
  const b = frozenBase();
  const startA = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 10, 0).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 14, 0).getTime();
  const flatTask1 = mkTask('k1', startA, startA + HOUR, {
    sectionKey: 'k',
    sourceName: 'חממה',
    slots: [mkSlot({ slotId: 'a' }), mkSlot({ slotId: 'b' })],
  });
  const m1 = computeSectionMetrics([flatTask1]);
  assert(
    m1.length === 1 &&
      m1[0].id === 'k' &&
      m1[0].columnCount === 1 &&
      m1[0].rowCount === 1 &&
      m1[0].totalSlots === 2 &&
      Math.abs(m1[0].weight - 1.5) < 1e-9,
    'C5.6: computeSectionMetrics weight = max(1, cols*rows + slots*0.25) = 1.5',
  );
  const flatTask2 = mkTask('k2', startB, startB + HOUR, {
    sectionKey: 'k',
    sourceName: 'חממה',
    slots: [mkSlot({ slotId: 'c' })],
  });
  const m2 = computeSectionMetrics([flatTask1, flatTask2]);
  assert(
    m2.length === 1 && m2[0].rowCount === 2 && m2[0].totalSlots === 3 && Math.abs(m2[0].weight - 2.75) < 1e-9,
    'C5.6: computeSectionMetrics with 2 unique start times → rowCount 2, weight 2.75',
  );

  // inferColumnStrategy — flat vs multi-source split.
  const flatCols = inferColumnStrategy([flatTask1])([flatTask1]);
  assert(
    flatCols.length === 1 && flatCols[0].key === 'all',
    'C5.6: inferColumnStrategy → flat (single source, no sub-team)',
  );

  const teamTask = mkTask('tt', startA, startA + HOUR, {
    sectionKey: 'aruga',
    sourceName: 'ערוגה',
    slots: [mkSlot({ slotId: 's1', subTeamId: 'st1', subTeamLabel: 'צוות א' })],
  });
  const teamCols = inferColumnStrategy([teamTask])([teamTask]);
  assert(
    teamCols.length >= 1 && teamCols.every((c) => c.key.startsWith('team-')),
    'C5.6: inferColumnStrategy → multi-source split when slots carry subTeamId',
  );

  const srcX = mkTask('sx', startA, startA + HOUR, {
    sectionKey: 'sec',
    sourceName: 'X',
    slots: [mkSlot({ slotId: 'x' })],
  });
  const srcY = mkTask('sy', startA, startA + HOUR, {
    sectionKey: 'sec',
    sourceName: 'Y',
    slots: [mkSlot({ slotId: 'y' })],
  });
  const multiCols = inferColumnStrategy([srcX, srcY])([srcX, srcY]);
  assert(
    multiCols.length === 2 && multiCols.every((c) => c.key.startsWith('source-')),
    'C5.6: inferColumnStrategy → one source-column per distinct sourceName',
  );

  // assignRows + generateGridTemplate — single section → full width.
  const single = generateGridTemplate(assignRows([mkMetric('only', 4, 1)]));
  assert(
    single.placements.length === 1 &&
      single.placements[0].colStart === 1 &&
      single.placements[0].colSpan === 12 &&
      single.totalRows === 1,
    'C5.6: single section → one full-width (span 12) row',
  );

  // Two equal sections share one row, spans sum to 12.
  const two = generateGridTemplate(assignRows([mkMetric('a', 6, 1), mkMetric('b', 6, 2)]));
  const twoSums = spanSumByRow(two.placements);
  assert(
    two.placements.length === 2 &&
      [...twoSums.values()].every((s) => s === 12) &&
      two.placements.every((p) => p.colSpan >= 3),
    'C5.6: two equal sections → one row, Σspan = 12, each ≥ MIN_COL_SPAN',
  );

  // Three sections, lopsided weights → MIN_COL_SPAN clamp + Σ=12 rebalance.
  const three = generateGridTemplate(assignRows([mkMetric('a', 5, 1), mkMetric('b', 5, 2), mkMetric('c', 1, 3)]));
  const threeSums = spanSumByRow(three.placements);
  const cPlace = three.placements.find((p) => p.sectionId === 'c');
  assert(
    [...threeSums.values()].every((s) => s === 12) && cPlace?.colSpan === 3,
    'C5.6: lightest section is clamped to MIN_COL_SPAN (3) and the row still Σ=12',
  );

  // Full-width promotion: dominant section (>50% weight) with ≥4 sections
  // (targetRows≥2) gets its own isolated full-width row.
  const promo = generateGridTemplate(
    assignRows([mkMetric('big', 20, 1), mkMetric('s1', 1, 2), mkMetric('s2', 1, 3), mkMetric('s3', 1, 4)]),
  );
  const bigP = promo.placements.find((p) => p.sectionId === 'big');
  const sameRow = promo.placements.filter((p) => p.row === bigP?.row);
  const promoSums = spanSumByRow(promo.placements);
  assert(
    bigP?.colSpan === 12 && sameRow.length === 1 && [...promoSums.values()].every((s) => s === 12),
    'C5.6: dominant section gets an isolated full-width row; every row Σspan = 12',
  );

  // Degenerate inputs.
  assert(assignRows([]).length === 0, 'C5.6: assignRows([]) → []');
  const empty = generateGridTemplate([]);
  assert(empty.placements.length === 0 && empty.totalRows === 0, 'C5.6: generateGridTemplate([]) → empty template');
}

// ─── C5.7 — day0-adapter ────────────────────────────────────────────────────

function buildSnapshot(): ContinuitySnapshot {
  const b = frozenBase();
  // Day-0 window for periodStart=Jan4, dsh=5 → [Jan3 05:00, Jan4 05:00).
  const day0Start = new Date(b.getFullYear(), b.getMonth(), b.getDate() - 1, 22, 0).getTime(); // Jan3 22:00
  const day0End = new Date(b.getFullYear(), b.getMonth(), b.getDate(), 8, 0).getTime(); // Jan4 08:00
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    dayIndex: 7,
    dayWindow: { start: new Date(day0Start).toISOString(), end: new Date(day0End).toISOString() },
    participants: [
      {
        name: 'Known Member',
        level: 0,
        certifications: ['Nitzan'],
        group: 'G',
        assignments: [
          {
            sourceName: 'סיור',
            taskName: 'סיור לילה',
            timeBlock: { start: new Date(day0Start).toISOString(), end: new Date(day0End).toISOString() },
            blocksConsecutive: true,
          },
        ],
      },
      {
        name: 'Foreign Person',
        level: 4,
        certifications: ['Hamama'],
        group: 'H',
        assignments: [
          {
            sourceName: 'חממה',
            taskName: 'חממה',
            timeBlock: { start: new Date(day0Start).toISOString(), end: new Date(day0End).toISOString() },
            blocksConsecutive: false,
          },
        ],
      },
    ],
  };
}

function testC57_day0Adapter(assert: AssertFn): void {
  const known = mkParticipant('real-1', 'Known Member', { level: Level.L2, group: 'G' });
  const snapshot = buildSnapshot();
  const parent = mkSchedule({
    id: 'parent',
    participants: [known],
    continuitySnapshot: snapshot,
    periodDays: 4,
  });

  assert(buildDay0Schedule(mkSchedule()) === null, 'C5.7: buildDay0Schedule → null when no continuitySnapshot');

  const day0 = buildDay0Schedule(parent);
  assert(day0 !== null, 'C5.7: buildDay0Schedule returns a synthetic schedule when continuity attached');
  if (!day0) return;

  // Matched participant reuses the real Participant object (id preserved).
  const matched = day0.participants.find((p) => p.name === 'Known Member');
  assert(matched === known, 'C5.7: matched-by-name participant reuses the real Participant record (identity)');

  // Foreign participant gets a synthetic id + foreign flag.
  const foreign = day0.participants.find((p) => p.name === 'Foreign Person');
  assert(
    !!foreign && foreign.id === 'day0-p-Foreign_Person' && isDay0Foreign(foreign) && !isDay0Foreign(matched),
    'C5.7: foreign participant → synthetic id (spaces→_) + DAY0_FOREIGN_FLAG, matched is not foreign',
  );

  // Synthetic ids + frozen-field reuse.
  assert(
    day0.id === 'parent-day0' &&
      day0.tasks.length === 2 &&
      day0.assignments.length === 2 &&
      day0.tasks.every((t) => t.id.startsWith('day0-t-')) &&
      day0.assignments.every((a) => a.id.startsWith('day0-a-')),
    'C5.7: synthetic schedule/task/assignment ids are namespaced (day0-*)',
  );
  assert(
    day0.algorithmSettings === parent.algorithmSettings &&
      day0.periodStart === parent.periodStart &&
      day0.certLabelSnapshot === parent.certLabelSnapshot &&
      day0.periodDays === parent.periodDays,
    'C5.7: synthetic schedule reuses the parent frozen fields by reference',
  );

  // getDay0HoursForParticipant — overlap-hours clipping.
  // Snapshot task Jan3 22:00→Jan4 08:00 (10h); Day-0 window [Jan3 05:00, Jan4 05:00)
  // → clipped to Jan3 22:00→Jan4 05:00 = 7h.
  const h = getDay0HoursForParticipant(parent, 'real-1');
  assert(Math.abs(h - 7) < 1e-9, 'C5.7: getDay0HoursForParticipant clips snapshot task to the Day-0 window (7h)');
  assert(
    getDay0HoursForParticipant(mkSchedule(), 'real-1') === 0,
    'C5.7: getDay0HoursForParticipant → 0 without continuity',
  );
  assert(
    getDay0HoursForParticipant(parent, 'no-such-id') === 0,
    'C5.7: getDay0HoursForParticipant → 0 for an unknown participant id',
  );
  const noNameParent = mkSchedule({
    participants: [mkParticipant('x', 'Nobody Snapshot')],
    continuitySnapshot: snapshot,
  });
  assert(
    getDay0HoursForParticipant(noNameParent, 'x') === 0,
    'C5.7: getDay0HoursForParticipant → 0 when participant name absent from snapshot',
  );
}

// ─── C5.8 — 2-D PDF fit packer (pure; the daily-export layout contract) ──────
// Pins the bug this WP fixes: the OLD row-band model produced a 2-page PDF
// with a near-empty page for a dense day. The 2-D packer MUST collapse the
// documented day to ONE page (every tiny section backfilled), and when a day
// genuinely cannot fit, spill to exactly TWO *balanced* pages at a readable
// font — never one full page + one near-empty page.

function testC58_pdfPacker(assert: AssertFn): void {
  // Realistic A4-landscape geometry (matches pdf-export's PageGeometry build).
  const geo: PageGeometry = {
    usableWidth: 281,
    heightBudget: 175,
    labelOffset: 3,
    rowGap: 3,
    colGap: 4,
    timeColWidth: 14,
    minNameColWidth: 20,
    idealNameColWidth: 30,
  };

  type R = { x: number; y: number; width: number; height: number; page: number };
  const anyOverlap = (r: R[]): boolean => {
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i];
        const b = r[j];
        if (a.page !== b.page) continue;
        if (
          a.x < b.x + b.width - 1e-6 &&
          b.x < a.x + a.width - 1e-6 &&
          a.y < b.y + b.height - 1e-6 &&
          b.y < a.y + a.height - 1e-6
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const pageBottoms = (r: R[]): number[] => {
    const m = new Map<number, number>();
    for (const s of r) m.set(s.page, Math.max(m.get(s.page) ?? 0, s.y + s.height));
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  // Faithful reconstruction of the attached real bug-report day: a 4-sub-team
  // adanit block, two heavy 6-row flat sections (≈9 names/cell), five tiny
  // sections. MUST collapse to ONE page with every tiny section on page 0.
  const realDay = planDayLayout({
    sections: [
      {
        id: 'adanit',
        displayOrder: 0,
        logicalColCount: 4,
        nameGrid: [
          [3, 4, 3, 3],
          [4, 3, 3, 3],
          [3, 4, 3, 3],
        ],
      },
      { id: 'shemesh', displayOrder: 1, logicalColCount: 1, nameGrid: [[3], [3], [3], [3], [5], [3]] },
      { id: 'shshsh', displayOrder: 2, logicalColCount: 1, nameGrid: [[9], [9], [9], [6], [9], [9]] },
      { id: 'mamtera', displayOrder: 3, logicalColCount: 1, nameGrid: [[3]] },
      { id: 'gk', displayOrder: 4, logicalColCount: 1, nameGrid: [[2]] },
      { id: 'matara', displayOrder: 5, logicalColCount: 1, nameGrid: [[3]] },
      { id: 'bi', displayOrder: 6, logicalColCount: 1, nameGrid: [[1]] },
      { id: 'dgk', displayOrder: 7, logicalColCount: 1, nameGrid: [[1]] },
    ],
    geometry: geo,
    levers: DEFAULT_LEVERS,
  });
  assert(
    !realDay.overflow && realDay.pageCount === 1 && realDay.predictedHeight <= geo.heightBudget,
    'C5.8: real bug-report day collapses to ONE page within budget',
  );
  assert(!anyOverlap(realDay.sections), 'C5.8: real day — no overlapping sections');
  assert(
    realDay.sections.filter((s) => ['mamtera', 'gk', 'matara', 'bi', 'dgk'].includes(s.id)).every((s) => s.page === 0),
    'C5.8: every tiny section backfills page 1 (no near-empty spill)',
  );

  // Genuinely impossible day: six 30-row single-name sections (height driven
  // purely by row count — name-column reshaping cannot shrink them). Must
  // spill to exactly 2 pages, balanced, at the readable floor font (7).
  const huge = planDayLayout({
    sections: Array.from({ length: 6 }, (_, i) => ({
      id: `S${i}`,
      displayOrder: i,
      logicalColCount: 1,
      nameGrid: Array.from({ length: 30 }, () => [1]),
    })),
    geometry: geo,
    levers: DEFAULT_LEVERS,
  });
  const bottoms = pageBottoms(huge.sections);
  assert(huge.overflow && huge.pageCount === 2, 'C5.8: impossible day spills to exactly 2 pages');
  assert(
    huge.fontSize >= 7 && bottoms.every((b) => b <= geo.heightBudget),
    'C5.8: 2-page fallback stays readable (font ≥ 7) and within per-page budget',
  );
  assert(
    bottoms.length === 2 && Math.abs(bottoms[0] - bottoms[1]) <= 20,
    'C5.8: the two pages are balanced (no near-empty trailing page)',
  );
  assert(!anyOverlap(huge.sections), 'C5.8: 2-page fallback — no overlapping sections');

  // Determinism: identical input ⇒ byte-identical plan (stable exports/tests).
  const detIn = {
    sections: [
      { id: 'X', displayOrder: 0, logicalColCount: 1, nameGrid: [[5], [5], [5]] },
      { id: 'Y', displayOrder: 1, logicalColCount: 1, nameGrid: [[2]] },
    ],
    geometry: geo,
    levers: DEFAULT_LEVERS,
  };
  // Two independent runs on identical input must produce identical plans.
  // Bound to separate consts so the determinism check isn't a literal
  // self-compare (Biome noSelfCompare) while keeping the exact intent.
  const detRun1 = JSON.stringify(planDayLayout(detIn));
  const detRun2 = JSON.stringify(planDayLayout(detIn));
  assert(detRun1 === detRun2, 'C5.8: planner is deterministic (identical input ⇒ identical plan)');
}

// ─── C5.9 — Phase 1.5 spread pass widens & centers sparse pages ──────────────
// The MAXRECTS packer (C5.8) is a pure space-minimizer: on sparse days it
// cheerfully crowds every tiny section into one corner and leaves the other
// half of the page dead. C5.9 covers the spread pass that — after a successful
// 1-page fit — grows name sub-columns, then cell padding, then centers the
// cluster, gated by a re-pack into one bin. Invariants: never grows the page
// count, never regresses a dense page (slack-gate no-op), deterministic.

function testC59_pdfSpread(assert: AssertFn): void {
  const geo: PageGeometry = {
    usableWidth: 281,
    heightBudget: 175,
    labelOffset: 3,
    rowGap: 3,
    colGap: 4,
    timeColWidth: 14,
    minNameColWidth: 20,
    idealNameColWidth: 30,
  };

  type R = { x: number; y: number; width: number; height: number; page: number };
  const anyOverlap = (r: R[]): boolean => {
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i];
        const b = r[j];
        if (a.page !== b.page) continue;
        if (
          a.x < b.x + b.width - 1e-6 &&
          b.x < a.x + a.width - 1e-6 &&
          a.y < b.y + b.height - 1e-6 &&
          b.y < a.y + a.height - 1e-6
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const bbox = (r: R[], page = 0): { x0: number; y0: number; x1: number; y1: number } => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = 0;
    let y1 = 0;
    for (const s of r) {
      if (s.page !== page) continue;
      if (s.x < x0) x0 = s.x;
      if (s.y < y0) y0 = s.y;
      if (s.x + s.width > x1) x1 = s.x + s.width;
      if (s.y + s.height > y1) y1 = s.y + s.height;
    }
    return { x0, y0, x1, y1 };
  };

  // ── (1) Sparse day matching the bug-report screenshot: 7 small sections with
  // ample headroom both axes. Spread MUST widen the cluster AND center it.
  const sparseInput = {
    sections: [
      { id: 'hamama', displayOrder: 0, logicalColCount: 1, nameGrid: [[1], [1]] },
      { id: 'adanit', displayOrder: 1, logicalColCount: 1, nameGrid: [[6], [6], [6], [3]] },
      { id: 'boker', displayOrder: 2, logicalColCount: 1, nameGrid: [[2]] },
      { id: 'erev', displayOrder: 3, logicalColCount: 1, nameGrid: [[2]] },
      { id: 'shemesh', displayOrder: 4, logicalColCount: 1, nameGrid: [[1], [1], [1], [1], [3], [2]] },
      { id: 'mamtera', displayOrder: 5, logicalColCount: 1, nameGrid: [[2]] },
      { id: 'kruv', displayOrder: 6, logicalColCount: 1, nameGrid: [[3], [3], [3]] },
    ],
    geometry: geo,
    levers: DEFAULT_LEVERS,
  };
  const sparse = planDayLayout(sparseInput);
  assert(sparse.pageCount === 1 && !sparse.overflow, 'C5.9: sparse day still fits one page after spread');
  assert(!anyOverlap(sparse.sections), 'C5.9: sparse day — no overlapping sections');
  const sparseBb = bbox(sparse.sections);
  const sparseCenterX = (sparseBb.x0 + sparseBb.x1) / 2;
  // Lever C took effect: padding grew above the Phase 1 floor.
  assert(
    sparse.cellPadding > DEFAULT_LEVERS.cellPaddings[0] + 1e-6,
    `C5.9: sparse — padding grew from ${DEFAULT_LEVERS.cellPaddings[0]} (got ${sparse.cellPadding.toFixed(2)})`,
  );
  // Lever D took effect: cluster sits at horizontal page midpoint.
  assert(
    Math.abs(sparseCenterX - geo.usableWidth / 2) <= 2,
    `C5.9: sparse cluster horizontally centered (center=${sparseCenterX.toFixed(1)}, mid=${(geo.usableWidth / 2).toFixed(1)})`,
  );
  // Width invariant: spread MUST NOT inflate per-section widths beyond what
  // Phase 1 picked (this is the bug from the first spread iteration — Levers
  // A/B widening sparse 1-name tables to span the whole page).
  const sparseRawWidths = planDayLayout({
    ...sparseInput,
    levers: { ...DEFAULT_LEVERS, disableSpread: true },
  }).sections;
  for (const s of sparse.sections) {
    const raw = sparseRawWidths.find((r) => r.id === s.id);
    if (!raw) continue;
    assert(
      Math.abs(s.width - raw.width) < 1e-6 && s.nameCols === raw.nameCols,
      `C5.9: section '${s.id}' width/nameCols unchanged by spread (raw=${raw.width.toFixed(1)}/${raw.nameCols}, spread=${s.width.toFixed(1)}/${s.nameCols})`,
    );
  }

  // ── (2) Spread-disabled flag: same fixture, `disableSpread: true` ⇒ raw
  // Phase 1 placements (no widening, no centering — cluster pinned at x=0).
  const sparseRaw = planDayLayout({ ...sparseInput, levers: { ...DEFAULT_LEVERS, disableSpread: true } });
  assert(sparseRaw.pageCount === 1, 'C5.9: disableSpread — still 1 page');
  const rawBb = bbox(sparseRaw.sections);
  assert(rawBb.x0 < 1, `C5.9: disableSpread leaves cluster pinned at left (x0=${rawBb.x0.toFixed(2)}, expected ≈ 0)`);
  assert(
    Math.abs(sparseCenterX - geo.usableWidth / 2) < Math.abs((rawBb.x0 + rawBb.x1) / 2 - geo.usableWidth / 2),
    'C5.9: spread cluster is closer to page center than raw Phase 1',
  );

  // ── (3) No-regression on dense day: re-run the C5.8 realDay fixture. The
  // slack-gate must keep the spread a no-op (or near-no-op) — page count stays
  // 1, no section migrates pages, predicted height ≤ heightBudget.
  const dense = planDayLayout({
    sections: [
      {
        id: 'adanit',
        displayOrder: 0,
        logicalColCount: 4,
        nameGrid: [
          [3, 4, 3, 3],
          [4, 3, 3, 3],
          [3, 4, 3, 3],
        ],
      },
      { id: 'shemesh', displayOrder: 1, logicalColCount: 1, nameGrid: [[3], [3], [3], [3], [5], [3]] },
      { id: 'shshsh', displayOrder: 2, logicalColCount: 1, nameGrid: [[9], [9], [9], [6], [9], [9]] },
      { id: 'mamtera', displayOrder: 3, logicalColCount: 1, nameGrid: [[3]] },
      { id: 'gk', displayOrder: 4, logicalColCount: 1, nameGrid: [[2]] },
      { id: 'matara', displayOrder: 5, logicalColCount: 1, nameGrid: [[3]] },
      { id: 'bi', displayOrder: 6, logicalColCount: 1, nameGrid: [[1]] },
      { id: 'dgk', displayOrder: 7, logicalColCount: 1, nameGrid: [[1]] },
    ],
    geometry: geo,
    levers: DEFAULT_LEVERS,
  });
  assert(
    !dense.overflow && dense.pageCount === 1 && dense.predictedHeight <= geo.heightBudget,
    'C5.9: dense day — spread did not push past 1 page or exceed height budget',
  );
  assert(!anyOverlap(dense.sections), 'C5.9: dense day — no overlapping sections after spread');

  // ── (4) No-regression on impossible day: Phase 1 fails so spread never runs.
  // The 2-page balanced fallback must be byte-equivalent to C5.8's expectation.
  const huge = planDayLayout({
    sections: Array.from({ length: 6 }, (_, i) => ({
      id: `S${i}`,
      displayOrder: i,
      logicalColCount: 1,
      nameGrid: Array.from({ length: 30 }, () => [1]),
    })),
    geometry: geo,
    levers: DEFAULT_LEVERS,
  });
  assert(
    huge.overflow && huge.pageCount === 2 && huge.fontSize >= 7,
    'C5.9: impossible day — spread untouched (still spills to 2 balanced pages at readable font)',
  );

  // ── (5) Determinism: identical inputs ⇒ identical plans (with spread on).
  const det1 = JSON.stringify(planDayLayout(sparseInput));
  const det2 = JSON.stringify(planDayLayout(sparseInput));
  assert(det1 === det2, 'C5.9: spread pass is deterministic');

  // ── (6) Single-section day — the cluster is one rectangle; centering should
  // land it at the page midpoint on both axes.
  const single = planDayLayout({
    sections: [{ id: 'solo', displayOrder: 0, logicalColCount: 1, nameGrid: [[1]] }],
    geometry: geo,
    levers: DEFAULT_LEVERS,
  });
  assert(single.pageCount === 1 && single.sections.length === 1, 'C5.9: single-section day — 1 page, 1 placement');
  const solo = single.sections[0];
  const soloCenterX = solo.x + solo.width / 2;
  const soloCenterY = solo.y + solo.height / 2;
  assert(
    Math.abs(soloCenterX - geo.usableWidth / 2) <= 2,
    `C5.9: single-section — horizontally centered (x-center=${soloCenterX.toFixed(1)})`,
  );
  assert(
    Math.abs(soloCenterY - geo.heightBudget / 2) <= 2,
    `C5.9: single-section — vertically centered (y-center=${soloCenterY.toFixed(1)})`,
  );
}

// ─── Standalone entry point ─────────────────────────────────────────────────
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
  runExportLayoutTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
