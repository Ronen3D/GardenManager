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
  // Make sure on participants tab
  await page.locator('.tab-btn[data-tab="participants"]').click();
  await page.waitForSelector('.table-participants');
}

test('add participant: form opens, accepts data, persists', async ({ page }) => {
  await setup(page);

  await page.locator('[data-action="add-participant"]').click();
  await expect(page.locator('#add-participant-form')).toBeVisible();

  await page.locator('[data-field="new-name"]').fill('בדיקה1');
  // group: pick first available group
  const groupSelect = page.locator('[data-field="new-group"]');
  const opts = await groupSelect.locator('option').allInnerTexts();
  console.log('groups:', opts);
  // Pick first non-empty option that isn't __new__
  await groupSelect.selectOption({ index: 1 });
  await page.locator('[data-field="new-level"]').selectOption('0');

  // Click confirm
  const initialCount = parseInt(((await page.locator('.tab-btn[data-tab="participants"] .count').textContent()) || '0').trim());
  await page.locator('[data-action="confirm-add-participant"]').click();
  await page.waitForTimeout(500);
  const newCount = parseInt(((await page.locator('.tab-btn[data-tab="participants"] .count').textContent()) || '0').trim());

  console.log(`participants ${initialCount} -> ${newCount}`);
  expect(newCount).toBe(initialCount + 1);
  expect(pageErrors).toEqual([]);
});

test('edit participant: open edit row, change level, save', async ({ page }) => {
  await setup(page);

  // Click edit on first row
  const firstEditBtn = page.locator('[data-action="edit-participant"]').first();
  const pid = await firstEditBtn.getAttribute('data-pid');
  await firstEditBtn.click();

  await expect(page.locator(`tr.row-editing[data-participant-id="${pid}"]`)).toBeVisible();

  // Change level
  const levelSelect = page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-field="level"]`);
  const initialLevel = await levelSelect.inputValue();
  const newLevel = initialLevel === '0' ? '2' : '0';
  await levelSelect.selectOption(newLevel);

  await page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-action="save-participant"]`).click();
  await page.waitForTimeout(300);

  // Verify by reopening
  await page.locator(`tr[data-participant-id="${pid}"] [data-action="edit-participant"]`).click();
  const afterLevel = await page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-field="level"]`).inputValue();
  expect(afterLevel).toBe(newLevel);
  expect(pageErrors).toEqual([]);
});

test('delete participant: confirms then removes', async ({ page }) => {
  await setup(page);

  const initialCount = parseInt(((await page.locator('.tab-btn[data-tab="participants"] .count').textContent()) || '0').trim());

  const firstRemoveBtn = page.locator('[data-action="remove-participant"]').first();
  await firstRemoveBtn.click();

  // Wait for confirm modal
  await page.waitForSelector('.gm-modal-backdrop', { timeout: 2000 });
  // Click confirm button
  const confirm = page.locator('.gm-modal-backdrop button.btn-danger, .gm-modal-backdrop button.btn-primary').first();
  // Look for "הסר" button text
  const removeBtn = page.locator('.gm-modal-backdrop button', { hasText: 'הסר' }).first();
  if (await removeBtn.count() > 0) await removeBtn.click();
  else await confirm.click();
  await page.waitForTimeout(500);

  const newCount = parseInt(((await page.locator('.tab-btn[data-tab="participants"] .count').textContent()) || '0').trim());
  console.log(`participants ${initialCount} -> ${newCount}`);
  expect(newCount).toBe(initialCount - 1);
  expect(pageErrors).toEqual([]);
});

test('toggle blackouts within edit mode (desktop has no row-expand toggle, must use edit row)', async ({ page }) => {
  await setup(page);
  // Open edit on first participant
  await page.locator('[data-action="edit-participant"]').first().click();
  await page.waitForTimeout(200);
  const blackoutToggle = page.locator('[data-action="toggle-blackouts"]').first();
  await expect(blackoutToggle).toBeVisible();
  await blackoutToggle.click();
  await page.waitForTimeout(200);
  await expect(page.locator('tr.row-blackout-expansion').first()).toBeVisible();
});

test('filter by group: click each group pill filters list', async ({ page }) => {
  await setup(page);
  const pills = page.locator('[data-action="filter-group"]');
  const count = await pills.count();
  expect(count).toBeGreaterThan(1);
  // pick second pill (first non-"all" group)
  await pills.nth(1).click();
  await page.waitForTimeout(200);
  await expect(pills.nth(1)).toHaveClass(/pill-active/);
  expect(pageErrors).toEqual([]);
});

test('sort by name: clicking column header reverses order', async ({ page }) => {
  await setup(page);
  const before = await page.locator('tr[data-participant-id] .col-name strong').allTextContents();
  await page.locator('[data-action="sort-column"][data-sort-col="name"]').click();
  await page.waitForTimeout(200);
  const after = await page.locator('tr[data-participant-id] .col-name strong').allTextContents();
  expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
});

test('table-edit mode: enter, edit a cell, save', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="enter-table-edit"]').click();
  await page.waitForTimeout(300);
  // Should now have te-table & te-toolbar
  await expect(page.locator('.te-table')).toBeVisible();
  // Edit name in first row
  const firstNameInput = page.locator('.te-table input[data-te-field="name"]').first();
  await firstNameInput.fill('שם חדש');
  await firstNameInput.dispatchEvent('input');
  // Try save
  await page.locator('[data-te-action="save"]').click();
  await page.waitForTimeout(500);
  // Confirm dialog may appear; if so accept
  const confirmDialog = page.locator('.gm-modal-backdrop button.btn-primary, .gm-modal-backdrop button', { hasText: 'אישור' }).first();
  if (await confirmDialog.count() > 0 && await confirmDialog.isVisible()) {
    await confirmDialog.click();
    await page.waitForTimeout(500);
  }
  // Should have exited table-edit
  expect(pageErrors).toEqual([]);
});

test('table-edit mode: cancel exits without saving', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="enter-table-edit"]').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.te-table')).toBeVisible();
  await page.locator('[data-te-action="cancel"]').click();
  await page.waitForTimeout(300);
  // Back to participants table
  await expect(page.locator('.table-participants')).toBeVisible();
});

test('table-edit mode: add-row button', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="enter-table-edit"]').click();
  await page.waitForTimeout(300);
  const before = await page.locator('.te-table tbody tr.te-row').count();
  await page.locator('[data-te-action="add-row"]').first().click();
  await page.waitForTimeout(200);
  const after = await page.locator('.te-table tbody tr.te-row').count();
  expect(after).toBe(before + 1);
});

test('participant sets panel toggle', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="pset-panel-toggle"]').click();
  await page.waitForTimeout(300);
  const panel = page.locator('[data-action="pset-panel-close"]');
  await expect(panel).toBeVisible();
  // Click "+ save new set"
  await page.locator('[data-action="pset-new"]').click();
  await page.waitForTimeout(200);
  const nameInput = page.locator('[data-field="pset-saveas-name"]');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('בדיקה');
  await page.locator('[data-action="pset-saveas-confirm"]').click();
  await page.waitForTimeout(300);
  expect(pageErrors).toEqual([]);
});

test('select-all checkbox toggles', async ({ page }) => {
  await setup(page);
  await page.locator('#cb-select-all').click();
  await page.waitForTimeout(200);
  const checkedCount = await page.locator('.cb-select-participant:checked').count();
  expect(checkedCount).toBeGreaterThan(0);

  // Bulk toolbar should appear
  await expect(page.locator('.bulk-toolbar')).toBeVisible();

  // Click clear-selection
  await page.locator('[data-action="bulk-clear-selection"]').click();
  await page.waitForTimeout(200);
  const checkedAfter = await page.locator('.cb-select-participant:checked').count();
  expect(checkedAfter).toBe(0);
});

test('bulk add unavailability dialog opens', async ({ page }) => {
  await setup(page);
  await page.locator('#cb-select-all').click();
  await page.waitForTimeout(100);
  await page.locator('[data-action="bulk-add-unavailability"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('[data-action="bulk-dialog-save"]')).toBeVisible();
  await page.locator('[data-action="bulk-dialog-cancel"]').click();
});

test('toggle-all-details exists but is hidden on desktop (mobile-only by design)', async ({ page }) => {
  await setup(page);
  // The button has class .btn-expand-all-mobile which is display:none on desktop.
  const btn = page.locator('[data-action="toggle-all-details"]');
  expect(await btn.count()).toBeGreaterThan(0);
  // Confirm it is intentionally hidden
  const visible = await btn.isVisible();
  expect(visible).toBe(false);
});

test('console errors during page load', async ({ page }) => {
  await setup(page);
  await page.waitForTimeout(1000);
  console.log('CE:', consoleErrors);
  console.log('PE:', pageErrors);
  expect(pageErrors).toEqual([]);
});
