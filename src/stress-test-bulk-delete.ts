/**
 * Stress Test — Bulk Delete Performance Profiling
 *
 * Creates 50 participants with blackouts and date unavailability rules,
 * then measures the time taken for `removeParticipantsBulk(20)`.
 *
 * Breaks down timing into:
 *   1. captureSnapshot / pushSnapshot (undo system)
 *   2. Map.delete loop
 *   3. notify() → subscriber execution
 *   4. Assignment stripping (simulated onStoreChanged)
 *
 * Usage: npx tsx src/stress-test-bulk-delete.ts
 */

import {
  Level,
  Certification,
  TaskType,
  Schedule,
  Task,
  Assignment,
  AssignmentStatus,
  Participant,
} from './models/types';
import * as store from './web/config-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ms(label: string, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const elapsed = performance.now() - t0;
  console.log(`  [${label}] ${elapsed.toFixed(2)} ms`);
  return elapsed;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

console.log('\n═══ Stress Test: Bulk Delete Performance ═══\n');

// Initialize store (seeds 60 participants + 7 task templates)
store.initStore();

const allParticipants = store.getAllParticipants();
console.log(`Participants after seed: ${allParticipants.length}`);

// Add some blackouts and date-unavailability rules to stress the clone
console.log('Adding blackouts and date-unavailability rules...');
let blackoutCount = 0;
let dateRuleCount = 0;
for (const p of allParticipants) {
  // Add 2 blackouts per participant
  for (let i = 0; i < 2; i++) {
    const start = new Date(2026, 1, 16, 8 + i * 4, 0);
    const end = new Date(2026, 1, 16, 12 + i * 4, 0);
    store.addBlackout(p.id, start, end, `Blackout ${i + 1}`);
    blackoutCount++;
  }
  // Add 1 date-unavailability rule per participant
  store.addDateUnavailability(p.id, {
    dayOfWeek: 5, // Friday
    allDay: false,
    startHour: 8,
    endHour: 16,
    reason: 'Weekly off',
  });
  dateRuleCount++;
}
console.log(`Added ${blackoutCount} blackouts, ${dateRuleCount} date rules`);

// Build a fake schedule with 200 assignments spread across participants
console.log('Building synthetic schedule with 200 assignments...\n');

const tasks: Task[] = [];
const assignments: Assignment[] = [];
let slotCounter = 0;
for (let t = 0; t < 40; t++) {
  const taskId = `stress-task-${t}`;
  const start = new Date(2026, 1, 16, 5 + (t % 8) * 2, 0);
  const end = new Date(start.getTime() + 8 * 3600000);
  tasks.push({
    id: taskId,
    type: TaskType.Adanit,
    name: `Stress Task ${t}`,
    timeBlock: { start, end },
    requiredCount: 5,
    slots: Array.from({ length: 5 }, (_, i) => ({
      slotId: `slot-${++slotCounter}`,
      acceptableLevels: [Level.L0, Level.L2],
      requiredCertifications: [],
      label: `Slot ${i}`,
    })),
    isLight: false,
    sameGroupRequired: false,
  });

  // 5 assignments per task = 200 total
  for (let s = 0; s < 5; s++) {
    const pIdx = (t * 5 + s) % allParticipants.length;
    assignments.push({
      id: `stress-a-${t}-${s}`,
      taskId,
      slotId: `slot-${t * 5 + s + 1}`,
      participantId: allParticipants[pIdx].id,
      status: AssignmentStatus.Scheduled,
      updatedAt: new Date(),
    });
  }
}

const fakeSchedule: Schedule = {
  id: 'stress-sched-1',
  generatedAt: new Date(),
  tasks,
  assignments,
  participants: allParticipants.map(p => ({ ...p })),
  violations: [],
  feasible: true,
  score: { compositeScore: 50, minRestHours: 8, avgRestHours: 12, restStdDev: 1.2, totalPenalty: 0, totalBonus: 5 },
};

// ─── Test 1: Measure captureSnapshot alone ───────────────────────────────────

console.log('── Phase 1: captureSnapshot() isolation ──');
// We'll call undo logic to indirectly measure snapshot perf
// First, do a trivial edit to push a snapshot
const trivialP = allParticipants[0];
store.updateParticipant(trivialP.id, { name: trivialP.name + ' (test)' });

// Now measure an undo (which calls captureSnapshot for redo + restoreSnapshot)
ms('undo (captureSnapshot + restore)', () => {
  store.undo();
});

// ─── Test 2: removeParticipantsBulk without subscriber ───────────────────────

console.log('\n── Phase 2: removeParticipantsBulk (no subscriber) ──');
const idsToDelete = allParticipants.slice(0, 20).map(p => p.id);
console.log(`Deleting ${idsToDelete.length} participants out of ${store.getAllParticipants().length}...`);

const t2 = ms('removeParticipantsBulk (no subscriber)', () => {
  store.removeParticipantsBulk(idsToDelete);
});

console.log(`Remaining participants: ${store.getAllParticipants().length}`);

// Undo to restore
store.undo();
console.log(`Restored (undo): ${store.getAllParticipants().length} participants`);

// ─── Test 3: removeParticipantsBulk WITH subscriber doing assignment strip ──

console.log('\n── Phase 3: removeParticipantsBulk + subscriber (assignment strip) ──');

let subscriberTimings = { calls: 0, totalMs: 0 };
let _testSchedule: Schedule | null = { ...fakeSchedule };

const unsub = store.subscribe(() => {
  const subT0 = performance.now();
  subscriberTimings.calls++;

  if (!_testSchedule) return;

  const storeIds = new Set(store.getAllParticipants().map(p => p.id));
  const before = _testSchedule.assignments.length;
  const cleaned = _testSchedule.assignments.filter(a => storeIds.has(a.participantId));
  if (cleaned.length !== before) {
    _testSchedule = {
      ..._testSchedule,
      assignments: cleaned,
      participants: _testSchedule.participants.filter(p => storeIds.has(p.id)),
    };
  }

  subscriberTimings.totalMs += performance.now() - subT0;
});

const t3 = ms('removeParticipantsBulk + subscriber', () => {
  store.removeParticipantsBulk(idsToDelete);
});

console.log(`  Subscriber calls: ${subscriberTimings.calls}`);
console.log(`  Subscriber total: ${subscriberTimings.totalMs.toFixed(2)} ms`);
console.log(`  Assignments after strip: ${_testSchedule?.assignments.length ?? 0} (was ${fakeSchedule.assignments.length})`);
console.log(`  Participants after strip: ${_testSchedule?.participants.length ?? 0}`);
unsub();

// Undo to restore
store.undo();

// ─── Test 4: Full DOM render simulation (measure getAllParticipants + sort) ──

console.log('\n── Phase 4: Render data preparation ──');
ms('getAllParticipants + sort', () => {
  const ps = store.getAllParticipants();
  ps.sort((a, b) => a.name.localeCompare(b.name));
});

// ─── Test 5: Check undo stack size (memory) ──────────────────────────────────

console.log('\n── Phase 5: Undo stack depth ──');
const undoState = store.getUndoRedoState();
console.log(`  Undo depth: ${undoState.undoDepth}`);
console.log(`  Redo depth: ${undoState.redoDepth}`);

// ─── Test 6: Heavy snapshot stress (push 40 snapshots quickly) ─────────────

console.log('\n── Phase 6: Snapshot stress (40 rapid edits) ──');
const rapid = ms('40 rapid updateParticipant calls', () => {
  const ps = store.getAllParticipants();
  for (let i = 0; i < 40; i++) {
    const p = ps[i % ps.length];
    store.updateParticipant(p.id, { name: `Stress ${i}` });
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══ Summary ═══');
console.log(`  Bulk delete (no subscriber):   ${t2.toFixed(2)} ms`);
console.log(`  Bulk delete + subscriber:      ${t3.toFixed(2)} ms`);
console.log(`  Subscriber overhead:           ${subscriberTimings.totalMs.toFixed(2)} ms`);
console.log(`  40 rapid edits:                ${rapid.toFixed(2)} ms`);
console.log(`  System responsive: ${t3 < 200 ? '✓ YES' : '✗ SLOW (>200ms)'}`);
console.log('');
