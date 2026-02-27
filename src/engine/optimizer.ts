/**
 * Optimizer - Max-Min Fairness scheduler with penalty heuristics.
 *
 * Uses a greedy constructive heuristic followed by local search (swap-based)
 * to maximize the composite score (rest fairness + penalties).
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
  Certification,
  SlotRequirement,
} from '../models/types';
import { isFullyCovered, blocksOverlap } from '../web/utils/time-utils';
import { validateHardConstraints, isLevelSatisfied } from '../constraints/hard-constraints';
import { computeScheduleScore, ScoreContext, IncrementalScorer } from '../constraints/soft-constraints';
import { computeTaskEffectiveHours } from '../web/utils/load-weighting';
import { checkSeniorHardBlock } from '../constraints/senior-policy';
import { isEligible, getRejectionReason } from './validator';
import { dateKey } from '../utils/date-utils';
import { computeAllCapacities } from '../utils/capacity';

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

/**
 * R4: Thin wrapper around the shared isEligible() that adds diagnostic
 * logging when enabled.  All constraint logic lives in validator.ts.
 */
function isEligibleForSlot(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
  participantAssignments: Assignment[],
  taskMap: Map<string, Task>,
  disabledHC?: Set<string>,
): boolean {
  const result = isEligible(participant, task, slot, participantAssignments, taskMap, { disabledHC });
  if (!result && _diagnosticLogging) {
    const _tag = `${participant.name} → ${task.name} [${slot.label || slot.slotId}]`;
    console.log(`[Elig] REJECT: ${_tag}`);
  }
  return result;
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
  dailyWorkload?: Map<string, Map<string, number>>,
  disabledHC?: Set<string>,
): Participant[] {
  const eligible = participants.filter((p) =>
    isEligibleForSlot(p, task, slot, assignmentsByParticipant.get(p.id) || [], taskMap, disabledHC),
  );

  // Calendar day of the task being assigned
  const taskDay = dateKey(task.timeBlock.start);

  // ── C1 FIX: Single composite comparator ──
  // Merges what were three sequential (destructive) sorts into one stable sort.
  // Adanit:     exact-level → workload → level → random
  // Non-Adanit: (Hamama: level pref) → workload → exact-level → level → random

  // P3: Pre-compute random keys for a transitive, unbiased tiebreaker
  const rngKey = new Map<string, number>();
  for (const p of eligible) rngKey.set(p.id, Math.random());

  eligible.sort((a, b) => {
    if (task.type === TaskType.Adanit) {
      // T1: exact level match vs overqualified
      const aExact = slot.acceptableLevels.includes(a.level) ? 0 : 1;
      const bExact = slot.acceptableLevels.includes(b.level) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      // T2: blended workload score — flat (absolute hours).
      // Proportional fairness is handled by SC-3/SC-8 in the scoring phase;
      // greedy phase uses flat workload to maximise slot coverage.
      const wa = participantWorkload.get(a.id) || 0;
      const wb = participantWorkload.get(b.id) || 0;
      const dayA = dailyWorkload?.get(a.id)?.get(taskDay) ?? 0;
      const dayB = dailyWorkload?.get(b.id)?.get(taskDay) ?? 0;
      const scoreA = wa + 2.0 * dayA;
      const scoreB = wb + 2.0 * dayB;
      if (scoreA !== scoreB) return scoreA - scoreB;
      // T2.5: Adanit-specific assignment count — prefer participants with fewer
      // Adanit shifts so L3/L4 naturally alternate instead of one level hoarding.
      const adanitCountA = (assignmentsByParticipant.get(a.id) || []).filter(
        (asgn) => taskMap.get(asgn.taskId)?.type === TaskType.Adanit,
      ).length;
      const adanitCountB = (assignmentsByParticipant.get(b.id) || []).filter(
        (asgn) => taskMap.get(asgn.taskId)?.type === TaskType.Adanit,
      ).length;
      if (adanitCountA !== adanitCountB) return adanitCountA - adanitCountB;
      // T3: level ascending
      if (a.level !== b.level) return a.level - b.level;
      // T4: random tiebreak (pre-computed key)
      return (rngKey.get(a.id) || 0) - (rngKey.get(b.id) || 0);
    }

    // ── All non-Adanit tasks ──
    // Hamama-specific: prefer L0 first, L4 only as absolute last resort
    // (L2/L3 are hard-blocked from Hamama by HC-13 and won't be candidates)
    if (task.type === TaskType.Hamama) {
      const hp = (l: Level): number => l === Level.L0 ? 0 : l === Level.L4 ? 1 : 2;
      const d = hp(a.level) - hp(b.level);
      if (d !== 0) return d;
    }

    // Primary fairness driver: flat blended workload score.
    // Proportional fairness is handled by SC-3/SC-8 in the scoring phase;
    // greedy phase uses flat workload to maximise slot coverage.
    const wa = participantWorkload.get(a.id) || 0;
    const wb = participantWorkload.get(b.id) || 0;
    const dayA = dailyWorkload?.get(a.id)?.get(taskDay) ?? 0;
    const dayB = dailyWorkload?.get(b.id)?.get(taskDay) ?? 0;
    const scoreA = wa + 2.0 * dayA;
    const scoreB = wb + 2.0 * dayB;
    if (scoreA !== scoreB) return scoreA - scoreB;

    // Prefer exact level match
    const aExact = slot.acceptableLevels.includes(a.level) ? 0 : 1;
    const bExact = slot.acceptableLevels.includes(b.level) ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;

    // Level ascending — only for overqualified participants.
    // When both are exact matches (e.g. L2/L3/L4 for Karov commander),
    // skip level bias so all eligible levels compete fairly.
    if (aExact === 1 && a.level !== b.level) return a.level - b.level;

    // Random tiebreak (pre-computed key)
    return (rngKey.get(a.id) || 0) - (rngKey.get(b.id) || 0);
  });

  return eligible;
}

// ─── Greedy Phase ────────────────────────────────────────────────────────────

/**
 * Sort tasks for assignment order. Constrained tasks first:
 * Adanit (same-group, complex), then Hamama, then Mamtera (14h window
 * makes it the hardest L0-only task — must be scheduled before Karov/Karovit
 * to avoid L0 pool depletion), then Karov, Aruga, Karovit (light) and Shemesh.
 */
function sortTasksByDifficulty(tasks: Task[], jitter: number = 0): Task[] {
  const priority: Record<string, number> = {
    [TaskType.Adanit]: 0,
    [TaskType.Hamama]: 1,
    [TaskType.Mamtera]: 2,
    [TaskType.Karov]: 3,
    [TaskType.Aruga]: 4,
    [TaskType.Karovit]: 5,
    [TaskType.Shemesh]: 6,
  };
  // P3: Pre-compute random keys for transitive tiebreaker
  const taskRngKey = new Map<string, number>();
  for (const t of tasks) taskRngKey.set(t.id, Math.random());

  // Task-order jitter: with probability `jitter`, apply a random ±1
  // perturbation to each task's base priority (clamped to [0, 6]).
  // Adanit (priority 0) is never perturbed — same-group constraint makes
  // it structurally critical to schedule first.
  const jitteredPriority = new Map<string, number>();
  for (const t of tasks) {
    const base = priority[t.type] ?? 99;
    if (jitter > 0 && base > 0 && base < 99 && Math.random() < jitter) {
      const delta = Math.random() < 0.5 ? -1 : 1;
      jitteredPriority.set(t.id, Math.max(1, Math.min(6, base + delta)));
    } else {
      jitteredPriority.set(t.id, base);
    }
  }

  return [...tasks].sort((a, b) => {
    const pa = jitteredPriority.get(a.id) ?? 99;
    const pb = jitteredPriority.get(b.id) ?? 99;
    if (pa !== pb) return pa - pb;
    const ta = a.timeBlock.start.getTime();
    const tb = b.timeBlock.start.getTime();
    if (ta !== tb) return ta - tb;
    // Random tiebreak within same priority+time tier for multi-attempt diversity
    return (taskRngKey.get(a.id) || 0) - (taskRngKey.get(b.id) || 0);
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
  disabledHC?: Set<string>,
  taskOrderJitter: number = 0,
): { assignments: Assignment[]; unfilledSlots: { taskId: string; slotId: string; reason: string }[] } {
  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const assignments: Assignment[] = [...lockedAssignments];
  const unfilledSlots: { taskId: string; slotId: string; reason: string }[] = [];

  // P4: Pre-build per-participant assignment index for O(1) lookups
  const assignmentsByParticipant = buildAssignmentMap(lockedAssignments);

  // Track workload
  const workload = new Map<string, number>();
  // Track per-day workload: participantId → (dateKey → effectiveHours)
  const dailyWorkload = new Map<string, Map<string, number>>();
  for (const p of participants) {
    workload.set(p.id, 0);
    dailyWorkload.set(p.id, new Map());
  }
  for (const a of lockedAssignments) {
    const task = taskMap.get(a.taskId);
    if (task) {
      // For daily spread: count all tasks (light tasks get a floor of 1h so
      // the day registers as occupied). For total workload: skip light tasks.
      const eff = computeTaskEffectiveHours(task);
      const dailyEff = task.isLight ? Math.max(1, eff) : eff;
      if (!task.isLight) {
        workload.set(
          a.participantId,
          (workload.get(a.participantId) || 0) + eff,
        );
      }
      const dk = dateKey(task.timeBlock.start);
      let pDaily = dailyWorkload.get(a.participantId);
      if (!pDaily) { pDaily = new Map(); dailyWorkload.set(a.participantId, pDaily); }
      pDaily.set(dk, (pDaily.get(dk) || 0) + dailyEff);
    }
  }

  const sortedTasks = sortTasksByDifficulty(tasks, taskOrderJitter);

  for (const task of sortedTasks) {
    // For same-group tasks (Adanit), we need special handling
    if (task.sameGroupRequired) {
      const assigned = assignSameGroupTask(task, participants, assignments, taskMap, workload, assignmentsByParticipant, dailyWorkload, disabledHC);
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
            const reason = `אף קבוצה לא יכולה למלא את כל העמדות ב${task.name}. חסר ${levelStr}${certStr} עבור ${task.name}`;
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
        dailyWorkload,
        disabledHC,
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
        const eff = computeTaskEffectiveHours(task);
        const dailyEff = task.isLight ? Math.max(1, eff) : eff;
        if (!task.isLight) {
          workload.set(chosen.id, (workload.get(chosen.id) || 0) + eff);
        }
        // Always update daily workload (light tasks get floor of 1h)
        const dk = dateKey(task.timeBlock.start);
        let pDaily = dailyWorkload.get(chosen.id);
        if (!pDaily) { pDaily = new Map(); dailyWorkload.set(chosen.id, pDaily); }
        pDaily.set(dk, (pDaily.get(dk) || 0) + dailyEff);
      } else {
        // ── Backtracking: try depth-1 swap chains to free a participant ──
        // Find participants who pass level/cert/availability but are blocked by
        // a current assignment (typically HC-5 double-booking). If we can
        // reassign their blocking assignment to someone else, we free them.
        let backtrackSuccess = false;
        for (const p of participants) {
          // Quick filter: skip if participant can't possibly fill this slot
          // (wrong level, missing cert, unavailable)
          if (!isLevelSatisfied(p.level, slot)) continue;
          if (slot.requiredCertifications.some(c => !p.certifications.includes(c))) continue;
          if (!isFullyCovered(task.timeBlock, p.availability)) continue;
          if (checkSeniorHardBlock(p, task, slot)) continue;
          if (p.certifications.includes(Certification.Horesh) && task.type === TaskType.Mamtera) continue;

          // Already eligible (shouldn't happen since candidates was empty, but guard)
          const pAssigns = assignmentsByParticipant.get(p.id) || [];
          if (isEligibleForSlot(p, task, slot, pAssigns, taskMap, disabledHC)) continue;

          // Find which of p's current assignments blocks them from this slot
          // (must overlap in time — HC-5 conflict)
          for (const blockingAssign of pAssigns) {
            if (blockingAssign.status === AssignmentStatus.Locked ||
                blockingAssign.status === AssignmentStatus.Manual ||
                blockingAssign.status === AssignmentStatus.Frozen) continue;

            const blockingTask = taskMap.get(blockingAssign.taskId);
            if (!blockingTask) continue;
            if (!blocksOverlap(blockingTask.timeBlock, task.timeBlock)) continue;
            // Don't steal from same-group tasks (Adanit) — too complex
            if (blockingTask.sameGroupRequired) continue;

            const blockingSlot = blockingTask.slots.find(s => s.slotId === blockingAssign.slotId);
            if (!blockingSlot) continue;

            // Try to find a replacement for the blocking assignment
            for (const replacement of participants) {
              if (replacement.id === p.id) continue;
              // Replacement must not already be assigned to the task being stolen from (HC-7)
              const rAssigns = assignmentsByParticipant.get(replacement.id) || [];
              if (rAssigns.some(a => a.taskId === blockingAssign.taskId)) continue;
              if (!isEligibleForSlot(replacement, blockingTask, blockingSlot, rAssigns, taskMap, disabledHC)) continue;

              // Would the replacement be eligible for the blocking slot AND
              // would p then become eligible for the target slot once unblocked?
              // Simulate: remove blockingAssign from p, check eligibility
              const pAssignsWithout = pAssigns.filter(a => a.id !== blockingAssign.id);
              if (!isEligibleForSlot(p, task, slot, pAssignsWithout, taskMap, disabledHC)) continue;

              // ── Execute backtrack swap ──
              // 1. Remove blocking assignment from p
              const blockIdx = assignments.indexOf(blockingAssign);
              if (blockIdx === -1) continue;
              assignments.splice(blockIdx, 1);
              const pList = assignmentsByParticipant.get(p.id);
              if (pList) {
                const pi = pList.indexOf(blockingAssign);
                if (pi !== -1) pList.splice(pi, 1);
              }
              // Update workload for p (remove blocking task load)
              const blockEff = computeTaskEffectiveHours(blockingTask);
              const blockDailyEff = blockingTask.isLight ? Math.max(1, blockEff) : blockEff;
              if (!blockingTask.isLight) {
                workload.set(p.id, (workload.get(p.id) || 0) - blockEff);
              }
              const blockDk = dateKey(blockingTask.timeBlock.start);
              const pDailyMap = dailyWorkload.get(p.id);
              if (pDailyMap) pDailyMap.set(blockDk, (pDailyMap.get(blockDk) || 0) - blockDailyEff);

              // 2. Assign replacement to the blocking slot
              const replacementAssign: Assignment = {
                id: nextAssignmentId(),
                taskId: blockingAssign.taskId,
                slotId: blockingAssign.slotId,
                participantId: replacement.id,
                status: AssignmentStatus.Scheduled,
                updatedAt: new Date(),
              };
              assignments.push(replacementAssign);
              addToAssignmentMap(assignmentsByParticipant, replacementAssign);
              if (!blockingTask.isLight) {
                workload.set(replacement.id, (workload.get(replacement.id) || 0) + blockEff);
              }
              let rDaily = dailyWorkload.get(replacement.id);
              if (!rDaily) { rDaily = new Map(); dailyWorkload.set(replacement.id, rDaily); }
              rDaily.set(blockDk, (rDaily.get(blockDk) || 0) + blockDailyEff);

              // 3. Assign p to the target slot
              const targetAssign: Assignment = {
                id: nextAssignmentId(),
                taskId: task.id,
                slotId: slot.slotId,
                participantId: p.id,
                status: AssignmentStatus.Scheduled,
                updatedAt: new Date(),
              };
              assignments.push(targetAssign);
              addToAssignmentMap(assignmentsByParticipant, targetAssign);
              const targetEff = computeTaskEffectiveHours(task);
              const targetDailyEff = task.isLight ? Math.max(1, targetEff) : targetEff;
              if (!task.isLight) {
                workload.set(p.id, (workload.get(p.id) || 0) + targetEff);
              }
              const targetDk = dateKey(task.timeBlock.start);
              let pDailyTarget = dailyWorkload.get(p.id);
              if (!pDailyTarget) { pDailyTarget = new Map(); dailyWorkload.set(p.id, pDailyTarget); }
              pDailyTarget.set(targetDk, (pDailyTarget.get(targetDk) || 0) + targetDailyEff);

              backtrackSuccess = true;
              break;
            }
            if (backtrackSuccess) break;
          }
          if (backtrackSuccess) break;
        }

        if (!backtrackSuccess) {
          // R8: Build specific reason with constraint codes for diagnostics
          const levelStr = slot.acceptableLevels.map((l) => 'L' + l).join('/');
          const certStr = slot.requiredCertifications.length > 0
            ? ` with ${slot.requiredCertifications.join(', ')} cert` : '';

          // Collect per-participant rejection codes to surface HC-12×HC-13 conflicts
          const rejectionCounts = new Map<string, number>();
          for (const p of participants) {
            const pAssigns = assignmentsByParticipant.get(p.id) || [];
            const code = getRejectionReason(p, task, slot, pAssigns, taskMap, { disabledHC });
            if (code) {
              rejectionCounts.set(code, (rejectionCounts.get(code) || 0) + 1);
            }
          }

          let reason: string;
          // Detect HC-12 × HC-13 combo: some candidates blocked by senior policy,
          // remaining blocked by consecutive high-load
          const hc12Count = rejectionCounts.get('HC-12') || 0;
          const hc13Count = rejectionCounts.get('HC-13') || 0;
          if (hc12Count > 0 && hc13Count > 0) {
            reason = `התנגשות HC-12×HC-13 ב${task.name}: ${hc13Count} נחסמו ע"י מדיניות בכירים, ${hc12Count} ע"י עומס רצוף. ${levelStr}${certStr}`;
          } else if (hc12Count > 0) {
            reason = `חסימת HC-12 עומס רצוף: כל המועמדים ${levelStr}${certStr} ל${task.name} משובצים למשימות כבדות סמוכות`;
          } else if (hc13Count > 0) {
            reason = `חסימת HC-13 מדיניות בכירים: כל המועמדים ${levelStr}${certStr} ל${task.name} מוגבלים ע"י אילוצי תפקיד בכיר`;
          } else {
            reason = `חסר ${levelStr}${certStr} עבור ${task.name}`;
          }
          unfilledSlots.push({ taskId: task.id, slotId: slot.slotId, reason });
        }
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
  dailyWorkload?: Map<string, Map<string, number>>,
  disabledHC?: Set<string>,
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

  // Pre-build group → participants map to avoid repeated filter() scans
  const groupParticipantsMap = new Map<string, Participant[]>();
  for (const p of participants) {
    const list = groupParticipantsMap.get(p.group);
    if (list) list.push(p);
    else groupParticipantsMap.set(p.group, [p]);
  }

  // Sort groups by total workload (ascending) for fairness
  // Uses precomputed group map instead of repeated filter() calls.
  // Random tiebreaker ensures different attempts explore different groups
  // when workloads are tied (critical for multi-attempt diversity).
  const groupRng = new Map<string, number>();
  for (const g of groupsToTry) groupRng.set(g, Math.random());
  groupsToTry.sort((ga, gb) => {
    const wa = (groupParticipantsMap.get(ga) || [])
      .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    const wb = (groupParticipantsMap.get(gb) || [])
      .reduce((s, p) => s + (workload.get(p.id) || 0), 0);
    if (wa !== wb) return wa - wb;
    return (groupRng.get(ga) || 0) - (groupRng.get(gb) || 0);
  });

  // Sort slots: fill most-constrained first (highest min-level → fewest candidates)
  const slotsToFill = task.slots
    .filter((s) => !lockedSlotIds.has(s.slotId))
    .sort((a, b) => Math.min(...b.acceptableLevels) - Math.min(...a.acceptableLevels));

  // Track best partial result across groups
  let bestGroupAssignments: Assignment[] = [];
  let bestFilledCount = 0;

  for (const group of groupsToTry) {
    const groupParticipants = groupParticipantsMap.get(group) || [];
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
        dailyWorkload,
        disabledHC,
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
        if (t) {
          const eff = computeTaskEffectiveHours(t);
          const dailyEff = t.isLight ? Math.max(1, eff) : eff;
          if (!t.isLight) {
            workload.set(
              a.participantId,
              (workload.get(a.participantId) || 0) + eff,
            );
          }
          if (dailyWorkload) {
            const dk = dateKey(t.timeBlock.start);
            let pDaily = dailyWorkload.get(a.participantId);
            if (!pDaily) { pDaily = new Map(); dailyWorkload.set(a.participantId, pDaily); }
            pDaily.set(dk, (pDaily.get(dk) || 0) + dailyEff);
          }
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

  // HC-4: No group could fill ALL slots. Cross-group fill is forbidden
  // (sameGroupRequired is a hard constraint). Report as infeasible.
  if (bestFilledCount > 0) {
    console.warn(
      `[Scheduler] ${task.name}: no group could fill all ${slotsToFill.length} slots. ` +
      `Best group filled ${bestFilledCount}/${slotsToFill.length}. HC-4 forbids cross-group fill.`,
    );
  }

  return false;
}

// ─── Local Search Phase ──────────────────────────────────────────────────────

/**
 * P1 Delta Validation: Check whether swapping the participants at indices
 * idxI and idxJ produces a feasible schedule. Only validates constraints
 * for the two affected participants instead of the entire schedule.
 *
 * Accepts pre-built per-participant and per-task assignment indices to
 * avoid O(n) scans on every call. The caller must pass the indices as
 * they exist AFTER the swap has been applied to the candidate array.
 */
function isSwapFeasible(
  candidate: Assignment[],
  idxI: number,
  idxJ: number,
  taskMap: Map<string, Task>,
  pMap: Map<string, Participant>,
  /** P1: Pre-built per-participant assignment index for the candidate */
  byParticipant: Map<string, Assignment[]>,
  /** P1: Pre-built per-task assignment index for the candidate */
  byTask: Map<string, Assignment[]>,
  disabledHC?: Set<string>,
): boolean {
  const aI = candidate[idxI];
  const aJ = candidate[idxJ];
  const pI = pMap.get(aI.participantId);
  const pJ = pMap.get(aJ.participantId);
  const taskI = taskMap.get(aI.taskId);
  const taskJ = taskMap.get(aJ.taskId);
  if (!pI || !pJ || !taskI || !taskJ) return false;

  // HC-1: Level check — single source of truth in isLevelSatisfied()
  const slotI = taskI.slots.find(s => s.slotId === aI.slotId);
  const slotJ = taskJ.slots.find(s => s.slotId === aJ.slotId);
  if (!slotI || !slotJ) return false;
  if (!disabledHC?.has('HC-1')) {
    if (!isLevelSatisfied(pI.level, slotI) || !isLevelSatisfied(pJ.level, slotJ)) return false;
  }

  // HC-2: Certification
  if (!disabledHC?.has('HC-2')) {
    for (const c of slotI.requiredCertifications) if (!pI.certifications.includes(c)) return false;
    for (const c of slotJ.requiredCertifications) if (!pJ.certifications.includes(c)) return false;
  }

  // HC-3: Availability
  if (!disabledHC?.has('HC-3')) {
    if (!isFullyCovered(taskI.timeBlock, pI.availability)) return false;
    if (!isFullyCovered(taskJ.timeBlock, pJ.availability)) return false;
  }

  // HC-13: Senior hard blocks
  if (!disabledHC?.has('HC-13')) {
    if (slotI && checkSeniorHardBlock(pI, taskI, slotI)) return false;
    if (slotJ && checkSeniorHardBlock(pJ, taskJ, slotJ)) return false;
  }

  // HC-11: Choresh exclusion from Mamtera
  if (!disabledHC?.has('HC-11')) {
    if (pI.certifications.includes(Certification.Horesh) && taskI.type === TaskType.Mamtera) return false;
    if (pJ.certifications.includes(Certification.Horesh) && taskJ.type === TaskType.Mamtera) return false;
  }

  // HC-7: Unique participant per task — use per-task index (O(k) instead of O(n))
  if (!disabledHC?.has('HC-7')) {
    const taskIAssignments = byTask.get(aI.taskId) || [];
    for (const a of taskIAssignments) {
      if (a === aI) continue;
      if (a.participantId === aI.participantId) return false;
    }
    const taskJAssignments = byTask.get(aJ.taskId) || [];
    for (const a of taskJAssignments) {
      if (a === aJ) continue;
      if (a.participantId === aJ.participantId) return false;
    }
  }

  // HC-4: Same-group — mandatory. If either swapped assignment belongs to a
  // sameGroupRequired task, verify all participants in that task share one group.
  if (!disabledHC?.has('HC-4')) {
    const checkSameGroupForTask = (taskId: string): boolean => {
      const task = taskMap.get(taskId);
      if (!task || !task.sameGroupRequired) return true;
      const taskAssigns = byTask.get(taskId) || [];
      const groups = new Set<string>();
      for (const a of taskAssigns) {
        const p = pMap.get(a.participantId);
        if (p) groups.add(p.group);
      }
      return groups.size <= 1;
    };
    if (!checkSameGroupForTask(aI.taskId) || !checkSameGroupForTask(aJ.taskId)) return false;
  }

  // HC-5: Double-booking for both affected participants — use per-participant index
  if (!disabledHC?.has('HC-5')) {
    const checkDoubleBooking = (pid: string): boolean => {
      const pAssignments = byParticipant.get(pid) || [];
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
  }

  // HC-12: No consecutive blocking tasks for both affected participants
  if (!disabledHC?.has('HC-12')) {
    const checkConsecutiveHighLoad = (pid: string): boolean => {
      const pAssignments = (byParticipant.get(pid) || [])
        .map(a => ({ assignment: a, task: taskMap.get(a.taskId)! }))
        .filter(x => x.task != null)
        .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
      for (let x = 0; x < pAssignments.length - 1; x++) {
        const cur = pAssignments[x];
        const nxt = pAssignments[x + 1];
        if (cur.task.id === nxt.task.id) continue;
        const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
        if (gap > 0) continue;
        if (cur.task.blocksConsecutive && nxt.task.blocksConsecutive) return false;
      }
      return true;
    };
    if (!checkConsecutiveHighLoad(pI.id) || !checkConsecutiveHighLoad(pJ.id)) return false;
  }

  return true;
}

/**
 * Try to improve the schedule by swapping participants between assignments
 * and inserting participants into unfilled slots.
 *
 * Uses simulated-annealing style acceptance: at the start of the search
 * the "temperature" is high and the algorithm occasionally accepts swaps
 * that lower the score (escaping local minima). Temperature decays
 * linearly toward zero so the tail of the search is purely hill-climbing.
 *
 * Insert moves: When unfilled slots exist, periodically tries to place
 * an eligible participant into an unfilled slot. Accepted inserts get a
 * large bonus (UNFILLED_SLOT_PENALTY per slot filled) to strongly prefer
 * feasibility over score quality.
 *
 * Performance: swaps are applied in-place on the `current` array and
 * undone if rejected, avoiding O(n) clones per attempt. A ScoreContext
 * is pre-built once and reused across all `computeScheduleScore` calls
 * to eliminate redundant map construction and O(P×A) scans.
 */
const UNFILLED_SLOT_PENALTY = 500;

export function localSearchOptimize(
  tasks: Task[],
  participants: Participant[],
  assignments: Assignment[],
  config: SchedulerConfig,
  disabledHC?: Set<string>,
  unfilledSlots?: { taskId: string; slotId: string; reason: string }[],
): { assignments: Assignment[]; filledSlots: string[] } {
  const current = [...assignments.map((a) => ({ ...a }))];

  // Track unfilled slots that SA might fill via insert moves
  const remainingUnfilled = unfilledSlots ? [...unfilledSlots] : [];
  const filledSlots: string[] = [];

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  // P1: Pre-build participant map once for delta validation
  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  // P1: Pre-build per-participant and per-task indices for O(k) lookups.
  // With in-place swaps these are patched and unpatched rather than rebuilt.
  const byParticipant = buildAssignmentMap(current);
  const byTask = new Map<string, Assignment[]>();
  for (const a of current) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }

  // Pre-compute capacities for proportional workload scoring
  let schedStart = tasks[0]?.timeBlock.start ?? new Date();
  let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const capacities = computeAllCapacities(participants, schedStart, schedEnd);

  // Build ScoreContext once — taskMap, pMap, and the mutable indices are
  // kept consistent via in-place patching so the same ctx is valid for
  // every scoring call throughout the search.
  const scoreCtx: ScoreContext = {
    taskMap,
    pMap,
    assignmentsByParticipant: byParticipant,
    assignmentsByTask: byTask,
    capacities,
  };

  let currentScore = computeScheduleScore(tasks, participants, current, config, scoreCtx);
  // Snapshot best independently — current is mutated in-place
  let best = current.map(a => ({ ...a }));
  let bestScore = currentScore;

  // Build incremental scorer for O(k) swap scoring
  const incScorer = IncrementalScorer.build(tasks, participants, current, config, scoreCtx);
  let currentComposite = incScorer.compositeScore;

  const startTime = Date.now();
  let iterations = 0;

  // Simulated-annealing parameters
  // T0 calibrated so that a swap losing ~50 score points has ~40% acceptance
  // at the start (e^(-50/55) ≈ 0.40). Uses geometric decay (α=0.997) instead
  // of linear decay to maintain exploration longer in early phases.
  const T0 = 55;
  const ALPHA = 0.997;  // geometric cooling rate
  const maxIter = config.maxIterations;
  let temperature = T0;
  // Reheating: if no improvement in REHEAT_THRESHOLD iterations, temporarily
  // raise temperature to T0/3 to escape local minima.
  const REHEAT_THRESHOLD = 500;
  let itersSinceImprovement = 0;

  // Pre-allocate index order array once and shuffle in-place each pass
  // to avoid per-iteration allocation.
  const idxOrder = Array.from({ length: current.length }, (_, k) => k);

  // Build assignment-ID → position-in-participant-list map for true O(1)
  // swap patching (avoids indexOf scans on each attempt).
  const assignmentPos = new Map<string, { pid: string; idx: number }>();
  for (const [pid, list] of byParticipant) {
    for (let idx = 0; idx < list.length; idx++) {
      assignmentPos.set(list[idx].id, { pid, idx });
    }
  }

  while (iterations < maxIter) {
    if (Date.now() - startTime > config.maxSolverTimeMs) break;

    // Geometric temperature decay with reheating
    temperature *= ALPHA;
    if (itersSinceImprovement >= REHEAT_THRESHOLD && temperature < 1) {
      temperature = T0 / 3;
      itersSinceImprovement = 0;
    }

    // Shuffle in-place (Fisher-Yates) — reuses the pre-allocated array
    for (let k = idxOrder.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [idxOrder[k], idxOrder[m]] = [idxOrder[m], idxOrder[k]];
    }

    let accepted = false;

    // ── Insert moves: try to fill unfilled slots ──
    // With 20% probability per iteration (when unfilled slots exist),
    // attempt to place an eligible participant into an unfilled slot.
    if (remainingUnfilled.length > 0 && Math.random() < 0.2) {
      // Pick a random unfilled slot
      const ufIdx = Math.floor(Math.random() * remainingUnfilled.length);
      const uf = remainingUnfilled[ufIdx];
      const ufTask = taskMap.get(uf.taskId);
      if (ufTask) {
        const ufSlot = ufTask.slots.find(s => s.slotId === uf.slotId);
        if (ufSlot) {
          // Shuffle participant order for this attempt
          const pOrder = [...participants];
          for (let k = pOrder.length - 1; k > 0; k--) {
            const m = Math.floor(Math.random() * (k + 1));
            [pOrder[k], pOrder[m]] = [pOrder[m], pOrder[k]];
          }
          for (const p of pOrder) {
            const pAssigns = byParticipant.get(p.id) || [];
            if (!isEligibleForSlot(p, ufTask, ufSlot, pAssigns, taskMap, disabledHC)) continue;
            // Also check HC-7: no duplicate participant in the same task
            const taskAssigns = byTask.get(uf.taskId) || [];
            if (taskAssigns.some(a => a.participantId === p.id)) continue;

            // Create new assignment and score
            const newA: Assignment = {
              id: nextAssignmentId(),
              taskId: uf.taskId,
              slotId: uf.slotId,
              participantId: p.id,
              status: AssignmentStatus.Scheduled,
              updatedAt: new Date(),
            };
            // Temporarily add to current
            current.push(newA);
            addToAssignmentMap(byParticipant, newA);
            const taskList = byTask.get(uf.taskId);
            if (taskList) taskList.push(newA);
            else byTask.set(uf.taskId, [newA]);

            const score = computeScheduleScore(tasks, participants, current, config, scoreCtx);
            // Insert moves get a large bonus per filled slot
            const insertBonus = UNFILLED_SLOT_PENALTY;
            const effectiveScore = score.compositeScore + insertBonus;

            if (effectiveScore > currentComposite) {
              // Accept insert — rebuild incremental scorer to include new assignment
              currentComposite = effectiveScore;
              // Update position map for the new assignment
              const pList = byParticipant.get(p.id)!;
              assignmentPos.set(newA.id, { pid: p.id, idx: pList.length - 1 });
              // Update idxOrder to include the new index
              idxOrder.push(current.length - 1);
              // Remove from unfilled
              remainingUnfilled.splice(ufIdx, 1);
              filledSlots.push(uf.slotId);
              accepted = true;

              // Track global best
              if (effectiveScore > bestScore.compositeScore) {
                best = current.map(a => ({ ...a }));
                bestScore = { ...score, compositeScore: effectiveScore };
              }
            } else {
              // Undo insert
              current.pop();
              const pAssignList = byParticipant.get(p.id);
              if (pAssignList) pAssignList.pop();
              const tList = byTask.get(uf.taskId);
              if (tList) tList.pop();
            }
            break; // Only try one candidate per iteration
          }
        }
      }
      iterations++;
      if (accepted) continue;
    }

    // Try swapping each pair of assignments
    for (let ii = 0; ii < idxOrder.length && !accepted; ii++) {
      const i = idxOrder[ii];
      for (let jj = ii + 1; jj < idxOrder.length && !accepted; jj++) {
        const j = idxOrder[jj];
        if (Date.now() - startTime > config.maxSolverTimeMs) break;

        const ai = current[i];
        const aj = current[j];

        // Skip locked/manual/frozen assignments (don't count as iterations)
        if (ai.status === AssignmentStatus.Locked || ai.status === AssignmentStatus.Manual || ai.status === AssignmentStatus.Frozen) continue;
        if (aj.status === AssignmentStatus.Locked || aj.status === AssignmentStatus.Manual || aj.status === AssignmentStatus.Frozen) continue;

        // Skip if same participant (don't count as iterations)
        if (ai.participantId === aj.participantId) continue;

        // Count only actual swap attempts against iteration budget
        iterations++;
        if (iterations > maxIter) break;

        // ── In-place swap ───────────────────────────────────────────
        const oldPidI = ai.participantId;
        const oldPidJ = aj.participantId;

        // 1. Mutate participant IDs in-place
        ai.participantId = oldPidJ;
        aj.participantId = oldPidI;

        // 2. Patch byParticipant index in true O(1) via position map
        //    (avoids indexOf scans on each attempt).
        const posInfoI = assignmentPos.get(ai.id)!;
        const posInfoJ = assignmentPos.get(aj.id)!;
        const listPidI = byParticipant.get(oldPidI)!;
        const listPidJ = byParticipant.get(oldPidJ)!;
        const posI = posInfoI.idx;
        const posJ = posInfoJ.idx;
        listPidI[posI] = aj;  // aj now belongs to oldPidI
        listPidJ[posJ] = ai;  // ai now belongs to oldPidJ
        // Update position map to reflect the swap
        assignmentPos.set(ai.id, { pid: oldPidJ, idx: posJ });
        assignmentPos.set(aj.id, { pid: oldPidI, idx: posI });

        // byTask: no change needed — same object references, same taskIds

        // 3. Delta validation with patched indices
        if (!isSwapFeasible(current, i, j, taskMap, pMap, byParticipant, byTask, disabledHC)) {
          // Undo in-place swap
          ai.participantId = oldPidI;
          aj.participantId = oldPidJ;
          listPidI[posI] = ai;
          listPidJ[posJ] = aj;
          assignmentPos.set(ai.id, { pid: oldPidI, idx: posI });
          assignmentPos.set(aj.id, { pid: oldPidJ, idx: posJ });
          continue;
        }

        // 4. Incremental score: only recompute for the two swapped participants
        //    Save state for undo
        const savedA = incScorer.saveParticipant(oldPidJ)!; // ai now has oldPidJ
        const savedB = incScorer.saveParticipant(oldPidI)!; // aj now has oldPidI
        const newComposite = incScorer.recomputeForSwap(oldPidJ, oldPidI);
        const delta = newComposite - currentComposite;

        // Accept if strictly better, or probabilistically if worse (SA)
        if (delta > 0 || (temperature > 0.01 && Math.random() < Math.exp(delta / temperature))) {
          ai.updatedAt = new Date();
          aj.updatedAt = new Date();
          currentComposite = newComposite;
          accepted = true;

          // Track global best (snapshot since current is mutated in-place)
          if (newComposite > bestScore.compositeScore) {
            best = current.map(a => ({ ...a }));
            bestScore = { ...bestScore, compositeScore: newComposite };
          }
        } else {
          // Undo in-place swap
          ai.participantId = oldPidI;
          aj.participantId = oldPidJ;
          listPidI[posI] = ai;
          listPidJ[posJ] = aj;
          assignmentPos.set(ai.id, { pid: oldPidI, idx: posI });
          assignmentPos.set(aj.id, { pid: oldPidJ, idx: posJ });
          // Restore incremental scorer state
          incScorer.restoreParticipant(oldPidJ, savedA);
          incScorer.restoreParticipant(oldPidI, savedB);
          incScorer.finalizeUndo();
        }
      }
    }

    // Track stagnation for reheating
    if (accepted) {
      itersSinceImprovement = 0;
    } else {
      itersSinceImprovement++;
    }

    // If nothing was accepted in this full pass AND temperature has decayed
    // significantly AND reheating can't help, the search has converged.
    if (!accepted && temperature < 0.5 && itersSinceImprovement > REHEAT_THRESHOLD) break;
  }

  return { assignments: best, filledSlots };
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
  disabledHC?: Set<string>,
  taskOrderJitter: number = 0,
): OptimizationResult {
  const startTime = Date.now();

  // Phase 1: Greedy construction
  const greedy = greedyAssign(tasks, participants, lockedAssignments, disabledHC, taskOrderJitter);

  // Phase 2: Local search improvement (also tries to fill unfilled slots)
  const lsResult = localSearchOptimize(
    tasks,
    participants,
    greedy.assignments,
    config,
    disabledHC,
    greedy.unfilledSlots,
  );

  // Remove slots that SA managed to fill
  const remainingUnfilled = greedy.unfilledSlots.filter(
    uf => !lsResult.filledSlots.includes(uf.slotId),
  );

  // Validate final result
  const validation = validateHardConstraints(tasks, participants, lsResult.assignments, disabledHC);

  // Build capacities for final scoring
  let schedStart = tasks[0]?.timeBlock.start ?? new Date();
  let schedEnd = tasks[0]?.timeBlock.end ?? new Date();
  for (const t of tasks) {
    if (t.timeBlock.start < schedStart) schedStart = t.timeBlock.start;
    if (t.timeBlock.end > schedEnd) schedEnd = t.timeBlock.end;
  }
  const finalCapacities = computeAllCapacities(participants, schedStart, schedEnd);
  const finalCtx: ScoreContext = {
    taskMap: new Map(tasks.map(t => [t.id, t])),
    pMap: new Map(participants.map(p => [p.id, p])),
    capacities: finalCapacities,
  };
  const score = computeScheduleScore(tasks, participants, lsResult.assignments, config, finalCtx);

  return {
    assignments: lsResult.assignments,
    score,
    feasible: validation.valid && remainingUnfilled.length === 0,
    unfilledSlots: remainingUnfilled,
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
 *  2. Higher composite score (fairness - penalties)
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
 * Run the optimizer multiple times with shuffled participant order and
 * task-order jitter, keeping the best result. This introduces diversity
 * in both participant ordering and task scheduling priority.
 *
 * @param attempts Number of optimization attempts (default: 2000)
 * @param onProgress Optional callback fired after each attempt
 */
export function optimizeMultiAttempt(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  lockedAssignments: Assignment[] = [],
  attempts: number = 2000,
  onProgress?: MultiAttemptProgressCallback,
  disabledHC?: Set<string>,
): OptimizationResult {
  let best: OptimizationResult | null = null;
  const totalStart = Date.now();
  const diagRows: Array<{ '#': number; score: string; unfilled: number; stdDev: string; penalty: string; improved: string }> = [];

  for (let i = 0; i < attempts; i++) {
    // Shuffle participant order to create diversity
    // (first attempt uses original order for determinism)
    const shuffledParticipants = i === 0
      ? [...participants]
      : shuffle([...participants]);

    // Task-order jitter: 0 for first attempt, 0.3 for subsequent
    const jitter = i === 0 ? 0 : 0.3;
    const result = optimize(tasks, shuffledParticipants, config, lockedAssignments, disabledHC, jitter);

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
 * overlay. This avoids 2000 individual setTimeout round-trips while
 * still keeping the UI responsive.
 */
const ASYNC_BATCH_SIZE = 4;

export function optimizeMultiAttemptAsync(
  tasks: Task[],
  participants: Participant[],
  config: SchedulerConfig,
  lockedAssignments: Assignment[] = [],
  attempts: number = 2000,
  onProgress?: MultiAttemptProgressCallback,
  disabledHC?: Set<string>,
): Promise<OptimizationResult> {
  return new Promise((resolve) => {
    let best: OptimizationResult | null = null;
    let i = 0;
    const totalStart = Date.now();
    const diagRows: Array<{ '#': number; score: string; unfilled: number; stdDev: string; penalty: string; improved: string }> = [];

    function runBatch(): void {
      const batchEnd = Math.min(i + ASYNC_BATCH_SIZE, attempts);

      while (i < batchEnd) {
        // Shuffle participant order (first attempt uses original order)
        const shuffledParticipants = i === 0
          ? [...participants]
          : shuffle([...participants]);

        // Task-order jitter: 0 for first attempt, 0.3 for subsequent
        const jitter = i === 0 ? 0 : 0.3;
        const result = optimize(tasks, shuffledParticipants, config, lockedAssignments, disabledHC, jitter);

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
