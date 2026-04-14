/**
 * Pure math helpers used by the auto-tuner. Extracted so they can be
 * imported from both the web bundle (via `src/web/auto-tuner.ts`) and the
 * Node test harness (via `src/test.ts`) — Node-side tests otherwise can't
 * reach into `src/web/` because that dir is excluded from `tsconfig.json`.
 *
 * No DOM, no storage, no side effects.
 */

export interface TunerDim {
  /** Inclusive min of the log-scaled sampling range. */
  min: number;
  /** Inclusive max of the log-scaled sampling range. */
  max: number;
  /** Sample and round as an integer? */
  integer: boolean;
}

/** Mulberry32 — deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function iqr(values: number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return q(0.75) - q(0.25);
}

/**
 * Draw `count` samples per dimension using Latin Hypercube over log-space.
 * Each row is a weight vector with one value per `dims[i]`.
 */
export function latinHypercubeSample(dims: TunerDim[], count: number, rng: () => number): number[][] {
  const samples: number[][] = Array.from({ length: count }, () => new Array<number>(dims.length).fill(0));

  for (let d = 0; d < dims.length; d++) {
    const dim = dims[d];
    const logMin = Math.log(dim.min);
    const logMax = Math.log(dim.max);

    const permutation = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = permutation[i];
      permutation[i] = permutation[j];
      permutation[j] = tmp;
    }
    for (let i = 0; i < count; i++) {
      const u = (permutation[i] + rng()) / count;
      const logVal = logMin + u * (logMax - logMin);
      let v = Math.exp(logVal);
      if (dim.integer) v = Math.max(dim.min, Math.round(v));
      samples[i][d] = v;
    }
  }
  return samples;
}

/** Max `unfilled` across a list of evaluation results. */
export function maxUnfilledIn<T extends { unfilled: number }>(results: T[]): number {
  let m = 0;
  for (const r of results) if (r.unfilled > m) m = r.unfilled;
  return m;
}

/**
 * Stability-aware rank score used in Phase 4.
 *   rank = median(refScore) − λ·IQR(refScore) − μ·maxUnfilled
 * Higher is better.
 */
export function computeRankScore<T extends { refScore: number; unfilled: number }>(
  results: T[],
  lambda: number,
  mu: number,
): number {
  if (results.length === 0) return -Infinity;
  const comps = results.map((r) => r.refScore);
  return median(comps) - lambda * iqr(comps) - mu * maxUnfilledIn(results);
}
