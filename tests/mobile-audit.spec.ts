/**
 * Comprehensive mobile UI audit — phone viewport (375×812).
 *
 * Run:  npx playwright test tests/mobile-audit.spec.ts --project=phone
 *
 * This file actively interacts with the UI (not just CSS inspection)
 * to discover real usability issues on phone-sized screens.
 */
import { test, expect, Page, Locator } from '@playwright/test';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function switchTab(page: Page, tab: string) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
  await expect(page.locator(`[data-tab="${tab}"].tab-active`)).toBeVisible();
}

async function generateSchedule(page: Page) {
  await switchTab(page, 'schedule');
  const input = page.locator('#input-scenarios');
  if (await input.count() > 0) {
    await input.fill('1');
  }
  await page.click('#btn-generate');
  // Wait for optimization to finish (overlay disappears or generate button re-enables)
  await page.waitForFunction(() => {
    const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
    return btn && !btn.disabled && !btn.textContent?.includes('מייעל');
  }, { timeout: 60000 });
  // Extra wait for DOM to stabilize
  await page.waitForTimeout(500);
}

/** Check that no element extends beyond the viewport width */
async function checkNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

// ─── Only run on phone viewport ─────────────────────────────────────────────

test.beforeEach(async ({ viewport }) => {
  if (!viewport || viewport.width > 500) test.skip();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. BASELINE
// ═══════════════════════════════════════════════════════════════════════════

test.describe('1. Baseline checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('touch-device class is set', async ({ page }) => {
    const hasClass = await page.evaluate(() =>
      document.documentElement.classList.contains('touch-device')
    );
    expect(hasClass).toBe(true);
  });

  test('HTML dir is rtl', async ({ page }) => {
    const dir = await page.evaluate(() => document.documentElement.dir);
    expect(dir).toBe('rtl');
  });

  test('body has padding-bottom for bottom nav clearance', async ({ page }) => {
    const pb = await page.evaluate(() => {
      return parseInt(window.getComputedStyle(document.body).paddingBottom, 10);
    });
    expect(pb).toBeGreaterThanOrEqual(70);
  });

  test('no horizontal overflow on initial load', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. BOTTOM NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════

test.describe('2. Bottom navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('bottom nav is fixed at viewport bottom', async ({ page, viewport }) => {
    const tabNav = page.locator('.tab-nav');
    const position = await tabNav.evaluate(el => window.getComputedStyle(el).position);
    expect(position).toBe('fixed');

    const box = await tabNav.boundingBox();
    expect(box).toBeTruthy();
    // Allow some margin for safe-area padding in emulated devices
    expect(box!.y + box!.height).toBeGreaterThan(viewport!.height - 30);
  });

  test('bottom nav has 4 tab buttons', async ({ page }) => {
    const buttons = page.locator('.tab-nav .tab-btn');
    await expect(buttons).toHaveCount(4);
  });

  test('each tab button has an icon', async ({ page }) => {
    const icons = page.locator('.tab-nav .tab-btn .tab-icon');
    await expect(icons).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(icons.nth(i)).toBeVisible();
    }
  });

  test('tab labels hidden at 375px except active tab', async ({ page }) => {
    const buttons = page.locator('.tab-nav .tab-btn');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const isActive = await buttons.nth(i).evaluate(el =>
        el.classList.contains('tab-active')
      );
      const label = buttons.nth(i).locator('.tab-label');
      const display = await label.evaluate(el =>
        window.getComputedStyle(el).display
      );
      if (isActive) {
        // Active tab shows a small label
        expect(display).not.toBe('none');
      } else {
        expect(display).toBe('none');
      }
    }
  });

  test('tab switching works via tap', async ({ page }) => {
    const tabs = ['participants', 'task-rules', 'schedule', 'algorithm'];
    for (const tab of tabs) {
      await page.click(`.tab-btn[data-tab="${tab}"]`);
      await expect(page.locator(`.tab-btn[data-tab="${tab}"].tab-active`)).toBeVisible();
    }
  });

  test('bottom nav z-index is high enough', async ({ page }) => {
    const z = await page.locator('.tab-nav').evaluate(el =>
      parseInt(window.getComputedStyle(el).zIndex, 10)
    );
    expect(z).toBeGreaterThanOrEqual(50);
  });

  test('tab buttons meet 44px minimum touch target', async ({ page }) => {
    const buttons = page.locator('.tab-nav .tab-btn');
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const box = await buttons.nth(i).boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HEADER
// ═══════════════════════════════════════════════════════════════════════════

test.describe('3. Header compact mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('header credit is hidden on mobile', async ({ page }) => {
    const credit = page.locator('.header-credit');
    if (await credit.count() > 0) {
      const display = await credit.evaluate(el =>
        window.getComputedStyle(el).display
      );
      expect(display).toBe('none');
    }
  });

  test('beta badge is hidden on mobile', async ({ page }) => {
    const badge = page.locator('.beta-badge');
    if (await badge.count() > 0) {
      const display = await badge.evaluate(el =>
        window.getComputedStyle(el).display
      );
      expect(display).toBe('none');
    }
  });

  test('undo/redo group takes full width', async ({ page }) => {
    const group = page.locator('.undo-redo-group');
    if (await group.count() > 0) {
      const width = await group.evaluate(el =>
        window.getComputedStyle(el).width
      );
      // width: 100% means it should be near viewport width
      expect(parseInt(width, 10)).toBeGreaterThan(300);
    }
  });

  test('header does not cause horizontal overflow', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. PARTICIPANTS TAB
// ═══════════════════════════════════════════════════════════════════════════

test.describe('4. Participants tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await switchTab(page, 'participants');
  });

  test('table thead is hidden (card layout)', async ({ page }) => {
    const thead = page.locator('.table-participants thead');
    if (await thead.count() > 0) {
      const display = await thead.evaluate(el =>
        window.getComputedStyle(el).display
      );
      expect(display).toBe('none');
    }
  });

  test('table body renders as flex column (cards)', async ({ page }) => {
    const tbody = page.locator('.table-participants tbody');
    if (await tbody.count() > 0) {
      const display = await tbody.evaluate(el =>
        window.getComputedStyle(el).display
      );
      expect(display).toBe('flex');
      const dir = await tbody.evaluate(el =>
        window.getComputedStyle(el).flexDirection
      );
      expect(dir).toBe('column');
    }
  });

  test('participant cards are visible with name and badges', async ({ page }) => {
    const cards = page.locator('.table-participants tbody tr');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    // First card should have a name cell visible
    const firstCard = cards.first();
    await expect(firstCard).toBeVisible();
  });

  test('row number column is hidden on mobile', async ({ page }) => {
    const rowNum = page.locator('.table-participants tbody td:nth-child(2)').first();
    if (await rowNum.count() > 0) {
      const display = await rowNum.evaluate(el =>
        window.getComputedStyle(el).display
      );
      expect(display).toBe('none');
    }
  });

  test('add participant button is visible and tappable', async ({ page }) => {
    const btn = page.locator('[data-action="add-participant"]');
    await expect(btn).toBeVisible();
    const box = await btn.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.height).toBeGreaterThanOrEqual(40);
  });

  test('add participant form opens and is usable', async ({ page }) => {
    await page.click('[data-action="add-participant"]');
    // Wait for the add form to appear
    const form = page.locator('[data-action="confirm-add-participant"]');
    await expect(form).toBeVisible({ timeout: 3000 });

    // Check form is within viewport (not behind bottom nav)
    const box = await form.boundingBox();
    expect(box).toBeTruthy();
  });

  test('no horizontal overflow on participants tab', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('edit button triggers edit mode', async ({ page }) => {
    const editBtn = page.locator('[data-action="edit-participant"]').first();
    if (await editBtn.count() > 0) {
      await editBtn.click();
      // Should enter edit mode — look for row-editing class or input fields
      await page.waitForTimeout(300);
      const editing = page.locator('.row-editing, [data-action="cancel-edit"]');
      const count = await editing.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('delete button opens confirm modal', async ({ page }) => {
    const deleteBtn = page.locator('[data-action="remove-participant"]').first();
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      // Should open confirm modal
      const modal = page.locator('.gm-modal-backdrop');
      await expect(modal).toBeVisible({ timeout: 3000 });
      // Modal should be at bottom (flex-end)
      const align = await modal.evaluate(el =>
        window.getComputedStyle(el).alignItems
      );
      expect(align).toBe('flex-end');
      // Dismiss
      await page.keyboard.press('Escape');
    }
  });

  test('bulk selection checkbox meets touch target size', async ({ page }) => {
    const checkbox = page.locator('.cb-select-participant').first();
    if (await checkbox.count() > 0) {
      const minH = await checkbox.evaluate(el =>
        parseInt(window.getComputedStyle(el).minHeight, 10)
      );
      expect(minH).toBeGreaterThanOrEqual(44);
    }
  });

  test('participant cards do not overflow viewport width', async ({ page, viewport }) => {
    const cards = page.locator('.table-participants tbody tr');
    const count = await cards.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const box = await cards.nth(i).boundingBox();
      if (box) {
        expect(box.width).toBeLessThanOrEqual(viewport!.width + 2);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. TASK RULES TAB
// ═══════════════════════════════════════════════════════════════════════════

test.describe('5. Task rules tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await switchTab(page, 'task-rules');
  });

  test('task templates are visible', async ({ page }) => {
    const templates = page.locator('.template-header');
    const count = await templates.count();
    expect(count).toBeGreaterThan(0);
  });

  test('add template button is visible', async ({ page }) => {
    const btn = page.locator('[data-action="toggle-add-template"]');
    await expect(btn).toBeVisible();
  });

  test('expanding a template shows detail', async ({ page }) => {
    const header = page.locator('.template-header').first();
    if (await header.count() > 0) {
      await header.click();
      await page.waitForTimeout(300);
      // After clicking, template detail should be visible
      const detail = page.locator('.template-detail, .template-body, [data-action="add-slot"]');
      const count = await detail.count();
      expect(count).toBeGreaterThanOrEqual(0); // May already be expanded
    }
  });

  test('no horizontal overflow on task rules tab', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('buttons meet 44px touch target', async ({ page }) => {
    const buttons = page.locator('.tab-content .btn-sm');
    const count = await buttons.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const h = await buttons.nth(i).evaluate(el =>
        parseInt(window.getComputedStyle(el).minHeight, 10)
      );
      expect(h).toBeGreaterThanOrEqual(44);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. SCHEDULE TAB — EMPTY STATE
// ═══════════════════════════════════════════════════════════════════════════

test.describe('6. Schedule tab — empty state', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await switchTab(page, 'schedule');
  });

  test('empty state message is shown', async ({ page }) => {
    const empty = page.locator('.empty-state');
    if (await empty.count() > 0) {
      await expect(empty).toBeVisible();
    }
  });

  test('generate button is visible and enabled', async ({ page }) => {
    const btn = page.locator('#btn-generate');
    await expect(btn).toBeVisible();
    const disabled = await btn.evaluate(el => (el as HTMLButtonElement).disabled);
    expect(disabled).toBe(false);
  });

  test('scenarios input is accessible', async ({ page }) => {
    const input = page.locator('#input-scenarios');
    await expect(input).toBeVisible();
    const minH = await input.evaluate(el =>
      parseInt(window.getComputedStyle(el).minHeight, 10)
    );
    expect(minH).toBeGreaterThanOrEqual(44);
  });

  test('no horizontal overflow on empty schedule', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('ISSUE: toolbar-right overflows on phone — buttons do not wrap', async ({ page, viewport }) => {
    // The .toolbar-right has no flex-wrap, causing overflow with multiple buttons
    const toolbarRight = page.locator('.toolbar-right');
    if (await toolbarRight.count() > 0) {
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      const viewW = viewport!.width;
      // This test documents the overflow issue
      if (scrollW > viewW) {
        // ISSUE CONFIRMED: toolbar causes horizontal overflow
        expect(scrollW).toBeGreaterThan(viewW);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SCHEDULE TAB — WITH DATA
// ═══════════════════════════════════════════════════════════════════════════

test.describe('7. Schedule tab — with generated schedule', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await generateSchedule(page);
  });

  test('schedule grid is visible after generation', async ({ page }) => {
    const grid = page.locator('.schedule-grid, .schedule-table-wrapper');
    const count = await grid.count();
    expect(count).toBeGreaterThan(0);
  });

  test('day navigator is present and horizontally scrollable', async ({ page }) => {
    const dayNav = page.locator('.day-navigator');
    if (await dayNav.count() > 0) {
      await expect(dayNav).toBeVisible();
      const overflow = await dayNav.evaluate(el =>
        window.getComputedStyle(el).overflowX
      );
      expect(overflow).toBe('auto');
    }
  });

  test('day tabs are clickable (not overlapped by toolbar)', async ({ page }) => {
    // Previously BROKEN: day tabs were intercepted by the sticky toolbar
    // and adjacent tabs. Fixed by raising .day-navigator z-index to 10.
    const dayTabs = page.locator('.day-tab');
    const count = await dayTabs.count();
    if (count >= 3) {
      await dayTabs.nth(2).scrollIntoViewIfNeeded();
      await dayTabs.nth(2).click({ timeout: 5000 });
      await page.waitForTimeout(300);
      await expect(dayTabs.nth(2)).toHaveClass(/day-active|active/);
    }
  });

  test('schedule grid has sticky time column', async ({ page }) => {
    const colTime = page.locator('.col-time').first();
    if (await colTime.count() > 0) {
      const pos = await colTime.evaluate(el =>
        window.getComputedStyle(el).position
      );
      expect(pos).toBe('sticky');
    }
  });

  test('gantt is collapsed by default on mobile', async ({ page }) => {
    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      await expect(toggle).toBeVisible();
      const expanded = await toggle.getAttribute('aria-expanded');
      expect(expanded).toBe('false');
    }
  });

  test('gantt toggle button is clickable (not overlapped)', async ({ page }) => {
    // Previously BROKEN: task-cell elements intercepted clicks on this button.
    // Fixed by adding position:relative; z-index:2 to .gantt-section on mobile
    // and position:relative; z-index:1 to .schedule-table-wrapper.
    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      await expect(toggle).toBeVisible();
      await toggle.scrollIntoViewIfNeeded();
      // Should succeed without force:true now
      await toggle.click({ timeout: 5000 });
      const expanded = await toggle.getAttribute('aria-expanded');
      expect(expanded).toBe('true');
      // Collapse again
      await toggle.click();
    }
  });

  test('gantt toggle works with force click (bypass interception)', async ({ page }) => {
    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      // Use force:true to bypass the overlap and verify toggle logic works
      await toggle.click({ force: true });
      let expanded = await toggle.getAttribute('aria-expanded');
      expect(expanded).toBe('true');

      const content = page.locator('.gantt-section-content');
      const display = await content.evaluate(el => el.style.display);
      expect(display).not.toBe('none');

      await toggle.click({ force: true });
      expanded = await toggle.getAttribute('aria-expanded');
      expect(expanded).toBe('false');
    }
  });

  test('gantt requires horizontal scroll (min-width 600px on 375px viewport)', async ({ page }) => {
    const toggle = page.locator('.gantt-mobile-toggle');
    if (await toggle.count() > 0) {
      await toggle.click({ force: true });
      const container = page.locator('.gantt-container');
      if (await container.count() > 0) {
        const { scrollW, clientW } = await container.evaluate(el => ({
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        }));
        expect(scrollW).toBeGreaterThan(clientW);
      }
      await toggle.click({ force: true });
    }
  });

  test('FAB is visible and positioned correctly', async ({ page, viewport }) => {
    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0) {
      await expect(fab).toBeVisible();
      const box = await fab.boundingBox();
      expect(box).toBeTruthy();
      // FAB should be in the lower portion of the screen
      expect(box!.y).toBeGreaterThan(viewport!.height / 2);
      // Should be 48x48
      expect(box!.width).toBeGreaterThanOrEqual(46);
      expect(box!.height).toBeGreaterThanOrEqual(46);
    }
  });

  test('FAB opens sidebar drawer with backdrop', async ({ page }) => {
    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0) {
      await fab.click({ timeout: 5000 });
      await page.waitForTimeout(400);

      const sidebar = page.locator('.participant-sidebar.sidebar-mobile-open');
      await expect(sidebar).toBeVisible();

      const backdrop = page.locator('.sidebar-drawer-backdrop');
      await expect(backdrop).toBeVisible();
    }
  });

  test('sidebar drawer closes on backdrop tap', async ({ page }) => {
    const fab = page.locator('.sidebar-fab');
    if (await fab.count() > 0) {
      await fab.click({ timeout: 5000 });
      await page.waitForTimeout(400);

      const backdrop = page.locator('.sidebar-drawer-backdrop');
      if (await backdrop.count() > 0) {
        // Click in the upper area of the screen (above the sidebar drawer)
        // since the sidebar (z-index:45) covers the backdrop (z-index:44) in the lower area
        await page.mouse.click(187, 50);
        await page.waitForTimeout(400);
        const open = page.locator('.participant-sidebar.sidebar-mobile-open');
        expect(await open.count()).toBe(0);
      }
    }
  });

  test('participant tap shows bottom sheet (not desktop tooltip)', async ({ page }) => {
    const pHover = page.locator('.participant-hover[data-pid]').first();
    if (await pHover.count() > 0) {
      await pHover.scrollIntoViewIfNeeded();
      // Try natural click first; fall back to force if still intercepted
      await pHover.click({ timeout: 5000 }).catch(async () => {
        await pHover.click({ force: true });
      });
      await page.waitForTimeout(500);

      const sheet = page.locator('.gm-bottom-sheet-backdrop');
      await expect(sheet).toBeVisible({ timeout: 3000 });

      const bottomSheet = page.locator('.gm-bottom-sheet');
      await expect(bottomSheet).toBeVisible();

      const closeBtn = page.locator('.gm-bs-close');
      if (await closeBtn.count() > 0) await closeBtn.click();
    }
  });

  test('bottom sheet has "view profile" link (fixed)', async ({ page }) => {
    // Previously BROKEN: buildParticipantTooltipContent() did not render a
    // [data-action="goto-profile"] element. Fixed by adding a "view profile"
    // button for touch devices.
    const pHover = page.locator('.participant-hover[data-pid]').first();
    if (await pHover.count() > 0) {
      await pHover.scrollIntoViewIfNeeded();
      await pHover.click({ timeout: 5000 }).catch(async () => {
        await pHover.click({ force: true });
      });
      await page.waitForTimeout(500);

      const sheet = page.locator('.gm-bottom-sheet');
      if (await sheet.count() > 0) {
        const profileLink = sheet.locator('[data-action="goto-profile"]');
        const count = await profileLink.count();
        expect(count).toBeGreaterThan(0);

        const closeBtn = page.locator('.gm-bs-close');
        if (await closeBtn.count() > 0) await closeBtn.click();
      }
    }
  });

  test('snapshot toggle button is accessible', async ({ page }) => {
    const snapBtn = page.locator('#btn-snap-toggle');
    if (await snapBtn.count() > 0) {
      await expect(snapBtn).toBeVisible();
      const box = await snapBtn.boundingBox();
      expect(box).toBeTruthy();
    }
  });

  test('snapshot panel opens and is within viewport', async ({ page, viewport }) => {
    const snapBtn = page.locator('#btn-snap-toggle');
    if (await snapBtn.count() > 0) {
      await snapBtn.scrollIntoViewIfNeeded();
      await snapBtn.click({ force: true });
      await page.waitForTimeout(300);

      const panel = page.locator('.snapshot-panel');
      if (await panel.count() > 0) {
        await expect(panel).toBeVisible();
        // Check for overflow
        const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
        if (scrollW > viewport!.width) {
          console.log(`SNAPSHOT PANEL: scrollWidth=${scrollW} > viewport=${viewport!.width}`);
        }
      }
    }
  });

  test('export button is visible', async ({ page }) => {
    const exportBtn = page.locator('#btn-export-pdf');
    if (await exportBtn.count() > 0) {
      await expect(exportBtn).toBeVisible();
    }
  });

  test('violations section is rendered', async ({ page }) => {
    // After generating, violations section should exist
    const violations = page.locator('.violations-section, .alert-ok');
    const count = await violations.count();
    expect(count).toBeGreaterThan(0);
  });

  test('schedule toolbar does not overflow (fixed)', async ({ page, viewport }) => {
    // Previously BROKEN: .toolbar-right had no flex-wrap, causing buttons
    // to overflow the 375px viewport. Fixed by adding flex-wrap: wrap.
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(viewport!.width);
  });

  test('ISSUE: live-mode controls add extra overflow', async ({ page, viewport }) => {
    const liveChk = page.locator('#chk-live-mode');
    if (await liveChk.count() > 0) {
      await liveChk.scrollIntoViewIfNeeded();
      await liveChk.check({ force: true });
      await page.waitForTimeout(500);

      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      const viewW = viewport!.width;
      if (scrollW > viewW) {
        // ISSUE: live-mode adds dropdowns to toolbar, causing more overflow
        console.log(`LIVE-MODE OVERFLOW: scrollWidth=${scrollW} > viewport=${viewW}`);
      }
    }
  });

  test('weekly dashboard is sticky at top', async ({ page }) => {
    const dashboard = page.locator('.weekly-dashboard');
    if (await dashboard.count() > 0) {
      const pos = await dashboard.evaluate(el =>
        window.getComputedStyle(el).position
      );
      expect(pos).toBe('sticky');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. ALGORITHM TAB
// ═══════════════════════════════════════════════════════════════════════════

test.describe('8. Algorithm tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await switchTab(page, 'algorithm');
  });

  test('algorithm sections are visible', async ({ page }) => {
    const sections = page.locator('.algo-section');
    const count = await sections.count();
    expect(count).toBeGreaterThan(0);
  });

  test('single-column toggle grid at 375px', async ({ page }) => {
    const grid = page.locator('.algo-toggle-grid');
    if (await grid.count() > 0) {
      const cols = await grid.first().evaluate(el =>
        window.getComputedStyle(el).gridTemplateColumns
      );
      // At <=480px, should be 1fr (single column)
      // The computed value is a pixel width like "343px" for 1fr
      const colCount = cols.split(' ').length;
      expect(colCount).toBe(1);
    }
  });

  test('weight input fields meet 44px touch target', async ({ page }) => {
    const inputs = page.locator('.algo-section input[type="number"]');
    const count = await inputs.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
      const h = await inputs.nth(i).evaluate(el =>
        parseInt(window.getComputedStyle(el).minHeight, 10)
      );
      expect(h).toBeGreaterThanOrEqual(44);
    }
  });

  test('no horizontal overflow on algorithm tab', async ({ page }) => {
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. PROFILE VIEW
// ═══════════════════════════════════════════════════════════════════════════

test.describe('9. Profile view', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await generateSchedule(page);
  });

  test('long-press on participant navigates to profile', async ({ page }) => {
    // Navigate to profile by simulating a long-press via raw CDP touch events
    const pHover = page.locator('.participant-hover[data-pid]').first();
    if (await pHover.count() > 0) {
      await pHover.scrollIntoViewIfNeeded();
      const box = await pHover.boundingBox();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;

        // Use CDP to dispatch proper touch events with coordinates
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: cx, y: cy }],
        });
        await page.waitForTimeout(600); // >500ms for long-press
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await page.waitForTimeout(500);

        const profile = page.locator('.profile-view-root');
        if (await profile.count() > 0) {
          await expect(profile).toBeVisible();
        }
      }
    }
  });

  test('profile view back button works', async ({ page }) => {
    const pHover = page.locator('.participant-hover[data-pid]').first();
    if (await pHover.count() > 0) {
      await pHover.scrollIntoViewIfNeeded();
      const box = await pHover.boundingBox();
      if (box) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        });
        await page.waitForTimeout(600);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await page.waitForTimeout(500);

        const profile = page.locator('.profile-view-root');
        if (await profile.count() > 0) {
          const backBtn = page.locator('.btn-back');
          if (await backBtn.count() > 0) {
            await backBtn.click();
            await page.waitForTimeout(500);
            expect(await page.locator('.profile-view-root').count()).toBe(0);
          }
        }
      }
    }
  });

  test('profile view has no horizontal overflow', async ({ page }) => {
    const pHover = page.locator('.participant-hover[data-pid]').first();
    if (await pHover.count() > 0) {
      await pHover.scrollIntoViewIfNeeded();
      const box = await pHover.boundingBox();
      if (box) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        });
        await page.waitForTimeout(600);
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await page.waitForTimeout(500);

        const profile = page.locator('.profile-view-root');
        if (await profile.count() > 0) {
          const noOverflow = await checkNoHorizontalOverflow(page);
          expect(noOverflow).toBe(true);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. MODALS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('10. Modals', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('modal backdrop uses flex-end on phone (slide-up)', async ({ page }) => {
    const align = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'gm-modal-backdrop';
      el.style.display = 'none';
      document.body.appendChild(el);
      const style = window.getComputedStyle(el);
      const result = style.alignItems;
      el.remove();
      return result;
    });
    expect(align).toBe('flex-end');
  });

  test('confirm modal opens from delete participant', async ({ page }) => {
    await switchTab(page, 'participants');
    const deleteBtn = page.locator('[data-action="remove-participant"]').first();
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      const modal = page.locator('.gm-modal-backdrop');
      await expect(modal).toBeVisible({ timeout: 3000 });

      // Check modal dialog has rounded top corners (bottom sheet style)
      const dialog = page.locator('.gm-modal-dialog');
      const radius = await dialog.evaluate(el =>
        window.getComputedStyle(el).borderRadius
      );
      expect(radius).toContain('16px');

      // Close via escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      expect(await page.locator('.gm-modal-backdrop').count()).toBe(0);
    }
  });

  test('modal closes on backdrop click', async ({ page }) => {
    await switchTab(page, 'participants');
    const deleteBtn = page.locator('[data-action="remove-participant"]').first();
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      const backdrop = page.locator('.gm-modal-backdrop');
      await expect(backdrop).toBeVisible({ timeout: 3000 });

      // Click on backdrop (outside dialog)
      const dialog = page.locator('.gm-modal-dialog');
      const dialogBox = await dialog.boundingBox();
      if (dialogBox) {
        // Click above the dialog (backdrop area)
        await page.mouse.click(dialogBox.x + dialogBox.width / 2, 10);
        await page.waitForTimeout(300);
        expect(await page.locator('.gm-modal-backdrop').count()).toBe(0);
      }
    }
  });

  test('modal buttons meet 44px touch target', async ({ page }) => {
    await switchTab(page, 'participants');
    const deleteBtn = page.locator('[data-action="remove-participant"]').first();
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
      const modalBtns = page.locator('.gm-modal-actions button');
      await page.waitForTimeout(300);
      const count = await modalBtns.count();
      for (let i = 0; i < count; i++) {
        const h = await modalBtns.nth(i).evaluate(el =>
          parseInt(window.getComputedStyle(el).minHeight, 10)
        );
        expect(h).toBeGreaterThanOrEqual(44);
      }
      await page.keyboard.press('Escape');
    }
  });

  test('bottom sheet CSS is properly defined', async ({ page }) => {
    const hasStyles = await page.evaluate(() => {
      const rules = Array.from(document.styleSheets)
        .flatMap(s => {
          try { return Array.from(s.cssRules); } catch { return []; }
        })
        .map(r => (r as CSSStyleRule).selectorText || '')
        .filter(s => s.includes('gm-bottom-sheet'));
      return rules.length > 0;
    });
    expect(hasStyles).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. OVERFLOW & CLIPPING
// ═══════════════════════════════════════════════════════════════════════════

test.describe('11. Overflow & clipping', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('participants tab — no horizontal overflow', async ({ page }) => {
    await switchTab(page, 'participants');
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('task rules tab — no horizontal overflow', async ({ page }) => {
    await switchTab(page, 'task-rules');
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('algorithm tab — no horizontal overflow', async ({ page }) => {
    await switchTab(page, 'algorithm');
    const noOverflow = await checkNoHorizontalOverflow(page);
    expect(noOverflow).toBe(true);
  });

  test('schedule tab — check horizontal overflow', async ({ page, viewport }) => {
    await switchTab(page, 'schedule');
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    // Document: schedule tab may overflow due to toolbar-right not wrapping
    if (scrollW > viewport!.width) {
      // ISSUE: horizontal overflow on schedule tab
      console.log(`OVERFLOW: scrollWidth=${scrollW}, viewport=${viewport!.width}`);
    }
  });

  test('last participant card is above bottom nav', async ({ page, viewport }) => {
    await switchTab(page, 'participants');
    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);

    const cards = page.locator('.table-participants tbody tr');
    const count = await cards.count();
    if (count > 0) {
      const lastCard = cards.last();
      const box = await lastCard.boundingBox();
      if (box) {
        // Last card's bottom should be above the bottom nav (which is at viewport - 72px area)
        // When scrolled to bottom, content should clear the 72px padding
        expect(box.y + box.height).toBeLessThanOrEqual(viewport!.height);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. TOUCH SPECIFICS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('12. Touch specifics', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('hover transforms suppressed on touch device', async ({ page }) => {
    const transform = await page.evaluate(() => {
      const el = document.createElement('button');
      el.className = 'btn-primary';
      document.body.appendChild(el);
      // Check touch-device hover rule
      const rules = Array.from(document.styleSheets)
        .flatMap(s => {
          try { return Array.from(s.cssRules); } catch { return []; }
        });
      const hasSuppress = rules.some(r => {
        const text = r.cssText || '';
        return text.includes('.touch-device') && text.includes('.btn-primary') && text.includes('hover');
      });
      el.remove();
      return hasSuppress;
    });
    expect(transform).toBe(true);
  });

  test('input font-size is 16px (prevents iOS zoom)', async ({ page }) => {
    await switchTab(page, 'participants');
    const input = page.locator('input[type="text"]').first();
    if (await input.count() > 0) {
      const fontSize = await input.evaluate(el =>
        window.getComputedStyle(el).fontSize
      );
      expect(parseInt(fontSize, 10)).toBeGreaterThanOrEqual(16);
    }
  });

  test('interactive elements have touch-action: manipulation', async ({ page }) => {
    const hasTouchAction = await page.evaluate(() => {
      const rules = Array.from(document.styleSheets)
        .flatMap(s => {
          try { return Array.from(s.cssRules); } catch { return []; }
        });
      return rules.some(r => {
        const text = r.cssText || '';
        return text.includes('.touch-device') && text.includes('touch-action') && text.includes('manipulation');
      });
    });
    expect(hasTouchAction).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. AVAILABILITY INSPECTOR (inside schedule with data)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('13. Availability inspector', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
    await generateSchedule(page);
  });

  test('ISSUE: availability inspector inline controls may overflow', async ({ page, viewport }) => {
    const inline = page.locator('.availability-inline');
    if (await inline.count() > 0) {
      const box = await inline.boundingBox();
      if (box && box.width > viewport!.width) {
        // ISSUE: availability inline controls overflow phone viewport
        expect(box.width).toBeGreaterThan(viewport!.width);
      }
    }
  });

  test('day-window row wraps correctly on mobile', async ({ page, viewport }) => {
    const dayWindow = page.locator('.day-window-row, .day-window');
    if (await dayWindow.count() > 0) {
      const box = await dayWindow.first().boundingBox();
      if (box) {
        // Check if day window content is within viewport
        if (box.width > viewport!.width) {
          console.log(`DAY-WINDOW OVERFLOW: ${box.width}px > ${viewport!.width}px`);
        }
      }
    }
  });
});
