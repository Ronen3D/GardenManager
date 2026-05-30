/**
 * fixture-universal-cert — every cert is held by ≥95% of the pool.
 *
 * The "Nitzan-style" trap: most tasks require a cert, but the cert
 * eliminates ~0% of the pool. Today's `hasCerts` flag classifies these
 * tasks into Tier 2 ("L0+cert = tight pool"), but the actual pool is
 * essentially L0-only. D1 resolves via lowPriority-aware effective cert
 * impact (≈ 0 for universal certs → S2 reads correctly).
 *
 * Targets: D1 (Phase 2).
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

const CERTS = ['NitzanU', 'HamamaU', 'HoreshU'];
const PARTICIPANT_COUNT = 40;
const PERIOD_DAYS = 7;
const GROUPS = ['ק1', 'ק2', 'ק3', 'ק4'];

export const UNIVERSAL_CERT_FIXTURE: FixtureSpec = {
  id: 'fixture-universal-cert',
  description: 'All 3 certs held by ≥95% of the pool — `hasCerts` is structurally true but eliminates ~no one. Tier 2 mis-classification target.',
  targetingPhase: 'D1',
  generate: (seed: number): FixtureInstance => {
    resetIdCounters();
    const rng = makeMulberry32(seed);

    // Build participants. ~95% hold each cert. The 5% non-holders are
    // chosen independently per cert (so a participant may lack one cert
    // and hold the others).
    const participants = [];
    for (let i = 0; i < PARTICIPANT_COUNT; i++) {
      const group = GROUPS[i % GROUPS.length];
      // Level distribution: 1 L4, 1 L3, 2 L2, 8 L0 per 12 (default proportions).
      const idx = i % 12;
      let level: Level;
      if (idx === 0) level = Level.L4;
      else if (idx === 1) level = Level.L3;
      else if (idx < 4) level = Level.L2;
      else level = Level.L0;

      const certs: string[] = [];
      for (const c of CERTS) {
        // ~95% inclusion threshold; rng deterministic from seed.
        if (rng() < 0.95) certs.push(c);
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

    // 6 task types per day, mix of cert-required and cert-free, all L0
    // (so the only differentiator is cert presence).
    const tasks = [];
    for (let day = 1; day <= PERIOD_DAYS; day++) {
      // Task A: L0 + NitzanU (Tier 2 in today's formula; should be Tier ~4 with D1)
      tasks.push(
        makeTask({
          name: `T-A-d${day}`,
          sourceName: 'TaskA',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 6,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['NitzanU'] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['NitzanU'] }),
          ],
        }),
      );
      // Task B: L0 + HamamaU (same — universal cert)
      tasks.push(
        makeTask({
          name: `T-B-d${day}`,
          sourceName: 'TaskB',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 11,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['HamamaU'] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['HamamaU'] }),
          ],
        }),
      );
      // Task C: L0-only no cert (Tier 4 in today's formula)
      tasks.push(
        makeTask({
          name: `T-C-d${day}`,
          sourceName: 'TaskC',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 15,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
            makeSlot({ acceptableLevels: [{ level: Level.L0 }] }),
          ],
        }),
      );
      // Task D: L0 + HoreshU (universal)
      tasks.push(
        makeTask({
          name: `T-D-d${day}`,
          sourceName: 'TaskD',
          baseDate: DEFAULT_BASE_DATE,
          dayIndex: day,
          startHour: 19,
          durationHours: 4,
          slots: [
            makeSlot({ acceptableLevels: [{ level: Level.L0 }], requiredCertifications: ['HoreshU'] }),
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
