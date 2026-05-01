import { test, expect, Page } from '@playwright/test';

test.setTimeout(120000);

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
}

test('probe: generate schedule and explore', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await setup(page);
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#btn-generate').click();
  // Wait for generation result
  await page.waitForFunction(() => document.querySelectorAll('.participant-hover, .task-tooltip-hover, .schedule-grid-view, .swimlane-view').length > 0, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Look at structure
  const data = await page.evaluate(() => {
    const dataActions = Array.from(document.querySelectorAll('[data-action]')).map((e) => ({
      action: (e as HTMLElement).dataset.action,
      tag: e.tagName,
      cls: e.className.slice(0, 80),
    }));
    const ph = document.querySelectorAll('.participant-hover').length;
    const tt = document.querySelectorAll('.task-tooltip-hover').length;
    const kpis = document.querySelectorAll('.kpi-cell, .kpi-hero').length;
    const sidebar = !!document.querySelector('.workload-sidebar');
    const continuityChip = !!document.querySelector('.continuity-chip-clear');
    const seniorToggle = !!document.querySelector('#btn-senior-toggle');
    const sidebarToggle = !!document.querySelector('[data-action="sidebar-toggle"]');
    const availStrip = document.querySelectorAll('.avail-strip').length;
    return {
      dataActionsUnique: [...new Set(dataActions.map((d) => d.action))],
      participantHoverCount: ph,
      taskTooltipHoverCount: tt,
      kpiTilesCount: kpis,
      sidebar,
      continuityChip,
      seniorToggle,
      sidebarToggle,
      availStrip,
      hasGardenWisdom: typeof (window as any).gardenWisdom === 'function',
      hasToggleSchedulerDiag: typeof (window as any).toggleSchedulerDiag === 'function',
    };
  });
  console.log('DATA:', JSON.stringify(data, null, 2));
  console.log('PAGE_ERRORS:', errors);
});
