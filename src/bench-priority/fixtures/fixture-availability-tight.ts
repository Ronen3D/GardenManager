/**
 * fixture-availability-tight — static pool large, time-window-available pool small.
 *
 * Most participants have wide availability. A specific "high-pressure"
 * task time block (06:00-10:00 on day 3) overlaps a narrow availability
 * window for most participants — only 4 are available at that time, even
 * though the static (level + cert + forbidden) eligible pool is ≥30.
 *
 * NO PHASE IN THIS PLAN TARGETS THIS FIXTURE — it's measurement
 * infrastructure for a future HC-3-aware T1 variant. All phases
 * (baseline, D1+D3, D4) expected NEUTRAL. The bench measures the gap
 * so a future phase has a baseline to compare against.
 *
 * Targets: none (future phase).
 */

import { addDays, addHours, startOfDay } from 'date-fns';

import { type AvailabilityWindow, Level } from '../../models/types';
import type { FixtureInstance, FixtureSpec } from '../types';
import {
  DEFAULT_BASE_DATE,
  defaultBenchConfig,
  makeMulberry32,
  makeParticipant,
  makeSlot,
  makeTask,
  resetIdCounters,
  wideAvailability,
} from './shared';

const PARTICIPANT_COUNT = 40;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

/** The high-pressure window — 06:00-10:00 on day 3. */
const TIGHT_DAY = 3;
const TIGHT_START_HOUR = 6;
const TIGHT_DURATION_HOURS = 4;

export const AVAILABILITY_TIGHT_FIXTURE: FixtureSpec = {
  id: 'fixture-availability-tight',
  description:
    'Static pool ≥30 but time-window-available pool ≤5 on one specific task time block. Measurement infrastructure for a future HC-3-aware T1 variant.',
  targetingPhase: 'future',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);

    // Choose 4 participants who ARE available during the tight window.
    // The other 36 have availability that EXCLUDES the tight window.
    // We deterministically pick 4 participants by seeded shuffle.
    const indices = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => i);
    // simple Fisher-Yates with the rng
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const AVAILABLE_DURING_TIGHT = new Set(indices.slice(0, 4));

    const dayBase = addDays(startOfDay(DEFAULT_BASE_DATE), TIGHT_DAY - 1);
    const tightStart = addHours(dayBase, TIGHT_START_HOUR);
    const tightEnd = addHours(dayBase, TIGHT_START_HOUR + TIGHT_DURATION_HOURS);

    const participants = [];
    for (let i = 0; i < PARTICIPANT_COUNT; i++) {
      const group = GROUPS[i % GROUPS.length];
      const idx = i % 12;
      let level: Level;
      if (idx === 0) level = Level.L4;
      else if (idx === 1) level = Level.L3;
      else if (idx < 4) level = Level.L2;
      else level = Level.L0;

      let availability: AvailabilityWindow[];
      if (AVAILABLE_DURING_TIGHT.has(i)) {
        // Wide availability — covers everything including the tight window.
        availability = wideAvailability(DEFAULT_BASE_DATE, PERIOD_DAYS);
      } else {
        // Available everywhere EXCEPT the tight window. Express as TWO windows:
        // [start of period, tightStart] and [tightEnd, end of period].
        const periodStart = startOfDay(DEFAULT_BASE_DATE);
        const periodEnd = addDays(periodStart, PERIOD_DAYS + 1);
        availability = [
          { start: periodStart, end: tightStart },
          { start: tightEnd, end: periodEnd },
        ];
      }

      participants.push(
        makeParticipant({
          id: `p${i + 1}`,
          name: `P${i + 1}`,
          level,
          certs: ['Nitzan'],
          group,
          availability,
        }),
      );
    }

    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // The "tight" task — falls on day TIGHT_DAY, hour TIGHT_START_HOUR.
      // Static pool is huge (all 40 are L0+Nitzan-eligible by level+cert)
      // but only 4 are actually available at this time block.
      if (day === TIGHT_DAY) {
        tasks.push(
          makeTask({
            name: `tight-d${day}`,
            sourceName: 'tight',
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: TIGHT_START_HOUR,
            durationHours: TIGHT_DURATION_HOURS,
            slots: [
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
              makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            ],
          }),
        );
      }
      // Other tasks (non-tight) — wide pool, normal time blocks
      tasks.push(
        makeTask({
          name: `wide-A-d${day}`,
          sourceName: 'wide-A',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 12,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
          ],
        }),
      );
      tasks.push(
        makeTask({
          name: `wide-B-d${day}`,
          sourceName: 'wide-B',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 17,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
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
