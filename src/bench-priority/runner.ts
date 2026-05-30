/**
 * Priority-ordering bench runner.
 *
 * Iterates (fixture × seed × variant), running `optimizeMultiAttempt`
 * wrapped in `withSeededRandom(seed, ...)`, and collects metrics into a
 * structured `BenchResults` object. Anchors are evaluated per-variant
 * (not per-seed) since they observe pure formula behavior.
 *
 * Usage (from project root):
 *   npx ts-node --project tsconfig.bench-priority.json src/bench-priority/runner.ts
 *
 * Tunable env vars:
 *   BENCH_SEED_COUNT       Number of seeds per fixture (default 60).
 *   BENCH_ATTEMPTS         Multi-attempt count per run (default 30).
 *   BENCH_BASE_SEED        Starting seed (default 1000). Seeds = [base, base+1, ...].
 *   BENCH_FIXTURES         Comma-separated fixture ids to include (default ALL).
 *   BENCH_VARIANTS         Comma-separated variant ids to include (default ALL).
 *   BENCH_PROGRESS         "true" to log per-run progress (default "false").
 *   BENCH_OUTPUT           Path to write JSON results (default tmp/priority-bench-results.json).
 */

// ─── localStorage shim — runs before any web/config-store import ────────────
{
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
    get length() {
      return Object.keys(mem).length;
    },
    key: (i: number) => Object.keys(mem)[i] ?? null,
  } as Storage;
}

import * as fs from 'fs';
import * as path from 'path';

import { withSeededRandom } from '../bench-split-tuning/seeded-rng';
import { optimizeMultiAttempt, type OptimizationResult } from '../engine/optimizer';
import { fullValidate } from '../engine/validator';
import type { AlgorithmSettings, Task } from '../models/types';
import { ALL_ANCHORS } from './anchors';
import { ALL_FIXTURES } from './fixtures';
import { generateReport } from './report';
import type { AnchorRecord, BenchResults, FixtureSpec, SingleRunRecord, VariantSpec } from './types';
import { ALL_VARIANTS } from './variants';

// ─── Tunables ────────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : def;
}
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v.toLowerCase() === 'true' || v === '1';
}
function envCsv(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
function envStr(name: string, def: string): string {
  return process.env[name] ?? def;
}

const SEED_COUNT = envInt('BENCH_SEED_COUNT', 60);
const ATTEMPTS = envInt('BENCH_ATTEMPTS', 30);
const BASE_SEED = envInt('BENCH_BASE_SEED', 1000);
const PROGRESS = envBool('BENCH_PROGRESS', false);
const OUTPUT_JSON = envStr('BENCH_OUTPUT', 'tmp/priority-bench-results.json');
const OUTPUT_REPORT = envStr('BENCH_REPORT', 'tmp/priority-bench-report.md');

const fixtureFilter = envCsv('BENCH_FIXTURES');
const variantFilter = envCsv('BENCH_VARIANTS');

const SELECTED_FIXTURES: FixtureSpec[] = ALL_FIXTURES.filter((f) => !fixtureFilter || fixtureFilter.includes(f.id));
const SELECTED_VARIANTS: VariantSpec[] = ALL_VARIANTS.filter((v) => !variantFilter || variantFilter.includes(v.id));

if (SELECTED_FIXTURES.length === 0) {
  console.error('No fixtures selected. Check BENCH_FIXTURES.');
  process.exit(1);
}
if (SELECTED_VARIANTS.length === 0) {
  console.error('No variants selected. Check BENCH_VARIANTS.');
  process.exit(1);
}

// ─── Per-run executor ────────────────────────────────────────────────────────

function totalSlots(tasks: Task[]): number {
  let s = 0;
  for (const t of tasks) s += t.slots.length;
  return s;
}

function runOnce(fixture: FixtureSpec, variant: VariantSpec, seed: number): SingleRunRecord {
  const instance = fixture.generate(seed);
  // Variant install — Phase 1 baseline is a no-op; Phase 2/3 variants
  // install priority overrides via this hook.
  const dummySettings: AlgorithmSettings = {
    config: instance.config,
    disabledHardConstraints: [],
    dayStartHour: instance.dayStartHour,
  } as AlgorithmSettings;
  const cleanup = variant.install(dummySettings);

  const t0 = Date.now();
  let result: OptimizationResult;
  try {
    result = withSeededRandom(seed, () =>
      optimizeMultiAttempt(
        instance.tasks,
        instance.participants,
        instance.config,
        [],
        ATTEMPTS,
        undefined,
        undefined,
        undefined,
        instance.restRuleMap,
        undefined,
        undefined,
        instance.dayStartHour,
      ),
    );
  } finally {
    cleanup();
  }
  const runtimeMs = Date.now() - t0;

  // Independent HC validation.
  const realizedTasks = result.tasks ?? instance.tasks;
  const validation = fullValidate(
    realizedTasks,
    instance.participants,
    result.assignments,
    undefined,
    instance.restRuleMap,
    undefined,
    undefined,
  );
  const NON_PLACEMENT_CODES = new Set<string>(['SLOT_UNFILLED', 'GROUP_INSUFFICIENT']);
  const hcViolationCount = validation.violations.filter((v) => !NON_PLACEMENT_CODES.has(v.code)).length;

  const slots = totalSlots(instance.tasks);
  const greedyFillRate = slots > 0 ? (slots - result.greedyUnfilledSlots.length) / slots : 1;

  return {
    fixtureId: fixture.id,
    variantId: variant.id,
    seed,
    feasible: result.feasible,
    compositeScore: result.score.compositeScore,
    unfilledSlotCount: result.unfilledSlots.length,
    hcViolationCount,
    greedyUnfilledCount: result.greedyUnfilledSlots.length,
    greedyFillRate,
    preSACompositeScore: result.phaseScores.postGreedy,
    postSACompositeScore: result.phaseScores.postSA,
    finalCompositeScore: result.phaseScores.final,
    attemptOfBest: result.attemptOfBest ?? 0,
    actualAttempts: result.actualAttempts,
    runtimeMs,
    greedyMs: result.phaseDurations.greedyMs,
    saMs: result.phaseDurations.saMs,
    polishMs: result.phaseDurations.polishMs,
  };
}

// ─── Anchor evaluator ────────────────────────────────────────────────────────

function evaluateAnchors(variant: VariantSpec): AnchorRecord[] {
  const records: AnchorRecord[] = [];
  const dummySettings: AlgorithmSettings = {
    config: { ...require('../models/types').DEFAULT_CONFIG },
    disabledHardConstraints: [],
    dayStartHour: 5,
  } as AlgorithmSettings;
  const cleanup = variant.install(dummySettings);
  try {
    for (const anchor of ALL_ANCHORS) {
      const expected = anchor.expectedOutcome[variant.id] ?? (anchor.group === 'invariant' ? 'pass' : 'fail');
      let result;
      try {
        result = anchor.evaluate();
      } catch (err) {
        result = {
          outcome: 'fail' as const,
          detail: `Anchor threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      records.push({
        anchorId: anchor.id,
        variantId: variant.id,
        observed: result.outcome,
        expected,
        matchesExpectation: result.outcome === expected,
        detail: result.detail,
        observations: result.observations,
      });
    }
  } finally {
    cleanup();
  }
  return records;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const seeds = Array.from({ length: SEED_COUNT }, (_, i) => BASE_SEED + i);
  const totalRuns = SELECTED_FIXTURES.length * SELECTED_VARIANTS.length * SEED_COUNT;

  console.log('─'.repeat(70));
  console.log(`Priority bench`);
  console.log(`  fixtures : ${SELECTED_FIXTURES.length} (${SELECTED_FIXTURES.map((f) => f.id).join(', ')})`);
  console.log(`  variants : ${SELECTED_VARIANTS.length} (${SELECTED_VARIANTS.map((v) => v.id).join(', ')})`);
  console.log(`  seeds    : ${SEED_COUNT} starting at ${BASE_SEED}`);
  console.log(`  attempts : ${ATTEMPTS} per multi-attempt run`);
  console.log(`  total    : ${totalRuns} runs + ${SELECTED_VARIANTS.length * ALL_ANCHORS.length} anchor evals`);
  console.log('─'.repeat(70));

  const startedAt = new Date();
  const t0 = Date.now();
  const runs: SingleRunRecord[] = [];
  const anchors: AnchorRecord[] = [];

  // Anchors first — they're per-variant, fast, and surface design bugs early.
  for (const variant of SELECTED_VARIANTS) {
    const records = evaluateAnchors(variant);
    anchors.push(...records);
    const passing = records.filter((r) => r.matchesExpectation).length;
    console.log(`[anchors] ${variant.id}: ${passing}/${records.length} match expectation`);
  }

  // Then the seed-driven sweep.
  let runIdx = 0;
  for (const fixture of SELECTED_FIXTURES) {
    for (const variant of SELECTED_VARIANTS) {
      const fixT0 = Date.now();
      for (const seed of seeds) {
        runIdx += 1;
        if (PROGRESS && runIdx % 10 === 0) {
          const elapsed = (Date.now() - t0) / 1000;
          const rate = runIdx / Math.max(1, elapsed);
          const eta = (totalRuns - runIdx) / Math.max(0.1, rate);
          console.log(`  run ${runIdx}/${totalRuns} — ${elapsed.toFixed(0)}s elapsed, ~${eta.toFixed(0)}s ETA`);
        }
        runs.push(runOnce(fixture, variant, seed));
      }
      const fixDur = ((Date.now() - fixT0) / 1000).toFixed(1);
      const fixRuns = runs.filter((r) => r.fixtureId === fixture.id && r.variantId === variant.id);
      const meanComposite = mean(fixRuns.map((r) => r.compositeScore));
      const meanUnfilled = mean(fixRuns.map((r) => r.unfilledSlotCount));
      const hcTotal = fixRuns.reduce((s, r) => s + r.hcViolationCount, 0);
      console.log(
        `[${fixture.id}/${variant.id}] ${fixRuns.length} runs in ${fixDur}s — ` +
          `composite ${meanComposite.toFixed(0)}, unfilled ${meanUnfilled.toFixed(1)}, HC violations ${hcTotal}`,
      );
    }
  }

  const finishedAt = new Date();
  const durationMs = Date.now() - t0;

  const results: BenchResults = {
    runs,
    anchors,
    startedAt,
    finishedAt,
    durationMs,
    fixtureIds: SELECTED_FIXTURES.map((f) => f.id),
    variantIds: SELECTED_VARIANTS.map((v) => v.id),
    seeds,
    attemptsPerRun: ATTEMPTS,
  };

  // Ensure tmp/ exists and write outputs.
  const outDir = path.dirname(OUTPUT_JSON);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`Wrote raw JSON → ${OUTPUT_JSON}`);

  const reportText = generateReport(results, { fixtures: SELECTED_FIXTURES, variants: SELECTED_VARIANTS, anchors: ALL_ANCHORS });
  const reportDir = path.dirname(OUTPUT_REPORT);
  if (reportDir && !fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(OUTPUT_REPORT, reportText, 'utf-8');
  console.log(`Wrote report → ${OUTPUT_REPORT}`);

  console.log('─'.repeat(70));
  console.log(`Total: ${runs.length} runs in ${(durationMs / 1000).toFixed(1)}s.`);
  console.log('─'.repeat(70));
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

main();
