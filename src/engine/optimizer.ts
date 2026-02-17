/**
 * Optimizer - Max-Min Fairness scheduler with penalty/bonus heuristics.
 *
 * Uses a greedy constructive heuristic followed by local search (swap-based)
 * to maximize the composite score (rest fairness + penalties + bonuses).
 *
 * Algorithm:
 *  1. Greedy Phase: Assign participants to task slots respecting hard constraints,
 *     using a priority that favors participants with the most accumulated rest.
 *  2. Local Search Phase: Iteratively try swaps between assignments to improve
 *     composite score, accepting improvements only.
 */

import {
  Task,
  Assignment,
  Participant,
  AssignmentStatus,
  SchedulerConfig,
  ScheduleScore,
  TaskType,
  Level,
  SlotRequirement,
} from '../models/types';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { validateHardConstraints } from '../constraints/hard-constraints';
import { computeScheduleScore } from '../constraints/soft-constraints';
import { computeTaskEffectiveHours } from '../web/utils/load-weighting';

/** Task types strictly forbidden for L4 participants (R4: hoisted to module scope) */
const FORBIDDEN_FOR_L4: TaskType[] = [TaskType.Shemesh, TaskType.Aruga, TaskType.Hamama];

/** P4: Add an assignment into the per-participant index */
function addToAssignmentMap(map: Map<string, Assignment[]>, a: Assignment): void {
  const arr = map.get(a.participantId);
  if (arr) arr.push(a);
  else map.set(a.participantId, [a]);
}

/** P4: Build a per-participant assignment index */
function buildAssignmentMap(assignments: Assignment[]): Map<string, Assignment[]> {
  const map = new Map<string, Assignment[]>();
  for (const a of assignments) addToAssignmentMap(map, a);
  return map;
}

let _assignmentCounter = 0;
function nextAssignmentId(): string {
  return `asgn-${++_assignmentCounter}`;
}

/** Reset counter (for testing) */
export function resetAssignmentCounter(): void {
  _assignmentCounter = 0;
}

// ─── Eligibility Checks ─────────────────────────────────────────────────────

/**
 * Check if a participant is eligible for a specific slot in a task,
 * considering current assignments (no double-booking of non-light tasks).
 */
/** Enable/disable verbose diagnostic logging */
let _diagnosticLogging = false;

/** Toggle scheduler diagnostic logging (call from console: toggleSchedulerDiag()) */
export function toggleSchedulerDiag(on?: boolean): void {
  _diagnosticLogging = on !== undefined ? on : !_diagnosticLogging;
  console.log(`[Scheduler] Diagnostic logging: ${_diagnosticLogging ? 'ON' : 'OFF'}`);
}

// Expose globally for browser console use
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).toggleSchedulerDiag = toggleSchedulerDiag;
}

function isEligibleForSlot(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
): boolean {
  const _tag = `${participant.name} → ${task.name} [${slot.label || slot.slotId}]`;

  // HC-NEW: L4 is strictly forbidden from Shemesh, Aruga, and Hamama
  if (participant.level === Level.L4) {
    if (FORBIDDEN_FOR_L4.includes(task.type)) {
      if (_diagnosticLogging) console.log(`[Elig] REJECT L4-forbidden: ${_tag} — L4 cannot serve ${task.type}`);
      return false;
    }
  }

  // HC-11: Choresh participants are strictly forbidden from Mamtera
  if (participant.chopidr && task.type === TaskType.Mamtera) {
    if (_diagnosticLogging) console.log(`[Elig] REJECT choresh-mamtera: ${_tag} — Choresh cannot serve Mamtera`);
    return false;
  }

  // Level check: accept explicit match OR "level higher than max listed" (e.g., L2 can fill an L0 slot)
  const levelOk = slot.acceptableLevels.includes(participant.level)
    || participant.level > Math.max(...slot.acceptableLevels);
  if (!levelOk) {
    if (_diagnosticLogging) console.log(`[Elig] REJECT level: ${_tag} — L${participant.level} not in [${slot.acceptableLevels.map(l => 'L' + l)}]`);
    return false;
  }

  // Certification check
  for (const cert of slot.requiredCertifications) {
    if (!participant.certifications.includes(cert)) {
      if (_diagnosticLogging) console.log(`[Elig] REJECT cert: ${_tag} — missing ${cert}`);
      return false;
    }
  }

  // Availability check
  if (!isFullyCovered(task.timeBlock, participant.availability)) {
    if (_diagnosticLogging) console.log(`[Elig] REJECT avail: ${_tag}`);
    return false;
  }

  // Double-booking check: physical presence is exclusive for ALL tasks (including light)
  for (const a of participantAssignments) {
    const otherTask = taskMap.get(a.taskId);
    if (otherTask && blocksOverlap(task.timeBlock, otherTask.timeBlock)) {
      if (_diagnosticLogging) console.log(`[Elig] REJECT double-book: ${_tag} — overlaps ${otherTask.name}`);
      return false;
    }
  }

  // Already assigned to this task?
  const alreadyInTask = participantAssignments.some(
    (a) => a.taskId === task.id,
  );
  if (alreadyInTask) {
    if (_diagnosticLogging) console.log(`[Elig] REJECT already-in-task: ${_tag}`);
    return false;
  }

  return true;
}

/**
 * Get all eligible participants for a slot, sorted by priority.
 */
function getEligibleCandidates(
  task: Task,
  slot: SlotRequirement,
  participants: Participant[],
  assignmentsByParticipant: Map<string, Assignment[]>,
  taskMap: Map<string, Task>,
  participantWorkload: Map<string, number>,
): Participant[] {
  const eligible = participants.filter((p) =>
    isEligibleForSlot(p, task, slot, assignmentsByParticipant.get(p.id) || [], taskMap),
  );

  // ── C1 FIX: Single composite comparator ──
  // Merges what were three sequential (destructive) sorts into one stable sort.
  // Adanit:     exact-level → workload → level → random
  // Non-Adanit: (Hamama: level pref) → workload → exact-level → level → random
  eligible.sort((a, b) => {
    if (task.type === TaskType.Adanit) {
      // T1: exact level match vs overqualified
      const aExact = slot.acceptableLevels.includes(a.level) ? 0 : 1;
      const bExact = slot.acceptableLevels.includes(b.level) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      // T2: workload ascending (fairness)
      const wa = participantWorkload.get(a.id) || 0;
      const wb = participantWorkload.get(b.id) || 0;
      if (wa !== wb) return wa - wb;
      // T3: level ascending
      if (a.level !== b.level) return a.level - b.level;
      // T4: random tiebreak
      return Math.random() - 0.5;
    }

    // ── All non-Adanit tasks ──
    // Hamama-specific: prefer L0 > L3
    if (task.type === TaskType.Hamama) {
      const hp = (l: Level): number => l === Level.L0 ? 0 : l === Level.L3 ? 1 : 2;
      const d = hp(a.level) - hp(b.level);
      if (d !== 0) return d;
    }

    // Primary fairness driver: workload ascending
    const wa = participantWorkload.get(a.id) || 0;
    const wb = participantWorkload.get(b.id) || 0;
    if (wa !== wb) return wa - wb;

    // Prefer exact level match
    const aExact = slot.acceptableLevels.includes(a.level) ? 0 : 1;
    const bExact = slot.acceptableLevels.includes(b.level) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // Level ascending
    if (a.level !== b.level) return a.level - b.level;

    // Random tiebreak
    return Math.random() - 0.5;
  });

  return eligible;
}

// ─── Greedy Phase ────────────────────────────────────────────────────────────

/**
 * Sort tasks for assignment order. Constrained tasks first:
 * Adanit (same-group, complex), then Hamama, then others.
 */
function sortTasksByDifficulty(tasks: Task[]): Task[] {
  const priority: Record<string, number> = {
    [TaskType.Adanit]: 0,
    [TaskType.Hamama]: 1,
    [TaskType.Karov]: 2,
    [TaskType.Mamtera]: 3,
    [TaskType.Shemesh]: 4,
    [TaskType.Aruga]: 5,
    [TaskType.Karovit]: 6,
  };
  return [...tasks].sort((a, b) => {
    const pa = priority[a.type] ?? 99;
    const pb = priority[b.type] ?? 99;
    if (pa !== pb) return pa - pb;
    const ta = a.timeBlock.start.getTime();
    const tb = b.timeBlock.start.getTime();
    if (ta !== tb) return ta - tb;
    // Random tiebreak within same priority+time tier for multi-attempt diversity
    return Math.random() - 0.5;
  });
}

/**
 * Greedy construction: assign participants to all task slots.
 * Returns assignments (may be partial if infeasible).
 */
export function greedyAssign(
  tasks: Task[],
  participants: Participant[],
  lockedAssignments: Assignment[] = [],
): { assignments: Assignment[]; unfilledSlots: { taskId: string; slotId: string; reason: string }[] } {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const assignments: Assignment[] = [...lockedAssignments];
  const unfilledSlots: { taskId: string; slotId: string; reason: string }[] = [];

  // P4: Pre-build per-participant assignment index for O(1) lookups
  const assignmentsByParticipant = buildAssignmentMap(lockedAssignments);

  // Track workload
  const workload = new Map<string, number>();
  for (const p of participants) workload.set(p.id, 0);
  for (const a of lockedAssignments) {
    const task = taskMap.get(a.taskId);
    if (task && !task.isLight) {
      workload.set(
        a.participantId,
        (workload.get(a.participantId) || 0) + computeTaskEffectiveHours(task),
      );
    }
  }

  const sortedTasks = sortTasksByDifficulty(tasks);

  for (const task of sortedTasks) {
    // For same-group tasks (Adanit), we need special handling
    if (task.sameGroupRequired) {
      const assigned = assignSameGroupTask(task, participants, assignments, taskMap, workload, assignmentsByParticipant);
      if (!assigned) {
        // Mark all slots as unfilled with specific reasons
        for (const slot of task.slots) {
          const alreadyFilled = assignments.some(
            (a) => a.taskId === task.id && a.slotId === slot.slotId,
          );
          if (!alreadyFilled) {
            const levelStr = slot.acceptableLevels.map((l) => 'L' + l).join('/');
            const certStr = slot.requiredCertifications.length > 0
              ? ` with ${slot.requiredCertifications.join(', ')} cert` : '';
            const reason = `No group can fill all ${task.name} slots. Missing ${levelStr}${certStr} for ${task.name}`;
            unfilledSlots.push({ taskId: task.id, slotId: slot.slotId, reason });
          }
        }
      }
      continue;
    }

    // Standard slot-by-slot assignment — fill most-constrained slots first
    const orderedSlots = [...task.slots].sort(
      (a, b) => Math.min(...b.acceptableLevels) - Math.min(...a.acceptableLevels),
    );
    for (const slot of orderedSlots) {
      // Skip if already assigned (locked)
      const existing = assignments.find(
        (a) => a.taskId === task.id && a.slotId === slot.slotId,
      );
      if (existing) continue;

      const candidates = getEligibleCandidates(
        task,
        slot,
        participants,
        assignmentsByParticipant,
        taskMap,
        workload,
      );

      if (candidates.length > 0) {
        const chosen = candidates[0];
        const newAssignment: Assignment = {
          id: nextAssignmentId(),
          taskId: task.id,
          slotId: slot.slotId,
          participantId: chosen.id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        assignments.push(newAssignment);
        addToAssignmentMap(assignmentsByParticipant, newAssignment);
        if (!task.isLight) {
          workload.set(chosen.id, (workload.get(chosen.id) || 0) + computeTaskEffectiveHours(task));
        }
      } else {
        // Build specific reason for why this slot can't be filled
        const levelStr = slot.acceptableLevels.map((l) => 'L' + l).join('/');
        const certStr = slot.requiredCertifications.length > 0
          ? ` with ${slot.requiredCertifications.join(', ')} cert` : '';
        const reason = `Missing ${levelStr}${certStr} for ${task.name}`;
        unfilledSlots.push({ taskId: task.id, slotId: slot.slotId, reason });
      }
    }
  }

  // ─── Greedy summary log ─────────────────────────────────────────
  const totalSlots = tasks.reduce((n, t) => n + t.slots.length, 0);
  const filledCount = assignments.length - lockedAssignments.length;
  const usedIds = new Set(assignments.map((a) => a.participantId));
  const idleCount = participants.length - usedIds.size;
  console.log(
    `[Scheduler] Greedy done: ${filledCount}/${totalSlots} slots filled, ` +
    `${unfilledSlots.length} unfilled, ${idleCount}/${participants.length} participants idle`,
  );
  if (unfilledSlots.length > 0) {
    // Group unfilled by task for cleaner output
    const byTask = new Map<string, number>();
    for (const u of unfilledSlots) {
      const t = taskMap.get(u.taskId);
      const key = t ? t.name : u.taskId;
      byTask.set(key, (byTask.get(key) || 0) + 1);
    }
    for (const [tName, count] of byTask) {
      console.warn(`  ↳ ${tName}: ${count} unfilled slot(s)`);
    }
  }

  return { assignments, unfilledSlots };
}

/**
 * Special handler for same-group tasks like Adanit.
 * Tries each group and picks the first one that can fill all slots.
 */
function assignSameGroupTask(
  task: Task,
  participants: Participant[],
  currentAssignments: Assignment[],
  taskMap: Map<string, Task>,
  workload: Map<string, number>,
  assignmentsByParticipant: Map<string, Assignment[]>,
): boolean {
  // Already have some locked assignments for this task?
  const lockedForTask = currentAssignments.filter((a) => a.taskId === task.id);
  const lockedSlotIds = new Set(lockedForTask.map((a) => a.slotId));

  // If locked assignments exist, determine the required group
  let requiredGroup: string | undefined;
  if (lockedForTask.length > 0) {
    const groups = new Set<string>();
    for (const a of lockedForTask) {
      const p = participants.find((pp) => pp.id === a.participantId);
      if (p) groups.add(p.group);
    }
    if (groups.size === 1) {
      requiredGroup = [...groups][0];
    }
  }

  // Collect all groups
  const allGroups = [...new Set(participants.map((p) => p.group))];
  const groupsToTry = requiredGroup ? [requiredGroup] : allGroups;

  // Sort groups by total workload (ascending) for fairness
  groupsToTry.sort((ga, gb) => {
    const wa = participants
      .filter((p) => p.group === ga)
      .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    const wb = participants
      .filter((p) => p.group === gb)
      .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    if (wa !== wb) return wa - wb;
    return Math.random() - 0.5;
  });

  // Sort slots: fill most-constrained first (highest min-level → fewest candidates)
  const slotsToFill = task.slots
    .filter((s) => !lockedSlotIds.has(s.slotId))
    .sort((a, b) => Math.min(...b.acceptableLevels) - Math.min(...a.acceptableLevels));

  // Track best partial result across groups
  let bestGroupAssignments: Assignment[] = [];
  let bestFilledCount = 0;

  for (const group of groupsToTry) {
    const groupParticipants = participants.filter((p) => p.group === group);
    const tempAssignments: Assignment[] = [];

    // P4: Build temp map for this group attempt (clone current + add temps as we go)
    const tempMap = new Map<string, Assignment[]>();
    for (const [pid, arr] of assignmentsByParticipant) {
      tempMap.set(pid, [...arr]);
    }

    for (const slot of slotsToFill) {
      const candidates = getEligibleCandidates(
        task,
        slot,
        groupParticipants,
        tempMap,
        taskMap,
        workload,
      );

      if (candidates.length > 0) {
        const newAssignment: Assignment = {
          id: nextAssignmentId(),
          taskId: task.id,
          slotId: slot.slotId,
          participantId: candidates[0].id,
          status: AssignmentStatus.Scheduled,
          updatedAt: new Date(),
        };
        tempAssignments.push(newAssignment);
        addToAssignmentMap(tempMap, newAssignment);
      }
      // Don't break — continue filling remaining slots even if one fails
    }

    if (tempAssignments.length === slotsToFill.length) {
      // Full success — commit and return immediately
      for (const a of tempAssignments) {
        currentAssignments.push(a);
        addToAssignmentMap(assignmentsByParticipant, a);
        const t = taskMap.get(a.taskId);
        if (t && !t.isLight) {
          workload.set(
            a.participantId,
            (workload.get(a.participantId) || 0) + computeTaskEffectiveHours(t),
          );
        }
      }
      return true;
    }

    // Track best partial result
    if (tempAssignments.length > bestFilledCount) {
      bestFilledCount = tempAssignments.length;
      bestGroupAssignments = tempAssignments;
    }
  }

  // No group could fill ALL slots — strict rule: leave unfilled rather than mix groups.
  // Do NOT commit partial assignments for same-group tasks.
  if (bestGroupAssignments.length > 0) {
    console.warn(
      `[Scheduler] ${task.name}: no group could fill all ${slotsToFill.length} slots. ` +
      `Best group filled ${bestFilledCount}/${slotsToFill.length}. Leaving ALL unfilled (strict same-group rule).`,
    );
  }

  return false;
}

// ─── Local Search Phase ──────────────────────────────────────────────────────

/**
 * P1 Delta Validation: Check whether swapping the participants at indices
 * idxI and idxJ produces a feasible schedule. Only validates constraints
 * for the two affected participants instead of the entire schedule.
 */
function isSwapFeasible(
  candidate: Assignment[],
  idxI: number,
  idxJ: number,
  taskMap: Map<string, Task>,
  pMap: Map<string, Participant>,
): boolean {
  const aI = candidate[idxI];
  const aJ = candidate[idxJ];
  const pI = pMap.get(aI.participantId);
  const pJ = pMap.get(aJ.participantId);
  const taskI = taskMap.get(aI.taskId);
  const taskJ = taskMap.get(aJ.taskId);
  if (!pI || !pJ || !taskI || !taskJ) return false;

  // HC-1: Level check
  const slotI = taskI.slots.find(s => s.slotId === aI.slotId);
  const slotJ = taskJ.slots.find(s => s.slotId === aJ.slotId);
  if (!slotI || !slotJ) return false;
  const levelOk = (p: Participant, slot: SlotRequirement) =>
    slot.acceptableLevels.includes(p.level) || p.level > Math.max(...slot.acceptableLevels);
  if (!levelOk(pI, slotI) || !levelOk(pJ, slotJ)) return false;

  // HC-2: Certification
  for (const c of slotI.requiredCertifications) if (!pI.certifications.includes(c)) return false;
  for (const c of slotJ.requiredCertifications) if (!pJ.certifications.includes(c)) return false;

  // HC-3: Availability
  if (!isFullyCovered(taskI.timeBlock, pI.availability)) return false;
  if (!isFullyCovered(taskJ.timeBlock, pJ.availability)) return false;

  // HC-10: L4 exclusion
  if (pI.level === Level.L4 && FORBIDDEN_FOR_L4.includes(taskI.type)) return false;
  if (pJ.level === Level.L4 && FORBIDDEN_FOR_L4.includes(taskJ.type)) return false;

  // HC-11: Choresh exclusion from Mamtera
  if (pI.chopidr && taskI.type === TaskType.Mamtera) return false;
  if (pJ.chopidr && taskJ.type === TaskType.Mamtera) return false;

  // HC-7: Unique participant per task (skip the swapped assignment itself)
  for (const a of candidate) {
    if (a === aI) continue;
    if (a.taskId === aI.taskId && a.participantId === aI.participantId) return false;
  }
  for (const a of candidate) {
    if (a === aJ) continue;
    if (a.taskId === aJ.taskId && a.participantId === aJ.participantId) return false;
  }

  // HC-4: Same-group (only for tasks that require it)
  if (taskI.sameGroupRequired) {
    const groups = new Set<string>();
    for (const a of candidate) {
      if (a.taskId !== taskI.id) continue;
      const p = pMap.get(a.participantId);
      if (p) groups.add(p.group);
    }
    if (groups.size > 1) return false;
  }
  if (taskJ.sameGroupRequired && taskJ.id !== taskI.id) {
    const groups = new Set<string>();
    for (const a of candidate) {
      if (a.taskId !== taskJ.id) continue;
      const p = pMap.get(a.participantId);
      if (p) groups.add(p.group);
    }
    if (groups.size > 1) return false;
  }

  // HC-5: Double-booking for both affected participants
  const checkDoubleBooking = (pid: string): boolean => {
    const pAssignments = candidate.filter(a => a.participantId === pid);
    for (let x = 0; x < pAssignments.length; x++) {
      for (let y = x + 1; y < pAssignments.length; y++) {
        const tX = taskMap.get(pAssignments[x].taskId);
        const tY = taskMap.get(pAssignments[y].taskId);
        if (tX && tY && blocksOverlap(tX.timeBlock, tY.timeBlock)) return false;
      }
    }
    return true;
  };
  if (!checkDoubleBooking(pI.id) || !checkDoubleBooking(pJ.id)) return false;

  return true;
}

/**
 * Try to improve the schedule by swapping participants between assignments.
 *
 * Uses simulated-annealing style acceptance: at the start of the search
 * the "temperature" is high and the algorithm occasionally accepts swaps
 * that lower the score (escaping local minima). Temperature decays
 * linearly toward zero so the tail of the search is purely hill-climbing.
 */
export function localSearchOptimize(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
): Assignment[] {
  let current = [...assignments.map((a) => ({ ...a }))];
  let currentScore = computeScheduleScore(tasks, participants, current, config);
  let best = current;
  let bestScore = currentScore;

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // P1: Pre-build participant map once for delta validation
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  const startTime = Date.now();
  let iterations = 0;

  // Simulated-annealing parameters
  // T0 is calibrated so that a swap losing ~50 score points has ~40% acceptance
  // at the start (e^(-50/55) ≈ 0.40). Temperature decays linearly to 0.
  const T0 = 55;
  const maxIter = config.maxIterations;

  while (iterations < maxIter) {
    if (Date.now() - startTime > config.maxSolverTimeMs) break;

    // Linear temperature decay: goes from T0 down to 0
    const temperature = T0 * (1 - iterations / maxIter);

    // Randomize iteration order for each pass
    const idxOrder = Array.from({ length: current.length }, (_, k) => k);
    for (let k = idxOrder.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [idxOrder[k], idxOrder[m]] = [idxOrder[m], idxOrder[k]];
    }

    let accepted = false;

    // Try swapping each pair of assignments that are in different tasks
    for (let ii = 0; ii < idxOrder.length && !accepted; ii++) {
      const i = idxOrder[ii];
      for (let jj = ii + 1; jj < idxOrder.length && !accepted; jj++) {
        const j = idxOrder[jj];
        iterations++;
        if (iterations > maxIter) break;
        if (Date.now() - startTime > config.maxSolverTimeMs) break;

        const ai = current[i];
        const aj = current[j];

        // Skip locked/manual assignments
        if (ai.status === AssignmentStatus.Locked || ai.status === AssignmentStatus.Manual) continue;
        if (aj.status === AssignmentStatus.Locked || aj.status === AssignmentStatus.Manual) continue;

        // Skip if same participant
        if (ai.participantId === aj.participantId) continue;

        // Try swap
        const candidate = current.map((a) => ({ ...a }));
        candidate[i] = { ...candidate[i], participantId: aj.participantId, updatedAt: new Date() };
        candidate[j] = { ...candidate[j], participantId: ai.participantId, updatedAt: new Date() };

        // P1: Delta validation — only check constraints for the 2 swapped participants
        if (!isSwapFeasible(candidate, i, j, taskMap, pMap)) continue;

        // Score the candidate
        const candidateScore = computeScheduleScore(tasks, participants, candidate, config);
        const delta = candidateScore.compositeScore - currentScore.compositeScore;

        // Accept if strictly better, or probabilistically if worse (SA)
        if (delta > 0 || (temperature > 0.01 && Math.random() < Math.exp(delta / temperature))) {
          current = candidate;
          currentScore = candidateScore;
          accepted = true;

          // Track global best
          if (currentScore.compositeScore > bestScore.compositeScore) {
            best = current;
            bestScore = currentScore;
          }
        }
      }
    }

    // If nothing was accepted in this full pass, temperature is likely zero
    // and we've converged — stop.
    if (!accepted) break;
  }

  return best;
}

// ─── Main Optimize Function ──────────────────────────────────────────────────

export interface OptimizationResult {
  assignments: Assignment[];
  score: ScheduleScore;
  feasible: boolean;
  unfilledSlots: { taskId: string; slotId: string; reason: string }[];
  iterations: number;
  durationMs: number;
}

/**
 * Full optimization pipeline: greedy + local search.
 */
export function optimize(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  lockedAssignments: Assignment[] = [],
): OptimizationResult {
  const startTime = Date.now();

  // Phase 1: Greedy construction
  const greedy = greedyAssign(tasks, participants, lockedAssignments);

  // Phase 2: Local search improvement
  const improved = localSearchOptimize(
    tasks,
    participants,
    greedy.assignments,
    config,
  );

  // Validate final result
  const validation = validateHardConstraints(tasks, participants, improved);
  const score = computeScheduleScore(tasks, participants, improved, config);

  return {
    assignments: improved,
    score,
    feasible: validation.valid && greedy.unfilledSlots.length === 0,
    unfilledSlots: greedy.unfilledSlots,
    iterations: 0,
    durationMs: Date.now() - startTime,
  };
}

// ─── Multi-Attempt Optimization ──────────────────────────────────────────────

/** Progress callback signature for multi-attempt optimization */
export type MultiAttemptProgressCallback = (info: {
  attempt: number;
  totalAttempts: number;
  currentBestScore: number;
  currentBestFeasible: boolean;
  currentBestUnfilled: number;
  attemptScore: number;
  attemptFeasible: boolean;
  improved: boolean;
}) => void;

/**
 * Fisher-Yates shuffle (in-place). Returns the same array.
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Compare two optimization results.
 * Returns true if `candidate` is better than `current`.
 *
 * Priority order:
 *  1. Fewer unfilled slots (more tasks filled)
 *  2. Higher composite score (fairness + bonuses - penalties)
 */
function isBetterResult(candidate: OptimizationResult, current: OptimizationResult): boolean {
  const candUnfilled = candidate.unfilledSlots.length;
  const curUnfilled = current.unfilledSlots.length;

  // Strictly fewer unfilled slots always wins
  if (candUnfilled < curUnfilled) return true;
  if (candUnfilled > curUnfilled) return false;

  // Same number of unfilled — compare composite score
  return candidate.score.compositeScore > current.score.compositeScore;
}

/**
 * Run the optimizer multiple times with shuffled participant order,
 * keeping the best result. This introduces diversity in the greedy
 * construction without changing the core algorithm.
 *
 * @param attempts Number of optimization attempts (default: 6)
 * @param onProgress Optional callback fired after each attempt
 */
export function optimizeMultiAttempt(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  lockedAssignments: Assignment[] = [],
  attempts: number = 40,
  onProgress?: MultiAttemptProgressCallback,
): OptimizationResult {
  let best: OptimizationResult | null = null;
  const totalStart = Date.now();
  const diagRows: Array<{ '#': number; score: string; unfilled: number; stdDev: string; penalty: string; bonus: string; improved: string }> = [];

  for (let i = 0; i < attempts; i++) {
    // Shuffle participant order to create diversity
    // (first attempt uses original order for determinism)
    const shuffledParticipants = i === 0
      ? [...participants]
      : shuffle([...participants]);

    const result = optimize(tasks, shuffledParticipants, config, lockedAssignments);

    const improved = best === null || isBetterResult(result, best);
    if (improved) {
      best = result;
    }

    diagRows.push({
      '#': i + 1,
      score: result.score.compositeScore.toFixed(4),
      unfilled: result.unfilledSlots.length,
      stdDev: result.score.restStdDev.toFixed(4),
      penalty: result.score.totalPenalty.toFixed(2),
      bonus: result.score.totalBonus.toFixed(2),
      improved: improved ? '★ YES' : '',
    });

    if (onProgress) {
      onProgress({
        attempt: i + 1,
        totalAttempts: attempts,
        currentBestScore: best!.score.compositeScore,
        currentBestFeasible: best!.feasible,
        currentBestUnfilled: best!.unfilledSlots.length,
        attemptScore: result.score.compositeScore,
        attemptFeasible: result.feasible,
        improved,
      });
    }
  }

  // Update total duration
  best!.durationMs = Date.now() - totalStart;

  console.log(
    `[Scheduler] Multi-attempt done: ${attempts} attempts in ${best!.durationMs}ms. ` +
    `Best score: ${best!.score.compositeScore.toFixed(2)}, ` +
    `unfilled: ${best!.unfilledSlots.length}, ` +
    `restStdDev: ${best!.score.restStdDev.toFixed(2)}`,
  );
  console.table(diagRows);

  return best!;
}

/**
 * Async version of optimizeMultiAttempt that yields to the event loop
 * between attempts, allowing the UI to update progress.
 *
 * Uses batched execution: runs BATCH_SIZE attempts synchronously, then
 * yields once via setTimeout so the browser can repaint the progress
 * overlay. This avoids 40 individual setTimeout round-trips while
 * still keeping the UI responsive.
 */
const ASYNC_BATCH_SIZE = 4;

export function optimizeMultiAttemptAsync(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  lockedAssignments: Assignment[] = [],
  attempts: number = 40,
  onProgress?: MultiAttemptProgressCallback,
): Promise<OptimizationResult> {
  return new Promise((resolve) => {
    let best: OptimizationResult | null = null;
    let i = 0;
    const totalStart = Date.now();
    const diagRows: Array<{ '#': number; score: string; unfilled: number; stdDev: string; penalty: string; bonus: string; improved: string }> = [];

    function runBatch(): void {
      const batchEnd = Math.min(i + ASYNC_BATCH_SIZE, attempts);

      while (i < batchEnd) {
        // Shuffle participant order (first attempt uses original order)
        const shuffledParticipants = i === 0
          ? [...participants]
          : shuffle([...participants]);

        const result = optimize(tasks, shuffledParticipants, config, lockedAssignments);

        const improved = best === null || isBetterResult(result, best);
        if (improved) {
          best = result;
        }

        i++;

        diagRows.push({
          '#': i,
          score: result.score.compositeScore.toFixed(4),
          unfilled: result.unfilledSlots.length,
          stdDev: result.score.restStdDev.toFixed(4),
          penalty: result.score.totalPenalty.toFixed(2),
          bonus: result.score.totalBonus.toFixed(2),
          improved: improved ? '★ YES' : '',
        });

        if (onProgress) {
          onProgress({
            attempt: i,
            totalAttempts: attempts,
            currentBestScore: best!.score.compositeScore,
            currentBestFeasible: best!.feasible,
            currentBestUnfilled: best!.unfilledSlots.length,
            attemptScore: result.score.compositeScore,
            attemptFeasible: result.feasible,
            improved,
          });
        }
      }

      if (i < attempts) {
        // Yield to event loop so the UI can repaint between batches
        setTimeout(runBatch, 0);
      } else {
        best!.durationMs = Date.now() - totalStart;
        console.log(
          `[Scheduler] Multi-attempt async done: ${attempts} attempts in ${best!.durationMs}ms. ` +
          `Best score: ${best!.score.compositeScore.toFixed(2)}, ` +
          `unfilled: ${best!.unfilledSlots.length}, ` +
          `restStdDev: ${best!.score.restStdDev.toFixed(2)}`,
        );
        console.table(diagRows);
        resolve(best!);
      }
    }

    // Start first batch
    runBatch();
  });
}
