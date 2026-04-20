/**
 * BALTAM — Post-generation task injection & staffing.
 *
 * Injects a new one-time task into an existing schedule snapshot and aggressively
 * tries to staff each slot from the current participant pool.
 *
 * Algorithm:
 *
 *   0. **Slot ordering** — process slots by *tightness* (fewest level+cert-
 *      compatible candidates first). Prevents the "easy slot grabs the only
 *      participant qualified for a hard slot" greedy failure.
 *
 *   1. **Direct fill** — any currently-eligible participant, scored on per-day
 *      effective load (primary), non-lowPriority first, then total load.
 *
 *   2. **Depth-2 chain** — displace one of p's existing assignments A to a
 *      backfill q who is directly eligible for A.
 *
 *   3. **Depth-3 chain** — p→slot, p's A → q, q's B → r. Used only when
 *      depth-1/2 both fail. Pruned with top-K candidate caps to keep runtime
 *      bounded.
 *
 *   4. **Group backtracking for `sameGroupRequired`** — the whole pipeline
 *      runs once per candidate group and the trial filling the most slots
 *      (tie-broken by lowest total impact) wins.
 *
 * Every eligibility check funnels through `isEligible()` from validator.ts,
 * with `extraUnavailability` from the schedule's Future-SOS windows included.
 * All active hard constraints (HC-1..HC-8, HC-11, HC-12, HC-14) are enforced.
 *
 * The new task is marked `injectedPostGeneration = true` so orphan detection
 * (app.ts:scheduleHasOrphans) ignores it. Callers are responsible for
 * committing (revalidateFull + persistence) or rolling back via the returned
 * rollback helper.
 */

import {
  type Assignment,
  AssignmentStatus,
  type LoadWindow,
  type Participant,
  type Schedule,
  type ScheduleUnavailability,
  type SlotRequirement,
  type SlotTemplate,
  type SubTeamTemplate,
  type Task,
} from '../models/types';
import { operationalDateKey } from '../utils/date-utils';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import type { SchedulingEngine } from './scheduler';
import { isEligible } from './validator';

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
  displayCategory?: string;
  color?: string;
  description?: string;
}

/** One step in a displace-and-backfill chain. */
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

export interface StaffingReport {
  task: Task;
  outcomes: SlotStaffingOutcome[];
  fullyStaffed: boolean;
  /**
   * Restore the schedule to the pre-injection state. Removes the injected
   * task, deletes every assignment created by this injection, and reverts
   * every modified pre-existing assignment. Safe to call exactly once; after
   * calling, the caller should run revalidateFull().
   */
  rollback: () => void;
}

export interface InjectStaffOptions {
  /** Allow the staffer to consider `lowPriority` level placements. Default true. */
  allowLowPriority?: boolean;
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

// ─── Small helpers ──────────────────────────────────────────────────────────

function participantAssignments(pId: string, assignments: Assignment[]): Assignment[] {
  const out: Assignment[] = [];
  for (const a of assignments) if (a.participantId === pId) out.push(a);
  return out;
}

function taskAssignments(tId: string, assignments: Assignment[]): Assignment[] {
  const out: Assignment[] = [];
  for (const a of assignments) if (a.taskId === tId) out.push(a);
  return out;
}

function totalEffectiveLoad(pId: string, assignments: Assignment[], taskMap: Map<string, Task>): number {
  let total = 0;
  for (const a of assignments) {
    if (a.participantId !== pId) continue;
    const t = taskMap.get(a.taskId);
    if (t) total += computeTaskEffectiveHours(t);
  }
  return total;
}

function dayEffectiveLoad(
  pId: string,
  dayKey: string,
  dayStartHour: number,
  assignments: Assignment[],
  taskMap: Map<string, Task>,
): number {
  let total = 0;
  for (const a of assignments) {
    if (a.participantId !== pId) continue;
    const t = taskMap.get(a.taskId);
    if (!t) continue;
    if (operationalDateKey(t.timeBlock.start, dayStartHour) !== dayKey) continue;
    total += computeTaskEffectiveHours(t);
  }
  return total;
}

function slotLabel(slot: SlotRequirement): string {
  if (slot.subTeamLabel && slot.label) return `${slot.subTeamLabel} / ${slot.label}`;
  return slot.subTeamLabel || slot.label || slot.slotId;
}

function isLowPriorityOnly(participant: Participant, slot: SlotRequirement): boolean {
  const entry = slot.acceptableLevels.find((le) => le.level === participant.level);
  return !!entry?.lowPriority;
}

/**
 * Coarse pre-filter: level + certs compatible with the slot, honoring
 * disabledHC. Used to narrow the candidate pool before expensive conflict
 * checks; always a superset of isEligible's verdict.
 */
function levelCertCompatible(p: Participant, slot: SlotRequirement, disabledHC?: Set<string>): boolean {
  if (!disabledHC?.has('HC-11') && slot.forbiddenCertifications?.some((c) => p.certifications.includes(c)))
    return false;
  if (!disabledHC?.has('HC-1') && !slot.acceptableLevels.some((le) => le.level === p.level)) return false;
  if (!disabledHC?.has('HC-2') && !slot.requiredCertifications.every((c) => p.certifications.includes(c))) return false;
  return true;
}

// ─── Task construction ──────────────────────────────────────────────────────

/**
 * Build the Task object from a spec. Mirrors the one-time-task expansion
 * path in app.ts:generateTasksFromTemplates — kept in lock-step manually
 * rather than imported to avoid coupling the engine to web-layer code.
 */
export function buildInjectedTask(spec: InjectedTaskSpec, periodStart: Date, periodDays: number): Task | null {
  if (spec.dayIndex < 1 || spec.dayIndex > periodDays) return null;
  if (spec.durationHours <= 0) return null;

  const day = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate() + (spec.dayIndex - 1));
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), spec.startHour, spec.startMinute);
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

  const task: Task = {
    id: nextInjTaskId(spec.name),
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
    displayCategory: spec.displayCategory,
    color: spec.color || '#c0392b',
    injectedPostGeneration: true,
  };
  return task;
}

// ─── Staffing context ───────────────────────────────────────────────────────

interface StaffingCtx {
  task: Task;
  engine: SchedulingEngine;
  schedule: Schedule;
  taskMap: Map<string, Task>;
  participantMap: Map<string, Participant>;
  disabledHC?: Set<string>;
  restRuleMap?: Map<string, number>;
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }>;
  allowLowPriority: boolean;
  dayStartHour: number;
  /** Operational-day key for the injected task, used to score by per-day load. */
  injectedDayKey: string;
  /** Group locked in for sameGroupRequired tasks (null = not yet locked). */
  groupLock: string | null;
  /** Created assignment IDs so we can roll back. */
  createdAssignmentIds: string[];
  /** Snapshot of mutated pre-existing assignments keyed by id. */
  mutatedAssignmentSnapshots: Map<string, { participantId: string; status: AssignmentStatus; updatedAt: Date }>;
}

/** Standard EligibilityOpts for checks against schedule state. */
function eligOpts(ctx: StaffingCtx, taskAssignmentsForCheck: Assignment[]) {
  return {
    checkSameGroup: true,
    taskAssignments: taskAssignmentsForCheck,
    participantMap: ctx.participantMap,
    disabledHC: ctx.disabledHC,
    restRuleMap: ctx.restRuleMap,
    extraUnavailability: ctx.extraUnavailability,
  };
}

// ─── Slot ordering by tightness ─────────────────────────────────────────────

/**
 * Count coarse (level+cert+group) candidates for a slot. Lower count = tighter.
 * We do NOT include conflict checks here — that would change as slots fill and
 * we want a stable initial ordering.
 */
function tightnessScore(ctx: StaffingCtx, slot: SlotRequirement, groupLock: string | null): number {
  let count = 0;
  for (const p of ctx.schedule.participants) {
    if (groupLock !== null && p.group !== groupLock) continue;
    if (!levelCertCompatible(p, slot, ctx.disabledHC)) continue;
    if (!ctx.allowLowPriority && isLowPriorityOnly(p, slot)) continue;
    count++;
  }
  return count;
}

function orderSlotsByTightness(ctx: StaffingCtx, slots: SlotRequirement[]): SlotRequirement[] {
  return [...slots].sort((a, b) => tightnessScore(ctx, a, ctx.groupLock) - tightnessScore(ctx, b, ctx.groupLock));
}

// ─── Phase 1: Direct fill ───────────────────────────────────────────────────

function pickDirectCandidate(ctx: StaffingCtx, slot: SlotRequirement): Participant | null {
  const task = ctx.task;
  const schedule = ctx.schedule;
  const thisTaskAssignments = taskAssignments(task.id, schedule.assignments);

  const candidates: { p: Participant; lowPrio: boolean; dayLoad: number; totalLoad: number }[] = [];

  for (const p of schedule.participants) {
    if (task.sameGroupRequired && ctx.groupLock !== null && p.group !== ctx.groupLock) continue;
    const lowPrio = isLowPriorityOnly(p, slot);
    if (lowPrio && !ctx.allowLowPriority) continue;
    if (!levelCertCompatible(p, slot, ctx.disabledHC)) continue;

    const pAssignments = participantAssignments(p.id, schedule.assignments);
    if (!isEligible(p, task, slot, pAssignments, ctx.taskMap, eligOpts(ctx, thisTaskAssignments))) continue;

    candidates.push({
      p,
      lowPrio,
      dayLoad: dayEffectiveLoad(p.id, ctx.injectedDayKey, ctx.dayStartHour, schedule.assignments, ctx.taskMap),
      totalLoad: totalEffectiveLoad(p.id, schedule.assignments, ctx.taskMap),
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.lowPrio !== b.lowPrio) return a.lowPrio ? 1 : -1;
    if (a.dayLoad !== b.dayLoad) return a.dayLoad - b.dayLoad;
    return a.totalLoad - b.totalLoad;
  });
  return candidates[0].p;
}

// ─── Candidate ranking for displacement phases ──────────────────────────────

interface RankedCandidate {
  p: Participant;
  lowPrio: boolean;
  dayLoad: number;
  totalLoad: number;
}

function rankedCandidatesForSlot(
  ctx: StaffingCtx,
  slot: SlotRequirement,
  dayKeyForLoad: string,
  respectGroupLock: boolean,
): RankedCandidate[] {
  const out: RankedCandidate[] = [];
  for (const p of ctx.schedule.participants) {
    if (respectGroupLock && ctx.task.sameGroupRequired && ctx.groupLock !== null && p.group !== ctx.groupLock) continue;
    if (!levelCertCompatible(p, slot, ctx.disabledHC)) continue;
    const lowPrio = isLowPriorityOnly(p, slot);
    if (lowPrio && !ctx.allowLowPriority) continue;
    out.push({
      p,
      lowPrio,
      dayLoad: dayEffectiveLoad(p.id, dayKeyForLoad, ctx.dayStartHour, ctx.schedule.assignments, ctx.taskMap),
      totalLoad: totalEffectiveLoad(p.id, ctx.schedule.assignments, ctx.taskMap),
    });
  }
  out.sort((a, b) => {
    if (a.lowPrio !== b.lowPrio) return a.lowPrio ? 1 : -1;
    if (a.dayLoad !== b.dayLoad) return a.dayLoad - b.dayLoad;
    return a.totalLoad - b.totalLoad;
  });
  return out;
}

/**
 * Return p's existing assignments that are plausible displacement candidates
 * to resolve their conflict with the target slot. We iterate the
 * participant's assignments and keep those that — when removed — would make
 * p eligible for (task, slot). This is exact: depth-2 with any of these
 * assignments as `displaced` will succeed for p's eligibility.
 */
function resolvingDisplacements(
  ctx: StaffingCtx,
  p: Participant,
  pAssignments: Assignment[],
  task: Task,
  slot: SlotRequirement,
  thisTaskAssignments: Assignment[],
  maxResults: number,
): Assignment[] {
  const out: Assignment[] = [];
  for (const a of pAssignments) {
    if (out.length >= maxResults) break;
    const aTask = ctx.taskMap.get(a.taskId);
    if (!aTask || aTask.id === task.id) continue; // don't displace own-task slots
    if (a.status === AssignmentStatus.Frozen) continue;
    const pMinus = pAssignments.filter((x) => x.id !== a.id);
    if (isEligible(p, task, slot, pMinus, ctx.taskMap, eligOpts(ctx, thisTaskAssignments))) {
      out.push(a);
    }
  }
  return out;
}

// ─── Phase 2: Depth-2 chain ─────────────────────────────────────────────────

interface Depth2Chain {
  fill: Participant;
  displaced: Assignment;
  displacedTask: Task;
  displacedSlot: SlotRequirement;
  backfill: Participant;
  impact: number;
}

// Caps (tunable) — bound the combinatorial explosion of displacement search.
const MAX_FILL_CANDIDATES = 15;
const MAX_DISPLACEMENTS_PER_P = 3;
const MAX_Q_CANDIDATES = 15;
const MAX_DISPLACEMENTS_PER_Q = 3;

function pickDisplaceChainDepth2(ctx: StaffingCtx, slot: SlotRequirement): Depth2Chain | null {
  const task = ctx.task;
  const schedule = ctx.schedule;
  const thisTaskAssignments = taskAssignments(task.id, schedule.assignments);

  let best: Depth2Chain | null = null;

  const pCandidates = rankedCandidatesForSlot(ctx, slot, ctx.injectedDayKey, true).slice(0, MAX_FILL_CANDIDATES);

  for (const pc of pCandidates) {
    const p = pc.p;
    const pAssignments = participantAssignments(p.id, schedule.assignments);

    const displaceableAs = resolvingDisplacements(
      ctx,
      p,
      pAssignments,
      task,
      slot,
      thisTaskAssignments,
      MAX_DISPLACEMENTS_PER_P,
    );

    for (const displaced of displaceableAs) {
      const displacedTask = ctx.taskMap.get(displaced.taskId);
      if (!displacedTask) continue;
      const displacedSlot = displacedTask.slots.find((s) => s.slotId === displaced.slotId);
      if (!displacedSlot) continue;

      const displacedTaskAssignmentsMinus = taskAssignments(displacedTask.id, schedule.assignments).filter(
        (a) => a.id !== displaced.id,
      );
      const displacedDayKey = operationalDateKey(displacedTask.timeBlock.start, ctx.dayStartHour);

      // Find best backfill q directly eligible for the displaced slot.
      let bestQ: RankedCandidate | null = null;
      for (const qc of rankedCandidatesForSlot(ctx, displacedSlot, displacedDayKey, false)) {
        if (qc.p.id === p.id) continue;
        const qAssignments = participantAssignments(qc.p.id, schedule.assignments);
        if (
          !isEligible(
            qc.p,
            displacedTask,
            displacedSlot,
            qAssignments,
            ctx.taskMap,
            eligOpts(ctx, displacedTaskAssignmentsMinus),
          )
        )
          continue;
        // Pre-sorted: first hit is optimal.
        bestQ = qc;
        break;
      }
      if (!bestQ) continue;

      const lowPrioPenalty = (pc.lowPrio ? 1000 : 0) + (bestQ.lowPrio ? 500 : 0);
      // Chain-length penalty keeps depth-2 plans preferred over depth-3 at equal day loads.
      const impact = pc.dayLoad + bestQ.dayLoad + lowPrioPenalty + 10;
      if (best === null || impact < best.impact) {
        best = { fill: p, displaced, displacedTask, displacedSlot, backfill: bestQ.p, impact };
      }
    }
  }

  return best;
}

// ─── Phase 3: Depth-3 chain ─────────────────────────────────────────────────

interface Depth3Chain {
  fill: Participant;
  displacedA: Assignment;
  displacedATask: Task;
  displacedASlot: SlotRequirement;
  backfillQ: Participant;
  displacedB: Assignment;
  displacedBTask: Task;
  displacedBSlot: SlotRequirement;
  backfillR: Participant;
  impact: number;
}

function pickDisplaceChainDepth3(ctx: StaffingCtx, slot: SlotRequirement): Depth3Chain | null {
  const task = ctx.task;
  const schedule = ctx.schedule;
  const thisTaskAssignments = taskAssignments(task.id, schedule.assignments);

  let best: Depth3Chain | null = null;

  const pCandidates = rankedCandidatesForSlot(ctx, slot, ctx.injectedDayKey, true).slice(0, MAX_FILL_CANDIDATES);

  for (const pc of pCandidates) {
    const p = pc.p;
    const pAssignments = participantAssignments(p.id, schedule.assignments);

    const displaceableAs = resolvingDisplacements(
      ctx,
      p,
      pAssignments,
      task,
      slot,
      thisTaskAssignments,
      MAX_DISPLACEMENTS_PER_P,
    );

    for (const displacedA of displaceableAs) {
      const aTask = ctx.taskMap.get(displacedA.taskId);
      if (!aTask) continue;
      const aSlot = aTask.slots.find((s) => s.slotId === displacedA.slotId);
      if (!aSlot) continue;

      const aTaskAssignmentsMinus = taskAssignments(aTask.id, schedule.assignments).filter(
        (x) => x.id !== displacedA.id,
      );
      const aDayKey = operationalDateKey(aTask.timeBlock.start, ctx.dayStartHour);

      const qCandidates = rankedCandidatesForSlot(ctx, aSlot, aDayKey, false).slice(0, MAX_Q_CANDIDATES);

      for (const qc of qCandidates) {
        const q = qc.p;
        if (q.id === p.id) continue;
        const qAssignments = participantAssignments(q.id, schedule.assignments);

        // If q is directly eligible for A, this would have been a depth-2 solution;
        // skip so depth-3 only catches the cases depth-2 misses.
        if (isEligible(q, aTask, aSlot, qAssignments, ctx.taskMap, eligOpts(ctx, aTaskAssignmentsMinus))) continue;

        const displaceableBs = resolvingDisplacements(
          ctx,
          q,
          qAssignments,
          aTask,
          aSlot,
          aTaskAssignmentsMinus,
          MAX_DISPLACEMENTS_PER_Q,
        );

        for (const displacedB of displaceableBs) {
          const bTask = ctx.taskMap.get(displacedB.taskId);
          if (!bTask) continue;
          // Never chain through the injected task or back through A's task.
          if (bTask.id === task.id) continue;
          if (displacedB.id === displacedA.id) continue;
          const bSlot = bTask.slots.find((s) => s.slotId === displacedB.slotId);
          if (!bSlot) continue;

          const bTaskAssignmentsMinus = taskAssignments(bTask.id, schedule.assignments).filter(
            (x) => x.id !== displacedB.id,
          );
          const bDayKey = operationalDateKey(bTask.timeBlock.start, ctx.dayStartHour);

          // Find best r directly eligible for B's slot.
          let bestR: RankedCandidate | null = null;
          for (const rc of rankedCandidatesForSlot(ctx, bSlot, bDayKey, false)) {
            if (rc.p.id === p.id || rc.p.id === q.id) continue;
            const rAssignments = participantAssignments(rc.p.id, schedule.assignments);
            if (!isEligible(rc.p, bTask, bSlot, rAssignments, ctx.taskMap, eligOpts(ctx, bTaskAssignmentsMinus)))
              continue;
            bestR = rc;
            break;
          }
          if (!bestR) continue;

          const lowPrioPenalty = (pc.lowPrio ? 1000 : 0) + (qc.lowPrio ? 500 : 0) + (bestR.lowPrio ? 250 : 0);
          // +20 chain penalty > depth-2's +10, keeping d2 preferred at equal day loads.
          const impact = pc.dayLoad + qc.dayLoad + bestR.dayLoad + lowPrioPenalty + 20;
          if (best === null || impact < best.impact) {
            best = {
              fill: p,
              displacedA,
              displacedATask: aTask,
              displacedASlot: aSlot,
              backfillQ: q,
              displacedB,
              displacedBTask: bTask,
              displacedBSlot: bSlot,
              backfillR: bestR.p,
              impact,
            };
          }
        }
      }
    }
  }

  return best;
}

// ─── Mutations & rollback ───────────────────────────────────────────────────

function createAssignment(ctx: StaffingCtx, slot: SlotRequirement, participantId: string): Assignment {
  const a: Assignment = {
    id: nextInjAssignmentId(),
    taskId: ctx.task.id,
    slotId: slot.slotId,
    participantId,
    status: AssignmentStatus.Manual,
    updatedAt: new Date(),
  };
  ctx.schedule.assignments.push(a);
  ctx.createdAssignmentIds.push(a.id);
  return a;
}

function mutateAssignment(ctx: StaffingCtx, assignmentId: string, newParticipantId: string): void {
  const a = ctx.schedule.assignments.find((x) => x.id === assignmentId);
  if (!a) return;
  if (!ctx.mutatedAssignmentSnapshots.has(a.id)) {
    ctx.mutatedAssignmentSnapshots.set(a.id, {
      participantId: a.participantId,
      status: a.status,
      updatedAt: a.updatedAt,
    });
  }
  a.participantId = newParticipantId;
  a.status = AssignmentStatus.Manual;
  a.updatedAt = new Date();
}

/** Roll back only the assignment-level mutations recorded on ctx (not the task). */
function rollbackAssignments(ctx: StaffingCtx): void {
  if (ctx.createdAssignmentIds.length > 0) {
    const ids = new Set(ctx.createdAssignmentIds);
    for (let i = ctx.schedule.assignments.length - 1; i >= 0; i--) {
      if (ids.has(ctx.schedule.assignments[i].id)) ctx.schedule.assignments.splice(i, 1);
    }
    ctx.createdAssignmentIds.length = 0;
  }
  for (const [id, snap] of ctx.mutatedAssignmentSnapshots) {
    const a = ctx.schedule.assignments.find((x) => x.id === id);
    if (!a) continue;
    a.participantId = snap.participantId;
    a.status = snap.status;
    a.updatedAt = snap.updatedAt;
  }
  ctx.mutatedAssignmentSnapshots.clear();
}

/** Full rollback: assignment state + remove the task. */
function buildFullRollback(ctx: StaffingCtx): () => void {
  return () => {
    rollbackAssignments(ctx);
    const tId = ctx.task.id;
    const idx = ctx.schedule.tasks.findIndex((t) => t.id === tId);
    if (idx >= 0) ctx.schedule.tasks.splice(idx, 1);
    ctx.engine.removeTask(tId);
  };
}

// ─── Per-slot staffing pipeline ─────────────────────────────────────────────

function staffSlot(ctx: StaffingCtx, slot: SlotRequirement): SlotStaffingOutcome {
  const label = slotLabel(slot);

  // Phase 1: direct fill.
  const direct = pickDirectCandidate(ctx, slot);
  if (direct) {
    createAssignment(ctx, slot, direct.id);
    if (ctx.task.sameGroupRequired && ctx.groupLock === null) ctx.groupLock = direct.group;
    return { slotId: slot.slotId, slotLabel: label, filled: true, participantId: direct.id };
  }

  // Phase 2: depth-2 displacement.
  const d2 = pickDisplaceChainDepth2(ctx, slot);
  if (d2) {
    mutateAssignment(ctx, d2.displaced.id, d2.backfill.id);
    createAssignment(ctx, slot, d2.fill.id);
    if (ctx.task.sameGroupRequired && ctx.groupLock === null) ctx.groupLock = d2.fill.group;
    return {
      slotId: slot.slotId,
      slotLabel: label,
      filled: true,
      participantId: d2.fill.id,
      swapChain: [
        {
          assignmentId: d2.displaced.id,
          fromParticipantId: d2.fill.id,
          toParticipantId: d2.backfill.id,
          taskId: d2.displacedTask.id,
          taskName: d2.displacedTask.name,
          slotLabel: slotLabel(d2.displacedSlot),
        },
      ],
    };
  }

  // Phase 3: depth-3 displacement.
  const d3 = pickDisplaceChainDepth3(ctx, slot);
  if (d3) {
    // Apply in order: move B to r first, then A to q, then create p's new assignment.
    // This is only correctness-neutral because we already validated each link; order
    // within the chain doesn't change final state, but applying leaf-first keeps
    // intermediate state valid if any later code were to inspect it.
    mutateAssignment(ctx, d3.displacedB.id, d3.backfillR.id);
    mutateAssignment(ctx, d3.displacedA.id, d3.backfillQ.id);
    createAssignment(ctx, slot, d3.fill.id);
    if (ctx.task.sameGroupRequired && ctx.groupLock === null) ctx.groupLock = d3.fill.group;
    return {
      slotId: slot.slotId,
      slotLabel: label,
      filled: true,
      participantId: d3.fill.id,
      swapChain: [
        {
          assignmentId: d3.displacedA.id,
          fromParticipantId: d3.fill.id,
          toParticipantId: d3.backfillQ.id,
          taskId: d3.displacedATask.id,
          taskName: d3.displacedATask.name,
          slotLabel: slotLabel(d3.displacedASlot),
        },
        {
          assignmentId: d3.displacedB.id,
          fromParticipantId: d3.backfillQ.id,
          toParticipantId: d3.backfillR.id,
          taskId: d3.displacedBTask.id,
          taskName: d3.displacedBTask.name,
          slotLabel: slotLabel(d3.displacedBSlot),
        },
      ],
    };
  }

  // All phases failed.
  return { slotId: slot.slotId, slotLabel: label, filled: false, reason: 'HC-6' };
}

// ─── Full-task trials (shared by the simple and group-backtracking paths) ──

interface TrialOutcome {
  outcomes: SlotStaffingOutcome[];
  filledCount: number;
  impactSum: number;
}

function runTrial(ctx: StaffingCtx): TrialOutcome {
  const ordered = orderSlotsByTightness(ctx, ctx.task.slots);
  const outcomes: SlotStaffingOutcome[] = [];
  let impactSum = 0;
  for (const slot of ordered) {
    const outcome = staffSlot(ctx, slot);
    outcomes.push(outcome);
    // Implicit impact by chain length: unfilled 0, direct 1, d2 2, d3 3.
    if (!outcome.filled) impactSum += 0;
    else impactSum += 1 + (outcome.swapChain?.length ?? 0);
  }
  // Re-map outcomes to the task's original slot order so the UI matches the spec.
  const byId = new Map(outcomes.map((o) => [o.slotId, o]));
  // biome-ignore lint/style/noNonNullAssertion: every slot processed in the loop
  const ordered2 = ctx.task.slots.map((s) => byId.get(s.slotId)!);
  return { outcomes: ordered2, filledCount: outcomes.filter((o) => o.filled).length, impactSum };
}

// ─── Group backtracking for sameGroupRequired tasks ─────────────────────────

/**
 * Candidate groups: those with at least one participant level+cert-compatible
 * with at least one slot. Filters wildly-unqualified groups early to keep
 * the backtracking loop bounded.
 */
function candidateGroups(ctx: StaffingCtx): string[] {
  const groups = new Set<string>();
  for (const p of ctx.schedule.participants) {
    for (const slot of ctx.task.slots) {
      if (levelCertCompatible(p, slot, ctx.disabledHC)) {
        groups.add(p.group);
        break;
      }
    }
  }
  return [...groups];
}

function runWithGroupBacktracking(ctx: StaffingCtx): TrialOutcome {
  const groups = candidateGroups(ctx);
  if (groups.length === 0) {
    // Nothing to try — return an all-unfilled trial.
    return runTrial(ctx);
  }

  let best: TrialOutcome | null = null;
  for (const g of groups) {
    ctx.groupLock = g;
    const trial = runTrial(ctx);
    if (
      best === null ||
      trial.filledCount > best.filledCount ||
      (trial.filledCount === best.filledCount && trial.impactSum < best.impactSum)
    ) {
      // This trial beats the previous best — discard previous and keep this.
      if (best) rollbackAssignments(ctx);
      best = trial;
    } else {
      // Discard this trial.
      rollbackAssignments(ctx);
    }
  }
  return best ?? runTrial(ctx);
}

// ─── Entry point ────────────────────────────────────────────────────────────

export function injectAndStaff(
  engine: SchedulingEngine,
  spec: InjectedTaskSpec,
  opts: InjectStaffOptions = {},
): { report: StaffingReport | null; error?: string } {
  const schedule = engine.getSchedule();
  if (!schedule) return { report: null, error: 'no-schedule' };

  const task = buildInjectedTask(spec, schedule.periodStart, schedule.periodDays);
  if (!task) return { report: null, error: 'invalid-spec' };

  // Commit the task to engine + snapshot. All mutations below are reverted
  // by the returned rollback() if the caller cancels.
  engine.addTask(task);
  schedule.tasks.push(task);

  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const participantMap = new Map<string, Participant>();
  for (const p of schedule.participants) participantMap.set(p.id, p);

  const dayStartHour = engine.getDayStartHour();
  const injectedDayKey = operationalDateKey(task.timeBlock.start, dayStartHour);

  // HC-3 layers schedule-scoped unavailability on top of master availability.
  // Pull the frozen snapshot — this is what the engine validates against.
  const scheduleUnavail: ScheduleUnavailability[] = schedule.scheduleUnavailability ?? [];
  const extraUnavailability = scheduleUnavail.map((u) => ({
    participantId: u.participantId,
    start: u.start,
    end: u.end,
  }));

  const ctx: StaffingCtx = {
    task,
    engine,
    schedule,
    taskMap,
    participantMap,
    disabledHC: engine.getDisabledHC(),
    restRuleMap: engine.getRestRuleMap(),
    extraUnavailability,
    allowLowPriority: opts.allowLowPriority ?? true,
    dayStartHour,
    injectedDayKey,
    groupLock: null,
    createdAssignmentIds: [],
    mutatedAssignmentSnapshots: new Map(),
  };

  const trial = task.sameGroupRequired ? runWithGroupBacktracking(ctx) : runTrial(ctx);

  const report: StaffingReport = {
    task,
    outcomes: trial.outcomes,
    fullyStaffed: trial.outcomes.every((o) => o.filled),
    rollback: buildFullRollback(ctx),
  };
  return { report };
}
