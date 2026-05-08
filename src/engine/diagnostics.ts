/**
 * Scheduler diagnostics — single gated console command.
 *
 *   toggleSchedulerDiag()           // toggle on ↔ off
 *   toggleSchedulerDiag('on')       // explicit on (summary mode)
 *   toggleSchedulerDiag('verbose')  // on + per-(participant, slot) elig log
 *   toggleSchedulerDiag('off')      // explicit off
 *   toggleSchedulerDiag('show')     // print last-run report (mode unchanged)
 *
 * Internally records phase timings, SA accept/reject by neighbourhood,
 * polish-pass stats, per-attempt SC component breakdown, and (verbose only)
 * rejection counts by HC code / task / participant. The 'show' action prints
 * everything as one structured report.
 *
 * Performance contract: when mode is 'off', every `record*` recorder
 * short-circuits on its first line — no Map allocations, no counter writes,
 * no snapshot retention.
 *
 * Memory contract: the snapshot stores scalars only (numbers, short strings).
 * Never captures Assignment / Task / Participant references — those would
 * pin the entire schedule graph alive across runs.
 */

export type DiagMode = 'off' | 'on' | 'verbose';

export interface AttemptRow {
  /** 1-based attempt index */
  attempt: number;
  compositeScore: number;
  unfilled: number;
  feasible: boolean;
  improved: boolean;
  durationMs: number;
  iterations: number;
  /** Flat numeric copy of ScheduleScore — no object refs. */
  score: {
    minRestHours: number;
    avgRestHours: number;
    restStdDev: number;
    totalPenalty: number;
    l0StdDev: number;
    seniorStdDev: number;
    dailyPerParticipantStdDev: number;
    dailyGlobalStdDev: number;
    restPerGapBonus: number;
    lowPriorityPenalty: number;
    notWithPenalty: number;
    taskPrefPenalty: number;
  };
}

export interface DiagSnapshot {
  startedAt: number;
  phases: {
    greedyMs: number;
    saMs: number;
    polishMs: number;
    totalMs: number;
  };
  sa: {
    iters: number;
    swapAccept: number;
    swapReject: number;
    insertAccept: number;
    insertReject: number;
    reheats: number;
    tempAtExit: number;
    itersSinceImprovementAtExit: number;
  };
  polish: {
    passes: number;
    replacementsPerPass: number[];
    deltaPerPass: number[];
  };
  attempts: AttemptRow[];
  rejections: {
    byCode: Map<string, number>;
    byTask: Map<string, number>;
    byParticipant: Map<string, number>;
    /** True when at least one rejection was captured. False until the first
     *  verbose-mode run records anything. */
    captured: boolean;
  };
  /** True iff at least one multi-attempt run completed under this snapshot. */
  finalized: boolean;
}

// ─── Module state ────────────────────────────────────────────────────────────

let _mode: DiagMode = 'off';
let _snapshot: DiagSnapshot | null = null;

function emptySnapshot(): DiagSnapshot {
  return {
    startedAt: Date.now(),
    phases: { greedyMs: 0, saMs: 0, polishMs: 0, totalMs: 0 },
    sa: {
      iters: 0,
      swapAccept: 0,
      swapReject: 0,
      insertAccept: 0,
      insertReject: 0,
      reheats: 0,
      tempAtExit: 0,
      itersSinceImprovementAtExit: 0,
    },
    polish: { passes: 0, replacementsPerPass: [], deltaPerPass: [] },
    attempts: [],
    rejections: {
      byCode: new Map(),
      byTask: new Map(),
      byParticipant: new Map(),
      captured: false,
    },
    finalized: false,
  };
}

// ─── Flag readers (cheap, called from hot paths) ─────────────────────────────

export function isSchedulerDiagOn(): boolean {
  return _mode !== 'off';
}

export function isVerboseDiag(): boolean {
  return _mode === 'verbose';
}

export function getSnapshot(): DiagSnapshot | null {
  return _snapshot;
}

// ─── Snapshot lifecycle ──────────────────────────────────────────────────────

/** Initialise a fresh snapshot. Called at the head of every multi-attempt run.
 *  No-op when diag is off — `_snapshot` stays null. */
export function resetSnapshot(): void {
  if (_mode === 'off') return;
  _snapshot = emptySnapshot();
}

/** Mark the current snapshot as a complete run. */
export function finalizeSnapshot(totalMs: number): void {
  if (_mode === 'off' || !_snapshot) return;
  _snapshot.phases.totalMs = totalMs;
  _snapshot.finalized = true;
}

// ─── Recorders (every first line: gate-and-return) ───────────────────────────

export function recordPhase(phase: 'greedy' | 'sa' | 'polish', ms: number): void {
  if (_mode === 'off' || !_snapshot) return;
  if (phase === 'greedy') _snapshot.phases.greedyMs += ms;
  else if (phase === 'sa') _snapshot.phases.saMs += ms;
  else if (phase === 'polish') _snapshot.phases.polishMs += ms;
}

/** Roll up SA loop stats at exit time. Cheaper than per-event recorders for
 *  a hot loop — caller maintains local counters and calls this once. */
export function recordSAStats(stats: {
  iters: number;
  swapAccept: number;
  swapReject: number;
  insertAccept: number;
  insertReject: number;
  reheats: number;
  tempAtExit: number;
  itersSinceImprovementAtExit: number;
}): void {
  if (_mode === 'off' || !_snapshot) return;
  const sa = _snapshot.sa;
  sa.iters += stats.iters;
  sa.swapAccept += stats.swapAccept;
  sa.swapReject += stats.swapReject;
  sa.insertAccept += stats.insertAccept;
  sa.insertReject += stats.insertReject;
  sa.reheats += stats.reheats;
  sa.tempAtExit = stats.tempAtExit;
  sa.itersSinceImprovementAtExit = stats.itersSinceImprovementAtExit;
}

export function recordPolishPass(replacements: number, delta: number): void {
  if (_mode === 'off' || !_snapshot) return;
  _snapshot.polish.passes += 1;
  _snapshot.polish.replacementsPerPass.push(replacements);
  _snapshot.polish.deltaPerPass.push(delta);
}

export function recordAttempt(row: AttemptRow): void {
  if (_mode === 'off' || !_snapshot) return;
  _snapshot.attempts.push(row);
}

export function recordRejection(code: string, taskId: string, participantId: string): void {
  if (_mode === 'off' || !_snapshot) return;
  const r = _snapshot.rejections;
  r.byCode.set(code, (r.byCode.get(code) ?? 0) + 1);
  r.byTask.set(taskId, (r.byTask.get(taskId) ?? 0) + 1);
  r.byParticipant.set(participantId, (r.byParticipant.get(participantId) ?? 0) + 1);
  r.captured = true;
}

// ─── Public command (single entry point) ────────────────────────────────────

/**
 * Scheduler diagnostic command — single entry point for control + inspection.
 *
 *   toggleSchedulerDiag()           // flip off ↔ on (summary mode)
 *   toggleSchedulerDiag('on')       // explicit on (summary mode)
 *   toggleSchedulerDiag('verbose')  // on with per-(participant, slot) elig spam
 *   toggleSchedulerDiag('off')      // explicit off
 *   toggleSchedulerDiag('show')     // print last-run snapshot (mode unchanged)
 *   toggleSchedulerDiag(true|false) // boolean shorthand for on/off
 */
export type DiagAction = DiagMode | 'show' | boolean;

export function toggleSchedulerDiag(arg?: DiagAction): void {
  if (arg === 'show') {
    printSnapshot();
    return;
  }
  if (arg === undefined) {
    _mode = _mode === 'off' ? 'on' : 'off';
  } else if (arg === true) {
    _mode = 'on';
  } else if (arg === false) {
    _mode = 'off';
  } else if (arg === 'off' || arg === 'on' || arg === 'verbose') {
    _mode = arg;
  } else {
    console.warn(
      `[Scheduler] toggleSchedulerDiag: unknown arg ${JSON.stringify(arg)}. Use 'on' | 'off' | 'verbose' | 'show'.`,
    );
    return;
  }
  if (_mode === 'off') {
    _snapshot = null;
  }
  console.log(
    `[Scheduler] Diagnostic logging: ${_mode.toUpperCase()}` +
      (_mode !== 'off' ? "  (call toggleSchedulerDiag('show') after regenerating to inspect)" : ''),
  );
}

// ─── Pretty-printer for the snapshot ────────────────────────────────────────

function fmtMs(n: number): string {
  return `${n.toLocaleString('en-US')}ms`;
}
function fmtPct(num: number, den: number): string {
  return den > 0 ? `${((100 * num) / den).toFixed(1)}%` : '—';
}
function sortDescAsRecord(m: Map<string, number>, limit = 20): Record<string, number> {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .reduce<Record<string, number>>((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});
}

function printSnapshot(): void {
  if (!_snapshot?.finalized) {
    console.log(
      "[Scheduler] No diag data yet. Call toggleSchedulerDiag('on') (or 'verbose'), regenerate the schedule, then toggleSchedulerDiag('show').",
    );
    return;
  }
  const s = _snapshot;
  const sa = s.sa;
  const swapTotal = sa.swapAccept + sa.swapReject;
  const insertTotal = sa.insertAccept + sa.insertReject;

  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Scheduler Diagnostics  [mode: ${_mode.toUpperCase()}]`);
  console.log(`  ${s.attempts.length} attempt(s) · ${fmtMs(s.phases.totalMs)} total`);
  console.log('═══════════════════════════════════════════════');

  // ── Phase timings ──
  console.log('\n── Phase timings ──');
  console.log(
    `  greedy: ${fmtMs(s.phases.greedyMs)}    SA: ${fmtMs(s.phases.saMs)}    polish: ${fmtMs(s.phases.polishMs)}`,
  );

  // ── Simulated annealing ──
  console.log('\n── Simulated annealing ──');
  console.log(`  iterations:      ${sa.iters.toLocaleString('en-US')}`);
  console.log(`  swap   accept:   ${sa.swapAccept.toLocaleString('en-US')} (${fmtPct(sa.swapAccept, swapTotal)})`);
  console.log(`  swap   reject:   ${sa.swapReject.toLocaleString('en-US')}`);
  console.log(
    `  insert accept:   ${sa.insertAccept.toLocaleString('en-US')} (${fmtPct(sa.insertAccept, insertTotal)})`,
  );
  console.log(`  insert reject:   ${sa.insertReject.toLocaleString('en-US')}`);
  console.log(`  reheats:         ${sa.reheats}`);
  console.log(`  temp at exit:    ${sa.tempAtExit.toFixed(3)}`);
  console.log(`  plateau on exit: ${sa.itersSinceImprovementAtExit}`);

  // ── Polish ──
  console.log(`\n── Polish (${s.polish.passes} pass${s.polish.passes === 1 ? '' : 'es'}) ──`);
  if (s.polish.passes === 0) {
    console.log('  (no replacements found)');
  } else {
    for (let i = 0; i < s.polish.passes; i++) {
      const reps = s.polish.replacementsPerPass[i] ?? 0;
      const delta = s.polish.deltaPerPass[i] ?? 0;
      console.log(`  pass ${i + 1}: ${reps} replacement(s)   Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`);
    }
  }

  // ── Attempts ──
  console.log(`\n── Attempts (${s.attempts.length}) ──`);
  const rows = s.attempts.map((a) => ({
    '#': a.attempt,
    score: a.compositeScore.toFixed(2),
    unfilled: a.unfilled,
    feas: a.feasible ? '✓' : '',
    imp: a.improved ? '★' : '',
    iters: a.iterations,
    ms: a.durationMs,
    minRest: a.score.minRestHours.toFixed(1),
    restStd: a.score.restStdDev.toFixed(2),
    l0Std: a.score.l0StdDev.toFixed(2),
    srStd: a.score.seniorStdDev.toFixed(2),
    dayPP: a.score.dailyPerParticipantStdDev.toFixed(2),
    dayGl: a.score.dailyGlobalStdDev.toFixed(2),
    restGap: a.score.restPerGapBonus.toFixed(1),
    lowPri: a.score.lowPriorityPenalty.toFixed(1),
    notWith: a.score.notWithPenalty.toFixed(1),
    taskPref: a.score.taskPrefPenalty.toFixed(1),
    penalty: a.score.totalPenalty.toFixed(1),
  }));
  console.table(rows);

  // ── Rejections (verbose only) ──
  console.log('\n── Rejections ──');
  if (!s.rejections.captured) {
    console.log("  (none captured — verbose mode only. Run toggleSchedulerDiag('verbose') and regenerate.)");
  } else {
    console.log('  By HC code:');
    console.table(sortDescAsRecord(s.rejections.byCode));
    console.log('  By task (top 20):');
    console.table(sortDescAsRecord(s.rejections.byTask));
    console.log('  By participant (top 20):');
    console.table(sortDescAsRecord(s.rejections.byParticipant));
  }

  console.log('═══════════════════════════════════════════════\n');
}

// ─── globalThis registration (browser console + Node REPL) ──────────────────

if (typeof globalThis !== 'undefined') {
  const g = globalThis as Record<string, unknown>;
  g.toggleSchedulerDiag = toggleSchedulerDiag;
}
