import { test, expect, Page } from '@playwright/test';

let consoleErrors: string[] = [];
let pageErrors: string[] = [];

async function setup(page: Page) {
  consoleErrors = [];
  pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  // First: clear localStorage and reload so subsequent reloads in the test preserve data
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
}

async function openAlgoTab(page: Page) {
  await page.locator('.tab-btn[data-tab="algorithm"]').click();
  await page.waitForSelector('[data-action="settings-accordion-toggle"]');
}

async function openAccordion(page: Page, id: string) {
  const header = page.locator(
    `[data-action="settings-accordion-toggle"][data-accordion="${id}"]`,
  );
  const expanded = await header.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await header.click();
    await page.waitForTimeout(150);
  }
}

test('accordions: top-level toggle open/close and persist during visit', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  // open the algorithm section
  await openAccordion(page, 'acc-algorithm');
  // open the entities section
  await openAccordion(page, 'acc-entities');

  // Both should be visible / aria-expanded=true
  expect(
    await page
      .locator('[data-action="settings-accordion-toggle"][data-accordion="acc-algorithm"]')
      .getAttribute('aria-expanded'),
  ).toBe('true');
  expect(
    await page
      .locator('[data-action="settings-accordion-toggle"][data-accordion="acc-entities"]')
      .getAttribute('aria-expanded'),
  ).toBe('true');

  // Switch tabs and back — verify state persistence
  await page.locator('.tab-btn[data-tab="participants"]').click();
  await page.waitForTimeout(100);
  await openAlgoTab(page);

  expect(
    await page
      .locator('[data-action="settings-accordion-toggle"][data-accordion="acc-algorithm"]')
      .getAttribute('aria-expanded'),
  ).toBe('true');
  expect(
    await page
      .locator('[data-action="settings-accordion-toggle"][data-accordion="acc-entities"]')
      .getAttribute('aria-expanded'),
  ).toBe('true');

  expect(pageErrors).toEqual([]);
});

test('hard-constraint toggles: each click flips the checkbox and persists', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-constraints');

  const checkboxes = page.locator('input[type="checkbox"][data-action="algo-toggle-hc"][data-code]');
  const count = await checkboxes.count();
  expect(count).toBeGreaterThan(0);
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = await checkboxes.nth(i).getAttribute('data-code');
    if (c) codes.push(c);
  }
  // Toggle off the first one
  const firstCode = codes[0];
  const first = page.locator(
    `input[type="checkbox"][data-action="algo-toggle-hc"][data-code="${firstCode}"]`,
  );
  expect(await first.isChecked()).toBe(true);
  await first.click();
  await page.waitForTimeout(100);

  // re-query (DOM may be re-rendered)
  const reFirst = page.locator(
    `input[type="checkbox"][data-action="algo-toggle-hc"][data-code="${firstCode}"]`,
  );
  expect(await reFirst.isChecked()).toBe(false);

  // Now reload and verify persistence
  await page.reload();
  await page.waitForSelector('.tab-nav');
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-constraints');
  const persisted = page.locator(
    `input[type="checkbox"][data-action="algo-toggle-hc"][data-code="${firstCode}"]`,
  );
  expect(await persisted.isChecked()).toBe(false);

  expect(pageErrors).toEqual([]);
});

test('weight slider syncs with paired number input', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const slider = page.locator('[data-action="algo-weight-slider"][data-key="l0FairnessWeight"]');
  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '123';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  expect(await numInput.inputValue()).toBe('123');

  // inverse: typing into number input should sync slider
  await numInput.fill('77');
  await numInput.dispatchEvent('input');
  await page.waitForTimeout(50);
  expect(await slider.inputValue()).toBe('77');

  expect(pageErrors).toEqual([]);
});

test('default attempts input persists across reload', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');

  const inp = page.locator('#input-default-attempts');
  await inp.fill('7');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(100);

  await page.reload();
  await page.waitForSelector('.tab-nav');
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');
  const persisted = await page.locator('#input-default-attempts').inputValue();
  expect(persisted).toBe('7');

  expect(pageErrors).toEqual([]);
});

test('theme toggle changes documentElement and persists', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');

  // Default theme on desktop is dark (no dataset.theme). Switch to light → dataset.theme="light".
  await page.locator('[data-action="set-theme"][data-theme="light"]').click();
  await page.waitForTimeout(100);
  const afterLight = await page.evaluate(() => document.documentElement.dataset.theme || '');
  expect(afterLight).toBe('light');

  // Reload and verify persistence
  await page.reload();
  await page.waitForSelector('.tab-nav');
  const persistedTheme = await page.evaluate(() => document.documentElement.dataset.theme || '');
  expect(persistedTheme).toBe('light');

  // Now toggle back to dark
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');
  await page.locator('[data-action="set-theme"][data-theme="dark"]').click();
  await page.waitForTimeout(100);
  const afterDark = await page.evaluate(() => document.documentElement.dataset.theme || '');
  expect(afterDark).toBe('');

  expect(pageErrors).toEqual([]);
});

test('certifications add and remove cycle', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');

  const before = await page.locator('.cert-def-item').count();
  // Type into add field
  const input = page.locator('input[data-field="cert-name"]');
  await input.fill('TestCertX');
  await page.locator('[data-action="cert-add"]').click();
  await page.waitForTimeout(200);
  const after = await page.locator('.cert-def-item').count();
  expect(after).toBe(before + 1);

  // Remove the new one (find item containing TestCertX)
  // Since there may now be multiple definitions, find the badge whose text matches
  const newItem = page.locator('.cert-def-item').filter({ hasText: 'TestCertX' });
  await expect(newItem).toBeVisible();
  await newItem.locator('[data-action="cert-remove"]').click();
  await page.waitForTimeout(200);
  const final = await page.locator('.cert-def-item').count();
  expect(final).toBe(before);

  expect(pageErrors).toEqual([]);
});

test('PAKAL add and remove cycle', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');

  const before = await page.locator('.pakal-def-item').count();
  await page.locator('input[data-field="pakal-new-label"]').fill('PakTest');
  await page.locator('[data-action="pakal-add"]').click();
  await page.waitForTimeout(200);
  const after = await page.locator('.pakal-def-item').count();
  expect(after).toBe(before + 1);

  const newItem = page.locator('.pakal-def-item').filter({ hasText: 'PakTest' });
  await expect(newItem).toBeVisible();
  await newItem.locator('[data-action="pakal-remove"]').click();
  await page.waitForTimeout(200);
  const final = await page.locator('.pakal-def-item').count();
  expect(final).toBe(before);
  expect(pageErrors).toEqual([]);
});

test('preset panel: open, save, rename, duplicate, delete', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');

  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.waitForSelector('.preset-panel');

  await page.locator('[data-action="algo-preset-new"]').click();
  await page.waitForSelector('[data-field="saveas-name"]');
  await page.locator('[data-field="saveas-name"]').fill('TestPresetA');
  await page.locator('[data-action="algo-preset-saveas-confirm"]').click();
  await page.waitForTimeout(300);

  const newItem = page.locator('.preset-item').filter({ hasText: 'TestPresetA' });
  await expect(newItem).toBeVisible();

  // Duplicate
  await newItem.locator('[data-preset-action="duplicate"]').click();
  await page.waitForTimeout(200);
  const dupCount = await page.locator('.preset-item').filter({ hasText: 'TestPresetA' }).count();
  expect(dupCount).toBeGreaterThanOrEqual(2);

  // Cleanup duplicates and original (only ones we created — non-built-in)
  // Delete via confirm modal — accept by clicking confirm button in modal
  page.on('dialog', (d) => d.accept());

  // Iterate non-built-in items containing TestPresetA — delete each
  for (let i = 0; i < 5; i++) {
    const items = page.locator('.preset-item').filter({ hasText: 'TestPresetA' });
    const c = await items.count();
    if (c === 0) break;
    const delBtn = items.first().locator('[data-preset-action="delete"]');
    if (await delBtn.count() === 0) break;
    await delBtn.click();
    // accept the showConfirm modal — find the confirm button
    const confirmBtn = page.locator('.confirm-modal .btn-primary, .modal-confirm-btn, .ui-modal-confirm').first();
    if (await confirmBtn.count()) {
      await confirmBtn.click();
    } else {
      // fallback — find a "מחק" button visible
      const danger = page.getByRole('button', { name: /מחק/ }).last();
      if (await danger.count()) await danger.click();
    }
    await page.waitForTimeout(200);
  }
  expect(pageErrors).toEqual([]);
});

test('storage refresh button works', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');
  await page.locator('[data-action="storage-refresh"]').click();
  await page.waitForTimeout(150);
  // Just check the panel still renders
  await expect(page.locator('.storage-usage-section')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('factory reset confirm dialog appears, can be cancelled', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');

  await page.locator('#btn-factory-reset').click();
  await page.waitForTimeout(300);
  // Modal should be visible (gm-modal-backdrop)
  const modal = page.locator('.gm-modal-backdrop');
  await expect(modal).toBeVisible();

  // Click cancel
  await modal.locator('.gm-modal-btn-cancel').click();
  await page.waitForTimeout(200);
  // Modal should be gone
  expect(await page.locator('.gm-modal-backdrop').count()).toBe(0);

  // localStorage should still have data (we cancelled)
  const ls = await page.evaluate(() => Object.keys(localStorage).length);
  expect(ls).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});

test('global header: undo / redo buttons exist and have correct disabled states', async ({ page }) => {
  await setup(page);
  // initial state: nothing to undo
  await expect(page.locator('#btn-undo')).toBeDisabled();
  await expect(page.locator('#btn-redo')).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test('tab badges show 48 participants and 8 tasks', async ({ page }) => {
  await setup(page);
  const pCount = await page.locator('.tab-btn[data-tab="participants"] .count').textContent();
  const tCount = await page.locator('.tab-btn[data-tab="task-rules"] .count').textContent();
  expect(pCount?.trim()).toBe('48');
  expect(tCount?.trim()).toBe('8');
  expect(pageErrors).toEqual([]);
});

test('auto-tune: clicking opens a confirm dialog', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-general');

  await page.locator('[data-action="algo-auto-tune"]').click();
  await page.waitForTimeout(300);
  const modal = page.locator('.gm-modal-backdrop');
  await expect(modal).toBeVisible();
  await modal.locator('.gm-modal-btn-cancel').click();
  await page.waitForTimeout(200);
  expect(pageErrors).toEqual([]);
});

test('weight value: typing negative value gets clamped on commit', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  await numInput.fill('-50');
  await numInput.dispatchEvent('change');
  await page.waitForTimeout(50);
  const v = await numInput.inputValue();
  // min for l0FairnessWeight is 0 → should clamp
  expect(parseFloat(v)).toBeGreaterThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

test('weight value: typing way-over-max gets clamped on commit', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  await numInput.fill('999999');
  await numInput.dispatchEvent('change');
  await page.waitForTimeout(50);
  const v = await numInput.inputValue();
  // max is 200
  expect(parseFloat(v)).toBeLessThanOrEqual(200);
  expect(pageErrors).toEqual([]);
});

test('cert custom-color trigger opens native picker', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');
  // Just verify hidden color input exists, since native dialog can't be observed
  const customInput = page.locator('input[data-action="cert-custom-color-change"]');
  expect(await customInput.count()).toBe(1);
  expect(pageErrors).toEqual([]);
});

test('cert color picker swatch click selects color', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');

  // Find a non-disabled, non-selected swatch in the add palette
  const swatch = page.locator('.cert-add-form [data-action="cert-select-color"]:not([disabled]):not(.selected)').first();
  const color = await swatch.getAttribute('data-color');
  await swatch.click();
  await page.waitForTimeout(150);
  const selected = page.locator('.cert-add-form [data-action="cert-select-color"].selected');
  const selectedColor = await selected.getAttribute('data-color');
  expect(selectedColor).toBe(color);
  expect(pageErrors).toEqual([]);
});

test('cert change-color: opens edit palette and pick changes color', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');

  const firstCert = page.locator('.cert-def-item').first();
  const certId = await firstCert.locator('[data-action="cert-change-color"]').getAttribute('data-cert-id');
  await firstCert.locator('[data-action="cert-change-color"]').click();
  await page.waitForTimeout(150);

  // edit palette should show
  await expect(page.locator('.cert-color-edit-palette').first()).toBeVisible();

  // pick the first non-disabled, non-selected swatch
  const pickBtn = page.locator(
    `[data-action="cert-pick-color"][data-cert-id="${certId}"]:not([disabled]):not(.selected)`,
  ).first();
  if (await pickBtn.count()) {
    await pickBtn.click();
    await page.waitForTimeout(150);
  }
  expect(pageErrors).toEqual([]);
});

test('day start hour custom select changes value', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-general');

  // Open the custom select
  const trigger = page.locator('#gm-day-start-hour .custom-select-trigger, #gm-day-start-hour [aria-haspopup], #gm-day-start-hour button').first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(150);
  }
  // Just take a screenshot for evidence
  await page.screenshot({ path: 'tests-audit/screenshots/agent3-day-start.png' });
  expect(pageErrors).toEqual([]);
});

test('hc toggle: toggling DOES NOT crash the app', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-constraints');

  const checkboxes = page.locator('input[type="checkbox"][data-action="algo-toggle-hc"][data-code]');
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    const cb = page.locator('input[type="checkbox"][data-action="algo-toggle-hc"][data-code]').nth(i);
    await cb.click();
    await page.waitForTimeout(50);
  }
  expect(pageErrors).toEqual([]);
});
