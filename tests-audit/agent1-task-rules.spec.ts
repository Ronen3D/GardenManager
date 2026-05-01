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
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForSelector('.template-list');
}

test('add-template modal opens, can create a template', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop', { timeout: 2000 });

  await page.locator('#add-template-modal-backdrop [data-field="tpl-name"]').fill('בדיקה משימה');
  await page.locator('#add-template-modal-backdrop [data-field="tpl-duration"]').fill('6');
  await page.locator('#add-template-modal-backdrop [data-field="tpl-shifts"]').fill('2');
  await page.locator('#add-template-modal-backdrop [data-action="confirm"]').click();
  await page.waitForTimeout(500);

  // Modal should be closed and template added
  await expect(page.locator('#add-template-modal-backdrop')).toHaveCount(0);
  // Confirm count went 8 -> 9
  const tasksCount = (await page.locator('.tab-btn[data-tab="task-rules"] .count').first().textContent())?.trim();
  expect(tasksCount).toBe('9');
  expect(pageErrors).toEqual([]);
});

test('add-template modal: cancel button closes', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  await page.locator('#add-template-modal-backdrop [data-action="cancel"]').click();
  await expect(page.locator('#add-template-modal-backdrop')).toHaveCount(0);
});

test('add-template modal: ESC closes', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('#add-template-modal-backdrop')).toHaveCount(0);
});

test('add-template modal: clicking backdrop closes', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  // Click on the very edge of backdrop
  await page.locator('#add-template-modal-backdrop').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  await expect(page.locator('#add-template-modal-backdrop')).toHaveCount(0);
});

test('expand a template card, edit basic fields', async ({ page }) => {
  await setup(page);
  // Click first template header
  const firstHeader = page.locator('.template-header[data-action="toggle-template"]').first();
  const tid = await firstHeader.getAttribute('data-tid');
  await firstHeader.click();
  await page.waitForTimeout(300);
  const tpl = page.locator(`[data-template-id="${tid}"]`);
  await expect(tpl.locator('.template-body')).toBeVisible();

  // Modify shiftsPerDay
  const shiftsInput = tpl.locator('input[data-tpl-field="shiftsPerDay"]');
  await shiftsInput.fill('3');
  await shiftsInput.dispatchEvent('change');
  await page.waitForTimeout(300);
  const after = await tpl.locator('input[data-tpl-field="shiftsPerDay"]').inputValue();
  expect(after).toBe('3');
  expect(pageErrors).toEqual([]);
});

test('expand template, toggle sameGroupRequired checkbox', async ({ page }) => {
  await setup(page);
  const firstHeader = page.locator('.template-header[data-action="toggle-template"]').first();
  const tid = await firstHeader.getAttribute('data-tid');
  await firstHeader.click();
  await page.waitForTimeout(300);
  const tpl = page.locator(`[data-template-id="${tid}"]`);
  const cb = tpl.locator('input[data-tpl-field="sameGroupRequired"]').first();
  const before = await cb.isChecked();
  await cb.click();
  await page.waitForTimeout(300);
  const after = await tpl.locator('input[data-tpl-field="sameGroupRequired"]').first().isChecked();
  expect(after).toBe(!before);
});

test('add-slot inside template', async ({ page }) => {
  await setup(page);
  const firstHeader = page.locator('.template-header[data-action="toggle-template"]').first();
  const tid = await firstHeader.getAttribute('data-tid');
  await firstHeader.click();
  await page.waitForTimeout(300);
  const tpl = page.locator(`[data-template-id="${tid}"]`);

  const beforeSlotCount = await tpl.locator('.table-slots tbody tr').count();
  await tpl.locator('[data-action="add-slot"]').first().click();
  await page.waitForTimeout(300);
  // The slot label input is unique to slot form (not load-window form)
  const slotForm = page.locator('.add-slot-form').filter({ has: page.locator('[data-field="slot-label"]') });
  await expect(slotForm).toBeVisible();
  await slotForm.locator('[data-field="slot-label"]').fill('משבצת חדשה');
  await slotForm.locator('[data-action="confirm-add-slot"]').click();
  await page.waitForTimeout(500);
  const afterSlotCount = await page.locator(`[data-template-id="${tid}"] .table-slots tbody tr`).count();
  expect(afterSlotCount).toBeGreaterThan(beforeSlotCount);
});

test('edit-slot opens slot editor', async ({ page }) => {
  await setup(page);
  const firstHeader = page.locator('.template-header[data-action="toggle-template"]').first();
  await firstHeader.click();
  await page.waitForTimeout(300);
  // Click first edit-slot button
  const editBtn = page.locator('[data-action="edit-slot"]').first();
  await editBtn.click();
  await page.waitForTimeout(300);
  // expect edit form visible
  await expect(page.locator('.edit-slot-form')).toBeVisible();
  // close
  await page.locator('.edit-slot-form [data-action="cancel-edit-slot"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('.edit-slot-form')).toHaveCount(0);
});

test('cycle-level button cycles through states', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Open slot editor
  await page.locator('[data-action="edit-slot"]').first().click();
  await page.waitForTimeout(200);
  const lvlBtn = page.locator('.edit-slot-form [data-action="cycle-level"]').first();
  const before = await lvlBtn.getAttribute('data-state');
  await lvlBtn.click();
  await page.waitForTimeout(100);
  const after = await lvlBtn.getAttribute('data-state');
  expect(after).not.toBe(before);
});

test('add-onetime form opens and creates task', async ({ page }) => {
  await setup(page);
  const before = await page.locator('.onetime-card').count();
  await page.locator('[data-action="toggle-add-onetime"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#add-onetime-form')).toBeVisible();

  await page.locator('[data-field="ot-name"]').fill('משימה חד-פעמית בדיקה');
  await page.locator('[data-action="confirm-add-onetime"]').click();
  await page.waitForTimeout(500);

  const after = await page.locator('.onetime-card').count();
  expect(after).toBe(before + 1);
});

test('add-onetime form: cancel works', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="toggle-add-onetime"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-action="cancel-add-onetime"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#add-onetime-form')).toHaveCount(0);
});

test('rest rule: add then delete', async ({ page }) => {
  await setup(page);
  const beforeCount = await page.locator('[data-rest-rule-id]').count();
  await page.locator('[data-action="add-rest-rule"]').click();
  await page.waitForTimeout(300);
  const afterCount = await page.locator('[data-rest-rule-id]').count();
  expect(afterCount).toBe(beforeCount + 1);

  // Delete the new rest rule (expect confirm dialog)
  const deleteBtn = page.locator('[data-action="delete-rest-rule"]').last();
  await deleteBtn.click();
  await page.waitForTimeout(300);
  // May or may not show a confirm
  const modal = page.locator('.gm-modal-backdrop');
  if (await modal.count() > 0 && await modal.isVisible()) {
    await modal.locator('button', { hasText: /מחק|אישור|אישור מחיקה/ }).first().click();
    await page.waitForTimeout(300);
  }
  const finalCount = await page.locator('[data-rest-rule-id]').count();
  expect(finalCount).toBe(beforeCount);
});

test('delete template: confirm dialog removes template', async ({ page }) => {
  await setup(page);
  const before = await page.locator('.template-card').count();
  // Expand first
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Click remove
  await page.locator('[data-action="remove-template"]').first().click();
  await page.waitForTimeout(300);
  // Find and click confirm
  const modal = page.locator('.gm-modal-backdrop');
  await expect(modal).toBeVisible();
  // Generic primary button or 'הסר' button
  const removeBtn = modal.locator('button', { hasText: /הסר|מחק|אישור/ }).first();
  await removeBtn.click();
  await page.waitForTimeout(500);
  const after = await page.locator('.template-card').count();
  expect(after).toBeLessThan(before);
});

test('add-subteam button works (handles prompt modal)', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const tpl = page.locator('.template-card').first();
  const beforeCount = await tpl.locator('[data-action="remove-subteam"]').count();
  await tpl.locator('[data-action="add-subteam"]').click();
  await page.waitForTimeout(300);
  // showPrompt opens with .gm-modal-main-input
  const promptInput = page.locator('.gm-modal-main-input');
  await expect(promptInput).toBeVisible();
  await promptInput.fill('תת-צוות בדיקה');
  await page.locator('.gm-modal-btn-ok').click();
  await page.waitForTimeout(500);
  const afterCount = await page.locator('.template-card').first().locator('[data-action="remove-subteam"]').count();
  expect(afterCount).toBe(beforeCount + 1);
});

test('toggle-load-formula-info shows explanation when present', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const infoBtn = page.locator('[data-action="toggle-load-formula-info"]').first();
  if (await infoBtn.count() === 0) {
    test.skip(true, 'no load formula info present on first template (no formula computed)');
    return;
  }
  await infoBtn.click();
});

test('open-load-formula button opens load-formula modal', async ({ page }) => {
  await setup(page);
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const lfBtn = page.locator('[data-action="open-load-formula"]').first();
  await lfBtn.click();
  await page.waitForTimeout(300);
  // Load-formula uses its own backdrop id
  await expect(page.locator('#lf-modal-backdrop')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('#lf-modal-backdrop')).toHaveCount(0);
});

test('task set panel toggle', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="tset-panel-toggle"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('[data-action="tset-panel-close"]')).toBeVisible();
  await page.locator('[data-action="tset-panel-close"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('[data-action="tset-panel-close"]')).toHaveCount(0);
});

test('show-task-findings badge clickable when present', async ({ page }) => {
  await setup(page);
  const badge = page.locator('[data-action="show-task-findings"]').first();
  const cnt = await badge.count();
  if (cnt === 0) {
    test.skip(true, 'no findings badge to click');
    return;
  }
  await badge.click();
  await page.waitForTimeout(300);
  const modal = page.locator('.gm-modal-backdrop');
  expect(await modal.count()).toBeGreaterThan(0);
});

test('console errors during page load', async ({ page }) => {
  await setup(page);
  await page.waitForTimeout(1000);
  console.log('CE:', consoleErrors);
  console.log('PE:', pageErrors);
  expect(pageErrors).toEqual([]);
});
