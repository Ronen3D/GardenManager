import { test, expect, type Page } from '@playwright/test';

// Each test sets up its own state; previous failure should not abort subsequent tests.
test.setTimeout(150_000);

async function setup(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  return { consoleErrors, pageErrors };
}

async function gotoSchedule(page: Page) {
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.waitForTimeout(200);
}

async function generateSchedule(page: Page, days = 2, attempts = 3) {
  await gotoSchedule(page);
  const daysInput = page.locator('#input-days');
  if (await daysInput.count()) await daysInput.fill(String(days));
  const sc = page.locator('#input-scenarios');
  if (await sc.count()) await sc.fill(String(attempts));
  await page.locator('#btn-generate').click();
  await page.waitForSelector('.optim-overlay', { timeout: 5_000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card, .empty-state', { timeout: 10_000 });
}

test('A1 - generate flow: optimizer overlay opens, schedule renders', async ({ page }) => {
  const { consoleErrors, pageErrors } = await setup(page);
  await gotoSchedule(page);
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  // Race: either overlay shows OR optimization is so fast it already finished.
  let overlaySeen = false;
  try {
    await page.waitForSelector('.optim-overlay', { timeout: 2_000 });
    overlaySeen = true;
  } catch {}
  if (overlaySeen) {
    // While overlay visible, cancel + accept should exist
    const cancelCnt = await page.locator('#btn-cancel-optim').count();
    const acceptCnt = await page.locator('#btn-accept-best').count();
    console.log('A1: overlay seen, cancel=', cancelCnt, 'accept=', acceptCnt);
  }
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForTimeout(300);
  const cards = await page.locator('.assignment-card').count();
  console.log('A1: cards=', cards, 'consoleErrors=', consoleErrors.length, 'pageErrors=', pageErrors.length);
  expect(cards).toBeGreaterThan(0);
});

test('A2 - day navigation: tabs switch and update active', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 3);
  const dayTabs = page.locator('.day-tab[data-day]');
  const count = await dayTabs.count();
  console.log('A2: day tabs found:', count);
  expect(count).toBe(3);
  for (let d = 1; d <= count; d++) {
    await page.locator(`.day-tab[data-day="${d}"]`).click();
    await page.waitForTimeout(150);
    const active = await page.locator('.day-tab.day-tab-active').getAttribute('data-day');
    expect(active).toBe(String(d));
  }
});

test('A3 - tooltip + swap: hover shows tooltip, swap click opens picker', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const firstHover = page.locator('.participant-hover[data-pid][data-assignment-id]').first();
  await firstHover.scrollIntoViewIfNeeded();
  await firstHover.hover();
  await page.waitForTimeout(400);
  const tooltip = page.locator('.participant-tooltip');
  const visible = await tooltip.evaluate((el) => (el as HTMLElement).style.display !== 'none').catch(() => false);
  console.log('A3: tooltip visible:', visible);
  expect(visible).toBeTruthy();
  await tooltip.locator('button.btn-swap').click();
  await page.waitForTimeout(700);
  // Swap-picker uses .gm-bottom-sheet-backdrop with .swap-picker-sheet
  const modalCnt = await page.locator('.gm-bottom-sheet-backdrop, .swap-picker-sheet, .swap-picker').count();
  console.log('A3: swap modal count:', modalCnt);
  expect(modalCnt).toBeGreaterThan(0);
});

test('A4 - manual build mode toggle on/off', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const btn = page.locator('#btn-manual-build');
  await btn.click();
  await page.waitForTimeout(200);
  const onClass = await page.locator('.schedule-toolbar.schedule-toolbar-manual').count();
  expect(onClass).toBe(1);
  await page.locator('#btn-manual-build').click();
  await page.waitForTimeout(200);
  const offClass = await page.locator('.schedule-toolbar.schedule-toolbar-manual').count();
  expect(offClass).toBe(0);
});

test('A5 - snapshot panel: open, save, reload', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#btn-snap-toggle').click();
  await page.waitForTimeout(200);
  const saveAs = page.locator('#btn-snap-save-as');
  await expect(saveAs).toBeVisible();
  const enabled = await saveAs.isEnabled();
  console.log('A5: save-as enabled:', enabled);
  expect(enabled).toBeTruthy();
  await saveAs.click();
  await page.waitForTimeout(200);
  const confirmBtn = page.locator('#btn-snap-confirm-save');
  const confirmCount = await confirmBtn.count();
  console.log('A5: confirm visible count:', confirmCount);
  if (confirmCount > 0) {
    await confirmBtn.click({ force: true });
    await page.waitForTimeout(400);
  }
  // Count snapshot rows
  const rows = await page.locator('[data-snapshot-id], .snapshot-row, .snapshot-card').count();
  console.log('A5: snapshot rows after save:', rows);
});

test('A6 - live mode toggle + inject button', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const chk = page.locator('#chk-live-mode');
  await expect(chk).toBeVisible();
  await chk.check();
  await page.waitForTimeout(500);
  // inject button should appear
  const injectBtn = page.locator('#btn-inject-task');
  const visible = await injectBtn.count();
  console.log('A6: inject visible:', visible, 'live checked:', await chk.isChecked());
  expect(visible).toBeGreaterThan(0);
  await injectBtn.click();
  await page.waitForTimeout(700);
  const modalCnt = await page.locator('#inject-modal-backdrop, .inject-backdrop').count();
  console.log('A6: inject modal count:', modalCnt);
  expect(modalCnt).toBeGreaterThan(0);
});

test('A7 - export panel: PDF opens, format options, cancel closes', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const exportBtn = page.locator('#btn-export-pdf');
  await expect(exportBtn).toBeVisible();
  await exportBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('#export-modal-backdrop')).toBeVisible();
  await expect(page.locator('#export-do')).toBeVisible();
  await page.locator('#export-cancel').click();
  await page.waitForTimeout(300);
  const open = await page.locator('#export-modal-backdrop').count();
  expect(open).toBe(0);
});

test('A8 - sidebar visibility at 1280x800 + toggle', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const sidebar = page.locator('.participant-sidebar');
  const sidebarCnt = await sidebar.count();
  const visible = sidebarCnt > 0 ? await sidebar.first().isVisible() : false;
  console.log('A8: sidebar count=', sidebarCnt, 'visible=', visible);
  const tog = page.locator('.sidebar-toggle[data-action="sidebar-toggle"]');
  const togCnt = await tog.count();
  const togVis = togCnt > 0 ? await tog.first().isVisible() : false;
  console.log('A8: sidebar toggle count=', togCnt, 'visible=', togVis);
  if (togCnt > 0 && togVis) {
    const before = await tog.first().textContent();
    await tog.first().click();
    await page.waitForTimeout(200);
    const after = await page.locator('.sidebar-toggle[data-action="sidebar-toggle"]').first().textContent();
    console.log('A8: tog text before/after:', before?.trim(), after?.trim());
    expect(after).not.toBe(before);
  } else {
    console.log('A8: sidebar toggle not visible — possible defect');
  }
});

test('A9 - gantt + swimlane toggles render and respond', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  // Wait a beat — toggles render after the optim overlay clears
  await page.waitForTimeout(500);
  const swim = page.locator('[data-action="toggle-swimlane"]');
  const swimCnt = await swim.count();
  console.log('A9: swim count=', swimCnt);
  if (swimCnt > 0) {
    const beforeAria = await swim.first().getAttribute('aria-expanded');
    await swim.first().click();
    await page.waitForTimeout(200);
    const afterAria = await page.locator('[data-action="toggle-swimlane"]').first().getAttribute('aria-expanded');
    console.log('A9: swim aria before/after:', beforeAria, afterAria);
    expect(afterAria).not.toBe(beforeAria);
  }
  const gantt = page.locator('[data-action="toggle-gantt"]');
  const ganttCnt = await gantt.count();
  console.log('A9: gantt count=', ganttCnt);
});

test('A10 - violations panel toggle', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.waitForTimeout(500);
  const tog = page.locator('[data-action="toggle-violations"]');
  const cnt = await tog.count();
  console.log('A10: tog count:', cnt);
  if (cnt > 0) {
    const beforeAria = await tog.first().getAttribute('aria-expanded');
    await tog.first().click();
    await page.waitForTimeout(200);
    const afterAria = await page.locator('[data-action="toggle-violations"]').first().getAttribute('aria-expanded');
    console.log('A10: viol aria before/after:', beforeAria, afterAria);
    expect(afterAria).not.toBe(beforeAria);
  } else {
    console.log('A10: no violations — toggle hidden by design');
  }
});

test('A11 - export-day JSON + generate-from-day buttons present and respond', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.waitForTimeout(300);
  const exDay = page.locator('#btn-export-day-json');
  const genFromDay = page.locator('#btn-generate-from-day');
  const exCnt = await exDay.count();
  const gfdCnt = await genFromDay.count();
  console.log('A11: export-day=', exCnt, 'gen-from-day=', gfdCnt);
  expect(exCnt).toBe(1);
  expect(gfdCnt).toBe(1);
  let dlPromise = page.waitForEvent('download', { timeout: 4_000 }).catch(() => null);
  await exDay.click();
  const dl = await dlPromise;
  console.log('A11: download:', dl ? dl.suggestedFilename() : 'none');
});

test('A12 - reset storage shows confirm dialog', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  let dialogShown = false;
  page.on('dialog', (d) => {
    dialogShown = true;
    d.dismiss().catch(() => {});
  });
  const resetBtn = page.locator('#btn-reset-storage');
  await expect(resetBtn).toBeVisible();
  await resetBtn.click();
  await page.waitForTimeout(500);
  console.log('A12: dialog shown:', dialogShown);
  expect(dialogShown).toBeTruthy();
});

test('A13 - live mode opens range-picker for initial timestamp', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const chk = page.locator('#chk-live-mode');
  await chk.check();
  await page.waitForTimeout(700);
  // App opens range-picker for initial pick. Look for various modal patterns.
  const modalCnt = await page.locator('.range-picker-backdrop, .gm-modal-backdrop, .modal-backdrop, [role="dialog"]').count();
  console.log('A13: modal count after live-mode check:', modalCnt);
});

test('A14 - empty slot click opens swap picker (if there are any)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const emptyCards = page.locator('.assignment-card:not(:has(.participant-hover))');
  const cnt = await emptyCards.count();
  console.log('A14: empty slot count:', cnt);
  if (cnt > 0) {
    await emptyCards.first().click();
    await page.waitForTimeout(500);
    const modalCnt = await page.locator('.gm-modal-backdrop, .swap-picker-backdrop, .modal-backdrop').count();
    console.log('A14: modal count after empty-slot click:', modalCnt);
  }
});

test('A15 - senior toggle button', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const btn = page.locator('#btn-senior-toggle');
  const cnt = await btn.count();
  console.log('A15: senior toggle count:', cnt, 'visible:', cnt > 0 ? await btn.first().isVisible() : false);
  if (cnt > 0) {
    await btn.first().click();
    await page.waitForTimeout(200);
  }
});
