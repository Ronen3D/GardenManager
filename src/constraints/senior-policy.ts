/**
 * Senior Role Policy  (HC-13 hard blocks + soft penalties)
 *
 * Defines which tasks/slots are "natural" for each senior level and provides
 * hard-constraint checks + soft-penalty scoring.
 *
 * Natural roles:
 *   L4 → Segol Main (Adanit), Karov commander, Karovit commander
 *   L3 → Segol Secondary (Adanit), Karov commander, Karovit commander
 *   L2 → Segol Secondary (Adanit), Karov commander, Karovit commander
 *
 * Hard blocks:
 *   L4 → forbidden from everything except natural roles + Hamama
 *   L3 → forbidden from Mamtera
 *
 * Soft penalties (very high):
 *   L4 in Hamama → allowed but heavily penalised
 *   Any senior in a non-natural slot → heavily penalised
 *
 * Overload escape valve:
 *   When L0 average effective hours > threshold, senior penalties are
 *   multiplied by a small factor (e.g. 0.1) so the optimizer can assign
 *   seniors to relieve L0 pressure.
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
  DEFAULT_CONFIG,
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

  // Karov and Karovit commander slots are natural for all seniors
  if (isKarov || isKarovit) return true;

  if (isAdanit) {
    // L4 → only Segol Main slots
    if (level === Level.L4) return slot.adanitTeam === AdanitTeam.SegolMain;
    // L3, L2 → only Segol Secondary slots
    if (level === Level.L3 || level === Level.L2) return slot.adanitTeam === AdanitTeam.SegolSecondary;
  }

  return false;
}

// ─── Hard constraint: absolute blocks ────────────────────────────────────────

/**
 * HC-13 · Senior hard blocks
 *
 * Returns a violation if:
 *   - L4 is assigned to anything other than their natural slots or Hamama
 *   - L3 is assigned to Mamtera
 *
 * L2 has no hard blocks (only soft penalties for out-of-role assignments).
 */
export function checkSeniorHardBlock(
  participant: Participant,
  task: Task,
  slot: SlotRequirement,
): ConstraintViolation | null {
  const lvl = participant.level;

  // Only applies to L3+
  if (lvl === Level.L0 || lvl === Level.L2) return null;

  // L4: forbidden from everything except natural roles + Hamama
  if (lvl === Level.L4) {
    const isHamama = task.type === TaskType.Hamama;
    if (!isHamama && !isNaturalRole(lvl, task, slot)) {
      return {
        code: 'SENIOR_HARD_BLOCK',
        message: `L4 participant "${participant.name}" cannot be assigned to ${task.name} [${slot.label || slot.slotId}] — only natural Adanit(Main)/Karov/Karovit slots and Hamama are allowed`,
        severity: ViolationSeverity.Error,
        participantId: participant.id,
        taskId: task.id,
        slotId: slot.slotId,
      };
    }
  }

  // L3: forbidden from Mamtera
  if (lvl === Level.L3 && task.type === TaskType.Mamtera) {
    return {
      code: 'SENIOR_HARD_BLOCK',
      message: `L3 participant "${participant.name}" cannot be assigned to Mamtera task "${task.name}"`,
      severity: ViolationSeverity.Error,
      participantId: participant.id,
      taskId: task.id,
      slotId: slot.slotId,
    };
  }

  return null;
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
 * When `l0AvgEffectiveHours` exceeds the config threshold, penalties are
 * scaled down by `l0OverloadPenaltyMultiplier` so the optimizer can
 * relieve L0 pressure by assigning seniors to non-natural slots.
 */
export function computeSeniorOutOfRolePenalty(
  participants: Participant[],
  assignments: Assignment[],
  tasks: Task[],
  l0AvgEffectiveHours: number,
  config: SchedulerConfig = DEFAULT_CONFIG,
): number {
  const pMap = new Map(participants.map(p => [p.id, p]));
  const tMap = new Map(tasks.map(t => [t.id, t]));

  // Determine penalty multiplier based on L0 overload
  const l0Overloaded = l0AvgEffectiveHours > config.l0OverloadThresholdHours;
  const multiplier = l0Overloaded ? config.l0OverloadPenaltyMultiplier : 1.0;

  let totalPenalty = 0;

  for (const a of assignments) {
    const p = pMap.get(a.participantId);
    const task = tMap.get(a.taskId);
    if (!p || !task) continue;
    if (p.level === Level.L0) continue;

    const slot = task.slots.find(s => s.slotId === a.slotId);
    if (!slot) continue;

    // L4 in Hamama — allowed but very undesirable
    if (p.level === Level.L4 && task.type === TaskType.Hamama) {
      totalPenalty += config.l4HamamaPenalty * multiplier;
      continue;
    }

    // Any senior in a non-natural slot
    if (!isNaturalRole(p.level, task, slot)) {
      totalPenalty += config.seniorOutOfRolePenalty * multiplier;
    }
  }

  return totalPenalty;
}
