/**
 * Senior Role Policy  (HC-13 hard blocks + soft penalties)
 *
 * Strict isolation model — seniors are locked to their natural domain.
 *
 * Natural roles (data-driven — no task-type branching):
 *   A slot is natural for a senior if their level appears in
 *   acceptableLevels at normal priority (not lowPriority).
 *
 * Hard blocks (apply to ALL seniors L2/L3/L4):
 *   Forbidden from ANY task that is not their natural domain,
 *   UNLESS their level appears as lowPriority in the slot's
 *   acceptableLevels (allowed with soft penalty).
 *
 * Low-priority exception:
 *   Slots that list a senior level with lowPriority=true allow that
 *   senior as an absolute last resort, with the maximum possible
 *   penalty. The system should only place them there when the
 *   alternative is a complete failure.
 *
 * Zero exceptions:
 *   Seniors can no longer be used for general tasks even if L0 is under
 *   extreme load.
 */

import {
  Level,
  Task,
  SlotRequirement,
  Assignment,
  Participant,
  ConstraintViolation,
  ViolationSeverity,
  SchedulerConfig,
} from '../models/types';
import { isAcceptedLevel, isLowPriority } from '../models/level-utils';
import { describeSlot } from '../utils/date-utils';

// ─── Natural-role detection ──────────────────────────────────────────────────

/**
 * Returns true if the given (task, slot) combination is a "natural" assignment
 * for the participant's level.
 *
 *  L0 → always natural (no restrictions from this policy)
 *  lowPriority levels → NOT natural (tolerated as last resort via soft penalty)
 *  All other levels → trust acceptableLevels at normal priority
 */
export function isNaturalRole(
  level: Level,
  _task: Task,
  slot: SlotRequirement,
): boolean {
  if (level === Level.L0) return true;

  // A level listed as lowPriority is NOT a natural role — it's a last resort
  if (isLowPriority(slot.acceptableLevels, level)) return false;

  // Trust acceptableLevels: natural if listed at normal priority
  return isAcceptedLevel(slot.acceptableLevels, level);
}

// ─── Hard constraint: absolute blocks ────────────────────────────────────────

/**
 * HC-13 · Senior hard blocks (strict isolation)
 *
 * Returns a violation if any senior (L2, L3, L4) is assigned to a task
 * that is NOT their natural domain and NOT listed (even as lowPriority)
 * in the slot's acceptableLevels.
 *
 * Low-priority exception: if the senior's level appears in acceptableLevels
 * with lowPriority=true, the assignment is allowed (with maximum soft penalty).
 */
export function checkSeniorHardBlock(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
): ConstraintViolation | null {
  const lvl = participant.level;

  // Only applies to seniors (L2/L3/L4)
  if (lvl === Level.L0) return null;

  // Low-priority level: allowed (soft-penalised via lowPriorityLevelPenalty)
  if (isLowPriority(slot.acceptableLevels, lvl)) return null;

  // Natural role → allowed
  if (isNaturalRole(lvl, task, slot)) return null;

  // Everything else is forbidden
  return {
    code: 'SENIOR_HARD_BLOCK',
    message: `${participant.name} (דרגה ${lvl}) אינו/ה ניתן/ת לשיבוץ ב-${task.name} [${describeSlot(slot.label, task.timeBlock)}] — לא בתחום התפקיד הטבעי שלו/ה`,
    severity: ViolationSeverity.Error,
    participantId: participant.id,
    taskId: task.id,
    slotId: slot.slotId,
  };
}

/**
 * Validate all assignments for senior hard blocks.
 * Returns an array of violations (empty = all OK).
 */
export function validateSeniorHardBlocks(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
): ConstraintViolation[] {
  const pMap = new Map(participants.map(p => [p.id, p]));
  const tMap = new Map(tasks.map(t => [t.id, t]));
  const violations: ConstraintViolation[] = [];

  for (const a of assignments) {
    const p = pMap.get(a.participantId);
    const task = tMap.get(a.taskId);
    if (!p || !task) continue;
    if (p.level === Level.L0) continue;

    const slot = task.slots.find(s => s.slotId === a.slotId);
    if (!slot) continue;

    const v = checkSeniorHardBlock(p, task, slot);
    if (v) violations.push(v);
  }

  return violations;
}

// ─── Soft penalty: low-priority level assignments ──────────────────────────

/**
 * Compute the total soft penalty for participants assigned to slots where
 * their level is marked as lowPriority.
 *
 * This is a general mechanism: any level can be marked lowPriority in any slot.
 * For example, Hamama marking L4 as lowPriority means L4 is an absolute last
 * resort for that slot. The penalty (`lowPriorityLevelPenalty`) is maximum —
 * the system should only place them there when the alternative is a complete failure.
 */
export function computeLowPriorityLevelPenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  config: SchedulerConfig,
  prebuiltPMap?: Map<string, Participant>,
  prebuiltTMap?: Map<string, Task>,
): number {
  const pMap = prebuiltPMap ?? new Map(participants.map(p => [p.id, p]));
  const tMap = prebuiltTMap ?? new Map(tasks.map(t => [t.id, t]));

  let totalPenalty = 0;

  for (const a of assignments) {
    const p = pMap.get(a.participantId);
    const task = tMap.get(a.taskId);
    if (!p || !task) continue;

    const slot = task.slots.find(s => s.slotId === a.slotId);
    if (!slot) continue;

    if (isLowPriority(slot.acceptableLevels, p.level)) {
      totalPenalty += config.lowPriorityLevelPenalty;
    }
  }

  return totalPenalty;
}
