/**
 * Senior Role Policy  (HC-13 hard blocks + soft penalties)
 *
 * Strict isolation model — seniors are locked to their natural domain.
 *
 * Natural roles (for known task types):
 *   L4 → Segol Main (Adanit), Karov commander, Karovit commander
 *   L3 → Segol Main (Adanit), Karov commander, Karovit commander
 *   L2 → Segol Secondary (Adanit), Karov commander, Karovit commander
 *
 * For unknown/custom task types, the slot's acceptableLevels is trusted:
 *   if the slot explicitly includes a senior level, it is considered natural.
 *
 * Hard blocks (apply to ALL seniors L2/L3/L4):
 *   Forbidden from ANY task that is not their natural domain.
 *   The ONLY exception is preferJuniors tasks (see below).
 *
 * preferJuniors exception (absolute last resort):
 *   Tasks flagged with preferJuniors (e.g., Hamama) allow ONLY L4 as
 *   a last resort. L2 and L3 are completely forbidden.
 *   L4 carries the maximum possible penalty — the system should only
 *   place L4 there when the alternative is a complete failure.
 *
 * Zero exceptions:
 *   Seniors can no longer be used for general tasks even if L0 is under
 *   extreme load.  The L0 Overload Escape Valve has been removed.
 */

import {
  Level,
  Task,
  TaskType,
  SlotRequirement,
  AdanitTeam,
  Assignment,
  Participant,
  ConstraintViolation,
  ViolationSeverity,
  SchedulerConfig,
} from '../models/types';

/** Known task types that have explicit natural-role logic. */
const KNOWN_SENIOR_TYPES = new Set<string>([TaskType.Karov, TaskType.Karovit, TaskType.Adanit]);

// ─── Natural-role detection ──────────────────────────────────────────────────

/**
 * Returns true if the given (task, slot) combination is a "natural" assignment
 * for the participant's level.
 *
 *  L0 → always natural (no restrictions from this policy)
 *  Known types (Karov/Karovit/Adanit): specific rules per type
 *  Unknown/custom types: trust the slot's acceptableLevels
 */
export function isNaturalRole(
  level: Level,
  task: Task,
  slot: SlotRequirement,
): boolean {
  if (level === Level.L0) return true;

  // preferJuniors tasks: no senior is "natural" here — L4 is only tolerated as last resort
  if (task.preferJuniors) return false;

  const isKarov = task.type === TaskType.Karov;
  const isKarovit = task.type === TaskType.Karovit;
  const isAdanit = task.type === TaskType.Adanit;

  // Karov and Karovit: only the commander slots (which explicitly list
  // the senior's level) are natural. L0-only slots are NOT natural for seniors.
  if (isKarov || isKarovit) return slot.acceptableLevels.includes(level);

  if (isAdanit) {
    // L4 → only Segol Main slots
    if (level === Level.L4) return slot.adanitTeam === AdanitTeam.SegolMain;
    // L3 → only Segol Main slots (same as L4)
    if (level === Level.L3) return slot.adanitTeam === AdanitTeam.SegolMain;
    // L2 → only Segol Secondary slots
    if (level === Level.L2) return slot.adanitTeam === AdanitTeam.SegolSecondary;
  }

  // Unknown/custom task types: trust the slot's explicit level configuration.
  // If the slot declares a senior level as acceptable, the senior is natural for it.
  if (!KNOWN_SENIOR_TYPES.has(task.type as string)) {
    return slot.acceptableLevels.includes(level);
  }

  return false;
}

// ─── Hard constraint: absolute blocks ────────────────────────────────────────

/**
 * HC-13 · Senior hard blocks (strict isolation)
 *
 * Returns a violation if any senior (L2, L3, L4) is assigned to a task
 * that is NOT their natural domain and NOT a preferJuniors task.
 *
 * preferJuniors exception: ONLY L4 may be assigned as an absolute
 * last resort (with maximum soft penalty). L2 and L3 are hard-blocked.
 */
export function checkSeniorHardBlock(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
): ConstraintViolation | null {
  const lvl = participant.level;

  // Only applies to seniors (L2/L3/L4)
  if (lvl === Level.L0) return null;

  // preferJuniors tasks: only L4 is allowed (soft-penalised). L2 and L3 are hard-blocked.
  if (task.preferJuniors) {
    if (lvl === Level.L4) return null; // L4 allowed (penalised via soft constraint)
    return {
      code: 'SENIOR_HARD_BLOCK',
      message: `משתתף בדרגה ${lvl} "${participant.name}" אסור ב-${task.name} — רק דרגה 0 (מועדף) או דרגה 4 (מוצא אחרון) ניתנים לשיבוץ`,
      severity: ViolationSeverity.Error,
      participantId: participant.id,
      taskId: task.id,
      slotId: slot.slotId,
    };
  }

  // Natural role → allowed
  if (isNaturalRole(lvl, task, slot)) return null;

  // Everything else is forbidden
  return {
    code: 'SENIOR_HARD_BLOCK',
    message: `משתתף בדרגה ${lvl} "${participant.name}" לא ניתן לשיבוץ ב-${task.name} [${slot.label || slot.slotId}] — סגל מוגבלים לתחום הטבעי שלהם`,
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

// ─── Soft penalty: L4 in preferJuniors tasks ────────────────────────────────

/**
 * Compute the total soft penalty for L4 participants assigned to preferJuniors tasks.
 *
 * This is the sole remaining soft-penalised senior exception. L2 and L3
 * are hard-blocked from preferJuniors tasks by HC-13. All other non-natural
 * assignments are also hard-blocked. L4 in a preferJuniors task carries
 * the maximum penalty (`seniorJuniorPreferencePenalty`) — it is an absolute last resort.
 */
export function computeSeniorJuniorPreferencePenalty(
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
    if (p.level === Level.L0) continue;

    // L4 in preferJuniors task — absolute last resort, maximum penalty
    // (L2/L3 are hard-blocked by HC-13 and should never reach here)
    if (task.preferJuniors && p.level === Level.L4) {
      totalPenalty += config.seniorJuniorPreferencePenalty;
    }
  }

  return totalPenalty;
}
