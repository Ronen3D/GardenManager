# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Garden Manager is a constraint-based scheduling system for garden teams. It generates weekly schedules for participants, respecting hard constraints (eligibility, certification, availability) and optimizing soft constraints (rest fairness, workload balance). The UI is in Hebrew.

**Task types are fully data-driven.** They are defined as `TaskTemplate` objects in the config store (`src/web/config-store.ts`), not hardcoded in the engine or constraints. Users create/edit/delete task types through the UI ("חוקי משימות" tab). The engine, optimizer, and constraint system operate on generic `Task`/`SlotRequirement` interfaces — they never branch on task name or type. Do not add new hardcoded task types in code; all task configuration flows through templates. The factory functions in `src/tasks/cli-task-factory.ts` are only used by Node CLI scripts (demo, priority analysis), not by the web app.

## Build & Run Commands

```bash
npm run dev              # Vite dev server with HMR (http://localhost:5174)
npm run build:web        # Build web bundle → dist-web/
npm run build:node       # Compile Node backend (tsc) → dist/
npm run test             # Run test suite (ts-node src/test.ts)
npm run start            # Run Node CLI entry point
npm run demo             # Run demo with sample data
npm run electron:dev     # Dev mode: Vite + Electron concurrently
npm run electron:build   # Production: Vite + tsc + electron-builder (Windows NSIS)
```

There is no external test framework — unit tests use a custom `assert()` function in `src/test.ts` with console pass/fail output.

### Linting & Formatting (Biome)

```bash
npm run lint             # Check for lint issues and formatting
npm run lint:fix         # Auto-fix safe lint issues
npm run format           # Format all files
npm run format:check     # Check formatting without writing
```

Biome handles both linting and formatting via `biome.json`. Most lint violations are set to `warn` (non-blocking). Run `npm run lint:fix` before committing.

### E2E Tests (Playwright)

```bash
npm run test:e2e              # All viewports
npm run test:e2e:desktop      # Desktop only (1280×800)
npm run test:e2e:phone        # Phone only (375×812)
npx playwright test --project=tablet   # Tablet (768×1024)
npx playwright test tests/navigation.spec.ts  # Single spec file
```

E2E specs are in `tests/` and cover desktop regression, navigation, mobile schedule/modals, and touch interactions. The dev server must be running (`npm run dev`) before E2E tests.

## Dual-Build Architecture

The project compiles to three targets via separate tsconfig files:

| Target | Config | Entry | Output | Module |
|--------|--------|-------|--------|--------|
| Node/CLI | `tsconfig.json` | `src/` (excludes `src/web/`) | `dist/` | CommonJS |
| Web (Vite) | `tsconfig.web.json` | `src/web/` + shared engine | `dist-web/` | ESNext (`noEmit`, Vite handles bundling) |
| Electron | `tsconfig.electron.json` | `electron/` | `dist-electron/` | CommonJS |

The web build uses Vite with path alias `@/` mapping to `src/`. All configs use `strict: true` and target ES2020.

## Architecture

```
Web UI (src/web/app.ts)
  ├── Tab views: participants, task-rules, schedule, algorithm (+ profile overlay)
  ├── Config persistence: config-store.ts (localStorage singleton)
  ├── PDF export, snapshot versioning
  ├── schedule-utils.ts  — Pure helpers: date formatting, day windows, status badges, violation labels
  ├── tooltips.ts        — Participant & task tooltip UI (hover/touch, callback injection)
  └── rescue-modal.ts    — Rescue planning modal (swap-chain UI, callback injection)
        │
Scheduling Engine (src/engine/)
  ├── scheduler.ts     — SchedulingEngine class (two-stage: data setup → optimization)
  ├── optimizer.ts     — Greedy construction + simulated annealing local search
  ├── validator.ts     — Real-time hard+soft constraint checking
  ├── temporal.ts      — Live mode: "point of no return" freezes past assignments
  └── rescue.ts        — Minimum-disruption replanning (depth 1→2→3 swap chains)
        │
Constraints (src/constraints/)
  ├── hard-constraints.ts  — HC-1..HC-8, HC-11, HC-12, HC-14 (must pass or schedule is invalid)
  ├── soft-constraints.ts  — SC-3, SC-6..SC-10 (penalties guiding optimization)
  └── senior-policy.ts     — Senior soft penalty (lowPriority last-resort) + isNaturalRole classification
        │
Foundation
  ├── models/types.ts          — All enums, interfaces, type aliases (TaskTemplate, SlotTemplate, etc.)
  ├── tasks/cli-task-factory.ts  — Task factories for CLI scripts (demo, priority analysis)
  ├── utils/                    — Capacity computation, date utilities
  └── ui/gantt-bridge.ts       — Schedule → Gantt data conversion
```

### Key Design Rules

- **No hardcoded task types.** The engine and constraints must never reference specific task names (Adanit, Hamama, etc.). All task behavior is driven by template properties: `sameGroupRequired`, `blocksConsecutive`, `isLight`, `restRuleId`, slot `acceptableLevels`, `requiredCertifications`, `forbiddenCertifications`, `subTeamId`, etc. Comments may mention task names as examples, but code must not branch on them.
- **Task instantiation path (web):** `generateTasksFromTemplates()` in `app.ts` iterates `getAllTaskTemplates()`, builds shifts from `shiftsPerDay`/`durationHours`/`startHour`, and converts `SlotTemplate` → `SlotRequirement`. One-time tasks (`OneTimeTask`) are also supported for non-recurring events.
- **Operational day boundary.** A "day" in the system runs from a configurable hour (default 05:00) to the same hour the next calendar day. The boundary is stored in `AlgorithmSettings.dayStartHour` and accessed via `store.getDayStartHour()`. When grouping tasks or timestamps by day in the engine layer, always use `operationalDateKey()` from `date-utils.ts` — never `calendarDateKey()`, which uses midnight boundaries. `calendarDateKey()` exists only for calendar-date formatting in UI/export contexts.

### Key Domain Concepts

- **Levels:** L0 (junior), L2, L3, L4 (senior). No L1 exists.
- **Certifications:** Nitzan, Salsala, Hamama, Horesh — gate eligibility for specific task types (configured per slot, not per task type).
- **Hard constraints** (HC-1..HC-8, HC-11, HC-12, HC-14): Binary pass/fail. Violations make a schedule invalid. HC-1 is the sole level gate for all participants. Note: HC-9, HC-10, HC-13 do not exist (removed or never created).
- **Soft constraints** (SC-3, SC-6..SC-10): Numeric penalties. The optimizer minimizes total penalty. SC-7 is a warning-only safety net. SC-1, SC-2, SC-4, SC-5 do not exist.
- **Senior policy:** Seniors have "natural roles" determined by `isNaturalRole()`. Slots can mark a senior level as `lowPriority` (last-resort) — the soft penalty `lowPriorityLevelPenalty` heavily discourages these placements. Hard level-gating is handled by HC-1.
- **Optimizer:** Two-phase — greedy assignment followed by swap-based local search with simulated annealing. Multi-attempt runs pick the best result.
- **Temporal (live mode):** A time anchor divides the schedule into frozen past and modifiable future.
- **Rescue planning:** When a slot is vacated, enumerates single-swap, then 2-swap, then 3-swap chain alternatives scored by workload impact.
- **Split-pool fairness:** L0 and seniors are balanced independently via Gini coefficient on rest distribution.

### Web UI Structure

`src/web/app.ts` is the main UI orchestrator (~3900 lines). It manages a tabbed interface (participants, task-rules, schedule, algorithm) with day navigation (days 1-7), schedule grid rendering, manual drag-drop swaps, live mode controls, and triggers full 7-day re-validation after every change. A profile view is rendered as a separate overlay, not as a tab. State is persisted in localStorage via `src/web/config-store.ts`.

Extracted modules use **callback injection** to avoid circular imports back to `app.ts`:
- `tooltips.ts` receives action callbacks (`onSwap`, `onLock`, `onRescue`, `onNavigateToProfile`) via `initTooltips()` and a `() => Schedule | null` getter for live schedule access.
- `rescue-modal.ts` receives engine/schedule getters and result callbacks via `initRescue()`.
- `schedule-utils.ts` is pure — reads only from the `store` singleton, no app-level state.

Debug helpers available in browser console: `toggleSchedulerDiag()`, `gardenWisdom()`.
