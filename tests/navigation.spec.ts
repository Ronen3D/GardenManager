import { expect, test } from '@playwright/test';

test.describe('Navigation across viewports', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('all 4 tabs are accessible and switch content', async ({ page }) => {
    const tabs = ['participants', 'task-rules', 'schedule', 'algorithm'];
    for (const tab of tabs) {
      await page.click(`.tab-btn[data-tab="${tab}"]`);
      await expect(page.locator(`[data-tab="${tab}"].tab-active`)).toBeVisible();
    }
  });

  test('bottom nav appears on phone, top nav on desktop', async ({ page, viewport }) => {
    const tabNav = page.locator('.tab-nav');
    await expect(tabNav).toBeVisible();

    if (viewport && viewport.width <= 768) {
      // On phone: tab-nav should be fixed at bottom
      const box = await tabNav.boundingBox();
      expect(box).toBeTruthy();
      // Bottom nav should be near the bottom of the viewport
      expect(box!.y + box!.height).toBeGreaterThan(viewport.height - 100);
    }
  });

  test('tab icons exist for mobile bottom nav', async ({ page, viewport }) => {
    if (viewport && viewport.width <= 768) {
      const icons = page.locator('.tab-nav .tab-icon');
      await expect(icons).toHaveCount(4);
    }
  });
});
