import { test, expect, type Page } from '@playwright/test';
test.setTimeout(60_000);

test('VERIFY load-formula modal opens', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.locator('.tab-btn[data-tab="task-rules"]').click();
  await page.waitForTimeout(500);
  // Click the first template card to expand
  const card = page.locator('.template-card[data-template-id]').first();
  await card.click();
  await page.waitForTimeout(400);
  // Click load-formula button
  const trigger = page.locator('[data-action="open-load-formula"]').first();
  console.log('VERIFY: trigger count:', await trigger.count());
  await trigger.click({ force: true });
  await page.waitForTimeout(500);
  // Look for #lf-modal-backdrop
  const lf = await page.locator('#lf-modal-backdrop').count();
  console.log('VERIFY: lf-modal-backdrop count:', lf);
  // Look for any new backdrop
  const allBackdrops = await page.evaluate(() => {
    const bds: string[] = [];
    document.querySelectorAll('[class*="backdrop"], [id*="backdrop"], [class*="modal"]').forEach((el) => {
      bds.push(`${(el as HTMLElement).id || ''}|${(el as HTMLElement).className}`);
    });
    return bds;
  });
  console.log('VERIFY: backdrops in DOM:', JSON.stringify(allBackdrops));
});

test('VERIFY drag-drop has no listeners', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10_000 });
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#input-days').fill('2');
  await page.locator('#input-scenarios').fill('5');
  await page.locator('#btn-generate').click();
  await page.waitForFunction(() => !document.querySelector('.optim-overlay'), null, { timeout: 90_000 });
  await page.waitForSelector('.assignment-card');
  // Search for any HTML5 drag attribute or pointer-based drag handlers
  const hasDragHandlers = await page.evaluate(() => {
    const cards = document.querySelectorAll('.assignment-card');
    let dragAttrs = 0;
    cards.forEach((c) => { if ((c as HTMLElement).draggable) dragAttrs++; });
    // Check schedule layout for any data-action="drag" attributes
    const dragLikeAttrs = document.querySelectorAll('[data-action*="drag"], [data-draggable], [data-drop]').length;
    return { totalCards: cards.length, draggableCards: dragAttrs, dragAttrs: dragLikeAttrs };
  });
  console.log('VERIFY-DRAG:', JSON.stringify(hasDragHandlers));
});
