/**
 * fixture-senior-heavy — 60%+ of the pool is L2-L4.
 *
 * The "inverted level pool" — L0-only tasks become tight because L0s are
 * the minority. Today's tier classifier puts L0-only at Tier 4 ("wide
 * pool"), which is the opposite of reality here. D4's continuous T1 (pool
 * fraction) captures this correctly.
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

const PARTICIPANT_COUNT = 40;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

export const SENIOR_HEAVY_FIXTURE: FixtureSpec = {
  id: 'fixture-senior-heavy',
  description: '60%+ L2-L4 (24 seniors / 16 L0s) — L0-only tasks become tight. Inverts the Tier 4 "wide pool" assumption.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng; // seed unused in this deterministic shape; kept for future variants

    // 24 seniors (6/group), 16 L0s (4/group).
    const participants = [];
    for (let g = 0; g < GROUPS.length; g++) {
      const group = GROUPS[g];
      // Per group: 2 L4, 2 L3, 2 L2, 4 L0
      const levelSpec: Level[] = [
        Level.L4, Level.L4,
        Level.L3, Level.L3,
        Level.L2, Level.L2,
        Level.L0, Level.L0, Level.L0, Level.L0,
      ];
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

    // Tasks: mix of L0-only (tight here) and senior-required (wide here).
    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // L0-only morning task (tight pool: 16 L0s for several occurrences)
      tasks.push(
        makeTask({
          name: `L0-morning-d${day}`,
          sourceName: 'L0-morning',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 6,
          durationHours: 5,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
          ],
        }),
      );
      // L0-only afternoon
      tasks.push(
        makeTask({
          name: `L0-afternoon-d${day}`,
          sourceName: 'L0-afternoon',
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
      // Senior task (wide pool here)
      tasks.push(
        makeTask({
          name: `senior-d${day}`,
          sourceName: 'senior',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 18,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }] }),
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
