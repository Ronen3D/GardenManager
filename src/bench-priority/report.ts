/**
 * Bench report generator — emits a Markdown summary of one bench cycle.
 *
 * Sections:
 *  1. Run summary (fixtures × variants × seeds, total runtime)
 *  2. Anchor results (invariant + pathology, per variant)
 *  3. Per-fixture metrics (mean composite, p25/p75, unfilled, HC violations,
 *     greedy fill rate, attempts-to-best, runtime)
 *  4. Paired-Δ comparisons vs baseline (when more than one variant present)
 *  5. Acceptance summary — Phase 1 expectations vs observed for baseline
 *
 * Statistical methods: paired-Δ uses the same `(fixture, seed)` across
 * variants. p-values use a simple paired-sign test for now (Wilcoxon
 * adds ~50 LOC of statistics; sign test is sufficient for Phase 1
 * directional checks, will be upgraded for Phase 2/3 if needed).
 */

import type { AnchorSpec, BenchResults, FixtureSpec, SingleRunRecord, VariantSpec } from './types';

interface ReportOptions {
  fixtures: readonly FixtureSpec[];
  variants: readonly VariantSpec[];
  anchors: readonly AnchorSpec[];
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
}

/** Sign test p-value (two-sided) for paired differences (NaN safe). */
function signTestPValue(deltas: number[]): number {
  const nonZero = deltas.filter((d) => d !== 0);
  const n = nonZero.length;
  if (n === 0) return 1;
  const positives = nonZero.filter((d) => d > 0).length;
  // Two-sided binomial test under H0: P(d > 0) = 0.5.
  // Use a normal approximation for n > 20; exact for smaller n.
  if (n <= 20) {
    let pTail = 0;
    const k = Math.min(positives, n - positives);
    for (let i = 0; i <= k; i++) pTail += binomialCoef(n, i) * 0.5 ** n;
    return Math.min(1, 2 * pTail);
  }
  const meanK = n / 2;
  const sdK = Math.sqrt(n / 4);
  const z = Math.abs((positives - meanK) / sdK);
  // Two-sided z-test: 2 * (1 - Phi(z))
  return 2 * (1 - normalCdf(z));
}
function binomialCoef(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
function normalCdf(z: number): number {
  // Approximation by Abramowitz & Stegun 26.2.17.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-(z * z) / 2);
  const p =
    d *
    (0.31938153 * t -
      0.356563782 * t * t +
      1.781477937 * t * t * t -
      1.821255978 * t * t * t * t +
      1.330274429 * t * t * t * t * t);
  return z >= 0 ? 1 - p : p;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface FixtureVariantSummary {
  fixtureId: string;
  variantId: string;
  runCount: number;
  meanComposite: number;
  p25Composite: number;
  p75Composite: number;
  stdDevComposite: number;
  meanUnfilled: number;
  meanGreedyFillRate: number;
  meanAttemptOfBest: number;
  meanRuntimeMs: number;
  totalHcViolations: number;
  feasibleCount: number;
}

function summarize(runs: SingleRunRecord[], fixtureId: string, variantId: string): FixtureVariantSummary {
  const r = runs.filter((x) => x.fixtureId === fixtureId && x.variantId === variantId);
  return {
    fixtureId,
    variantId,
    runCount: r.length,
    meanComposite: mean(r.map((x) => x.compositeScore)),
    p25Composite: quantile(
      r.map((x) => x.compositeScore),
      0.25,
    ),
    p75Composite: quantile(
      r.map((x) => x.compositeScore),
      0.75,
    ),
    stdDevComposite: stdDev(r.map((x) => x.compositeScore)),
    meanUnfilled: mean(r.map((x) => x.unfilledSlotCount)),
    meanGreedyFillRate: mean(r.map((x) => x.greedyFillRate)),
    meanAttemptOfBest: mean(r.map((x) => x.attemptOfBest)),
    meanRuntimeMs: mean(r.map((x) => x.runtimeMs)),
    totalHcViolations: r.reduce((s, x) => s + x.hcViolationCount, 0),
    feasibleCount: r.filter((x) => x.feasible).length,
  };
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderHeader(results: BenchResults): string {
  const ms = results.durationMs;
  const human = ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)}h` : `${(ms / 1000).toFixed(0)}s`;
  return [
    `# Priority bench report`,
    ``,
    `Generated: ${results.finishedAt.toISOString()}`,
    `Duration : ${human}`,
    `Fixtures : ${results.fixtureIds.length} — ${results.fixtureIds.join(', ')}`,
    `Variants : ${results.variantIds.length} — ${results.variantIds.join(', ')}`,
    `Seeds    : ${results.seeds.length} (${results.seeds[0]}..${results.seeds[results.seeds.length - 1]})`,
    `Attempts/run: ${results.attemptsPerRun}`,
    ``,
  ].join('\n');
}

function renderAnchors(results: BenchResults, opts: ReportOptions): string {
  const lines: string[] = ['## Anchor results', ''];
  for (const group of ['invariant', 'pathology'] as const) {
    const anchorsInGroup = opts.anchors.filter((a) => a.group === group);
    if (anchorsInGroup.length === 0) continue;
    lines.push(
      `### ${group === 'invariant' ? 'Invariant anchors (must pass)' : 'Pathology anchors (baseline expected to fail)'}`,
    );
    lines.push('');
    // Header: anchor + one column per variant
    const header = ['Anchor', ...opts.variants.map((v) => v.id)];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const anchor of anchorsInGroup) {
      const row: string[] = [anchor.id];
      for (const v of opts.variants) {
        const rec = results.anchors.find((r) => r.anchorId === anchor.id && r.variantId === v.id);
        if (!rec) {
          row.push('—');
          continue;
        }
        const symbol = rec.observed === 'pass' ? '✓' : '✗';
        const matchTag = rec.matchesExpectation ? '' : ' ⚠';
        row.push(`${symbol} (${rec.observed}, exp ${rec.expected})${matchTag}`);
      }
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
    // Per-anchor detail (only when SOMETHING was off)
    for (const anchor of anchorsInGroup) {
      const recs = results.anchors.filter((r) => r.anchorId === anchor.id);
      const hasDetail = recs.some((r) => r.detail || (r.observations && Object.keys(r.observations).length > 0));
      if (!hasDetail) continue;
      lines.push(`#### ${anchor.id} — detail`);
      lines.push(`> ${anchor.description}`);
      lines.push('');
      for (const rec of recs) {
        const obsStr = rec.observations
          ? Object.entries(rec.observations)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
          : '';
        const detailStr = rec.detail ? ` — ${rec.detail}` : '';
        lines.push(`- ${rec.variantId}: ${rec.observed}${detailStr} (${obsStr})`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderFixtureTables(results: BenchResults, opts: ReportOptions): string {
  const lines: string[] = ['## Per-fixture metrics', ''];
  for (const fixture of opts.fixtures) {
    lines.push(`### ${fixture.id}`);
    lines.push(`> ${fixture.description}`);
    lines.push(`> Phase target: **${fixture.targetingPhase}**`);
    lines.push('');
    const header = [
      'Variant',
      'Runs',
      'Composite (mean)',
      'Composite (p25)',
      'Composite (p75)',
      'StdDev',
      'Unfilled (mean)',
      'GreedyFill (mean)',
      'AttemptOfBest (mean)',
      'Runtime (ms, mean)',
      'HC violations',
      'Feasible',
    ];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const variant of opts.variants) {
      const s = summarize(results.runs, fixture.id, variant.id);
      lines.push(
        `| ${variant.id} | ${s.runCount} | ${s.meanComposite.toFixed(1)} | ${s.p25Composite.toFixed(1)} | ${s.p75Composite.toFixed(1)} | ${s.stdDevComposite.toFixed(1)} | ${s.meanUnfilled.toFixed(2)} | ${(s.meanGreedyFillRate * 100).toFixed(1)}% | ${s.meanAttemptOfBest.toFixed(1)} | ${s.meanRuntimeMs.toFixed(0)} | ${s.totalHcViolations} | ${s.feasibleCount}/${s.runCount} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function renderPairedDeltas(results: BenchResults, opts: ReportOptions): string {
  if (opts.variants.length < 2) {
    return '## Paired-Δ vs baseline\n\n_Only one variant in this run — no paired comparison applicable._\n\n';
  }
  const baseline = opts.variants[0];
  const lines: string[] = ['## Paired-Δ vs baseline', '', `Baseline variant: **${baseline.id}**`, ''];
  const header = ['Fixture', 'Variant', 'ΔComposite (mean)', 'ΔComposite (median)', '% better', 'p (sign test)'];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const fixture of opts.fixtures) {
    for (const variant of opts.variants) {
      if (variant.id === baseline.id) continue;
      const baseRuns = results.runs.filter((r) => r.fixtureId === fixture.id && r.variantId === baseline.id);
      const varRuns = results.runs.filter((r) => r.fixtureId === fixture.id && r.variantId === variant.id);
      const baseBySeed = new Map(baseRuns.map((r) => [r.seed, r]));
      const deltas: number[] = [];
      for (const v of varRuns) {
        const b = baseBySeed.get(v.seed);
        if (!b) continue;
        deltas.push(v.compositeScore - b.compositeScore);
      }
      if (deltas.length === 0) continue;
      const meanD = mean(deltas);
      const medianD = quantile(deltas, 0.5);
      const pctBetter = (deltas.filter((d) => d > 0).length / deltas.length) * 100;
      const p = signTestPValue(deltas);
      lines.push(
        `| ${fixture.id} | ${variant.id} | ${meanD.toFixed(1)} | ${medianD.toFixed(1)} | ${pctBetter.toFixed(0)}% | ${p.toFixed(3)} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderAcceptance(results: BenchResults, opts: ReportOptions): string {
  const lines: string[] = ['## Acceptance summary', ''];
  // Phase 1 acceptance: baseline behaves correctly and pathologies fail as expected.
  const baseline = opts.variants.find((v) => v.id === 'baseline');
  if (!baseline) {
    lines.push('_No `baseline` variant in this run; Phase 1 acceptance check skipped._');
    return lines.join('\n');
  }

  // 1. Default fixture: HC violations and feasibility under baseline.
  const defaultRuns = results.runs.filter((r) => r.fixtureId === 'fixture-default' && r.variantId === baseline.id);
  if (defaultRuns.length > 0) {
    const hc = defaultRuns.reduce((s, r) => s + r.hcViolationCount, 0);
    const feasible = defaultRuns.filter((r) => r.feasible).length;
    lines.push(
      `**fixture-default / baseline**: ${defaultRuns.length} runs, ${feasible} feasible, ${hc} HC violations (independent fullValidate).`,
    );
  }

  // 2. Invariant anchors: all should pass for baseline.
  const baselineAnchors = results.anchors.filter((r) => r.variantId === baseline.id);
  const invariants = baselineAnchors.filter(
    (r) => opts.anchors.find((a) => a.id === r.anchorId)?.group === 'invariant',
  );
  const invPass = invariants.filter((r) => r.observed === 'pass').length;
  lines.push(`**Invariant anchors / baseline**: ${invPass}/${invariants.length} pass.`);
  for (const rec of invariants.filter((r) => r.observed !== 'pass')) {
    lines.push(`  - ✗ ${rec.anchorId}: ${rec.detail ?? '(no detail)'}`);
  }

  // 3. Pathology anchors: all should fail for baseline (in named ways).
  const pathologies = baselineAnchors.filter(
    (r) => opts.anchors.find((a) => a.id === r.anchorId)?.group === 'pathology',
  );
  const pathExpectedFail = pathologies.filter((r) => r.expected === 'fail');
  const pathFailedAsExpected = pathExpectedFail.filter((r) => r.observed === 'fail').length;
  lines.push(`**Pathology anchors / baseline**: ${pathFailedAsExpected}/${pathExpectedFail.length} fail as expected.`);
  const unexpectedlyPassing = pathExpectedFail.filter((r) => r.observed !== 'fail');
  for (const rec of unexpectedlyPassing) {
    lines.push(
      `  - ⚠ ${rec.anchorId}: unexpectedly PASSED for baseline. Bench bug or unintended side effect — investigate.`,
    );
  }

  // 4. Total HC violations across all baseline runs.
  const baselineRuns = results.runs.filter((r) => r.variantId === baseline.id);
  const totalHC = baselineRuns.reduce((s, r) => s + r.hcViolationCount, 0);
  lines.push(`**Total HC violations** across all baseline runs: ${totalHC}. (Phase 1 expects 0.)`);

  lines.push('');
  return lines.join('\n');
}

export function generateReport(results: BenchResults, opts: ReportOptions): string {
  return [
    renderHeader(results),
    renderAcceptance(results, opts),
    renderAnchors(results, opts),
    renderFixtureTables(results, opts),
    renderPairedDeltas(results, opts),
  ].join('\n');
}
