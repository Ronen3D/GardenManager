/**
 * Anchor registry.
 *
 * Anchors are tagged by group:
 *  - 'invariant' — every variant MUST pass.
 *  - 'pathology' — baseline expected to fail; later phases' variants
 *    expected to pass (per their expectedOutcome map).
 *
 * The bench runner iterates `ALL_ANCHORS` in this order. Invariants come
 * first for readability in the report.
 */

import type { AnchorSpec } from '../types';
import { ALL_INVARIANT_ANCHORS } from './invariants';
import { ALL_PATHOLOGY_ANCHORS } from './pathologies';

export const ALL_ANCHORS: readonly AnchorSpec[] = [...ALL_INVARIANT_ANCHORS, ...ALL_PATHOLOGY_ANCHORS];

export function getAnchor(id: string): AnchorSpec | undefined {
  return ALL_ANCHORS.find((a) => a.id === id);
}

export { ALL_INVARIANT_ANCHORS, ALL_PATHOLOGY_ANCHORS };
