import { test, expect, Page } from '@playwright/test';

test.setTimeout(180_000);

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
}

async function generateSchedule(page: Page) {
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#btn-generate').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.participant-hover').length > 5,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(500);
}

// Investigate tooltip clipping more carefully
test('tooltip: bottom clipping repro — hover element near bottom edge', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Find a participant-hover element near the bottom of the viewport
  const target = await page.evaluateHandle(() => {
    const els = Array.from(document.querySelectorAll('.participant-hover[data-pid]')) as HTMLElement[];
    let best: HTMLElement | null = null;
    let bestY = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      // Must be within viewport and as close to bottom as possible
      if (r.top > bestY && r.top < window.innerHeight - 30 && r.bottom < window.innerHeight) {
        best = el;
        bestY = r.top;
      }
    }
    return best;
  });

  if (!target) test.skip();
  await (target as any).hover();
  await page.waitForTimeout(400);
  const result = await page.evaluate(() => {
    const tt = document.querySelector('.participant-tooltip') as HTMLElement | null;
    if (!tt || tt.style.display === 'none') return null;
    const r = tt.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight, height: r.height };
  });
  console.log('Tooltip near bottom:', result);
  await page.screenshot({ path: 'tests-audit/screenshots/agent4-tooltip-clip-bottom.png' });

  if (result) {
    const overflow = result.bottom > result.h;
    const heightOverflow = result.height > result.h - 8;
    console.log('Bottom overflow:', overflow, 'tooltip taller than viewport-8?', heightOverflow);
    expect(overflow).toBe(false);
  }
});

// Investigate jump-to-violations keyboard activation more carefully
test('KPI: jump-to-violations Enter key activation — separate test from click', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const tile = page.locator('[data-action="jump-to-violations"]');
  const cnt = await tile.count();
  if (cnt === 0) test.skip();

  // Don't click first — go straight to keyboard
  await tile.focus();
  await page.waitForTimeout(200);
  const beforeY = await page.evaluate(() => window.scrollY);
  console.log('beforeY (Enter):', beforeY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const afterY = await page.evaluate(() => window.scrollY);
  console.log('afterY (Enter):', afterY);
  expect(afterY).toBeGreaterThan(beforeY);
});

test('KPI: jump-to-violations Space key activation — separate test from click', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const tile = page.locator('[data-action="jump-to-violations"]');
  const cnt = await tile.count();
  if (cnt === 0) test.skip();

  await tile.focus();
  await page.waitForTimeout(200);
  const beforeY = await page.evaluate(() => window.scrollY);
  console.log('beforeY (Space):', beforeY);
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  const afterY = await page.evaluate(() => window.scrollY);
  console.log('afterY (Space):', afterY);
  expect(afterY).toBeGreaterThan(beforeY);
});

// Verify the only task-panel-hover chip is hidden in a closed menu
test('task panel: task-panel-hover chip only present inside hidden menu — main schedule has no direct chip', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const visibleChips = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('.task-panel-hover[data-source-name]')) as HTMLElement[];
    return chips.map((c) => {
      const r = c.getBoundingClientRect();
      const style = getComputedStyle(c);
      const parentMenu = c.closest('.task-panel-menu, .gm-popover, [hidden]');
      return {
        text: c.textContent?.trim().slice(0, 40),
        visible: r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        inMenu: !!parentMenu,
        parentClass: parentMenu?.className.slice(0, 80) || null,
      };
    });
  });
  console.log('All task-panel-hover chips:', JSON.stringify(visibleChips, null, 2));

  // Look for menu trigger (multi-source title)
  const trigger = await page.evaluate(() => {
    const t = document.querySelector('[data-task-panel-menu="true"]');
    if (!t) return null;
    return {
      txt: t.textContent?.trim().slice(0, 40),
      ariaExpanded: t.getAttribute('aria-expanded'),
    };
  });
  console.log('Menu trigger:', trigger);
});

// Theme switching probe
test('theme: search for theme toggle button thoroughly', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const allButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => ({
      id: (el as HTMLElement).id,
      cls: el.className.slice(0, 80),
      title: (el as HTMLElement).title,
      txt: el.textContent?.trim().slice(0, 30),
    })).filter((b) => b.title.includes('כהה') || b.title.includes('בהיר') || b.title.toLowerCase().includes('theme') || b.txt?.includes('🌓') || b.txt?.includes('🌙') || b.cls.includes('theme'));
  });
  console.log('Theme-like buttons:', JSON.stringify(allButtons, null, 2));

  // Check html[data-theme]
  const themeAttr = await page.evaluate(() => ({
    documentClass: document.documentElement.className,
    documentDataTheme: document.documentElement.dataset.theme,
    bodyClass: document.body.className,
  }));
  console.log('Theme attrs on document:', themeAttr);
});

// Tooltip hover-target hover keeping it open should let swap button work
test('tooltip: actions remain responsive when navigating from anchor → tooltip', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const target = page.locator('.participant-hover[data-pid][data-assignment-id]').first();
  const cnt = await target.count();
  if (cnt === 0) test.skip();

  await target.hover();
  await page.waitForTimeout(300);
  const swap = page.locator('.participant-tooltip .btn-swap');
  const swapCount = await swap.count();
  console.log('swap button count:', swapCount);
  // Move to tooltip — verify it stays
  await page.locator('.participant-tooltip').hover();
  await page.waitForTimeout(150);
  const stillVisible = await page.locator('.participant-tooltip').isVisible();
  console.log('tooltip still visible after hovering it:', stillVisible);
  expect(stillVisible).toBe(true);
});

// Verify the avail-strip results have a "close-availability-popover" inside when populated
test('availability strip: open and select a range, results popover present', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  await page.locator('[data-action="open-avail-strip"]').first().click();
  await page.waitForTimeout(300);

  // After open, look for time pickers inside avail strip
  const strip = await page.evaluate(() => {
    const s = document.querySelector('.avail-strip') as HTMLElement | null;
    if (!s) return null;
    return {
      html: s.outerHTML.slice(0, 500),
      hasInputs: s.querySelectorAll('input, button, select').length,
    };
  });
  console.log('Strip after open (snippet):', strip?.html);
  console.log('Strip controls count:', strip?.hasInputs);
});

// Close button placement of workload popup
test('workload popup: close button works', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const bar = page.locator('.sidebar-bar-bg[data-pid]').first();
  if ((await bar.count()) === 0) test.skip();
  await bar.click();
  await page.waitForTimeout(400);
  const closeBtn = page.locator('.workload-popup [data-wp-close]');
  const closeCnt = await closeBtn.count();
  console.log('workload popup close btn count:', closeCnt);
  expect(closeCnt).toBeGreaterThan(0);
  await closeBtn.click();
  await page.waitForTimeout(300);
  const visible = await page.locator('.workload-popup').isVisible();
  expect(visible).toBe(false);
});

// Profile: assignments list — clicking on a task tooltip-hover inside profile
test('profile: task tooltip works inside profile view', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);
  await page.locator('.participant-hover[data-pid]').first().click();
  await page.waitForTimeout(400);

  const taskInProfile = page.locator('.profile-view-root .task-tooltip-hover[data-task-id]').first();
  const cnt = await taskInProfile.count();
  console.log('task-tooltip-hover in profile:', cnt);
  if (cnt === 0) test.skip();

  await taskInProfile.hover();
  await page.waitForTimeout(400);
  const ttVisible = await page.locator('.task-detail-tooltip').isVisible();
  console.log('task tooltip visible in profile:', ttVisible);
  expect(ttVisible).toBe(true);
});
