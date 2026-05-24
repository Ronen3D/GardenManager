import { expect, type Page, test } from '@playwright/test';

/**
 * Deep tour — playlist sequencing (phone + desktop).
 *
 * The deep tour ('deep-tour') is not a TutorialTrack: the engine expands it
 * into a back-to-back playlist of the six topic tracks
 * (participants → task-rules → schedule → algorithm → profile → task-panel),
 * keeping demo mode active for the whole run and restoring the user's data
 * exactly once at the end.
 *
 * This spec asserts the behaviours that are new and easy to regress:
 *   - the macro caption ("סיור מעמיק · מסלול N מתוך 6 · <track>") renders and
 *     its ordinal advances across a track boundary,
 *   - crossing a boundary does NOT exit/re-enter demo mode (the durable backup
 *     blob is created once and never rewritten mid-playlist — rewriting it
 *     would snapshot demo data over the user's real data),
 *   - exiting clears the playlist and restores the user, so a subsequent
 *     single-track tour shows no deep-tour caption.
 */

const BACKUP_KEY = 'gardenmanager_pre_tutorial_snapshot';

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
  await page
    .waitForFunction(() => typeof (window as unknown as { gmStartTutorial?: unknown }).gmStartTutorial === 'function', {
      timeout: 10_000,
    })
    .catch(() => {});
}

/** Current step id, read from the popover's aria-labelledby (tutorial-title-<id>). */
async function currentStepId(page: Page): Promise<string> {
  const labelled = await page.locator('.tutorial-popover').getAttribute('aria-labelledby');
  return (labelled ?? '').replace('tutorial-title-', '');
}

async function readBackup(page: Page): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), BACKUP_KEY);
}

test.describe('Deep tour — sequencing', () => {
  test.beforeEach(async ({ page }) => {
    await freshSeed(page);
  });

  test('runs topic tracks back-to-back with a single demo snapshot, then restores once', async ({ page }) => {
    const popover = page.locator('.tutorial-popover');
    const caption = popover.locator('.tutorial-tour-track');

    await page.evaluate(() => window.gmStartTutorial?.('deep-tour'));
    await expect(popover).toBeVisible();

    // First track of the playlist is `participants` (12 steps).
    await expect(caption).toBeVisible();
    await expect(caption).toContainText('מסלול 1 מתוך 6');
    await expect(popover.locator('.tutorial-step-counter')).toContainText('מתוך 12');
    expect(await currentStepId(page)).toBe('p-1');

    // Demo mode entered exactly once → durable backup blob exists now.
    const backupAtStart = await readBackup(page);
    expect(backupAtStart).not.toBeNull();

    // Advance until the playlist crosses participants → task-rules. 12 "next"
    // clicks at most (p-1..p-12 then the boundary), cap generously for any
    // intermediate re-renders.
    let crossed = false;
    for (let i = 0; i < 40; i++) {
      const next = popover.locator('[data-tutorial-action="next"]');
      await next.click();
      await page.waitForTimeout(250);
      const id = await currentStepId(page);
      if (id.startsWith('t-')) {
        crossed = true;
        break;
      }
    }
    expect(crossed).toBe(true);

    // Macro caption advanced to the second topic track; per-track counter reset.
    await expect(caption).toContainText('מסלול 2 מתוך 6');
    await expect(popover.locator('.tutorial-step-counter')).toContainText('מתוך 16');

    // Crossing the boundary must NOT have exited/re-entered demo mode: the
    // backup blob is still present and byte-identical to the one taken at start
    // (a re-snapshot mid-playlist would capture demo data over the user's).
    const backupAfterCross = await readBackup(page);
    expect(backupAfterCross).not.toBeNull();
    expect(backupAfterCross).toBe(backupAtStart);

    // Exit mid-playlist → restored exactly once, backup blob removed.
    await popover.locator('[data-tutorial-action="exit"]').click();
    await expect(page.locator('.tutorial-popover')).toHaveCount(0);
    expect(await readBackup(page)).toBeNull();
    await expect(page.locator('.tab-nav')).toBeVisible();
  });

  test('exiting the deep tour clears the playlist (single topic track shows no macro caption)', async ({ page }) => {
    const popover = page.locator('.tutorial-popover');

    await page.evaluate(() => window.gmStartTutorial?.('deep-tour'));
    await expect(popover.locator('.tutorial-tour-track')).toBeVisible();

    await popover.locator('[data-tutorial-action="exit"]').click();
    await expect(page.locator('.tutorial-popover')).toHaveCount(0);

    // A standalone topic track started right after must NOT show the deep-tour
    // caption and must NOT auto-advance into another track.
    await page.evaluate(() => window.gmStartTutorial?.('task-panel'));
    await expect(popover).toBeVisible();
    await expect(popover.locator('.tutorial-tour-track')).toHaveCount(0);
    expect(await currentStepId(page)).toBe('tp-1');
  });
});
