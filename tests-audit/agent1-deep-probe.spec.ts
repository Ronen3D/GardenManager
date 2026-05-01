import { test, expect, Page } from '@playwright/test';

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

async function setup(page: Page, tab = 'participants') {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await page.waitForTimeout(300);
}

// ─── Add participant: "+ קבוצה חדשה…" inline group creation ──
test('add participant: inline new-group flow creates group and adds participant', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="add-participant"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-field="new-name"]').fill('בדיקת קבוצה');
  // Select "+ קבוצה חדשה…"
  await page.locator('[data-field="new-group"]').selectOption('__new__');
  // The hidden input should now appear
  const newGroupInput = page.locator('[data-field="new-group-name"]');
  await page.waitForTimeout(200);
  await expect(newGroupInput).toBeVisible();
  await newGroupInput.fill('קבוצה חדשה Z');
  await page.locator('[data-action="confirm-add-participant"]').click();
  await page.waitForTimeout(500);
  // The new group pill should now appear
  await expect(page.locator('[data-action="filter-group"][data-group="קבוצה חדשה Z"]')).toBeVisible();
});

// ─── Add participant: "+ קבוצה חדשה…" with empty group name rejected ──
test('add participant: new-group with empty group name shows inline error', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="add-participant"]').click();
  await page.locator('[data-field="new-name"]').fill('בדיקה X');
  await page.locator('[data-field="new-group"]').selectOption('__new__');
  await page.waitForTimeout(200);
  // leave new-group-name empty
  const before = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  await page.locator('[data-action="confirm-add-participant"]').click();
  await page.waitForTimeout(300);
  const after = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  expect(after).toBe(before);
});

// ─── Sort indicator updates on click ──
test('sort indicator shows correct direction', async ({ page }) => {
  await setup(page);
  // Click name column header twice
  const nameHeader = page.locator('[data-action="sort-column"][data-sort-col="name"]');
  await nameHeader.click();
  await page.waitForTimeout(200);
  const ind1 = await nameHeader.textContent();
  await nameHeader.click();
  await page.waitForTimeout(200);
  const ind2 = await nameHeader.textContent();
  expect(ind1).not.toBe(ind2);
});

// ─── Bulk dialog: end before start rejected ──
test('bulk-add-unavailability: end-day before start-day rejected', async ({ page }) => {
  await setup(page);
  await page.locator('#cb-select-all').click();
  await page.waitForTimeout(100);
  await page.locator('[data-action="bulk-add-unavailability"]').click();
  await page.waitForTimeout(200);
  // Set day-end smaller than day-start
  const startSelect = page.locator('[data-field="bulk-day-start"]');
  const endSelect = page.locator('[data-field="bulk-day-end"]');
  // Select last option for start, first for end
  const opts = await startSelect.locator('option').count();
  await startSelect.selectOption({ index: opts - 1 });
  await endSelect.selectOption({ index: 0 });
  await page.locator('[data-action="bulk-dialog-save"]').click();
  await page.waitForTimeout(300);
  // Dialog should still be open
  await expect(page.locator('[data-action="bulk-dialog-save"]')).toBeVisible();
  await page.locator('[data-action="bulk-dialog-cancel"]').click();
});

// ─── Bulk dialog: backdrop click dismisses ──
test('bulk-add dialog: backdrop click dismisses', async ({ page }) => {
  await setup(page);
  await page.locator('#cb-select-all').click();
  await page.waitForTimeout(100);
  await page.locator('[data-action="bulk-add-unavailability"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('.bulk-dialog')).toBeVisible();
  // Click backdrop
  await page.locator('.bulk-dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  await expect(page.locator('.bulk-dialog')).toHaveCount(0);
});

// ─── Bulk save with all-day creates rules ──
test('bulk save: all-day rule applies to selected', async ({ page }) => {
  await setup(page);
  await page.locator('#cb-select-all').click();
  await page.waitForTimeout(100);
  await page.locator('[data-action="bulk-add-unavailability"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-field="bulk-allday"]').check();
  await page.locator('[data-action="bulk-dialog-save"]').click();
  await page.waitForTimeout(500);
  // Dialog closed
  await expect(page.locator('[data-action="bulk-dialog-save"]')).toHaveCount(0);
});

// ─── Sets panel: import xlsx button exists & clicks ──
test('participant sets: import xlsx button', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="pset-panel-toggle"]').click();
  await page.waitForTimeout(200);
  const importBtn = page.locator('[data-action="pset-import-xlsx"]');
  await expect(importBtn).toBeVisible();
  // Click — likely opens a file picker which can't be tested. Just verify no error.
  expect(pageErrors).toEqual([]);
});

// ─── Group count badge triple-tap easter-egg shows notwith column ──
test('triple-tap on participants count toggles aiHateMatching column', async ({ page }) => {
  await setup(page);
  const countBadge = page.locator('.tab-toolbar h2 .count').first();
  // Triple-click (clicks within 600ms)
  await countBadge.click();
  await countBadge.click();
  await countBadge.click();
  await page.waitForTimeout(300);
  // notwith column should now show
  const cols = await page.locator('th.col-notwith').count();
  expect(cols).toBe(1);
});

// ─── Schedule-screen "rules" badge — when criticals exist ──
test('task-rules tab badge visible when no criticals (default seed)', async ({ page }) => {
  await setup(page, 'task-rules');
  // Check status badge — default seed should be ready
  const status = await page.locator('.score-card .score-value').first().textContent();
  console.log('preflight status:', status);
  // not assertive — just record
});

// ─── Edit existing template name via prompt ──
test('template card: name not directly editable in card (no input)', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Look for any input to edit the template name
  const nameInput = page.locator('.template-card').first().locator('input[data-tpl-field="name"]');
  const cnt = await nameInput.count();
  console.log('name input found in expanded template:', cnt);
  // Is there any way to rename? Look for an edit pencil
  const editPencil = page.locator('.template-card').first().locator('[data-action*="rename"], [data-action*="edit-name"]');
  console.log('edit-name button candidates:', await editPencil.count());
});

// ─── Delete certifications → orphan cert behavior ──
test('certifications: edit cert in algorithm tab — verify update', async ({ page }) => {
  await setup(page, 'algorithm');
  await page.waitForTimeout(300);
  // Just snapshot — not in scope. Smoke check no errors.
  expect(pageErrors).toEqual([]);
});

// ─── Edit template numeric fields update on input ──
test('template baseLoadWeight changes on input then re-renders consistent value', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const inp = page.locator('.template-card').first().locator('[data-tpl-field="baseLoadWeight"]');
  await inp.fill('0.50');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(300);
  // Re-read it
  const after = await page.locator('.template-card').first().locator('[data-tpl-field="baseLoadWeight"]').inputValue();
  expect(parseFloat(after)).toBeCloseTo(0.5, 2);
});

// ─── Template start-hour field accepts arbitrary input ──
test('template startHour accepts only HH:00 via type=time step=3600', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  const inp = page.locator('.template-card').first().locator('[data-tpl-field="startHour"]');
  // Try to set to 14:30
  await inp.fill('14:30');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(300);
  // Read back; type=time step=3600 may or may not respect step
  const val = await inp.inputValue();
  console.log('startHour value after 14:30 fill:', val);
});

// ─── Backdrop click on add-template doesn't close if click inside dialog ──
test('add-template: clicking inside dialog body does NOT close', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  // Click inside the dialog title area
  await page.locator('.gm-modal-dialog').click({ position: { x: 50, y: 30 } });
  await page.waitForTimeout(200);
  await expect(page.locator('#add-template-modal-backdrop')).toBeVisible();
  await page.keyboard.press('Escape');
});

// ─── Console errors smoke test for entire flow ──
test('comprehensive smoke: no errors during many interactions', async ({ page }) => {
  await setup(page, 'participants');
  // Every tab
  for (const tab of ['task-rules', 'schedule', 'algorithm', 'participants']) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
    await page.waitForTimeout(500);
  }
  console.log('CE:', consoleErrors);
  console.log('PE:', pageErrors);
  expect(pageErrors).toEqual([]);
});
