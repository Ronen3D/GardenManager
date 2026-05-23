/**
 * Analysis script for the shift-splitting tuning benchmark.
 *
 * Reads the NDJSON file produced by `bench.ts`, groups by
 * (scenarioId, structuralPasses, splittingOn, splitPenalty), and prints:
 *
 *   1. Correctness audit — any cell with hcViolations > 0 is flagged loudly.
 *   2. Per-scenario *sweep table* — one row per cell with composite, unfilled,
 *      split rate, runtime, and paired Δ vs OFF. Easy to eyeball the curve.
 *   3. Per-scenario *soft-metric breakdown* — minRest / restPerGap / l0Std /
 *      seniorStd / dailyStd / penalty buckets, paired Δ vs OFF. Tells us
 *      *what* the splits actually buy.
 *   4. MAX_STRUCTURAL_PASSES sweep (tier 3 only).
 *   5. Cross-scenario splitPenalty recommendation — which value wins the most
 *      paired-Δ-composite head-to-heads, with the mean Δ across scenarios.
 *
 * Usage:
 *   npx ts-node src/bench-split-tuning/analyze.ts <path-to-ndjson>
 */

import * as fs from 'fs';

import { ci95HalfWidth, fmt, padL, padR, pairedTStat, summarize, type Summary } from './stats';
import type { RunResult } from './runner';

function loadRuns(file: string): RunResult[] {
  const txt = fs.readFileSync(file, 'utf8');
  const rows: RunResult[] = [];
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as RunResult);
  }
  return rows;
}

/** Group key: (scenarioId, structuralPasses, splittingOn, splitPenalty). */
function cellKey(r: RunResult): string {
  return `${r.scenarioId}|${r.maxStructuralPasses}|${r.splittingOn ? 'ON' : 'OFF'}|${r.splitPenalty}`;
}

interface Cell {
  scenarioId: string;
  structuralPasses: number;
  splittingOn: boolean;
  splitPenalty: number;
  runs: RunResult[];
}

function buildCells(rows: RunResult[]): Map<string, Cell> {
  const m = new Map<string, Cell>();
  for (const r of rows) {
    const k = cellKey(r);
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
  for (const c of m.values()) c.runs.sort((a, b) => a.seed - b.seed);
  return m;
}

function pairBySeed<T>(a: RunResult[], b: RunResult[], pick: (r: RunResult) => T): { aArr: T[]; bArr: T[] } | null {
  const byA = new Map<number, RunResult>();
  for (const r of a) byA.set(r.seed, r);
  const aArr: T[] = [];
  const bArr: T[] = [];
  for (const r of b) {
    const m = byA.get(r.seed);
    if (!m) continue;
    aArr.push(pick(m));
    bArr.push(pick(r));
  }
  if (aArr.length < 2) return null;
  return { aArr, bArr };
}

function pairedScalarDelta(
  off: RunResult[],
  on: RunResult[],
  pick: (r: RunResult) => number,
): { meanDelta: number; sdDelta: number; tStat: number; n: number } {
  const a = pairBySeed(off, on, pick);
  if (!a) return { meanDelta: NaN, sdDelta: NaN, tStat: NaN, n: 0 };
  return pairedTStat(a.aArr, a.bArr);
}

// ─── Correctness audit ───────────────────────────────────────────────────────

function correctnessAudit(rows: RunResult[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('Correctness audit (independent fullValidate — non-SLOT_UNFILLED / non-GROUP_INSUFFICIENT)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  const offenders = rows.filter((r) => r.hcViolations > 0);
  if (offenders.length === 0) {
    console.log(`  PASS — all ${rows.length} runs had zero hard-placement violations.`);
    return;
  }
  console.log(`  FAIL — ${offenders.length} of ${rows.length} runs produced placement violations.`);
  const byCell = new Map<string, number>();
  for (const r of offenders) {
    const k = `${r.scenarioId}/${r.splittingOn ? 'ON' : 'OFF'}/sp=${r.splitPenalty}/struct=${r.maxStructuralPasses}`;
    byCell.set(k, (byCell.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byCell.entries()].sort()) {
    console.log(`    ${k}: ${n} run(s)`);
  }
}

// ─── Per-scenario sweep table ────────────────────────────────────────────────

function compositeRow(c: Cell): string {
  const comp = summarize(c.runs.map((r) => r.compositeScore));
  const ci = ci95HalfWidth(comp.stddev, comp.n);
  return `${fmt(comp.mean, 1).padStart(10)} ±${fmt(comp.stddev, 1).padStart(6)} (±${fmt(ci, 1).padStart(6)})`;
}

function perScenarioSweep(scenarioId: string, cells: Cell[]): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log(`Scenario: ${scenarioId}`);
  console.log('═══════════════════════════════════════════════════════════════════════════');
  const sample = cells[0]?.runs[0];
  if (sample) {
    console.log(
      `  tasksIn=${sample.tasksIn}  slotsIn=${sample.slotsIn}  participants=${sample.participants}` +
        `  attempts=${sample.attempts}  maxSolverMs=${sample.maxSolverTimeMs}` +
        `  structuralPasses=${sample.maxStructuralPasses}`,
    );
  }
  console.log('───────────────────────────────────────────────────────────────────────────');

  const offCell = cells.find((c) => !c.splittingOn);
  const onCells = cells.filter((c) => c.splittingOn).sort((a, b) => a.splitPenalty - b.splitPenalty);

  console.log(
    padR('cell', 22) +
      padR('composite mean ± sd (95%CI)', 34) +
      padR('Δcomp(t)', 18) +
      padR('split slots', 14) +
      padR('split runs', 12) +
      padR('unfilled', 10) +
      padR('runtime(s)', 14) +
      padR('HC-clean', 9),
  );

  const printRow = (label: string, c: Cell, deltaStr: string): void => {
    const splits = summarize(c.runs.map((r) => r.splitSlotCount));
    const splitRuns = c.runs.filter((r) => r.splitSlotCount > 0).length;
    const unf = summarize(c.runs.map((r) => r.unfilledSlots));
    const rtime = summarize(c.runs.map((r) => r.runtimeMs / 1000));
    const hcClean = c.runs.filter((r) => r.hcViolations === 0).length;
    console.log(
      padR(label, 22) +
        padR(compositeRow(c), 34) +
        padR(deltaStr, 18) +
        padR(`${fmt(splits.mean, 1)}±${fmt(splits.stddev, 1)}`, 14) +
        padR(`${splitRuns}/${c.runs.length}`, 12) +
        padR(`${fmt(unf.mean, 1)}±${fmt(unf.stddev, 1)}`, 10) +
        padR(`${fmt(rtime.mean, 1)}±${fmt(rtime.stddev, 1)}`, 14) +
        padR(`${hcClean}/${c.runs.length}`, 9),
    );
  };

  if (offCell) printRow('OFF (control)', offCell, '—');
  for (const c of onCells) {
    let deltaStr = '—';
    if (offCell) {
      const t = pairedScalarDelta(offCell.runs, c.runs, (r) => r.compositeScore);
      const sig = Math.abs(t.tStat) >= 2.0 ? '*' : ' ';
      deltaStr = `${fmt(t.meanDelta, 1).padStart(8)} (t=${fmt(t.tStat, 1)})${sig}`;
    }
    printRow(`ON sp=${c.splitPenalty}`, c, deltaStr);
  }
}

// ─── Per-scenario soft-metric breakdown ──────────────────────────────────────

interface SoftPickers {
  label: string;
  pick: (r: RunResult) => number;
}

const SOFT_METRICS: SoftPickers[] = [
  { label: 'minRest', pick: (r) => r.minRestHours },
  { label: 'restPerGap', pick: (r) => r.restPerGapBonus },
  { label: 'l0StdDev', pick: (r) => r.l0StdDev },
  { label: 'seniorStdDev', pick: (r) => r.seniorStdDev },
  { label: 'dailyPerParticipantStd', pick: (r) => r.dailyPerParticipantStdDev },
  { label: 'dailyGlobalStd', pick: (r) => r.dailyGlobalStdDev },
  { label: 'lowPrioPenalty', pick: (r) => r.lowPriorityPenalty },
  { label: 'notWithPenalty', pick: (r) => r.notWithPenalty },
  { label: 'taskPrefPenalty', pick: (r) => r.taskPrefPenalty },
];

function perScenarioBreakdown(scenarioId: string, cells: Cell[]): void {
  const offCell = cells.find((c) => !c.splittingOn);
  const onCells = cells.filter((c) => c.splittingOn).sort((a, b) => a.splitPenalty - b.splitPenalty);
  if (!offCell || onCells.length === 0) return;
  console.log(
    `\n  Soft-metric paired Δ (ON − OFF) — positive minRest/restPerGap = better; std/penalty = lower is better`,
  );
  console.log(`  ${padR('splitPenalty', 14)}${SOFT_METRICS.map((m) => padR(m.label, 13)).join('')}`);
  for (const c of onCells) {
    const cells = SOFT_METRICS.map((m) => {
      const t = pairedScalarDelta(offCell.runs, c.runs, m.pick);
      return padR(fmt(t.meanDelta, 2), 13);
    }).join('');
    console.log(`  ${padR(c.splitPenalty.toString(), 14)}${cells}`);
  }
}

// ─── MAX_STRUCTURAL_PASSES sweep (tier 3) ────────────────────────────────────

function structuralPassesTable(rows: RunResult[]): void {
  const onRows = rows.filter((r) => r.splittingOn);
  if (onRows.length === 0) return;
  const passes = new Set<number>(onRows.map((r) => r.maxStructuralPasses));
  if (passes.size < 2) return;
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('MAX_STRUCTURAL_PASSES sweep (ON cells, paired by seed)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  const byScenario = new Map<string, RunResult[]>();
  for (const r of onRows) {
    let l = byScenario.get(r.scenarioId);
    if (!l) {
      l = [];
      byScenario.set(r.scenarioId, l);
    }
    l.push(r);
  }
  for (const [scen, runs] of byScenario) {
    console.log(`\n  ${scen}:`);
    const byPasses = new Map<number, RunResult[]>();
    for (const r of runs) {
      let l = byPasses.get(r.maxStructuralPasses);
      if (!l) {
        l = [];
        byPasses.set(r.maxStructuralPasses, l);
      }
      l.push(r);
    }
    const sortedPasses = [...byPasses.keys()].sort((a, b) => a - b);
    const baseline = sortedPasses[0];
    const basRuns = byPasses.get(baseline)!.sort((a, b) => a.seed - b.seed);
    for (const p of sortedPasses) {
      const cellRuns = byPasses.get(p)!.sort((a, b) => a.seed - b.seed);
      const comp = summarize(cellRuns.map((r) => r.compositeScore));
      const split = summarize(cellRuns.map((r) => r.splitSlotCount));
      const rtime = summarize(cellRuns.map((r) => r.runtimeMs / 1000));
      const hc = cellRuns.filter((r) => r.hcViolations === 0).length;
      let deltaStr = '';
      if (p !== baseline) {
        const t = pairedScalarDelta(basRuns, cellRuns, (r) => r.compositeScore);
        deltaStr = `  Δcomp vs passes=${baseline}: ${fmt(t.meanDelta, 1)} (t=${fmt(t.tStat, 2)})`;
      }
      console.log(
        `    passes=${p}: comp ${fmt(comp.mean, 0)}±${fmt(comp.stddev, 0)}` +
          `   splits ${fmt(split.mean, 1)}±${fmt(split.stddev, 1)}` +
          `   rt ${fmt(rtime.mean, 1)}s` +
          `   HC ${hc}/${cellRuns.length}` +
          deltaStr,
      );
    }
  }
}

// ─── Cross-scenario recommendation ───────────────────────────────────────────

function overallRecommendation(cells: Map<string, Cell>): void {
  console.log('\n═══════════════════════════════════════════════════════════════════════════');
  console.log('Cross-scenario splitPenalty recommendation');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  // For each scenario, find OFF and the best ON splitPenalty (max paired Δcomposite).
  const scenarios = new Set<string>();
  for (const c of cells.values()) scenarios.add(c.scenarioId);
  const wins = new Map<number, number>();
  const meanDeltas = new Map<number, number[]>();
  const winners = new Map<number, string[]>(); // sp → scenarios where it won
  const splitFreq = new Map<number, number[]>(); // sp → mean split rate per scenario

  for (const sId of scenarios) {
    const sCells = [...cells.values()].filter((c) => c.scenarioId === sId);
    const off = sCells.find((c) => !c.splittingOn);
    const onCells = sCells.filter((c) => c.splittingOn).sort((a, b) => a.splitPenalty - b.splitPenalty);
    if (!off || onCells.length === 0) continue;
    let best: { sp: number; delta: number } | null = null;
    for (const c of onCells) {
      // Skip cells with HC violations — correctness gate.
      const allHcClean = c.runs.every((r) => r.hcViolations === 0);
      if (!allHcClean) continue;
      const t = pairedScalarDelta(off.runs, c.runs, (r) => r.compositeScore);
      const md = meanDeltas.get(c.splitPenalty) ?? [];
      md.push(t.meanDelta);
      meanDeltas.set(c.splitPenalty, md);

      const sr = c.runs.reduce((s, r) => s + r.splitSlotCount, 0) / c.runs.length;
      const sf = splitFreq.get(c.splitPenalty) ?? [];
      sf.push(sr);
      splitFreq.set(c.splitPenalty, sf);

      if (!best || t.meanDelta > best.delta) best = { sp: c.splitPenalty, delta: t.meanDelta };
    }
    if (best) {
      wins.set(best.sp, (wins.get(best.sp) ?? 0) + 1);
      const w = winners.get(best.sp) ?? [];
      w.push(sId);
      winners.set(best.sp, w);
    }
  }
  console.log('\n  splitPenalty | scens won | mean Δcomp | median Δcomp | mean split slots');
  for (const sp of [...meanDeltas.keys()].sort((a, b) => a - b)) {
    const md = meanDeltas.get(sp)!;
    const m = md.reduce((a, b) => a + b, 0) / md.length;
    const sorted = [...md].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const w = wins.get(sp) ?? 0;
    const sf = splitFreq.get(sp) ?? [0];
    const mf = sf.reduce((a, b) => a + b, 0) / sf.length;
    console.log(
      `  ${padL(sp.toString(), 12)} | ${padL(`${w}/${scenarios.size}`, 9)} | ${fmt(m, 1).padStart(10)} | ${fmt(median, 1).padStart(12)} | ${fmt(mf, 1).padStart(16)}`,
    );
  }

  console.log('\n  Per-splitPenalty winners (scenarios where this value gave the best paired Δcomposite):');
  for (const sp of [...winners.keys()].sort((a, b) => a - b)) {
    const list = winners.get(sp)!.sort();
    console.log(`    sp=${padL(sp.toString(), 6)}: ${list.join(', ')}`);
  }

  console.log('  NB: composite is "higher is better"; rest weighted positively, std-devs/penalties negatively.');
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: ts-node analyze.ts <ndjson>');
    process.exit(1);
  }
  const rows = loadRuns(file);
  console.log(`Loaded ${rows.length} runs from ${file}`);

  correctnessAudit(rows);

  const cells = buildCells(rows);
  const scenarios = new Set<string>();
  for (const c of cells.values()) scenarios.add(c.scenarioId);
  for (const sId of [...scenarios].sort()) {
    const sCells = [...cells.values()].filter((c) => c.scenarioId === sId);
    perScenarioSweep(sId, sCells);
    perScenarioBreakdown(sId, sCells);
  }

  structuralPassesTable(rows);
  overallRecommendation(cells);
}

main();
