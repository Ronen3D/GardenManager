/**
 * Statistical helpers for the benchmark report.
 *
 * Goal: distinguish a real shift-splitting effect from SA noise. Every
 * (scenario, params) cell has N independent paired runs; this module
 * computes the standard descriptive statistics + paired comparisons.
 */

export interface Summary {
  n: number;
  mean: number;
  median: number;
  stddev: number;
  min: number;
  max: number;
  q1: number;
  q3: number;
}

export function summarize(xs: number[]): Summary {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, median: 0, stddev: 0, min: 0, max: 0, q1: 0, q3: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  return {
    n,
    mean,
    median: quantile(sorted, 0.5, true),
    stddev,
    min: sorted[0],
    max: sorted[n - 1],
    q1: quantile(sorted, 0.25, true),
    q3: quantile(sorted, 0.75, true),
  };
}

function quantile(sorted: number[], q: number, isSorted: boolean): number {
  const s = isSorted ? sorted : [...sorted].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const idx = (s.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Paired-delta summary: `b - a` per matched seed, then summarize. */
export function pairedDelta(a: number[], b: number[]): Summary {
  if (a.length !== b.length) {
    throw new Error(`pairedDelta length mismatch: a=${a.length} b=${b.length}`);
  }
  const deltas = a.map((v, i) => b[i] - v);
  return summarize(deltas);
}

/** Paired t-stat for "mean delta = 0". Returns t value; |t| > 2 ≈ p < 0.05 for n≥20. */
export function pairedTStat(a: number[], b: number[]): { tStat: number; meanDelta: number; sdDelta: number; n: number } {
  if (a.length !== b.length) throw new Error('length mismatch');
  const n = a.length;
  const deltas = a.map((v, i) => b[i] - v);
  const meanDelta = deltas.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? deltas.reduce((s, x) => s + (x - meanDelta) ** 2, 0) / (n - 1) : 0;
  const sdDelta = Math.sqrt(variance);
  const seDelta = sdDelta / Math.sqrt(n);
  return { tStat: seDelta > 0 ? meanDelta / seDelta : 0, meanDelta, sdDelta, n };
}

/** 95% CI half-width assuming Student-t with n-1 df; uses 1.96 for n≥30, otherwise inflates. */
export function ci95HalfWidth(stddev: number, n: number): number {
  if (n <= 1) return 0;
  // Approximate t-multiplier for two-sided 95% CI
  const tMult = n >= 30 ? 1.96 : n >= 20 ? 2.09 : n >= 10 ? 2.26 : n >= 5 ? 2.78 : 4.30;
  return tMult * (stddev / Math.sqrt(n));
}

export function fmt(n: number, digits: number = 2): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(digits);
}

export function padR(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

export function padL(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}
