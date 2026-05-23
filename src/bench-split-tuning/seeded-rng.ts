/**
 * Deterministic seeded RNG for paired benchmarks.
 *
 * The optimizer uses raw `Math.random()` in multiple places (participant
 * shuffle, task-order jitter, SA acceptance, group-trial ordering, etc.).
 * To make ON-vs-OFF and parameter sweeps a *fair* comparison we patch
 * `Math.random` with a deterministic stream keyed by an integer seed.
 *
 * Algorithm: Mulberry32 — small, fast, well-distributed in [0,1).
 *   https://en.wikipedia.org/wiki/Linear_congruential_generator (variant)
 *
 * Usage:
 *   withSeededRandom(42, () => optimizeMultiAttempt(...));
 *
 * The same seed reproduces the same Math.random sequence; passing the same
 * seed to a paired OFF/ON pair guarantees identical participant shuffles,
 * task-order jitter, and SA decisions up until the structural divergence
 * caused by splitting itself.
 */

function makeMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Run `fn` with Math.random replaced by a deterministic stream seeded with `seed`. */
export function withSeededRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random;
  const rng = makeMulberry32(seed);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Math as any).random = rng;
  try {
    return fn();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Math as any).random = original;
  }
}
