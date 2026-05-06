/**
 * Bench — SC-8 daily-balance metric magnitude diagnostic.
 *
 * Runs five synthetic scenarios that exercise the capacity-proportional
 * formulation of `dailyWorkloadImbalance` against the legacy capacity-blind
 * fallback (path used when the caller doesn't pass a capacities map).
 *
 * Each row prints:
 *   capacity-blind (legacy):  flat-mean across all days
 *   current SC-8 (with cap):  capacity-proportional target (production path)
 *
 * The capacity-proportional metric should:
 *   - flag imbalances the legacy metric misses (Scenario A)
 *   - stop penalising natural shapes (Scenarios B, E)
 *   - reduce signal on capacity-driven dips while keeping real imbalance (C, D)
 *
 * Run: `npx ts-node src/bench-sc8-magnitude.ts`
 *
 * Dev tip: this is a regression diagnostic. If the printed values drift
 * unexpectedly after a soft-constraints.ts edit, the metric semantics
 * probably changed unintentionally — verify before merging.
 */

import { dailyWorkloadImbalance } from './constraints/soft-constraints';
import { type Assignment, AssignmentStatus, Level, type Participant, type Task } from './models/types';
import { computeAllCapacities } from './utils/capacity';

const DSH = 5;

function mkParticipant(
  id: string,
  level: Level,
  group: string,
  availability: Array<{ start: Date; end: Date }>,
): Participant {
  return {
    id,
    name: id,
    level,
    certifications: ['Nitzan'],
    group,
    availability,
    dateUnavailability: [],
  };
}

function mkTask(id: string, name: string, start: Date, durationHours: number): Task {
  return {
    id,
    name,
    sourceName: name,
    timeBlock: { start, end: new Date(start.getTime() + durationHours * 3600_000) },
    requiredCount: 1,
    slots: [
      {
        slotId: `${id}-s1`,
        acceptableLevels: [{ level: Level.L0 }, { level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: ['Nitzan'],
      },
    ],
    blocksConsecutive: false,
    sameGroupRequired: false,
    baseLoadWeight: 1,
    loadWindows: [],
  } as Task;
}

function mkAssign(taskId: string, slotId: string, participantId: string, idx: number): Assignment {
  return {
    id: `a-${idx}`,
    taskId,
    slotId,
    participantId,
    status: AssignmentStatus.Scheduled,
    updatedAt: new Date(),
  };
}

function buildOpDayWindows(base: Date, perDayHours: number[]): Array<{ start: Date; end: Date }> {
  const dayMs = 24 * 3600_000;
  const out: Array<{ start: Date; end: Date }> = [];
  for (let d = 0; d < perDayHours.length; d++) {
    const dayStart = new Date(base.getTime() + d * dayMs);
    const opStart = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), DSH, 0, 0, 0);
    if (perDayHours[d] > 0) {
      out.push({ start: opStart, end: new Date(opStart.getTime() + perDayHours[d] * 3600_000) });
    }
  }
  return out;
}

interface Scenario {
  name: string;
  desc: string;
  build: () => {
    participants: Participant[];
    tasks: Task[];
    assignments: Assignment[];
    scheduleStart: Date;
    scheduleEnd: Date;
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'A: equal hours on mixed-capacity days',
    desc: 'Mon/Wed/Fri 4h-avail; Tue/Thu/Sat/Sun 24h. Gets 4h per day. Old: 0. New: > 4.',
    build: () => {
      const base = new Date(2026, 1, 14);
      const dayMs = 24 * 3600_000;
      const part = mkParticipant('Carol', Level.L0, 'Alpha', buildOpDayWindows(base, [4, 24, 4, 24, 4, 24, 24]));
      const tasks: Task[] = [];
      const assignments: Assignment[] = [];
      for (let d = 0; d < 7; d++) {
        const taskStart = new Date(base.getTime() + d * dayMs);
        taskStart.setHours(DSH, 0, 0, 0);
        const t = mkTask(`t${d}`, `Task ${d}`, taskStart, 4);
        tasks.push(t);
        assignments.push(mkAssign(t.id, t.slots[0].slotId, 'Carol', d));
      }
      return {
        participants: [part],
        tasks,
        assignments,
        scheduleStart: tasks[0].timeBlock.start,
        scheduleEnd: tasks[tasks.length - 1].timeBlock.end,
      };
    },
  },
  {
    name: 'B: capacity-proportional load',
    desc: 'Same availability as A. ~1.3h on partial days, 7h on full days. Old: ~5.6 (penalty!). New: ~0.2.',
    build: () => {
      const base = new Date(2026, 1, 14);
      const dayMs = 24 * 3600_000;
      const part = mkParticipant('Carol', Level.L0, 'Alpha', buildOpDayWindows(base, [4, 24, 4, 24, 4, 24, 24]));
      const tasks: Task[] = [];
      const assignments: Assignment[] = [];
      const dayHours = [1.3, 7, 1.3, 7, 1.3, 7, 7];
      for (let d = 0; d < 7; d++) {
        const taskStart = new Date(base.getTime() + d * dayMs);
        taskStart.setHours(DSH, 0, 0, 0);
        const t = mkTask(`t${d}`, `Task ${d}`, taskStart, dayHours[d]);
        tasks.push(t);
        assignments.push(mkAssign(t.id, t.slots[0].slotId, 'Carol', d));
      }
      return {
        participants: [part],
        tasks,
        assignments,
        scheduleStart: tasks[0].timeBlock.start,
        scheduleEnd: tasks[tasks.length - 1].timeBlock.end,
      };
    },
  },
  {
    name: 'C: whole-team Friday with reduced capacity',
    desc: '10 L0s. Sun-Thu 24h, Fri 12h, Sat 24h. Daily load: 50h Sun-Thu, 30h Fri, 50h Sat. Friday is expected to be lighter.',
    build: () => {
      const base = new Date(2026, 1, 14);
      const dayMs = 24 * 3600_000;
      const participants: Participant[] = [];
      for (let i = 0; i < 10; i++) {
        const days = [24, 24, 24, 24, 12, 24, 24];
        participants.push(mkParticipant(`P${i}`, Level.L0, 'Alpha', buildOpDayWindows(base, days)));
      }
      const tasks: Task[] = [];
      const assignments: Assignment[] = [];
      let aIdx = 0;
      for (let d = 0; d < 7; d++) {
        const dayLoad = d === 4 ? 30 : 50;
        let remaining = dayLoad;
        let pIdx = 0;
        const taskStart = new Date(base.getTime() + d * dayMs);
        taskStart.setHours(DSH, 0, 0, 0);
        while (remaining >= 5) {
          const t = mkTask(`d${d}-p${pIdx}`, `Task d${d}p${pIdx}`, taskStart, 5);
          tasks.push(t);
          assignments.push(mkAssign(t.id, t.slots[0].slotId, `P${pIdx % participants.length}`, aIdx++));
          pIdx++;
          remaining -= 5;
        }
      }
      return {
        participants,
        tasks,
        assignments,
        scheduleStart: tasks[0].timeBlock.start,
        scheduleEnd: tasks[tasks.length - 1].timeBlock.end,
      };
    },
  },
  {
    name: 'D: mixed pool — part-time + full-time, balanced',
    desc: '3 PT (Mon-Wed only, 8h/day), 7 FT (1.4h/day all 7 days). Proposed correctly retains cross-pool imbalance signal.',
    build: () => {
      const base = new Date(2026, 1, 14);
      const dayMs = 24 * 3600_000;
      const participants: Participant[] = [];
      for (let i = 0; i < 3; i++) {
        participants.push(
          mkParticipant(`PT${i}`, Level.L0, 'Alpha', buildOpDayWindows(base, [24, 24, 24, 0, 0, 0, 0])),
        );
      }
      for (let i = 0; i < 7; i++) {
        participants.push(
          mkParticipant(`FT${i}`, Level.L0, 'Alpha', buildOpDayWindows(base, [24, 24, 24, 24, 24, 24, 24])),
        );
      }
      const tasks: Task[] = [];
      const assignments: Assignment[] = [];
      let aIdx = 0;
      for (let i = 0; i < 3; i++) {
        for (let d = 0; d < 3; d++) {
          const ts = new Date(base.getTime() + d * dayMs);
          ts.setHours(DSH, 0, 0, 0);
          const t = mkTask(`pt${i}d${d}`, `pt${i}d${d}`, ts, 8);
          tasks.push(t);
          assignments.push(mkAssign(t.id, t.slots[0].slotId, `PT${i}`, aIdx++));
        }
      }
      for (let i = 0; i < 7; i++) {
        for (let d = 0; d < 7; d++) {
          const ts = new Date(base.getTime() + d * dayMs);
          ts.setHours(DSH + 8, 0, 0, 0);
          const t = mkTask(`ft${i}d${d}`, `ft${i}d${d}`, ts, 1.4);
          tasks.push(t);
          assignments.push(mkAssign(t.id, t.slots[0].slotId, `FT${i}`, aIdx++));
        }
      }
      return {
        participants,
        tasks,
        assignments,
        scheduleStart: tasks[0].timeBlock.start,
        scheduleEnd: tasks[tasks.length - 1].timeBlock.end,
      };
    },
  },
  {
    name: 'E: single-day participant',
    desc: 'Bob avail only Mon, gets 4h. Other days: zero capacity. Both metrics should be 0 — edge case.',
    build: () => {
      const base = new Date(2026, 1, 14);
      const part = mkParticipant('Bob', Level.L0, 'Alpha', buildOpDayWindows(base, [24, 0]));
      const opStart = new Date(base.getFullYear(), base.getMonth(), base.getDate(), DSH, 0, 0, 0);
      const t = mkTask('bob-task', 'BobTask', opStart, 4);
      const dummyStart = new Date(base.getTime() + 24 * 3600_000);
      dummyStart.setHours(DSH, 0, 0, 0);
      const dummy = mkTask('dummy', 'Dummy', dummyStart, 4);
      return {
        participants: [part],
        tasks: [t, dummy],
        assignments: [mkAssign(t.id, t.slots[0].slotId, 'Bob', 0)],
        scheduleStart: t.timeBlock.start,
        scheduleEnd: dummy.timeBlock.end,
      };
    },
  },
];

console.log('═'.repeat(80));
console.log('SC-8 Magnitude Comparison: Capacity-Blind (Legacy) vs Capacity-Proportional');
console.log('═'.repeat(80));

for (const sc of SCENARIOS) {
  console.log(`\n── ${sc.name} ──`);
  console.log(`   ${sc.desc}`);
  const data = sc.build();
  const capacities = computeAllCapacities(data.participants, data.scheduleStart, data.scheduleEnd, DSH);
  const withCap = dailyWorkloadImbalance(
    data.participants,
    data.assignments,
    data.tasks,
    undefined,
    undefined,
    capacities,
    DSH,
  );
  const blind = dailyWorkloadImbalance(
    data.participants,
    data.assignments,
    data.tasks,
    undefined,
    undefined,
    undefined,
    DSH,
  );
  const fmt = (x: number) => x.toFixed(3);
  console.log(
    `   capacity-blind (legacy):  perPart=${fmt(blind.dailyPerParticipantStdDev)}  global=${fmt(blind.dailyGlobalStdDev)}  sum=${fmt(blind.dailyPerParticipantStdDev + blind.dailyGlobalStdDev)}`,
  );
  console.log(
    `   capacity-proportional:    perPart=${fmt(withCap.dailyPerParticipantStdDev)}  global=${fmt(withCap.dailyGlobalStdDev)}  sum=${fmt(withCap.dailyPerParticipantStdDev + withCap.dailyGlobalStdDev)}`,
  );
}

console.log(`\n${'═'.repeat(80)}`);
console.log('Default dailyBalanceWeight = 144. Composite contribution = -144 × sum.');
console.log('═'.repeat(80));
