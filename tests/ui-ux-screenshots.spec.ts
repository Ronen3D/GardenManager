/**
 * Comprehensive UI/UX visual regression tests with screenshots.
 *
 * Run:  npx playwright test tests/ui-ux-screenshots.spec.ts
 *       npx playwright test tests/ui-ux-screenshots.spec.ts --project=phone
 *       npx playwright test tests/ui-ux-screenshots.spec.ts --update-snapshots
 *
 * First run generates baseline screenshots in tests/ui-ux-screenshots.spec.ts-snapshots/.
 * Subsequent runs compare against baselines and fail on visual regressions.
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function switchTab(page: Page, tab: string) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
  await expect(page.locator(`[data-tab="${tab}"].tab-active`)).toBeVisible();
  // Let animations and renders settle
  await page.waitForTimeout(300);
}

async function generateSchedule(page: Page) {
  await switchTab(page, 'schedule');
  const input = page.locator('#input-scenarios');
  if (await input.count() > 0) {
    await input.fill('1');
  }
  await page.click('#btn-generate');
  await page.waitForFunction(() => {
    const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
    return btn && !btn.disabled && !btn.textContent?.includes('מייעל');
  }, { timeout: 60000 });
  await page.waitForTimeout(500);
}

const ALL_TABS = ['participants', 'task-rules', 'schedule', 'algorithm'] as const;

// ═══════════════════════════════════════════════════════════════════════════
// 1. FULL-PAGE SCREENSHOTS — every tab, every viewport
// ═══════════════════════════════════════════════════════════════════════════

test.describe('1. Full-page tab screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  for (const tab of ALL_TABS) {
    test(`tab "${tab}" full-page screenshot`, async ({ page }) => {
      await switchTab(page, tab);
      await expect(page).toHaveScreenshot(`tab-${tab}-full.png`, {
        fullPage: true,
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. NAVIGATION BAR — visual consistency
// ═══════════════════════════════════════════════════════════════════════════

test.describe('2. Navigation bar screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('navigation bar appearance', async ({ page }) => {
    const tabNav = page.locator('.tab-nav');
    await expect(tabNav).toHaveScreenshot('nav-bar.png');
  });

  for (const tab of ALL_TABS) {
    test(`nav active state — "${tab}" selected`, async ({ page }) => {
      await switchTab(page, tab);
      const tabNav = page.locator('.tab-nav');
      await expect(tabNav).toHaveScreenshot(`nav-active-${tab}.png`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SCHEDULE VIEW — with generated data
// ═══════════════════════════════════════════════════════════════════════════

test.describe('3. Schedule view screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('empty schedule view', async ({ page }) => {
    await switchTab(page, 'schedule');
    await expect(page).toHaveScreenshot('schedule-empty.png', { fullPage: true });
  });

  test('schedule with generated data', async ({ page }) => {
    await generateSchedule(page);
    await expect(page).toHaveScreenshot('schedule-generated.png', { fullPage: true });
  });

  test('schedule toolbar area', async ({ page }) => {
    await switchTab(page, 'schedule');
    const toolbar = page.locator('.tab-toolbar').first();
    if (await toolbar.count() > 0) {
      await expect(toolbar).toHaveScreenshot('schedule-toolbar.png');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PARTICIPANTS TAB — table & toolbar
// ═══════════════════════════════════════════════════════════════════════════

test.describe('4. Participants tab screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('participants table layout', async ({ page }) => {
    await switchTab(page, 'participants');
    const table = page.locator('.table-participants');
    if (await table.count() > 0) {
      await expect(table).toHaveScreenshot('participants-table.png');
    }
  });

  test('participants toolbar', async ({ page }) => {
    await switchTab(page, 'participants');
    const toolbar = page.locator('.tab-toolbar').first();
    if (await toolbar.count() > 0) {
      await expect(toolbar).toHaveScreenshot('participants-toolbar.png');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ALGORITHM TAB — settings panel
// ═══════════════════════════════════════════════════════════════════════════

test.describe('5. Algorithm tab screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('algorithm settings view', async ({ page }) => {
    await switchTab(page, 'algorithm');
    const section = page.locator('.algo-section').first();
    if (await section.count() > 0) {
      await expect(section).toHaveScreenshot('algorithm-section.png');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. UI/UX QUALITY CHECKS — touch targets, overflow, spacing
// ═══════════════════════════════════════════════════════════════════════════

test.describe('6. UI/UX quality checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('no horizontal overflow on any tab', async ({ page }) => {
    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      const overflowing = await page.evaluate(() =>
        document.documentElement.scrollWidth > window.innerWidth
      );
      expect(overflowing, `horizontal overflow on tab "${tab}"`).toBe(false);
    }
  });

  test('all buttons meet minimum touch target size (44px)', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      const tooSmall = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, .btn, [role="button"], a.tab-btn');
        const problems: string[] = [];
        buttons.forEach(btn => {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (rect.width < 44 || rect.height < 44) {
              const label = btn.textContent?.trim().slice(0, 30) || btn.className;
              problems.push(`${label}: ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            }
          }
        });
        return problems;
      });
      expect(tooSmall, `small touch targets on tab "${tab}"`).toEqual([]);
    }
  });

  test('no text is clipped or truncated unexpectedly', async ({ page }) => {
    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      const clipped = await page.evaluate(() => {
        const problems: string[] = [];
        document.querySelectorAll('h1, h2, h3, label, .tab-btn, th, td').forEach(el => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && el.scrollWidth > rect.width + 2 && style.overflow !== 'hidden' && style.textOverflow !== 'ellipsis') {
            problems.push(`${el.tagName}.${el.className}: content overflows (${el.scrollWidth} > ${Math.round(rect.width)})`);
          }
        });
        return problems;
      });
      expect(clipped, `text clipping on tab "${tab}"`).toEqual([]);
    }
  });

  test('RTL direction is consistent across all tabs', async ({ page }) => {
    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      const dir = await page.evaluate(() => {
        return window.getComputedStyle(document.body).direction;
      });
      expect(dir, `RTL not set on tab "${tab}"`).toBe('rtl');
    }
  });

  test('font sizes are readable (>= 12px) on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      const tooSmall = await page.evaluate(() => {
        const problems: string[] = [];
        document.querySelectorAll('p, span, label, td, th, li, a, button').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
            if (fontSize < 12) {
              const text = el.textContent?.trim().slice(0, 30) || el.className;
              problems.push(`${text}: ${fontSize}px`);
            }
          }
        });
        return problems;
      });
      expect(tooSmall, `small fonts on tab "${tab}"`).toEqual([]);
    }
  });

  test('interactive elements are not overlapping on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 768) test.skip();

    await switchTab(page, 'participants');
    const overlaps = await page.evaluate(() => {
      const interactives = Array.from(
        document.querySelectorAll('button, a, input, select, [role="button"]')
      ).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const problems: string[] = [];
      for (let i = 0; i < interactives.length; i++) {
        for (let j = i + 1; j < interactives.length; j++) {
          const a = interactives[i].getBoundingClientRect();
          const b = interactives[j].getBoundingClientRect();
          const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (overlapX > 5 && overlapY > 5) {
            const labelA = interactives[i].textContent?.trim().slice(0, 20) || interactives[i].tagName;
            const labelB = interactives[j].textContent?.trim().slice(0, 20) || interactives[j].tagName;
            problems.push(`"${labelA}" overlaps "${labelB}" by ${overlapX}x${overlapY}px`);
          }
        }
      }
      return problems.slice(0, 10); // limit output
    });
    expect(overlaps, 'overlapping interactive elements').toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. MODAL SCREENSHOTS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('7. Modal screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('modal backdrop and centering', async ({ page, viewport }) => {
    // Try to open a modal by adding a participant or similar action
    await switchTab(page, 'participants');
    const addBtn = page.locator('button:has-text("הוסף"), .btn-add, [data-action="add"]').first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(300);

      const modal = page.locator('.gm-modal-backdrop, .modal, [role="dialog"]').first();
      if (await modal.count() > 0 && await modal.isVisible()) {
        await expect(page).toHaveScreenshot('modal-open.png', { fullPage: true });

        // Check modal is vertically centered on desktop
        if (viewport && viewport.width > 768) {
          const modalContent = page.locator('.gm-modal, .modal-content, [role="dialog"] > *').first();
          if (await modalContent.count() > 0) {
            await expect(modalContent).toHaveScreenshot('modal-content.png');
          }
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. MOBILE-SPECIFIC SCREENSHOTS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('8. Mobile-specific screenshots', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width > 500) test.skip();
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('mobile bottom navigation bar', async ({ page }) => {
    const tabNav = page.locator('.tab-nav');
    await expect(tabNav).toHaveScreenshot('mobile-bottom-nav.png');
  });

  test('mobile schedule view with sidebar FAB', async ({ page }) => {
    await switchTab(page, 'schedule');
    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0) {
      await expect(page).toHaveScreenshot('mobile-schedule-with-fab.png');
    }
  });

  test('mobile sidebar overlay when opened', async ({ page }) => {
    await switchTab(page, 'schedule');
    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0 && await fab.isVisible()) {
      await fab.click();
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot('mobile-sidebar-open.png');
    }
  });

  test('mobile day navigator', async ({ page }) => {
    await switchTab(page, 'schedule');
    const dayNav = page.locator('.day-navigator');
    if (await dayNav.count() > 0) {
      await expect(dayNav).toHaveScreenshot('mobile-day-navigator.png');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. DESKTOP-SPECIFIC SCREENSHOTS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('9. Desktop-specific screenshots', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width < 1024) test.skip();
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('desktop schedule with sticky sidebar', async ({ page }) => {
    await switchTab(page, 'schedule');
    const sidebar = page.locator('.participant-sidebar');
    if (await sidebar.count() > 0) {
      await expect(sidebar).toHaveScreenshot('desktop-sidebar.png');
    }
  });

  test('desktop schedule full layout', async ({ page }) => {
    await switchTab(page, 'schedule');
    const layout = page.locator('.schedule-layout');
    if (await layout.count() > 0) {
      await expect(layout).toHaveScreenshot('desktop-schedule-layout.png');
    }
  });

  test('desktop top navigation', async ({ page }) => {
    const tabNav = page.locator('.tab-nav');
    await expect(tabNav).toHaveScreenshot('desktop-top-nav.png');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. INTERACTION SCREENSHOTS — before/after state changes
// ═══════════════════════════════════════════════════════════════════════════

test.describe('10. Interaction state screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('tab switching transitions — all tabs', async ({ page }) => {
    for (const tab of ALL_TABS) {
      await switchTab(page, tab);
      await expect(page).toHaveScreenshot(`after-switch-to-${tab}.png`);
    }
  });

  test('schedule generation — before and after', async ({ page }) => {
    await switchTab(page, 'schedule');
    await expect(page).toHaveScreenshot('schedule-before-generate.png');

    await generateSchedule(page);
    await expect(page).toHaveScreenshot('schedule-after-generate.png');
  });
});
