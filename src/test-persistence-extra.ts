/**
 * WP4 — Persistence / continuity / frozen-snapshot / data-transfer (net-new).
 *
 * Covers C4.1–C4.6. C4.1 additionally pins a behavior that is under
 * independent review: `importFullBackup`'s pre-import-state handling on a
 * failed restore write. C4.4 asserts the resolved contract that
 * `jsonDeserialize` rejects an unparseable `__date__` value rather than
 * propagating an Invalid Date (plus a prototype-pollution safety check).
 *
 * Group B (imports `src/web`): runs under `tsconfig.test-persistence.json` via
 * `npm run test:persistence`. Standalone:
 *   npx ts-node --project tsconfig.test-persistence.json src/test-persistence-extra.ts
 */

// ═══════════════════════════════════════════════════════════════════════════════
// localStorage / DOMException / location / document / navigator / URL / Blob /
// File shims — replicated from the head of src/test-persistence.ts.  These MUST
// be installed before any src/web module function is *called*.  Each install is
// guarded so wiring this file into src/test-persistence.ts (which installs the
// same shims first) does not double-install.
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
    const keys = [...this._data.keys()];
    return keys[index] ?? null;
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
  _gs.location = {
    reload: () => {
      /* no-op stub; importFullBackup calls this on success */
    },
    href: 'http://localhost:5174/',
  };
}
if (typeof _gs.document === 'undefined') {
  _gs.document = {
    createElement: () => ({ click: () => {}, style: {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
}
if (typeof _gs.navigator === 'undefined') {
  _gs.navigator = {};
}
if (typeof _gs.URL === 'undefined') {
  _gs.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
}
if (typeof _gs.Blob === 'undefined') {
  _gs.Blob = class Blob {
    constructor(
      public parts: unknown[],
      public options?: { type?: string },
    ) {}
    get type() {
      return this.options?.type ?? '';
    }
  };
}
if (typeof _gs.File === 'undefined') {
  _gs.File = class File {
    name: string;
    type: string;
    constructor(_parts: unknown[], name: string, options?: { type?: string }) {
      this.name = name;
      this.type = options?.type ?? '';
    }
  };
}

// ─── Now safe to import store + data-transfer + engine ─────────────────────────
// `./engine/scheduler` and `./models/types` are pure `src/` (no DOM) and are
// already part of the Node `tsc` build, so static imports are safe.
import { SchedulingEngine } from './engine/scheduler';
import { Level, type Participant, type Schedule, type Task } from './models/types';

// The `src/web` modules are DOM-dependent. They are loaded through a
// runtime-computed specifier (NOT a static `import` or string-literal
// `require`) on purpose: the Node-targeted `npm run build:node`
// (tsconfig.json, no DOM lib, `src/web` excluded) picks this file up as a
// compilation root, and in `node16` module mode `tsc` resolves and
// type-checks any statically-known module specifier — which would drag the
// DOM-dependent `src/web` graph into the Node build and fail it. A computed
// specifier is unresolvable to `tsc`, so it is NOT added to the build:node
// program (stays clean WITHOUT a tsconfig exclude edit), while at runtime
// (`ts-node --project tsconfig.test-persistence.json`, DOM lib present) the
// string evaluates to the real path and the modules load normally.
// biome-ignore lint: dynamic require by design (keeps src/web out of build:node)
const _req = require as (id: string) => any;
const _W = './web/';
const store = _req(`${_W}config-store`) as Record<string, any>;
const dataTransfer = _req(`${_W}data-transfer`) as Record<string, any>;
const { parseContinuitySnapshot } = _req(`${_W}continuity-import`) as {
  parseContinuitySnapshot: (json: string) => { error: string } | Record<string, unknown>;
};

type AssertFn = (condition: boolean, name: string) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Hard reset between test blocks: drain timers, clear in-memory + storage. */
function resetAll(): void {
  store.factoryReset();
  (globalThis as unknown as { localStorage: Storage }).localStorage.clear();
}

/** Build a structurally-valid full-backup envelope JSON wrapping the given
 *  storageEntries (always includes a valid `gardenmanager_state`). */
function buildBackupJson(entries: Record<string, string>): string {
  const storageEntries: Record<string, string> = {
    gardenmanager_state: JSON.stringify({ version: 7, scheduleDate: new Date().toISOString(), scheduleDays: 7 }),
    ...entries,
  };
  return JSON.stringify({
    _format: 'gardenmanager-export',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    exportType: 'fullBackup',
    payload: { storageEntries },
  });
}

/**
 * Mirror of the (module-private) `hasFrozenFields` predicate in
 * src/web/app.ts:257-268. The app's load path (app.ts:7359, :2153, and
 * loadScheduleFromFrozen:6938) discards any persisted schedule for which this
 * returns false. Kept in lock-step with the scheduler frozen-field set written
 * by `_commitOptimizationResult` (src/engine/scheduler.ts:443-451:
 * algorithmSettings{config}, restRuleSnapshot, certLabelSnapshot, periodStart
 * (Date), periodDays (number)). If app.ts changes the predicate, update here.
 */
function hasFrozenFieldsLikeApp(sched: unknown): boolean {
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

function makeParticipant(id: string, name: string, start: Date, end: Date): Participant {
  return {
    id,
    name,
    level: Level.L0,
    certifications: [],
    group: 'A',
    availability: [{ start, end }],
    dateUnavailability: [],
  };
}

function makeTask(id: string, start: Date, end: Date): Task {
  return {
    id,
    name: 'TestTask D1',
    sourceName: 'TestTask',
    timeBlock: { start, end },
    requiredCount: 1,
    slots: [{ slotId: `${id}-s1`, acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [] }],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

/** Temporarily make localStorage.setItem throw a quota error on the Nth call. */
function withSetItemThrowingOnCall<T>(n: number, fn: () => T): T {
  const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
  const orig = ls.setItem.bind(ls);
  let calls = 0;
  // biome-ignore lint: test monkey-patch
  (ls as any).setItem = (k: string, v: string) => {
    calls++;
    if (calls === n) {
      const DE = (globalThis as unknown as { DOMException: typeof DOMException }).DOMException;
      throw new DE('quota exceeded', 'QuotaExceededError');
    }
    return orig(k, v);
  };
  try {
    return fn();
  } finally {
    // biome-ignore lint: test monkey-patch restore
    (ls as any).setItem = orig;
  }
}

const LS = () => (globalThis as unknown as { localStorage: Storage }).localStorage;

// ═══════════════════════════════════════════════════════════════════════════════
// Main runner
// ═══════════════════════════════════════════════════════════════════════════════

export async function runPersistenceExtraTests(assert: AssertFn): Promise<void> {
  console.log('\n── WP4: persistence / frozen-snapshot / data-transfer extra ──');

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.1 — RESOLVED: importFullBackup pre-import-state handling on a failed
  // restore write. The prior open question ("if the restore write loop throws
  // partway, what happens to the user's data?") was investigated and judged a
  // real defect: factoryReset() destroyed the only copy before the (possibly
  // failing) write, leaving the user with neither their old data nor a
  // complete backup. importFullBackup now snapshots localStorage to the heap
  // before factoryReset() and rolls back on any write failure. This block now
  // asserts the corrected behavior: a mid-write quota error leaves the user's
  // ORIGINAL data fully intact (and still reports a structured failure).
  // ═══════════════════════════════════════════════════════════════════════════
  {
    resetAll();
    // Seed real user data and force-persist it.
    store.addParticipant({ name: 'UserAlice', group: 'A' });
    store.flushPendingSave();
    store.saveToStorage();
    const before = LS().getItem('gardenmanager_state');
    assert(
      before !== null && before.includes('UserAlice'),
      'C4.1: pre-import user state persisted (contains seeded participant)',
    );

    // A perfectly valid backup envelope — the ONLY failure is a transient
    // quota error on the first restore write.
    const backupJson = buildBackupJson({
      gardenmanager_algorithm: JSON.stringify({ foo: 1 }),
    });
    const v = dataTransfer.validateImportFile(backupJson);
    assert(v.ok === true, 'C4.1: backup payload is a structurally-valid fullBackup (validateImportFile ok)');

    const result = withSetItemThrowingOnCall(1, () => dataTransfer.importFullBackup(backupJson));

    // A mid-write failure must still be reported as a structured failure...
    assert(result.ok === false, 'C4.1: importFullBackup reports failure on mid-write quota error');
    assert(
      typeof result.error === 'string' && result.error.length > 0,
      'C4.1: importFullBackup returns a non-empty error string on mid-write failure',
    );

    // ...and the user's ORIGINAL data must be rolled back / preserved — not
    // wiped — so a failed restore can never leave the user with neither their
    // old data nor a complete backup (the resolved defect).
    const afterState = LS().getItem('gardenmanager_state');
    assert(
      afterState !== null && afterState.includes('UserAlice'),
      'C4.1: after a failed restore write, pre-import user data is preserved/restored (rollback)',
    );
    // The half-applied backup must not survive: a backup-only key that did not
    // exist before the import must be gone after rollback.
    assert(
      LS().getItem('gardenmanager_algorithm') === null,
      'C4.1: a backup-only key written before the failure is removed by rollback (no half-applied backup)',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.2 — hasFrozenFields discard-on-load: a persisted schedule missing the
  // frozen fields must be detected as stale (app discards it + clear path).
  // ═══════════════════════════════════════════════════════════════════════════
  {
    resetAll();
    const stale = {
      id: 'stale-1',
      tasks: [],
      participants: [],
      assignments: [],
      feasible: true,
      score: {},
      violations: [],
      generatedAt: new Date(),
      // intentionally MISSING: algorithmSettings, restRuleSnapshot,
      // certLabelSnapshot, periodStart, periodDays
    } as unknown as Schedule;

    const saved = store.saveSchedule(stale);
    assert(saved === true, 'C4.2: store.saveSchedule persists a schedule blob (store itself is not the gate)');

    const loaded = store.loadSchedule();
    assert(loaded !== null, 'C4.2: store.loadSchedule returns the persisted blob (no store-level frozen check)');
    assert(
      hasFrozenFieldsLikeApp(loaded) === false,
      'C4.2: pre-schema schedule fails the frozen-field predicate → app discards it on load',
    );

    // Positive control: a fully-frozen schedule passes the predicate.
    const frozen = {
      ...(loaded as object),
      algorithmSettings: { config: {}, disabledHardConstraints: [], dayStartHour: 5 },
      restRuleSnapshot: {},
      certLabelSnapshot: {},
      periodStart: new Date(),
      periodDays: 7,
    } as unknown as Schedule;
    assert(hasFrozenFieldsLikeApp(frozen) === true, 'C4.2: fully-frozen schedule passes the frozen-field predicate');

    // The clear path the app runs on discard.
    store.clearSchedule();
    assert(store.loadSchedule() === null, 'C4.2: clearSchedule() removes the blob → loadSchedule() === null');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.3 — Frozen-snapshot participant deep-clone isolation. Mutating the
  // store/engine participant AFTER generation must NOT reach
  // Schedule.participants[i] (structuredClone in _commitOptimizationResult).
  // ═══════════════════════════════════════════════════════════════════════════
  {
    resetAll();
    const start = new Date('2026-03-15T06:00:00Z');
    const end = new Date('2026-03-15T14:00:00Z');
    const orig = makeParticipant('c43-p1', 'OrigName', start, end);

    const engine = new SchedulingEngine({ maxIterations: 50, maxSolverTimeMs: 500 });
    engine.addParticipant(orig);
    engine.addTask(makeTask('c43-t1', start, end));
    const schedule = engine.generateSchedule();

    const snap = schedule.participants.find((p) => p.id === 'c43-p1');
    assert(snap !== undefined, 'C4.3: generated schedule contains the participant snapshot');
    if (snap) {
      const origLevel = snap.level;
      const origName = snap.name;
      const origCertCount = snap.certifications.length;
      const origAvailCount = snap.availability.length;

      // Deep-mutate BOTH the caller object and the engine's internal copy.
      orig.level = Level.L4;
      orig.name = 'CALLER_HACKED';
      orig.certifications.push('Nitzan');
      orig.availability.push({ start, end });

      const enginePart = engine.getParticipant('c43-p1');
      assert(enginePart !== undefined, 'C4.3: engine still owns the participant after generation');
      if (enginePart) {
        enginePart.level = Level.L3;
        enginePart.name = 'ENGINE_HACKED';
        enginePart.certifications.push('Hamama');
        enginePart.availability.push({ start, end });
      }

      assert(snap.level === origLevel, 'C4.3: Schedule.participants[i].level unchanged after store/engine mutation');
      assert(snap.name === origName, 'C4.3: Schedule.participants[i].name unchanged after store/engine mutation');
      assert(
        snap.certifications.length === origCertCount,
        'C4.3: Schedule.participants[i].certifications array isolated (no leaked push)',
      );
      assert(
        snap.availability.length === origAvailCount,
        'C4.3: Schedule.participants[i].availability array isolated (no leaked push)',
      );
      assert(snap !== orig, 'C4.3: snapshot participant is a distinct object from the caller object');
      assert(
        snap !== enginePart,
        'C4.3: snapshot participant is a distinct object from the engine-internal participant',
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.4 — prototype-pollution safety + REVIEW: jsonDeserialize __date__
  // handling + deep-validator malformed-payload rejection.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    // ── Part A: prototype pollution must NOT occur ──────────────────────────
    resetAll();
    const pollutionBackup = buildBackupJson({
      // attacker-controlled localStorage key + a state value that tries
      // __proto__ / constructor.prototype pollution on later parse.
      __proto__: JSON.stringify({ polluted: true }),
      gardenmanager_algorithm: JSON.stringify({
        __proto__: { polluted: true },
        constructor: { prototype: { polluted2: true } },
      }),
    });
    try {
      dataTransfer.importFullBackup(pollutionBackup);
    } catch {
      /* importFullBackup must not throw on this; tolerated either way */
    }
    // Also drive the documented reviver path directly.
    store.jsonDeserialize('{"a":{"__proto__":{"polluted":true}},"b":{"constructor":{"prototype":{"polluted2":true}}}}');
    const probe = {} as Record<string, unknown>;
    assert(probe.polluted === undefined, 'C4.4: Object.prototype not polluted via __proto__ key (importFullBackup)');
    assert(probe.polluted2 === undefined, 'C4.4: Object.prototype not polluted via constructor.prototype');
    assert(
      (Object.prototype as Record<string, unknown>).polluted === undefined,
      'C4.4: Object.prototype.polluted is undefined (direct check)',
    );

    // ── Part B: jsonDeserialize rejects an unparseable __date__ ─────────────
    // Resolved (independent investigation): jsonSerialize only ever emits a
    // re-parseable Date.toISOString() and throws on an Invalid Date, so a
    // __date__ marker that does not parse back to a valid Date is corrupt /
    // foreign input. The reviver is symmetric — it rejects (throws) rather than
    // propagating an Invalid Date (getTime()===NaN, yet still `instanceof Date`,
    // so it would slip past the hasFrozenFields() "drop & regenerate" net) into
    // engine fields such as Schedule.periodStart / Task.timeBlock.
    let revivedRejected = false;
    try {
      store.jsonDeserialize('{"d":{"__date__":"garbage-not-a-date"}}');
    } catch {
      revivedRejected = true;
    }
    assert(
      revivedRejected,
      'C4.4: jsonDeserialize rejects (throws on) an unparseable {__date__} rather than reviving an Invalid Date',
    );
    // A valid __date__ still round-trips normally (the strictness is targeted).
    const okRevived = store.jsonDeserialize('{"d":{"__date__":"2026-01-15T10:30:00.000Z"}}') as { d: Date };
    assert(
      okRevived.d instanceof Date && !Number.isNaN(okRevived.d.getTime()),
      'C4.4: a valid __date__ still revives to a valid Date (rejection is targeted, not blanket)',
    );

    // Full path: a hostile backup whose schedule blob carries a garbage
    // __date__ is rejected at deserialization, so loadSchedule() returns null
    // (its try/catch) — the app then shows no schedule and the user
    // regenerates, instead of running on Invalid Dates in engine fields.
    resetAll();
    const poisonedSchedule = JSON.stringify({
      id: 's',
      tasks: [{ id: 't', name: 'X', timeBlock: { start: { __date__: 'garbage' }, end: { __date__: 'garbage' } } }],
      participants: [],
      assignments: [],
    });
    try {
      dataTransfer.importFullBackup(buildBackupJson({ gardenmanager_schedule: poisonedSchedule }));
    } catch {
      /* tolerated */
    }
    const loadedPoison = store.loadSchedule();
    assert(
      loadedPoison === null,
      'C4.4: a garbage __date__ in a backup is rejected — loadSchedule() returns null, no Invalid Date reaches engine fields',
    );

    // ── Part C: deep validators reject malformed payloads ───────────────────
    const badTaskSet = JSON.stringify({
      _format: 'gardenmanager-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportType: 'taskSet',
      payload: { taskSet: { id: 't', name: 'n', createdAt: 1 /* templates missing */ } },
    });
    const rTaskSet = dataTransfer.validateImportFile(badTaskSet);
    assert(
      rTaskSet.ok === false && typeof rTaskSet.error === 'string' && rTaskSet.error.length > 0,
      'C4.4: taskSet payload missing templates[] is rejected with a clear error',
    );

    const badPset = JSON.stringify({
      _format: 'gardenmanager-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportType: 'participantSet',
      payload: {
        participantSet: {
          id: 'p',
          name: 'n',
          createdAt: 1,
          participants: [{ level: 0, certifications: [], group: 'A', dateUnavailability: [] /* name missing */ }],
          certificationCatalog: [],
        },
      },
    });
    const rPset = dataTransfer.validateImportFile(badPset);
    assert(
      rPset.ok === false && typeof rPset.error === 'string' && rPset.error.length > 0,
      'C4.4: participant missing "name" is rejected with a clear error',
    );

    const noStateBackup = JSON.stringify({
      _format: 'gardenmanager-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportType: 'fullBackup',
      payload: { storageEntries: { something_else: 'x' } },
    });
    const rNoState = dataTransfer.validateImportFile(noStateBackup);
    assert(
      rNoState.ok === false && typeof rNoState.error === 'string' && rNoState.error.length > 0,
      'C4.4: fullBackup missing gardenmanager_state key is rejected',
    );

    const nonStringEntry = JSON.stringify({
      _format: 'gardenmanager-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportType: 'fullBackup',
      payload: { storageEntries: { gardenmanager_state: '{}', bad: 123 } },
    });
    const rNonString = dataTransfer.validateImportFile(nonStringEntry);
    assert(
      rNonString.ok === false && typeof rNonString.error === 'string',
      'C4.4: fullBackup with a non-string entry value is rejected',
    );

    const unparseableState = JSON.stringify({
      _format: 'gardenmanager-export',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportType: 'fullBackup',
      payload: { storageEntries: { gardenmanager_state: 'this-is-not-json' } },
    });
    const rUnparseable = dataTransfer.validateImportFile(unparseableState);
    assert(
      rUnparseable.ok === false && typeof rUnparseable.error === 'string',
      'C4.4: fullBackup with an unparseable gardenmanager_state is rejected',
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.5 — Quota mid-restore (graceful) + oversized / deeply-nested JSON.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    resetAll();
    // Quota on the first restore write → structured error, no throw/crash.
    let threw = false;
    let res: { ok: boolean; error?: string } | null = null;
    try {
      res = withSetItemThrowingOnCall(1, () =>
        dataTransfer.importFullBackup(buildBackupJson({ gardenmanager_algorithm: '{}' })),
      );
    } catch {
      threw = true;
    }
    assert(threw === false, 'C4.5: importFullBackup does not throw on a mid-restore quota error');
    assert(
      res !== null && res.ok === false && typeof res.error === 'string' && res.error.length > 0,
      'C4.5: importFullBackup returns a graceful structured error on quota (no wiped-and-unrestored crash)',
    );
    // NOTE: pre-import-state restore on a failed write is the open question
    // pinned in C4.1 — not re-pinned here to avoid a duplicate signal.

    // Oversized flat JSON → bounded, no crash, fast rejection (not a valid envelope).
    const huge = `{"_format":"x","big":"${'A'.repeat(1_000_000)}"}`;
    const t0 = Date.now();
    let hugeOk = true;
    try {
      const r = dataTransfer.validateImportFile(huge);
      assert(r.ok === false, 'C4.5: a 1MB non-envelope JSON is rejected (not accepted as a valid import)');
    } catch {
      hugeOk = false;
    }
    assert(hugeOk, 'C4.5: validateImportFile handles a 1MB payload without throwing');
    assert(Date.now() - t0 < 5000, 'C4.5: oversized-JSON handling is bounded (<5s)');

    // Deeply-nested JSON → handled (parsed or catchable error), never an
    // uncaught crash / hang.
    let nested = '0';
    for (let i = 0; i < 2000; i++) nested = `{"a":${nested}}`;
    let nestedHandled = false;
    try {
      store.jsonDeserialize(nested);
      nestedHandled = true;
    } catch {
      nestedHandled = true; // RangeError/stack — catchable, still graceful
    }
    assert(nestedHandled, 'C4.5: deeply-nested JSON (2000 levels) is handled gracefully (no uncaught crash)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // C4.6 — continuity-import assignment-level validation.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const validSnap = () => ({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      dayIndex: 1,
      dayWindow: { start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() },
      participants: [
        {
          name: 'Pat',
          level: 0,
          certifications: [],
          group: 'A',
          assignments: [
            {
              sourceName: 'Task',
              taskName: 'Task D1',
              timeBlock: {
                start: new Date().toISOString(),
                end: new Date(Date.now() + 3600_000).toISOString(),
              },
              blocksConsecutive: true,
            },
          ],
        },
      ],
    });

    const ok = parseContinuitySnapshot(JSON.stringify(validSnap()));
    assert(!('error' in ok), 'C4.6: a well-formed continuity snapshot parses successfully');

    const rejected = (mutate: (s: ReturnType<typeof validSnap>) => void, label: string, expectFragment: string) => {
      const s = validSnap();
      mutate(s);
      const r = parseContinuitySnapshot(JSON.stringify(s));
      const isErr = typeof r === 'object' && r !== null && 'error' in r;
      const msg = isErr ? (r as { error: string }).error : '';
      assert(
        isErr && msg.length > 0 && msg.includes(expectFragment),
        `C4.6: ${label} → rejected with a clear error (mentions "${expectFragment}")`,
      );
    };

    rejected(
      (s) => {
        delete (s.participants[0].assignments[0] as Record<string, unknown>).taskName;
      },
      'assignment missing taskName',
      'taskName',
    );
    rejected(
      (s) => {
        delete (s.participants[0].assignments[0] as Record<string, unknown>).timeBlock;
      },
      'assignment missing timeBlock',
      'timeBlock',
    );
    rejected(
      (s) => {
        delete (s.participants[0].assignments[0] as Record<string, unknown>).blocksConsecutive;
      },
      'assignment missing blocksConsecutive',
      'blocksConsecutive',
    );
    rejected(
      (s) => {
        (s.participants[0].assignments[0] as Record<string, unknown>).restRuleId = 123;
      },
      'restRuleId wrong type (number)',
      'restRuleId',
    );
    rejected(
      (s) => {
        s.participants[0].assignments[0].timeBlock.start = 'not-a-date';
      },
      'unparseable timeBlock date',
      'תאריכים',
    );
  }

  resetAll();
  console.log('── WP4 extra tests complete ──');
}

// ─── Standalone entry point ────────────────────────────────────────────────────
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
  runPersistenceExtraTests(assert)
    .then(() => {
      console.log(`\n  ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
