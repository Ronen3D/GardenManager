# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Garden Manager is a constraint-based scheduling system for garden teams. It generates weekly schedules for participants, respecting hard constraints (eligibility, certification, availability) and optimizing soft constraints (rest fairness, workload balance). The UI is in Hebrew.

**Task types are fully data-driven.** They are defined as `TaskTemplate` objects in the config store (`src/web/config-store.ts`), not hardcoded in the engine or constraints. Users create/edit/delete task types through the UI ("חוקי משימות" tab). The engine, optimizer, and constraint system operate on generic `Task`/`SlotRequirement` interfaces — they never branch on task name or type. Do not add new hardcoded task types in code; all task configuration flows through templates. The factory functions in `src/tasks/cli-task-factory.ts` are only used by Node CLI scripts (demo, priority analysis), not by the web app.

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
  ├── hard-constraints.ts  — HC-1 through HC-14 (must pass or schedule is invalid)
  ├── soft-constraints.ts  — SC-1 through SC-7 (penalties guiding optimization)
  └── senior-policy.ts     — Senior soft penalty (lowPriority last-resort) + isNaturalRole classification
        │
Foundation
  ├── models/types.ts          — All enums, interfaces, type aliases (TaskTemplate, SlotTemplate, etc.)
  ├── tasks/cli-task-factory.ts  — Task factories for CLI scripts (demo, priority analysis)
  ├── utils/                    — Capacity computation, date utilities
  └── ui/gantt-bridge.ts       — Schedule → Gantt data conversion
```

### Key Design Rules

- **No hardcoded task types.** The engine and constraints must never reference specific task names (Adanit, Hamama, etc.). All task behavior is driven by template properties: `sameGroupRequired`, `blocksConsecutive`, `isLight`, `requiresCategoryBreak`, slot `acceptableLevels`, `requiredCertifications`, `forbiddenCertifications`, `subTeamId`, etc. Comments may mention task names as examples, but code must not branch on them.
- **Task instantiation path (web):** `generateTasksFromTemplates()` in `app.ts` iterates `getAllTaskTemplates()`, builds shifts from `shiftsPerDay`/`durationHours`/`startHour`, and converts `SlotTemplate` → `SlotRequirement`. One-time tasks (`OneTimeTask`) are also supported for non-recurring events.
- **Operational day boundary.** A "day" in the system runs from a configurable hour (default 05:00) to the same hour the next calendar day. The boundary is stored in `AlgorithmSettings.dayStartHour` and accessed via `store.getDayStartHour()`. When grouping tasks or timestamps by day in the engine layer, always use `operationalDateKey()` from `date-utils.ts` — never `calendarDateKey()`, which uses midnight boundaries. `calendarDateKey()` exists only for calendar-date formatting in UI/export contexts.

### Key Domain Concepts

- **Levels:** L0 (junior), L2, L3, L4 (senior). No L1 exists.
- **Certifications:** Nitzan, Salsala, Hamama, Horesh — gate eligibility for specific task types (configured per slot, not per task type).
- **Hard constraints** (HC-1 to HC-14): Binary pass/fail. Violations make a schedule invalid. HC-1 is the sole level gate for all participants.
- **Soft constraints** (SC-1 to SC-7): Numeric penalties. The optimizer minimizes total penalty.
- **Senior policy:** Seniors have "natural roles" determined by `isNaturalRole()`. Slots can mark a senior level as `lowPriority` (last-resort) — the soft penalty `lowPriorityLevelPenalty` heavily discourages these placements. Hard level-gating is handled by HC-1.
- **Optimizer:** Two-phase — greedy assignment followed by swap-based local search with simulated annealing. Multi-attempt runs pick the best result.
- **Temporal (live mode):** A time anchor divides the schedule into frozen past and modifiable future.
- **Rescue planning:** When a slot is vacated, enumerates single-swap, then 2-swap, then 3-swap chain alternatives scored by workload impact.
- **Split-pool fairness:** L0 and seniors are balanced independently via Gini coefficient on rest distribution.

### Web UI Structure

`src/web/app.ts` is the main UI orchestrator (~3000 lines). It manages a tabbed interface with day navigation (days 1-7), schedule grid rendering, manual drag-drop swaps, live mode controls, and triggers full 7-day re-validation after every change. State is persisted in localStorage via `src/web/config-store.ts`.

Debug helpers available in browser console: `toggleSchedulerDiag()`, `gardenWisdom()`.

## Security & Code Standards

These rules apply to every code change — human or AI-generated. Review all generated code before accepting it.

### Never Commit Secrets

- **No API keys, tokens, passwords, or credentials in source code.** Not in TypeScript, not in HTML, not in comments.
- `.env*` files are gitignored. If external services are ever added, use environment variables and document required keys in a `.env.example` (values blank).
- Before committing, scan your diff for anything that looks like a secret. If a secret is accidentally committed, rotate it immediately — git history is permanent.

### XSS Prevention

- **All user-supplied text must be escaped before insertion into the DOM.** Use `escHtml()` for element content and `escAttr()` for attribute values (both in `src/web/ui-helpers.ts`).
- Never use `innerHTML` with raw user input. When building HTML from template literals, every dynamic value from user data (participant names, task labels, notes, imported JSON fields) must pass through `escHtml()`/`escAttr()`.
- Do not use `eval()`, `Function()`, or `document.write()`.
- When adding new UI that renders user-configurable data, verify escaping in both the initial render and any update/re-render paths.

### localStorage Data Integrity

- All data deserialized from localStorage must be validated before use. Corrupt or tampered localStorage should not crash the app.
- Wrap `JSON.parse()` calls in try-catch and fall back to defaults on failure (the existing `config-store.ts` pattern).
- When adding new persisted fields, add type/range validation in the load path — do not trust that the stored shape matches the current interface.

### Error Handling

- **Never swallow errors silently.** Every `catch` block must either:
  1. Log the error with context (`console.error('contextDescription:', err)`), or
  2. Re-throw / propagate to a handler that does.
- User-facing errors must produce a visible UI indication (alert, status message, highlighted field) — not just a console log.
- In the scheduling engine, constraint violations must surface through the validation system, never be silently ignored.

### Input Validation

- Validate all external input at system boundaries: file imports (JSON/CSV), URL parameters, clipboard paste, drag-drop data.
- For file imports, validate JSON structure and types before merging into app state. Use the existing `ContinuityImportOptions.validate()` pattern.
- Sanitize file names in export paths (the existing `data-transfer.ts` pattern: strip special characters).
- Numeric inputs from UI must be bounds-checked (e.g., `dayStartHour` 0–23, `shiftsPerDay` ≥ 1).

### Dependency Discipline

- This project has only 3 production dependencies. Keep it that way.
- Do not add a dependency for something achievable in <50 lines of code.
- When a dependency is truly needed, prefer well-maintained packages with minimal transitive dependencies.
- Run `npm audit` before adding new packages. Do not ship with known high/critical vulnerabilities.

### Code Quality Gates

- Every change must pass `npm run build:web` (type-checking + bundle) before it is considered complete.
- Run `npm run test` to verify engine logic after any change to `src/engine/`, `src/constraints/`, or `src/models/`.
- Run `npm run test:e2e:desktop` after UI changes to catch visual regressions.
- TypeScript `strict: true` is non-negotiable. Do not add `@ts-ignore`, `any` casts, or loosen compiler options to make code compile.

### Electron / Desktop Security

- Electron's `nodeIntegration` and `contextIsolation` settings in `electron/main.ts` must not be relaxed. If new IPC channels are needed, use the preload script pattern.
- Never load remote URLs in the Electron shell. The app must only serve local bundled content.

### What "Done" Means

A change is not done when the code compiles. It is done when:
1. It builds without errors (`build:web` + `build:node` if engine code touched).
2. Relevant tests pass (`test` for engine, `test:e2e` for UI).
3. The diff has been read for secrets, unescaped user input, and silent error swallowing.
4. New UI rendering paths use `escHtml()`/`escAttr()` for user data.
5. New localStorage fields have validation in their load path.
