import type { AlgorithmSettings, SchedulerConfig } from '../models/types';

/**
 * Returns the SchedulerConfig the engine should actually use for scoring,
 * given the user's stored config and the active `splittingMode`. In
 * `feasibility` mode the engine treats split cost as zero everywhere
 * (SA scorer, structuralRefine's gates, multi-attempt selection, and any
 * `computeScheduleScore` call) — feasibility splits exist out of
 * necessity, not as a quality cost. In `quality` and `off` modes the
 * user's `config.splitPenalty` is honored as-is.
 *
 * The user's stored `config.splitPenalty` is preserved in the input
 * `config` object so switching back to quality restores their value.
 */
export function getEffectiveConfig(
  config: SchedulerConfig,
  splittingMode: AlgorithmSettings['splittingMode'],
): SchedulerConfig {
  if (splittingMode === 'feasibility') {
    return { ...config, splitPenalty: 0 };
  }
  return config;
}
