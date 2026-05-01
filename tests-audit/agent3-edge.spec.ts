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

test('add-preset cancel: form-cancel returns to default state', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');

  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.waitForSelector('.preset-panel');
  await page.locator('[data-action="algo-preset-new"]').click();
  await page.waitForSelector('[data-field="saveas-name"]');

  // Cancel
  await page.locator('[data-action="algo-preset-form-cancel"]').click();
  await page.waitForTimeout(100);
  expect(await page.locator('[data-field="saveas-name"]').count()).toBe(0);
  // The "save preset" button should appear again
  await expect(page.locator('[data-action="algo-preset-new"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('preset panel close button collapses the panel', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');

  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.waitForSelector('.preset-panel');
  await page.locator('[data-action="algo-preset-panel-close"]').click();
  await page.waitForTimeout(100);
  expect(await page.locator('.preset-panel').count()).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('preset save-as: empty name shows validation error', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');

  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.locator('[data-action="algo-preset-new"]').click();
  await page.waitForSelector('[data-field="saveas-name"]');
  // Leave name blank, click confirm
  await page.locator('[data-action="algo-preset-saveas-confirm"]').click();
  await page.waitForTimeout(150);
  // The error element should have non-empty text
  const errEl = page.locator('#preset-form-error');
  const errText = (await errEl.textContent())?.trim() || '';
  expect(errText.length).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('preset rename flow: rename a non-built-in preset', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');

  // First, create a preset to rename
  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.locator('[data-action="algo-preset-new"]').click();
  await page.locator('[data-field="saveas-name"]').fill('OriginalName');
  await page.locator('[data-action="algo-preset-saveas-confirm"]').click();
  await page.waitForTimeout(200);

  const item = page.locator('.preset-item').filter({ hasText: 'OriginalName' });
  await expect(item).toBeVisible();
  await item.locator('[data-preset-action="rename"]').click();
  await page.waitForSelector('[data-field="rename-name"]');
  await page.locator('[data-field="rename-name"]').fill('RenamedName');
  await page.locator('[data-action="algo-preset-rename-confirm"]').click();
  await page.waitForTimeout(250);

  await expect(page.locator('.preset-item').filter({ hasText: 'RenamedName' })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('cert removal of in-use cert prompts confirm dialog', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');

  // The default app pre-seeds participants with certifications, so existing certs are in use.
  const firstCert = page.locator('.cert-def-item').first();
  await firstCert.locator('[data-action="cert-remove"]').click();
  await page.waitForTimeout(200);
  // gm-modal-backdrop should appear
  const modal = page.locator('.gm-modal-backdrop');
  await expect(modal).toBeVisible();
  // Cancel
  await modal.locator('.gm-modal-btn-cancel').click();
  await page.waitForTimeout(150);
  expect(await page.locator('.gm-modal-backdrop').count()).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('weight slider: slider input event during drag clamps gracefully', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const slider = page.locator('[data-action="algo-weight-slider"][data-key="minRestWeight"]');
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '999';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(50);
  const sliderVal = await slider.inputValue();
  // Range input naturally clamps to its max=200
  expect(parseFloat(sliderVal)).toBeLessThanOrEqual(200);
  expect(pageErrors).toEqual([]);
});

test('default attempts: empty value reverts on commit', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');

  const inp = page.locator('#input-default-attempts');
  await inp.fill('');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(100);
  const v = await inp.inputValue();
  expect(parseInt(v, 10)).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('default attempts: zero / negative is rejected (reverts)', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');

  const inp = page.locator('#input-default-attempts');
  const before = await inp.inputValue();
  await inp.fill('0');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(100);
  const v = await inp.inputValue();
  expect(parseInt(v, 10)).toBeGreaterThan(0);
  expect(v).toBe(before);
  expect(pageErrors).toEqual([]);
});

test('all four accordions toggle independently', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  for (const id of ['acc-algorithm', 'acc-entities', 'acc-additional', 'acc-transfer']) {
    const header = page.locator(
      `[data-action="settings-accordion-toggle"][data-accordion="${id}"]`,
    );
    await expect(header).toBeVisible();
    const before = await header.getAttribute('aria-expanded');
    await header.click();
    await page.waitForTimeout(100);
    const after = await page.locator(
      `[data-action="settings-accordion-toggle"][data-accordion="${id}"]`,
    ).getAttribute('aria-expanded');
    expect(after).not.toBe(before);
  }
  expect(pageErrors).toEqual([]);
});

test('storage info shows and breakdown rows render', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-additional');
  await expect(page.locator('.storage-usage-section')).toBeVisible();
  // After a fresh install we should have at least one breakdown row
  const rows = await page.locator('.storage-breakdown-row').count();
  expect(rows).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('weight slider input is clamped to range when value entered exceeds max', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  // Test: type into number input something > max. During input it should be clamped.
  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  const slider = page.locator('[data-action="algo-weight-slider"][data-key="l0FairnessWeight"]');

  await numInput.fill('5000');
  await numInput.dispatchEvent('input');
  await page.waitForTimeout(50);
  // The slider should reflect the clamped value (200)
  const sliderVal = await slider.inputValue();
  expect(parseFloat(sliderVal)).toBeLessThanOrEqual(200);
  expect(pageErrors).toEqual([]);
});

test('change tabs: modified weight persists when navigating away and back', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');
  const slider = page.locator('[data-action="algo-weight-slider"][data-key="l0FairnessWeight"]');
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = '90';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Wait for debounce flush (300ms)
  await page.waitForTimeout(500);

  // Switch tabs and back
  await page.locator('.tab-btn[data-tab="participants"]').click();
  await page.waitForTimeout(100);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');
  const newSlider = page.locator('[data-action="algo-weight-slider"][data-key="l0FairnessWeight"]');
  expect(await newSlider.inputValue()).toBe('90');
  expect(pageErrors).toEqual([]);
});
