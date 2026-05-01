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

// Bug repro: weight number input is NOT clamped during typing — only commit.
// Slider is, however, paired-clamped. This creates a mismatch between
// what the user sees in the number input vs. the slider position vs. persisted state.
test('BUG: number input shows out-of-range value while slider is clamped', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  const slider = page.locator('[data-action="algo-weight-slider"][data-key="l0FairnessWeight"]');

  // l0FairnessWeight: max=200
  await numInput.fill('500');
  await numInput.dispatchEvent('input');
  await page.waitForTimeout(50);

  const numVal = await numInput.inputValue();
  const sliderVal = await slider.inputValue();
  console.log('After typing 500: numInput=', numVal, ' slider=', sliderVal);
  // The slider should be clamped to 200
  expect(parseFloat(sliderVal)).toBeLessThanOrEqual(200);
  // But the number input still shows 500 — confirm the mismatch
  expect(numVal).toBe('500');
  expect(pageErrors).toEqual([]);
});

// Bug repro: weight slider goes through debounce → renders. After 300ms debounce
// fires + rerender, the slider snaps to clamped, but the number input value
// (which user typed) is also overwritten by the rerender.
test('BUG: number input value is overwritten on debounce flush after typing', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-weights');

  const numInput = page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]');
  await numInput.fill('500');
  await numInput.dispatchEvent('input');
  // Wait for the 300ms debounce + rerender
  await page.waitForTimeout(500);
  const v = await page.locator('[data-action="algo-weight-input"][data-key="l0FairnessWeight"]').inputValue();
  console.log('After debounce/rerender:', v);
  // After rerender, value should be the clamped persisted state (200)
  expect(parseFloat(v)).toBeLessThanOrEqual(200);
  expect(pageErrors).toEqual([]);
});

// Probe: cert-name input — is it cleared after a successful cert add?
test('after cert-add, the input should be cleared', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');
  const input = page.locator('input[data-field="cert-name"]');
  await input.fill('NewCertCleared');
  await page.locator('[data-action="cert-add"]').click();
  await page.waitForTimeout(200);
  // The input should be empty
  const v = await page.locator('input[data-field="cert-name"]').inputValue();
  expect(v).toBe('');
  // Cleanup
  const newItem = page.locator('.cert-def-item').filter({ hasText: 'NewCertCleared' });
  await newItem.locator('[data-action="cert-remove"]').click();
  await page.waitForTimeout(200);
  expect(pageErrors).toEqual([]);
});

// Probe: empty cert-name shows toast (not validation error)
test('cert-add with empty name shows toast', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');
  await page.locator('[data-action="cert-add"]').click();
  await page.waitForTimeout(150);
  // Look for a toast
  const toastVisible = await page.locator('.toast, .gm-toast, [class*="toast"]').first().isVisible().catch(() => false);
  expect(toastVisible).toBe(true);
  expect(pageErrors).toEqual([]);
});

// Probe: hard-constraint toggle DOES NOT have a 'change' propagation issue
// when the underlying label is clicked (not the checkbox itself)
test('clicking HC label toggles the checkbox', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-constraints');
  // Get first HC label and click on its text content
  const label = page.locator('.algo-toggle-item').first();
  const codeBefore = await label.locator('input[type="checkbox"]').isChecked();
  // Click the label
  await label.locator('.algo-toggle-label').click();
  await page.waitForTimeout(100);
  // The checkbox should toggle
  const codeAfter = await label.locator('input[type="checkbox"]').isChecked();
  expect(codeAfter).not.toBe(codeBefore);
  expect(pageErrors).toEqual([]);
});

// Probe: open cert color picker palette via 'cert-change-color', then
// click 'cert-change-color' a SECOND time to close it (toggle)
test('cert change-color: toggle behavior closes palette on second click', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-entities');
  const firstCert = page.locator('.cert-def-item').first();
  const trigger = firstCert.locator('[data-action="cert-change-color"]');
  await trigger.click();
  await page.waitForTimeout(150);
  await expect(page.locator('.cert-color-edit-palette').first()).toBeVisible();
  // Click again — should close
  await page.locator('.cert-def-item').first().locator('[data-action="cert-change-color"]').click();
  await page.waitForTimeout(150);
  expect(await page.locator('.cert-color-edit-palette').count()).toBe(0);
  expect(pageErrors).toEqual([]);
});

// Probe: multi-stage preset save (open panel, save, then close)
test('preset save retains panel-open state', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await page.locator('[data-action="algo-preset-panel-toggle"]').click();
  await page.waitForSelector('.preset-panel');
  await page.locator('[data-action="algo-preset-new"]').click();
  await page.locator('[data-field="saveas-name"]').fill('PanelStateTest');
  await page.locator('[data-action="algo-preset-saveas-confirm"]').click();
  await page.waitForTimeout(250);
  // Panel should still be open
  await expect(page.locator('.preset-panel')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

// Probe: HC-toggle reflects in disabledHardConstraints localStorage (frozen check
// requires schedule, but config-store also has it)
test('HC toggle: writes to localStorage immediately', async ({ page }) => {
  await setup(page);
  await openAlgoTab(page);
  await openAccordion(page, 'acc-algorithm');
  await openAccordion(page, 'acc-constraints');
  const cb = page.locator('input[type="checkbox"][data-action="algo-toggle-hc"][data-code="HC-1"]');
  await cb.click();
  await page.waitForTimeout(100);
  const ls = await page.evaluate(() => localStorage.getItem('gardenmanager_algorithm'));
  expect(ls).toBeTruthy();
  expect(ls!.includes('HC-1')).toBe(true);
  expect(pageErrors).toEqual([]);
});

// Probe: undo button enablement after a participant-side edit. We need to actually
// do an edit. Let's modify a participant.
test('undo button enables after participant deletion', async ({ page }) => {
  await setup(page);
  // Initial: undo disabled
  await expect(page.locator('#btn-undo')).toBeDisabled();
  await page.locator('.tab-btn[data-tab="participants"]').click();
  await page.waitForTimeout(200);

  // Try to find a remove button on a participant
  const removeBtn = page.locator('[data-action="participant-remove"], [data-action="remove-participant"]').first();
  if (await removeBtn.count()) {
    page.on('dialog', (d) => d.accept());
    await removeBtn.click();
    await page.waitForTimeout(300);
    // accept any confirm modal
    const modalConfirm = page.locator('.gm-modal-backdrop .gm-modal-btn-ok');
    if (await modalConfirm.count()) await modalConfirm.click();
    await page.waitForTimeout(200);
    // undo should now be enabled
    const undoDisabled = await page.locator('#btn-undo').isDisabled();
    expect(undoDisabled).toBe(false);
  } else {
    test.skip();
  }
  expect(pageErrors).toEqual([]);
});
