/**
 * Shared run-coalescing primitive (shift-splitting, plan D13–D16).
 *
 * A "legal run" is a participant's maximal chain of CONTIGUOUS (gap == 0),
 * SAME-`sourceName` task blocks whose cumulative length does not exceed K (the
 * original pre-split occurrence duration). Coalescing such a chain into one
 * synthetic block is what makes split halves behave, for HC-12 / HC-14 / the
 * rest-calculator (SC-6), exactly like the single unsplit shift they came from:
 *
 *   - ½A + ½B  (= K)        → ONE block → HC-12 silent (note 6 allowed)
 *   - ½A + ½B + ½C (> K)    → [K-run] + leftover ½C, touching at gap 0
 *                             → HC-12 fires for blocksConsecutive (run cap),
 *                               silent for non-blocking (note 9)
 *   - one person, both halves of one occurrence → ONE block = the original
 *     occurrence → no spurious self-violation (D16; HC-16 separately forbids
 *     this as a product rule, this is the defense-in-depth).
 *
 * The cap K is intrinsic here (derived from `splitOriginalMs`), so coalescing
 * is correct even when the run-cap-bearing HC is globally disabled — beyond K
 * the chain simply stops merging and the existing pairwise HC fires.
 *
 * IDENTITY GUARANTEE: if no task in the input carries `splitGroupId` the input
 * array reference is returned unchanged with zero allocation. So when
 * splitting is off (or this participant holds no split halves) every consumer
 * is byte-for-byte its pre-feature self — the basis of the zero-regression
 * proof for stages that thread this in.
 *
 * Pure; no engine deps; usable by Node/CLI and web builds.
 */

import type { Task } from '../../models/types';

/** True if any task carries a split linkage (cheap pre-scan / short-circuit). */
export function hasAnySplit(tasks: Task[]): boolean {
  for (const t of tasks) if (t.splitGroupId !== undefined) return true;
  return false;
}

/**
 * Coalesce contiguous same-source ≤K runs in a participant's task list.
 *
 * @param sorted Tasks for ONE participant, ascending by `timeBlock.start`.
 *               (Every consumer already produces this ordering.)
 * @returns The SAME array reference when no task is split; otherwise a new
 *          array where each merged run is one synthetic `Task` (spread from
 *          its first member, with merged `timeBlock` and a stable run `id`)
 *          and every un-mergeable task is passed through by reference.
 */
export function coalesceTaskRuns(sorted: Task[]): Task[] {
  // Global identity short-circuit — the zero-regression path.
  if (sorted.length < 2 || !hasAnySplit(sorted)) return sorted;

  const out: Task[] = [];
  let runMembers: Task[] = [sorted[0]];
  let runStart = sorted[0].timeBlock.start.getTime();
  let runEnd = sorted[0].timeBlock.end.getTime();

  const flush = (): void => {
    if (runMembers.length === 1) {
      out.push(runMembers[0]); // pass-through by reference (no synthesis)
      return;
    }
    const first = runMembers[0];
    // Stable, collision-resistant synthetic id. A coalesced run is ONE element
    // so the existing `a.id === b.id` self-skip in HC-12/HC-14 still holds; the
    // id only needs to differ from real task ids and from sibling runs.
    const runId = `run::${first.splitGroupId ?? first.id}::${runStart}-${runEnd}`;
    out.push({
      ...first,
      id: runId,
      timeBlock: { start: new Date(runStart), end: new Date(runEnd) },
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i];
    const tStart = t.timeBlock.start.getTime();
    const tEnd = t.timeBlock.end.getTime();
    const first = runMembers[0];

    // K = original (pre-split) occurrence duration for this run's source.
    // All members of a legal run share one source/template, hence one K.
    // Whole tasks (no splitOriginalMs) use their own span ⇒ two whole tasks
    // never merge (2 occurrences > 1), preserving today's HC behavior.
    const k = first.splitOriginalMs ?? runEnd - runStart;
    const contiguous = tStart === runEnd;
    const sameSource = t.sourceName !== undefined && t.sourceName === first.sourceName;
    const splitInvolved = first.splitGroupId !== undefined || t.splitGroupId !== undefined;
    const withinK = tEnd - runStart <= k;

    if (contiguous && sameSource && splitInvolved && withinK) {
      runMembers.push(t);
      runEnd = tEnd;
    } else {
      flush();
      runMembers = [t];
      runStart = tStart;
      runEnd = tEnd;
    }
  }
  flush();
  return out;
}
