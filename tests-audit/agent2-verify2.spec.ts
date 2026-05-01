import { test, expect } from '@playwright/test';
test.setTimeout(60_000);

test('Enter on participant-hover does NOT navigate or toggle tooltip', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card');

  // Find a participant-hover with role=button + tabindex=0
  const target = page.locator('.participant-hover[data-pid][role="button"]').first();
  const cnt = await target.count();
  console.log('VERIFY: matching participant-hover count:', cnt);
  expect(cnt).toBeGreaterThan(0);

  // Focus it
  await target.focus();
  // Press Enter
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  // Check whether profile view opened (back-to-schedule btn should exist in profile)
  const backBtnCnt = await page.locator('[data-action="back-to-schedule"]').count();
  // Check whether tooltip showed up
  const ttVisible = await page.evaluate(() => {
    const t = document.querySelector('.participant-tooltip') as HTMLElement | null;
    return t ? t.style.display !== 'none' : false;
  });
  console.log('VERIFY: after Enter — backBtnCnt:', backBtnCnt, 'tooltip visible:', ttVisible);
  // If both are 0/false → Enter activation is broken (a11y defect)
});

test('Space on participant-hover does NOT navigate or toggle tooltip', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card');

  const target = page.locator('.participant-hover[data-pid][role="button"]').first();
  await target.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const backBtnCnt = await page.locator('[data-action="back-to-schedule"]').count();
  const ttVisible = await page.evaluate(() => {
    const t = document.querySelector('.participant-tooltip') as HTMLElement | null;
    return t ? t.style.display !== 'none' : false;
  });
  console.log('VERIFY-SPACE: after Space — backBtnCnt:', backBtnCnt, 'tooltip visible:', ttVisible);
});

test('time-cell Enter activates inspect (control test)', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card');

  // Time cells are inspectable via Enter — just confirms the keydown listener works for some elements
  const tc = page.locator('.time-cell-inspectable[data-time-ms]').first();
  const cnt = await tc.count();
  console.log('TC: time-cell-inspectable count:', cnt);
  if (cnt > 0) {
    await tc.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    // Check selection state — is there a `.time-cell-range-start` class added?
    const rangeStart = await page.locator('.time-cell-range-start').count();
    console.log('TC: range-start count after Enter:', rangeStart);
  }
});
