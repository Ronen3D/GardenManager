import { expect, test } from '@playwright/test';

/**
 * E2E Persistence Tests
 *
 * Tests that require a real browser environment: localStorage survival across
 * page reload, undo/redo button behaviour.
 *
 * NOTE: When localStorage is empty, the app seeds ~48 default participants.
 * Tests therefore check for specific participant names (not absolute row counts)
 * and compare row counts relative to a baseline.
 */

test.describe('E1: Save/Load Survives Page Reload', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    // Clear prior state and reload for a clean seeded baseline
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.tab-nav');
  });

  test('participant survives page reload', async ({ page }) => {
    // Count baseline rows
    const baselineCount = await page.locator('table.table-participants tbody tr').count();

    // Open add-participant form
    await page.click('[data-action="add-participant"]');
    await page.waitForSelector('#add-participant-form:not(.hidden)');
    await page.fill('[data-field="new-name"]', 'ReloadTestUser');
    await page.click('[data-action="confirm-add-participant"]');

    // Verify participant appears
    await expect(page.locator('table.table-participants tbody')).toContainText('ReloadTestUser');
    await expect(page.locator('table.table-participants tbody tr')).toHaveCount(baselineCount + 1);

    // Reload the page
    await page.reload();
    await page.waitForSelector('.tab-nav');

    // Participant should still be visible after reload
    await expect(page.locator('table.table-participants tbody')).toContainText('ReloadTestUser');
  });

  test('undo stack does not survive reload (in-memory only)', async ({ page }) => {
    // Add a participant so undo becomes available
    await page.click('[data-action="add-participant"]');
    await page.waitForSelector('#add-participant-form:not(.hidden)');
    await page.fill('[data-field="new-name"]', 'UndoReloadTest');
    await page.click('[data-action="confirm-add-participant"]');

    // Undo button should be enabled
    await expect(page.locator('#btn-undo')).toBeEnabled({ timeout: 3000 });

    // Reload
    await page.reload();
    await page.waitForSelector('.tab-nav');

    // After reload, undo stack is gone — button should be disabled
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
  });

  test('add participant then undo removes it', async ({ page }) => {
    const baselineCount = await page.locator('table.table-participants tbody tr').count();

    await page.click('[data-action="add-participant"]');
    await page.waitForSelector('#add-participant-form:not(.hidden)');
    await page.fill('[data-field="new-name"]', 'UndoMe');
    await page.click('[data-action="confirm-add-participant"]');

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
    await page.click('[data-action="add-participant"]');
    await page.waitForSelector('#add-participant-form:not(.hidden)');
    await page.fill('[data-field="new-name"]', 'RedoMe');
    await page.click('[data-action="confirm-add-participant"]');

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
      await page.click('[data-action="add-participant"]');
      await page.waitForSelector('#add-participant-form:not(.hidden)');
      await page.fill('[data-field="new-name"]', name);
      await page.click('[data-action="confirm-add-participant"]');
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
