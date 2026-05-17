import { expect, type Page, test } from '@playwright/test';

/**
 * C7.1 — Tutorial demo enter → walk → exit, phone smoke (375×812).
 *
 * The tour runs against a curated *demo* roster/schedule that temporarily
 * replaces the user's real data (`enterTutorialDemoMode`). The deep
 * byte-identical snapshot/restore is unit-tested elsewhere; this spec asserts
 * the phone enter/exit UX itself works and never strands the user in demo
 * state:
 *   - entering the tour actually swaps in the small demo roster (proves it's
 *     not a no-op),
 *   - exiting restores the real roster and a usable app,
 *   - an interrupted tour (page reload mid-tour) self-heals back to the real
 *     roster instead of leaving the demo data behind.
 *
 * Default seed = 48 participants; demo seed = 6. That count gap is the
 * behavioral signal used throughout.
 */

const PARTICIPANT_ROWS = '.table-participants tbody tr[data-participant-id]';

async function freshSeed(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.tab-nav');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload();
  await page.waitForSelector('.tab-nav');
  // Wait for the tutorial API to be wired so gmStartTutorial(...) doesn't
  // optional-chain to undefined mid-init.
  await page
    .waitForFunction(() => typeof (window as unknown as { gmStartTutorial?: unknown }).gmStartTutorial === 'function', {
      timeout: 10_000,
    })
    .catch(() => {});
}

async function participantRowCount(page: Page): Promise<number> {
  await page.click('.tab-btn[data-tab="participants"]');
  await page.waitForSelector(PARTICIPANT_ROWS, { state: 'attached', timeout: 10_000 });
  return page.locator(PARTICIPANT_ROWS).count();
}

test.describe('Tutorial demo round-trip — phone', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width > 500) test.skip();
    await freshSeed(page);
  });

  test('enter → advance → exit restores the real roster and a usable app', async ({ page }) => {
    // ── Real state baseline ──
    const realCount = await participantRowCount(page);
    expect(realCount).toBeGreaterThan(10); // default seed is 48

    // ── Enter the tour (this enters demo mode) ──
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    const popover = page.locator('.tutorial-popover');
    await expect(popover).toBeVisible();

    // Demo mode must actually have swapped the roster in — otherwise enter is a
    // no-op and the rest of the assertions would be meaningless. The
    // 'participants' track switches to the participants tab, so the (smaller)
    // demo roster is rendered behind the tour overlay.
    await expect
      .poll(async () => page.locator(PARTICIPANT_ROWS).count(), { timeout: 10_000 })
      .toBeLessThan(realCount);
    const demoCount = await page.locator(PARTICIPANT_ROWS).count();
    expect(demoCount).toBeGreaterThan(0);

    // ── Advance a couple of steps ──
    for (let i = 0; i < 2; i++) {
      const next = popover.locator('[data-tutorial-action="next"]');
      if ((await next.count()) === 0) break;
      await next.click();
      await page.waitForTimeout(300);
    }
    await expect(popover).toBeVisible();

    // ── Exit the tour ──
    await popover.locator('[data-tutorial-action="exit"]').click();
    await expect(page.locator('.tutorial-popover')).toHaveCount(0);

    // ── Real state restored & app usable ──
    await expect(page.locator('.tab-nav')).toBeVisible();
    const restoredCount = await participantRowCount(page);
    expect(restoredCount).toBe(realCount);

    // No demo participant leaked into the restored roster, and the app is
    // still interactive (tab switching works, not frozen behind a stale
    // tutorial backdrop).
    await expect(page.getByText('שרון בכר', { exact: true })).toHaveCount(0);
    await page.click('.tab-btn[data-tab="schedule"]');
    await expect(page.locator('#btn-generate')).toBeVisible();
    await page.click('.tab-btn[data-tab="participants"]');
    await expect(page.locator(PARTICIPANT_ROWS)).toHaveCount(realCount);
  });

  test('interrupted tour (reload mid-tour) self-heals back to the real roster', async ({ page }) => {
    const realCount = await participantRowCount(page);
    expect(realCount).toBeGreaterThan(10);

    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    await expect(page.locator('.tutorial-popover')).toBeVisible();
    // Confirm demo took effect before the interruption.
    await expect
      .poll(async () => page.locator(PARTICIPANT_ROWS).count(), { timeout: 10_000 })
      .toBeLessThan(realCount);

    // Hard interruption: reload the page while the tour (demo data) is active.
    await page.reload();
    await page.waitForSelector('.tab-nav');

    // restoreTutorialBackupIfPresent() must have written the user's data back
    // before init() read it — the real roster is whole, the tour is gone, and
    // the user is not stranded looking at the 6-person demo.
    await expect(page.locator('.tutorial-popover')).toHaveCount(0);
    const afterReload = await participantRowCount(page);
    expect(afterReload).toBe(realCount);
    await expect(page.getByText('שרון בכר', { exact: true })).toHaveCount(0);
  });
});
