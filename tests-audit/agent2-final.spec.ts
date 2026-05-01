import { test, expect, type Page } from '@playwright/test';

test.setTimeout(120_000);

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

async function gen(page: Page) {
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.waitForTimeout(200);
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card', { timeout: 10_000 });
  await page.waitForTimeout(300);
}

test('D1 - workload-popup: click sidebar bar opens popup', async ({ page }) => {
  await setup(page);
  await gen(page);
  const bar = page.locator('.sidebar-bar-bg[data-pid]').first();
  const cnt = await bar.count();
  console.log('D1: sidebar bars:', cnt);
  expect(cnt).toBeGreaterThan(0);
  await bar.click();
  await page.waitForTimeout(500);
  const popupCnt = await page.locator('.workload-popup').count();
  console.log('D1: popup count:', popupCnt);
  expect(popupCnt).toBeGreaterThan(0);
});

test('D2 - load-formula: expand template, then trigger', async ({ page }) => {
  await setup(page);
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(500);
  // Click on a template-card to expand it (template-card data-template-id)
  const card = page.locator('.template-card[data-template-id]').first();
  const cardCnt = await card.count();
  console.log('D2: template cards:', cardCnt);
  if (cardCnt > 0) {
    await card.click();
    await page.waitForTimeout(400);
    const triggerCnt = await page.locator('[data-action="open-load-formula"]').count();
    console.log('D2: open-load-formula triggers after expand:', triggerCnt);
    if (triggerCnt > 0) {
      await page.locator('[data-action="open-load-formula"]').first().click();
      await page.waitForTimeout(500);
      const modal = await page.locator('.gm-modal-backdrop, [class*="load-formula"]').count();
      console.log('D2: load-formula modal open:', modal);
    }
  }
});

test('D3 - export Excel: select radio, click export', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#btn-export-pdf').click();
  await page.waitForTimeout(300);
  // Click the Excel radio
  await page.locator('input[name="export-format"][value="excel"]').check();
  await page.waitForTimeout(200);
  const dlPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => null);
  await page.locator('#export-do').click();
  const dl = await dlPromise;
  console.log('D3: xlsx download:', dl ? dl.suggestedFilename() : 'none');
  expect(dl).not.toBeNull();
});

test('D4 - profile view: round-trip', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('.participant-hover[data-pid]').first().click({ force: true });
  await page.waitForTimeout(500);
  const profCnt = await page.locator('[data-action="back-to-schedule"]').count();
  console.log('D4: back-to-schedule btn count:', profCnt);
  expect(profCnt).toBeGreaterThan(0);
  await page.locator('[data-action="back-to-schedule"]').click();
  await page.waitForTimeout(500);
  // Should be back on schedule (assignment-card visible)
  const cards = await page.locator('.assignment-card').count();
  console.log('D4: cards after back:', cards);
  expect(cards).toBeGreaterThan(0);
});

test('D5 - participant cell drag: assignment-card has no draggable attribute', async ({ page }) => {
  await setup(page);
  await gen(page);
  const card = page.locator('.assignment-card').first();
  // Test if the card or a child has draggable=true / dragstart handler
  const result = await card.evaluate((el) => {
    const cardDraggable = (el as HTMLElement).draggable;
    // Look for any element inside with draggable attribute
    const all = el.querySelectorAll('*');
    let anyDraggable = false;
    for (const e of Array.from(all)) {
      if ((e as HTMLElement).draggable) { anyDraggable = true; break; }
    }
    return { cardDraggable, anyDraggable };
  });
  console.log('D5: card draggable=', result.cardDraggable, 'any-child-draggable=', result.anyDraggable);
});

test('D6 - manual build: warehouse card click without selected slot is no-op?', async ({ page }) => {
  const { consoleErrors } = await setup(page);
  await gen(page);
  await page.locator('#btn-manual-build').click();
  await page.waitForTimeout(400);
  // Click warehouse card without first selecting a slot
  const wcard = page.locator('.warehouse-card[data-pid]').first();
  const cnt = await wcard.count();
  console.log('D6: warehouse cards:', cnt);
  if (cnt > 0) {
    await wcard.click();
    await page.waitForTimeout(300);
    // Check: was a slot auto-filled?
    const newAssignments = await page.locator('.assignment-card .participant-name').count();
    console.log('D6: assignments now:', newAssignments, 'console errors:', consoleErrors.length);
  }
});

test('D7 - swimlane content rendered when expanded', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.waitForTimeout(500);
  const swimSection = page.locator('.swimlane-section');
  const cnt = await swimSection.count();
  console.log('D7: swimlane section count:', cnt);
  if (cnt > 0) {
    const collapsed = await swimSection.first().evaluate((el) => el.classList.contains('swimlane-section--collapsed'));
    console.log('D7: collapsed initially:', collapsed);
    // Body should be present
    const bodyHtml = await page.locator('.swimlane-section-body').first().innerHTML();
    console.log('D7: body html len:', bodyHtml.length);
  }
});

test('D8 - gantt chart rendered on desktop', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.waitForTimeout(500);
  const gantt = page.locator('.gantt-section');
  const cnt = await gantt.count();
  console.log('D8: gantt section count:', cnt);
  if (cnt > 0) {
    const html = await gantt.first().innerHTML();
    console.log('D8: gantt html len:', html.length);
    // Look for SVG / rendered chart elements
    const svgCnt = await page.locator('.gantt-section svg').count();
    console.log('D8: svg count in gantt:', svgCnt);
  }
});

test('D9 - inject-task: switching to plans phase', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#chk-live-mode').check();
  await page.waitForTimeout(400);
  await page.locator('#btn-inject-task').click();
  await page.waitForTimeout(700);
  // Fill required fields and click run
  await page.locator('#inject-modal-backdrop [data-inj="name"]').fill('TestEmergency');
  await page.locator('#btn-inject-run').click();
  await page.waitForTimeout(2000);
  // Check if plans rendered (data-inj-action="select-plan")
  const plansCnt = await page.locator('[data-inj-action="select-plan"]').count();
  console.log('D9: plan options count:', plansCnt);
  // Or back button
  const backCnt = await page.locator('#btn-inject-back').count();
  console.log('D9: back button count:', backCnt);
});

test('D10 - rescue: applying first plan dismisses modal', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#chk-live-mode').check();
  await page.waitForTimeout(500);
  const futureHover = page.locator('.participant-hover[data-pid][data-assignment-id]:not([data-frozen="1"])').first();
  await futureHover.scrollIntoViewIfNeeded();
  await futureHover.hover();
  await page.waitForTimeout(400);
  await page.locator('.participant-tooltip button.btn-rescue').click();
  await page.waitForTimeout(1500);
  // Click first apply button
  const applyButtons = page.locator('#rescue-modal-backdrop button:has-text("✅")');
  const applyCnt = await applyButtons.count();
  console.log('D10: apply buttons:', applyCnt);
  if (applyCnt > 0) {
    await applyButtons.first().click();
    await page.waitForTimeout(800);
    const modalAfter = await page.locator('#rescue-modal-backdrop').count();
    console.log('D10: rescue modal after apply:', modalAfter);
    expect(modalAfter).toBe(0);
  }
});
