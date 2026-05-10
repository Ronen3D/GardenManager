import { type Page, expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tutorial walkthrough — desktop (1280×800).
 *
 * Walks every step of every tutorial track, capturing:
 *   - step counter text
 *   - title text
 *   - whether the spotlight is in centered-fallback mode
 *   - bounding boxes of popover and (if not centered) spotlight
 *   - viewport size
 *   - screenshot per step
 *
 * Writes a JSON sidecar per track to test-results/walkthrough-desktop/<trackId>.json
 * so the diagnosis report can be produced from a single run.
 *
 * NOT a regression test — every test passes regardless of findings; the
 * captured artifacts are analyzed offline.
 */

interface StepCapture {
  trackId: string;
  stepIndex: number; // 0-based
  counterText: string | null;
  titleText: string | null;
  centered: boolean;
  popoverBox: { x: number; y: number; width: number; height: number } | null;
  spotlightBox: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number };
  screenshotPath: string;
}

// Write outside `test-results/` so Playwright's run-cleanup doesn't wipe the
// captured JSON sidecars between runs. Screenshots can stay alongside JSON.
const OUT_DIR = path.join('test-output', 'walkthrough-desktop');

function ensureOutDir(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function clearAllStorage(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload();
  await page.waitForSelector('.tab-nav');
}

async function generateSchedule(page: Page): Promise<void> {
  // Make sure we're on the schedule tab
  const schedTab = page.locator('.tab-btn[data-tab="schedule"]');
  if (await schedTab.count()) {
    await schedTab.click();
  }
  await page.waitForSelector('#btn-generate', { timeout: 5000 });
  // Lower scenarios to 1 for fast generation in tests (the schedule shape
  // doesn't matter — we just need a valid frozen schedule for the tutorial
  // engine's `requiresSchedule` guard to pass).
  const scenarios = page.locator('#input-scenarios');
  if ((await scenarios.count()) > 0) {
    await scenarios.fill('1');
  }
  await page.click('#btn-generate');
  // Wait until the button is re-enabled and no longer reads "מייעל"
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
      return btn != null && !btn.disabled && !(btn.textContent ?? '').includes('מייעל');
    },
    { timeout: 60_000 },
  );
  // Belt-and-suspenders: also let any optim overlay finish unmounting
  await page
    .waitForSelector('.optim-overlay', { state: 'hidden', timeout: 5000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

async function enableLiveMode(page: Page): Promise<void> {
  // Live mode toggle id is #chk-live-mode (per tutorial step s-9 selector)
  const live = page.locator('#chk-live-mode');
  if ((await live.count()) === 0) return;
  const checked = await live.isChecked().catch(() => false);
  if (!checked) {
    await live.check({ force: true }).catch(() => {});
  }
}

async function captureCurrent(page: Page, trackId: string, stepIndex: number): Promise<StepCapture> {
  // Wait for the popover element to exist
  await page.waitForSelector('.tutorial-popover', { state: 'visible', timeout: 5000 });
  // Wait for the step counter text to match the expected step number — this
  // avoids capturing stale content from the previous step (the popover is
  // re-used between steps; only its innerHTML is replaced inside renderStep).
  // Try to wait for the step counter to match the expected step number, but
  // don't fail the whole test if it doesn't (some steps may have the popover
  // content stuck on the previous step due to a bug — we still want to capture
  // and record the failure).
  await page
    .waitForFunction(
      (expected) => {
        const counter = document.querySelector('.tutorial-popover .tutorial-step-counter');
        const text = counter?.textContent ?? '';
        return text.includes(`שלב ${expected} `);
      },
      stepIndex + 1,
      { timeout: 2500 },
    )
    .catch(() => {});
  // Two frames for positioning + transition to settle (renderStep finishes
  // synchronously after innerHTML, but spotlight position is set in the same
  // tick; one rAF is enough but we use two to be safe).
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );

  const data = await page.evaluate(() => {
    const popover = document.querySelector('.tutorial-popover');
    const spotlight = document.querySelector('.tutorial-spotlight');
    const counter = popover?.querySelector('.tutorial-step-counter')?.textContent ?? null;
    const title = popover?.querySelector('.tutorial-title')?.textContent ?? null;
    const centered = !!spotlight?.classList.contains('tutorial-spotlight-centered');
    const pRect = popover?.getBoundingClientRect();
    const sRect = spotlight?.getBoundingClientRect();
    return {
      counterText: counter,
      titleText: title,
      centered,
      popoverBox: pRect
        ? { x: pRect.x, y: pRect.y, width: pRect.width, height: pRect.height }
        : null,
      spotlightBox: !centered && sRect
        ? { x: sRect.x, y: sRect.y, width: sRect.width, height: sRect.height }
        : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });

  const screenshotPath = path.join(OUT_DIR, `${trackId}-${String(stepIndex).padStart(2, '0')}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  return {
    trackId,
    stepIndex,
    counterText: data.counterText,
    titleText: data.titleText,
    centered: data.centered,
    popoverBox: data.popoverBox,
    spotlightBox: data.spotlightBox,
    viewport: data.viewport,
    screenshotPath,
  };
}

async function walkTrack(
  page: Page,
  trackId: string,
  expectedSteps: number,
): Promise<StepCapture[]> {
  const captures: StepCapture[] = [];
  await page.evaluate((id) => window.gmStartTutorial?.(id), trackId);
  for (let i = 0; i < expectedSteps; i++) {
    try {
      const cap = await captureCurrent(page, trackId, i);
      captures.push(cap);
      // Persist incrementally so a hang or timeout doesn't lose all captures
      writeCaptures(trackId, captures);
    } catch (err) {
      captures.push({
        trackId,
        stepIndex: i,
        counterText: null,
        titleText: null,
        centered: false,
        popoverBox: null,
        spotlightBox: null,
        viewport: { width: 1280, height: 800 },
        screenshotPath: '',
      });
      writeCaptures(trackId, captures);
      break;
    }
    // Click "next" — but only if popover still exists and still on the same step
    const nextBtn = page.locator('.tutorial-popover [data-tutorial-action="next"]');
    if ((await nextBtn.count()) === 0) break;
    await nextBtn.click().catch(() => {});
    // Wait for the next step to render OR for the popover to disappear
    // (it disappears after the final step's "סיים"). Accordion-opening steps
    // need ~300ms; tab-switch steps need ~50ms; we use 400ms to be safe.
    await page.waitForTimeout(400);
  }
  return captures;
}

function writeCaptures(trackId: string, captures: StepCapture[]): void {
  fs.writeFileSync(path.join(OUT_DIR, `${trackId}.json`), JSON.stringify(captures, null, 2));
}

test.describe('Tutorial walkthrough — desktop', () => {
  test.beforeAll(() => {
    ensureOutDir();
  });

  test('full-tour walkthrough (~36 steps)', async ({ page }) => {
    test.setTimeout(300_000);
    await clearAllStorage(page);
    const captures = await walkTrack(page, 'full-tour', 36);
    writeCaptures('full-tour', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('participants walkthrough (10 steps)', async ({ page }) => {
    test.setTimeout(120_000);
    await clearAllStorage(page);
    const captures = await walkTrack(page, 'participants', 10);
    writeCaptures('participants', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('task-rules walkthrough (12 steps)', async ({ page }) => {
    test.setTimeout(120_000);
    await clearAllStorage(page);
    const captures = await walkTrack(page, 'task-rules', 12);
    writeCaptures('task-rules', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('schedule walkthrough (18 steps, schedule + live mode pre-generated)', async ({ page }) => {
    test.setTimeout(300_000);
    await clearAllStorage(page);
    await generateSchedule(page);
    await enableLiveMode(page);
    const captures = await walkTrack(page, 'schedule', 18);
    writeCaptures('schedule', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('algorithm walkthrough (9 steps)', async ({ page }) => {
    test.setTimeout(120_000);
    await clearAllStorage(page);
    const captures = await walkTrack(page, 'algorithm', 9);
    writeCaptures('algorithm', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('profile walkthrough (5 steps, requires schedule)', async ({ page }) => {
    test.setTimeout(180_000);
    await clearAllStorage(page);
    await generateSchedule(page);
    const captures = await walkTrack(page, 'profile', 5);
    writeCaptures('profile', captures);
    expect(captures.length).toBeGreaterThan(0);
  });

  test('task-panel walkthrough (5 steps, requires schedule)', async ({ page }) => {
    test.setTimeout(180_000);
    await clearAllStorage(page);
    await generateSchedule(page);
    const captures = await walkTrack(page, 'task-panel', 5);
    writeCaptures('task-panel', captures);
    expect(captures.length).toBeGreaterThan(0);
  });
});
