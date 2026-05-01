import { test, expect, Page } from '@playwright/test';

async function setup(page: Page, tab = 'task-rules') {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav');
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
}

test('recurring template: name has no editable input nor rename button', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();
  // Look for any input with data-tpl-field="name" or similar
  const nameInputs = await tpl.locator('input[data-tpl-field="name"]').count();
  const renameBtns = await tpl.locator('[data-action="rename-template"], [data-action="edit-template-name"]').count();
  expect(nameInputs).toBe(0);
  expect(renameBtns).toBe(0);
  // The only ways to handle this are: delete & re-add, OR the user can never rename.
});

test('one-time task: name IS editable via input', async ({ page }) => {
  await setup(page);
  // Create one-time task first
  await page.locator('[data-action="toggle-add-onetime"]').click();
  await page.locator('[data-field="ot-name"]').fill('OT-Test');
  await page.locator('[data-action="confirm-add-onetime"]').click();
  await page.waitForTimeout(500);
  // Expand it
  await page.locator('.onetime-card .template-header').first().click();
  await page.waitForTimeout(300);
  const nameInput = page.locator('input[data-ot-field="name"]');
  await expect(nameInput).toBeVisible();
});
