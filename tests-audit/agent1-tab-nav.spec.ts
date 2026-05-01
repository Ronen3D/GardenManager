import { test, expect, Page } from '@playwright/test';

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

async function setup(page: Page) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
}

test('tab nav: clicking each tab activates it', async ({ page }) => {
  await setup(page);
  for (const tab of ['task-rules', 'schedule', 'algorithm', 'participants']) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await expect(page.locator(`.tab-btn[data-tab="${tab}"]`)).toHaveClass(/tab-active/);
  }
  expect(pageErrors).toEqual([]);
});

test('tab nav: keyboard activation via Enter / Space', async ({ page }) => {
  await setup(page);
  // Try to focus a tab via Tab key, then press Enter / Space
  const taskTab = page.locator('.tab-btn[data-tab="task-rules"]');
  await taskTab.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const isActiveAfterEnter = await taskTab.evaluate((el) => el.classList.contains('tab-active'));

  // Reset
  await page.locator('.tab-btn[data-tab="participants"]').click();
  const algoTab = page.locator('.tab-btn[data-tab="algorithm"]');
  await algoTab.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const isActiveAfterSpace = await algoTab.evaluate((el) => el.classList.contains('tab-active'));

  console.log('Enter activates tab:', isActiveAfterEnter);
  console.log('Space activates tab:', isActiveAfterSpace);
  // We expect both to activate the tab since these are <button>; just record findings.
  expect(isActiveAfterEnter).toBe(true);
  expect(isActiveAfterSpace).toBe(true);
});

test('tab nav: badge counts reflect data', async ({ page }) => {
  await setup(page);
  const participantsCount = await page.locator('.tab-btn[data-tab="participants"] .count').textContent();
  const tasksCount = await page.locator('.tab-btn[data-tab="task-rules"] .count').textContent();
  expect(participantsCount?.trim()).toBe('48');
  expect(tasksCount?.trim()).toBe('8');
});
