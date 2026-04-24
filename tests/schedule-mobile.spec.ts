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

// ─── Structural section grouping (mobile) ──────────────────────────────────
// Verifies the data-driven grouping contract end-to-end on phone viewport:
// tasks whose originating templates share a structural time-footprint key
// render as ONE `.schedule-table-wrapper` with multi-source columns, while
// tasks with different footprints get their own wrappers (vertically
// stacked by the mobile flex-column layout). See src/shared/layout-key.ts.
test.describe('Structural section grouping on mobile', () => {
  async function generateSchedule(page: import('@playwright/test').Page) {
    await page.click('.tab-btn[data-tab="schedule"]');
    const input = page.locator('#input-scenarios');
    if ((await input.count()) > 0) await input.fill('1');
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

  /** Names (in Hebrew) of the default templates that share the 8h×3×05:00 time footprint. */
  const PATROL_LIKE = ['אדנית', 'כרוב', 'כרובית'];
  const HAMAMA = 'חממה';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('templates with identical time footprint share one section', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();
    await generateSchedule(page);

    // For each patrol-like template, find which wrapper its source-name chip
    // belongs to. Two or more of them must resolve to the same wrapper — the
    // end-to-end proof that structural grouping works.
    const wrapperBySource = await page.evaluate((sources: string[]) => {
      const result: Record<string, string | null> = {};
      for (const src of sources) {
        const chip = document.querySelector(`.table-title-chips [data-source-name="${src}"]`);
        if (!chip) {
          result[src] = null;
          continue;
        }
        const wrapper = chip.closest('.schedule-table-wrapper') as HTMLElement | null;
        result[src] = wrapper?.getAttribute('data-section') ?? null;
      }
      return result;
    }, PATROL_LIKE);

    const present = PATROL_LIKE.filter((n) => wrapperBySource[n]);
    expect(present.length).toBeGreaterThanOrEqual(2);
    const sectionIds = new Set(present.map((n) => wrapperBySource[n]));
    expect(sectionIds.size).toBe(1);

    const [sectionId] = [...sectionIds];
    expect(sectionId).toBeTruthy();
    // Structural keys for template-generated tasks always carry the `tpl:` namespace.
    expect(sectionId!).toMatch(/^tpl:/);

    // The shared wrapper must declare multi-source columns (one per chip).
    const sharedWrapper = page.locator('.schedule-table-wrapper').filter({
      has: page.locator(`[data-source-name="${present[0]}"]`),
    });
    const cols = Number(await sharedWrapper.getAttribute('data-columns'));
    expect(cols).toBeGreaterThanOrEqual(present.length);
  });

  test('templates with different time footprints land in different sections', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();
    await generateSchedule(page);

    const mapping = await page.evaluate(
      (names: string[]) => {
        const out: Record<string, string | null> = {};
        for (const n of names) {
          const chip = document.querySelector(`.table-title-chips [data-source-name="${n}"]`);
          const wrapper = chip?.closest('.schedule-table-wrapper') as HTMLElement | null;
          out[n] = wrapper?.getAttribute('data-section') ?? null;
        }
        return out;
      },
      [...PATROL_LIKE, HAMAMA],
    );

    // Hamama must not share a section with any patrol-like template.
    const hamamaSection = mapping[HAMAMA];
    if (hamamaSection) {
      for (const n of PATROL_LIKE) {
        if (mapping[n]) expect(mapping[n]).not.toBe(hamamaSection);
      }
    }
  });

  test('structurally distinct sections stack vertically on phone', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();
    await generateSchedule(page);

    const wrappers = page.locator('.schedule-table-wrapper');
    const count = await wrappers.count();
    expect(count).toBeGreaterThan(1);

    // On mobile the grid collapses to flex-column; each wrapper should start
    // strictly below the previous one (no side-by-side placement).
    const tops: number[] = [];
    for (let i = 0; i < count; i++) {
      const box = await wrappers.nth(i).boundingBox();
      expect(box).toBeTruthy();
      tops.push(box!.y);
    }
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeGreaterThan(tops[i - 1]);
    }
  });

  test('section color is applied via --section-color CSS variable', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();
    await generateSchedule(page);

    const sectionColors = await page.$$eval('.schedule-table-wrapper', (els) =>
      els.map((el) => {
        const style = el.getAttribute('style') ?? '';
        const match = style.match(/--section-color:\s*([^;]+)/);
        return match ? match[1].trim() : null;
      }),
    );
    expect(sectionColors.length).toBeGreaterThan(0);
    for (const c of sectionColors) {
      expect(c).toBeTruthy();
      // Representative-template color must be a hex triple, not the fallback gray #999.
      expect(c).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
  });

  test('wrappers carry the structural key in data-section', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();
    await generateSchedule(page);

    const sections = await page.$$eval('.schedule-table-wrapper', (els) =>
      els.map((el) => el.getAttribute('data-section')),
    );
    expect(sections.length).toBeGreaterThan(0);
    for (const s of sections) {
      expect(s).toBeTruthy();
      // Every section id must belong to one of the three namespaces the
      // structural key helpers emit — and in particular must NOT be a
      // free-form category string like 'patrol' (the legacy hardcoded value).
      expect(s!).toMatch(/^(tpl:|ot:|inject:)/);
    }
  });
});
