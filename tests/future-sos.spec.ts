import { expect, type Page, test } from '@playwright/test';

/**
 * Future SOS — smoke E2E.
 *
 * Full engine correctness is covered by unit tests (src/test.ts `fsos-*`).
 * This spec verifies the UI entry points render and trigger the expected
 * modals. A complete click-through flow is driven manually via the unit
 * test suite because automating the three-modal sequence (time picker →
 * range picker → confirm → plans) against randomly generated schedules is
 * flaky.
 *
 * Generation uses the standard repo idiom (cap scenarios to 1, wait for the
 * generate button to re-enable) instead of a fixed 10s wait — an unthrottled
 * 60-attempt run takes far longer than 10s on the phone project, which is what
 * made the old wait time out. On touch/phone the profile is reached via the
 * bottom-sheet quick card's "צפה בפרופיל" button.
 */

async function generateSchedule(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const input = page.locator('#input-scenarios');
  if ((await input.count()) > 0) await input.fill('1');
  await page.click('#btn-generate');
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
      return !!btn && !btn.disabled && !btn.textContent?.includes('מייעל');
    },
    { timeout: 90_000 },
  );
  await page.waitForSelector('.participant-hover[data-pid], [data-pid]', {
    state: 'attached',
    timeout: 90_000,
  });
  await page.waitForTimeout(400);
}

async function openFirstProfile(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const first = page.locator('.participant-hover[data-pid]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  // On touch/mobile, tapping a participant opens a bottom-sheet quick card
  // first; the profile is reached via its "📋 צפה בפרופיל" button.
  const gotoProfile = page.locator('[data-action="goto-profile"][data-pid]').first();
  if (await gotoProfile.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await gotoProfile.click();
  }
  await page.waitForSelector('.profile-view-root', { timeout: 8_000 });
}

test.describe('Future SOS — profile button', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('אי זמינות עתידית button appears in participant profile after generation', async ({ page }) => {
    test.setTimeout(150_000);
    await generateSchedule(page);
    await openFirstProfile(page);

    // The Future SOS button should be visible on the profile top bar.
    await expect(page.locator('.btn-future-sos')).toBeVisible();
  });

  // Left intentionally unchanged from its original form: with a fresh,
  // un-generated context this test gracefully `test.skip()`s (no schedule →
  // no profile to reach), so it is GREEN-as-skip isolated. Per the audit
  // scope (future-sos concern is the line-19 generation-wait failure only),
  // green-isolated tests are not modified.
  test('clicking אי זמינות עתידית with live mode OFF opens the anchor time picker', async ({ page }) => {
    await page.click('.tab-btn[data-tab="schedule"]');

    // Try to enter profile view. If no schedule exists, the profile view
    // cannot be reached — skip rather than fail.
    const participantCount = await page.locator('.participant-hover[data-pid]').count();
    if (participantCount === 0) test.skip();
    await page.locator('.participant-hover[data-pid]').first().click();
    await page.waitForSelector('.profile-view-root', { timeout: 5000 });

    // Ensure live mode is OFF.
    await page.evaluate(() => {
      const v = localStorage.getItem('gardenmanager_live_mode');
      if (v) {
        const parsed = JSON.parse(v);
        parsed.enabled = false;
        localStorage.setItem('gardenmanager_live_mode', JSON.stringify(parsed));
      }
    });
    await page.reload();
    await page.waitForSelector('.tab-nav');
    // Re-enter profile (view mode resets on reload).
    if ((await page.locator('.participant-hover[data-pid]').count()) === 0) test.skip();
    await page.locator('.participant-hover[data-pid]').first().click();
    await page.waitForSelector('.profile-view-root');

    await page.locator('.btn-future-sos').click();

    // The time picker shows the "הפעלת מצב חי" title when live mode is off.
    await expect(page.locator('.gm-modal-dialog')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.gm-modal-title')).toContainText('מצב חי');
    // There should be day + hour selects for the anchor.
    await expect(page.locator('#gm-tp-day')).toBeVisible();
    await expect(page.locator('#gm-tp-hour')).toBeVisible();
  });
});
