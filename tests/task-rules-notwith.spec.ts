import { expect, type Page, test } from '@playwright/test';

/**
 * Q7 — "not-with" terminology unification + tappable Participants signpost (phone).
 *
 * Mobile is the dominant platform, so these run on the phone project only.
 *
 *  Q7.1  The task-rules "אי התאמה" toggle row has a "?" help button; tapping it
 *        reveals a hint that navigates to the Participants screen (where the
 *        incompatible pairs are defined).
 *  Q7.2  The participant editor uses the unified term «אי התאמה» (and the old
 *        "אי-זיווג" term is gone).
 *
 * (The exhaustive "no deprecated term anywhere in src/" guard lives in the Node
 * suite — src/test.ts runTerminologyConsistencyTests. These specs cover the
 * runtime behaviour the text scan can't: render + navigation.)
 */

async function freshSeed(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-nav', { timeout: 45_000 });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-nav', { timeout: 45_000 });
}

const PARTICIPANT_ROWS = '.table-participants tbody tr[data-participant-id]';

test.describe('Q7 not-with term + signpost (phone)', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width > 500) test.skip();
    await freshSeed(page);
  });

  test('Q7.1 the "אי התאמה" hint navigates to the Participants screen', async ({ page }) => {
    await page.click('.tab-btn[data-tab="task-rules"]');

    // Expand the first recurring template card (one-time cards also use
    // .template-card, hence :not(.onetime-card)).
    const card = page.locator('.template-card:not(.onetime-card)').first();
    await expect(card).toBeVisible();
    await card.locator('.template-header').click();

    // The behavior toggle uses the unified term.
    const toggleLabel = card.locator('label.checkbox-label:has([data-tpl-field="togethernessRelevant"])');
    await expect(toggleLabel).toContainText('אי התאמה', { timeout: 20_000 });

    // The signpost is hidden behind a "?" help button in the same row; it is not
    // visible until the user taps "?".
    const helpBtn = card.locator('[data-action="toggle-notwith-help"]').first();
    await expect(helpBtn).toBeVisible();
    const hint = card.locator('[data-action="goto-participants"]').first();
    await expect(hint).toBeHidden();

    // Tapping "?" reveals the hint, which points to the participant cards.
    await helpBtn.click();
    await expect(hint).toBeVisible();
    await expect(card.locator('[data-help-panel]').first()).toContainText('בכרטיסי המשתתפים');

    // Tapping the in-panel button lands on the Participants screen.
    await hint.click();
    await expect(page.locator('.tab-btn[data-tab="participants"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(PARTICIPANT_ROWS).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Q7.2 the participant editor uses the unified «אי התאמה» term', async ({ page }) => {
    await page.click('.tab-btn[data-tab="participants"]');
    const firstRow = page.locator(PARTICIPANT_ROWS).first();
    await expect(firstRow).toBeVisible();
    const pid = await firstRow.getAttribute('data-participant-id');
    expect(pid).toBeTruthy();

    await page.click(`[data-action="edit-participant"][data-pid="${pid}"]`);
    const sheet = page.locator('.gm-edit-sheet-v2');
    await expect(sheet).toBeVisible();

    // The pairings section now reads «אי התאמה»; the old term is gone.
    await expect(sheet.locator('.pe-section-title', { hasText: 'אי התאמה' })).toBeVisible();
    await expect(sheet).not.toContainText('זיווג');
  });
});
