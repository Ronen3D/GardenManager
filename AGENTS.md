# Garden Manager Agent Guide

## Project Shape

- Repo root: `./` (this directory)
- Stack: TypeScript, Vite web app, Electron wrapper, Playwright E2E, Biome for lint/format
- UI language is Hebrew, so preserve RTL behavior and text encoding when touching labels or layout

## Key Commands

```bash
npm run dev
npm run build:web
npm run build:node
npm run electron:dev
npm run electron:build
npm run test
npm run test:e2e
npm run test:e2e:desktop
npm run test:e2e:phone
npm run lint
npm run lint:fix
npm run format
```

## Test Notes

- `npm run test` runs the custom TypeScript test harness in `src/test.ts`
- Playwright is configured in `playwright.config.ts` with its own `webServer` entry, so `npm run test:e2e` will start or reuse the Vite server on `http://localhost:5174`
- Viewport projects: `desktop`, `tablet`, `phone`, `phone-landscape`

## Build Targets

- Node CLI: `tsconfig.json` compiles `src/` except `src/web/` into `dist/`
- Web app: `tsconfig.web.json` + Vite build `src/` into `dist-web/`
- Electron: `tsconfig.electron.json` compiles `electron/` into `dist-electron/`
- Vite alias: `@` maps to `src/`

## Where Things Live

- `src/web/app.ts`: main web UI orchestrator and tab flow
- `src/web/config-store.ts`: persisted configuration and task-template state
- `src/engine/`: scheduler, optimizer, validator, temporal logic, rescue planning
- `src/constraints/`: hard and soft scheduling constraints plus senior-policy logic
- `src/models/types.ts`: core domain types
- `src/tasks/cli-task-factory.ts`: CLI/demo task factories, not the main web task-definition path
- `tests/`: Playwright regression and mobile interaction coverage

## Project Invariants

- Task types are data-driven. Do not hardcode task-specific behavior in the engine, constraints, or UI flow when it should come from `TaskTemplate` or slot/template configuration.
- The web app creates schedule tasks from stored templates in the config store. CLI task factories are for scripts and demos.
- A scheduling "day" uses the configurable operational day boundary, not midnight. Use the date utilities that respect `dayStartHour` when grouping assignments by day.
- Preserve the separation between hard constraints (validity gates) and soft constraints (penalty scoring).

## Working Norms

- Prefer editing source in `src/`, `electron/`, and `tests/`; avoid manual edits to generated output in `dist/`, `dist-web/`, `dist-electron/`, `playwright-report/`, or `test-results/`
- Run Biome after meaningful TS/CSS changes
- When changing scheduling behavior, pair code edits with either `npm run test` or the most relevant Playwright spec/project
- Keep mobile and desktop behavior in mind; this repo has active phone and landscape coverage

## Useful Context

- The Vite dev server is pinned to port `5174` to avoid localStorage collisions with other projects
- `index.html`, `public/`, and `src/web/style*.css` are part of the shipped web app surface
- There is an existing `CLAUDE.md` with a longer architecture write-up; keep this file aligned with it if major conventions change
