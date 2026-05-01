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
  await page.waitForSelector('.tab-nav');
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForSelector('.template-list');
}

test('load-window: add valid window then remove', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();

  // Fill the lw-start, lw-end, lw-weight in the inline add form
  const before = await tpl.locator('[data-action="remove-load-window"]').count();

  const startInput = tpl.locator('[data-field="lw-start"]').first();
  const endInput = tpl.locator('[data-field="lw-end"]').first();
  await startInput.fill('10:00');
  await endInput.fill('12:00');
  await tpl.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);

  const after = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();
  expect(after).toBe(before + 1);

  // Now remove it
  await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').last().click();
  await page.waitForTimeout(500);
  const final = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();
  expect(final).toBe(before);
});

test('load-window: zero-length range rejected', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();
  const before = await tpl.locator('[data-action="remove-load-window"]').count();
  await tpl.locator('[data-field="lw-start"]').first().fill('10:00');
  await tpl.locator('[data-field="lw-end"]').first().fill('10:00');
  await tpl.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);
  const after = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();
  expect(after).toBe(before);
});

test('load-window: invalid time format rejected', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();
  const before = await tpl.locator('[data-action="remove-load-window"]').count();
  await tpl.locator('[data-field="lw-start"]').first().fill('99:99');
  await tpl.locator('[data-field="lw-end"]').first().fill('12:00');
  await tpl.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);
  const after = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();
  expect(after).toBe(before);
});

test('load-window: overlapping window rejected', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();
  // Add a window
  await tpl.locator('[data-field="lw-start"]').first().fill('10:00');
  await tpl.locator('[data-field="lw-end"]').first().fill('12:00');
  await tpl.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);
  const after1 = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();

  // Try overlapping
  const tpl2 = page.locator('.template-card').first();
  await tpl2.locator('[data-field="lw-start"]').first().fill('11:00');
  await tpl2.locator('[data-field="lw-end"]').first().fill('13:00');
  await tpl2.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);
  const after2 = await page.locator('.template-card').first().locator('[data-action="remove-load-window"]').count();
  expect(after2).toBe(after1); // should not have added
});

test('load-window: no console errors throughout', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Add a window
  const tpl = page.locator('.template-card').first();
  await tpl.locator('[data-field="lw-start"]').first().fill('10:00');
  await tpl.locator('[data-field="lw-end"]').first().fill('12:00');
  await tpl.locator('[data-action="add-load-window"]').first().click();
  await page.waitForTimeout(500);
  expect(pageErrors).toEqual([]);
  console.log('console errors:', consoleErrors);
});
