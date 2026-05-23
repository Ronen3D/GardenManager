/**
 * Export the NDJSON runs to a flat CSV for plotting / spreadsheet analysis.
 *
 * Usage:
 *   npx ts-node src/bench-split-tuning/export-csv.ts <ndjson> [out.csv]
 */

import * as fs from 'fs';

import type { RunResult } from './runner';

const COLUMNS: Array<keyof RunResult> = [
  'scenarioId',
  'splittingOn',
  'splitPenalty',
  'maxStructuralPasses',
  'seed',
  'attempts',
  'maxSolverTimeMs',
  'tasksIn',
  'slotsIn',
  'participants',
  'feasible',
  'unfilledSlots',
  'hcViolations',
  'softWarnings',
  'compositeScore',
  'minRestHours',
  'restPerGapBonus',
  'l0StdDev',
  'seniorStdDev',
  'dailyPerParticipantStdDev',
  'dailyGlobalStdDev',
  'totalPenalty',
  'lowPriorityPenalty',
  'notWithPenalty',
  'taskPrefPenalty',
  'splitPenaltyContribution',
  'splitSlotCount',
  'splitOccurrenceCount',
  'tasksRealized',
  'runtimeMs',
  'greedyMs',
  'saMs',
  'polishMs',
  'iterations',
  'actualAttempts',
];

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  return String(v);
}

function main(): void {
  const inFile = process.argv[2];
  if (!inFile) {
    console.error('Usage: ts-node export-csv.ts <ndjson> [out.csv]');
    process.exit(1);
  }
  const outFile = process.argv[3] ?? inFile.replace(/\.ndjson$/, '.csv');
  const txt = fs.readFileSync(inFile, 'utf8');
  const lines = txt.split('\n').filter((l) => l.trim());
  const out: string[] = [];
  out.push(COLUMNS.join(','));
  for (const line of lines) {
    const r = JSON.parse(line) as RunResult;
    out.push(COLUMNS.map((c) => csvCell(r[c])).join(','));
  }
  fs.writeFileSync(outFile, out.join('\n') + '\n');
  console.log(`Wrote ${lines.length} rows → ${outFile}`);
}

main();
