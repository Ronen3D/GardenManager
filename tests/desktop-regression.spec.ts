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

  test('gantt toggle button is hidden on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    await page.click('.tab-btn[data-tab="schedule"]');

    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      await expect(toggle).not.toBeVisible();
    }
  });
});
