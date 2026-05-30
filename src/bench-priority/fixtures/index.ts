/**
 * Fixture registry. The runner iterates this in order; the report uses
 * the same order for fixture columns.
 *
 * To add a fixture: create the generator file under `fixtures/`, import
 * it here, and append to ALL_FIXTURES.
 */

import type { FixtureSpec } from '../types';
import { ADJACENCY_DENSE_FIXTURE } from './fixture-adjacency-dense';
import { AVAILABILITY_TIGHT_FIXTURE } from './fixture-availability-tight';
import { DEFAULT_FIXTURE } from './fixture-default';
import { DEMAND_TIGHT_FIXTURE } from './fixture-demand-tight';
import { JUNIOR_HEAVY_FIXTURE } from './fixture-junior-heavy';
import { RARE_EVERYWHERE_FIXTURE } from './fixture-rare-everywhere';
import { REST_RULE_DENSE_FIXTURE } from './fixture-restRule-dense';
import { SAME_GROUP_HEAVY_FIXTURE } from './fixture-sameGroup-heavy';
import { SENIOR_HEAVY_FIXTURE } from './fixture-senior-heavy';
import { UNIVERSAL_CERT_FIXTURE } from './fixture-universal-cert';

export const ALL_FIXTURES: readonly FixtureSpec[] = [
  // Order: control first, then by targeting-phase (Phase 2 D1/D3/D1+D3, then Phase 3 D4, then future).
  DEFAULT_FIXTURE,
  UNIVERSAL_CERT_FIXTURE,
  RARE_EVERYWHERE_FIXTURE,
  SENIOR_HEAVY_FIXTURE,
  JUNIOR_HEAVY_FIXTURE,
  DEMAND_TIGHT_FIXTURE,
  ADJACENCY_DENSE_FIXTURE,
  REST_RULE_DENSE_FIXTURE,
  SAME_GROUP_HEAVY_FIXTURE,
  AVAILABILITY_TIGHT_FIXTURE,
];

export function getFixture(id: string): FixtureSpec | undefined {
  return ALL_FIXTURES.find((f) => f.id === id);
}
