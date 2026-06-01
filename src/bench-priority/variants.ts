/**
 * Variant registry for the priority-ordering benchmark.
 *
 * Two variants — `baseline` (legacy tiered formula, pre-D1+D3) and
 * `D1+D3` (current production default). The bench acts as a permanent
 * regression gate so future ordering changes are validated rather than
 * asserted.
 *
 * To add a new variant, append to ALL_VARIANTS.
 *
 * Variant cleanup contract: every `install` returns a cleanup function
 * that MUST restore the optimizer to the production-default ordering
 * formula. That default is D1+D3 as of 2026-05-30, so both variants'
 * cleanups call `_benchSetEnhancedRarity(true)`. Keeping the variants
 * symmetric here (rather than implicitly relying on the file-level
 * default) makes the flag's production state obvious at the bench-call
 * site and prevents post-bench state drift.
 *
 * Note: an earlier Phase 3 (D4) `continuous` model + auto-tuner were
 * implemented and evaluated end-to-end; see
 * [tmp/priority-bench-phase3-report.md](../../tmp/priority-bench-phase3-report.md)
 * and the tuner output for the historical record. The D4 path was
 * removed after both default and tuned coefficients failed Phase 3
 * acceptance criteria — D4 marginally beat its anchor on
 * fixture-default but couldn't match D1+D3 even with proper calibration,
 * and 6 of 10 fixtures were SA-converged regardless of ordering.
 */

import { _benchSetEnhancedRarity } from '../engine/optimizer';
import type { VariantSpec } from './types';

/**
 * Baseline — legacy tiered formula (pre-D1+D3). Kept as a regression
 * reference so future ordering changes can compare against both the
 * current production formula AND the original pre-Phase-2 baseline.
 */
export const BASELINE_VARIANT: VariantSpec = {
  id: 'baseline',
  description: 'Legacy tiered formula (tier × 10 + sub), pre-D1+D3. Reference for paired-Δ comparisons.',
  install: (_settings) => {
    _benchSetEnhancedRarity(false);
    return () => {
      // Restore production default — D1+D3 since 2026-05-30.
      _benchSetEnhancedRarity(true);
    };
  },
};

/**
 * D1+D3 — production default ordering formula since 2026-05-30.
 *
 * D1 changes two things:
 *   1. S2 trigger reads `effectiveCertImpactPerTask` (rarity of certs
 *      against the pool the slot can actually draw from) instead of
 *      pool-wide `certRarity`. Threshold: `D1_CERT_IMPACT_THRESHOLD`
 *      (0.5).
 *   2. Symmetric vacuous-cert relief: when impact < D1_LOW_IMPACT_THRESHOLD
 *      (0.1), `hasCerts` / `hasExclusion` are treated as false in the base
 *      tier classifier. Without this, universal-cert L0 tasks stay stuck
 *      in Tier 2 even though the cert removes no one. This is what flips
 *      P-universal-cert-tier.
 *
 * D3 replaces the [0,9] subMin clamp with a log-scale on pool fraction
 * (cleanPool / nonLowPrioLevelEligible). Tight pool → low subMin (early
 * sort); wide pool → high subMin (late sort). Same direction as the
 * legacy clamp, but discriminates pools above size 9 (which the clamp
 * collapsed).
 *
 * Bench install/cleanup are explicit (not no-ops) for symmetry with
 * BASELINE_VARIANT — the explicit `true` documents the production state.
 */
export const D1_D3_VARIANT: VariantSpec = {
  id: 'D1+D3',
  description: 'D1 (lowPriority-aware effective cert impact + vacuous-cert relief) + D3 (log-scale sub-priority on pool fraction). Production default.',
  install: (_settings) => {
    _benchSetEnhancedRarity(true);
    return () => {
      _benchSetEnhancedRarity(true);
    };
  },
};

/**
 * Public registry. The runner iterates this in order; report columns appear
 * in the same order. Baseline first so paired-Δ reads "variant vs baseline."
 */
export const ALL_VARIANTS: readonly VariantSpec[] = [BASELINE_VARIANT, D1_D3_VARIANT];

export function getVariant(id: string): VariantSpec | undefined {
  return ALL_VARIANTS.find((v) => v.id === id);
}
