# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Primary Platform: Mobile

**Mobile (phone) is the primary, dominant, and by far most common use case for this app.** Real users overwhelmingly run Garden Manager on a phone. Desktop is supported but secondary. This is a hard product rule and it shapes how every UI decision should be made:

- When designing, reviewing, or modifying any UI: assume a phone viewport (≈375×812) first. A change is "done" when it looks and works correctly on mobile; desktop is a follow-up check, not the starting point.
- When manually verifying UI changes via Playwright or the dev server, **default to the phone viewport** (`npm run test:e2e:phone`, or set viewport 375×812 in browser tooling). Only switch to desktop when desktop is the specific subject of the change.
- Trade-offs between mobile and desktop polish should resolve in favor of mobile. If a layout cannot be equally good on both, mobile wins.
- Touch interactions, thumb reach, small-screen density, and modal/sheet behavior on phones take precedence over equivalent desktop concerns.

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

**Default verification viewport is phone (375×812).** Per the "Primary Platform: Mobile" rule, ad-hoc manual verification of UI changes (via Playwright MCP or the dev server) should start on the phone viewport. Only verify on desktop when desktop is the specific subject of the change, or as a secondary regression check after mobile passes.

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
  ├── sleep-recovery.ts    — HC-15 helpers: per-task recovery-window check
  └── group-matching.ts    — Bipartite max-matching (Kuhn's algorithm) for same-group feasibility
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

- **No hardcoded task types.** The engine and constraints must never reference specific task names (Adanit, Hamama, etc.). All task behavior is driven by template properties: `sameGroupRequired`, `blocksConsecutive`, `baseLoadWeight`, `loadWindows`, `restRuleId`, `sleepRecovery`, slot `acceptableLevels`, `requiredCertifications`, `forbiddenCertifications`, `subTeamId`, etc. Comments may mention task names as examples, but code must not branch on them.
- **Task instantiation path (web):** `generateTasksFromTemplates()` in `app.ts` iterates `getAllTaskTemplates()`, builds shifts from `shiftsPerDay`/`durationHours`/`startHour`, and converts `SlotTemplate` → `SlotRequirement`. One-time tasks (`OneTimeTask`) are also supported for non-recurring events.
- **Operational day boundary.** A "day" in the system runs from a configurable hour (default 05:00) to the same hour the next calendar day. The boundary is stored in `AlgorithmSettings.dayStartHour` and accessed via `store.getDayStartHour()`. When grouping tasks or timestamps by day in the engine layer, always use `operationalDateKey()` from `date-utils.ts` — never `calendarDateKey()`, which uses midnight boundaries. `calendarDateKey()` exists only for calendar-date formatting in UI/export contexts.
- **One day model.** Days are addressed system-wide by **schedule-relative index `1..periodDays`** (the operational day, anchored at `schedule.periodStart + dayStartHour`). There is **no dependency on calendar dates or weekdays** in UI, persistence, engine, or exports. Exceptions: (1) absolute timestamps on `Task.timeBlock`, `ScheduleUnavailability`, and the live-mode anchor are intrinsically calendar-based; (2) `Schedule.periodStart` is an internal calendar anchor used only to compose op-day windows. Hours in user input are 0..23 and mapped into an op-day via `hourInOpDay(baseDate, dayStartHour, dayIndex, hour)` from `shared/utils/time-utils.ts` — hours `< dayStartHour` fall on the post-midnight tail of the given op-day.
- **`DateUnavailability` addresses days by index.** The type is `{ dayIndex: 1..periodDays, endDayIndex?: 1..periodDays, startHour, endHour, allDay, reason? }`. Rules are recurring per schedule (apply at generation time to the current schedule window), not to a JS weekday. `isBlockedByDateUnavailability` in `shared/utils/time-utils.ts` is the single source of truth; `config-store.computeAvailability` and `app.ts findPreExistingUnavailabilityOverlaps` use the same `hourInOpDay` helper so UI preview and HC-3 validation agree.
- **`getDayWindow` anchor.** The canonical `getDayWindow` lives in `web/schedule-utils.ts` and reads `schedule.periodStart + dayStartHour`. `export-utils.getDayWindow` and `schedule-grid-view`'s day filter read the same frozen anchor — never `min(task.start)`. This keeps the displayed schedule, PDF, and Excel day grids in lock-step with the engine.
- **Frozen-snapshot schedules.** Once generated, a `Schedule` is a frozen snapshot. The freeze is **explicit and synchronous at the generation site** — `_commitOptimizationResult` in `engine/scheduler.ts` deep-clones every participant via `structuredClone` before assigning to `Schedule.participants`, and `engine.addParticipant` deep-clones on entry. This means `Schedule.participants[i]` and `engine.participants.get(id)` are JS objects independent of `store.participants` from generation onward; mutating the live store cannot reach them. The schedule embeds the rest of the values the engine and display layer need: `algorithmSettings` (config, disabledHardConstraints, dayStartHour), `restRuleSnapshot`, `certLabelSnapshot`, `periodStart` + `periodDays`, and `scheduleUnavailability` (Future-SOS windows scoped to this snapshot). Any edit outside the schedule screen (participants, templates, algorithm settings, cert labels) only sets `_scheduleDirty = true` and shows the dirty warning — it cannot mutate the displayed schedule, the engine, or validation results. Schedule-screen code paths (render, rescue/SOS, manual swap, slot eligibility, tooltips, day grouping, violation filtering) must read frozen values from `schedule.algorithmSettings.*` / `engine.get*()`, never from `store.*`. The engine is the single source of truth post-generation; `store.*` is only consulted at generation time. Two corollaries: (1) the store's own update path uses replace-not-mutate (`participants.set(id, { ...p, ...patch })` in `_updateParticipantNoSnapshot`) so even references held outside the engine see immutable participant objects; (2) `Schedule.violations` is a cached array refreshed only by `engine.revalidateFull()` — which runs on schedule-screen actions and load events, not on store edits — so violations stay coherent with the frozen participant snapshot. Pre-schema saved schedules (missing frozen fields) are detected by `hasFrozenFields()` in `app.ts` and discarded at load — there is no migration.
- **Default Day 0 continuity snapshot.** First-launch state pre-populates the continuity buffer (`_continuityJson` in `app.ts`) from `src/web/default-continuity.ts`. The snapshot is hand-crafted in canonical form (ms offsets relative to `scheduleDate`) and re-anchored at runtime so it stays aligned with whatever schedule the user is generating. ⚠️ **Whenever `seedDefaultParticipants()` or `seedDefaultTaskTemplates()` in `config-store.ts` changes** (rename/add/remove participants or templates), the snapshot **must be updated by hand** — names are the matching key in `buildPhantomContext`, so a stale name silently drops that phantom assignment and weakens HC-12/HC-14 cross-boundary enforcement on first launch. See the file header for details. The runtime helper substitutes the active default rest rule's id into rest-rule-bearing assignments, so HC-14 pairing works without needing the seed's rest-rule id to be stable.
- **Group feasibility uses bipartite max matching, not greedy.** `findMaxMatching` in `src/constraints/group-matching.ts` (Kuhn's augmenting paths) is the canonical primitive whenever the question is "can a group fill all slots in a same-group task." Used by HC-8 (`checkGroupFeasibility`), preflight (`checkGroupIntegrity`), and the optimizer's `assignSameGroupTask`. Greedy "claim first eligible" matching produces false negatives when slots have heterogeneous tightness (e.g. one slot needs a rare cert held only by member P1, another slot accepts P1 too — greedy can claim P1 for the wrong slot and reject the group). Do not reintroduce per-slot greedy matching; route every same-group feasibility decision through this primitive.
- **Boundary-blocking model: task-level absolute, window-level opt-in.** Two distinct "blocks consecutive heavy work" knobs exist and they do not overlap. (1) `task.blocksConsecutive = true` is **unconditional**: the task always blocks at both edges (start AND end), regardless of any `loadWindows`. (2) For tasks with `blocksConsecutive = false`, individual entries in `task.loadWindows` may set `blocksAtBoundary = true`; that window blocks **only at whichever task boundary it actually touches** (start, end, or both — determined by whether the window's clock-time range contains the task's start/end clock time). Don't gate window-level boundary blocking on whether the task itself blocks; pre-v2.8.4 silently treated a `blocksConsecutive = true` task as non-blocking when its windows didn't reach the task edges, an availability-style bug that let HC-12 miss back-to-back heavy work.
- **Free-text inputs: escape on render, set a context-appropriate `maxlength`.** Free-text fields (participant names, reasons, descriptions, notes) follow a consistent pattern: trust the input on the way in (just `.trim()`, no in-code sanitization or control-char stripping — example: the participant-name flow in `src/web/tab-participants.ts`), and escape every render site via `escHtml()` / `escAttr()` from `ui-helpers.ts`. When adding a new free-text input, (1) confirm every place the value renders escapes it (including indirect paths — e.g. `showConfirm` in `ui-modal.ts` already wraps its `message` in `escHtml`, so callers can pass plain strings), and (2) set a `maxlength` attribute sized for the tightest place the value will render — narrow inline list cells need a smaller cap than wide table columns. If unsure what max length is appropriate, ask the user rather than guessing.

### Key Domain Concepts

- **Levels:** L0 (junior), L2, L3, L4 (senior). No L1 exists.
- **Certifications:** Nitzan, Hamama, Horesh — gate eligibility for specific task types (configured per slot, not per task type). Defined in `DEFAULT_CERTIFICATION_DEFINITIONS` (`src/models/types.ts`) and user-editable at runtime.
- **Hard constraints** (HC-1..HC-8, HC-11, HC-12, HC-14, HC-15): Binary pass/fail. Violations make a schedule invalid. HC-1 is the sole level gate for all participants. HC-15 (sleep & recovery) enforces a per-task recovery window: each `SleepRecoveryRule` lists 1-based `triggerShifts` (which specific shifts of the template/one-time-task fire the rule); when the assigned participant finishes one of those shifts they cannot take any other loaded task during the following `recoveryHours` window. (Pre-v2.8.8 the rule used a clock-hour range on task end time; that model is gone — `triggerShifts` is now the only trigger.) Stale shift indices that exceed the template's current `shiftsPerDay` are ignored at evaluation time. Every HC is gated by the `disabledHardConstraints` set frozen on the schedule, and feasibility prechecks (preflight, group integrity) must respect the same set — never re-impose a globally-disabled constraint indirectly. Note: HC-9, HC-10, HC-13 do not exist (removed or never created).
- **Soft constraints** (SC-3, SC-6..SC-10): Numeric penalties. The optimizer minimizes total penalty. SC-7 is a warning-only safety net. SC-1, SC-2, SC-4, SC-5 do not exist. SC-3 (overall fairness) and SC-8 (daily fairness) both use **capacity-proportional targets** when capacity data is available — a participant's expected day-load is `totalLoad × (cap_d / totalCap)`, mirroring the period-level rule. This stops the optimizer from penalising naturally-uneven schedules driven by uneven availability (partial-day participants, Shabbat-eve dips, etc.).
- **Senior policy:** Seniors have "natural roles" determined by `isNaturalRole()`. Slots can mark a senior level as `lowPriority` (last-resort) — the soft penalty `lowPriorityLevelPenalty` heavily discourages these placements. Hard level-gating is handled by HC-1.
- **Optimizer:** Three-phase — greedy assignment, simulated-annealing local search (pairwise swap + insert-into-unfilled), and a deterministic post-SA polish (`polishReplaceWithIdle`) that scans (assigned-incumbent, idle-eligible) pairs and accepts strict composite-score improvements. Polish runs inside `localSearchOptimize` after the existing post-SA insert sweep, skips `sameGroupRequired` tasks (within-group is SA's job, cross-group is HC-4-infeasible) and pinned/Manual/Frozen incumbents, reuses `IncrementalScorer` for O(k) per-attempt scoring, and is capped at 3 passes. Multi-attempt runs pick the best result.
- **Temporal (live mode):** A time anchor divides the schedule into frozen past and modifiable future.
- **Rescue planning:** When a slot is vacated, enumerates single-swap, then 2-swap, then 3-swap chain alternatives scored by composite-score delta. If depths 1–3 yield zero valid plans, a depth-4 deep-chain fallback runs and tags plans with `fallbackDepth = 4` so the UI can warn. Per-slot chain enumeration lives in `rescue-primitives.ts` and is shared with Future SOS.
- **Future SOS:** When a participant is marked unavailable for a future window (stored on the frozen `Schedule.scheduleUnavailability`, not on the live participant), Future SOS identifies every affected assignment and composes a single batch plan that fills all vacated slots together. Scored by full composite score, pruned by admissible bounds, bounded disruption (depth ≤ 3 per slot). HC-3 layers `scheduleUnavailability` on top of master-data availability during validation and rescue planning.
- **BALTAM injection:** Post-generation injection of a one-time task into an existing schedule (`src/engine/inject.ts`). **Live-mode-only** — the 🚨 emergency-task button is hidden when live mode is off, and the engine refuses to run without `opts.anchor`. Without that gate, a chain of replacements could silently rewrite already-completed past assignments. Runs depth-1/2/3 chain search with per-group backtracking for `sameGroupRequired` tasks, gated by `assertInjectableTimeBlock` from temporal.ts. Injected tasks carry `injectedPostGeneration = true` so orphan detection in `app.ts` ignores them.
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
