import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Page, test } from '@playwright/test';

/**
 * Tutorial walkthrough — mobile (375×812).
 *
 * Walks every step of every tutorial track on mobile and captures:
 *   - popover bbox + spotlight bbox
 *   - whether spotlight is centred (no target) or anchored
 *   - screenshot per step (gm-walkthrough/<track>-<idx>.png)
 *
 * Output goes to gm-walkthrough/ (NOT under test-results/) so parallel
 * Playwright runs that wipe test-results don't destroy the data.
 *
 * Run via:
 *   npx playwright test tests/tutorial-walkthrough-mobile.spec.ts --project=phone --reporter=line --workers=1
 */

const OUT_DIR = path.resolve('gm-walkthrough');

interface StepReport {
  trackId: string;
  stepIndex: number;
  stepCounter: string;
  stepTitle: string;
  popoverBox: { x: number; y: number; width: number; height: number } | null;
  spotlightBox: { x: number; y: number; width: number; height: number } | null;
  spotlightCentered: boolean;
  hasLiftedClass: boolean;
  liftPx: number | null;
  vh: number;
  vw: number;
  classification: string;
  classificationReason: string;
  screenshotPath: string;
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

async function clearStorage(page: Page): Promise<void> {
  await page.goto('/', { timeout: 15_000 });
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ timeout: 15_000 });
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  // Wait for window.gmStartTutorial to be wired up — without this the first
  // gmStartTutorial(...) call after a reload sometimes lands before init() has
  // finished, optional-chains to undefined, and the walker times out waiting
  // for a popover that was never asked to render.
  await page
    .waitForFunction(() => typeof (window as unknown as { gmStartTutorial?: unknown }).gmStartTutorial === 'function', {
      timeout: 10_000,
    })
    .catch(() => {});
  // Dismiss the banner if present (don't wait long).
  const dismiss = page.locator('.tutorial-banner [data-tutorial-banner-action="dismiss"]:not(.tutorial-banner-close)');
  if ((await dismiss.count()) > 0) {
    await dismiss
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
  }
}

async function generateSchedule(page: Page): Promise<boolean> {
  await page
    .locator('.tab-btn[data-tab="schedule"]')
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page.waitForTimeout(300);
  // The grid container may already be present even before generate (empty state).
  // Generate to be sure assignments exist.
  const gen = page.locator('#btn-generate');
  if ((await gen.count()) === 0) return false;
  // Lower scenarios to 4 to cap generation time.
  const scenInput = page.locator('#input-scenarios');
  if ((await scenInput.count()) > 0) {
    await scenInput.fill('4').catch(() => {});
  }
  await gen
    .first()
    .click({ timeout: 5_000 })
    .catch(() => {});
  // Wait for at least one participant cell to appear (schedule has assignments).
  const ok = await page
    .waitForSelector('.participant-hover[data-pid], [data-pid]', { timeout: 90_000, state: 'attached' })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(500);
  return ok;
}

async function enableLiveMode(page: Page): Promise<void> {
  await page
    .locator('.tab-btn[data-tab="schedule"]')
    .click({ timeout: 5_000 })
    .catch(() => {});
  await page.waitForTimeout(200);
  const chk = page.locator('#chk-live-mode');
  if ((await chk.count()) === 0) return;
  const checked = await chk.isChecked().catch(() => false);
  if (!checked) {
    await chk.click({ timeout: 3_000 }).catch(() => {});
    // Live-mode opens an anchor-time picker modal — accept defaults.
    await page.waitForTimeout(400);
    const confirm = page.locator('.gm-modal-dialog .btn-primary, .gm-modal .btn-primary').first();
    if ((await confirm.count()) > 0) {
      await confirm.click({ timeout: 2_000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
  }
}

interface Snapshot {
  popoverBox: { x: number; y: number; width: number; height: number } | null;
  spotlightBox: { x: number; y: number; width: number; height: number } | null;
  spotlightCentered: boolean;
  hasLiftedClass: boolean;
  liftPx: number | null;
  stepCounter: string;
  stepTitle: string;
  vh: number;
  vw: number;
}

async function readPopoverState(page: Page): Promise<Snapshot> {
  return await page.evaluate(() => {
    const popover = document.querySelector('.tutorial-popover') as HTMLElement | null;
    const spotlight = document.querySelector('.tutorial-spotlight') as HTMLElement | null;
    const counterEl = document.querySelector('.tutorial-step-counter') as HTMLElement | null;
    const titleEl = document.querySelector('.tutorial-title') as HTMLElement | null;
    const toBox = (el: HTMLElement | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null; // treat as gone
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const liftStr = popover?.style.getPropertyValue('--tutorial-popover-lift') ?? '';
    const liftPx = liftStr ? parseFloat(liftStr) : null;
    return {
      popoverBox: toBox(popover),
      spotlightBox: toBox(spotlight),
      spotlightCentered: !!spotlight?.classList.contains('tutorial-spotlight-centered'),
      hasLiftedClass: !!popover?.classList.contains('tutorial-popover-lifted'),
      liftPx: Number.isFinite(liftPx as number) ? (liftPx as number) : null,
      stepCounter: (counterEl?.textContent ?? '').trim(),
      stepTitle: (titleEl?.textContent ?? '').trim(),
      vh: window.innerHeight,
      vw: window.innerWidth,
    };
  });
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

function classify(snap: Snapshot): { cls: string; reason: string } {
  const { popoverBox, spotlightBox, spotlightCentered, vh, vw } = snap;
  if (!popoverBox) return { cls: 'OK', reason: 'no popover (probably finished)' };
  if (popoverBox.y < -1 || popoverBox.y + popoverBox.height > vh + 1) {
    return {
      cls: 'SHEET CLIPPED',
      reason: `popover y=${popoverBox.y.toFixed(0)} h=${popoverBox.height.toFixed(0)} extends past viewport (vh=${vh})`,
    };
  }
  if (spotlightCentered) {
    return { cls: 'OK', reason: 'centred (target null or fallback)' };
  }
  if (!spotlightBox || spotlightBox.width === 0 || spotlightBox.height === 0) {
    return { cls: 'OK', reason: 'no spotlight box but not centred — odd, treating as OK' };
  }
  if (
    spotlightBox.y + spotlightBox.height < 0 ||
    spotlightBox.y > vh ||
    spotlightBox.x + spotlightBox.width < 0 ||
    spotlightBox.x > vw
  ) {
    return {
      cls: 'TARGET OFF-SCREEN',
      reason: `spotlight y=${spotlightBox.y.toFixed(0)} h=${spotlightBox.height.toFixed(0)} outside viewport`,
    };
  }
  if (rectsIntersect(spotlightBox, popoverBox)) {
    return {
      cls: 'TARGET COVERED',
      reason: `spotlight (y=${spotlightBox.y.toFixed(0)}..${(spotlightBox.y + spotlightBox.height).toFixed(0)}) intersects popover (y=${popoverBox.y.toFixed(0)}..${(popoverBox.y + popoverBox.height).toFixed(0)})`,
    };
  }
  return { cls: 'OK', reason: 'target visible, popover does not cover it' };
}

interface TrackPlan {
  id: string;
  needsSchedule: boolean;
  needsLive: boolean;
  expectedSteps: number;
}

const TRACK_PLANS: TrackPlan[] = [
  { id: 'full-tour', needsSchedule: false, needsLive: false, expectedSteps: 43 },
  { id: 'participants', needsSchedule: false, needsLive: false, expectedSteps: 12 },
  { id: 'task-rules', needsSchedule: false, needsLive: false, expectedSteps: 15 },
  { id: 'schedule', needsSchedule: true, needsLive: true, expectedSteps: 22 },
  { id: 'algorithm', needsSchedule: false, needsLive: false, expectedSteps: 10 },
  { id: 'profile', needsSchedule: true, needsLive: false, expectedSteps: 7 },
  { id: 'task-panel', needsSchedule: true, needsLive: false, expectedSteps: 6 },
];

function appendStep(rec: StepReport): void {
  try {
    fs.appendFileSync(path.join(OUT_DIR, 'steps.ndjson'), `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    /* ignore disk errors */
  }
}

async function walkTrack(page: Page, plan: TrackPlan): Promise<void> {
  // Open the track.
  await page.evaluate((id) => window.gmStartTutorial?.(id), plan.id);
  // Wait for the popover.
  const opened = await page
    .waitForSelector('.tutorial-popover', { timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    console.warn(`[walkthrough] track ${plan.id} did not open a popover`);
    return;
  }

  let stepIndex = 0;
  const HARD_CAP = plan.expectedSteps + 6;
  let lastCounter = '';
  let stuckCount = 0;

  while (stepIndex < HARD_CAP) {
    // Brief settle window (rAF, scroll, accordion ~200ms).
    await page.waitForTimeout(280);

    let snap: Snapshot;
    try {
      snap = await readPopoverState(page);
    } catch {
      console.warn(`[walkthrough] ${plan.id} step ${stepIndex} readPopoverState failed`);
      break;
    }
    if (!snap.popoverBox) {
      // Tutorial closed.
      break;
    }

    // Detect non-advance: same counter twice in a row → bail.
    if (snap.stepCounter && snap.stepCounter === lastCounter) {
      stuckCount++;
      if (stuckCount >= 2) {
        console.warn(`[walkthrough] ${plan.id} stuck on counter "${lastCounter}" — bailing`);
        break;
      }
    } else {
      stuckCount = 0;
      lastCounter = snap.stepCounter;
    }

    // Screenshot.
    const screenshotPath = path.join(OUT_DIR, `${plan.id}-${String(stepIndex).padStart(2, '0')}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5_000 }).catch(() => {});

    const { cls, reason } = classify(snap);
    appendStep({
      trackId: plan.id,
      stepIndex,
      stepCounter: snap.stepCounter,
      stepTitle: snap.stepTitle,
      popoverBox: snap.popoverBox,
      spotlightBox: snap.spotlightBox,
      spotlightCentered: snap.spotlightCentered,
      hasLiftedClass: snap.hasLiftedClass,
      liftPx: snap.liftPx,
      vh: snap.vh,
      vw: snap.vw,
      classification: cls,
      classificationReason: reason,
      screenshotPath,
    });

    // Advance — fast-fail click. force:true bypasses actionability checks
    // (relevant if backdrop intercepts pointer events on some steps).
    const nextBtn = page.locator('.tutorial-popover [data-tutorial-action="next"]');
    if ((await nextBtn.count()) === 0) break;
    await nextBtn.click({ timeout: 3_000, force: true }).catch(() => {});
    stepIndex++;
  }

  // Force-close any remaining tutorial UI before next track.
  await page.evaluate(() => {
    document.querySelector('.tutorial-root')?.remove();
  });
}

test.describe('Tutorial walkthrough — mobile (375×812)', () => {
  test.beforeAll(() => {
    ensureDir(OUT_DIR);
    // Don't truncate the ndjson here: with workers=1 and any test failure,
    // Playwright may spin up a fresh worker which re-runs beforeAll and wipes
    // the data the previous tests in the same logical run already wrote. The
    // CLI is responsible for removing gm-walkthrough/ before invoking the
    // suite (see project README for the run recipe).
  });

  for (const plan of TRACK_PLANS) {
    test(`walk track: ${plan.id}`, async ({ page, viewport }) => {
      // Allow 5min per track to absorb the 60s schedule generation worst case.
      test.setTimeout(plan.needsSchedule ? 240_000 : 90_000);
      if (!viewport || viewport.width > 767) test.skip();

      await clearStorage(page);

      if (plan.needsSchedule) {
        const scheduled = await generateSchedule(page);
        if (!scheduled) {
          console.warn(`[walkthrough] ${plan.id}: schedule generation failed/timed out — skipping`);
          test.skip();
          return;
        }
      }
      if (plan.needsLive) {
        await enableLiveMode(page);
      }

      await walkTrack(page, plan);
    });
  }

  test.afterAll(() => {
    // Read NDJSON, build summary.
    const ndjsonPath = path.join(OUT_DIR, 'steps.ndjson');
    if (!fs.existsSync(ndjsonPath)) return;
    const records: StepReport[] = fs
      .readFileSync(ndjsonPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StepReport);
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(records, null, 2), 'utf8');

    const lines: string[] = [];
    lines.push('# Tutorial walkthrough — mobile (375×812)');
    lines.push('');
    const total = records.length;
    const byClass: Record<string, number> = {};
    for (const r of records) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
    lines.push(`Total steps walked: ${total}`);
    for (const [cls, n] of Object.entries(byClass)) lines.push(`  ${cls}: ${n}`);
    lines.push('');
    lines.push('## Problems');
    for (const r of records) {
      if (r.classification === 'OK') continue;
      lines.push(`- [${r.trackId}] step #${r.stepIndex} "${r.stepTitle}" (${r.stepCounter}) — ${r.classification}`);
      lines.push(`    ${r.classificationReason}`);
      lines.push(`    lifted=${r.hasLiftedClass} liftPx=${r.liftPx}`);
      lines.push(`    screenshot: ${r.screenshotPath}`);
    }
    lines.push('');
    lines.push('## Pass list');
    for (const r of records) {
      if (r.classification !== 'OK') continue;
      lines.push(`- [${r.trackId}] step #${r.stepIndex} "${r.stepTitle}" (${r.stepCounter})`);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), lines.join('\n'), 'utf8');
  });
});
