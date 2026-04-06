/**
 * Micro-benchmark: old (.map/.filter/.sort) vs new (_hcScratch) for HC-12/HC-14.
 * Measures wall-clock time over many iterations on realistic data.
 */

interface TimeBlock { start: Date; end: Date; }
interface Task {
  id: string; name: string; timeBlock: TimeBlock;
  blocksConsecutive: boolean; requiresCategoryBreak?: boolean;
  loadWindows?: { weight: number }[];
  [key: string]: unknown;
}
interface Assignment { id: string; taskId: string; slotId: string; participantId: string; }

function effectivelyBlocksAt(task: Task, edge: 'start' | 'end'): boolean {
  if (task.loadWindows && task.loadWindows.length > 0) {
    return task.loadWindows.some(w => w.weight >= 1.0);
  }
  return task.blocksConsecutive;
}

const HOUR = 3600000;
const BASE = new Date('2026-04-05T05:00:00Z').getTime();
const BREAK_MS = 5 * HOUR;

// ─── OLD ────────────────────────────────────────────────────────────────────

function oldHC12(pid: string, byP: Map<string, Assignment[]>, tm: Map<string, Task>): boolean {
  const pAssignments = (byP.get(pid) || [])
    .map(a => ({ assignment: a, task: tm.get(a.taskId) }))
    .filter((x): x is { assignment: Assignment; task: Task } => x.task != null)
    .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  for (let x = 0; x < pAssignments.length - 1; x++) {
    const cur = pAssignments[x]; const nxt = pAssignments[x + 1];
    if (cur.task.id === nxt.task.id) continue;
    const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
    if (gap > 0) continue;
    if (effectivelyBlocksAt(cur.task, 'end') && effectivelyBlocksAt(nxt.task, 'start')) return false;
  }
  return true;
}

function oldHC14(pid: string, byP: Map<string, Assignment[]>, tm: Map<string, Task>, breakMs: number): boolean {
  const pAssignments = (byP.get(pid) || [])
    .map(a => ({ assignment: a, task: tm.get(a.taskId) }))
    .filter((x): x is { assignment: Assignment; task: Task } => x.task != null && !!x.task.requiresCategoryBreak)
    .sort((a, b) => a.task.timeBlock.start.getTime() - b.task.timeBlock.start.getTime());
  for (let x = 0; x < pAssignments.length - 1; x++) {
    const cur = pAssignments[x]; const nxt = pAssignments[x + 1];
    if (cur.task.id === nxt.task.id) continue;
    const gap = nxt.task.timeBlock.start.getTime() - cur.task.timeBlock.end.getTime();
    if (gap < breakMs) return false;
  }
  return true;
}

// ─── NEW ────────────────────────────────────────────────────────────────────

const _hcScratch: Task[] = [];

function newHC12(pid: string, byP: Map<string, Assignment[]>, tm: Map<string, Task>): boolean {
  const raw = byP.get(pid) || [];
  _hcScratch.length = 0;
  for (let i = 0; i < raw.length; i++) {
    const task = tm.get(raw[i].taskId);
    if (task != null) _hcScratch.push(task);
  }
  _hcScratch.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());
  for (let x = 0; x < _hcScratch.length - 1; x++) {
    const cur = _hcScratch[x]; const nxt = _hcScratch[x + 1];
    if (cur.id === nxt.id) continue;
    const gap = nxt.timeBlock.start.getTime() - cur.timeBlock.end.getTime();
    if (gap > 0) continue;
    if (effectivelyBlocksAt(cur, 'end') && effectivelyBlocksAt(nxt, 'start')) return false;
  }
  return true;
}

function newHC14(pid: string, byP: Map<string, Assignment[]>, tm: Map<string, Task>, breakMs: number): boolean {
  const raw = byP.get(pid) || [];
  _hcScratch.length = 0;
  for (let i = 0; i < raw.length; i++) {
    const task = tm.get(raw[i].taskId);
    if (task != null && task.requiresCategoryBreak) _hcScratch.push(task);
  }
  _hcScratch.sort((a, b) => a.timeBlock.start.getTime() - b.timeBlock.start.getTime());
  for (let x = 0; x < _hcScratch.length - 1; x++) {
    const cur = _hcScratch[x]; const nxt = _hcScratch[x + 1];
    if (cur.id === nxt.id) continue;
    const gap = nxt.timeBlock.start.getTime() - cur.timeBlock.end.getTime();
    if (gap < breakMs) return false;
  }
  return true;
}

// ─── Generate realistic test data ───────────────────────────────────────────

// Simulate ~50 participants, ~8 assignments each (realistic for garden schedule)
const PARTICIPANT_COUNT = 50;
const ASSIGNMENTS_PER_PARTICIPANT = 8;
const TASK_COUNT = 25;

const tasks: Task[] = [];
const taskMap = new Map<string, Task>();
for (let ti = 0; ti < TASK_COUNT; ti++) {
  const startH = 5 + Math.floor(Math.random() * 16); // 5am to 9pm
  const dur = 2 + Math.floor(Math.random() * 4);      // 2-5 hours
  const t: Task = {
    id: `t${ti}`,
    name: `Task${ti}`,
    timeBlock: { start: new Date(BASE + startH * HOUR), end: new Date(BASE + (startH + dur) * HOUR) },
    blocksConsecutive: Math.random() < 0.4,
    requiresCategoryBreak: Math.random() < 0.3,
  };
  tasks.push(t);
  taskMap.set(t.id, t);
}

const allAssignments: Assignment[] = [];
const byParticipant = new Map<string, Assignment[]>();
for (let pi = 0; pi < PARTICIPANT_COUNT; pi++) {
  const pid = `p${pi}`;
  const pAssigns: Assignment[] = [];
  for (let ai = 0; ai < ASSIGNMENTS_PER_PARTICIPANT; ai++) {
    const task = tasks[Math.floor(Math.random() * tasks.length)];
    const a: Assignment = { id: `a${pi}-${ai}`, taskId: task.id, slotId: 's1', participantId: pid };
    pAssigns.push(a);
    allAssignments.push(a);
  }
  byParticipant.set(pid, pAssigns);
}

// Participant IDs to test (cycle through all participants like real SA loop)
const pids = Array.from(byParticipant.keys());

// ─── Benchmark ──────────────────────────────────────────────────────────────

const ITERATIONS = 200_000; // Simulate 200k swap feasibility checks
const fs = require('fs');
const out: string[] = [];

// Warm up JIT
for (let w = 0; w < 5000; w++) {
  const pid = pids[w % pids.length];
  oldHC12(pid, byParticipant, taskMap);
  oldHC14(pid, byParticipant, taskMap, BREAK_MS);
  newHC12(pid, byParticipant, taskMap);
  newHC14(pid, byParticipant, taskMap, BREAK_MS);
}

// Measure OLD
const t0old = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) {
  const pidI = pids[i % pids.length];
  const pidJ = pids[(i + 1) % pids.length];
  oldHC12(pidI, byParticipant, taskMap);
  oldHC12(pidJ, byParticipant, taskMap);
  oldHC14(pidI, byParticipant, taskMap, BREAK_MS);
  oldHC14(pidJ, byParticipant, taskMap, BREAK_MS);
}
const oldNs = Number(process.hrtime.bigint() - t0old);

// Measure NEW
const t0new = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) {
  const pidI = pids[i % pids.length];
  const pidJ = pids[(i + 1) % pids.length];
  newHC12(pidI, byParticipant, taskMap);
  newHC12(pidJ, byParticipant, taskMap);
  newHC14(pidI, byParticipant, taskMap, BREAK_MS);
  newHC14(pidJ, byParticipant, taskMap, BREAK_MS);
}
const newNs = Number(process.hrtime.bigint() - t0new);

const oldMs = oldNs / 1e6;
const newMs = newNs / 1e6;
const speedup = ((oldMs - newMs) / oldMs * 100).toFixed(1);
const oldPerCall = (oldNs / (ITERATIONS * 4) / 1000).toFixed(2); // 4 calls per iter
const newPerCall = (newNs / (ITERATIONS * 4) / 1000).toFixed(2);

out.push(`=== HC-12/HC-14 Micro-Benchmark ===`);
out.push(`Participants: ${PARTICIPANT_COUNT}, Assignments/participant: ${ASSIGNMENTS_PER_PARTICIPANT}, Tasks: ${TASK_COUNT}`);
out.push(`Iterations: ${ITERATIONS.toLocaleString()} (× 4 calls each = ${(ITERATIONS * 4).toLocaleString()} total calls)`);
out.push(``);
out.push(`OLD (.map/.filter/.sort): ${oldMs.toFixed(1)} ms total, ${oldPerCall} µs/call`);
out.push(`NEW (_hcScratch):         ${newMs.toFixed(1)} ms total, ${newPerCall} µs/call`);
out.push(`Speedup:                  ${speedup}%`);
out.push(``);

// Context: what fraction of total SA time is this?
// isSwapFeasible also includes HC-1,2,3,4,5,7,11 checks + the IncrementalScorer.
// HC-12/HC-14 are ~30-40% of isSwapFeasible time (the rest are O(k) map lookups).
// isSwapFeasible is ~50% of total SA iteration time (the other 50% is IncrementalScorer).
// So HC-12/HC-14 ≈ 15-20% of total SA time.
const estimatedSAFraction = 0.175;
const estimatedTotalSASpeedup = (parseFloat(speedup) * estimatedSAFraction).toFixed(1);
out.push(`Estimated HC-12/HC-14 share of SA loop: ~15-20%`);
out.push(`Estimated total SA loop speedup: ~${estimatedTotalSASpeedup}%`);

fs.writeFileSync('bench-results.txt', out.join('\n') + '\n');
