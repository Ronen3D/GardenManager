/**
 * Coverage-suite runner (A0 de-orphan gate).
 *
 * The 8 "coverage" test files below were already written but INERT — nothing
 * ran them, so a regression in optimizer / constraints / capability-change /
 * rescue-sos-inject / shared-utils would not fail any automated run.
 *
 * Each of those files has a top-level test body and self-execs with a non-zero
 * `process.exit` on failure. Wrapping their bodies in an exported
 * `run<Name>(assert)` would be a large, risky mechanical edit across ~5k lines.
 * Per the A0 directive's explicit fallback, we instead run each file as its own
 * `ts-node` child process and aggregate the exit codes. This requires ZERO
 * structural change to those files (apart from a single test-assertion
 * correction in test-capability-change-edge.ts), preserving their
 * verified-passing behaviour exactly, while still making ANY failure fail this
 * runner (exit 1) and therefore the CI gate.
 *
 * These files are pure `src/` (no `src/web` imports) so they run under the
 * default `tsconfig.json` — they must NOT be added to `npm test` (src/test.ts)
 * because each one calls `process.exit`, which would abort the shared harness.
 *
 * EXTENSION POINT: to gate a new pure-`src/` coverage file, add ONE line to
 * `COVERAGE_FILES`. (NEW writing-agent files instead follow the exported
 * `run<Name>(assert)` convention and are wired into src/test.ts /
 * src/test-persistence.ts.)
 *
 * Usage:  npm run test:coverage
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// ─── The single extension point ─────────────────────────────────────────────
const COVERAGE_FILES: string[] = [
  'test-optimizer-coverage.ts',
  'test-optimizer-coverage-2.ts',
  'test-shared-utils-coverage.ts',
  'test-constraints-coverage.ts',
  'test-capability-change-unit.ts',
  'test-capability-change-integration.ts',
  'test-capability-change-edge.ts',
  'test-rescue-sos-inject-coverage.ts',
];

const repoRoot = path.resolve(__dirname, '..');

const results: { file: string; code: number }[] = [];

for (const file of COVERAGE_FILES) {
  const full = path.join(__dirname, file);
  console.log(`\n══════════════════════════════════════════`);
  console.log(`▶ RUN  ${file}`);
  console.log(`══════════════════════════════════════════`);
  // Spawn `node -r ts-node/register <file>` (cross-platform: avoids the
  // Windows ts-node.cmd shell issue). ts-node/register uses tsconfig.json,
  // matching `npm test`'s type-check semantics.
  const res = spawnSync(process.execPath, ['-r', 'ts-node/register', full], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env,
  });
  // res.status is null when the process was killed by a signal → treat as fail.
  const code = res.status ?? 1;
  results.push({ file, code });
}

console.log(`\n══════════════════════════════════════════`);
console.log(`  COVERAGE SUITE SUMMARY`);
console.log(`══════════════════════════════════════════`);
let anyFailed = false;
for (const r of results) {
  const status = r.code === 0 ? 'PASS' : 'FAIL';
  if (r.code !== 0) anyFailed = true;
  console.log(`  ${status}  ${r.file}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
}
console.log(`══════════════════════════════════════════\n`);

process.exit(anyFailed ? 1 : 0);
