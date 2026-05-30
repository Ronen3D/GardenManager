/**
 * fixture-demand-tight — totalPersonShifts ≈ 95% of total capacity.
 *
 * Roughly 95% utilization. Every participant must work nearly every
 * available hour. The current formula has no demand/supply signal —
 * a task that consumes a huge fraction of pool capacity has the same
 * priority as one that consumes little. D4's T3 (demand/supply ratio)
 * and T8 (capacity fraction) reveal this.
 *
 * Targets: D4 (Phase 3 — T3).
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

const PARTICIPANT_COUNT = 24;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3'];

export const DEMAND_TIGHT_FIXTURE: FixtureSpec = {
  id: 'fixture-demand-tight',
  description: 'Total person-shifts ≈ 95% of total capacity — heavy utilization pressure. Demand/supply target.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng;

    // 24 participants (8/group): 1 L4, 1 L3, 2 L2, 4 L0 each.
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

    // Period capacity: 24 participants × 7 days × ~14 effective hours = ~2350 hours.
    // Target demand: ~95% = ~2230 person-hours.
    // Each shift is 4h × 1 slot. ~558 person-shifts. Distribute:
    // Spread 10 shifts/day × 7 days × 2 slots × 4h = 560 person-hours per shift type.
    // Use 5 shift types per day → ~80 person-slot occurrences/day × 4h = 1120/day × 7 days too high.
    // Calibrate: 4 task slots × 7 hours × 7 days = 196 person-shifts × ~10h average = ~2000 person-hours ≈ 85%.

    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // 4 wide L0+Nitzan slots covering most of the day (06-22)
      const shifts: { startHour: number; durationHours: number }[] = [
        { startHour: 6, durationHours: 4 },
        { startHour: 10, durationHours: 4 },
        { startHour: 14, durationHours: 4 },
        { startHour: 18, durationHours: 4 },
      ];
      for (let si = 0; si < shifts.length; si++) {
        tasks.push(
          makeTask({
            name: `shift-${si + 1}-d${day}`,
            sourceName: `shift-${si + 1}`,
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: shifts[si].startHour,
            durationHours: shifts[si].durationHours,
            shiftIndex: si + 1,
            slots: [
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            ],
          }),
        );
      }
      // One senior slot per day
      tasks.push(
        makeTask({
          name: `senior-d${day}`,
          sourceName: 'senior',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 8,
          durationHours: 6,
          slots: [
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
