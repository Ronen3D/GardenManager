/**
 * Shift-splitting parameter tuning benchmark — main matrix runner.
 *
 * Goals (per the brief that triggered this study):
 *   1. Decide whether the current `splitPenalty=1000` and
 *      `MAX_STRUCTURAL_PASSES=2` are good values or just reasonable guesses.
 *   2. Quantify the *real* impact of shift-splitting on schedule quality,
 *      separated from SA noise.
 *   3. Keep hard-constraint correctness non-negotiable — any run that
 *      improves composite by violating HCs is a failure, not a win.
 *
 * Design choices:
 *   - Math.random is seeded per-run (Mulberry32) so OFF / ON / each splitPenalty
 *     run on the SAME seed gets the SAME participant shuffle and SAME SA
 *     starting decisions. The data is paired, so we can quote a real
 *     `Δcomposite vs OFF` per seed instead of comparing two distributions.
 *   - Results stream to an NDJSON file so we can analyse a partial matrix
 *     if interrupted, and so each cell is self-contained.
 *   - HC correctness is verified by an INDEPENDENT `fullValidate` pass on
 *     the realized task set — never trust `result.feasible` alone.
 *
 * Tiers (selectable via TIER env var):
 *   tier=1  Broad sweep over 12 scenarios × {OFF, splitPenalty ∈ 5 values}
 *           × N=12 seeds × 15 attempts × 1500ms cap. Cost ~ 2 hours.
 *   tier=2  Deep dive on the 6 most-relevant scenarios × 8 splitPenalty
 *           values × N=24 seeds × 20 attempts × 2000ms cap. ~ 5 hours.
 *   tier=3  MAX_STRUCTURAL_PASSES sweep on 4 scenarios × {1,2,3,5}
 *           × N=20 seeds × 20 attempts × 2000ms cap. ~ 2 hours.
 *   tier=recon  Tiny smoke test: 3 scenarios × 3 params × 3 seeds × 5 attempts × 800ms. Minutes.
 *
 * Env overrides:
 *   BENCH_OUT          output NDJSON path (default tmp/split-bench-<tier>.ndjson)
 *   BENCH_SEEDS        seed count override (e.g. 30)
 *   BENCH_ATTEMPTS     attempts override
 *   BENCH_TIME_MS      per-attempt SA cap override
 *   BENCH_SCENARIOS    csv of scenario ids to restrict to (debugging)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SCENARIOS,
  TIER1_IDS,
  TIER1B_IDS,
  TIER2_IDS,
  TIER3_IDS,
  buildScenario,
  type ScenarioBundle,
} from './scenarios';
import { runOnce, type RunParams, type RunResult } from './runner';
import { fmt } from './stats';

// ─── Tier configuration ──────────────────────────────────────────────────────

type Tier = 'recon' | '1' | '1b' | '1c' | '2' | '3';

interface TierConfig {
  scenarioIds: Set<string>;
  splitPenalties: number[];
  structuralPasses: number[]; // applied only for tier=3; otherwise [2]
  seeds: number[];
  attempts: number;
  maxSolverTimeMs: number;
  /** Sweep structuralPasses too? (tier 3 only) */
  sweepStructural: boolean;
  /** Skip the OFF control cell — used by supplements that pair against an
   *  earlier tier's OFF cells via the merged NDJSON stream. */
  skipOff?: boolean;
}

function tierConfig(tier: Tier): TierConfig {
  const seeds = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  if (tier === 'recon') {
    return {
      scenarioIds: new Set(['7d-54p-default-med', '7d-54p-tight-med', '7d-54p-extra-med']),
      splitPenalties: [500, 1000, 2000],
      structuralPasses: [2],
      seeds: seeds(3),
      attempts: 5,
      maxSolverTimeMs: 800,
      sweepStructural: false,
    };
  }
  // PRODUCTION-FIDELITY: 60 attempts per `optimizeMultiAttempt` call (matches
  // `FALLBACK_DEFAULT_ATTEMPTS` in `src/web/ui-helpers.ts` and what the web app
  // actually runs). Seed counts and scenario sets are sized so the total
  // bench fits in 2-3 days end-to-end without compromising attempt fidelity.
  const PROD_ATTEMPTS = 60;
  const SA_CAP_MS = 1000;
  if (tier === '1') {
    return {
      scenarioIds: TIER1_IDS,
      splitPenalties: [0, 10, 50, 200, 500, 1000, 2000, 5000],
      structuralPasses: [2],
      seeds: seeds(6),
      attempts: PROD_ATTEMPTS,
      maxSolverTimeMs: SA_CAP_MS,
      sweepStructural: false,
    };
  }
  if (tier === '1b') {
    return {
      scenarioIds: TIER1B_IDS,
      splitPenalties: [0, 10, 50, 200, 500, 1000, 2000, 5000],
      structuralPasses: [2],
      seeds: seeds(6),
      attempts: PROD_ATTEMPTS,
      maxSolverTimeMs: SA_CAP_MS,
      sweepStructural: false,
    };
  }
  if (tier === '1c') {
    return {
      scenarioIds: TIER1_IDS,
      splitPenalties: [1, 2, 3, 5],
      structuralPasses: [2],
      seeds: seeds(6),
      attempts: PROD_ATTEMPTS,
      maxSolverTimeMs: SA_CAP_MS,
      sweepStructural: false,
      skipOff: true,
    };
  }
  if (tier === '2') {
    return {
      scenarioIds: TIER2_IDS,
      splitPenalties: [0, 1, 2, 3, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000],
      structuralPasses: [2],
      seeds: seeds(8),
      attempts: PROD_ATTEMPTS,
      maxSolverTimeMs: SA_CAP_MS,
      sweepStructural: false,
    };
  }
  // tier 3
  return {
    scenarioIds: TIER3_IDS,
    splitPenalties: [1000],
    structuralPasses: [1, 2, 3, 5],
    seeds: seeds(8),
    attempts: PROD_ATTEMPTS,
    maxSolverTimeMs: SA_CAP_MS,
    sweepStructural: true,
  };
}

// ─── Time / progress helpers ─────────────────────────────────────────────────

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const tier = (process.env.TIER ?? 'recon') as Tier;
  if (!['recon', '1', '1b', '1c', '2', '3'].includes(tier)) {
    console.error(`Unknown TIER=${tier} — expected one of recon/1/1b/1c/2/3`);
    process.exit(1);
  }
  const cfg = tierConfig(tier);

  // Env overrides
  const seedOverride = parseInt(process.env.BENCH_SEEDS ?? '0', 10);
  if (seedOverride > 0) cfg.seeds = Array.from({ length: seedOverride }, (_, i) => i + 1);
  const attOverride = parseInt(process.env.BENCH_ATTEMPTS ?? '0', 10);
  if (attOverride > 0) cfg.attempts = attOverride;
  const timeOverride = parseInt(process.env.BENCH_TIME_MS ?? '0', 10);
  if (timeOverride > 0) cfg.maxSolverTimeMs = timeOverride;
  if (process.env.BENCH_SCENARIOS) {
    const ids = process.env.BENCH_SCENARIOS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    cfg.scenarioIds = new Set(ids);
  }

  const outDir = path.resolve(process.cwd(), 'tmp');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = process.env.BENCH_OUT ?? path.join(outDir, `split-bench-tier${tier}.ndjson`);

  // Resume support: if the file exists, parse it and build a "done" set so
  // we skip any cell that already has a run with the same identity tuple.
  // This makes the bench crash-safe — if the machine closes mid-run, just
  // re-launch and it picks up where it left off.
  const doneKeys = new Set<string>();
  if (fs.existsSync(outPath)) {
    const txt = fs.readFileSync(outPath, 'utf8');
    let n = 0;
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t) as RunResult;
        doneKeys.add(
          `${r.scenarioId}|${r.maxStructuralPasses}|${r.splittingOn ? 'ON' : 'OFF'}|${r.splitPenalty}|${r.seed}`,
        );
        n++;
      } catch {
        // Tolerate truncated last line from a crash.
      }
    }
    if (n > 0) console.log(`  Resuming: ${n} prior runs found in ${outPath}, will skip them.\n`);
  }

  // Open in append mode so resume doesn't truncate.
  const fp = fs.openSync(outPath, 'a');

  const scenarios: ScenarioBundle[] = SCENARIOS.filter((b) => cfg.scenarioIds.has(b.on.id));

  if (scenarios.length === 0) {
    console.error(`No scenarios matched. Wanted: ${[...cfg.scenarioIds].join(', ')}`);
    process.exit(1);
  }

  // Total cell count: each scenario has 1 OFF + |splitPenalties| ON cells,
  // each multiplied by structuralPasses (tier 3 sweeps it; others = [2]).
  const cellsPerScenario = ((cfg.skipOff ? 0 : 1) + cfg.splitPenalties.length) * cfg.structuralPasses.length;
  const totalRuns = scenarios.length * cellsPerScenario * cfg.seeds.length;

  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Shift-splitting tuning benchmark — TIER ${tier}`);
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`  Scenarios:        ${scenarios.length} (${scenarios.map((s) => s.on.id).join(', ')})`);
  console.log(`  splitPenalty grid: ${cfg.splitPenalties.join(', ')}`);
  console.log(`  structuralPasses:  ${cfg.structuralPasses.join(', ')}`);
  console.log(`  Seeds per cell:    ${cfg.seeds.length}`);
  console.log(`  Attempts per run:  ${cfg.attempts}`);
  console.log(`  SA cap per attempt: ${cfg.maxSolverTimeMs}ms`);
  console.log(`  Total runs:        ${totalRuns}`);
  console.log(`  Output (NDJSON):   ${outPath}`);
  console.log('───────────────────────────────────────────────────────────────────────────');

  const t0 = Date.now();
  let done = 0;
  let lastReport = t0;

  for (const bundle of scenarios) {
    console.log(`\n▶ ${bundle.label}`);

    for (const sp of cfg.structuralPasses) {
      // OFF (control): splittableSet='none' on the OFF spec, splitPenalty held at 1000
      // (it's a no-op when nothing is splittable but keeps the config field identical).
      const keyFor = (so: boolean, splitPen: number, seed: number): string =>
        `${bundle.on.id}|${sp}|${so ? 'ON' : 'OFF'}|${splitPen}|${seed}`;

      let fsyncBacklog = 0;
      const FSYNC_EVERY = 10; // flush to disk every 10 runs (~10 min worst case)
      const writeAndCheckpoint = (r: RunResult): void => {
        fs.writeSync(fp, JSON.stringify(r) + '\n');
        fsyncBacklog++;
        if (fsyncBacklog >= FSYNC_EVERY) {
          fs.fsyncSync(fp);
          fsyncBacklog = 0;
        }
      };
      const progress = (justSkipped: boolean = false): void => {
        const now = Date.now();
        if (now - lastReport > 5000 || done === totalRuns || justSkipped) {
          const elapsed = now - t0;
          const remaining = totalRuns - done;
          const ratePerRun = done > 0 ? elapsed / done : 0;
          const eta = (ratePerRun * remaining) | 0;
          const rate = ratePerRun > 0 ? `${fmt(60000 / ratePerRun, 1)} runs/min` : '—';
          process.stdout.write(
            `\r  [${done}/${totalRuns}] elapsed ${fmtDur(elapsed)} · ETA ${fmtDur(eta)} · ${rate}    `,
          );
          lastReport = now;
        }
      };

      if (!cfg.skipOff) {
        const offScenario = buildScenario(bundle.off);
        const offParams: Omit<RunParams, 'seed'> = {
          splitPenalty: 1000,
          splittingOn: false,
          maxStructuralPasses: sp,
          attempts: cfg.attempts,
          maxSolverTimeMs: cfg.maxSolverTimeMs,
        };
        for (const seed of cfg.seeds) {
          if (doneKeys.has(keyFor(false, 1000, seed))) {
            done++;
            progress(true);
            continue;
          }
          const r: RunResult = runOnce(offScenario, { ...offParams, seed });
          writeAndCheckpoint(r);
          done++;
          progress();
        }
      }

      // ON cells: splittableSet from bundle.on, sweep splitPenalty
      const onScenario = buildScenario(bundle.on);
      for (const splitPen of cfg.splitPenalties) {
        const onParams: Omit<RunParams, 'seed'> = {
          splitPenalty: splitPen,
          splittingOn: true,
          maxStructuralPasses: sp,
          attempts: cfg.attempts,
          maxSolverTimeMs: cfg.maxSolverTimeMs,
        };
        for (const seed of cfg.seeds) {
          if (doneKeys.has(keyFor(true, splitPen, seed))) {
            done++;
            progress(true);
            continue;
          }
          const r: RunResult = runOnce(onScenario, { ...onParams, seed });
          writeAndCheckpoint(r);
          done++;
          progress();
        }
      }
      // Force-flush at the end of every scenario × structuralPasses combo.
      fs.fsyncSync(fp);
    }
  }

  fs.closeSync(fp);

  console.log(`\n\n✓ Done. ${totalRuns} runs in ${fmtDur(Date.now() - t0)}.`);
  console.log(`  Results: ${outPath}`);
  console.log(`  Next:    npx ts-node src/bench-split-tuning/analyze.ts ${outPath}`);
}

main();
