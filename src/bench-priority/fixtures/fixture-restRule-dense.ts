/**
 * fixture-restRule-dense — 4+ tasks share one `restRuleId` over 7 days.
 *
 * Many task occurrences share the same rest rule X (5h gap required).
 * The current S3 stickiness contributes `+1` for `restRuleId` presence
 * regardless of how many other tasks share the rule. A rule shared by
 * 2 tasks looks the same as one shared by 7. D4's T7 rest-rule analog
 * (sharingDensity × ruleHours / periodHours) reveals it.
 *
 * Targets: D4 (Phase 3 — T7 rest-rule analog).
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

export const REST_RULE_DENSE_FIXTURE: FixtureSpec = {
  id: 'fixture-restRule-dense',
  description:
    'Dense restRule X (5 task types share it) vs. sparse restRule Y (1 task) — same +1 stickiness today. T7 rest-rule analog target.',
  targetingPhase: 'D4',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);
    void rng;

    // 32 participants — 1 L4, 1 L3, 2 L2, 4 L0 per group
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

    // Two rest rules: X (shared by 5 task types) and Y (shared by 1 task type).
    const RR_X = 'rr-X-5h';
    const RR_Y = 'rr-Y-5h';
    const restRuleMap = new Map<string, number>([
      [RR_X, 5 * 3600000],
      [RR_Y, 5 * 3600000],
    ]);

    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // 5 task types on RR_X — pressure
      const xConfigs = [
        { name: 'TX-1', startHour: 6, dur: 3 },
        { name: 'TX-2', startHour: 10, dur: 3 },
        { name: 'TX-3', startHour: 14, dur: 3 },
        { name: 'TX-4', startHour: 18, dur: 3 },
        { name: 'TX-5', startHour: 22, dur: 3 },
      ];
      for (const tc of xConfigs) {
        tasks.push(
          makeTask({
            name: `${tc.name}-d${day}`,
            sourceName: tc.name,
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: tc.startHour,
            durationHours: tc.dur,
            restRuleId: RR_X,
            slots: [makeSlot({ acceptableLevels: [{ level: Level.L0 }] })],
          }),
        );
      }
      // 1 task on RR_Y — no pressure
      tasks.push(
        makeTask({
          name: `TY-1-d${day}`,
          sourceName: 'TY-1',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 8,
          durationHours: 3,
          restRuleId: RR_Y,
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
      restRuleMap,
    };
  },
};
