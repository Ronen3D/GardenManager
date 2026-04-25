/**
 * BALTAM — Post-generation task injection & multi-plan staffing.
 *
 * Injects a new one-time task into an existing schedule snapshot and produces
 * a ranked pool of staffing plans. Each plan tells how to fill every slot of
 * the task, possibly via cross-task swap chains that displace existing
 * assignments and backfill them.
 *
 * Architecture:
 *
 *   1. **Insert task + placeholder assignments.** The injected task is added
 *      to the schedule along with one synthetic placeholder assignment per
 *      slot. The placeholder participantId never resolves to a real
 *      participant, so HC-4/HC-5/HC-7 silently skip it during enumeration.
 *
 *   2. **Per-slot chain enumeration.** Each placeholder is treated as a
 *      vacated slot and fed into the shared `enumerateChainsForSlot()` from
 *      rescue-primitives.ts. We get depth-1/2/3 chains by default, with
 *      depth-4 and depth-5 fallbacks unlocked by a cascading retry.
 *
 *   3. **Joint composition.** Per-slot candidate chains are composed via
 *      `dfsCompose()` with admissible upper-bound pruning, conflict
 *      detection (touched assignments + (participant, task) pairs), and a
 *      time budget. This produces the top-K compositions globally.
 *
 *   4. **Ranking.** Each composition is hard-constraint-validated on its
 *      post-mutation state and scored by full composite score delta. Plans
 *      are sorted by composite delta, with disruption-minimising tiebreaks
 *      (fewer touched participants, shorter swap chain, shallower depth
 *      histogram, no fallback-depth penalty). MMR diversity selects the
 *      final top-N alternatives.
 *
 *   5. **Group backtracking** for `sameGroupRequired` tasks runs the same
 *      search per candidate group, then merges all valid plans into one
 *      ranked pool — the user (or the auto-pick) picks the global best,
 *      not a forced first-success.
 *
 *   6. **Apply** mutates the placeholders to real participants and applies
 *      donor swaps; unfilled placeholders are removed. **Cancel** removes
 *      the task and every placeholder/donor mutation atomically.
 *
 * Backwards-compat: `injectAndStaff()` still returns `{ report, error }`.
 * The report represents the auto-applied top-ranked plan (or the best
 * partial plan when no full plan exists). New callers should prefer
 * `searchInjectionPlans()` which returns the multi-plan result without
 * applying anything, so the UI can present alternatives.
 */

import { validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore } from '../constraints/soft-constraints';
import {
  type Assignment,
  AssignmentStatus,
  type ConstraintViolation,
  type LoadWindow,
  type Participant,
  type RescueSwap,
  type Schedule,
  type ScheduleUnavailability,
  type SlotRequirement,
  type SlotTemplate,
  type SubTeamTemplate,
  type Task,
} from '../models/types';
import { injectSectionKey } from '../shared/layout-key';
import { hourInOpDay } from '../shared/utils/time-utils';
import { operationalDateKey } from '../utils/date-utils';
import {
  type CandidateChain,
  type ChainEnumerationCaps,
  DEFAULT_CAPS,
  enumerateChainsForSlot,
  type FallbackLevel,
  type SlotEnumerationContext,
} from './rescue-primitives';
import type { SchedulingEngine } from './scheduler';
import { assertInjectableTimeBlock } from './temporal';
import { getRejectionReason, REJECTION_REASONS_HE, type RejectionCode } from './validator';

// ─── Public types ───────────────────────────────────────────────────────────

/** Form-level spec for the task being injected. Mirrors OneTimeTask fields. */
export interface InjectedTaskSpec {
  name: string;
  /** Day index within the current schedule (1-based, 1..periodDays). */
  dayIndex: number;
  startHour: number;
  startMinute: number;
  durationHours: number;
  subTeams: SubTeamTemplate[];
  slots: SlotTemplate[];
  sameGroupRequired: boolean;
  blocksConsecutive: boolean;
  baseLoadWeight?: number;
  loadWindows?: LoadWindow[];
  schedulingPriority?: number;
  togethernessRelevant?: boolean;
  restRuleId?: string;
  color?: string;
  description?: string;
}

/** One step in a displace-and-backfill chain (preserved for UI back-compat). */
export interface StaffingSwapStep {
  assignmentId: string;
  fromParticipantId: string;
  toParticipantId: string;
  taskId: string;
  taskName: string;
  slotLabel: string;
}

export interface SlotStaffingOutcome {
  slotId: string;
  slotLabel: string;
  filled: boolean;
  participantId?: string;
  /** Non-empty when staffing required a displace-and-backfill chain. */
  swapChain?: StaffingSwapStep[];
  reason?: string;
}

export interface PerParticipantChange {
  participantId: string;
  added: Assignment[];
  removed: Assignment[];
}

/** A full multi-slot staffing plan produced by the search stage. */
export interface InjectionPlan {
  id: string;
  rank: number;
  /** Composite score delta vs baseline. Positive = improvement. */
  compositeDelta: number;
  /** { 1: n1, 2: n2, ... } — chain depths used across all slots. */
  depthHistogram: Record<1 | 2 | 3 | 4 | 5, number>;
  perParticipantChanges: PerParticipantChange[];
  /** Hard-constraint violations on the post-mutation state. Empty for valid plans. */
  violations: ConstraintViolation[];
  /** True when at least one slot has no chain (left empty by this plan). */
  isPartial: boolean;
  /** When the plan needed depth 4 or 5 to find a chain anywhere. */
  fallbackDepthUsed?: 4 | 5;
  /** Per-slot outcomes (filled or not + swap chain detail), in task.slots order. */
  outcomes: SlotStaffingOutcome[];
  filledCount: number;
  totalSlotCount: number;
  /** For sameGroupRequired tasks: the group this plan locks. Null otherwise. */
  groupLock: string | null;
  /** Internal: chains per slot, used to materialise mutations on apply. */
  _chainBySlotId: Map<string, CandidateChain | null>;
}

export interface InjectionResult {
  task: Task;
  /** Top-N plans ranked & MMR-diversified. May include partial plans. */
  plans: InjectionPlan[];
  /** Slot IDs that had ZERO candidate chains at any tried fallback level. */
  unsolvableSlotIds: string[];
  /** Whether the DFS composition hit its wall-clock budget. */
  timedOut: boolean;
  /** Apply the chosen plan to the schedule. Returns a report with rollback. */
  apply: (planId: string) => StaffingReport | null;
  /** Hard-rollback: discard task + placeholders without applying any plan. */
  cancel: () => void;
}

export interface StaffingReport {
  task: Task;
  outcomes: SlotStaffingOutcome[];
  fullyStaffed: boolean;
  /** Composite score delta vs baseline (when an applied plan was scored). */
  compositeDelta?: number;
  /** Restore the schedule to the pre-injection state. Idempotent in practice. */
  rollback: () => void;
}

export interface InjectStaffOptions {
  /** Allow the staffer to consider `lowPriority` level placements. Default true. */
  allowLowPriority?: boolean;
  /**
   * Live Mode temporal anchor. When provided, the injection is rejected if
   * the resolved task start is strictly before the anchor — the "past is
   * closed" contract. Omit for non-Live-Mode callers (CLI, tests).
   */
  anchor?: Date;
  /** How many alternative plans to keep at most. Default 3. */
  maxPlans?: number;
  /** DFS composition wall-clock budget per stage. Default 500ms (1500ms for ≥5 slots). */
  timeBudgetMs?: number;
  /** Per-depth caps for chain enumeration. Defaults to DEFAULT_CAPS from rescue-primitives. */
  caps?: ChainEnumerationCaps;
}

// ─── ID generation ──────────────────────────────────────────────────────────

let _injCounter = 0;
function nextInjAssignmentId(): string {
  return `inj-asgn-${Date.now()}-${++_injCounter}`;
}
function nextInjTaskId(name: string): string {
  return `inj-${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${++_injCounter}`;
}
function nextInjSlotId(): string {
  return `inj-slot-${Date.now()}-${++_injCounter}`;
}

const PLACEHOLDER_PREFIX = '__inject_placeholder__';
function makePlaceholderParticipantId(slotId: string): string {
  return `${PLACEHOLDER_PREFIX}-${slotId}`;
}
function isPlaceholderParticipantId(pid: string): boolean {
  return pid.startsWith(PLACEHOLDER_PREFIX);
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function slotLabel(slot: SlotRequirement, ownerTask: Task): string {
  if (slot.subTeamLabel && slot.label) return `${slot.subTeamLabel} / ${slot.label}`;
  if (slot.subTeamLabel) return slot.subTeamLabel;
  if (slot.label) return slot.label;
  const idx = ownerTask.slots.findIndex((s) => s.slotId === slot.slotId);
  return `משבצת ${idx >= 0 ? idx + 1 : 1}`;
}

function isLowPriorityOnly(participant: Participant, slot: SlotRequirement): boolean {
  const entry = slot.acceptableLevels.find((le) => le.level === participant.level);
  return !!entry?.lowPriority;
}

/**
 * Coarse pre-filter: level + certs compatible with the slot, honoring
 * disabledHC. Always a superset of isEligible's verdict.
 */
function levelCertCompatible(p: Participant, slot: SlotRequirement, disabledHC?: Set<string>): boolean {
  if (!disabledHC?.has('HC-11') && slot.forbiddenCertifications?.some((c) => p.certifications.includes(c)))
    return false;
  if (!disabledHC?.has('HC-1') && !slot.acceptableLevels.some((le) => le.level === p.level)) return false;
  if (!disabledHC?.has('HC-2') && !slot.requiredCertifications.every((c) => p.certifications.includes(c))) return false;
  return true;
}

// ─── Task construction (preserved as-is) ────────────────────────────────────

/**
 * Build the Task object from a spec. Mirrors the one-time-task expansion
 * path in app.ts:generateTasksFromTemplates.
 *
 * `spec.dayIndex` is the **operational** day (1-based). When `startHour` is
 * below `dayStartHour` the composed calendar date rolls forward by one day,
 * so `operationalDateKey(start, dayStartHour)` always matches `dayIndex`.
 */
export function buildInjectedTask(
  spec: InjectedTaskSpec,
  periodStart: Date,
  periodDays: number,
  dayStartHour: number,
): Task | null {
  if (spec.dayIndex < 1 || spec.dayIndex > periodDays) return null;
  if (spec.durationHours <= 0) return null;

  const dsh = ((Math.trunc(dayStartHour) % 24) + 24) % 24;
  const hourMs = hourInOpDay(periodStart, dsh, spec.dayIndex, spec.startHour);
  const start = new Date(hourMs + spec.startMinute * 60_000);
  const end = new Date(start.getTime() + spec.durationHours * 3600000);

  const slots: SlotRequirement[] = [];
  for (const st of spec.subTeams) {
    for (const s of st.slots) {
      if (s.acceptableLevels.length === 0) continue;
      slots.push({
        slotId: nextInjSlotId(),
        acceptableLevels: [...s.acceptableLevels],
        requiredCertifications: [...s.requiredCertifications],
        forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
        label: s.label,
        subTeamLabel: st.name,
        subTeamId: st.id,
      });
    }
  }
  for (const s of spec.slots) {
    if (s.acceptableLevels.length === 0) continue;
    slots.push({
      slotId: nextInjSlotId(),
      acceptableLevels: [...s.acceptableLevels],
      requiredCertifications: [...s.requiredCertifications],
      forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
      label: s.label,
    });
  }

  if (slots.length === 0) return null;

  const id = nextInjTaskId(spec.name);
  const task: Task = {
    id,
    name: `יום ${spec.dayIndex} ${spec.name}`,
    sourceName: spec.name,
    timeBlock: { start, end },
    requiredCount: slots.length,
    slots,
    baseLoadWeight: spec.baseLoadWeight,
    loadWindows: (spec.loadWindows ?? []).map((w) => ({ ...w })),
    sameGroupRequired: spec.sameGroupRequired,
    blocksConsecutive: spec.blocksConsecutive,
    schedulingPriority: spec.schedulingPriority,
    togethernessRelevant: spec.togethernessRelevant,
    restRuleId: spec.restRuleId,
    sectionKey: injectSectionKey(id),
    color: spec.color || '#c0392b',
    injectedPostGeneration: true,
  };
  return task;
}

// ─── Placeholder lifecycle ──────────────────────────────────────────────────

interface PlaceholderInfo {
  /** All placeholder assignments (one per slot). */
  bySlot: Map<string, Assignment>;
  /** All placeholder assignment IDs. */
  ids: Set<string>;
}

function installPlaceholders(schedule: Schedule, task: Task): PlaceholderInfo {
  const bySlot = new Map<string, Assignment>();
  const ids = new Set<string>();
  for (const slot of task.slots) {
    const a: Assignment = {
      id: nextInjAssignmentId(),
      taskId: task.id,
      slotId: slot.slotId,
      participantId: makePlaceholderParticipantId(slot.slotId),
      status: AssignmentStatus.Manual,
      updatedAt: new Date(),
    };
    schedule.assignments.push(a);
    bySlot.set(slot.slotId, a);
    ids.add(a.id);
  }
  return { bySlot, ids };
}

// ─── Per-slot enumeration with group + lowPriority filters ──────────────────

/**
 * Filter a chain so it only fills the placeholder slot with a participant
 * matching `groupLock` (when set) and respecting `allowLowPriority`. The
 * "fill" participant is the `toParticipantId` of the chain's first swap —
 * by construction, that's the swap that targets the placeholder.
 */
function chainAcceptsFill(
  chain: CandidateChain,
  slot: SlotRequirement,
  participantMap: Map<string, Participant>,
  groupLock: string | null,
  allowLowPriority: boolean,
): boolean {
  if (chain.swaps.length === 0) return false;
  const fillP = participantMap.get(chain.swaps[0].toParticipantId);
  if (!fillP) return false;
  if (groupLock !== null && fillP.group !== groupLock) return false;
  if (!allowLowPriority && isLowPriorityOnly(fillP, slot)) return false;
  return true;
}

// ─── Composition helpers (forked from future-sos.ts, slightly adapted) ──────

type Composition = { chains: CandidateChain[]; deltaSum: number; slotIndex: number[] };

/**
 * 32-bit non-cryptographic hash over a plan's swap list. Same algorithm as
 * future-sos so plan IDs hash-stably across modules.
 */
function hashSwaps(swaps: RescueSwap[]): string {
  let h = 2166136261;
  const key = swaps
    .map((s) => `${s.assignmentId}>${s.toParticipantId}`)
    .sort()
    .join('|');
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function applyCompositionToAssignments(
  schedule: Schedule,
  chains: CandidateChain[],
  /** Placeholder assignment IDs that this composition does NOT fill — drop them. */
  unfilledPlaceholderIds: Set<string>,
): Assignment[] {
  const swapMap = new Map<string, string>();
  for (const c of chains) {
    for (const s of c.swaps) swapMap.set(s.assignmentId, s.toParticipantId);
  }
  const out: Assignment[] = [];
  for (const a of schedule.assignments) {
    if (unfilledPlaceholderIds.has(a.id)) continue;
    const pid = swapMap.get(a.id);
    out.push(pid ? { ...a, participantId: pid } : a);
  }
  return out;
}

function mergeSwaps(chains: CandidateChain[]): RescueSwap[] {
  const merged: RescueSwap[] = [];
  const seen = new Set<string>();
  for (const c of chains) {
    for (const s of c.swaps) {
      if (seen.has(s.assignmentId)) continue;
      seen.add(s.assignmentId);
      merged.push(s);
    }
  }
  return merged;
}

function buildPerParticipantChanges(
  baseline: Assignment[],
  candidate: Assignment[],
  touchedAssignmentIds: Set<string>,
  unfilledPlaceholderIds: Set<string>,
  isPlaceholderId: (id: string) => boolean,
): PerParticipantChange[] {
  const baseById = new Map<string, Assignment>();
  for (const a of baseline) baseById.set(a.id, a);
  const candById = new Map<string, Assignment>();
  for (const a of candidate) candById.set(a.id, a);

  const byParticipant = new Map<string, { added: Assignment[]; removed: Assignment[] }>();
  const ensure = (pid: string) => {
    let entry = byParticipant.get(pid);
    if (!entry) {
      entry = { added: [], removed: [] };
      byParticipant.set(pid, entry);
    }
    return entry;
  };

  for (const id of touchedAssignmentIds) {
    const before = baseById.get(id);
    const after = candById.get(id);
    // Placeholder swaps: `before` has the synthetic placeholder participant
    // (no real "removed" participant). Show only the "added" side.
    if (after && (!before || isPlaceholderParticipantId(before.participantId))) {
      ensure(after.participantId).added.push(after);
      continue;
    }
    if (!before || !after) continue;
    if (before.participantId === after.participantId) continue;
    ensure(before.participantId).removed.push(before);
    ensure(after.participantId).added.push(after);
  }

  // Unfilled placeholders represent slots that nobody fills — no participant
  // gain or loss to report here.
  void unfilledPlaceholderIds;
  void isPlaceholderId;

  const result: PerParticipantChange[] = [];
  for (const [pid, v] of byParticipant) {
    result.push({ participantId: pid, added: v.added, removed: v.removed });
  }
  return result;
}

// ─── DFS composition with branch-and-bound ──────────────────────────────────

interface DfsState {
  chosen: (CandidateChain | null)[];
  usedAssignmentIds: Set<string>;
  usedPairs: Set<string>;
  sumSoloDelta: number;
}

function pairKey(participantId: string, taskId: string): string {
  return `${participantId}|${taskId}`;
}

interface DfsOutcome {
  /** Each composition stores chosen chains AND original slot indices so we
   *  can map results back to the task's slot order after the search. */
  compositions: Composition[];
  timedOut: boolean;
}

function dfsCompose(
  candidatesPerSlot: CandidateChain[][],
  /** Original slot index of each entry in `candidatesPerSlot` (it gets reordered for fail-fast DFS). */
  originalIndex: number[],
  topK: number,
  deadline: number,
): DfsOutcome {
  const suffixBest: number[] = new Array(candidatesPerSlot.length + 1).fill(0);
  for (let i = candidatesPerSlot.length - 1; i >= 0; i--) {
    const best = candidatesPerSlot[i].length > 0 ? candidatesPerSlot[i][0].soloCompositeDelta : -Infinity;
    suffixBest[i] = suffixBest[i + 1] + (Number.isFinite(best) ? best : 0);
  }

  const best: Composition[] = [];
  let timedOut = false;
  const state: DfsState = {
    chosen: new Array(candidatesPerSlot.length).fill(null),
    usedAssignmentIds: new Set(),
    usedPairs: new Set(),
    sumSoloDelta: 0,
  };

  function tryInsert(comp: Composition) {
    if (best.length < topK) {
      best.push(comp);
      best.sort((a, b) => b.deltaSum - a.deltaSum);
      return;
    }
    if (comp.deltaSum > best[best.length - 1].deltaSum) {
      best[best.length - 1] = comp;
      best.sort((a, b) => b.deltaSum - a.deltaSum);
    }
  }

  function worstKeptDelta(): number {
    return best.length < topK ? -Infinity : best[best.length - 1].deltaSum;
  }

  function recurse(i: number) {
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }
    if (i === candidatesPerSlot.length) {
      const chains = state.chosen.filter((c): c is CandidateChain => c !== null);
      tryInsert({ chains, deltaSum: state.sumSoloDelta, slotIndex: [...originalIndex] });
      return;
    }
    // Admissible upper-bound prune.
    const upperBound = state.sumSoloDelta + suffixBest[i];
    if (upperBound <= worstKeptDelta()) return;

    const cands = candidatesPerSlot[i];
    for (const cand of cands) {
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }
      let conflict = false;
      for (const id of cand.touchedAssignmentIds) {
        if (state.usedAssignmentIds.has(id)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      for (const pair of cand.participantTaskPairs) {
        if (state.usedPairs.has(pairKey(pair.participantId, pair.taskId))) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      const addedAssn: string[] = [];
      const addedPairs: string[] = [];
      for (const id of cand.touchedAssignmentIds) {
        state.usedAssignmentIds.add(id);
        addedAssn.push(id);
      }
      for (const pair of cand.participantTaskPairs) {
        const k = pairKey(pair.participantId, pair.taskId);
        state.usedPairs.add(k);
        addedPairs.push(k);
      }
      state.chosen[i] = cand;
      state.sumSoloDelta += cand.soloCompositeDelta;

      recurse(i + 1);

      state.sumSoloDelta -= cand.soloCompositeDelta;
      state.chosen[i] = null;
      for (const id of addedAssn) state.usedAssignmentIds.delete(id);
      for (const k of addedPairs) state.usedPairs.delete(k);
    }
  }

  recurse(0);
  return { compositions: best, timedOut };
}

// ─── MMR diversity (forked from future-sos for module independence) ─────────

function selectDiversePlans(ranked: InjectionPlan[], k: number, lambda = 0.3): InjectionPlan[] {
  if (ranked.length <= k) return ranked;
  const keys = ranked.map((p) => {
    const set = new Set<string>();
    for (const o of p.outcomes) {
      if (o.filled && o.participantId) set.add(`${o.participantId}|${o.slotId}`);
    }
    return set;
  });
  const picked: number[] = [0];
  while (picked.length < k && picked.length < ranked.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (picked.includes(i)) continue;
      let maxSim = 0;
      for (const j of picked) {
        const a = keys[i];
        const b = keys[j];
        if (a.size === 0 && b.size === 0) continue;
        let inter = 0;
        for (const x of a) if (b.has(x)) inter++;
        const union = a.size + b.size - inter;
        const sim = union === 0 ? 0 : inter / union;
        if (sim > maxSim) maxSim = sim;
      }
      const refDelta = Math.max(1, Math.abs(ranked[0].compositeDelta));
      const s = ranked[i].compositeDelta - lambda * maxSim * refDelta;
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    picked.push(bestIdx);
  }
  return picked.map((i) => ranked[i]);
}

// ─── Stage runner: enumerate + compose + validate + score ───────────────────

interface StageOpts {
  task: Task;
  placeholders: PlaceholderInfo;
  slotCtx: SlotEnumerationContext;
  baselineComposite: number;
  caps: ChainEnumerationCaps;
  allowLowPriority: boolean;
  groupLock: string | null;
  maxPlans: number;
  budgetMs: number;
  fallbackLevel: FallbackLevel;
}

interface StageOutput {
  validPlans: InjectionPlan[];
  invalidPlans: InjectionPlan[];
  unsolvableSlotIds: string[];
  timedOut: boolean;
  /** False iff EVERY slot had zero candidate chains at this fallback level. */
  anySolvable: boolean;
}

function runStage(opts: StageOpts): StageOutput {
  const {
    task,
    placeholders,
    slotCtx,
    baselineComposite,
    caps,
    allowLowPriority,
    groupLock,
    maxPlans,
    budgetMs,
    fallbackLevel,
  } = opts;

  const candidatesPerSlot: CandidateChain[][] = [];
  const unsolvableSlotIds: string[] = [];
  const slotByIndex: SlotRequirement[] = [];

  for (const slot of task.slots) {
    const placeholder = placeholders.bySlot.get(slot.slotId);
    if (!placeholder) {
      candidatesPerSlot.push([]);
      slotByIndex.push(slot);
      unsolvableSlotIds.push(slot.slotId);
      continue;
    }
    const allChains = enumerateChainsForSlot(slotCtx, placeholder, caps, fallbackLevel);
    const filtered = allChains.filter((c) =>
      chainAcceptsFill(c, slot, slotCtx.participantMap, groupLock, allowLowPriority),
    );
    candidatesPerSlot.push(filtered);
    slotByIndex.push(slot);
    if (filtered.length === 0) unsolvableSlotIds.push(slot.slotId);
  }

  // Drop slots with zero candidates from the DFS — they'll be marked unfilled.
  const solvableIdx: number[] = [];
  for (let i = 0; i < candidatesPerSlot.length; i++) {
    if (candidatesPerSlot[i].length > 0) solvableIdx.push(i);
  }
  if (solvableIdx.length === 0) {
    return { validPlans: [], invalidPlans: [], unsolvableSlotIds, timedOut: false, anySolvable: false };
  }

  // Order by ascending candidate count (fail-fast DFS).
  const orderedSolvable = [...solvableIdx].sort((a, b) => candidatesPerSlot[a].length - candidatesPerSlot[b].length);
  const orderedCandidates = orderedSolvable.map((i) => candidatesPerSlot[i]);

  const deadline = Date.now() + budgetMs;
  const { compositions, timedOut } = dfsCompose(
    orderedCandidates,
    orderedSolvable,
    Math.max(maxPlans * 4, 8),
    deadline,
  );
  if (compositions.length === 0) {
    return { validPlans: [], invalidPlans: [], unsolvableSlotIds, timedOut, anySolvable: true };
  }

  const isPartial = unsolvableSlotIds.length > 0;
  const computeFallbackDepthUsed = (chains: CandidateChain[]): 4 | 5 | undefined => {
    let max: 1 | 2 | 3 | 4 | 5 = 1;
    for (const c of chains) if (c.depth > max) max = c.depth;
    return max === 4 || max === 5 ? max : undefined;
  };

  // Map a composition to an InjectionPlan, including per-slot outcomes.
  const composeToPlan = (comp: Composition, idx: number): InjectionPlan => {
    const chainBySlotId = new Map<string, CandidateChain | null>();
    for (const slot of task.slots) chainBySlotId.set(slot.slotId, null);
    for (let k = 0; k < comp.chains.length; k++) {
      const slotIdx = comp.slotIndex[k];
      const slot = slotByIndex[slotIdx];
      chainBySlotId.set(slot.slotId, comp.chains[k]);
    }

    const unfilledPlaceholderIds = new Set<string>();
    for (const slot of task.slots) {
      if (chainBySlotId.get(slot.slotId) === null) {
        const ph = placeholders.bySlot.get(slot.slotId);
        if (ph) unfilledPlaceholderIds.add(ph.id);
      }
    }

    const tempAssignments = applyCompositionToAssignments(slotCtx.schedule, comp.chains, unfilledPlaceholderIds);
    const validation = validateHardConstraints(
      slotCtx.schedule.tasks,
      slotCtx.schedule.participants,
      tempAssignments,
      slotCtx.disabledHC,
      slotCtx.restRuleMap,
      undefined,
      slotCtx.extraUnavailability,
      slotCtx.scheduleContext,
    );

    const depthHistogram: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const c of comp.chains) depthHistogram[c.depth]++;

    let compositeDelta: number;
    if (validation.violations.length > 0) {
      // Invalid plans are kept as a last-resort bucket; we still need a
      // composite delta for ranking within that bucket.
      const candScore = computeScheduleScore(
        slotCtx.schedule.tasks,
        slotCtx.schedule.participants,
        tempAssignments,
        slotCtx.config,
        slotCtx.scoreCtx,
      );
      compositeDelta = candScore.compositeScore - baselineComposite;
    } else {
      const candScore = computeScheduleScore(
        slotCtx.schedule.tasks,
        slotCtx.schedule.participants,
        tempAssignments,
        slotCtx.config,
        slotCtx.scoreCtx,
      );
      compositeDelta = candScore.compositeScore - baselineComposite;
    }

    const touched = new Set<string>();
    for (const c of comp.chains) for (const id of c.touchedAssignmentIds) touched.add(id);

    // Build per-slot outcomes in the task's original slot order.
    const outcomes: SlotStaffingOutcome[] = task.slots.map((slot) => {
      const chain = chainBySlotId.get(slot.slotId) ?? null;
      const label = slotLabel(slot, task);
      if (!chain || chain.swaps.length === 0) {
        return {
          slotId: slot.slotId,
          slotLabel: label,
          filled: false,
          reason: diagnoseUnfillableSlotAtFinalState(slotCtx, task, slot, tempAssignments, groupLock),
        };
      }
      // chain.swaps[0] is the placeholder→fill swap. Subsequent swaps are
      // donor backfills.
      const fillSwap = chain.swaps[0];
      const swapChain: StaffingSwapStep[] | undefined =
        chain.swaps.length > 1
          ? chain.swaps.slice(1).map((s) => ({
              assignmentId: s.assignmentId,
              fromParticipantId: s.fromParticipantId ?? '',
              toParticipantId: s.toParticipantId,
              taskId: s.taskId,
              taskName: s.taskName,
              slotLabel: s.slotLabel,
            }))
          : undefined;
      return {
        slotId: slot.slotId,
        slotLabel: label,
        filled: true,
        participantId: fillSwap.toParticipantId,
        swapChain,
      };
    });

    const filledCount = outcomes.filter((o) => o.filled).length;
    const merged = mergeSwaps(comp.chains);

    return {
      id: `inj-${hashSwaps(merged)}-${idx}`,
      rank: 0,
      compositeDelta,
      depthHistogram,
      perParticipantChanges: buildPerParticipantChanges(
        slotCtx.schedule.assignments,
        tempAssignments,
        touched,
        unfilledPlaceholderIds,
        (id) => placeholders.ids.has(id),
      ),
      violations: validation.violations,
      isPartial,
      fallbackDepthUsed: computeFallbackDepthUsed(comp.chains),
      outcomes,
      filledCount,
      totalSlotCount: task.slots.length,
      groupLock,
      _chainBySlotId: chainBySlotId,
    };
  };

  const valid: InjectionPlan[] = [];
  const invalid: InjectionPlan[] = [];
  for (let i = 0; i < compositions.length; i++) {
    const plan = composeToPlan(compositions[i], i);
    if (plan.violations.length > 0) invalid.push(plan);
    else valid.push(plan);
  }

  return { validPlans: valid, invalidPlans: invalid, unsolvableSlotIds, timedOut, anySolvable: true };
}

/**
 * Cascade depths 1-3 → 4 → 5 for a single (group-locked) search. Returns
 * the deepest stage with valid plans, or the deepest stage's invalid bucket
 * as a last-resort.
 */
function searchOneGroup(
  task: Task,
  placeholders: PlaceholderInfo,
  slotCtx: SlotEnumerationContext,
  baselineComposite: number,
  caps: ChainEnumerationCaps,
  allowLowPriority: boolean,
  groupLock: string | null,
  maxPlans: number,
  baseBudgetMs: number,
): { plans: InjectionPlan[]; unsolvableSlotIds: string[]; timedOut: boolean } {
  const FALLBACK_MAX = 10_000;
  const fallbackBudget = Math.min(FALLBACK_MAX, baseBudgetMs * 4);

  const stage1 = runStage({
    task,
    placeholders,
    slotCtx,
    baselineComposite,
    caps,
    allowLowPriority,
    groupLock,
    maxPlans,
    budgetMs: baseBudgetMs,
    fallbackLevel: 'none',
  });
  if (stage1.validPlans.length > 0) {
    return { plans: stage1.validPlans, unsolvableSlotIds: stage1.unsolvableSlotIds, timedOut: stage1.timedOut };
  }

  if (stage1.anySolvable || stage1.unsolvableSlotIds.length > 0) {
    console.warn(
      `[inject] depth-4 fallback fired for task ${task.id} (group=${groupLock ?? '∅'}, unsolvable=${stage1.unsolvableSlotIds.length}/${task.slots.length})`,
    );
    const stage2 = runStage({
      task,
      placeholders,
      slotCtx,
      baselineComposite,
      caps,
      allowLowPriority,
      groupLock,
      maxPlans,
      budgetMs: fallbackBudget,
      fallbackLevel: 'depth4',
    });
    if (stage2.validPlans.length > 0) {
      return { plans: stage2.validPlans, unsolvableSlotIds: stage2.unsolvableSlotIds, timedOut: stage2.timedOut };
    }
    if (stage2.anySolvable || stage2.unsolvableSlotIds.length > 0) {
      console.warn(
        `[inject] depth-5 fallback fired for task ${task.id} (group=${groupLock ?? '∅'}, unsolvable=${stage2.unsolvableSlotIds.length}/${task.slots.length})`,
      );
      const stage3 = runStage({
        task,
        placeholders,
        slotCtx,
        baselineComposite,
        caps,
        allowLowPriority,
        groupLock,
        maxPlans,
        budgetMs: fallbackBudget,
        fallbackLevel: 'depth5',
      });
      if (stage3.validPlans.length > 0) {
        return { plans: stage3.validPlans, unsolvableSlotIds: stage3.unsolvableSlotIds, timedOut: stage3.timedOut };
      }
      // Last-resort: surface the deepest invalid bucket.
      const lastInvalid =
        stage3.invalidPlans.length > 0
          ? stage3.invalidPlans
          : stage2.invalidPlans.length > 0
            ? stage2.invalidPlans
            : stage1.invalidPlans;
      return {
        plans: lastInvalid,
        unsolvableSlotIds: stage3.unsolvableSlotIds,
        timedOut: stage1.timedOut || stage2.timedOut || stage3.timedOut,
      };
    }
    // Stage 2 had no candidates anywhere — fall through to last-resort below.
  }

  // Nothing solvable at any depth.
  return { plans: stage1.invalidPlans, unsolvableSlotIds: stage1.unsolvableSlotIds, timedOut: stage1.timedOut };
}

/**
 * Cross-group search for `sameGroupRequired` tasks. Runs `searchOneGroup`
 * per candidate group and merges all valid plans into one ranked pool.
 *
 * Why pool-and-merge instead of pick-the-best-group: a 2/3 fill in group X
 * may have a much better composite delta than a 3/3 fill in group Y; and
 * the user gets to see alternatives across groups. The auto-pick still
 * favours full fills via the disruption tiebreaks (more participants
 * changed in a 3/3 plan only beats fewer-changed 2/3 when score difference
 * is below epsilon).
 */
function searchAcrossGroups(
  task: Task,
  placeholders: PlaceholderInfo,
  slotCtx: SlotEnumerationContext,
  baselineComposite: number,
  caps: ChainEnumerationCaps,
  allowLowPriority: boolean,
  maxPlans: number,
  baseBudgetMs: number,
): { plans: InjectionPlan[]; unsolvableSlotIds: string[]; timedOut: boolean } {
  const groups = new Set<string>();
  for (const p of slotCtx.schedule.participants) {
    for (const slot of task.slots) {
      if (levelCertCompatible(p, slot, slotCtx.disabledHC)) {
        groups.add(p.group);
        break;
      }
    }
  }
  if (groups.size === 0) {
    return { plans: [], unsolvableSlotIds: task.slots.map((s) => s.slotId), timedOut: false };
  }

  const allPlans: InjectionPlan[] = [];
  // Track per-slot solvability across all groups: a slot is unsolvable only
  // if NO group could produce a chain for it.
  const perSlotAnySolvable = new Map<string, boolean>();
  for (const s of task.slots) perSlotAnySolvable.set(s.slotId, false);
  let timedOut = false;

  for (const g of groups) {
    const r = searchOneGroup(
      task,
      placeholders,
      slotCtx,
      baselineComposite,
      caps,
      allowLowPriority,
      g,
      maxPlans,
      baseBudgetMs,
    );
    timedOut = timedOut || r.timedOut;
    for (const p of r.plans) allPlans.push(p);
    // A slot is solvable in this group if it's NOT in r.unsolvableSlotIds.
    const unsolvableSet = new Set(r.unsolvableSlotIds);
    for (const s of task.slots) {
      if (!unsolvableSet.has(s.slotId)) perSlotAnySolvable.set(s.slotId, true);
    }
  }

  const unsolvableSlotIds = task.slots.filter((s) => !perSlotAnySolvable.get(s.slotId)).map((s) => s.slotId);
  return { plans: allPlans, unsolvableSlotIds, timedOut };
}

// ─── Plan ranking ───────────────────────────────────────────────────────────

/**
 * Sort plans by composite delta with disruption-minimising tiebreaks. Mirrors
 * the FSOS ranking pattern; for injection we add additional tiebreaks to
 * prefer shallower chain distributions and avoid fallback-depth plans when
 * shallower ones are equally good.
 */
function sortPlans(plans: InjectionPlan[]): InjectionPlan[] {
  const EPS = 0.1;
  const out = [...plans];
  out.sort((a, b) => {
    // Primary: prefer fully-staffed plans over partial.
    if (a.isPartial !== b.isPartial) return a.isPartial ? 1 : -1;
    if (a.filledCount !== b.filledCount) return b.filledCount - a.filledCount;
    // Score: composite delta (higher = better).
    const delta = b.compositeDelta - a.compositeDelta;
    if (Math.abs(delta) > EPS) return delta;
    // Disruption: fewer participants changed.
    if (a.perParticipantChanges.length !== b.perParticipantChanges.length) {
      return a.perParticipantChanges.length - b.perParticipantChanges.length;
    }
    // Chain length: shorter = less disruption.
    const aSwaps = a.outcomes.reduce((n, o) => n + 1 + (o.swapChain?.length ?? 0), 0);
    const bSwaps = b.outcomes.reduce((n, o) => n + 1 + (o.swapChain?.length ?? 0), 0);
    if (aSwaps !== bSwaps) return aSwaps - bSwaps;
    // Depth distribution: prefer shallower (more depth-1 chains).
    const aShallow = a.depthHistogram[1] * 4 + a.depthHistogram[2] * 2 + a.depthHistogram[3];
    const bShallow = b.depthHistogram[1] * 4 + b.depthHistogram[2] * 2 + b.depthHistogram[3];
    if (aShallow !== bShallow) return bShallow - aShallow;
    // Last tiebreak: avoid fallback-depth plans when an equal alternative exists.
    const aFb = a.fallbackDepthUsed ?? 0;
    const bFb = b.fallbackDepthUsed ?? 0;
    return aFb - bFb;
  });
  return out;
}

// ─── Diagnose unfillable slots (final state) ───────────────────────────────

/** Highest-listed code wins. Same priority as the legacy diagnose path. */
const UNFILLABLE_PRIORITY: RejectionCode[] = [
  'HC-5',
  'HC-7',
  'HC-3',
  'HC-14',
  'HC-15',
  'HC-12',
  'HC-4',
  'HC-11',
  'HC-2',
  'HC-1',
];

/**
 * Diagnose why no participant could fill a slot, given the FINAL composed
 * state (so HC-5/HC-7 reflect what would block a fill in this plan).
 *
 * Walks every real participant and tallies the first failing HC. Returns
 * the highest-priority rejection in Hebrew.
 */
function diagnoseUnfillableSlotAtFinalState(
  slotCtx: SlotEnumerationContext,
  task: Task,
  slot: SlotRequirement,
  finalAssignments: Assignment[],
  groupLock: string | null,
): string {
  const tally = new Map<RejectionCode, number>();
  const bump = (code: RejectionCode) => tally.set(code, (tally.get(code) ?? 0) + 1);
  const disabled = slotCtx.disabledHC;
  const taskMap = slotCtx.taskMap;
  const finalTaskAssignments = finalAssignments.filter((a) => a.taskId === task.id);

  for (const p of slotCtx.schedule.participants) {
    if (groupLock !== null && p.group !== groupLock) {
      bump('HC-4');
      continue;
    }
    if (!disabled?.has('HC-1') && !slot.acceptableLevels.some((le) => le.level === p.level)) {
      bump('HC-1');
      continue;
    }
    if (!disabled?.has('HC-11') && slot.forbiddenCertifications?.some((c) => p.certifications.includes(c))) {
      bump('HC-11');
      continue;
    }
    if (!disabled?.has('HC-2') && !slot.requiredCertifications.every((c) => p.certifications.includes(c))) {
      bump('HC-2');
      continue;
    }
    const pAssignments = finalAssignments.filter((a) => a.participantId === p.id);
    const code = getRejectionReason(p, task, slot, pAssignments, taskMap, {
      checkSameGroup: true,
      taskAssignments: finalTaskAssignments,
      participantMap: slotCtx.participantMap,
      disabledHC: disabled,
      restRuleMap: slotCtx.restRuleMap,
      scheduleContext: slotCtx.scheduleContext,
      extraUnavailability: slotCtx.extraUnavailability,
    });
    if (code) bump(code);
  }

  for (const code of UNFILLABLE_PRIORITY) {
    if (tally.has(code)) return REJECTION_REASONS_HE[code];
  }
  return 'אין מועמד כשיר';
}

// ─── Apply / rollback ───────────────────────────────────────────────────────

interface ApplyCtx {
  schedule: Schedule;
  engine: SchedulingEngine;
  task: Task;
  placeholders: PlaceholderInfo;
  /** All assignments created by this injection (placeholders). Used for full rollback. */
  createdAssignmentIds: string[];
  /** Pre-mutation snapshots for any donor assignments touched by an applied plan. */
  mutatedSnapshots: Map<string, { participantId: string; status: AssignmentStatus; updatedAt: Date }>;
  /** True once apply() succeeded; rollback after this preserves the apply's commit semantics. */
  applied: boolean;
  /** Track which placeholders were removed during apply (for partial plans) so re-apply doesn't double-remove. */
  removedPlaceholderIds: Set<string>;
}

function snapshotIfUnseen(ctx: ApplyCtx, a: Assignment): void {
  if (ctx.mutatedSnapshots.has(a.id)) return;
  ctx.mutatedSnapshots.set(a.id, {
    participantId: a.participantId,
    status: a.status,
    updatedAt: a.updatedAt,
  });
}

function applyInjectionPlan(ctx: ApplyCtx, plan: InjectionPlan): StaffingReport {
  const now = new Date();

  // Apply all swaps in the chosen plan.
  const seenAssignments = new Set<string>();
  for (const slot of ctx.task.slots) {
    const chain = plan._chainBySlotId.get(slot.slotId);
    if (!chain) continue;
    for (const sw of chain.swaps) {
      if (seenAssignments.has(sw.assignmentId)) continue;
      seenAssignments.add(sw.assignmentId);
      const a = ctx.schedule.assignments.find((x) => x.id === sw.assignmentId);
      if (!a) continue;
      snapshotIfUnseen(ctx, a);
      a.participantId = sw.toParticipantId;
      a.status = AssignmentStatus.Manual;
      a.updatedAt = now;
    }
  }

  // Remove unfilled placeholders so the schedule doesn't carry synthetic
  // participants. Fully-rolled-back schedules will re-add nothing — that's
  // correct: those slots were never staffed.
  const filledPlaceholderIds = new Set<string>();
  for (const slot of ctx.task.slots) {
    const chain = plan._chainBySlotId.get(slot.slotId);
    if (!chain) continue;
    const ph = ctx.placeholders.bySlot.get(slot.slotId);
    if (ph) filledPlaceholderIds.add(ph.id);
  }
  for (const phId of ctx.placeholders.ids) {
    if (filledPlaceholderIds.has(phId)) continue;
    if (ctx.removedPlaceholderIds.has(phId)) continue;
    const idx = ctx.schedule.assignments.findIndex((a) => a.id === phId);
    if (idx >= 0) ctx.schedule.assignments.splice(idx, 1);
    ctx.removedPlaceholderIds.add(phId);
  }

  ctx.applied = true;

  return {
    task: ctx.task,
    outcomes: plan.outcomes,
    fullyStaffed: plan.outcomes.every((o) => o.filled),
    compositeDelta: plan.compositeDelta,
    rollback: () => rollbackAll(ctx),
  };
}

function rollbackAll(ctx: ApplyCtx): void {
  // Revert any donor / placeholder mutations.
  for (const [id, snap] of ctx.mutatedSnapshots) {
    const a = ctx.schedule.assignments.find((x) => x.id === id);
    if (!a) continue;
    a.participantId = snap.participantId;
    a.status = snap.status;
    a.updatedAt = snap.updatedAt;
  }
  ctx.mutatedSnapshots.clear();

  // Remove every placeholder assignment (whether mutated, removed, or still
  // synthetic) — the entire injection unwinds back to pre-call state.
  if (ctx.placeholders.ids.size > 0) {
    for (let i = ctx.schedule.assignments.length - 1; i >= 0; i--) {
      if (ctx.placeholders.ids.has(ctx.schedule.assignments[i].id)) {
        ctx.schedule.assignments.splice(i, 1);
      }
    }
  }
  ctx.removedPlaceholderIds.clear();

  // Remove the injected task itself.
  const tIdx = ctx.schedule.tasks.findIndex((t) => t.id === ctx.task.id);
  if (tIdx >= 0) ctx.schedule.tasks.splice(tIdx, 1);
  ctx.engine.removeTask(ctx.task.id);
}

// ─── Build the empty/all-unfilled report fallback ───────────────────────────

/**
 * Build a "no plan available" report. Used when search returns zero plans
 * — the task is committed empty and the report explains per slot why no
 * candidate could fill it. The caller can choose to rollback (cancel) or
 * commit (accept the empty task).
 */
function buildEmptyPlan(
  task: Task,
  slotCtx: SlotEnumerationContext,
  groupLock: string | null,
  finalAssignments: Assignment[],
): InjectionPlan {
  const outcomes: SlotStaffingOutcome[] = task.slots.map((slot) => ({
    slotId: slot.slotId,
    slotLabel: slotLabel(slot, task),
    filled: false,
    reason: diagnoseUnfillableSlotAtFinalState(slotCtx, task, slot, finalAssignments, groupLock),
  }));
  const chainBySlotId = new Map<string, CandidateChain | null>();
  for (const slot of task.slots) chainBySlotId.set(slot.slotId, null);
  return {
    id: `inj-empty-${Date.now()}`,
    rank: 1,
    compositeDelta: 0,
    depthHistogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    perParticipantChanges: [],
    violations: [],
    isPartial: true,
    outcomes,
    filledCount: 0,
    totalSlotCount: task.slots.length,
    groupLock,
    _chainBySlotId: chainBySlotId,
  };
}

// ─── Public entry: searchInjectionPlans (multi-plan) ────────────────────────

/**
 * Search for staffing plans for a new task. Inserts the task + placeholder
 * assignments into the schedule, enumerates per-slot chains via
 * `enumerateChainsForSlot`, joins them via DFS composition, and returns a
 * ranked + diversified pool of plans. Nothing is applied until the caller
 * invokes `result.apply(planId)`. Calling `result.cancel()` removes the
 * injected task without applying any plan.
 */
export function searchInjectionPlans(
  engine: SchedulingEngine,
  spec: InjectedTaskSpec,
  opts: InjectStaffOptions = {},
): { result: InjectionResult | null; error?: 'no-schedule' | 'invalid-spec' | 'past-time' } {
  const schedule = engine.getSchedule();
  if (!schedule) return { result: null, error: 'no-schedule' };

  const task = buildInjectedTask(spec, schedule.periodStart, schedule.periodDays, engine.getDayStartHour());
  if (!task) return { result: null, error: 'invalid-spec' };

  if (opts.anchor) {
    const gate = assertInjectableTimeBlock(task.timeBlock, opts.anchor);
    if (!gate.ok) return { result: null, error: gate.reason };
  }

  // Add task + placeholders to the schedule (always cleaned up via rollback).
  engine.addTask(task);
  schedule.tasks.push(task);
  const placeholders = installPlaceholders(schedule, task);

  // Build search infrastructure.
  const dayStartHour = engine.getDayStartHour();
  const config = engine.getConfig();
  const scoreCtx = engine.buildScoreContext();
  if (!scoreCtx) {
    // Should never happen post-importSchedule. Defensive cleanup.
    for (let i = schedule.assignments.length - 1; i >= 0; i--) {
      if (placeholders.ids.has(schedule.assignments[i].id)) schedule.assignments.splice(i, 1);
    }
    const tIdx = schedule.tasks.findIndex((t) => t.id === task.id);
    if (tIdx >= 0) schedule.tasks.splice(tIdx, 1);
    engine.removeTask(task.id);
    return { result: null, error: 'invalid-spec' };
  }

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const participantMap = new Map<string, Participant>();
  for (const p of schedule.participants) participantMap.set(p.id, p);

  const assignmentsByParticipant = new Map<string, Assignment[]>();
  const assignmentsByTask = new Map<string, Assignment[]>();
  for (const a of schedule.assignments) {
    let l = assignmentsByParticipant.get(a.participantId);
    if (!l) {
      l = [];
      assignmentsByParticipant.set(a.participantId, l);
    }
    l.push(a);
    let tl = assignmentsByTask.get(a.taskId);
    if (!tl) {
      tl = [];
      assignmentsByTask.set(a.taskId, tl);
    }
    tl.push(a);
  }

  // Use the engine's frozen disabled-HC set as-is. Per-injection relaxation
  // is intentionally not supported — HC enable/disable is global config only.
  const disabledHC = engine.getDisabledHC();

  const scheduleUnavail: ScheduleUnavailability[] = schedule.scheduleUnavailability ?? [];
  const extraUnavailability = scheduleUnavail.map((u) => ({
    participantId: u.participantId,
    start: u.start,
    end: u.end,
  }));

  const baselineScore = computeScheduleScore(
    schedule.tasks,
    schedule.participants,
    schedule.assignments,
    config,
    scoreCtx,
  );

  const slotCtx: SlotEnumerationContext = {
    schedule,
    taskMap,
    participantMap,
    assignmentsByParticipant,
    assignmentsByTask,
    // For non-Live-Mode callers (CLI/tests) we use the epoch so every task is
    // "future" and every assignment "modifiable" (matching the legacy
    // injection behaviour, which had no temporal gate beyond `assertInjectableTimeBlock`).
    anchor: opts.anchor ?? new Date(0),
    disabledHC,
    restRuleMap: engine.getRestRuleMap(),
    scheduleContext: engine.getScheduleContext(),
    config,
    scoreCtx,
    baselineComposite: baselineScore.compositeScore,
    extraUnavailability,
    excludeParticipantIds: new Set(),
  };

  const allowLowPriority = opts.allowLowPriority ?? true;
  const maxPlans = opts.maxPlans ?? 3;
  const baseBudgetMs = opts.timeBudgetMs ?? (task.slots.length >= 5 ? 1500 : 500);
  const caps = opts.caps ?? DEFAULT_CAPS;

  const searchResult = task.sameGroupRequired
    ? searchAcrossGroups(
        task,
        placeholders,
        slotCtx,
        baselineScore.compositeScore,
        caps,
        allowLowPriority,
        maxPlans,
        baseBudgetMs,
      )
    : searchOneGroup(
        task,
        placeholders,
        slotCtx,
        baselineScore.compositeScore,
        caps,
        allowLowPriority,
        null,
        maxPlans,
        baseBudgetMs,
      );

  // Rank and diversify.
  let ranked: InjectionPlan[];
  if (searchResult.plans.length === 0) {
    // Last-resort: fabricate a single all-unfilled plan so the UI has something
    // coherent to display ("no candidate available, here's why per slot").
    ranked = [buildEmptyPlan(task, slotCtx, null, schedule.assignments)];
  } else {
    const sorted = sortPlans(searchResult.plans);
    ranked = selectDiversePlans(sorted, maxPlans);
    for (let i = 0; i < ranked.length; i++) ranked[i].rank = i + 1;
  }

  const ctx: ApplyCtx = {
    schedule,
    engine,
    task,
    placeholders,
    createdAssignmentIds: [...placeholders.ids],
    mutatedSnapshots: new Map(),
    applied: false,
    removedPlaceholderIds: new Set(),
  };

  return {
    result: {
      task,
      plans: ranked,
      unsolvableSlotIds: searchResult.unsolvableSlotIds,
      timedOut: searchResult.timedOut,
      apply: (planId: string) => {
        const plan = ranked.find((p) => p.id === planId);
        if (!plan) return null;
        return applyInjectionPlan(ctx, plan);
      },
      cancel: () => rollbackAll(ctx),
    },
  };
}

// ─── Public entry: injectAndStaff (back-compat: auto-apply top plan) ────────

/**
 * Backwards-compatible entry: search + auto-apply the top-ranked plan.
 *
 * Returns `{ report, error }` where `report` represents the applied plan
 * (or, when no plan is found, an all-unfilled report). Existing callers
 * (legacy CLI scripts, tests) keep working unchanged. New UI callers should
 * use `searchInjectionPlans()` to present alternatives.
 *
 * The returned `report.rollback()` removes the entire injection (task +
 * mutations + placeholders), exactly like before.
 */
export function injectAndStaff(
  engine: SchedulingEngine,
  spec: InjectedTaskSpec,
  opts: InjectStaffOptions = {},
): { report: StaffingReport | null; error?: string } {
  const { result, error } = searchInjectionPlans(engine, spec, opts);
  if (!result) return { report: null, error };
  const top = result.plans[0];
  if (!top) {
    // Should never happen: searchInjectionPlans always returns at least the
    // empty-plan fallback. Defensive: surface a no-staff report.
    const cancelReport: StaffingReport = {
      task: result.task,
      outcomes: result.task.slots.map((s) => ({
        slotId: s.slotId,
        slotLabel: slotLabel(s, result.task),
        filled: false,
        reason: 'אין מועמד כשיר',
      })),
      fullyStaffed: false,
      rollback: result.cancel,
    };
    return { report: cancelReport };
  }
  const report = result.apply(top.id);
  if (!report) {
    // Shouldn't happen — apply only fails on unknown planId.
    result.cancel();
    return { report: null, error: 'invalid-spec' };
  }
  return { report };
}
