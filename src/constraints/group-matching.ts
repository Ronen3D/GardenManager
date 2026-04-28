/**
 * Bipartite max-matching primitive for same-group task feasibility.
 *
 * Same-group tasks (e.g. Adanit) require every slot in the task to be filled
 * from a single group. Whether a group can fill all slots is a bipartite
 * matching question: slots on one side, group members on the other, edges
 * for "this member is eligible for this slot".
 *
 * Plain greedy ("for each slot pick first eligible unclaimed member") is not
 * a maximum matching — it can fail to cover slots that a different selection
 * would have covered. Concretely, when slots have heterogeneous tightness
 * (e.g. slot X needs Nitzan, slot Y needs Nitzan+Hamama, member P1 has
 * Nitzan, member P2 has both), greedy iterating slot X first and picking P2
 * leaves Y unfillable, even though X→P1, Y→P2 is valid.
 *
 * This module solves the matching exactly using augmenting paths (Kuhn's
 * algorithm). Within-slot candidate ordering is honored where possible —
 * augmenting paths only re-route an already-matched member when leaving them
 * in place would cause a downstream slot to fail. So callers that pass a
 * priority-ordered candidate list (workload-first, etc.) get their
 * preference whenever feasibility allows.
 *
 * Determinism: result depends only on input order. Same input → same matching.
 *
 * Complexity: O(S · C) where S = slot count, C = sum of candidate-list
 * lengths. Negligible at the scale used here.
 */

export interface SlotCandidates {
  /** Stable identifier for this slot. The caller's slotId is fine. */
  slotId: string;
  /** Participant IDs eligible for this slot, preferred-first. */
  candidates: string[];
}

export interface MatchingResult {
  /** slotId → participantId, only for slots that were matched. */
  assignments: Map<string, string>;
  /** slotIds that could not be matched. Empty when the matching covers every slot. */
  unfilled: string[];
}

/**
 * Find a maximum bipartite matching between slots and participants.
 *
 * Uses augmenting paths (Kuhn's algorithm). When a covering matching exists,
 * one is returned; otherwise the result is the largest possible partial
 * matching, with the leftover slot ids in `unfilled`.
 */
export function findMaxMatching(slots: SlotCandidates[]): MatchingResult {
  const slotToParticipant = new Map<string, string>();
  const participantToSlot = new Map<string, string>();

  for (const slot of slots) {
    const visited = new Set<string>();
    tryAugment(slot.slotId, slots, slotToParticipant, participantToSlot, visited);
  }

  const unfilled: string[] = [];
  for (const slot of slots) {
    if (!slotToParticipant.has(slot.slotId)) unfilled.push(slot.slotId);
  }
  return { assignments: slotToParticipant, unfilled };
}

/**
 * Attempt to match `slotId` by either claiming a free candidate or by
 * re-routing the candidate's currently-matched slot to a different one.
 */
function tryAugment(
  slotId: string,
  slots: SlotCandidates[],
  slotToParticipant: Map<string, string>,
  participantToSlot: Map<string, string>,
  visitedParticipants: Set<string>,
): boolean {
  const slot = slots.find((s) => s.slotId === slotId);
  if (!slot) return false;
  for (const pid of slot.candidates) {
    if (visitedParticipants.has(pid)) continue;
    visitedParticipants.add(pid);
    const occupant = participantToSlot.get(pid);
    if (
      occupant === undefined ||
      tryAugment(occupant, slots, slotToParticipant, participantToSlot, visitedParticipants)
    ) {
      slotToParticipant.set(slotId, pid);
      participantToSlot.set(pid, slotId);
      return true;
    }
  }
  return false;
}
