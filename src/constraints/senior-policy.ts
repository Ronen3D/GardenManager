/**
 * Senior Role Policy  (HC-13 hard blocks + soft penalties)
 *
 * Strict isolation model — seniors are locked to their natural domain.
 *
 * Natural roles:
 *   L4 → Segol Main (Adanit), Karov commander, Karovit commander
 *   L3 → Segol Secondary (Adanit), Karov commander, Karovit commander
 *   L2 → Segol Secondary (Adanit), Karov commander, Karovit commander
 *
 * Hard blocks (apply to ALL seniors L2/L3/L4):
 *   Forbidden from ANY task that is not their natural domain.
 *   The ONLY exception is Hamama (see below).
 *
 * Hamama exception (absolute last resort):
 *   Seniors MAY be assigned to Hamama, but with the maximum possible
 *   penalty.  The system should only place a senior in Hamama when the
 *   alternative is a complete failure to generate a schedule.
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

// ─── Natural-role detection ──────────────────────────────────────────────────

/**
 * Returns true if the given (task, slot) combination is a "natural" assignment
 * for the participant's level.
 *
 *  L0 → always natural (no restrictions from this policy)
 *  L4 → Segol Main (Adanit), Karov, Karovit
 *  L3 → Segol Secondary (Adanit), Karov, Karovit
 *  L2 → Segol Secondary (Adanit), Karov, Karovit
 */
export function isNaturalRole(
  level: Level,
  task: Task,
  slot: SlotRequirement,
): boolean {
  if (level === Level.L0) return true;

  const isKarov = task.type === TaskType.Karov;
  const isKarovit = task.type === TaskType.Karovit;
  const isAdanit = task.type === TaskType.Adanit;

  // Karov and Karovit: only the commander slots (which explicitly list
  // the senior's level) are natural. L0-only slots are NOT natural for seniors.
  if (isKarov || isKarovit) return slot.acceptableLevels.includes(level);

  if (isAdanit) {
    // L4 → only Segol Main slots
    if (level === Level.L4) return slot.adanitTeam === AdanitTeam.SegolMain;
    // L3 → Segol Main or Segol Secondary (breaks L4 monopoly on Main)
    if (level === Level.L3)
      return slot.adanitTeam === AdanitTeam.SegolMain || slot.adanitTeam === AdanitTeam.SegolSecondary;
    // L2 → only Segol Secondary slots
    if (level === Level.L2) return slot.adanitTeam === AdanitTeam.SegolSecondary;
  }

  return false;
}

// ─── Hard constraint: absolute blocks ────────────────────────────────────────

/**
 * HC-13 · Senior hard blocks (strict isolation)
 *
 * Returns a violation if any senior (L2, L3, L4) is assigned to a task
 * that is NOT their natural domain and NOT Hamama.
 *
 * Hamama is the ONLY non-natural exception — it is allowed but carries
 * the maximum soft penalty (absolute last resort).
 */
export function checkSeniorHardBlock(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
): ConstraintViolation | null {
  const lvl = participant.level;

  // Only applies to seniors (L2/L3/L4)
  if (lvl === Level.L0) return null;

  // Hamama is the sole non-natural exception (soft-penalised, not blocked)
  if (task.type === TaskType.Hamama) return null;

  // Natural role → allowed
  if (isNaturalRole(lvl, task, slot)) return null;

  // Everything else is forbidden
  return {
    code: 'SENIOR_HARD_BLOCK',
    message: `L${lvl} participant "${participant.name}" cannot be assigned to ${task.name} [${slot.label || slot.slotId}] — seniors are restricted to their natural domain (Adanit/Karov/Karovit) and Hamama`,
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

// ─── Soft penalty: out-of-role assignments ───────────────────────────────────

/**
 * Compute the total soft penalty for senior out-of-role assignments.
 *
 * Under the strict isolation model only Hamama remains as a soft-penalised
 * exception.  All other non-natural assignments are hard-blocked and should
 * never reach this function, but guard defensively.
 *
 * Hamama carries the maximum penalty (`seniorHamamaPenalty`) regardless of
 * senior level — it is an absolute last resort.
 */
export function computeSeniorOutOfRolePenalty(
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

    const slot = task.slots.find(s => s.slotId === a.slotId);
    if (!slot) continue;

    // Any senior in Hamama — absolute last resort, maximum penalty
    if (task.type === TaskType.Hamama) {
      totalPenalty += config.seniorHamamaPenalty;
      continue;
    }

    // Defensive: any non-natural assignment that slipped past hard blocks
    if (!isNaturalRole(p.level, task, slot)) {
      totalPenalty += config.seniorOutOfRolePenalty;
    }
  }

  return totalPenalty;
}
