# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Garden Manager is a constraint-based scheduling system for garden teams. It generates weekly schedules for participants, respecting hard constraints (eligibility, certification, availability) and optimizing soft constraints (rest fairness, workload balance). The UI is in Hebrew.

**Task types are fully data-driven.** They are defined as `TaskTemplate` objects in the config store (`src/web/config-store.ts`), not hardcoded in the engine or constraints. Users create/edit/delete task types through the UI ("חוקי משימות" tab). The engine, optimizer, and constraint system operate on generic `Task`/`SlotRequirement` interfaces — they never branch on task name or type. Do not add new hardcoded task types in code; all task configuration flows through templates. The legacy factory functions in `src/tasks/task-definitions.ts` are only used by Node CLI scripts (`src/index.ts`, priority analysis), not by the web app.

## Build & Run Commands

```bash
npm run dev              # Vite dev server with HMR (http://localhost:5173)
npm run build:web        # Build web bundle → dist-web/
npm run build:node       # Compile Node backend (tsc) → dist/
npm run test             # Run test suite (ts-node src/test.ts)
npm run start            # Run Node CLI entry point
npm run demo             # Run demo with sample data
npm run electron:dev     # Dev mode: Vite + Electron concurrently
npm run electron:build   # Production: Vite + tsc + electron-builder (Windows NSIS)
```

There is no external test framework — unit tests use a custom `assert()` function in `src/test.ts` with console pass/fail output. No linter or formatter is configured.

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
  ├── Tab views: participants, task-rules, schedule-grid, algorithm, profile
  ├── Config persistence: config-store.ts (localStorage singleton)
  └── PDF export, snapshot versioning, rescue planning UI
        │
Scheduling Engine (src/engine/)
  ├── scheduler.ts     — SchedulingEngine class (two-stage: data setup → optimization)
  ├── optimizer.ts     — Greedy construction + simulated annealing local search
  ├── validator.ts     — Real-time hard+soft constraint checking
  ├── temporal.ts      — Live mode: "point of no return" freezes past assignments
  └── rescue.ts        — Minimum-disruption replanning (depth 1→2→3 swap chains)
        │
Constraints (src/constraints/)
  ├── hard-constraints.ts  — HC-1 through HC-13 (must pass or schedule is invalid)
  ├── soft-constraints.ts  — SC-1 through SC-7 (penalties guiding optimization)
  └── senior-policy.ts     — HC-13: L2/L3/L4 natural role isolation
        │
Foundation
  ├── models/types.ts          — All enums, interfaces, type aliases (TaskTemplate, SlotTemplate, etc.)
  ├── tasks/task-definitions.ts — Legacy factory functions (Node CLI only, not used by web app)
  ├── utils/                    — Capacity computation, date utilities
  └── ui/gantt-bridge.ts       — Schedule → Gantt data conversion
```

### Key Design Rules

- **No hardcoded task types.** The engine and constraints must never reference specific task names (Adanit, Hamama, etc.). All task behavior is driven by template properties: `sameGroupRequired`, `blocksConsecutive`, `isLight`, `requiresCategoryBreak`, slot `acceptableLevels`, `requiredCertifications`, `forbiddenCertifications`, `subTeamRole`, etc. Comments may mention task names as examples, but code must not branch on them.
- **Task instantiation path (web):** `generateTasksFromTemplates()` in `app.ts` iterates `getAllTaskTemplates()`, builds shifts from `shiftsPerDay`/`durationHours`/`startHour`, and converts `SlotTemplate` → `SlotRequirement`. One-time tasks (`OneTimeTask`) are also supported for non-recurring events.

### Key Domain Concepts

- **Levels:** L0 (junior), L2, L3, L4 (senior). No L1 exists.
- **Certifications:** Nitzan, Salsala, Hamama, Horesh — gate eligibility for specific task types (configured per slot, not per task type).
- **Hard constraints** (HC-1 to HC-13): Binary pass/fail. Violations make a schedule invalid.
- **Soft constraints** (SC-1 to SC-7): Numeric penalties. The optimizer minimizes total penalty.
- **Senior policy (HC-13):** Seniors have "natural roles" by domain. L4 can be used as last resort with max penalty (`preferJuniors` exception).
- **Optimizer:** Two-phase — greedy assignment followed by swap-based local search with simulated annealing. Multi-attempt runs pick the best result.
- **Temporal (live mode):** A time anchor divides the schedule into frozen past and modifiable future.
- **Rescue planning:** When a slot is vacated, enumerates single-swap, then 2-swap, then 3-swap chain alternatives scored by workload impact.
- **Split-pool fairness:** L0 and seniors are balanced independently via Gini coefficient on rest distribution.

### Web UI Structure

`src/web/app.ts` is the main UI orchestrator (~3000 lines). It manages a tabbed interface with day navigation (days 1-7), schedule grid rendering, manual drag-drop swaps, live mode controls, and triggers full 7-day re-validation after every change. State is persisted in localStorage via `src/web/config-store.ts`.

Debug helpers available in browser console: `toggleSchedulerDiag()`, `gardenWisdom()`.
