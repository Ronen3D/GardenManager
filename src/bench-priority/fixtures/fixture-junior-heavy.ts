/**
 * fixture-junior-heavy — 90%+ of pool is L0.
 *
 * Senior-required tasks have tight pools (4 seniors total). Today's
 * S5 senior-pressure handles tier-0 same-group senior demand somewhat,
 * but non-sameGroup senior-required tasks have no equivalent signal —
 * they sit at Tier 3 (mixed levels + cert) regardless of how few seniors
 * remain. D4's T1 (pool fraction) reveals it.
 *
 * Targets: D4 (Phase 3).
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

export const JUNIOR_HEAVY_FIXTURE: FixtureSpec = {
  id: 'fixture-junior-heavy',
  description: '90% L0 (36 L0s / 4 seniors, one per group) — senior-required tasks are tight. T1 pool-fraction target.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng;

    // 4 seniors (1 per group, all L2), 36 L0s (9 per group).
    const participants = [];
    for (let g = 0; g < GROUPS.length; g++) {
      const group = GROUPS[g];
      participants.push(
        makeParticipant({
          id: `p-sr-${g}`,
          name: `Sr-${g}`,
          level: Level.L2,
          certs: ['Nitzan'],
          group,
        }),
      );
      for (let j = 0; j < 9; j++) {
        participants.push(
          makeParticipant({
            id: `p-jr-${g}-${j}`,
            name: `Jr-${g}-${j}`,
            level: Level.L0,
            certs: ['Nitzan'],
            group,
          }),
        );
      }
    }

    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // Senior-required task — tight pool of 4
      tasks.push(
        makeTask({
          name: `senior-required-d${day}`,
          sourceName: 'senior-required',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 6,
          durationHours: 5,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L2 }] }),
          ],
        }),
      );
      // L0 task — wide pool of 36
      tasks.push(
        makeTask({
          name: `junior-d${day}`,
          sourceName: 'junior',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 12,
          durationHours: 5,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
          ],
        }),
      );
      // Mixed task — accepts both
      tasks.push(
        makeTask({
          name: `mixed-d${day}`,
          sourceName: 'mixed',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 18,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }, { level: Level.L2 }] }),
          ],
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
