import { test, expect } from '@playwright/test';
test('probe', async ({ page }) => {
  await page.goto('http://localhost:5174/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
  const tabs = await page.locator('.tab-btn').allTextContents();
  const viewMode = await page.evaluate(() => document.documentElement.classList.contains('pointer-device') ? 'pointer' : 'touch');
  console.log('TABS:', JSON.stringify(tabs));
  console.log('VIEW:', viewMode);
});
