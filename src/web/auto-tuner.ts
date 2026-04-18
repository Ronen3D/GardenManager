/**
 * Auto-Tuning Meta-Layer — Staged Tournament (Successive Halving).
 *
 * Given the live dataset, finds a `SchedulerConfig` that performs best
 * for that dataset specifically. Strategy:
 *
 *   Phase 0  Dataset fingerprint — prune irrelevant dims, shape ranges,
 *            populate the overlay summary so the wait feels contextual.
 *   Phase 1  Seed population via Latin Hypercube over log-scaled ranges
 *            (+ pinned current, minimalist, rigid anchors).
 *   Phase 2  Cheap culling round (reduced attempts/iterations) — keep ~30%.
 *   Phase 3  Mid-fidelity round, 2 evaluations per candidate, median-ranked;
 *            top-3 also probed with single-weight ±1 step perturbations.
 *   Phase 4  Stability arena — full quality, 5 independent runs per survivor,
 *            ranked by  median − λ·IQR − μ·unfilled. Infeasible runs
 *            disqualify.
 *   Phase 5  Verify winner vs. pinned current settings on fresh independent
 *            runs. If no material improvement → refuse to recommend.
 *
 * The tuner never mutates engine/constraint code (per the plan) and never
 * writes the user's settings directly — it returns a recommendation the
 * user explicitly applies.
 */

import { computeScheduleScore } from '../constraints/soft-constraints';
import { SchedulingEngine } from '../engine/scheduler';
import { DEFAULT_CONFIG, type Participant, type Schedule, type SchedulerConfig, type Task } from '../models/types';
import { computeRankScore, iqr, latinHypercubeSample, maxUnfilledIn, median, mulberry32 } from '../utils/tuner-math';
import * as store from './config-store';
import { escHtml, getStoredDefaultAttempts } from './ui-helpers';

// ═══════════════════════════════════════════════════════════════════════════
//  Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface TuneRecommendation {
  /** The suggested scheduler config (full, not a patch). */
  config: SchedulerConfig;
  /** Median composite score of the winner across Phase 5 seeds. */
  winnerMedian: number;
  /** IQR of the winner's composite score across Phase 5 seeds. */
  winnerIQR: number;
  /** Median composite score of the current settings across the same seeds. */
  baselineMedian: number;
  /** IQR of the current settings across Phase 5 seeds. */
  baselineIQR: number;
  /** Delta in median score: winner − baseline. Positive ⇒ winner is better. */
  medianDelta: number;
  /** True ⇒ we recommend applying; false ⇒ current settings are competitive. */
  recommend: boolean;
  /** Short Hebrew explanation of the decision. */
  reason: string;
  /** Fingerprint summary shown to the user. */
  fingerprintSummary: string;
  /** Per-dim diff: { key, baseline, tuned }. */
  diff: Array<{ key: keyof SchedulerConfig; baseline: number; tuned: number }>;
  /** Wall-clock duration of the run (ms). */
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Runtime state
// ═══════════════════════════════════════════════════════════════════════════

type TunerPhase = 0 | 1 | 2 | 3 | 4 | 5 | -1; // -1 = done / idle

interface CandidateView {
  id: number;
  /** Median composite score seen so far across evaluations (Phase 3+). */
  median: number | null;
  /** Number of evaluations completed for this candidate. */
  evals: number;
  /** Any unfilled slots in any eval? Disqualifies in Phase 4. */
  anyInfeasible: boolean;
}

interface TuneState {
  phase: TunerPhase;
  /** Human-readable phase label (Hebrew). */
  phaseLabel: string;
  /** Total evaluations planned for current phase. */
  phaseTotal: number;
  /** Evaluations completed in current phase. */
  phaseDone: number;
  /** Fingerprint summary HTML line. */
  fingerprintSummary: string;
  /** Current leading candidate (by its best-known median). */
  leader: CandidateView | null;
  /** Rolling best known median so far. */
  bestMedian: number | null;
  /** Rolling best known unfilled count. */
  bestUnfilled: number;
  /** Set true by `cancelAutoTune()`; evaluations check between candidates. */
  canceled: boolean;
  /** Start wall time. */
  startMs: number;
  /** Last phase for which the bracket DOM was rendered. Avoids innerHTML
   * churn on every eval — that would reset CSS animations. */
  lastRenderedPhase: TunerPhase | null;
  /** Human-readable diff of the leading candidate vs. current settings,
   * rendered below the metrics. Null until a non-`current` leader emerges. */
  leaderDiffLabel: string | null;
  /** Set true by `observeCandidate` when a new best is found. The next
   * `updateOverlay` consumes it to retrigger the score-pulse animation, then
   * clears it — preserving single-fire pulse semantics. */
  bestImproved: boolean;
}

let _state: TuneState | null = null;
let _isTuning = false;

export function isAutoTuning(): boolean {
  return _isTuning;
}

export function cancelAutoTune(): void {
  if (!_state || _state.canceled) return;
  _state.canceled = true;
  // Replace the phase label with an acknowledgement so the user sees the
  // cancel was accepted even while the current evaluation finishes running.
  _state.phaseLabel = 'מבטל… ההערכה הנוכחית תסתיים מיד';
  updateOverlay();
}

// ═══════════════════════════════════════════════════════════════════════════
//  Search space definition
// ═══════════════════════════════════════════════════════════════════════════

type TunedKey =
  | 'minRestWeight'
  | 'l0FairnessWeight'
  | 'seniorFairnessWeight'
  | 'lowPriorityLevelPenalty'
  | 'dailyBalanceWeight'
  | 'notWithPenalty'
  | 'taskNamePreferencePenalty'
  | 'taskNameAvoidancePenalty'
  | 'taskNamePreferenceBonus';

interface Dim {
  key: TunedKey;
  /** Inclusive min of the log-scaled sampling range. */
  min: number;
  /** Inclusive max of the log-scaled sampling range. */
  max: number;
  /** Sample and round as an integer? (Most fields are effectively integer in UX.) */
  integer: boolean;
}

const BASE_DIMS: Dim[] = [
  { key: 'minRestWeight', min: 1, max: 200, integer: true },
  { key: 'l0FairnessWeight', min: 1, max: 500, integer: true },
  { key: 'seniorFairnessWeight', min: 1, max: 200, integer: true },
  { key: 'lowPriorityLevelPenalty', min: 50, max: 20000, integer: true },
  { key: 'dailyBalanceWeight', min: 1, max: 500, integer: true },
  { key: 'notWithPenalty', min: 10, max: 20000, integer: true },
  { key: 'taskNamePreferencePenalty', min: 1, max: 1000, integer: true },
  { key: 'taskNameAvoidancePenalty', min: 1, max: 1000, integer: true },
  { key: 'taskNamePreferenceBonus', min: 1, max: 500, integer: true },
];

// ═══════════════════════════════════════════════════════════════════════════
//  Phase 0 — dataset fingerprint
// ═══════════════════════════════════════════════════════════════════════════

interface Fingerprint {
  participantCount: number;
  levelCounts: Record<string, number>;
  notWithPairCount: number;
  preferenceCount: number; // participants with any task-name preference
  lowPrioritySlotCount: number;
  /** The dims we actually search over (pruned). */
  activeDims: Dim[];
  summaryHebrew: string;
}

function buildFingerprint(participants: Participant[], tasks: Task[]): Fingerprint {
  const levelCounts: Record<string, number> = {};
  let notWithPairCount = 0;
  let preferenceCount = 0;
  const seenPairs = new Set<string>();

  for (const p of participants) {
    levelCounts[`L${p.level}`] = (levelCounts[`L${p.level}`] ?? 0) + 1;
    if (p.preferredTaskName || p.lessPreferredTaskName) preferenceCount++;
    for (const other of p.notWithIds ?? []) {
      const key = p.id < other ? `${p.id}|${other}` : `${other}|${p.id}`;
      if (!seenPairs.has(key)) {
        seenPairs.add(key);
        notWithPairCount++;
      }
    }
  }

  let lowPrioritySlotCount = 0;
  for (const t of tasks) {
    for (const s of t.slots) {
      if (s.acceptableLevels.some((e) => e.lowPriority)) lowPrioritySlotCount++;
    }
  }

  const seniorCount = (levelCounts.L2 ?? 0) + (levelCounts.L3 ?? 0) + (levelCounts.L4 ?? 0);

  // Prune irrelevant dims: a dim whose penalty/bonus can never fire is held
  // constant at the current user value (we treat it as "not part of search").
  const activeDims: Dim[] = [];
  for (const d of BASE_DIMS) {
    if (d.key === 'notWithPenalty' && notWithPairCount === 0) continue;
    if (
      (d.key === 'taskNamePreferencePenalty' ||
        d.key === 'taskNameAvoidancePenalty' ||
        d.key === 'taskNamePreferenceBonus') &&
      preferenceCount === 0
    )
      continue;
    if (d.key === 'lowPriorityLevelPenalty' && lowPrioritySlotCount === 0) continue;
    if (d.key === 'seniorFairnessWeight' && seniorCount === 0) continue;

    // Shape ranges based on dataset density
    const shaped: Dim = { ...d };
    if (d.key === 'taskNamePreferencePenalty' || d.key === 'taskNameAvoidancePenalty') {
      const density = preferenceCount / Math.max(1, participants.length);
      if (density < 0.2) shaped.max = Math.max(d.min + 1, Math.round(d.max * 0.3));
    }
    activeDims.push(shaped);
  }

  const parts: string[] = [`${participants.length} משתתפים`];
  if (seniorCount > 0) parts.push(`${seniorCount} סגל`);
  if (notWithPairCount > 0) parts.push(`${notWithPairCount} זוגות "אי התאמה"`);
  if (preferenceCount > 0) parts.push(`${preferenceCount} העדפות משימה`);
  parts.push(`${tasks.length} משימות`);
  const summaryHebrew = parts.join(' · ');

  return {
    participantCount: participants.length,
    levelCounts,
    notWithPairCount,
    preferenceCount,
    lowPrioritySlotCount,
    activeDims,
    summaryHebrew,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Evaluation — run a full multi-attempt scheduling with candidate weights
// ═══════════════════════════════════════════════════════════════════════════

interface EvalResult {
  /**
   * Weight-independent score: schedule re-scored under `DEFAULT_CONFIG` so
   * candidates with different weights are on the same scale. This is the
   * only score used for ranking across candidates.
   */
  refScore: number;
  unfilled: number;
  feasible: boolean;
  wallMs: number;
}

interface EvalParams {
  participants: Participant[];
  tasks: Task[];
  config: SchedulerConfig;
  attempts: number;
  maxIterations: number;
  baseAttempts: number;
  frozen: FrozenEnv;
}

/** Engine inputs captured once per tuning run so all evaluations see the same world. */
interface FrozenEnv {
  dayStart: number;
  disabledHC: ReturnType<typeof store.getDisabledHCSet>;
  restRuleMap: ReturnType<typeof store.buildRestRuleMap>;
  /** notWithPairs required for the reference-score SC-9 term. */
  notWithPairs: Map<string, Set<string>>;
  taskMap: Map<string, Task>;
  pMap: Map<string, Participant>;
}

function freezeEnv(participants: Participant[], tasks: Task[]): FrozenEnv {
  const notWithPairs = new Map<string, Set<string>>();
  for (const p of participants) {
    if (p.notWithIds && p.notWithIds.length > 0) {
      notWithPairs.set(p.id, new Set(p.notWithIds));
    }
  }
  return {
    dayStart: store.getDayStartHour(),
    disabledHC: store.getDisabledHCSet(),
    restRuleMap: store.buildRestRuleMap(),
    notWithPairs,
    taskMap: new Map(tasks.map((t) => [t.id, t])),
    pMap: new Map(participants.map((p) => [p.id, p])),
  };
}

async function evaluate(params: EvalParams): Promise<EvalResult> {
  const start = performance.now();
  const { dayStart, disabledHC, restRuleMap, notWithPairs } = params.frozen;

  // Scale maxIterations/maxSolverTimeMs into the config copy so cheap stages
  // truly run cheaper. Scaling ratio is derived from the live baseline so it
  // stays correct regardless of the user's attempts count.
  const solverRatio = Math.max(0.1, Math.min(1, params.attempts / Math.max(1, params.baseAttempts)));
  const scaledConfig: SchedulerConfig = {
    ...params.config,
    maxIterations: params.maxIterations,
    maxSolverTimeMs: Math.max(1500, Math.round(params.config.maxSolverTimeMs * solverRatio)),
  };

  const engine = new SchedulingEngine(scaledConfig, disabledHC, restRuleMap, dayStart);
  engine.addParticipants(params.participants);
  engine.addTasks(params.tasks);

  let schedule: Schedule;
  try {
    schedule = await engine.generateScheduleAsync(params.attempts);
  } catch (_err) {
    // A scheduling failure during tuning is treated as a maximally-infeasible
    // evaluation: strongly discouraged, but doesn't abort the tournament.
    return { refScore: -1e18, unfilled: 9999, feasible: false, wallMs: performance.now() - start };
  }

  const unfilled = schedule.violations.filter((v) => v.code === 'INFEASIBLE_SLOT').length;

  // Re-score the produced schedule under a fixed reference config so results
  // from different candidate weight vectors are directly comparable. Without
  // this, candidates that inflate positive terms or shrink penalties would
  // "win" on their own yardstick, not on schedule quality.
  const refScoreObj = computeScheduleScore(params.tasks, params.participants, schedule.assignments, DEFAULT_CONFIG, {
    taskMap: params.frozen.taskMap,
    pMap: params.frozen.pMap,
    notWithPairs,
    dayStartHour: dayStart,
  });

  return {
    refScore: refScoreObj.compositeScore,
    unfilled,
    feasible: unfilled === 0,
    wallMs: performance.now() - start,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Candidate = full SchedulerConfig + per-run score history
// ═══════════════════════════════════════════════════════════════════════════

interface Candidate {
  id: number;
  label: string; // 'current' | 'floor' | 'ceiling' | 'lhs-12' etc.
  config: SchedulerConfig;
  results: EvalResult[];
}

function makeCandidateFromVector(
  id: number,
  label: string,
  baseConfig: SchedulerConfig,
  dims: Dim[],
  vector: number[],
): Candidate {
  const config: SchedulerConfig = { ...baseConfig };
  for (let i = 0; i < dims.length; i++) {
    (config as unknown as Record<string, number>)[dims[i].key] = vector[i];
  }
  return { id, label, config, results: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Aggregation — median / IQR / ranking   (pure helpers in utils/tuner-math)
// ═══════════════════════════════════════════════════════════════════════════

function maxUnfilled(results: EvalResult[]): number {
  return maxUnfilledIn(results);
}

/**
 * Stability-aware rank score (higher is better).
 * Infeasible seeds are penalised via μ; Phase 4 also applies a hard disqualify.
 * λ=0.5 / μ=10000 — unfilled slots dominate any typical IQR gain.
 */
function rankScore(results: EvalResult[]): number {
  return computeRankScore(results, 0.5, 10000);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overlay UI (surgical DOM updates — bypasses renderAll)
// ═══════════════════════════════════════════════════════════════════════════

function ensureOverlay(): void {
  let overlay = document.getElementById('tune-overlay');
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'tune-overlay';
  overlay.className = 'optim-overlay';
  overlay.innerHTML = renderOverlayHtml();
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('[data-action="tune-cancel"]');
    if (btn) cancelAutoTune();
  });
}

function removeOverlay(): void {
  const overlay = document.getElementById('tune-overlay');
  overlay?.remove();
}

function renderOverlayHtml(): string {
  return `
  <div class="optim-card tune-card tune-card-breathing" role="dialog" aria-label="כיול אוטומטי">
    <div class="tune-particles" aria-hidden="true">
      <span class="tune-bubble"></span>
      <span class="tune-bubble"></span>
      <span class="tune-bubble"></span>
      <span class="tune-bubble"></span>
      <span class="tune-bubble"></span>
      <span class="tune-bubble"></span>
    </div>
    <h3 id="tune-title">כיול הגדרות עבור הנתונים שלך…</h3>
    <div class="tune-fingerprint" id="tune-fingerprint"></div>
    <div class="tune-phase-label" id="tune-phase-label"></div>
    <div class="optim-progress-bar">
      <div class="optim-progress-fill" id="tune-phase-fill" style="width:0%"></div>
    </div>
    <div class="optim-status" id="tune-phase-status"></div>
    <div class="tune-bracket" id="tune-bracket"></div>
    <div class="optim-metrics tune-metrics" aria-live="polite" aria-atomic="false">
      <div class="optim-metric">
        <span class="optim-metric-label">הציון הטוב ביותר</span>
        <span class="optim-metric-value" id="tune-best-score">—</span>
      </div>
      <div class="optim-metric" id="tune-unfilled-metric" style="display:none">
        <span class="optim-metric-label">משבצות לא מאוישות</span>
        <span class="optim-metric-value" id="tune-best-unfilled">0</span>
      </div>
    </div>
    <div class="tune-leader-diff" id="tune-leader-diff" aria-live="polite"></div>
    <div class="tune-elapsed" id="tune-elapsed"></div>
    <div class="tune-actions">
      <button class="btn-sm btn-outline" data-action="tune-cancel">ביטול</button>
    </div>
  </div>`;
}

function updateOverlay(): void {
  if (!_state) return;
  ensureOverlay();
  const s = _state;

  const fp = document.getElementById('tune-fingerprint');
  if (fp) fp.textContent = s.fingerprintSummary;

  const label = document.getElementById('tune-phase-label');
  if (label) label.textContent = s.phaseLabel;

  const fill = document.getElementById('tune-phase-fill') as HTMLElement | null;
  if (fill) {
    const pct = s.phaseTotal > 0 ? Math.round((s.phaseDone / s.phaseTotal) * 100) : 0;
    fill.style.width = `${pct}%`;
  }

  const status = document.getElementById('tune-phase-status');
  if (status) status.textContent = `${s.phaseDone} / ${s.phaseTotal}`;

  const best = document.getElementById('tune-best-score');
  if (best) {
    best.textContent = s.bestMedian == null ? '—' : s.bestMedian.toFixed(1);
    // Retrigger the pulse animation only when a new best was actually found.
    // Remove + force-reflow + add is the standard way to restart a CSS keyframe.
    if (s.bestImproved) {
      best.classList.remove('tune-score-pulse');
      void best.offsetWidth;
      best.classList.add('tune-score-pulse');
      s.bestImproved = false;
    }
  }

  const unMetric = document.getElementById('tune-unfilled-metric');
  if (unMetric) {
    const show = s.bestMedian != null && s.bestUnfilled > 0;
    unMetric.style.display = show ? '' : 'none';
    if (show) {
      const un = document.getElementById('tune-best-unfilled');
      if (un) {
        un.textContent = String(s.bestUnfilled);
        un.className = 'optim-metric-value optim-warn';
      }
    }
  }

  const elapsed = document.getElementById('tune-elapsed');
  if (elapsed) elapsed.textContent = formatElapsed(performance.now() - s.startMs);

  const diff = document.getElementById('tune-leader-diff');
  if (diff) diff.textContent = s.leaderDiffLabel ?? '';

  // Rebuild the bracket only when the phase actually changes. Otherwise
  // innerHTML churn would restart the `tune-bracket-pulse` animation on
  // every eval (~1-3s), producing a visible stutter.
  if (s.lastRenderedPhase !== s.phase) {
    const bracket = document.getElementById('tune-bracket');
    if (bracket) bracket.innerHTML = renderBracketHtml(s);
    s.lastRenderedPhase = s.phase;
  }
}

/** Human-readable wall time since tuning started. Updated every overlay paint. */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `חלפו ${totalSec} שנ'`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (seconds === 0) return `חלפו ${minutes} דק'`;
  return `חלפו ${minutes}:${String(seconds).padStart(2, '0')} דק'`;
}

function renderBracketHtml(s: TuneState): string {
  const labels = ['סקירה', 'דגימה', 'ניפוי', 'סינון', 'יציבות', 'אימות'];
  const segs: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const active = s.phase === i;
    const done = s.phase === -1 || s.phase > i;
    const cls = ['tune-bracket-seg'];
    if (active) cls.push('tune-bracket-active');
    if (done) cls.push('tune-bracket-done');
    // Two stacked glyphs — a 1-based index and a checkmark. CSS crossfades
    // between them when `.tune-bracket-done` is applied, instead of a
    // text-content swap (which can't be animated). The bracket is rebuilt
    // only on phase change (see updateOverlay), so each phase transition
    // triggers a single fresh animation.
    segs.push(
      `<div class="${cls.join(' ')}">` +
        `<span class="tune-bracket-num">` +
        `<span class="tune-bracket-num-pending">${i + 1}</span>` +
        `<span class="tune-bracket-num-check" aria-hidden="true">✓</span>` +
        `</span>` +
        `<span class="tune-bracket-label">${escHtml(labels[i])}</span>` +
        `</div>`,
    );
  }
  return segs.join('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Orchestrator
// ═══════════════════════════════════════════════════════════════════════════

function newState(): TuneState {
  return {
    phase: 0,
    phaseLabel: 'סקירת הנתונים שלך',
    phaseTotal: 0,
    phaseDone: 0,
    fingerprintSummary: '',
    leader: null,
    bestMedian: null,
    bestUnfilled: 0,
    canceled: false,
    startMs: performance.now(),
    lastRenderedPhase: null,
    leaderDiffLabel: null,
    bestImproved: false,
  };
}

function setPhase(phase: TunerPhase, label: string, total: number): void {
  if (!_state) return;
  _state.phase = phase;
  _state.phaseLabel = label;
  _state.phaseTotal = total;
  _state.phaseDone = 0;
  // Reset the peak-tracker so the "leading score" panel reflects only
  // candidates actually alive in the current phase — otherwise it would
  // keep displaying a number from an eliminated Phase 2/3 candidate.
  _state.bestMedian = null;
  _state.bestUnfilled = 0;
  _state.leader = null;
  _state.leaderDiffLabel = null;
}

function recordEval(_result: EvalResult): void {
  if (!_state) return;
  _state.phaseDone++;
}

/**
 * Baseline config used when computing the "leader vs current" diff preview
 * rendered live in the overlay. Set once per tuning run from the pinned
 * `current` candidate. Kept at module scope because `observeCandidate` is a
 * hot path and threading this through every call site would add noise.
 */
let _leaderDiffBaseline: SchedulerConfig | null = null;
let _leaderDiffDims: Dim[] | null = null;

/** Hebrew labels for weight keys — used in the live leader-diff preview.
 * Duplicates the map in `app.ts#formatWeightKey` so the auto-tuner module
 * stays free of a reverse dependency back to the app layer. */
const TUNED_LABELS: Record<string, string> = {
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

/** Pick the weight with the largest log-space change vs. baseline — this
 * surfaces the dimension the tuner is leaning on hardest, not the one that
 * happens to have the largest absolute number. Returns null if nothing
 * differs. */
function computeLeaderDiffLabel(leader: SchedulerConfig): string | null {
  if (!_leaderDiffBaseline || !_leaderDiffDims) return null;
  let best: { key: string; baseline: number; tuned: number; mag: number } | null = null;
  for (const d of _leaderDiffDims) {
    const baseline = (_leaderDiffBaseline as unknown as Record<string, number>)[d.key];
    const tuned = (leader as unknown as Record<string, number>)[d.key];
    if (baseline === tuned) continue;
    const mag = Math.abs(Math.log(Math.max(1, tuned)) - Math.log(Math.max(1, baseline)));
    if (!best || mag > best.mag) best = { key: d.key, baseline, tuned, mag };
  }
  if (!best) return null;
  const label = TUNED_LABELS[best.key] ?? best.key;
  return `המוביל: ${label} ${best.baseline} → ${best.tuned}`;
}

function observeCandidate(c: Candidate): void {
  if (!_state) return;
  if (c.results.length === 0) return;
  const med = median(c.results.map((r) => r.refScore));
  const unf = maxUnfilled(c.results);
  if (_state.bestMedian == null || med > _state.bestMedian) {
    _state.bestMedian = med;
    _state.bestUnfilled = unf;
    _state.bestImproved = true;
    _state.leader = {
      id: c.id,
      median: med,
      evals: c.results.length,
      anyInfeasible: c.results.some((r) => !r.feasible),
    };
    _state.leaderDiffLabel = computeLeaderDiffLabel(c.config);
  }
}

/**
 * Yield to the event loop so the overlay can repaint and click events fire.
 * Mirrors the pattern in `optimizeMultiAttemptAsync`.
 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runAutoTune(): Promise<TuneRecommendation | null> {
  if (_isTuning) return null;
  _isTuning = true;
  _state = newState();
  // Reset module-local leader-diff context — a prior canceled run may have
  // left stale values that would otherwise leak into the next run's preview.
  _leaderDiffBaseline = null;
  _leaderDiffDims = null;

  const participants = store.getAllParticipants();
  if (participants.length === 0) {
    _isTuning = false;
    _state = null;
    throw new Error('אין משתתפים — הוסף משתתפים לפני כיול אוטומטי.');
  }

  // Resolve tasks via the app-layer template-expansion by letting the caller
  // provide them. To avoid circular imports with app.ts, we re-build the
  // engine exactly like doGenerate() does by reading the live store via a
  // thin helper the caller injects. See `setTaskFactory` below.
  if (!_taskFactory) {
    _isTuning = false;
    _state = null;
    throw new Error('auto-tuner: task factory not initialised — call setTaskFactory() at startup.');
  }
  const tasks = _taskFactory();
  if (tasks.length === 0) {
    _isTuning = false;
    _state = null;
    throw new Error('אין משימות — הוסף תבניות משימה לפני כיול אוטומטי.');
  }

  try {
    return await runTournament(participants, tasks);
  } finally {
    _isTuning = false;
    _state = null;
    removeOverlay();
  }
}

// Task factory injection — avoids circular import with app.ts.
let _taskFactory: (() => Task[]) | null = null;
export function setAutoTunerTaskFactory(fn: () => Task[]): void {
  _taskFactory = fn;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Tournament body
// ═══════════════════════════════════════════════════════════════════════════

/** Baseline attempts count used for Phase 4/5 (full quality). */
function getBaselineAttempts(): number {
  const n = getStoredDefaultAttempts();
  return Number.isFinite(n) && n > 0 ? n : 100;
}

async function runTournament(participants: Participant[], tasks: Task[]): Promise<TuneRecommendation | null> {
  if (!_state) throw new Error('auto-tuner: internal state missing (should not happen).');
  const s = _state;

  // ── Phase 0 ────────────────────────────────────────────────────────────
  setPhase(0, 'סקירת הנתונים שלך', 1);
  const fp = buildFingerprint(participants, tasks);
  s.fingerprintSummary = fp.summaryHebrew;
  ensureOverlay();
  updateOverlay();
  await yieldToUi();
  s.phaseDone = 1;
  if (s.canceled) return null;

  // Freeze engine inputs once so every evaluation in this run sees the same
  // world — participants/tasks were already captured in runAutoTune(), and
  // this extends the freeze to disabledHC/dayStart/restRuleMap.
  const frozen = freezeEnv(participants, tasks);

  const baseAttempts = getBaselineAttempts();
  const baseIter = DEFAULT_CONFIG.maxIterations;
  const mkEval = (config: SchedulerConfig, attempts: number, maxIterations: number): EvalParams => ({
    participants,
    tasks,
    config,
    attempts,
    maxIterations,
    baseAttempts,
    frozen,
  });

  // Per-phase cost profile (attempts × maxIterations). The baselines below
  // target a ~10-minute budget on a mid-size dataset; real wall time is
  // governed by the scheduler itself and surfaced live via the ETA panel.
  const phase2Attempts = Math.max(8, Math.round(baseAttempts * 0.15));
  const phase2Iter = Math.max(5000, Math.round(baseIter * 0.3));
  const phase3Attempts = Math.max(20, Math.round(baseAttempts * 0.4));
  const phase3Iter = Math.max(15000, Math.round(baseIter * 0.6));
  const phase4Attempts = Math.max(40, Math.round(baseAttempts * 0.8));
  const phase4Iter = baseIter;
  const phase5Attempts = baseAttempts;
  const phase5Iter = baseIter;

  // ── Phase 1 — sample population ────────────────────────────────────────
  setPhase(1, 'דגימת מועמדים', 1);
  const currentSettings = store.getAlgorithmSettings();
  const rng = mulberry32(Date.now() | 0);
  const lhsCount = 40;
  const vectors = latinHypercubeSample(fp.activeDims, lhsCount, rng);

  const candidates: Candidate[] = [];
  let cid = 0;

  // Pinned current settings
  candidates.push({ id: cid++, label: 'current', config: { ...currentSettings.config }, results: [] });

  // Minimalist & rigid anchors
  const floorVec = fp.activeDims.map((d) => d.min);
  const ceilingVec = fp.activeDims.map((d) => d.max);
  candidates.push(
    makeCandidateFromVector(cid++, 'floor', currentSettings.config, fp.activeDims, floorVec),
    makeCandidateFromVector(cid++, 'ceiling', currentSettings.config, fp.activeDims, ceilingVec),
  );

  for (let i = 0; i < vectors.length; i++) {
    candidates.push(makeCandidateFromVector(cid++, `lhs-${i}`, currentSettings.config, fp.activeDims, vectors[i]));
  }

  const perturbDimCount = Math.min(3, fp.activeDims.length);
  s.phaseDone = 1;
  updateOverlay();
  if (s.canceled) return null;

  // ── Phase 2 — cheap culling ────────────────────────────────────────────
  setPhase(2, 'ניפוי מהיר', candidates.length);
  updateOverlay();
  for (const c of candidates) {
    if (s.canceled) return null;
    const r = await evaluate(mkEval(c.config, phase2Attempts, phase2Iter));
    c.results.push(r);
    recordEval(r);
    observeCandidate(c);
    updateOverlay();
    await yieldToUi();
  }

  // Keep top 30% (minimum 8, maximum 15). Ranking by single cheap score.
  const cheapSurvivors = [...candidates]
    .sort((a, b) => cheapRank(b) - cheapRank(a))
    .slice(0, Math.min(15, Math.max(8, Math.round(candidates.length * 0.3))));

  // Always ensure current-settings candidate survives to Phase 3+.
  const currentCand = candidates.find((c) => c.label === 'current');
  if (!currentCand) throw new Error('auto-tuner: missing pinned current candidate.');
  if (!cheapSurvivors.includes(currentCand)) cheapSurvivors.push(currentCand);

  // Pin the baseline for the live leader-diff preview now that we know the
  // `current` candidate's config. Active dims are the only ones the tuner
  // actually varies — comparing inactive dims would always be a no-op.
  _leaderDiffBaseline = currentCand.config;
  _leaderDiffDims = fp.activeDims;

  // ── Phase 3 — mid-fidelity + local perturbation probing ────────────────
  // Each survivor runs twice; then top-3 are perturbed on up to 3 dims.
  // The phaseTotal upper-bounds the perturbation count so the progress bar
  // never overshoots 100% when some perturbations are skipped (identical to
  // base after rounding / clamping).
  const phase3SurvivorEvals = cheapSurvivors.length * 2;
  const phase3PerturbUpper = Math.min(3, cheapSurvivors.length) * perturbDimCount;
  setPhase(3, 'סינון מעמיק', phase3SurvivorEvals + phase3PerturbUpper);
  updateOverlay();

  for (const c of cheapSurvivors) {
    // Drop the single cheap Phase 2 result so the Phase 3 median is computed
    // from mid-fidelity evaluations only.
    c.results = [];
    for (let k = 0; k < 2; k++) {
      if (s.canceled) return null;
      const r = await evaluate(mkEval(c.config, phase3Attempts, phase3Iter));
      c.results.push(r);
      recordEval(r);
      observeCandidate(c);
      updateOverlay();
      await yieldToUi();
    }
  }

  // Perturb top-3 on up to 3 dims (halve/double one dim at a time).
  const rankedMid = [...cheapSurvivors].sort((a, b) => midRank(b) - midRank(a));
  const topThree = rankedMid.slice(0, 3);
  const perturbDims = fp.activeDims.slice(0, Math.min(3, fp.activeDims.length));
  const perturbCandidates: Candidate[] = [];
  for (const seed of topThree) {
    for (const dim of perturbDims) {
      if (s.canceled) return null;
      const base = seed.config[dim.key] ?? DEFAULT_CONFIG[dim.key];
      // Use the seeded RNG (not Math.random) so the tuner's stochastic
      // choices stay reproducible per-run given the same start seed.
      const perturbedVal = Math.min(dim.max, Math.max(dim.min, Math.round(base * (rng() < 0.5 ? 0.5 : 2))));
      if (perturbedVal === base) continue;
      const pc: Candidate = {
        id: cid++,
        label: `perturb-${seed.id}-${dim.key}`,
        config: { ...seed.config, [dim.key]: perturbedVal },
        results: [],
      };
      const r = await evaluate(mkEval(pc.config, phase3Attempts, phase3Iter));
      pc.results.push(r);
      recordEval(r);
      observeCandidate(pc);
      updateOverlay();
      await yieldToUi();
      perturbCandidates.push(pc);
    }
  }

  // Combine survivors + perturbation candidates, pick top-4 by mid rank.
  // Then ensure the pinned current-settings candidate is always a finalist
  // — but only evict the *bottom* of the finalist list, never a better one.
  const combined = [...cheapSurvivors, ...perturbCandidates];
  let phase4Survivors = [...combined].sort((a, b) => midRank(b) - midRank(a)).slice(0, 4);
  if (!phase4Survivors.includes(currentCand)) {
    if (phase4Survivors.length >= 4) phase4Survivors = phase4Survivors.slice(0, 3);
    phase4Survivors.push(currentCand);
  }

  // ── Phase 4 — stability arena ──────────────────────────────────────────
  const phase4EvalCount = phase4Survivors.length * 5;
  setPhase(4, 'בדיקת יציבות', phase4EvalCount);
  updateOverlay();

  for (const c of phase4Survivors) {
    // Reset results so Phase 4 score isn't mixed with cheap-stage results.
    c.results = [];
    for (let k = 0; k < 5; k++) {
      if (s.canceled) return null;
      const r = await evaluate(mkEval(c.config, phase4Attempts, phase4Iter));
      c.results.push(r);
      recordEval(r);
      observeCandidate(c);
      updateOverlay();
      await yieldToUi();
    }
  }

  // Apply the feasibility gate: any candidate with ≥1 infeasible run is
  // disqualified from being chosen as the winner.
  const feasibleFinalists = phase4Survivors.filter((c) => !c.results.some((r) => r.unfilled > 0));
  const ranked = [...feasibleFinalists].sort((a, b) => rankScore(b.results) - rankScore(a.results));
  const winner = ranked[0];
  // Distinguish "current was already best" from "nothing survived feasibility".
  const noFeasibleChallenger = feasibleFinalists.length === 0;

  // ── Phase 5 — verify winner vs. baseline on fresh seeds ────────────────
  // Total evals depends on the branch: no-challenger does only 3 (baseline
  // confirmation), winner path does 6 (winner+baseline × 3). Set the real
  // budget so the progress bar can actually reach 100%.
  const hasChallenger = winner != null && winner !== currentCand;
  const phase5Total = hasChallenger ? 6 : 3;
  setPhase(5, 'אימות מול הנוכחי', phase5Total);
  updateOverlay();

  let verdict: TuneRecommendation;
  if (winner == null || winner === currentCand) {
    // No challenger beat the baseline (either current was already best, or
    // no candidate passed the feasibility gate). Run a short confirmation on
    // the current settings alone so the user sees a stability estimate.
    const verifyResults: EvalResult[] = [];
    for (let k = 0; k < 3; k++) {
      if (s.canceled) return null;
      const r = await evaluate(mkEval(currentCand.config, phase5Attempts, phase5Iter));
      verifyResults.push(r);
      recordEval(r);
      updateOverlay();
      await yieldToUi();
    }
    const med = median(verifyResults.map((r) => r.refScore));
    const band = iqr(verifyResults.map((r) => r.refScore));
    verdict = {
      config: { ...currentCand.config },
      winnerMedian: med,
      winnerIQR: band,
      baselineMedian: med,
      baselineIQR: band,
      medianDelta: 0,
      recommend: false,
      reason: noFeasibleChallenger
        ? 'אף מועמד מתחרה לא עבר את בדיקת הכדאיות — נשמרות ההגדרות הנוכחיות.'
        : 'ההגדרות הנוכחיות תחרותיות — אין צורך בשינוי.',
      fingerprintSummary: fp.summaryHebrew,
      diff: [],
      durationMs: Math.round(performance.now() - s.startMs),
    };
  } else {
    // Run winner + current, alternating, over 3 paired evaluations each.
    const winnerResults: EvalResult[] = [];
    const baselineResults: EvalResult[] = [];
    for (let k = 0; k < 3; k++) {
      if (s.canceled) return null;
      const rw = await evaluate(mkEval(winner.config, phase5Attempts, phase5Iter));
      winnerResults.push(rw);
      recordEval(rw);
      updateOverlay();
      await yieldToUi();

      if (s.canceled) return null;
      const rb = await evaluate(mkEval(currentCand.config, phase5Attempts, phase5Iter));
      baselineResults.push(rb);
      recordEval(rb);
      updateOverlay();
      await yieldToUi();
    }

    const wMed = median(winnerResults.map((r) => r.refScore));
    const wIQR = iqr(winnerResults.map((r) => r.refScore));
    const bMed = median(baselineResults.map((r) => r.refScore));
    const bIQR = iqr(baselineResults.map((r) => r.refScore));
    const anyWinnerInfeasible = winnerResults.some((r) => r.unfilled > 0);
    const delta = wMed - bMed;

    // Material-improvement threshold: must beat by ≥1% of |baseline| and at
    // least 5 points absolute, and must not widen IQR by more than 2×.
    const absThreshold = Math.max(5, Math.abs(bMed) * 0.01);
    const stabilityOk = wIQR <= Math.max(1, bIQR * 2);
    const recommend = !anyWinnerInfeasible && delta >= absThreshold && stabilityOk;

    const diff: TuneRecommendation['diff'] = [];
    for (const d of fp.activeDims) {
      const baseline = currentCand.config[d.key];
      const tuned = winner.config[d.key];
      if (baseline !== tuned) diff.push({ key: d.key, baseline, tuned });
    }

    verdict = {
      config: { ...winner.config },
      winnerMedian: wMed,
      winnerIQR: wIQR,
      baselineMedian: bMed,
      baselineIQR: bIQR,
      medianDelta: delta,
      recommend,
      reason: recommend
        ? `שיפור של ${delta.toFixed(1)} נקודות בציון החציוני (יציבות נשמרה).`
        : anyWinnerInfeasible
          ? 'הניצח הפיק ריצה אחת או יותר לא-תקינה באימות — לא מומלץ ליישם.'
          : `השיפור (${delta.toFixed(1)}) נמוך מסף המינימום או שהיציבות נפגעה — לא מומלץ ליישם.`,
      fingerprintSummary: fp.summaryHebrew,
      diff,
      durationMs: Math.round(performance.now() - s.startMs),
    };
  }

  s.phase = -1;
  updateOverlay();
  return verdict;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ranking helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Single-eval cheap rank: feasibility-gated, then composite score. */
function cheapRank(c: Candidate): number {
  if (c.results.length === 0) return -Infinity;
  const r = c.results[0];
  return r.refScore - 10000 * r.unfilled;
}

/** Mid-fidelity rank: median of evaluations minus unfilled penalty. */
function midRank(c: Candidate): number {
  if (c.results.length === 0) return -Infinity;
  const med = median(c.results.map((r) => r.refScore));
  const worst = maxUnfilled(c.results);
  return med - 10000 * worst;
}
