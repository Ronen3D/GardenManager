/**
 * fixture-adjacency-dense — many `blocksConsecutive` tasks packed at
 * boundaries.
 *
 * On each day, 5 blocksConsecutive tasks run back-to-back with shared
 * eligible-pool overlap. Every participant placed on one task has 2 other
 * tasks blocked at the boundary. Today's S3 stickiness gives each task
 * `+1` for blocksConsecutive (uniformly); a task adjacent to 4 others
 * scores the same as an isolated one. D4's T5 (adjacency density)
 * resolves it.
 *
 * Targets: D4 (Phase 3 — T5).
 */

import { Level } from '../../models/types';
import type { FixtureInstance, FixtureSpec } from '../types';
import {
  DEFAULT_BASE_DATE,
  defaultBenchConfig,
  makeMulberry32,
  makeParticipant,
  makeSlot,
  makeTask,
  resetIdCounters,
} from './shared';

const PARTICIPANT_COUNT = 32;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

export const ADJACENCY_DENSE_FIXTURE: FixtureSpec = {
  id: 'fixture-adjacency-dense',
  description:
    'Multiple blocksConsecutive tasks packed back-to-back each day — HC-12 boundary pressure. T5 density target.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng;

    // 32 L0+Nitzan participants, 8 per group.
    const participants = [];
    for (let g = 0; g < GROUPS.length; g++) {
      const group = GROUPS[g];
      // 1 L4, 1 L3, 2 L2, 4 L0 per group
      const levelSpec: Level[] = [Level.L4, Level.L3, Level.L2, Level.L2, Level.L0, Level.L0, Level.L0, Level.L0];
      for (let j = 0; j < levelSpec.length; j++) {
        participants.push(
          makeParticipant({
            id: `p-${g}-${j}`,
            name: `P-${g}-${j}`,
            level: levelSpec[j],
            certs: ['Nitzan'],
            group,
          }),
        );
      }
    }

    // 5 blocksConsecutive tasks back-to-back: 5h each, 06:00, 11:00, 16:00, 21:00, 02:00.
    // Each adjacent pair shares boundaries — heavy HC-12 pressure.
    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      const shifts = [
        { startHour: 6, dur: 5, idx: 1 },
        { startHour: 11, dur: 5, idx: 2 },
        { startHour: 16, dur: 5, idx: 3 },
        { startHour: 21, dur: 5, idx: 4 },
        { startHour: 2, dur: 4, idx: 5 }, // post-midnight
      ];
      for (const sh of shifts) {
        tasks.push(
          makeTask({
            name: `block-${sh.idx}-d${day}`,
            sourceName: `block-${sh.idx}`,
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: sh.startHour,
            durationHours: sh.dur,
            shiftIndex: sh.idx,
            blocksConsecutive: true,
            slots: [
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            ],
          }),
        );
      }
      // One isolated blocksConsecutive task — pool same, but no adjacency
      tasks.push(
        makeTask({
          name: `isolated-d${day}`,
          sourceName: 'isolated',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 13,
          durationHours: 2,
          blocksConsecutive: true,
          slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
        }),
      );
    }

    return {
      participants,
      tasks,
      config: defaultBenchConfig(),
      dayStartHour: 5,
      baseDate: DEFAULT_BASE_DATE,
      periodDays: PERIOD_DAYS,
    };
  },
};
