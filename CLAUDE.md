# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Response Language

**All assistant responses to the user MUST be in English**, even when the user writes in Hebrew. This is a hard rule — do not mirror the user's input language. The project UI is Hebrew and code strings / UI copy stay in Hebrew, but conversational responses, explanations, summaries, commit messages drafted for user review, and `AskUserQuestion` prompts/options are English only. Only switch to Hebrew if the user explicitly asks for a Hebrew response in the current turn.

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
  ├── Tabs: participants, task-rules, schedule, algorithm (+ profile / task-panel overlays)
  ├── Config persistence: config-store.ts (localStorage singleton)
  ├── Tab renderers: tab-participants.ts, tab-task-rules.ts, tab-algorithm.ts, tab-profile.ts, tab-task-panel.ts
  ├── Modals: rescue-modal.ts, future-sos-modal.ts, inject-task-modal.ts, range-picker-modal.ts,
  │           load-formula-modal.ts, swap-picker.ts, ui-modal.ts
  ├── Helpers: schedule-utils.ts, tooltips.ts, workload-popup.ts, workload-utils.ts, preflight.ts, ui-helpers.ts
  └── PDF/XLSX export, snapshot versioning
        │
Scheduling Engine (src/engine/)
  ├── scheduler.ts         — SchedulingEngine class (two-stage: data setup → optimization)
  ├── optimizer.ts         — Greedy construction + simulated annealing local search
  ├── validator.ts         — Real-time hard+soft constraint checking
  ├── temporal.ts          — Live mode: "point of no return" freezes past assignments
  ├── rescue.ts            — Minimum-disruption replanning (depth 1→3, + depth-4 deep-chain fallback)
  ├── rescue-primitives.ts — Shared per-slot chain enumeration (used by rescue + future-sos)
  ├── future-sos.ts        — Multi-slot batch rescue when a participant goes unavailable for a window
  └── inject.ts            — BALTAM: post-generation one-time task injection & staffing
        │
Constraints (src/constraints/)
  ├── hard-constraints.ts  — HC-1..HC-8, HC-11, HC-12, HC-14, HC-15 (must pass or schedule is invalid)
  ├── soft-constraints.ts  — SC-3, SC-6..SC-10 (penalties guiding optimization)
  ├── senior-policy.ts     — Senior soft penalty (lowPriority last-resort) + isNaturalRole classification
  └── sleep-recovery.ts    — HC-15 helpers: per-task recovery-window check
        │
Foundation
  ├── models/types.ts            — All enums, interfaces, type aliases (TaskTemplate, SlotTemplate,
  │                                ScheduleUnavailability, etc.)
  ├── shared/                    — Code usable by both Node/CLI and web builds
  │                                (utils/{time-utils,rest-calculator,load-formula,load-weighting},
  │                                 group-name-rules, participant-set-xlsx)
  ├── tasks/cli-task-factory.ts  — Task factories for CLI scripts (demo, priority analysis)
  ├── utils/                     — Capacity computation, date utilities
  └── ui/gantt-bridge.ts         — Schedule → Gantt data conversion
```

### Key Design Rules

- **No hardcoded task types.** The engine and constraints must never reference specific task names (Adanit, Hamama, etc.). All task behavior is driven by template properties: `sameGroupRequired`, `blocksConsecutive`, `isLight`, `restRuleId`, slot `acceptableLevels`, `requiredCertifications`, `forbiddenCertifications`, `subTeamId`, etc. Comments may mention task names as examples, but code must not branch on them.
- **Task instantiation path (web):** `generateTasksFromTemplates()` in `app.ts` iterates `getAllTaskTemplates()`, builds shifts from `shiftsPerDay`/`durationHours`/`startHour`, and converts `SlotTemplate` → `SlotRequirement`. One-time tasks (`OneTimeTask`) are also supported for non-recurring events.
- **Operational day boundary.** A "day" in the system runs from a configurable hour (default 05:00) to the same hour the next calendar day. The boundary is stored in `AlgorithmSettings.dayStartHour` and accessed via `store.getDayStartHour()`. When grouping tasks or timestamps by day in the engine layer, always use `operationalDateKey()` from `date-utils.ts` — never `calendarDateKey()`, which uses midnight boundaries. `calendarDateKey()` exists only for calendar-date formatting in UI/export contexts.
- **One day model.** Days are addressed system-wide by **schedule-relative index `1..periodDays`** (the operational day, anchored at `schedule.periodStart + dayStartHour`). There is **no dependency on calendar dates or weekdays** in UI, persistence, engine, or exports. Exceptions: (1) absolute timestamps on `Task.timeBlock`, `ScheduleUnavailability`, and the live-mode anchor are intrinsically calendar-based; (2) `Schedule.periodStart` is an internal calendar anchor used only to compose op-day windows; (3) HC-15's sleep-recovery trigger range is wall-clock (circadian, not schedule-structural). Hours in user input are 0..23 and mapped into an op-day via `hourInOpDay(baseDate, dayStartHour, dayIndex, hour)` from `shared/utils/time-utils.ts` — hours `< dayStartHour` fall on the post-midnight tail of the given op-day.
- **`DateUnavailability` addresses days by index.** The type is `{ dayIndex: 1..periodDays, endDayIndex?: 1..periodDays, startHour, endHour, allDay, reason? }`. Rules are recurring per schedule (apply at generation time to the current schedule window), not to a JS weekday. `isBlockedByDateUnavailability` in `shared/utils/time-utils.ts` is the single source of truth; `config-store.computeAvailability` and `app.ts findPreExistingUnavailabilityOverlaps` use the same `hourInOpDay` helper so UI preview and HC-3 validation agree.
- **`getDayWindow` anchor.** The canonical `getDayWindow` lives in `web/schedule-utils.ts` and reads `schedule.periodStart + dayStartHour`. `export-utils.getDayWindow` and `schedule-grid-view`'s day filter read the same frozen anchor — never `min(task.start)`. This keeps the displayed schedule, PDF, and Excel day grids in lock-step with the engine.
- **Frozen-snapshot schedules.** Once generated, a `Schedule` is a frozen snapshot. It embeds the values the engine and display layer need: `algorithmSettings` (config, disabledHardConstraints, dayStartHour), `restRuleSnapshot`, `certLabelSnapshot`, `periodStart` + `periodDays`, and `scheduleUnavailability` (Future-SOS windows scoped to this snapshot). Any edit outside the schedule screen (participants, templates, algorithm settings, cert labels) only sets `_scheduleDirty = true` and shows the dirty warning — it must **not** mutate the displayed schedule, the engine, or validation results. Schedule-screen code paths (render, rescue/SOS, manual swap, slot eligibility, tooltips, day grouping, violation filtering) must read frozen values from `schedule.algorithmSettings.*` / `engine.get*()`, never from `store.*`. The engine is the single source of truth post-generation; `store.*` is only consulted at generation time. Pre-schema saved schedules (missing frozen fields) are detected by `hasFrozenFields()` in `app.ts` and discarded at load — there is no migration.

### Key Domain Concepts

- **Levels:** L0 (junior), L2, L3, L4 (senior). No L1 exists.
- **Certifications:** Nitzan, Hamama, Horesh — gate eligibility for specific task types (configured per slot, not per task type). Defined in `DEFAULT_CERTIFICATION_DEFINITIONS` (`src/models/types.ts`) and user-editable at runtime.
- **Hard constraints** (HC-1..HC-8, HC-11, HC-12, HC-14, HC-15): Binary pass/fail. Violations make a schedule invalid. HC-1 is the sole level gate for all participants. HC-15 (sleep & recovery) enforces a per-task recovery window: if a task's end falls in a configured inclusive clock-hour range, the assigned participant cannot take any other loaded task during the following `recoveryHours` window. Every HC is gated by the `disabledHardConstraints` set frozen on the schedule. Note: HC-9, HC-10, HC-13 do not exist (removed or never created).
- **Soft constraints** (SC-3, SC-6..SC-10): Numeric penalties. The optimizer minimizes total penalty. SC-7 is a warning-only safety net. SC-1, SC-2, SC-4, SC-5 do not exist.
- **Senior policy:** Seniors have "natural roles" determined by `isNaturalRole()`. Slots can mark a senior level as `lowPriority` (last-resort) — the soft penalty `lowPriorityLevelPenalty` heavily discourages these placements. Hard level-gating is handled by HC-1.
- **Optimizer:** Two-phase — greedy assignment followed by swap-based local search with simulated annealing. Multi-attempt runs pick the best result.
- **Temporal (live mode):** A time anchor divides the schedule into frozen past and modifiable future.
- **Rescue planning:** When a slot is vacated, enumerates single-swap, then 2-swap, then 3-swap chain alternatives scored by composite-score delta. If depths 1–3 yield zero valid plans, a depth-4 deep-chain fallback runs and tags plans with `fallbackDepth = 4` so the UI can warn. Per-slot chain enumeration lives in `rescue-primitives.ts` and is shared with Future SOS.
- **Future SOS:** When a participant is marked unavailable for a future window (stored on the frozen `Schedule.scheduleUnavailability`, not on the live participant), Future SOS identifies every affected assignment and composes a single batch plan that fills all vacated slots together. Scored by full composite score, pruned by admissible bounds, bounded disruption (depth ≤ 3 per slot). HC-3 layers `scheduleUnavailability` on top of master-data availability during validation and rescue planning.
- **BALTAM injection:** Post-generation injection of a one-time task into an existing schedule (`src/engine/inject.ts`). Runs depth-1/2/3 chain search with per-group backtracking for `sameGroupRequired` tasks, gated by `assertInjectableTimeBlock` from temporal.ts. Injected tasks carry `injectedPostGeneration = true` so orphan detection in `app.ts` ignores them.
- **Split-pool fairness:** L0 and seniors are balanced independently via Gini coefficient on rest distribution.

### Web UI Structure

`src/web/app.ts` is the main UI orchestrator (~5200 lines). It manages a tabbed interface (participants, task-rules, schedule, algorithm) with day navigation over `schedule.periodDays` (configurable 1..7 via `store.getScheduleDays()`), schedule grid rendering, manual drag-drop swaps, live mode controls, and triggers full period-wide re-validation after every change. Profile and task-panel views are rendered as separate overlays (`_viewMode = 'PROFILE_VIEW' | 'TASK_PANEL_VIEW'`), not as tabs. State is persisted in localStorage via `src/web/config-store.ts`.

Most rendering logic is extracted into per-tab and per-modal modules; `app.ts` orchestrates lifecycle, navigation, engine calls, and state. Extracted modules use **callback injection** to avoid circular imports back to `app.ts`:
- **Tab renderers** (`tab-participants.ts`, `tab-task-rules.ts`, `tab-algorithm.ts`, `tab-profile.ts`, `tab-task-panel.ts`) expose `render*` + `wire*Events` pairs and receive context objects / getters from `app.ts`.
- **Modal modules** (`rescue-modal.ts`, `future-sos-modal.ts`, `inject-task-modal.ts`, `range-picker-modal.ts`, `load-formula-modal.ts`, `swap-picker.ts`) receive engine/schedule getters and result callbacks via their `init*` functions.
- `tooltips.ts` receives action callbacks (`onSwap`, `onRescue`, `onNavigateToProfile`) via `initTooltips()` and a `() => Schedule | null` getter for live schedule access.
- `schedule-utils.ts` is pure — reads only from the `store` singleton, no app-level state.
- `preflight.ts` runs real-time feasibility checks (skill gap, capacity, group integrity) before schedule generation.

Debug helpers available in browser console: `toggleSchedulerDiag()`, `gardenWisdom()`.
