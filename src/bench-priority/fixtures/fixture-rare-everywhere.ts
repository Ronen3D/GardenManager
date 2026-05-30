/**
 * fixture-rare-everywhere — every cert is held by ≤15% of the pool.
 *
 * Many tasks require certs; eligible pools are tiny (4–6 candidates each).
 * The S1 sub-priority `[0,9]` clamp saturates at 9 for *every* task in
 * this fixture (since most pools land between 4 and 9, all very small)
 * but the values are not differentiated finely. D3 log-scale resolves
 * this — pools of 4 vs 6 vs 9 map to clearly different sub-priorities.
 *
 * Targets: D3 (Phase 2).
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
  shuffleInPlace,
} from './shared';

const CERTS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const PARTICIPANT_COUNT = 40;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

export const RARE_EVERYWHERE_FIXTURE: FixtureSpec = {
  id: 'fixture-rare-everywhere',
  description: '4 certs each held by ≤15% of pool — every cert-requiring task has a tight pool. S1 sub-priority saturation target.',
  targetingPhase: 'D3',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);

    // Decide cert holders deterministically: shuffle indices and take the
    // first ~15% as holders for each cert independently.
    const certHolders: Record<string, Set<number>> = {};
    const targetHolders = Math.floor(PARTICIPANT_COUNT * 0.15); // 6 per cert
    for (const c of CERTS) {
      const indices = Array.from({ length: PARTICIPANT_COUNT }, (_, i) => i);
      shuffleInPlace(indices, rng);
      certHolders[c] = new Set(indices.slice(0, targetHolders));
    }

    const participants = [];
    for (let i = 0; i < PARTICIPANT_COUNT; i++) {
      const group = GROUPS[i % GROUPS.length];
      const idx = i % 12;
      let level: Level;
      if (idx === 0) level = Level.L4;
      else if (idx === 1) level = Level.L3;
      else if (idx < 4) level = Level.L2;
      else level = Level.L0;

      const certs: string[] = [];
      for (const c of CERTS) {
        if (certHolders[c].has(i)) certs.push(c);
      }
      participants.push(
        makeParticipant({
          id: `p${i + 1}`,
          name: `P${i + 1}`,
          level,
          certs,
          group,
        }),
      );
    }

    // 5 task types, each requiring a different cert. Slots are L0-only or
    // mixed L0/L2 to vary the pool shapes within the tight-everywhere theme.
    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // Each task requires one of the rare certs. L0-only + cert → Tier 2 today.
      const taskConfigs: { name: string; cert: string; startHour: number; slotCount: number }[] = [
        { name: 'TR-A', cert: 'Alpha', startHour: 6, slotCount: 2 },
        { name: 'TR-B', cert: 'Beta', startHour: 11, slotCount: 1 },
        { name: 'TR-C', cert: 'Gamma', startHour: 15, slotCount: 2 },
        { name: 'TR-D', cert: 'Delta', startHour: 19, slotCount: 1 },
      ];
      for (const tc of taskConfigs) {
        const slots = Array.from({ length: tc.slotCount }, () =>
          makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: [tc.cert] }),
        );
        tasks.push(
          makeTask({
            name: `${tc.name}-d${day}`,
            sourceName: tc.name,
            baseDate: DEFAULT_BASE_DATE,
            dayIndex: day,
            startHour: tc.startHour,
            durationHours: 3,
            slots,
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
