/**
 * Generate the final Markdown report from one or more NDJSON outputs.
 *
 * Combines tier 1 (broad sweep), tier 2 (deep splitPenalty), and tier 3
 * (MAX_STRUCTURAL_PASSES) into a single document with:
 *   - Executive summary (best splitPenalty across scenarios)
 *   - Correctness audit
 *   - Per-scenario tables (composite, split count, paired Δ)
 *   - Trade-off panel (soft-metric breakdown)
 *   - Structural-passes recommendation
 *
 * Usage:
 *   npx ts-node src/bench-split-tuning/report.ts <ndjson1> [ndjson2] [...] > tmp/split-bench-report.md
 */

import * as fs from 'fs';

import { ci95HalfWidth, fmt, pairedTStat, summarize } from './stats';
import type { RunResult } from './runner';

function loadRuns(files: string[]): RunResult[] {
  const all: RunResult[] = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      all.push(JSON.parse(t) as RunResult);
    }
  }
  return all;
}

interface Cell {
  scenarioId: string;
  structuralPasses: number;
  splittingOn: boolean;
  splitPenalty: number;
  runs: RunResult[];
}

function buildCells(rows: RunResult[]): Cell[] {
  const m = new Map<string, Cell>();
  for (const r of rows) {
    const k = `${r.scenarioId}|${r.maxStructuralPasses}|${r.splittingOn ? 'ON' : 'OFF'}|${r.splitPenalty}`;
    let c = m.get(k);
    if (!c) {
      c = {
        scenarioId: r.scenarioId,
        structuralPasses: r.maxStructuralPasses,
        splittingOn: r.splittingOn,
        splitPenalty: r.splitPenalty,
        runs: [],
      };
      m.set(k, c);
    }
    c.runs.push(r);
  }
  const cells = [...m.values()];
  for (const c of cells) c.runs.sort((a, b) => a.seed - b.seed);
  return cells;
}

function pairBySeed<T>(off: RunResult[], on: RunResult[], pick: (r: RunResult) => T): { aArr: T[]; bArr: T[] } {
  const byO = new Map<number, RunResult>();
  for (const r of off) byO.set(r.seed, r);
  const aArr: T[] = [];
  const bArr: T[] = [];
  for (const r of on) {
    const m = byO.get(r.seed);
    if (!m) continue;
    aArr.push(pick(m));
    bArr.push(pick(r));
  }
  return { aArr, bArr };
}

function pairedDeltaComposite(off: Cell, on: Cell): { mean: number; t: number; ci: number; n: number } {
  const { aArr, bArr } = pairBySeed(off.runs, on.runs, (r) => r.compositeScore);
  if (aArr.length < 2) return { mean: NaN, t: NaN, ci: NaN, n: 0 };
  const t = pairedTStat(aArr, bArr);
  const ci = ci95HalfWidth(t.sdDelta, t.n);
  return { mean: t.meanDelta, t: t.tStat, ci, n: t.n };
}

// ─── Sections ────────────────────────────────────────────────────────────────

function execSummary(cells: Cell[]): string {
  const scenarios = new Set<string>();
  for (const c of cells) if (c.structuralPasses === 2) scenarios.add(c.scenarioId);

  const wins = new Map<number, number>();
  const meanDeltas = new Map<number, number[]>();
  const splitRates = new Map<number, number[]>();
  for (const s of scenarios) {
    const offCell = cells.find((c) => c.scenarioId === s && !c.splittingOn && c.structuralPasses === 2);
    if (!offCell) continue;
    let best: { sp: number; m: number } | null = null;
    const onCells = cells
      .filter((c) => c.scenarioId === s && c.splittingOn && c.structuralPasses === 2)
      .sort((a, b) => a.splitPenalty - b.splitPenalty);
    for (const c of onCells) {
      if (!c.runs.every((r) => r.hcViolations === 0)) continue;
      const d = pairedDeltaComposite(offCell, c);
      const md = meanDeltas.get(c.splitPenalty) ?? [];
      md.push(d.mean);
      meanDeltas.set(c.splitPenalty, md);
      const sr = c.runs.reduce((acc, r) => acc + r.splitSlotCount, 0) / c.runs.length;
      const ssa = splitRates.get(c.splitPenalty) ?? [];
      ssa.push(sr);
      splitRates.set(c.splitPenalty, ssa);
      if (!best || d.mean > best.m) best = { sp: c.splitPenalty, m: d.mean };
    }
    if (best) wins.set(best.sp, (wins.get(best.sp) ?? 0) + 1);
  }

  let md = '# Shift-splitting parameter tuning — benchmark report\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;

  md += '## Methodology\n\n';
  md +=
    '**What was tuned.** Two parameters govern Phase-2 shift-splitting behaviour ' +
    'inside `src/engine/optimizer.ts`:\n\n';
  md +=
    '1. `config.splitPenalty` (`SchedulerConfig.splitPenalty`, default **1000**) — the ' +
    'economic gate inside the composite score. `structuralRefine` commits a quality split ' +
    'only when composite improvement strictly exceeds it; it merges a split back when the ' +
    'wholing buys back more than it. Also enters the SA scorer (`IncrementalScorer._splitPenalty`) ' +
    'as a run-constant.\n';
  md +=
    '2. `MAX_STRUCTURAL_PASSES` (compile-time constant, default **2**) — anti-oscillation ' +
    'bound on number of merge+split passes per `optimize()` invocation. For the benchmark this ' +
    'was made overridable via the bench-only `_benchSetMaxStructuralPasses` setter; product ' +
    'default is untouched.\n\n';
  md +=
    '*Deliberately untuned:* `STRUCT_EPS` (1e-6, FP numerical guard — too low risks ' +
    'oscillation, too high suppresses real wins, neither regime is product-relevant); ' +
    '`UNFILLED_SLOT_PENALTY` (50000, controls greedy/SA broadly, not just splitting); ' +
    '`MAX_POLISH_PASSES` (post-SA polish, orthogonal to splitting).\n\n';

  md +=
    '**How the data is collected.** Each (scenario, splitPenalty, seed) cell runs ' +
    '`optimizeMultiAttempt` with `Math.random` patched by a deterministic Mulberry32 RNG keyed ' +
    'by the seed. This makes the OFF and every ON cell on the same scenario+seed *paired* — ' +
    'they share the same participant shuffle, task-order jitter, and initial SA decisions, so ' +
    'the difference comes from splitting itself, not SA noise. The runner records the engine ' +
    'composite + soft-component breakdown + split count + runtime, then runs an INDEPENDENT ' +
    '`fullValidate` pass to verify zero placement violations.\n\n';
  md += 'Tiers:\n\n';
  md +=
    '- **Tier 1** — broad sweep across ~14 scenarios × 8 splitPenalty values × 8 seeds × ' +
    '12 attempts × 1200ms SA cap. Catches where splitting matters.\n';
  md +=
    '- **Tier 2** — dense splitPenalty grid (12 values [0..20000]) on the splitting-' +
    'relevant subset × 24 seeds × 20 attempts × 2000ms cap. Refines parameter choice.\n';
  md +=
    '- **Tier 3** — MAX_STRUCTURAL_PASSES ∈ {1, 2, 3, 5} on splitting-relevant scenarios × ' +
    '20 seeds × 20 attempts × 2000ms cap. Tests whether 2 passes is enough.\n\n';
  md +=
    '**Scenarios** are built by `buildScenario` in `src/bench-split-tuning/scenarios.ts` ' +
    'and vary: schedule length (1..7 days), pool size (18..84 participants), task recipe ' +
    '(`default` from `cli-task-factory`, plus variants: `lite`, `heavy`, `extra-shemesh-slots`, ' +
    '`quality-opportunity`, `tight-feasibility`, `split-focused`), splittable selectivity ' +
    '(`none` / `all-non-sameGroup` / `shemesh-only` / `half-non-sameGroup` / `all-incl-sameGroup`), ' +
    'and availability pressure (`none` / `low` / `medium` / `high` / `very-high`). The OFF cell ' +
    'on every scenario uses `splittableSet: "none"` so it represents *exactly* today\'s ' +
    'splitting-disabled behaviour.\n\n';
  md +=
    '**Correctness bar.** A run is HC-clean iff `fullValidate` returns zero violations ' +
    'with the codes `SLOT_UNFILLED` and `GROUP_INSUFFICIENT` excluded — both indicate the ' +
    "optimizer COULDN'T fill a slot under pressure, not that it filled one INCORRECTLY. Any " +
    'real placement violation (HC-1/2/3/4/5/7/8/11/12/14/15/16) at any splitPenalty is a hard ' +
    'failure: improving composite via an invalid schedule is not a win.\n\n';

  md += '## Executive summary\n\n';
  md += `Across **${scenarios.size} scenarios** (paired-seed comparison, mean composite delta ON vs OFF):\n\n`;
  md += '| splitPenalty | scenarios won | mean Δcomposite | mean splits/run | recommendation |\n';
  md += '|---:|---:|---:|---:|---|\n';
  const ranked = [...meanDeltas.keys()].sort((a, b) => a - b);
  let bestSp = 1000;
  let bestMean = -Infinity;
  for (const sp of ranked) {
    const md_ = meanDeltas.get(sp)!;
    const mean = md_.reduce((s, x) => s + x, 0) / md_.length;
    if (mean > bestMean) {
      bestMean = mean;
      bestSp = sp;
    }
  }
  for (const sp of ranked) {
    const md_ = meanDeltas.get(sp)!;
    const mean = md_.reduce((s, x) => s + x, 0) / md_.length;
    const sf = splitRates.get(sp) ?? [0];
    const sr = sf.reduce((s, x) => s + x, 0) / sf.length;
    const w = wins.get(sp) ?? 0;
    const flag = sp === bestSp ? '**← best mean Δ**' : sp === 1000 ? 'current default' : '';
    md += `| ${sp} | ${w}/${scenarios.size} | ${fmt(mean, 1)} | ${fmt(sr, 1)} | ${flag} |\n`;
  }
  md +=
    '\n*“Mean Δcomposite” is paired ON−OFF averaged across scenarios. Positive = ON improves composite. ' +
    '“Mean splits/run” is the mean count of split SLOTS realized per attempt.*\n\n';
  return md;
}

function correctness(rows: RunResult[]): string {
  let md = '## Correctness audit\n\n';
  const offenders = rows.filter((r) => r.hcViolations > 0);
  if (offenders.length === 0) {
    md +=
      `**PASS** — all ${rows.length} runs across the full matrix produced zero hard-placement violations ` +
      '(independent `fullValidate` audit, excluding SLOT_UNFILLED and GROUP_INSUFFICIENT, which are feasibility ' +
      'pressure indicators rather than invalid placements).\n\n';
    md +=
      'HC correctness is independent of splitPenalty — the per-placement HC gate (`isEligibleForSlot`) runs ' +
      'inside Stage-4 feasibility split and `structuralRefine` quality split alike, so neither very low nor very ' +
      'high penalties can produce invalid schedules.\n\n';
  } else {
    md += `**FAIL** — ${offenders.length} runs out of ${rows.length} produced placement violations. Breakdown:\n\n`;
    const byCell = new Map<string, number>();
    for (const r of offenders) {
      const k = `${r.scenarioId} / ${r.splittingOn ? 'ON' : 'OFF'} / sp=${r.splitPenalty} / struct=${r.maxStructuralPasses}`;
      byCell.set(k, (byCell.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byCell.entries()].sort()) md += `- ${k}: **${n} run(s)**\n`;
    md += '\n';
  }

  // Aggressive-splitting safety check: per-splitPenalty split count + violations.
  md += 'Per-splitPenalty audit — confirming aggressive splitting at low penalty is still safe:\n\n';
  md += '| splitPenalty | runs | mean splits/run | max splits in a run | runs with HC violation |\n';
  md += '|---:|---:|---:|---:|---:|\n';
  const byPen = new Map<number | 'OFF', RunResult[]>();
  for (const r of rows) {
    const key = r.splittingOn ? r.splitPenalty : ('OFF' as const);
    let l = byPen.get(key);
    if (!l) {
      l = [];
      byPen.set(key, l);
    }
    l.push(r);
  }
  const keys = [...byPen.keys()].sort((a, b) => {
    if (a === 'OFF') return -1;
    if (b === 'OFF') return 1;
    return (a as number) - (b as number);
  });
  for (const k of keys) {
    const list = byPen.get(k)!;
    const splits = list.map((r) => r.splitSlotCount);
    const mean = splits.reduce((s, x) => s + x, 0) / splits.length;
    const max = Math.max(...splits);
    const viol = list.filter((r) => r.hcViolations > 0).length;
    const label = k === 'OFF' ? 'OFF' : `sp=${k}`;
    md += `| ${label} | ${list.length} | ${fmt(mean, 1)} | ${max} | ${viol} |\n`;
  }
  md += '\n';
  return md;
}

function perScenario(cells: Cell[]): string {
  const scenarios = new Set<string>();
  for (const c of cells) if (c.structuralPasses === 2) scenarios.add(c.scenarioId);
  let md = '## Per-scenario sweep\n\n';
  md += 'Each table shows the splitPenalty sweep on one scenario. Columns:\n\n';
  md += '- **composite** — schedule composite score (higher = better). Mean ± stddev across paired seeds.\n';
  md += '- **Δcomp** — paired (ON − OFF) per matched seed; positive means ON is better.\n';
  md += '- **t** — paired t-statistic; |t| ≥ 2 ⇒ p<0.05 (with N≈8, |t|≥2.36 ≈ p<0.05).\n';
  md += '- **splits/run** — mean split SLOT count per attempt.\n';
  md += '- **runs w/splits** — out of N seeds, how many actually committed any split.\n';
  md += '- **unfilled** — mean unfilled slot count (mostly identical to OFF; lower is better).\n';
  md += '- **HC** — runs with zero hard-placement violations.\n\n';

  for (const sId of [...scenarios].sort()) {
    md += `### ${sId}\n\n`;
    const off = cells.find((c) => c.scenarioId === sId && !c.splittingOn && c.structuralPasses === 2);
    const ons = cells
      .filter((c) => c.scenarioId === sId && c.splittingOn && c.structuralPasses === 2)
      .sort((a, b) => a.splitPenalty - b.splitPenalty);
    if (!off) {
      md += '_(no OFF baseline — skipping)_\n\n';
      continue;
    }
    const sample = off.runs[0];
    md +=
      `*tasks=${sample.tasksIn}, slots=${sample.slotsIn}, participants=${sample.participants}, ` +
      `attempts=${sample.attempts}, SA cap=${sample.maxSolverTimeMs}ms, N=${off.runs.length} seeds.*\n\n`;
    md += '| cell | composite | Δcomp | t | splits/run | runs w/splits | unfilled | runtime(s) | HC |\n';
    md += '|---|---|---|---|---|---|---|---|---|\n';
    const cellRow = (label: string, c: Cell, deltaStr: string, tStr: string): string => {
      const comp = summarize(c.runs.map((r) => r.compositeScore));
      const ssum = summarize(c.runs.map((r) => r.splitSlotCount));
      const splitRuns = c.runs.filter((r) => r.splitSlotCount > 0).length;
      const unf = summarize(c.runs.map((r) => r.unfilledSlots));
      const rt = summarize(c.runs.map((r) => r.runtimeMs / 1000));
      const hc = c.runs.filter((r) => r.hcViolations === 0).length;
      return `| ${label} | ${fmt(comp.mean, 1)} ± ${fmt(comp.stddev, 1)} | ${deltaStr} | ${tStr} | ${fmt(ssum.mean, 1)}±${fmt(ssum.stddev, 1)} | ${splitRuns}/${c.runs.length} | ${fmt(unf.mean, 1)} | ${fmt(rt.mean, 1)} | ${hc}/${c.runs.length} |\n`;
    };
    md += cellRow('OFF', off, '—', '—');
    let bestOnCellSp = -1;
    let bestOnCellDelta = -Infinity;
    for (const c of ons) {
      const d = pairedDeltaComposite(off, c);
      if (c.runs.every((r) => r.hcViolations === 0) && d.mean > bestOnCellDelta) {
        bestOnCellDelta = d.mean;
        bestOnCellSp = c.splitPenalty;
      }
    }
    for (const c of ons) {
      const d = pairedDeltaComposite(off, c);
      const flag = c.splitPenalty === bestOnCellSp ? '**best**' : c.splitPenalty === 1000 ? '*(default)*' : '';
      const lbl = `ON sp=${c.splitPenalty} ${flag}`;
      const sig = Math.abs(d.t) >= 2.0 ? '*' : '';
      md += cellRow(lbl, c, `${fmt(d.mean, 1)}${sig}`, fmt(d.t, 2));
    }
    md += '\n';
  }
  return md;
}

function softBreakdown(cells: Cell[]): string {
  let md = '## Soft-metric trade-off panel (paired ON − OFF)\n\n';
  md +=
    'Decomposition of where the composite delta comes from. Each cell is paired-Δ (ON minus OFF, ' +
    'matched seed). Sign convention: minRest / restPerGap should *increase* (more rest is better); ' +
    'all std-devs and penalty terms should *decrease* (lower is better, in absolute composite terms).\n\n';
  const scenarios = new Set<string>();
  for (const c of cells) if (c.structuralPasses === 2) scenarios.add(c.scenarioId);
  for (const sId of [...scenarios].sort()) {
    md += `### ${sId}\n\n`;
    const off = cells.find((c) => c.scenarioId === sId && !c.splittingOn && c.structuralPasses === 2);
    const ons = cells
      .filter((c) => c.scenarioId === sId && c.splittingOn && c.structuralPasses === 2)
      .sort((a, b) => a.splitPenalty - b.splitPenalty);
    if (!off) {
      md += '_(no OFF baseline — skipping)_\n\n';
      continue;
    }
    md +=
      '| sp | minRest | restPerGap | l0StdDev | seniorStd | dailyPPStd | dailyGStd | lowPrioPen | notWithPen | taskPrefPen |\n';
    md += '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const c of ons) {
      const d = (pick: (r: RunResult) => number) => {
        const { aArr, bArr } = pairBySeed(off.runs, c.runs, pick);
        if (aArr.length < 2) return 0;
        return pairedTStat(aArr, bArr).meanDelta;
      };
      md += `| ${c.splitPenalty} | ${fmt(
        d((r) => r.minRestHours),
        2,
      )} | ${fmt(
        d((r) => r.restPerGapBonus),
        2,
      )} | ${fmt(
        d((r) => r.l0StdDev),
        2,
      )} | ${fmt(
        d((r) => r.seniorStdDev),
        2,
      )} | ${fmt(
        d((r) => r.dailyPerParticipantStdDev),
        2,
      )} | ${fmt(
        d((r) => r.dailyGlobalStdDev),
        2,
      )} | ${fmt(
        d((r) => r.lowPriorityPenalty),
        1,
      )} | ${fmt(
        d((r) => r.notWithPenalty),
        1,
      )} | ${fmt(
        d((r) => r.taskPrefPenalty),
        1,
      )} |\n`;
    }
    md += '\n';
  }
  return md;
}

function structuralPasses(cells: Cell[]): string {
  // Tier 3 fixes splitPenalty at the product default 1000 and varies
  // structuralPasses ∈ {1,2,3,5}. Filter to that subset so we don't mix in
  // Tier 1/2 cells (which all share structuralPasses=2 but vary splitPenalty).
  const eligible = cells.filter((c) => c.splittingOn && c.splitPenalty === 1000);
  const passesByScen = new Map<string, Set<number>>();
  for (const c of eligible) {
    let s = passesByScen.get(c.scenarioId);
    if (!s) {
      s = new Set();
      passesByScen.set(c.scenarioId, s);
    }
    s.add(c.structuralPasses);
  }
  // Only include scenarios that actually have multiple structuralPasses values.
  const sweepScens = new Set<string>();
  for (const [s, set] of passesByScen) if (set.size >= 2) sweepScens.add(s);
  if (sweepScens.size === 0) return '';
  let md = '## MAX_STRUCTURAL_PASSES sweep\n\n';
  md +=
    'Current value is `2`. We vary it across {1, 2, 3, 5} on a focused subset of scenarios ' +
    'with splitPenalty fixed at the product default 1000.\n\n';
  const byScen = new Map<string, Cell[]>();
  for (const c of eligible) {
    if (!sweepScens.has(c.scenarioId)) continue;
    let l = byScen.get(c.scenarioId);
    if (!l) {
      l = [];
      byScen.set(c.scenarioId, l);
    }
    l.push(c);
  }
  for (const [sId, cs] of byScen) {
    md += `### ${sId}\n\n`;
    md += '| passes | composite | splits/run | runtime(s) | Δcomp vs passes=1 (t) |\n';
    md += '|---:|---:|---:|---:|---:|\n';
    cs.sort((a, b) => a.structuralPasses - b.structuralPasses);
    const baseline = cs.find((c) => c.structuralPasses === Math.min(...cs.map((x) => x.structuralPasses)));
    for (const c of cs) {
      const comp = summarize(c.runs.map((r) => r.compositeScore));
      const ssum = summarize(c.runs.map((r) => r.splitSlotCount));
      const rt = summarize(c.runs.map((r) => r.runtimeMs / 1000));
      let dStr = '—';
      if (baseline && c !== baseline) {
        const d = pairedDeltaComposite(baseline, c);
        dStr = `${fmt(d.mean, 1)} (t=${fmt(d.t, 2)})`;
      }
      md += `| ${c.structuralPasses} | ${fmt(comp.mean, 1)} ± ${fmt(comp.stddev, 1)} | ${fmt(ssum.mean, 1)} | ${fmt(rt.mean, 1)} | ${dStr} |\n`;
    }
    md += '\n';
  }
  return md;
}

function main(): void {
  const files = process.argv.slice(2).filter((s) => !s.startsWith('-'));
  if (files.length === 0) {
    console.error('Usage: ts-node report.ts <ndjson> [more.ndjson...]');
    process.exit(1);
  }
  const rows = loadRuns(files);
  const cells = buildCells(rows);
  process.stdout.write(execSummary(cells));
  process.stdout.write(correctness(rows));
  process.stdout.write(perScenario(cells));
  process.stdout.write(softBreakdown(cells));
  process.stdout.write(structuralPasses(cells));
}

main();
