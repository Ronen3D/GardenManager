# Priority-ordering bench

Empirical bench infrastructure for validating changes to the scheduler's
initial task-ordering phase. Ships with two variants — `baseline`
(legacy tiered formula) and `D1+D3` (the shipped Phase 2 change:
lowPriority-aware effective cert impact + log-scale sub-priority).

Phase 3 (D4 continuous priority) was implemented and evaluated end-to-end
with both default and auto-tuner-calibrated coefficients; both failed
acceptance and the D4 code path was removed. The 6 fixtures originally
built to stress D4 mechanisms remain in the bench as regression
sentinels for any future ordering change that re-targets them.

See the full plan and bench history in the design notes referenced by the
git history for this directory.

## What this measures

For each `(fixture, variant, seed)` triple, the bench runs
`optimizeMultiAttempt` (wrapped in `withSeededRandom(seed, ...)` for paired
comparison) and records:

- composite score (final, post-greedy/postSA/final phase scores)
- unfilled slot count
- independent HC violation count (via `fullValidate`)
- greedy fill rate (pre-SA)
- attempt-of-best (which multi-attempt iteration produced the best schedule)
- per-phase runtime

Anchors run per-variant (not per-seed) and pin specific ordering relations.

## Structure

```
src/bench-priority/
├── types.ts              — FixtureSpec, AnchorSpec, VariantSpec interfaces
├── variants.ts           — Variant registry (Phase 1: only `baseline`)
├── fixtures/
│   ├── shared.ts         — fixture-builder helpers (deterministic RNG, builders)
│   ├── fixture-default.ts          — replays config-store seeds (control)
│   ├── fixture-universal-cert.ts   — D1 target
│   ├── fixture-rare-everywhere.ts  — D3 target
│   ├── fixture-senior-heavy.ts     — D4 target (unfixed; regression sentinel)
│   ├── fixture-junior-heavy.ts     — D4 target (unfixed; regression sentinel)
│   ├── fixture-demand-tight.ts     — D4 target (unfixed; regression sentinel)
│   ├── fixture-adjacency-dense.ts  — D4 target (unfixed; regression sentinel)
│   ├── fixture-restRule-dense.ts   — D4 target (unfixed; regression sentinel)
│   ├── fixture-sameGroup-heavy.ts  — D4 target (unfixed; regression sentinel)
│   ├── fixture-availability-tight.ts — future phase (HC-3-aware T1)
│   └── index.ts          — fixture registry
├── anchors/
│   ├── shared.ts         — anchor helpers (priorityOf, ctxFor, tinyL0Pool, ...)
│   ├── invariants.ts     — 5 invariant anchors (baseline must pass)
│   ├── pathologies.ts    — 5 pathology anchors (baseline expected to fail)
│   └── index.ts          — anchor registry
├── runner.ts             — bench runner (entry point)
├── report.ts             — Markdown report generator
└── README.md
```

## Invocation

Full bench (defaults: 60 seeds × 30 attempts):

```
npm run bench:priority
```

Tunable via env vars:

| Variable | Default | Purpose |
|---|---|---|
| `BENCH_SEED_COUNT` | 60 | Seeds per fixture |
| `BENCH_ATTEMPTS` | 30 | `optimizeMultiAttempt` attempts per run |
| `BENCH_BASE_SEED` | 1000 | Starting seed |
| `BENCH_PROGRESS` | false | Per-run progress logging |
| `BENCH_FIXTURES` | (all) | Comma-separated fixture ids to include |
| `BENCH_VARIANTS` | (all) | Comma-separated variant ids to include |
| `BENCH_OUTPUT` | `tmp/priority-bench-results.json` | JSON output path |
| `BENCH_REPORT` | `tmp/priority-bench-report.md` | Markdown report path |

Bash:

```bash
BENCH_SEED_COUNT=10 BENCH_ATTEMPTS=15 BENCH_PROGRESS=true npm run bench:priority
```

PowerShell:

```powershell
$env:BENCH_SEED_COUNT=10; $env:BENCH_ATTEMPTS=15; $env:BENCH_PROGRESS='true'; npm run bench:priority
```

Smoke test (fast):

```bash
BENCH_SEED_COUNT=2 BENCH_ATTEMPTS=4 BENCH_PROGRESS=true BENCH_FIXTURES=fixture-default npm run bench:priority
```

## Acceptance criteria (Phase 1)

The bench passes Phase 1 acceptance when:

1. **`baseline` on `fixture-default` reproduces today's behavior** within
   statistical noise (mean composite Δ within ±0.5% across runs).
2. **All 5 invariant anchors pass for `baseline`.**
3. **All 5 pathology anchors fail for `baseline` in the specific ways
   named in `pathologies.ts`.** An unexpectedly-passing pathology anchor
   for baseline is itself a bench bug — investigate.
4. **Zero HC violations matrix-wide** (independent `fullValidate` of
   every run's final assignments).
5. **Bench runs to completion under 24 hours** at default settings.

## Adding a variant (Phase 2+)

1. Create the variant spec in `variants.ts`. The `install` callback may:
   - Flip module-level dispatch flags exported by `src/engine/optimizer.ts`
     (the D1+D3 path uses `_benchSetEnhancedRarity`).
   - Return a cleanup function that restores original state.
2. Append the variant to `ALL_VARIANTS`.
3. For each pathology anchor the new variant should resolve, update its
   `expectedOutcome` map to declare `'pass'` for that variant id.
4. Re-run the bench; the report's "Paired-Δ vs baseline" table and
   anchor results will show the variant's impact.

## Adding a fixture

1. Create `fixture-X.ts` in `fixtures/`. Export a `FixtureSpec` whose
   `generate(seed)` returns a `FixtureInstance`. Must be deterministic.
2. Append to `ALL_FIXTURES` in `fixtures/index.ts` — order matters for
   report column order.
3. Tag with `targetingPhase` so the runner can apply the right
   per-phase acceptance criteria.

## Adding an anchor

Anchors observe pure formula behavior — they should NOT run the full
optimizer pipeline (one exception: `I-deterministic-under-seed` needs
multi-attempt to verify the seeded-RNG contract).

1. Create the anchor spec in `anchors/invariants.ts` (must-pass) or
   `anchors/pathologies.ts` (named pathology, baseline-fails).
2. The anchor's `evaluate()` returns an `AnchorResult` with structured
   `observations` so the report can show the quantitative observation
   (priority values, gap, index, etc.).
3. Append to the relevant `ALL_*_ANCHORS` array.
4. Set `expectedOutcome` per known variant. The bench runner asserts the
   observed outcome matches; mismatches are reported with a ⚠ flag.
