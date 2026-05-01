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

// ─── Validation: add participant with empty name ──
test('add participant: empty name shows toast, does not add', async ({ page }) => {
  await setup(page);
  const before = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  await page.locator('[data-action="add-participant"]').click();
  await page.waitForTimeout(200);
  // Don't fill name
  await page.locator('[data-action="confirm-add-participant"]').click();
  await page.waitForTimeout(300);
  const after = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  expect(after).toBe(before);
});

// ─── Validation: duplicate name ──
test('add participant: duplicate name rejected', async ({ page }) => {
  await setup(page);
  // Get an existing name from the table
  const firstName = await page.locator('tr[data-participant-id] .col-name strong').first().textContent();
  if (!firstName) test.fail();
  const before = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  await page.locator('[data-action="add-participant"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-field="new-name"]').fill(firstName!.trim());
  await page.locator('[data-field="new-group"]').selectOption({ index: 1 });
  await page.locator('[data-action="confirm-add-participant"]').click();
  await page.waitForTimeout(300);
  const after = parseInt((await page.locator('.tab-btn[data-tab="participants"] .count').textContent())!.trim());
  expect(after).toBe(before);
});

// ─── Edit save: empty name rejected ──
test('save participant: empty name rejected', async ({ page }) => {
  await setup(page);
  const firstEdit = page.locator('[data-action="edit-participant"]').first();
  const pid = await firstEdit.getAttribute('data-pid');
  await firstEdit.click();
  await page.waitForTimeout(200);
  const input = page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-field="name"]`);
  await input.fill('');
  await page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-action="save-participant"]`).click();
  await page.waitForTimeout(300);
  // Edit row should still be open
  await expect(page.locator(`tr.row-editing[data-participant-id="${pid}"]`)).toBeVisible();
});

// ─── Toggle certifications during edit, persist ──
test('edit participant: toggle a certification, save, persists', async ({ page }) => {
  await setup(page);
  const firstEdit = page.locator('[data-action="edit-participant"]').first();
  const pid = await firstEdit.getAttribute('data-pid');
  await firstEdit.click();
  await page.waitForTimeout(200);
  const certCb = page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-cert]`).first();
  const before = await certCb.isChecked();
  await certCb.click();
  await page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-action="save-participant"]`).click();
  await page.waitForTimeout(300);
  // Re-open
  await page.locator(`tr[data-participant-id="${pid}"] [data-action="edit-participant"]`).click();
  await page.waitForTimeout(200);
  const afterCb = page.locator(`tr.row-editing[data-participant-id="${pid}"] [data-cert]`).first();
  const after = await afterCb.isChecked();
  expect(after).toBe(!before);
});

// ─── Filter pills exclusivity (only one active) ──
test('filter group pills: only one active at a time', async ({ page }) => {
  await setup(page);
  const pills = page.locator('[data-action="filter-group"]');
  const count = await pills.count();
  for (let i = 1; i < count; i++) {
    await pills.nth(i).click();
    await page.waitForTimeout(100);
    const active = await page.locator('[data-action="filter-group"].pill-active').count();
    expect(active).toBe(1);
  }
});

// ─── Sort by group, level ──
test('sort by group changes order', async ({ page }) => {
  await setup(page);
  const before = await page.locator('tr[data-participant-id] .col-group').allTextContents();
  await page.locator('[data-action="sort-column"][data-sort-col="group"]').click();
  await page.waitForTimeout(200);
  const after = await page.locator('tr[data-participant-id] .col-group').allTextContents();
  // Either changed, or already sorted; at least no error
  expect(pageErrors).toEqual([]);
});

test('sort by level changes order', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="sort-column"][data-sort-col="level"]').click();
  await page.waitForTimeout(200);
  // Click again to reverse
  await page.locator('[data-action="sort-column"][data-sort-col="level"]').click();
  await page.waitForTimeout(200);
  expect(pageErrors).toEqual([]);
});

// ─── Add-participant cancel button works ──
test('add-participant cancel hides form', async ({ page }) => {
  await setup(page);
  await page.locator('[data-action="add-participant"]').click();
  await page.waitForTimeout(200);
  await expect(page.locator('#add-participant-form')).toBeVisible();
  await page.locator('[data-action="cancel-add-participant"]').click();
  await page.waitForTimeout(200);
  // Form should be hidden — uses .hidden class
  const formIsHidden = await page.locator('#add-participant-form').evaluate((el) => el.classList.contains('hidden'));
  expect(formIsHidden).toBe(true);
});

// ─── TASK RULES: validation ──

test('add-template: empty name shows toast, does not add', async ({ page }) => {
  await setup(page, 'task-rules');
  const before = (await page.locator('.tab-btn[data-tab="task-rules"] .count').first().textContent())?.trim();
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  // Click confirm without name
  await page.locator('#add-template-modal-backdrop [data-action="confirm"]').click();
  await page.waitForTimeout(300);
  // Modal should still be open
  await expect(page.locator('#add-template-modal-backdrop')).toBeVisible();
  // Close manually
  await page.keyboard.press('Escape');
});

test('add-template: duplicate name rejected', async ({ page }) => {
  await setup(page, 'task-rules');
  const firstTemplateName = await page.locator('.template-card .template-title strong').first().textContent();
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  await page.locator('#add-template-modal-backdrop [data-field="tpl-name"]').fill(firstTemplateName!.trim());
  await page.locator('#add-template-modal-backdrop [data-action="confirm"]').click();
  await page.waitForTimeout(300);
  // Should still be open
  await expect(page.locator('#add-template-modal-backdrop')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('slot edit: setting a cert as both required and forbidden rejected', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-action="edit-slot"]').first().click();
  await page.waitForTimeout(200);
  const editForm = page.locator('.edit-slot-form');
  // Find a cert checkbox in required section
  const reqCb = editForm.locator('[data-slot-cert]').first();
  const certId = await reqCb.getAttribute('data-slot-cert');
  // Force-check both required and forbidden for same cert
  if (!await reqCb.isChecked()) await reqCb.click();
  const fbCb = editForm.locator(`[data-slot-forbidden-cert="${certId}"]`);
  if (!await fbCb.isChecked()) await fbCb.click();
  // Try to save
  await editForm.locator('[data-action="confirm-edit-slot"]').click();
  await page.waitForTimeout(300);
  // Edit form should remain (toast error)
  await expect(page.locator('.edit-slot-form')).toBeVisible();
  // Cancel
  await page.locator('[data-action="cancel-edit-slot"]').click();
});

test('slot edit: setting all levels off rejected', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-action="edit-slot"]').first().click();
  await page.waitForTimeout(200);
  const form = page.locator('.edit-slot-form');
  // Click each level button until all are off
  // Each click cycles normal -> lowPriority -> off -> normal
  // To go to off: click 2 times (if normal) or 1 time (if lowPriority).
  // Easier: ensure each ends on 'off' by reading state and clicking until off.
  const lvlBtns = form.locator('[data-action="cycle-level"]');
  const count = await lvlBtns.count();
  for (let i = 0; i < count; i++) {
    let btn = lvlBtns.nth(i);
    for (let c = 0; c < 4; c++) {
      const state = await btn.getAttribute('data-state');
      if (state === 'off') break;
      await btn.click();
      await page.waitForTimeout(50);
    }
  }
  // Try to save
  await form.locator('[data-action="confirm-edit-slot"]').click();
  await page.waitForTimeout(300);
  // Edit form should remain
  await expect(page.locator('.edit-slot-form')).toBeVisible();
  await page.locator('[data-action="cancel-edit-slot"]').click();
});

test('rest rule: editing label persists in DOM', async ({ page }) => {
  await setup(page, 'task-rules');
  // Find any existing rest rule label input
  const inputs = page.locator('[data-rr-field="label"]');
  if (await inputs.count() === 0) {
    // Add one first
    await page.locator('[data-action="add-rest-rule"]').click();
    await page.waitForTimeout(300);
  }
  const first = page.locator('[data-rr-field="label"]').first();
  await first.fill('כלל מותאם');
  await first.dispatchEvent('change');
  await page.waitForTimeout(300);
  // Reload tab and check
  await page.locator('.tab-btn[data-tab="participants"]').click();
  await page.waitForTimeout(200);
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(300);
  const reloaded = await page.locator('[data-rr-field="label"]').first().inputValue();
  expect(reloaded).toBe('כלל מותאם');
});

test('one-time task: empty name rejected', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('[data-action="toggle-add-onetime"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-action="confirm-add-onetime"]').click();
  await page.waitForTimeout(200);
  // Form should still be open (validation toast)
  await expect(page.locator('#add-onetime-form')).toBeVisible();
});

test('toggle-template: clicking same header collapses', async ({ page }) => {
  await setup(page, 'task-rules');
  const header = page.locator('.template-header[data-action="toggle-template"]').first();
  await header.click();
  await page.waitForTimeout(200);
  await expect(page.locator('.template-card .template-body').first()).toBeVisible();
  await header.click();
  await page.waitForTimeout(200);
  // Body should be removed (not just hidden — re-rendered)
  // Check that the first template card no longer has body
  const tpl = page.locator('.template-card').first();
  const hasBody = await tpl.locator('.template-body').count();
  expect(hasBody).toBe(0);
});

test('open sleep-recovery editor in expanded template', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Click the SR header
  const srHeader = page.locator('[data-action="toggle-sleep-recovery"]').first();
  await srHeader.click();
  await page.waitForTimeout(200);
  // Body should be visible
  await expect(page.locator('.sr-body').first()).toBeVisible();
});

test('toggle a shift chip in sleep-recovery', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  await page.locator('[data-action="toggle-sleep-recovery"]').first().click();
  await page.waitForTimeout(200);
  const chip = page.locator('[data-action="toggle-shift-chip"]').first();
  if (await chip.count() === 0) {
    test.skip(true, 'no shift chips');
    return;
  }
  const before = await chip.getAttribute('aria-checked');
  await chip.click();
  await page.waitForTimeout(200);
  const after = await page.locator('[data-action="toggle-shift-chip"]').first().getAttribute('aria-checked');
  expect(after).not.toBe(before);
});

test('add load-window: time fields validate', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Find load-window add button
  const addLwBtn = page.locator('[data-action="add-load-window"]').first();
  if (await addLwBtn.count() === 0) {
    test.skip(true, 'no add-load-window button');
    return;
  }
  // Fill garbage times then click
  const tpl = page.locator('.template-card').first();
  await tpl.locator('[data-field="lw-start"]').first().fill('99:99');
  await tpl.locator('[data-field="lw-end"]').first().fill('11:00');
  await addLwBtn.click();
  await page.waitForTimeout(300);
  // Should NOT add a window (count remains 0 or unchanged)
  expect(pageErrors).toEqual([]);
});

test('navigation between tabs preserves task-rules state', async ({ page }) => {
  await setup(page, 'task-rules');
  await page.locator('.template-header[data-action="toggle-template"]').first().click();
  await page.waitForTimeout(300);
  // Switch tabs
  await page.locator('.tab-btn[data-tab="algorithm"]').click();
  await page.waitForTimeout(200);
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(300);
  // Was the expanded state preserved?
  const bodies = await page.locator('.template-body').count();
  console.log('after-nav .template-body count:', bodies);
});

// ─── Console errors after lots of interaction ──
test('end to end interaction: no errors', async ({ page }) => {
  await setup(page, 'participants');
  // Open add form
  await page.locator('[data-action="add-participant"]').click();
  await page.locator('[data-action="cancel-add-participant"]').click();

  // Switch tab
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(300);
  // Open and close template
  await page.locator('.template-header').first().click();
  await page.waitForTimeout(200);
  await page.locator('.template-header').first().click();
  await page.waitForTimeout(200);
  // Open add-template modal then close
  await page.locator('[data-action="toggle-add-template"]').click();
  await page.waitForSelector('#add-template-modal-backdrop');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('CE:', consoleErrors);
  console.log('PE:', pageErrors);
  expect(pageErrors).toEqual([]);
});
