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
  /** Composite score after greedy phase, before SA. */
  postGreedyComposite: number;
  /** Composite score at SA loop exit, before polish. */
  postSAComposite: number;
  /** Best composite seen across all attempts up to and including this one. */
  bestSoFarComposite: number;
  /** 8-char hex FNV-1a fingerprint of the assignment vector. */
  solutionHash: string;
  /** Polish passes consumed by this attempt. */
  polishPassesThisAttempt: number;
  /** Sum of polish deltas across this attempt's polish passes. */
  polishDeltaThisAttempt: number;
  /** Flat numeric copy of ScheduleScore — no object refs. */
  score: {
    minRestHours: number;
    avgRestHours: number;
    workloadStdDev: number;
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

/** A single greedy-phase unfilled-slot capture. One attempt may emit multiple. */
export interface GreedyFailureRow {
  attempt: number;
  taskId: string;
  taskName: string;
  slotId: string;
  slotLabel: string;
  reason: string;
  hcCodes?: string[];
}

/** A single notWith violation captured during the final score pass of an attempt. */
export interface NotWithViolationRow {
  attempt: number;
  /** Participant IDs (sorted lexicographically so {A,B} and {B,A} share an entry). */
  a: string;
  b: string;
  taskId: string;
  taskName: string;
}

/** A single (iter, temperature) sample taken during the SA loop. */
export interface SATempSample {
  iter: number;
  temp: number;
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
    /** SA-loop neighbour proposals attempted (one per iteration). */
    proposalAttempts: number;
    /** SA-loop neighbour proposals that yielded an HC-feasible candidate. */
    proposalsFound: number;
    /** Periodic (iter, temp) samples taken during the SA loop. */
    tempSamples: SATempSample[];
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
    /** True when at least one rejection was captured. */
    captured: boolean;
  };
  /** Greedy-phase unfilled-slot captures across all attempts. */
  greedyFailures: GreedyFailureRow[];
  /** notWith violations seen on the *final* assignment of each attempt. */
  notWithViolations: NotWithViolationRow[];
  /** True iff at least one multi-attempt run completed under this snapshot. */
  finalized: boolean;
}

// ─── Module state ────────────────────────────────────────────────────────────

let _mode: DiagMode = 'off';
let _snapshot: DiagSnapshot | null = null;

/** Cursor: index of the attempt currently being executed. Read by
 *  recordNotWithViolation so the soft-constraints scorer doesn't need
 *  to know about attempt indices. Reset on resetSnapshot(). */
let _currentAttemptIndex = 0;

/** Gate flag: true only while the *final* score pass of an attempt is running.
 *  notWith captures fire only when this is true, suppressing the millions of
 *  transient mid-SA score evaluations that would otherwise pollute the data. */
let _capturingFinal = false;

/** Cursor: number of polish passes already attributed to prior attempts.
 *  Used by `consumePolishProgressForAttempt` to compute per-attempt totals
 *  via snapshot diff (zero changes to polish loop). */
let _lastPolishPassCount = 0;

/** SA proposal-rejection sampling rate. 1 = capture every event; raise to
 *  reduce overhead at the cost of histogram precision. Calibrated empirically:
 *  on a default 60-attempt run the rejection event count is ~6M per attempt,
 *  and 3 Map.set calls per event made the on-mode run ~6× slower than off-mode.
 *  Sampling 1-in-100 cuts that overhead by ~100× while leaving ample resolution
 *  for "which HC dominates" — each bucket still gets thousands of samples per
 *  run. Bump back to 1 only for a focused diagnostic where exact counts matter. */
const RECORD_REJECTION_SAMPLE_RATE = 100;
let _rejectionEventCounter = 0;

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
      proposalAttempts: 0,
      proposalsFound: 0,
      tempSamples: [],
    },
    polish: { passes: 0, replacementsPerPass: [], deltaPerPass: [] },
    attempts: [],
    rejections: {
      byCode: new Map(),
      byTask: new Map(),
      byParticipant: new Map(),
      captured: false,
    },
    greedyFailures: [],
    notWithViolations: [],
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
  _currentAttemptIndex = 0;
  _capturingFinal = false;
  _lastPolishPassCount = 0;
  _rejectionEventCounter = 0;
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
  proposalAttempts: number;
  proposalsFound: number;
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
  sa.proposalAttempts += stats.proposalAttempts;
  sa.proposalsFound += stats.proposalsFound;
}

/** Capture an (iter, temperature) sample from inside the SA loop. The caller
 *  decides the sampling cadence; this recorder just stores. */
export function recordSATempSample(iter: number, temp: number): void {
  if (_mode === 'off' || !_snapshot) return;
  _snapshot.sa.tempSamples.push({ iter, temp });
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
  // Optional sampling: skip Map writes for (N-1)/N events to bound overhead on
  // very hot SA loops. Sample-rate=1 is the default (capture all).
  if (RECORD_REJECTION_SAMPLE_RATE > 1 && _rejectionEventCounter++ % RECORD_REJECTION_SAMPLE_RATE !== 0) return;
  const r = _snapshot.rejections;
  r.byCode.set(code, (r.byCode.get(code) ?? 0) + 1);
  r.byTask.set(taskId, (r.byTask.get(taskId) ?? 0) + 1);
  r.byParticipant.set(participantId, (r.byParticipant.get(participantId) ?? 0) + 1);
  r.captured = true;
}

/** Record a notWith pair co-assigned to the same togetherness group on a final
 *  schedule. Caller MUST gate via `_capturingFinal` (see setCapturingFinal); this
 *  recorder also enforces the gate so the soft-constraints scorer doesn't have
 *  to. The attempt index is read from the module-local cursor. */
export function recordNotWithViolation(a: string, b: string, taskId: string, taskName: string): void {
  if (_mode === 'off' || !_snapshot || !_capturingFinal) return;
  // Sort the pair so {Alice, Bob} and {Bob, Alice} don't appear as two rows.
  const [x, y] = a < b ? [a, b] : [b, a];
  _snapshot.notWithViolations.push({
    attempt: _currentAttemptIndex,
    a: x,
    b: y,
    taskId,
    taskName,
  });
}

/** Record one or more greedy-phase unfilled slots from a single attempt.
 *  Called by the multi-attempt loop only when failures occurred. */
export function recordGreedyFailures(
  attempt: number,
  failures: Array<{
    taskId: string;
    taskName: string;
    slotId: string;
    slotLabel: string;
    reason: string;
    hcCodes?: string[];
  }>,
): void {
  if (_mode === 'off' || !_snapshot || failures.length === 0) return;
  for (const f of failures) {
    _snapshot.greedyFailures.push({
      attempt,
      taskId: f.taskId,
      taskName: f.taskName,
      slotId: f.slotId,
      slotLabel: f.slotLabel,
      reason: f.reason,
      hcCodes: f.hcCodes,
    });
  }
}

// ─── Cursor setters (module-local state, gated) ─────────────────────────────

/** Set the current attempt index. Called by the multi-attempt loop before each
 *  attempt so capture sites that don't have the index in scope (notably
 *  soft-constraints scoring) can tag their captures. */
export function setCurrentAttemptIndex(i: number): void {
  if (_mode === 'off') return;
  _currentAttemptIndex = i;
}

/** Mark the start/end of the *final* score pass of an attempt. Only while this
 *  is true does recordNotWithViolation fire — preventing pollution from the
 *  millions of transient mid-SA score evaluations. */
export function setCapturingFinal(flag: boolean): void {
  if (_mode === 'off') return;
  _capturingFinal = flag;
}

/** Compute and consume the polish progress (pass count + delta sum) since the
 *  previous call. The multi-attempt loop calls this once per attempt to attach
 *  per-attempt polish stats to AttemptRow. Off-mode returns zeros. */
export function consumePolishProgressForAttempt(): { passes: number; deltaSum: number } {
  if (_mode === 'off' || !_snapshot) return { passes: 0, deltaSum: 0 };
  const total = _snapshot.polish.passes;
  const start = _lastPolishPassCount;
  let deltaSum = 0;
  for (let k = start; k < total; k++) {
    deltaSum += _snapshot.polish.deltaPerPass[k] ?? 0;
  }
  _lastPolishPassCount = total;
  return { passes: total - start, deltaSum };
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

  // ── Score progression ──
  printScoreProgression(s.attempts);

  // ── Simulated annealing (extended with proposal-throughput + cooling) ──
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

  // Move generator throughput sub-block — exposes the "% of proposals that
  // reached scoring" gap, the headline diagnostic for HC-bound SA loops.
  if (sa.proposalAttempts > 0) {
    const rejectedAtHC = sa.proposalAttempts - sa.proposalsFound;
    console.log('  ── move generator throughput ──');
    console.log(`    proposals attempted:   ${sa.proposalAttempts.toLocaleString('en-US')}`);
    console.log(
      `    proposals reached scoring: ${sa.proposalsFound.toLocaleString('en-US')} (${fmtPct(sa.proposalsFound, sa.proposalAttempts)})`,
    );
    console.log(
      `    rejected at HC stage:  ${rejectedAtHC.toLocaleString('en-US')} (${fmtPct(rejectedAtHC, sa.proposalAttempts)})`,
    );
  }

  // Cooling curve. Samples are captured every SA_TEMP_SAMPLE_INTERVAL outer
  // iterations of every attempt — each attempt's SA loop starts from iter=0
  // with the same initial temperature, so the captured array contains 60
  // interleaved cooling curves. Show only the first attempt's curve since the
  // schedule is identical by construction across attempts.
  if (sa.tempSamples.length > 0) {
    const firstAttempt = takeFirstAttemptSamples(sa.tempSamples);
    console.log(
      `  ── cooling curve (first attempt; ${sa.tempSamples.length.toLocaleString('en-US')} samples across ${s.attempts.length} attempt${s.attempts.length === 1 ? '' : 's'}) ──`,
    );
    const samples = downsampleTempCurve(firstAttempt, 12);
    for (const sample of samples) {
      console.log(
        `    iter ${sample.iter.toLocaleString('en-US').padStart(12, ' ')}    temp ${sample.temp.toFixed(3)}`,
      );
    }
  }

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

  // ── Solution diversity ──
  printSolutionDiversity(s.attempts);

  // ── Attempts: phase progression ──
  console.log(`\n── Attempts: phase progression (${s.attempts.length}) ──`);
  const phaseRows = s.attempts.map((a) => ({
    '#': a.attempt,
    postGreedy: a.postGreedyComposite.toFixed(2),
    postSA: a.postSAComposite.toFixed(2),
    final: a.compositeScore.toFixed(2),
    saΔ: (a.postSAComposite - a.postGreedyComposite).toFixed(2),
    polishΔ: a.polishDeltaThisAttempt.toFixed(2),
    polishN: a.polishPassesThisAttempt,
    bestSoFar: a.bestSoFarComposite.toFixed(2),
    hash: a.solutionHash,
  }));
  console.table(phaseRows);

  // ── Attempts: score components (existing table, unchanged column order) ──
  console.log(`\n── Attempts: score components (${s.attempts.length}) ──`);
  const rows = s.attempts.map((a) => ({
    '#': a.attempt,
    score: a.compositeScore.toFixed(2),
    unfilled: a.unfilled,
    feas: a.feasible ? '✓' : '',
    imp: a.improved ? '★' : '',
    iters: a.iterations,
    ms: a.durationMs,
    minRest: a.score.minRestHours.toFixed(1),
    restStd: a.score.workloadStdDev.toFixed(2),
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

  // ── notWith violations ──
  printNotWithViolations(s.notWithViolations, s.attempts.length);

  // ── Greedy choke points ──
  printGreedyChokePoints(s.greedyFailures, s.attempts.length);

  // ── Rejections deep-dive (now active in 'on' mode, not just 'verbose') ──
  console.log('\n── Rejections deep-dive ──');
  if (!s.rejections.captured) {
    console.log('  (none captured — no eligibility rejections were recorded)');
  } else {
    if (RECORD_REJECTION_SAMPLE_RATE > 1) {
      console.log(
        `  (sampled at 1-in-${RECORD_REJECTION_SAMPLE_RATE} — counts shown are the recorded sample, ratios are accurate)`,
      );
    }
    console.log('  By HC code:');
    console.table(sortDescAsRecord(s.rejections.byCode));
    console.log('  By task (top 20):');
    console.table(sortDescAsRecord(s.rejections.byTask));
    console.log('  By participant (top 20):');
    console.table(sortDescAsRecord(s.rejections.byParticipant));
  }

  console.log('═══════════════════════════════════════════════\n');
}

// ─── Sub-section helpers ────────────────────────────────────────────────────

function printScoreProgression(attempts: AttemptRow[]): void {
  console.log('\n── Score progression ──');
  if (attempts.length === 0) {
    console.log('  (no attempts recorded)');
    return;
  }
  // Find the attempt that produced the global best (last `improved` row).
  let bestAttempt = attempts[0];
  for (const a of attempts) {
    if (a.compositeScore > bestAttempt.compositeScore) bestAttempt = a;
  }
  const best = bestAttempt.compositeScore;
  console.log(`  best:           ${best.toFixed(2)}  (attempt ${bestAttempt.attempt} of ${attempts.length})`);

  if (attempts.length === 1) return; // No plateau / threshold counts on a 1-attempt run.

  // Plateau: count how many attempts after the best produced no improvement.
  const plateau = attempts.length - bestAttempt.attempt;
  if (plateau > 0) {
    console.log(`  plateau after:  ${plateau} attempt(s) with no improvement`);
  }

  // Threshold counts.
  const ge99 = attempts.filter((a) => a.compositeScore >= best * 0.99).length;
  const ge90 = attempts.filter((a) => a.compositeScore >= best * 0.9).length;
  console.log(`  attempts ≥99% of best:   ${ge99} / ${attempts.length}`);
  console.log(`  attempts ≥90% of best:   ${ge90} / ${attempts.length}`);
}

function printSolutionDiversity(attempts: AttemptRow[]): void {
  console.log('\n── Solution diversity ──');
  if (attempts.length === 0) {
    console.log('  (no attempts recorded)');
    return;
  }
  const distinct = new Set(attempts.map((a) => a.solutionHash));
  console.log(`  unique solutions:           ${distinct.size} / ${attempts.length}`);

  const zeroNotWith = attempts.filter((a) => a.score.notWithPenalty === 0);
  if (zeroNotWith.length > 0 && attempts.length > 1) {
    const zeroDistinct = new Set(zeroNotWith.map((a) => a.solutionHash));
    console.log(
      `  zero-notWith attempts:      ${zeroNotWith.length} / ${attempts.length}  (${zeroDistinct.size} unique solutions)`,
    );
  }
  if (distinct.size === 1 && attempts.length > 1) {
    console.log('  ⚠ all attempts produced an identical assignment — multi-attempt is producing duplicates');
  }
}

function printNotWithViolations(rows: NotWithViolationRow[], totalAttempts: number): void {
  console.log('\n── notWith violations ──');
  if (rows.length === 0) {
    console.log('  (none — no notWith pair was co-assigned in any final schedule)');
    return;
  }
  // Aggregate by (a, b, taskName) → set of attempts.
  const agg = new Map<string, { a: string; b: string; taskName: string; attempts: Set<number> }>();
  for (const r of rows) {
    const key = `${r.a}|${r.b}|${r.taskId}`;
    const entry = agg.get(key);
    if (entry) {
      entry.attempts.add(r.attempt);
    } else {
      agg.set(key, { a: r.a, b: r.b, taskName: r.taskName, attempts: new Set([r.attempt]) });
    }
  }
  const sorted = Array.from(agg.values()).sort((x, y) => y.attempts.size - x.attempts.size);
  for (const v of sorted) {
    console.log(`  (${v.a}, ${v.b})  on ${v.taskName}  in ${v.attempts.size} / ${totalAttempts} attempts`);
  }
}

function printGreedyChokePoints(rows: GreedyFailureRow[], totalAttempts: number): void {
  console.log('\n── Greedy choke points ──');
  if (rows.length === 0) {
    console.log('  (none — greedy filled every slot in every attempt)');
    return;
  }
  // Aggregate by (taskName, slotLabel) → { attempts, top reasons }.
  const agg = new Map<
    string,
    { taskName: string; slotLabel: string; attempts: Set<number>; reasons: Map<string, number> }
  >();
  for (const r of rows) {
    const key = `${r.taskName}|${r.slotLabel}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { taskName: r.taskName, slotLabel: r.slotLabel, attempts: new Set(), reasons: new Map() };
      agg.set(key, entry);
    }
    entry.attempts.add(r.attempt);
    entry.reasons.set(r.reason, (entry.reasons.get(r.reason) ?? 0) + 1);
  }
  const sorted = Array.from(agg.values()).sort((x, y) => y.attempts.size - x.attempts.size);
  for (const v of sorted) {
    const topReason = Array.from(v.reasons.entries()).sort((p, q) => q[1] - p[1])[0]?.[0] ?? '?';
    console.log(
      `  ${v.taskName} · ${v.slotLabel}:  ${v.attempts.size} / ${totalAttempts} attempts — top reason: "${topReason}"`,
    );
  }
}

/** Down-sample a temperature-sample list to at most `targetCount` evenly-spaced
 *  rows for display. Always keeps the first and last samples. */
function downsampleTempCurve(samples: SATempSample[], targetCount: number): SATempSample[] {
  if (samples.length <= targetCount) return samples;
  const result: SATempSample[] = [];
  const step = (samples.length - 1) / (targetCount - 1);
  for (let i = 0; i < targetCount; i++) {
    result.push(samples[Math.round(i * step)]);
  }
  return result;
}

/** Extract the first attempt's samples from an interleaved multi-attempt array.
 *  Attempt boundaries are detected by `iter` resetting to 0 (each attempt's SA
 *  loop starts a fresh iter counter). Returns the prefix up to (but excluding)
 *  the second iter=0 marker. */
function takeFirstAttemptSamples(samples: SATempSample[]): SATempSample[] {
  if (samples.length === 0) return samples;
  // The first sample is iter=0 by construction. Stop at the next iter=0.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].iter === 0) return samples.slice(0, i);
  }
  return samples;
}

// ─── globalThis registration (browser console + Node REPL) ──────────────────

if (typeof globalThis !== 'undefined') {
  const g = globalThis as Record<string, unknown>;
  g.toggleSchedulerDiag = toggleSchedulerDiag;
}
