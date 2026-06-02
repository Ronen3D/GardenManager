/**
 * fixture-sameGroup-heavy — 5+ tier-0 (sameGroupRequired) tasks per day.
 *
 * Multiple tier-0 tasks compete for the same scarce senior cohort across
 * groups. Today's S5 ranks each tier-0 task by its OWN senior-pressure
 * ratio, ignoring cross-task contention — two tier-0 tasks with identical
 * senior demand look identical even when their combined demand exceeds
 * total senior supply. D4's T7 (cross-task senior contention) captures
 * the joint pressure.
 *
 * Targets: D4 (Phase 3 — T7 cross-task senior).
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

const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

export const SAME_GROUP_HEAVY_FIXTURE: FixtureSpec = {
  id: 'fixture-sameGroup-heavy',
  description:
    '6 tier-0 (sameGroupRequired) tasks per day competing for the same senior cohort — cross-task contention.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng;

    // 32 participants — 1 L4, 1 L3, 2 L2, 4 L0 per group (8 per group)
    const participants = [];
    for (let g = 0; g < GROUPS.length; g++) {
      const group = GROUPS[g];
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

    // 6 tier-0 tasks per day, each requires 1 senior + 2 L0s, same group.
    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      const configs = [
        { name: 'SG-A', startHour: 5, dur: 3 },
        { name: 'SG-B', startHour: 8, dur: 3 },
        { name: 'SG-C', startHour: 11, dur: 3 },
        { name: 'SG-D', startHour: 14, dur: 3 },
        { name: 'SG-E', startHour: 17, dur: 3 },
        { name: 'SG-F', startHour: 20, dur: 3 },
      ];
      for (const tc of configs) {
        tasks.push(
          makeTask({
            name: `${tc.name}-d${day}`,
            sourceName: tc.name,
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: tc.startHour,
            durationHours: tc.dur,
            sameGroupRequired: true,
            slots: [
              makeSlot({ acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            ],
          }),
        );
      }
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
