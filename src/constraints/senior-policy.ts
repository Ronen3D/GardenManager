/**
 * Senior Role Policy  (soft penalties only)
 *
 * Natural roles (data-driven — no task-type branching):
 *   A slot is natural for a senior if their level appears in
 *   acceptableLevels at normal priority (not lowPriority).
 *
 * Hard level-gating is handled entirely by HC-1 (isLevelSatisfied).
 * This module provides:
 *   - isNaturalRole(): classifies assignments as natural vs last-resort
 *   - computeLowPriorityLevelPenalty(): soft penalty for lowPriority slots
 *
 * Legacy exports checkSeniorHardBlock / validateSeniorHardBlocks are
 * kept for backward compatibility but always return no violations.
 */

import {
  Level,
  Task,
  SlotRequirement,
  Assignment,
  Participant,
  ConstraintViolation,
  SchedulerConfig,
} from '../models/types';
import { isAcceptedLevel, isLowPriority } from '../models/level-utils';

// ─── Natural-role detection ──────────────────────────────────────────────────

/**
 * Returns true if the given (task, slot) combination is a "natural" assignment
 * for the participant's level.
 *
 * Level-agnostic:
 *  lowPriority levels → NOT natural (tolerated as last resort via soft penalty)
 *  Listed at normal priority → natural
 *  Not listed at all → not natural (blocked by HC-1)
 */
export function isNaturalRole(
  level: Level,
  _task: Task,
  slot: SlotRequirement,
): boolean {
  // A level listed as lowPriority is NOT a natural role — it's a last resort
  if (isLowPriority(slot.acceptableLevels, level)) return false;

  // Trust acceptableLevels: natural if listed at normal priority
  return isAcceptedLevel(slot.acceptableLevels, level);
}

// ─── Legacy hard-constraint stubs (kept for backward compatibility) ─────────

/**
 * Legacy stub — always returns null (no violation).
 * Hard level-gating is now handled entirely by HC-1 (isLevelSatisfied).
 */
export function checkSeniorHardBlock(
  _participant: Participant,
  _task: Task,
  _slot: SlotRequirement,
): ConstraintViolation | null {
  return null;
}

/**
 * Legacy stub — always returns empty array.
 * Hard level-gating is now handled entirely by HC-1 (isLevelSatisfied).
 */
export function validateSeniorHardBlocks(
  _participants: Participant[],
  _assignments: Assignment[],
  _tasks: Task[],
): ConstraintViolation[] {
  return [];
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
