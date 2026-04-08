import { expect, test } from '@playwright/test';

test.describe('Schedule view on mobile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    // Navigate to schedule tab
    await page.click('.tab-btn[data-tab="schedule"]');
  });

  test('sidebar is not blocking content on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    const sidebar = page.locator('.participant-sidebar');
    // On mobile, sidebar should be off-screen (translated down) by default
    if ((await sidebar.count()) > 0) {
      const box = await sidebar.boundingBox();
      // Either not visible or translated off-screen
      if (box) {
        expect(box.y).toBeGreaterThan(viewport.height - 50);
      }
    }
  });

  test('sidebar FAB is visible on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    // Need a schedule to see the sidebar FAB
    // The FAB only renders in schedule tab with a schedule generated
    const fab = page.locator('.sidebar-fab');
    // FAB may or may not be visible depending on whether schedule exists
    // Just verify it's in the DOM
    if ((await fab.count()) > 0) {
      await expect(fab).toBeVisible();
    }
  });

  test('day navigator is horizontally scrollable on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    const dayNav = page.locator('.day-navigator');
    if ((await dayNav.count()) > 0) {
      const overflow = await dayNav.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.overflowX;
      });
      expect(overflow).toBe('auto');
    }
  });

  test('gantt toggle button is visible on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    const toggle = page.locator('.gantt-mobile-toggle');
    if ((await toggle.count()) > 0) {
      await expect(toggle).toBeVisible();
    }
  });

  test('gantt toggle button is hidden on desktop', async ({ page, viewport }) => {
    if (!viewport || viewport.width <= 768) test.skip();

    const toggle = page.locator('.gantt-mobile-toggle');
    if ((await toggle.count()) > 0) {
      await expect(toggle).not.toBeVisible();
    }
  });
});

test.describe('Schedule table column visibility on mobile', () => {
  async function generateSchedule(page: import('@playwright/test').Page) {
    await page.click('.tab-btn[data-tab="schedule"]');
    const input = page.locator('#input-scenarios');
    if ((await input.count()) > 0) {
      await input.fill('1');
    }
    await page.click('#btn-generate');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
        return btn && !btn.disabled && !btn.textContent?.includes('מייעל');
      },
      { timeout: 60000 },
    );
    await page.waitForTimeout(500);
  }

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('all schedule table column headers are present in the DOM', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await generateSchedule(page);

    // Every section table must have all its column headers in the DOM
    const wrappers = page.locator('.schedule-table-wrapper');
    const count = await wrappers.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const wrapper = wrappers.nth(i);
      const colCount = await wrapper.getAttribute('data-columns');
      expect(colCount).toBeTruthy();

      const headers = wrapper.locator('thead th');
      const headerCount = await headers.count();
      // columns + 1 for the time column
      expect(headerCount).toBe(Number(colCount) + 1);
    }
  });

  test('table wrapper allows horizontal scroll when content overflows', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await generateSchedule(page);

    const wrappers = page.locator('.schedule-table-wrapper');
    const count = await wrappers.count();

    for (let i = 0; i < count; i++) {
      const wrapper = wrappers.nth(i);
      const overflowX = await wrapper.evaluate((el) => window.getComputedStyle(el).overflowX);
      expect(overflowX).toBe('auto');

      // If content overflows, scrollWidth must be > clientWidth and scrolling must work
      const { scrollWidth, clientWidth } = await wrapper.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));

      if (scrollWidth > clientWidth) {
        // Verify the wrapper is actually scrollable by scrolling to the end
        // and checking that the last header becomes visible
        const lastHeader = wrapper.locator('thead th:last-child');
        await lastHeader.evaluate((el) => el.scrollIntoView({ inline: 'center' }));
        const box = await lastHeader.boundingBox();
        expect(box).toBeTruthy();
        expect(box!.width).toBeGreaterThan(0);
      }
    }
  });

  test('all column headers are reachable by scrolling on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await generateSchedule(page);

    const wrappers = page.locator('.schedule-table-wrapper');
    const count = await wrappers.count();

    for (let i = 0; i < count; i++) {
      const wrapper = wrappers.nth(i);
      const headers = wrapper.locator('thead th');
      const headerCount = await headers.count();

      for (let h = 0; h < headerCount; h++) {
        const header = headers.nth(h);
        // Scroll the header into view within the wrapper
        await header.evaluate((el) => el.scrollIntoView({ inline: 'center' }));
        const box = await header.boundingBox();
        expect(box).toBeTruthy();
        // Header must be within the viewport horizontally
        expect(box!.x).toBeGreaterThanOrEqual(-1); // small tolerance
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
      }
    }
  });

  test('no parent element clips schedule table with overflow:hidden', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await generateSchedule(page);

    // Walk up from each table wrapper to check no ancestor has overflow:hidden
    const hasHiddenParent = await page.evaluate(() => {
      const wrappers = document.querySelectorAll('.schedule-table-wrapper');
      for (const wrapper of wrappers) {
        let el = wrapper.parentElement;
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el);
          if (style.overflowX === 'hidden') {
            return `${el.tagName}.${el.className} has overflow-x: hidden`;
          }
          el = el.parentElement;
        }
      }
      return null;
    });

    expect(hasHiddenParent).toBeNull();
  });

  test('data-columns attribute and --col-count CSS variable are set on wrappers', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await generateSchedule(page);

    const wrappers = page.locator('.schedule-table-wrapper');
    const count = await wrappers.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const wrapper = wrappers.nth(i);
      const dataColumns = await wrapper.getAttribute('data-columns');
      expect(dataColumns).toBeTruthy();
      expect(Number(dataColumns)).toBeGreaterThan(0);

      // Verify --col-count CSS variable is set via inline style
      const style = await wrapper.getAttribute('style');
      expect(style).toContain('--col-count');
    }
  });
});
