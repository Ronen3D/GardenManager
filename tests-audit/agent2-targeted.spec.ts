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

test('C1 - profile navigation: clicking participant name shows profile view', async ({ page }) => {
  const { consoleErrors, pageErrors } = await setup(page);
  await gen(page);
  const firstHover = page.locator('.participant-hover[data-pid]').first();
  await firstHover.scrollIntoViewIfNeeded();
  // Click triggers navigateToProfile (desktop only)
  await firstHover.click({ force: true });
  await page.waitForTimeout(500);
  // Check the body / tab-content for profile-view markers
  const bodyHtml = await page.evaluate(() => document.body.innerHTML.length);
  console.log('C1: body html len:', bodyHtml);
  // Look for known profile-view DOM hooks (search source: profile-view)
  const candidates = [
    '.profile-view-back',
    '[data-action="back-to-schedule"]',
    '.tab-profile-view',
    '.profile-back',
    '.profile-view-container',
    '.btn-profile-back',
    '.profile-name',
    'h1.profile-title',
    '.profile-page',
  ];
  for (const sel of candidates) {
    const cnt = await page.locator(sel).count();
    if (cnt > 0) console.log(`C1: found ${cnt} of "${sel}"`);
  }
  // Output the visible top of tab content
  const tab = await page.locator('#tab-content').first();
  const innerLen = await tab.innerHTML().then((h) => h.length);
  console.log('C1: tab-content inner len:', innerLen);
  console.log('C1: console errors:', consoleErrors.length, 'page errors:', pageErrors.length);
});

test('C2 - workload-popup: click on sidebar entry', async ({ page }) => {
  const { consoleErrors, pageErrors } = await setup(page);
  await gen(page);
  // Look for sidebar entries
  const sels = ['.sidebar-entry[data-pid]', '.sidebar-entries [data-pid]', '.sidebar-bar[data-pid]'];
  for (const sel of sels) {
    const c = await page.locator(sel).count();
    console.log('C2: count', sel, '=', c);
  }
  // Click first
  const entry = page.locator('.sidebar-entries [data-pid]').first();
  if (await entry.count() === 0) {
    console.log('C2: no sidebar entries found');
    return;
  }
  // Inspect what HTML elements have click bindings — get first element's HTML
  const html = await entry.evaluate((el) => (el as HTMLElement).outerHTML.substring(0, 200));
  console.log('C2: first entry html:', html);
  await entry.click();
  await page.waitForTimeout(500);
  const popup = await page.locator('.workload-popup, .workload-bottom-sheet, .gm-bottom-sheet-backdrop, .gm-modal-backdrop').count();
  console.log('C2: popup count:', popup);
  console.log('C2: console errors:', consoleErrors.length, 'page errors:', pageErrors.length);
});

test('C3 - load-formula: open from task rules tab', async ({ page }) => {
  const { consoleErrors, pageErrors } = await setup(page);
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(800);
  // Look for the trigger button data-action="open-load-formula"
  const triggers = page.locator('[data-action="open-load-formula"], [data-action="open-load-formula-new"]');
  const cnt = await triggers.count();
  console.log('C3: load-formula trigger count:', cnt);
  if (cnt > 0) {
    await triggers.first().scrollIntoViewIfNeeded();
    await triggers.first().click({ force: true });
    await page.waitForTimeout(500);
    const modalCnt = await page.locator('.load-formula-modal, [class*="load-formula"], .gm-modal-backdrop').count();
    console.log('C3: load-formula modal count:', modalCnt);
  }
});

test('C4 - drag-drop: assignment-card draggable?', async ({ page }) => {
  await setup(page);
  await gen(page);
  const card = page.locator('.assignment-card').first();
  const draggable = await card.evaluate((el) => (el as HTMLElement).draggable);
  console.log('C4: assignment-card draggable attr:', draggable);
  // Listen for drag events
  await page.evaluate(() => {
    (window as any).__dragEvts = [];
    document.addEventListener('dragstart', () => (window as any).__dragEvts.push('dragstart'));
  });
  const b = await card.boundingBox();
  if (b) {
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 200, b.y + 200, { steps: 5 });
    await page.mouse.up();
    const evts = await page.evaluate(() => (window as any).__dragEvts || []);
    console.log('C4: drag events:', JSON.stringify(evts));
  }
});

test('C5 - inject task modal: try to actually run injection', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#chk-live-mode').check();
  await page.waitForTimeout(400);
  await page.locator('#btn-inject-task').click();
  await page.waitForTimeout(700);
  await expect(page.locator('#inject-modal-backdrop')).toBeVisible();
  // List the form fields
  const fields = page.locator('#inject-modal-backdrop [data-inj]');
  const cnt = await fields.count();
  for (let i = 0; i < cnt; i++) {
    const f = fields.nth(i);
    const dataInj = await f.getAttribute('data-inj');
    const tag = await f.evaluate((el) => el.tagName);
    console.log('C5: field', i, dataInj, tag);
  }
  // Try clicking run button
  const runBtn = page.locator('#btn-inject-run');
  const runCnt = await runBtn.count();
  console.log('C5: run btn count:', runCnt);
  if (runCnt > 0) {
    const enabled = await runBtn.isEnabled();
    console.log('C5: run btn enabled:', enabled);
  }
});

test('C6 - rescue modal: apply/cancel buttons and plan list', async ({ page }) => {
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
  await expect(page.locator('#rescue-modal-backdrop')).toBeVisible();
  // Look for buttons inside
  const allButtons = await page.locator('#rescue-modal-backdrop button').count();
  const closeBtnCnt = await page.locator('#rescue-modal-backdrop [data-action="close"], #rescue-modal-backdrop .rescue-close, #rescue-modal-backdrop #btn-rescue-close').count();
  console.log('C6: total buttons in rescue modal:', allButtons, 'close-like:', closeBtnCnt);
  // List action buttons
  const buttons = page.locator('#rescue-modal-backdrop button');
  const n = await buttons.count();
  for (let i = 0; i < Math.min(n, 10); i++) {
    const text = await buttons.nth(i).textContent();
    const id = await buttons.nth(i).getAttribute('id');
    console.log(`C6: btn[${i}] id=${id} text="${text?.trim().substring(0,30)}"`);
  }
});

test('C7 - export panel: switch format select, export Excel', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#btn-export-pdf').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#export-modal-backdrop')).toBeVisible();
  // List format choices
  const formatGroup = await page.locator('#export-format-group').innerHTML();
  console.log('C7: export-format-group html (first 500):', formatGroup.substring(0, 500));
  // Try clicking an Excel-related option
  const xlsxBtn = page.locator('#export-format-group [data-format="xlsx"], #export-format-group [data-format="excel"]');
  const xlsxCnt = await xlsxBtn.count();
  console.log('C7: xlsx button count:', xlsxCnt);
  if (xlsxCnt > 0) {
    await xlsxBtn.first().click();
    await page.waitForTimeout(200);
    const dlPromise = page.waitForEvent('download', { timeout: 8_000 }).catch(() => null);
    await page.locator('#export-do').click();
    const dl = await dlPromise;
    console.log('C7: xlsx download:', dl ? dl.suggestedFilename() : 'none');
  }
});

test('C8 - toggle violations panel content visible', async ({ page }) => {
  await setup(page);
  await gen(page);
  // Force at least 1 violation: disable all participants except a few
  // Easier path: just check whether the toggle exists and works if present
  const tog = page.locator('[data-action="toggle-violations"]');
  const cnt = await tog.count();
  console.log('C8: violations-toggle count:', cnt);
  if (cnt > 0) {
    const beforeAria = await tog.first().getAttribute('aria-expanded');
    await tog.first().click();
    await page.waitForTimeout(200);
    const afterAria = await page.locator('[data-action="toggle-violations"]').first().getAttribute('aria-expanded');
    console.log('C8: aria before/after:', beforeAria, afterAria);
    expect(afterAria).not.toBe(beforeAria);
  } else {
    console.log('C8: no violations to test toggle (zero-violation schedule). Look for violations-section instead');
    const sec = await page.locator('#violations-section').count();
    console.log('C8: violations-section exists:', sec);
  }
});

test('C9 - sidebar entry workload-popup direct trigger', async ({ page }) => {
  await setup(page);
  await gen(page);
  // Look at the sidebar entry HTML
  const html = await page.locator('.participant-sidebar').first().innerHTML();
  console.log('C9: sidebar inner html (first 800):', html.substring(0, 800));
});

test('C10 - manual build: warehouse rendered, search filter input wired', async ({ page }) => {
  await setup(page);
  await gen(page);
  await page.locator('#btn-manual-build').click();
  await page.waitForTimeout(400);
  const warehouse = await page.locator('.participant-warehouse, .manual-warehouse, .warehouse-card').count();
  console.log('C10: warehouse-related counts:', warehouse);
  const filter = page.locator('#warehouse-filter');
  const filterCnt = await filter.count();
  console.log('C10: filter input count:', filterCnt);
  if (filterCnt > 0) {
    await filter.fill('xx');
    await page.waitForTimeout(200);
    const after = await page.locator('.warehouse-card[data-pid]').count();
    console.log('C10: warehouse cards after filter "xx":', after);
  }
});

test('C11 - generate-from-day actually re-generates', async ({ page }) => {
  await setup(page);
  await gen(page);
  // Click on day 2
  await page.locator('.day-tab[data-day="2"]').click();
  await page.waitForTimeout(150);
  await page.locator('#btn-generate-from-day').click();
  await page.waitForTimeout(500);
  // Look for confirm or for optimization to begin
  const optim = await page.locator('.optim-overlay').count();
  const modal = await page.locator('.gm-modal-backdrop').count();
  console.log('C11: optim=', optim, 'modal=', modal);
});

test('C12 - sidebar collapse + sidebar visible', async ({ page }) => {
  await setup(page);
  await gen(page);
  const sidebar = page.locator('.participant-sidebar');
  const isCollapsed = await sidebar.evaluate((el) => el.classList.contains('sidebar-collapsed'));
  console.log('C12: initial collapsed:', isCollapsed);
  const tog = page.locator('.sidebar-toggle[data-action="sidebar-toggle"]');
  await tog.click();
  await page.waitForTimeout(200);
  const after = await page.locator('.participant-sidebar').first().evaluate((el) => el.classList.contains('sidebar-collapsed'));
  console.log('C12: after toggle collapsed:', after);
  expect(after).not.toBe(isCollapsed);
});

test('C13 - schedule grid keyboard activation: Enter on participant', async ({ page }) => {
  await setup(page);
  await gen(page);
  const first = page.locator('.participant-hover[data-pid]').first();
  await first.focus();
  // Try pressing Enter — should it activate? Read source: role=button + tabindex=0 — no Enter handler!
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const tt = await page.locator('.participant-tooltip').evaluate((el) => (el as HTMLElement).style.display !== 'none').catch(() => false);
  // Profile activation
  const profileLike = await page.locator('h1, .profile-back').count();
  console.log('C13: tooltip visible after Enter:', tt, 'profile-like:', profileLike);
});

test('C14 - day-hero stepper visibility on desktop', async ({ page }) => {
  await setup(page);
  await gen(page);
  const stepper = page.locator('.day-hero-step[data-day-step="1"]');
  const cnt = await stepper.count();
  const visible = cnt > 0 ? await stepper.first().isVisible() : false;
  console.log('C14: day-hero-step count:', cnt, 'visible:', visible);
  // Per source it's a hero (mobile) navigation; on desktop the .day-hero is hidden via CSS
  // If it's visible at 1280×800 something is wrong; if not, this is fine.
});
