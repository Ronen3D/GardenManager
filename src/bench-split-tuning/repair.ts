/**
 * Repair pass — re-run any time-capped run with a high SA cap so it hits the
 * 100k-iteration cap and becomes CPU-independent (canonical) data.
 *
 * Why this is valid: the optimizer is deterministic given (seed, code,
 * scenario) once the SA hits the iteration cap — the time-cap value is then
 * irrelevant. A run with `iterations < 99000` hit the *time* cap (its SA was
 * cut short, usually by CPU contention). Re-running it with a 10000ms cap
 * lets all 60 attempts reach the 100k-iteration cap, producing exactly the
 * result a clean run would have produced.
 *
 * Resumable: rewrites the NDJSON after every repaired run, so an interrupted
 * repair just leaves the not-yet-repaired runs flagged for the next pass.
 *
 * Usage:
 *   npx ts-node src/bench-split-tuning/repair.ts            # all tiers
 *   npx ts-node src/bench-split-tuning/repair.ts tier3      # one tier
 */

import * as fs from 'fs';
import * as path from 'path';

import { SCENARIOS } from './scenarios';
import { runOnce, type RunParams, type RunResult } from './runner';
import { buildScenario } from './scenarios';

const REPAIR_SA_CAP_MS = 10000; // generous — guarantees the iteration cap binds
const ITER_CLEAN_THRESHOLD = 99000;

function tierFile(tier: string): string {
  return path.resolve(process.cwd(), 'tmp', `split-bench-${tier}.ndjson`);
}

function loadRows(file: string): RunResult[] {
  const txt = fs.readFileSync(file, 'utf8');
  const rows: RunResult[] = [];
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as RunResult);
    } catch {
      // skip truncated line
    }
  }
  return rows;
}

function writeRows(file: string, rows: RunResult[]): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

/** Rebuild the scenario + params for one RunResult so it can be re-run. */
function rebuild(r: RunResult): { scenario: ReturnType<typeof buildScenario>; params: RunParams } | null {
  const bundle = SCENARIOS.find((b) => b.on.id === r.scenarioId);
  if (!bundle) {
    console.error(`  ! scenario ${r.scenarioId} not found in catalog — skipping`);
    return null;
  }
  const spec = r.splittingOn ? bundle.on : bundle.off;
  const scenario = buildScenario(spec);
  const params: RunParams = {
    splitPenalty: r.splitPenalty,
    splittingOn: r.splittingOn,
    maxStructuralPasses: r.maxStructuralPasses,
    seed: r.seed,
    attempts: r.attempts,
    maxSolverTimeMs: REPAIR_SA_CAP_MS, // the only change vs the original run
  };
  return { scenario, params };
}

function repairTier(tier: string): { repaired: number; stillBad: number } {
  const file = tierFile(tier);
  if (!fs.existsSync(file)) {
    console.log(`  ${tier}: file not found, skipping`);
    return { repaired: 0, stillBad: 0 };
  }
  const rows = loadRows(file);
  const badIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].iterations < ITER_CLEAN_THRESHOLD) badIdx.push(i);
  }
  if (badIdx.length === 0) {
    console.log(`  ${tier}: ${rows.length} runs, 0 time-capped — nothing to repair`);
    return { repaired: 0, stillBad: 0 };
  }
  console.log(`  ${tier}: ${rows.length} runs, ${badIdx.length} time-capped — repairing...`);

  let repaired = 0;
  let stillBad = 0;
  for (const idx of badIdx) {
    const orig = rows[idx];
    const rebuilt = rebuild(orig);
    if (!rebuilt) {
      stillBad++;
      continue;
    }
    const t0 = Date.now();
    const fresh: RunResult = runOnce(rebuilt.scenario, rebuilt.params);
    // Restore the original maxSolverTimeMs label so the row matches its tier's
    // config (the high cap was a repair detail, not a real config change —
    // and since the iteration cap bound, the result is cap-independent).
    fresh.maxSolverTimeMs = orig.maxSolverTimeMs;
    const dt = ((Date.now() - t0) / 1000).toFixed(0);
    if (fresh.iterations < ITER_CLEAN_THRESHOLD) {
      // Still short even at 10s/attempt — genuinely heavy. Keep the better of
      // the two (more iterations) and flag it.
      console.log(
        `    ! ${orig.scenarioId} sp=${orig.splitPenalty} seed=${orig.seed} struct=${orig.maxStructuralPasses}` +
          ` still time-capped (${fresh.iterations} iters, ${dt}s) — keeping best`,
      );
      rows[idx] = fresh.iterations > orig.iterations ? fresh : orig;
      stillBad++;
    } else {
      rows[idx] = fresh;
      repaired++;
      process.stdout.write(
        `\r    repaired ${repaired}/${badIdx.length} (last: ${orig.scenarioId} sp=${orig.splitPenalty}` +
          ` seed=${orig.seed} struct=${orig.maxStructuralPasses}, ${fresh.iterations} iters, ${dt}s)        `,
      );
    }
    // Rewrite after every run so the repair is resumable.
    writeRows(file, rows);
  }
  console.log('');
  return { repaired, stillBad };
}

function main(): void {
  const arg = process.argv[2];
  const tiers = arg ? [arg] : ['tier1', 'tier1b', 'tier1c', 'tier2', 'tier3'];
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Repair pass — re-running time-capped runs at ${REPAIR_SA_CAP_MS}ms SA cap`);
  console.log('═══════════════════════════════════════════════════════════════');
  const t0 = Date.now();
  let totalRepaired = 0;
  let totalStillBad = 0;
  for (const tier of tiers) {
    const { repaired, stillBad } = repairTier(tier);
    totalRepaired += repaired;
    totalStillBad += stillBad;
  }
  console.log('───────────────────────────────────────────────────────────────');
  console.log(
    `Done in ${(((Date.now() - t0) / 60000) | 0)}m — ${totalRepaired} repaired, ${totalStillBad} still time-capped.`,
  );
}

main();
