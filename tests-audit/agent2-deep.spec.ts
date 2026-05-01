import { test, expect, type Page } from '@playwright/test';

test.setTimeout(180_000);

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

async function generateSchedule(page: Page, days = 2, attempts = 5) {
  await gotoSchedule(page);
  const daysInput = page.locator('#input-days');
  if (await daysInput.count()) await daysInput.fill(String(days));
  const sc = page.locator('#input-scenarios');
  if (await sc.count()) await sc.fill(String(attempts));
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card, .empty-state', { timeout: 10_000 });
  await page.waitForTimeout(300);
}

test('B1 - snapshot: save with name, then verify entry rendered', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#btn-snap-toggle').click();
  await page.waitForTimeout(200);
  await page.locator('#btn-snap-save-as').click();
  await page.waitForTimeout(200);
  const nameInput = page.locator('#snap-name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('AuditSnap1');
  await page.locator('#btn-snap-confirm-save').click();
  await page.waitForTimeout(400);
  // After save the list should have 1 snapshot row
  const items = await page.locator('.snapshot-item[data-snap-id]').count();
  console.log('B1: snapshot-items:', items);
  expect(items).toBe(1);
  // The toggle text should now show count "(1)"
  const togText = await page.locator('#btn-snap-toggle').textContent();
  console.log('B1: toggle text:', togText?.trim());
  expect(togText).toMatch(/\(1\)/);
});

test('B2 - snapshot: load, rename, delete (round-trip)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  // Save snapshot
  await page.locator('#btn-snap-toggle').click();
  await page.locator('#btn-snap-save-as').click();
  await page.locator('#snap-name').fill('A1');
  await page.locator('#btn-snap-confirm-save').click();
  await page.waitForTimeout(300);
  // Inspect snapshot row for action buttons
  const item = page.locator('.snapshot-item[data-snap-id]').first();
  const buttons = await item.locator('button').count();
  console.log('B2: buttons in snapshot row:', buttons);
  // List action button DOM
  const html = await item.innerHTML();
  console.log('B2: snapshot row html (truncated):', html.substring(0, 600));
});

test('B3 - rescue modal (live mode): tooltip shows rescue button, click opens rescue modal', async ({ page }) => {
  const { consoleErrors, pageErrors } = await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#chk-live-mode').check();
  await page.waitForTimeout(500);
  // Find a future (non-frozen) participant cell
  const futureHover = page.locator('.participant-hover[data-pid][data-assignment-id]:not([data-frozen="1"])').first();
  await futureHover.scrollIntoViewIfNeeded();
  await futureHover.hover();
  await page.waitForTimeout(400);
  const rescueBtn = page.locator('.participant-tooltip button.btn-rescue');
  const rescueCnt = await rescueBtn.count();
  console.log('B3: rescue button count in tooltip:', rescueCnt);
  if (rescueCnt > 0) {
    await rescueBtn.click();
    await page.waitForTimeout(800);
    const modalCnt = await page.locator('#rescue-modal-backdrop, .rescue-backdrop').count();
    console.log('B3: rescue modal count:', modalCnt);
    expect(modalCnt).toBeGreaterThan(0);
  } else {
    console.log('B3: NO rescue button shown in live mode tooltip — possible defect');
  }
  console.log('B3: consoleErrors:', consoleErrors.length, 'pageErrors:', pageErrors.length);
});

test('B4 - export PDF: do export', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#btn-export-pdf').click();
  await page.waitForTimeout(300);
  const dlPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => null);
  // Click the export action
  await page.locator('#export-do').click();
  await page.waitForTimeout(2000);
  const dl = await dlPromise;
  console.log('B4: download:', dl ? dl.suggestedFilename() : 'none');
});

test('B5 - export-day: clipboard write triggers toast', async ({ page }) => {
  await setup(page);
  // Grant clipboard permission
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await generateSchedule(page, 2);
  await page.locator('#btn-export-day-json').click();
  await page.waitForTimeout(800);
  const toastCnt = await page.locator('.gm-toast').count();
  console.log('B5: toast count after export-day click:', toastCnt);
  expect(toastCnt).toBeGreaterThan(0);
});

test('B6 - generate-from-day button responds', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 3);
  await page.locator('#btn-generate-from-day').click();
  // Could open a confirm dialog or directly start generating
  await page.waitForTimeout(800);
  const bgCnt = await page.locator('.gm-modal-backdrop, .optim-overlay').count();
  console.log('B6: post-click bgCnt:', bgCnt);
});

test('B7 - reset storage: gm-modal-backdrop confirm appears with danger button', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#btn-reset-storage').click();
  await page.waitForTimeout(400);
  const backdropCnt = await page.locator('.gm-modal-backdrop').count();
  console.log('B7: confirm backdrops:', backdropCnt);
  expect(backdropCnt).toBeGreaterThan(0);
  const dangerBtn = page.locator('.gm-modal-btn-danger');
  await expect(dangerBtn).toBeVisible();
  // Cancel
  await page.locator('.gm-modal-btn-cancel').click();
  await page.waitForTimeout(200);
});

test('B8 - manual build: select empty slot then participant should fill it', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  // Need an empty slot — easiest: enter manual mode and check
  await page.locator('#btn-manual-build').click();
  await page.waitForTimeout(400);
  const emptyCards = page.locator('.assignment-card.manual-slot-empty');
  const cnt = await emptyCards.count();
  console.log('B8: empty cards in manual mode:', cnt);
  if (cnt > 0) {
    await emptyCards.first().click();
    await page.waitForTimeout(300);
    const selectedCnt = await page.locator('.assignment-card.manual-slot-selected').count();
    console.log('B8: selected slot count:', selectedCnt);
    // Should now show participant warehouse
    const warehouseCnt = await page.locator('.warehouse-card[data-pid]').count();
    console.log('B8: warehouse cards:', warehouseCnt);
  }
});

test('B9 - inject-task modal: form fields render, close works', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#chk-live-mode').check();
  await page.waitForTimeout(400);
  await page.locator('#btn-inject-task').click();
  await page.waitForTimeout(700);
  await expect(page.locator('#inject-modal-backdrop')).toBeVisible();
  // Look for form fields
  const formFields = await page.locator('#inject-modal-backdrop [data-inj]').count();
  console.log('B9: inject form fields:', formFields);
  // Close
  await page.locator('#btn-inject-close').click();
  await page.waitForTimeout(300);
  const stillOpen = await page.locator('#inject-modal-backdrop').count();
  console.log('B9: still open after close:', stillOpen);
  expect(stillOpen).toBe(0);
});

test('B10 - drag-drop: drag participant card to another slot', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  // Drag-drop is only relevant in some modes. Try dragging an assignment-card.
  const cards = page.locator('.assignment-card');
  const count = await cards.count();
  if (count >= 2) {
    const c1 = cards.nth(0);
    const c2 = cards.nth(1);
    const b1 = await c1.boundingBox();
    const b2 = await c2.boundingBox();
    console.log('B10: bounding boxes:', b1, b2);
    if (b1 && b2) {
      await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
      await page.mouse.down();
      await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 5 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      // Check if a confirm dialog or toast appeared
      const modalCnt = await page.locator('.gm-modal-backdrop, .gm-toast, .gm-bottom-sheet-backdrop').count();
      console.log('B10: post-drag modal/toast count:', modalCnt);
    }
  }
});

test('B11 - load-formula modal accessible from task rules tab?', async ({ page }) => {
  await setup(page);
  // Switch to task rules tab and search for load-formula trigger
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(400);
  // Click first task to expand or open
  const tasks = page.locator('.task-template-row, .task-card, [data-task-template-id]');
  const cnt = await tasks.count();
  console.log('B11: task rows in rules tab:', cnt);
  // Search for any button that opens load-formula modal
  const triggers = await page.locator('[data-action*="formula"], [data-action*="load"], [class*="formula-btn"], [class*="load-formula"]').count();
  console.log('B11: formula triggers found:', triggers);
});

test('B12 - profile view: clicking participant name navigates to profile overlay', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const firstHover = page.locator('.participant-hover[data-pid]').first();
  await firstHover.scrollIntoViewIfNeeded();
  await firstHover.click();
  await page.waitForTimeout(500);
  // Profile view should activate. _viewMode = 'PROFILE_VIEW'. Look for profile DOM
  const profileCnt = await page.locator('.profile-view, [data-view="profile"], .tab-profile').count();
  const html = await page.locator('#tab-content').innerHTML();
  console.log('B12: profile DOM count:', profileCnt, 'tab-content first 300:', html.substring(0, 300));
});

test('B13 - day stepper buttons work (‹ ›)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 3);
  // Check for day-hero stepper or day-tab navigation
  const next = page.locator('[data-day-step="1"]');
  const prev = page.locator('[data-day-step="-1"]');
  console.log('B13: prev count:', await prev.count(), 'next count:', await next.count());
  if (await next.count()) {
    // Click via the underlying day-tab if needed
    await page.locator(`.day-tab[data-day="1"]`).click();
    await page.waitForTimeout(150);
    if (await next.count()) await next.first().click();
    await page.waitForTimeout(200);
    const active = await page.locator('.day-tab.day-tab-active').getAttribute('data-day');
    console.log('B13: after next, active=', active);
  }
});

test('B14 - jump to violations KPI tile', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const tile = page.locator('[data-action="jump-to-violations"]');
  const cnt = await tile.count();
  console.log('B14: jump-to-violations tiles:', cnt);
  if (cnt > 0) {
    await tile.first().click();
    await page.waitForTimeout(300);
    const violSec = await page.locator('#violations-section').count();
    console.log('B14: violations section after jump:', violSec);
  }
});

test('B15 - manual build: Esc clears selection', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  await page.locator('#btn-manual-build').click();
  await page.waitForTimeout(300);
  const cards = page.locator('.assignment-card.manual-slot-target');
  if (await cards.count() > 0) {
    await cards.first().click();
    await page.waitForTimeout(200);
    const selectedBefore = await page.locator('.assignment-card.manual-slot-selected').count();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const selectedAfter = await page.locator('.assignment-card.manual-slot-selected').count();
    console.log('B15: selected before/after Esc:', selectedBefore, selectedAfter);
  }
});

test('B16 - workload-popup: click on sidebar entry should show popup', async ({ page }) => {
  await setup(page);
  await generateSchedule(page, 2);
  const entry = page.locator('.sidebar-entries [data-pid], .sidebar-entry[data-pid]');
  const cnt = await entry.count();
  console.log('B16: sidebar entries with data-pid:', cnt);
  if (cnt > 0) {
    await entry.first().click();
    await page.waitForTimeout(400);
    const popupCnt = await page.locator('.workload-popup, .gm-bottom-sheet-backdrop, .gm-modal-backdrop').count();
    console.log('B16: workload popup count:', popupCnt);
  }
});
