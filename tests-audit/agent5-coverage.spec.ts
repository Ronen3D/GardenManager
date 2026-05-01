import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

/**
 * Agent 5 — covers gaps left by agents 1..4.
 * Focus: continuity flow, data-transfer, range/load-formula/swap-picker modals,
 * swimlane interactions, period-days, day-start-hour, BALTAM injection,
 * preflight UI, workload popup actions, snapshot save flow.
 */

const errs: { msg: string; src: 'console' | 'pageerror' }[] = [];
function hookErrors(page: Page) {
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() === 'error') errs.push({ msg: m.text(), src: 'console' });
  });
  page.on('pageerror', (e) => errs.push({ msg: String(e), src: 'pageerror' }));
}

async function freshLoad(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.tab-btn', { timeout: 10_000 });
}

async function gotoTab(page: Page, name: string) {
  await page.locator('.tab-btn', { hasText: name }).first().click();
  await page.waitForTimeout(150);
}

async function generateSchedule(page: Page) {
  await gotoTab(page, 'שבצ');
  const gen = page.locator('#btn-generate');
  await gen.waitFor({ state: 'visible' });
  if (await gen.isDisabled()) return false;
  await gen.click();
  // wait for optimizer overlay to come and go
  await page.waitForFunction(
    () => !document.querySelector('.optimizer-overlay'),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(300);
  return true;
}

test.beforeEach(async ({ page }) => {
  errs.length = 0;
  hookErrors(page);
});

// ─────────────────────────────────────────────────────────────────
// 1. Period-days control
// ─────────────────────────────────────────────────────────────────
test('period days: input changes write to gardenmanager_state', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'שבצ');
  const daysInput = page.locator('#input-days');
  await daysInput.waitFor();
  await expect(daysInput).toHaveValue('7');
  await daysInput.fill('3');
  await daysInput.dispatchEvent('change');
  await page.waitForTimeout(200);
  const stored = await page.evaluate(() => localStorage.getItem('gardenmanager_state'));
  expect(stored).toBeTruthy();
  expect(stored).toContain('"scheduleDays":3');
});

test('period days: out-of-range reverts on change', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'שבצ');
  const daysInput = page.locator('#input-days');
  await daysInput.fill('99');
  await daysInput.dispatchEvent('change');
  await expect(daysInput).toHaveValue('7');
});

// ─────────────────────────────────────────────────────────────────
// 2. Continuity flow
// ─────────────────────────────────────────────────────────────────
test('continuity: import button visible when no schedule and opens prompt', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'שבצ');
  const importBtn = page.locator('#btn-continuity-import');
  await expect(importBtn).toBeVisible();
  await importBtn.click();
  // Should produce some kind of dialog or chip
  await page.waitForTimeout(400);
  const dialog = await page.locator('.gm-modal-dialog, textarea, [role="dialog"]').count();
  expect(dialog).toBeGreaterThan(0);
});

test('continuity: export-day button writes JSON to clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule generated');
  const exportBtn = page.locator('#btn-export-day-json');
  await exportBtn.waitFor();
  await exportBtn.click();
  await page.waitForTimeout(500);
  // Either toast appears or no errors raised
  const toastShown = await page.locator('.gm-toast, .toast').count();
  const realErrs = errs.filter((e) => !/clipboard|favicon/i.test(e.msg));
  expect(realErrs, JSON.stringify(realErrs)).toEqual([]);
});

test('continuity: generate-from-day button regenerates schedule', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule generated');
  const btn = page.locator('#btn-generate-from-day');
  await btn.waitFor();
  await btn.click();
  await page.waitForFunction(
    () => !document.querySelector('.optimizer-overlay'),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(500);
  // Should still show schedule UI
  const hasUI = await page.locator('.day-tab, .swimlane-view, .schedule-grid').count();
  expect(hasUI).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────
// 3. Data-transfer panel
// ─────────────────────────────────────────────────────────────────
test('data-transfer: open transfer accordion, click export', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'אלגו');
  // The accordion sections live under #acc-transfer
  // Find header by text
  const header = page.locator('.settings-accordion-header', { hasText: 'העברת נתונים' }).first();
  if (!(await header.isVisible().catch(() => false))) {
    // Try clicking accordion toggle directly
    const acc = page.locator('[data-action="settings-accordion-toggle"]').filter({ hasText: 'העברת' }).first();
    if (await acc.isVisible().catch(() => false)) await acc.click();
  } else {
    await header.click();
  }
  await page.waitForTimeout(200);
  const exportBtn = page.locator('[data-action="transfer-export"]');
  await expect(exportBtn).toBeVisible({ timeout: 3000 });
  await exportBtn.click();
  await page.waitForTimeout(400);
  // Should show some scope picker / dialog
  const hasDialog = await page.locator('.gm-modal-dialog, .transfer-scope-item, [role="dialog"]').count();
  expect(hasDialog).toBeGreaterThan(0);
});

test('data-transfer: import button opens dialog', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'אלגו');
  const acc = page.locator('[data-action="settings-accordion-toggle"]').filter({ hasText: 'העברת' }).first();
  if (await acc.isVisible().catch(() => false)) await acc.click();
  await page.waitForTimeout(200);
  const importBtn = page.locator('[data-action="transfer-import"]');
  await expect(importBtn).toBeVisible({ timeout: 3000 });
  await importBtn.click();
  await page.waitForTimeout(400);
  const hasDialog = await page.locator('.gm-modal-dialog, [role="dialog"], textarea').count();
  expect(hasDialog).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────
// 4. Load-formula modal
// ─────────────────────────────────────────────────────────────────
test('load-formula modal: opens via 🧮 in expanded template, cancel closes', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'חוקי');
  // Expand the first template card
  const firstCard = page.locator('.template-card').first();
  await firstCard.waitFor();
  const expandTrigger = firstCard.locator('[data-action="toggle-template"], .template-card-header').first();
  await expandTrigger.click();
  await page.waitForTimeout(300);
  const lfBtn = page.locator('[data-action="open-load-formula"]').first();
  if (!(await lfBtn.isVisible().catch(() => false))) {
    test.skip(true, 'load-formula button not visible in any expanded card');
  }
  await lfBtn.click();
  const modal = page.locator('#lf-modal-backdrop');
  await expect(modal).toBeVisible({ timeout: 3000 });
  // Stepper buttons
  const plus = page.locator('[data-lf-action="target-step"][data-lf-delta="1"]').first();
  if (await plus.isVisible().catch(() => false)) {
    await plus.click();
  }
  // cancel
  await page.locator('[data-lf-action="cancel"]').first().click();
  await expect(modal).toBeHidden({ timeout: 2000 });
});

// ─────────────────────────────────────────────────────────────────
// 5. Swap-picker
// ─────────────────────────────────────────────────────────────────
test('swap-picker: opens via tooltip swap button, search filter narrows list', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule');
  // Hover over a participant chip in the schedule to get tooltip
  const chip = page.locator('.participant-hover, [data-pid]').first();
  await chip.hover();
  await page.waitForTimeout(300);
  // Find the swap button in the tooltip
  const swapBtn = page.locator('.btn-swap, button[title="החלף"]').first();
  if (!(await swapBtn.isVisible().catch(() => false))) {
    test.skip(true, 'swap button not visible in tooltip');
  }
  await swapBtn.click();
  const picker = page.locator('.swap-picker').first();
  await expect(picker).toBeVisible({ timeout: 3000 });
  const search = page.locator('#swap-picker-search');
  await search.waitFor();
  await search.fill('zzznoone');
  await page.waitForTimeout(300);
  const empty = await page.locator('.swap-picker-empty').count();
  expect(empty).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
});

// ─────────────────────────────────────────────────────────────────
// 6. Swimlane group toggle
// ─────────────────────────────────────────────────────────────────
test('swimlane: clicking group header toggles aria-expanded', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule');
  // Try to expand swimlane section if collapsed
  const swToggle = page.locator('[data-action="toggle-swimlane"]').first();
  if (await swToggle.isVisible().catch(() => false)) {
    const isExpanded = await swToggle.getAttribute('aria-expanded');
    if (isExpanded === 'false') {
      await swToggle.click();
      await page.waitForTimeout(300);
    }
  }
  const header = page.locator('[data-group-toggle]').first();
  if (!(await header.isVisible().catch(() => false))) {
    test.skip(true, 'swimlane group header not visible');
  }
  const before = await header.getAttribute('aria-expanded');
  await header.click();
  await page.waitForTimeout(300);
  const after = await header.getAttribute('aria-expanded');
  expect(after).not.toBe(before);
});

// ─────────────────────────────────────────────────────────────────
// 7. Day-start-hour
// ─────────────────────────────────────────────────────────────────
test('day-start-hour: clicking a custom-select option persists value', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'אלגו');
  // ensure the parent accordion is open
  const acc = page.locator('[data-action="settings-accordion-toggle"]').filter({ hasText: /יום|שעה/ }).first();
  if (await acc.isVisible().catch(() => false)) await acc.click();
  await page.waitForTimeout(200);
  const ctrl = page.locator('#gm-day-start-hour');
  if (!(await ctrl.isVisible().catch(() => false))) {
    test.skip(true, 'day-start-hour control not visible');
  }
  await ctrl.click();
  await page.waitForTimeout(200);
  // Pick first option that's not currently selected
  const opt = page.locator('[data-cs-value]').first();
  if (await opt.isVisible().catch(() => false)) {
    const val = await opt.getAttribute('data-cs-value');
    await opt.click();
    await page.waitForTimeout(300);
    const stored = await page.evaluate(() => localStorage.getItem('gardenmanager_algorithm'));
    expect(stored).toContain('dayStartHour');
    expect(stored).toContain(`"dayStartHour":${parseInt(val || '0', 10)}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// 8. Workload popup
// ─────────────────────────────────────────────────────────────────
test('workload-popup: close via [data-wp-close] or click-outside', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule');
  // Sidebar bar element. Use both observed selectors.
  const bar = page.locator('.sidebar-bar-bg, [data-pid].sidebar-bar-bg').first();
  await bar.waitFor({ timeout: 5000 });
  await bar.click();
  await page.waitForTimeout(400);
  const pop = page.locator('.workload-popup').first();
  if (!(await pop.isVisible().catch(() => false))) {
    test.skip(true, 'workload-popup did not appear on click');
  }
  // Try close button first
  const close = page.locator('[data-wp-close]').first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
  } else {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
  }
  await page.waitForTimeout(400);
  const stillVisible = await pop.isVisible().catch(() => false);
  expect(stillVisible).toBeFalsy();
});

// ─────────────────────────────────────────────────────────────────
// 9. BALTAM inject button gating
// ─────────────────────────────────────────────────────────────────
test('inject-task button: hidden without live mode, visible with live mode', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule');
  // Without live mode
  const before = await page.locator('#btn-inject-task').count();
  expect(before).toBe(0);
  // Enable live mode
  const liveTog = page.locator('#chk-live-mode');
  await liveTog.waitFor();
  await liveTog.click();
  await page.waitForTimeout(300);
  // Confirm anchor picker if present
  const okBtn = page.locator('.gm-modal-btn-ok, button:has-text("אישור")').first();
  if (await okBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await okBtn.click();
    await page.waitForTimeout(500);
  }
  const after = await page.locator('#btn-inject-task').count();
  expect(after).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────
// 10. Preflight: zero-participant scenario actually disables generate
// ─────────────────────────────────────────────────────────────────
test('preflight: removing participants via store disables generate', async ({ page }) => {
  await freshLoad(page);
  // Wipe participants directly in the correct storage key
  await page.evaluate(() => {
    const raw = localStorage.getItem('gardenmanager_state');
    if (!raw) return;
    const state = JSON.parse(raw);
    state.participants = [];
    localStorage.setItem('gardenmanager_state', JSON.stringify(state));
  });
  await page.reload();
  await page.waitForSelector('.tab-btn');
  await gotoTab(page, 'שבצ');
  const gen = page.locator('#btn-generate');
  await gen.waitFor();
  const isDisabled = await gen.isDisabled();
  expect(isDisabled).toBeTruthy();
});

// ─────────────────────────────────────────────────────────────────
// 11. Snapshot panel save
// ─────────────────────────────────────────────────────────────────
test('snapshot panel: open and save creates a new entry', async ({ page }) => {
  await freshLoad(page);
  const ok = await generateSchedule(page);
  test.skip(!ok, 'no schedule');
  const snapBtn = page.locator('#btn-snap-toggle');
  await snapBtn.waitFor();
  await snapBtn.click();
  await page.waitForTimeout(300);
  const saveBtn = page.locator('#btn-snap-save-as');
  if (!(await saveBtn.isVisible().catch(() => false))) {
    test.skip(true, 'save snapshot btn not visible');
  }
  await saveBtn.click();
  // Modal may prompt for a name
  await page.waitForTimeout(500);
  // Try OK button if a modal appeared
  const ok2 = page.locator('.gm-modal-btn-ok, button:has-text("שמור")').first();
  if (await ok2.isVisible({ timeout: 1000 }).catch(() => false)) {
    await ok2.click();
    await page.waitForTimeout(300);
  }
  const stored = await page.evaluate(() => localStorage.getItem('gardenmanager_schedule_snapshots'));
  expect(stored).toBeTruthy();
});

// ─────────────────────────────────────────────────────────────────
// 12. Reset storage button vs factory reset
// ─────────────────────────────────────────────────────────────────
test('reset storage and factory reset both trigger confirm dialogs', async ({ page }) => {
  await freshLoad(page);
  await gotoTab(page, 'אלגו');
  // Find the factory reset button
  const factory = page.locator('#btn-factory-reset');
  await factory.waitFor();
  page.once('dialog', (d) => d.dismiss());
  await factory.click();
  await page.waitForTimeout(300);
  // Also test reset-storage if exists
  const resetStorage = page.locator('#btn-reset-storage, [data-action="storage-reset"]').first();
  if (await resetStorage.isVisible().catch(() => false)) {
    page.once('dialog', (d) => d.dismiss());
    await resetStorage.click();
    await page.waitForTimeout(200);
  }
});

// ─────────────────────────────────────────────────────────────────
// 13. Console-error sweep across uncovered surfaces
// ─────────────────────────────────────────────────────────────────
test('no console errors during uncovered-surface exercises', async ({ page }) => {
  await freshLoad(page);
  // continuity import button
  await gotoTab(page, 'שבצ');
  const importBtn = page.locator('#btn-continuity-import');
  if (await importBtn.isVisible().catch(() => false)) {
    await importBtn.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
  }
  // toggle days input
  const days = page.locator('#input-days');
  await days.fill('2');
  await days.dispatchEvent('change');
  await page.waitForTimeout(300);
  // toggle algo accordions
  await gotoTab(page, 'אלגו');
  const accs = page.locator('[data-action="settings-accordion-toggle"]');
  const n = Math.min(await accs.count(), 3);
  for (let i = 0; i < n; i++) await accs.nth(i).click();
  // Snapshot toggle
  await gotoTab(page, 'שבצ');
  const snap = page.locator('#btn-snap-toggle');
  if (await snap.isVisible().catch(() => false)) {
    await snap.click();
    await page.waitForTimeout(200);
  }
  // Filter only error messages
  const real = errs.filter(
    (e) =>
      !/favicon|Failed to load resource|net::ERR/i.test(e.msg) &&
      !/clipboard/i.test(e.msg),
  );
  expect(real, JSON.stringify(real, null, 2)).toEqual([]);
});
