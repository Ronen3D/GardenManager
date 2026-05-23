/**
 * Periodic checkpoint script — prints a one-line summary of every tier's
 * bench progress for the user-facing status notifications. Also writes
 * `tmp/checkpoint-state.json` so successive invocations can compute the rate.
 *
 * Usage (from Monitor):
 *   npx ts-node src/bench-split-tuning/checkpoint.ts
 */

import * as fs from 'fs';
import * as path from 'path';

import type { RunResult } from './runner';

interface TierExpect {
  tier: string;
  total: number;
}

const TIER_EXPECT: TierExpect[] = [
  { tier: '1', total: 756 },
  { tier: '1b', total: 1026 },
  { tier: '1c', total: 336 },
  { tier: '2', total: 816 },
  { tier: '3', total: 160 },
];

function fmtDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return `${h}h${rm.toString().padStart(2, '0')}m`;
}

interface State {
  ts: number;
  counts: Record<string, number>;
}

const stateFile = path.resolve(process.cwd(), 'tmp', 'checkpoint-state.json');
let prev: State | null = null;
if (fs.existsSync(stateFile)) {
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
  } catch {
    prev = null;
  }
}

const now = Date.now();
const cur: State = { ts: now, counts: {} };

const ts = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
process.stdout.write(`[checkpoint ${ts}]\n`);

let totalRemaining = 0;
let weightedRatePerMs = 0;
let weightedDeltaSum = 0;

for (const { tier, total } of TIER_EXPECT) {
  const file = path.resolve(process.cwd(), 'tmp', `split-bench-tier${tier}.ndjson`);
  if (!fs.existsSync(file)) {
    process.stdout.write(`  T${tier}: not started (0/${total})\n`);
    continue;
  }
  const stat = fs.statSync(file);
  const ageMs = now - stat.mtimeMs;
  let n = 0;
  let withSplits = 0;
  let hcViol = 0;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    n++;
    try {
      const r = JSON.parse(t) as RunResult;
      if (r.splitSlotCount > 0) withSplits++;
      if (r.hcViolations > 0) hcViol++;
    } catch {
      // truncated tail line, ignore
    }
  }
  cur.counts[tier] = n;
  const remaining = Math.max(0, total - n);
  totalRemaining += remaining;
  let rateStr = '—';
  let etaStr = '—';
  if (prev?.counts[tier] !== undefined) {
    const dN = n - prev.counts[tier];
    const dT = now - prev.ts;
    if (dN > 0 && dT > 0) {
      const ratePerMs = dN / dT;
      weightedRatePerMs += ratePerMs;
      weightedDeltaSum += 1;
      const rateRpm = (ratePerMs * 60000).toFixed(2);
      const eta = remaining / ratePerMs;
      rateStr = `${rateRpm} runs/min`;
      etaStr = fmtDur(eta);
    }
  }
  const idle = ageMs > 90000 && remaining > 0 ? ` · IDLE for ${fmtDur(ageMs)}` : '';
  const pct = ((n / total) * 100).toFixed(1);
  process.stdout.write(
    `  T${tier}: ${n}/${total} (${pct}%) · splits ${withSplits}/${n} · HC-viol ${hcViol}/${n} · rate ${rateStr} · ETA ${etaStr}${idle}\n`,
  );
}

if (weightedRatePerMs > 0 && totalRemaining > 0) {
  // Average rate across active tiers
  const avgRate = weightedRatePerMs / Math.max(1, weightedDeltaSum);
  const totalEta = totalRemaining / avgRate;
  process.stdout.write(`  ALL: ~${totalRemaining} runs remaining · combined ETA ${fmtDur(totalEta)}\n`);
}

fs.writeFileSync(stateFile, JSON.stringify(cur));
