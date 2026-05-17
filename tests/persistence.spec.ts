import { expect, type Page, test } from '@playwright/test';

/**
 * E2E Persistence Tests
 *
 * Tests that require a real browser environment: localStorage survival across
 * page reload, undo/redo button behaviour.
 *
 * NOTE: When localStorage is empty, the app seeds ~48 default participants.
 * Tests therefore check for specific participant names (not absolute row counts)
 * and compare row counts relative to a baseline.
 *
 * The app now lands on the Home view (not the Participants table) and shows a
 * first-run welcome banner. `openParticipantsTab()` dismisses that banner the
 * same way the tutorial specs dismiss theirs and opens the Participants tab so
 * the table-based assertions have a table to read. Adding a participant now
 * goes through the `.gm-edit-sheet-v2` editor sheet (the old inline
 * `#add-participant-form` was removed) — `addParticipant()` drives that sheet.
 * Test intent (save/load survives reload, undo/redo) is unchanged.
 */

/**
 * Dismiss the Home first-run welcome banner if present, then open the
 * Participants tab and wait for the table. Safe to call repeatedly and after a
 * mid-test reload (which also returns to the Home view).
 */
async function openParticipantsTab(page: Page): Promise<void> {
  const dismissWelcome = page.locator('.home-welcome [data-action="dismiss-welcome"]');
  if ((await dismissWelcome.count()) > 0) {
    await dismissWelcome
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
  }
  await page.click('.tab-btn[data-tab="participants"]');
  await page.waitForSelector('table.table-participants tbody tr');
}

/**
 * Add a participant via the editor sheet. Mirrors the green
 * config-crud-mobile idiom: the create draft already defaults to a valid
 * seeded group, so a name + save is enough to commit.
 */
async function addParticipant(page: Page, name: string): Promise<void> {
  await page.click('[data-action="add-participant"]');
  const sheet = page.locator('.gm-edit-sheet-v2');
  await expect(sheet).toBeVisible();
  await sheet.locator('[data-pe-field="name"]').fill(name);
  await sheet.locator('[data-pe-save]').first().click();
  await expect(sheet).toHaveCount(0);
}

test.describe('E1: Save/Load Survives Page Reload', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    // Clear prior state and reload for a clean seeded baseline
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.tab-nav');
    await openParticipantsTab(page);
  });

  test('participant survives page reload', async ({ page }) => {
    // Count baseline rows
    const baselineCount = await page.locator('table.table-participants tbody tr').count();

    // Open add-participant sheet and create the participant
    await addParticipant(page, 'ReloadTestUser');

    // Verify participant appears
    await expect(page.locator('table.table-participants tbody')).toContainText('ReloadTestUser');
    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount + 1);

    // Reload the page
    await page.reload();
    await page.waitForSelector('.tab-nav');
    await openParticipantsTab(page);

    // Participant should still be visible after reload
    await expect(page.locator('table.table-participants tbody')).toContainText('ReloadTestUser');
  });

  test('undo stack does not survive reload (in-memory only)', async ({ page }) => {
    // Add a participant so undo becomes available
    await addParticipant(page, 'UndoReloadTest');

    // Undo button should be enabled
    await expect(page.locator('#btn-undo')).toBeEnabled({ timeout: 3000 });

    // Reload
    await page.reload();
    await page.waitForSelector('.tab-nav');

    // After reload, undo stack is gone — button should be disabled.
    // (#btn-undo lives in the global header, present on the Home view too.)
    await expect(page.locator('#btn-undo')).toBeDisabled({ timeout: 3000 });
  });
});

test.describe('E2: Undo/Redo User Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.tab-nav');
    await openParticipantsTab(page);
  });

  test('add participant then undo removes it', async ({ page }) => {
    const baselineCount = await page.locator('table.table-participants tbody tr').count();

    await addParticipant(page, 'UndoMe');

    await expect(page.locator('table.table-participants tbody')).toContainText('UndoMe');

    // Click undo
    await page.click('#btn-undo');

    // Participant should be gone, row count back to baseline
    await expect(page.locator('table.table-participants tbody')).not.toContainText('UndoMe', {
      timeout: 3000,
    });
    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount, {
      timeout: 3000,
    });
  });

  test('undo then redo restores participant', async ({ page }) => {
    await addParticipant(page, 'RedoMe');

    await expect(page.locator('table.table-participants tbody')).toContainText('RedoMe');

    // Undo
    await page.click('#btn-undo');
    await expect(page.locator('table.table-participants tbody')).not.toContainText('RedoMe', {
      timeout: 3000,
    });

    // Redo
    await page.click('#btn-redo');
    await expect(page.locator('table.table-participants tbody')).toContainText('RedoMe');
  });

  test('multiple undos and redos', async ({ page }) => {
    const baselineCount = await page.locator('table.table-participants tbody tr').count();

    // Add 3 participants
    for (const name of ['Multi-A', 'Multi-B', 'Multi-C']) {
      await addParticipant(page, name);
      await expect(page.locator('table.table-participants tbody')).toContainText(name);
    }

    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount + 3);

    // Undo 3 times
    await page.click('#btn-undo');
    await page.click('#btn-undo');
    await page.click('#btn-undo');
    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount, {
      timeout: 3000,
    });

    // Redo 3 times
    await page.click('#btn-redo');
    await page.click('#btn-redo');
    await page.click('#btn-redo');
    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount + 3, {
      timeout: 3000,
    });
  });
});
