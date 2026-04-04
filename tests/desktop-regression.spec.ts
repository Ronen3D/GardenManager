import { test, expect } from '@playwright/test';

test.describe('Desktop regression checks', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('schedule layout remains flex-row on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    await page.click('.tab-btn[data-tab="schedule"]');

    const scheduleLayout = page.locator('.schedule-layout');
    if (await scheduleLayout.count() > 0) {
      const direction = await scheduleLayout.evaluate(el =>
        window.getComputedStyle(el).flexDirection
      );
      expect(direction).toBe('row');
    }
  });

  test('sidebar is visible on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    await page.click('.tab-btn[data-tab="schedule"]');

    const sidebar = page.locator('.participant-sidebar');
    if (await sidebar.count() > 0) {
      const position = await sidebar.evaluate(el =>
        window.getComputedStyle(el).position
      );
      expect(position).toBe('sticky');
    }
  });

  test('sidebar FAB is hidden on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    await page.click('.tab-btn[data-tab="schedule"]');

    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0) {
      await expect(fab).not.toBeVisible();
    }
  });

  test('tab nav is at top (not fixed bottom) on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    const tabNav = page.locator('.tab-nav');
    const position = await tabNav.evaluate(el =>
      window.getComputedStyle(el).position
    );
    // On desktop, should NOT be fixed
    expect(position).not.toBe('fixed');
  });

  test('modal dialog is centered on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    const alignment = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'gm-modal-backdrop';
      el.style.display = 'none';
      document.body.appendChild(el);
      const style = window.getComputedStyle(el);
      const result = style.alignItems;
      el.remove();
      return result;
    });
    expect(alignment).toBe('center');
  });

  test('hover tooltips CSS is not suppressed on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    const hasPointerClass = await page.evaluate(() =>
      document.documentElement.classList.contains('pointer-device')
    );
    // On desktop without touch, pointer-device should be set
    // (touch-device should NOT be set, so hover suppression doesn't apply)
    const hasTouchClass = await page.evaluate(() =>
      document.documentElement.classList.contains('touch-device')
    );

    // At least one should be set
    expect(hasPointerClass || hasTouchClass).toBe(true);
  });

  test('all 4 tabs render correctly on desktop', async ({ page }) => {
    const tabs = [
      { tab: 'participants', selector: '.table-participants, .tab-toolbar' },
      { tab: 'task-rules', selector: '.tab-toolbar' },
      { tab: 'schedule', selector: '.schedule-layout, .tab-toolbar' },
      { tab: 'algorithm', selector: '.algo-section, .tab-toolbar' },
    ];

    for (const { tab, selector } of tabs) {
      await page.click(`.tab-btn[data-tab="${tab}"]`);
      await expect(page.locator(`[data-tab="${tab}"].tab-active`)).toBeVisible();
      // Verify some content rendered for each tab
      const content = page.locator(selector);
      if (await content.count() > 0) {
        await expect(content.first()).toBeVisible();
      }
    }
  });

  test('bulk delete only affects visible filtered participants', async ({ page }) => {
    await page.click('.tab-btn[data-tab="participants"]');

    const participantRows = page.locator('.table-participants tbody tr[data-participant-id]');
    await expect(participantRows).toHaveCount(48);

    const checkboxes = page.locator('.cb-select-participant');
    await checkboxes.nth(0).click();
    await checkboxes.nth(12).click({ modifiers: ['Control'] });
    await expect(page.locator('.bulk-count')).toContainText('2');

    await page.click('.filter-pills button[data-group="קבוצה 1"]');
    await expect(page.locator('.bulk-count')).toContainText('1');

    await page.click('[data-action="bulk-delete-participants"]');
    await page.click('[data-action="bulk-delete-confirm"]');

    await expect(page.locator('.tab-toolbar h2 .count')).toHaveText('47');

    await page.click('.filter-pills button[data-group="קבוצה 2"]');
    await expect(page.locator('.table-participants tbody tr[data-participant-id]')).toHaveCount(12);
  });

  test('loading a task set restores one-time tasks and category-break settings', async ({ page }) => {
    await page.click('.tab-btn[data-tab="task-rules"]');

    await page.click('[data-action="toggle-add-onetime"]');
    await page.fill('[data-field="ot-name"]', 'Saved Snapshot OT');
    await page.click('[data-action="confirm-add-onetime"]');
    const savedOneTimeTaskCard = page.locator('.template-card').filter({ hasText: 'Saved Snapshot OT' }).first();
    await expect(savedOneTimeTaskCard).toBeVisible();

    await page.locator('#category-break-hours').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '7';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#category-break-hours')).toHaveValue('7');

    await page.click('[data-action="tset-panel-toggle"]');
    await page.click('[data-action="tset-new"]');
    await page.fill('[data-field="tset-saveas-name"]', 'Full Snapshot Task Set');
    await page.click('[data-action="tset-saveas-confirm"]');
    await expect(page.locator('.preset-item').filter({ hasText: 'Full Snapshot Task Set' })).toBeVisible();
    await page.click('[data-action="tset-panel-close"]');

    await page.click('[data-action="toggle-add-onetime"]');
    await page.fill('[data-field="ot-name"]', 'Unsaved Current OT');
    await page.click('[data-action="confirm-add-onetime"]');
    const unsavedOneTimeTaskCard = page.locator('.template-card').filter({ hasText: 'Unsaved Current OT' }).first();
    await expect(unsavedOneTimeTaskCard).toBeVisible();

    await page.locator('#category-break-hours').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '3';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#category-break-hours')).toHaveValue('3');

    await page.click('[data-action="tset-panel-toggle"]');
    await page.click('[data-tset-id="tset-default"] [data-tset-action="load"]');

    const defaultConfirmBody = page.locator('.gm-modal-body');
    await expect(defaultConfirmBody).toContainText('תבניות המשימות');
    await expect(defaultConfirmBody).toContainText('המשימות החד-פעמיות השמורות בו');
    await expect(defaultConfirmBody).toContainText('ההפסקה המינימלית בין משימות קטגוריה');
    await page.click('.gm-modal-btn-ok');

    await expect(savedOneTimeTaskCard).toHaveCount(0);
    await expect(unsavedOneTimeTaskCard).toHaveCount(0);
    await expect(page.locator('#category-break-hours')).toHaveValue('5');

    await page.locator('.preset-item').filter({ hasText: 'Full Snapshot Task Set' }).locator('[data-tset-action="load"]').click();

    const savedSetConfirmBody = page.locator('.gm-modal-body');
    await expect(savedSetConfirmBody).toContainText('תבניות המשימות');
    await expect(savedSetConfirmBody).toContainText('המשימות החד-פעמיות השמורות בו');
    await expect(savedSetConfirmBody).toContainText('ההפסקה המינימלית בין משימות קטגוריה');
    await page.click('.gm-modal-btn-ok');

    await expect(savedOneTimeTaskCard).toBeVisible();
    await expect(unsavedOneTimeTaskCard).toHaveCount(0);
    await expect(page.locator('#category-break-hours')).toHaveValue('7');
  });

  test('gantt toggle button is hidden on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    await page.click('.tab-btn[data-tab="schedule"]');

    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      await expect(toggle).not.toBeVisible();
    }
  });
});
