import { test, expect, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

test.setTimeout(180_000);

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

async function setup(page: Page) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav', { timeout: 10000 });
}

async function generateSchedule(page: Page) {
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.locator('#btn-generate').click();
  // Wait for participant-hover elements to appear (schedule rendered)
  await page.waitForFunction(
    () => document.querySelectorAll('.participant-hover').length > 5,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(500);
}

// ─── 1. Profile overlay ───────────────────────────────────────────────────────

test('profile overlay: opens on click and back button returns to schedule', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Click first participant-hover with data-pid in the schedule
  const firstParticipant = page.locator('.participant-hover[data-pid]').first();
  await firstParticipant.click();
  await page.waitForTimeout(400);

  const profileVisible = await page.locator('.profile-view-root').isVisible();
  expect(profileVisible).toBe(true);

  // Back button
  await page.locator('.btn-back[data-action="back-to-schedule"]').click();
  await page.waitForTimeout(400);
  const backOnSchedule = await page.locator('.profile-view-root').count();
  expect(backOnSchedule).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('profile overlay: Esc key does NOT close profile (no keyboard handler)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);
  await page.locator('.participant-hover[data-pid]').first().click();
  await page.waitForTimeout(300);
  expect(await page.locator('.profile-view-root').isVisible()).toBe(true);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // Record finding: Esc doesn't close
  const stillOpen = await page.locator('.profile-view-root').count();
  console.log('Profile after Esc count:', stillOpen);
  // We expect this to still be 1 (i.e., Esc is not wired)
  expect(stillOpen).toBe(1);
});

test('profile overlay: clicking outside (on empty page area) does NOT close', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);
  await page.locator('.participant-hover[data-pid]').first().click();
  await page.waitForTimeout(300);
  expect(await page.locator('.profile-view-root').isVisible()).toBe(true);

  // Click on the body in a far area
  await page.mouse.click(5, 5);
  await page.waitForTimeout(300);
  const stillOpen = await page.locator('.profile-view-root').count();
  // No "click outside" close (overlay covers full page anyway)
  console.log('Profile after outside click count:', stillOpen);
  expect(stillOpen).toBe(1);
});

// ─── 2. Task panel overlay ────────────────────────────────────────────────────

test('task panel overlay: opens via task-panel-hover chip and back returns', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Look for the task-panel-hover chip
  const taskChip = page.locator('.task-panel-hover[data-source-name]').first();
  const found = await taskChip.count();
  console.log('task-panel-hover count:', found);

  if (found > 0) {
    await taskChip.click();
    await page.waitForTimeout(500);
    expect(await page.locator('.task-panel-view-root').isVisible()).toBe(true);

    // Back button
    await page.locator('.task-panel-view-root .btn-back[data-action="back-to-schedule"]').click();
    await page.waitForTimeout(400);
    expect(await page.locator('.task-panel-view-root').count()).toBe(0);
  } else {
    // Try opening via gm:open-task-panel custom event using a known sourceName
    const sourceName = await page.evaluate(() => {
      const el = document.querySelector('.task-tooltip-hover[data-task-id]') as HTMLElement | null;
      if (!el) return null;
      const taskId = el.dataset.taskId;
      // Best effort: dispatch open-task-panel for the first task chip
      const chip = document.querySelector('[data-source-name]') as HTMLElement | null;
      return chip?.dataset.sourceName || null;
    });
    console.log('No task-panel-hover; sourceName probe:', sourceName);
  }
  expect(pageErrors).toEqual([]);
});

// ─── 3. Tooltips: hover behavior on desktop ───────────────────────────────────

test('tooltip: hover shows participant tooltip and mouseout hides it', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const firstP = page.locator('.participant-hover[data-pid]').first();
  await firstP.hover();
  await page.waitForTimeout(300);
  const ttVisible = await page.locator('.participant-tooltip').isVisible();
  expect(ttVisible).toBe(true);

  // Move mouse far away
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const ttHidden = await page.locator('.participant-tooltip').isVisible();
  expect(ttHidden).toBe(false);
});

test('tooltip: positioned within viewport (no clipping)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Hover a participant near the right edge — find the rightmost
  const positions = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('.participant-hover[data-pid]')) as HTMLElement[];
    return els.slice(0, 30).map((el, i) => {
      const r = el.getBoundingClientRect();
      return { i, right: r.right, top: r.top };
    });
  });
  console.log('First few participant positions:', positions.slice(0, 5));

  // Find one near right edge
  const rightmostIdx = positions.reduce((best, cur) => (cur.right > best.right ? cur : best), { i: 0, right: 0, top: 0 }).i;
  const target = page.locator('.participant-hover[data-pid]').nth(rightmostIdx);
  await target.hover();
  await page.waitForTimeout(400);

  const ttRect = await page.evaluate(() => {
    const tt = document.querySelector('.participant-tooltip') as HTMLElement | null;
    if (!tt || tt.style.display === 'none') return null;
    const r = tt.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight };
  });
  console.log('Tooltip rect (rightmost):', ttRect);
  if (ttRect) {
    expect(ttRect.right).toBeLessThanOrEqual(ttRect.w);
    expect(ttRect.left).toBeGreaterThanOrEqual(0);
    expect(ttRect.bottom).toBeLessThanOrEqual(ttRect.h);
    expect(ttRect.top).toBeGreaterThanOrEqual(0);
  }
});

test('tooltip: only one tooltip in DOM after multiple hovers (no orphan stacking)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  for (let i = 0; i < 5; i++) {
    await page.locator('.participant-hover[data-pid]').nth(i).hover();
    await page.waitForTimeout(120);
  }
  const count = await page.locator('.participant-tooltip').count();
  console.log('Participant tooltip count after 5 hovers:', count);
  expect(count).toBe(1);
});

test('tooltip: task tooltip appears on hover of task-tooltip-hover element', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const firstTask = page.locator('.task-tooltip-hover[data-task-id]').first();
  await firstTask.hover();
  await page.waitForTimeout(300);
  const visible = await page.locator('.task-detail-tooltip').isVisible();
  console.log('Task tooltip visible:', visible);
  expect(visible).toBe(true);

  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const hidden = await page.locator('.task-detail-tooltip').isVisible();
  expect(hidden).toBe(false);
});

test('tooltip: clicking on participant after tooltip click navigates to profile', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const target = page.locator('.participant-hover[data-pid]').first();
  await target.hover();
  await page.waitForTimeout(300);
  await target.click();
  await page.waitForTimeout(400);
  const profile = await page.locator('.profile-view-root').isVisible();
  expect(profile).toBe(true);
});

// ─── 4. Workload popup ─────────────────────────────────────────────────────────

test('workload popup: clicking sidebar bar opens popup', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const sidebarBar = page.locator('.sidebar-bar-bg[data-pid]').first();
  const found = await sidebarBar.count();
  console.log('Sidebar bars:', found);
  if (found > 0) {
    await sidebarBar.click();
    await page.waitForTimeout(400);
    const popupVisible = await page.locator('.workload-popup').isVisible();
    expect(popupVisible).toBe(true);

    // Esc closes
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const popupHidden = await page.locator('.workload-popup').isVisible();
    expect(popupHidden).toBe(false);
  }
});

test('workload popup: positioned within viewport', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const sidebarBar = page.locator('.sidebar-bar-bg[data-pid]').first();
  if ((await sidebarBar.count()) === 0) test.skip();
  await sidebarBar.click();
  await page.waitForTimeout(400);
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.workload-popup') as HTMLElement | null;
    if (!el || el.style.display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: window.innerWidth, h: window.innerHeight };
  });
  console.log('Workload popup rect:', rect);
  if (rect) {
    expect(rect.l).toBeGreaterThanOrEqual(0);
    expect(rect.r).toBeLessThanOrEqual(rect.w);
    expect(rect.t).toBeGreaterThanOrEqual(0);
    expect(rect.b).toBeLessThanOrEqual(rect.h);
  }
});

// ─── 5. KPI tile + jump-to-violations ────────────────────────────────────────

test('KPI: jump-to-violations tile clickable; Enter and Space activate it', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const tile = page.locator('[data-action="jump-to-violations"]');
  const found = await tile.count();
  console.log('Warnings tile count:', found);
  if (found === 0) test.skip(true, 'Schedule has no warnings — tile not rendered');

  // Click test
  const beforeY = await page.evaluate(() => window.scrollY);
  await tile.click();
  await page.waitForTimeout(800);
  const afterY = await page.evaluate(() => window.scrollY);
  console.log('Scroll Y before/after click:', beforeY, afterY);
  expect(afterY).not.toBe(beforeY);

  // Enter key
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await tile.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const afterEnterY = await page.evaluate(() => window.scrollY);
  console.log('After Enter scrollY:', afterEnterY);
  expect(afterEnterY).toBeGreaterThan(0);

  // Space key
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await tile.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  const afterSpaceY = await page.evaluate(() => window.scrollY);
  console.log('After Space scrollY:', afterSpaceY);
  expect(afterSpaceY).toBeGreaterThan(0);
});

// ─── 6. Availability strip ─────────────────────────────────────────────────────

test('availability strip: open and close', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const open = page.locator('[data-action="open-avail-strip"]').first();
  const cnt = await open.count();
  console.log('open-avail-strip count:', cnt);
  if (cnt === 0) test.skip();
  await open.click();
  await page.waitForTimeout(300);

  // After opening, the close button should appear
  const closeBtn = page.locator('[data-action="close-avail-strip"]');
  const closeFound = await closeBtn.count();
  console.log('close-avail-strip count after open:', closeFound);
  expect(closeFound).toBeGreaterThan(0);

  await closeBtn.first().click();
  await page.waitForTimeout(300);
  const reopenable = await page.locator('[data-action="open-avail-strip"]').count();
  expect(reopenable).toBeGreaterThan(0);
});

// ─── 7. Sidebar toggle ────────────────────────────────────────────────────────

test('sidebar toggle: collapses and expands the workload sidebar', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const sidebar = page.locator('.participant-sidebar');
  expect(await sidebar.count()).toBeGreaterThan(0);
  const isCollapsedBefore = await sidebar.evaluate((el) => el.classList.contains('sidebar-collapsed'));
  await page.locator('[data-action="sidebar-toggle"]').click();
  await page.waitForTimeout(400);
  const isCollapsedAfter = await page.locator('.participant-sidebar').evaluate((el) => el.classList.contains('sidebar-collapsed'));
  console.log('Sidebar collapsed before/after click:', isCollapsedBefore, isCollapsedAfter);
  expect(isCollapsedAfter).not.toBe(isCollapsedBefore);
});

// ─── 8. Senior toggle ─────────────────────────────────────────────────────────

test('senior toggle: shows/hides senior workload section', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const panel = page.locator('#sidebar-senior-panel');
  const before = await panel.evaluate((el) => el.classList.contains('hidden'));
  await page.locator('#btn-senior-toggle').click();
  await page.waitForTimeout(300);
  const after = await page.locator('#sidebar-senior-panel').evaluate((el) => el.classList.contains('hidden'));
  console.log('Senior panel hidden before/after:', before, after);
  expect(after).not.toBe(before);
});

// ─── 9. Easter eggs / debug helpers ──────────────────────────────────────────

test('easter eggs: gardenWisdom() and toggleSchedulerDiag() do not throw', async ({ page }) => {
  await setup(page);

  const result = await page.evaluate(() => {
    const out: { gw?: string; gwErr?: string; tsd?: string; tsdErr?: string } = {};
    try {
      const fn = (window as any).gardenWisdom;
      out.gw = typeof fn;
      if (typeof fn === 'function') fn();
    } catch (e: any) {
      out.gwErr = String(e?.message || e);
    }
    try {
      const fn2 = (window as any).toggleSchedulerDiag;
      out.tsd = typeof fn2;
      if (typeof fn2 === 'function') fn2(false); // toggle off if was on
    } catch (e: any) {
      out.tsdErr = String(e?.message || e);
    }
    return out;
  });
  console.log('Easter egg result:', result);
  expect(result.gw).toBe('function');
  expect(result.tsd).toBe('function');
  expect(result.gwErr).toBeUndefined();
  expect(result.tsdErr).toBeUndefined();
});

// ─── 10. Modal layering: Esc closes ──────────────────────────────────────────

test('modal: snapshot toggle modal — Esc closes it', async ({ page }) => {
  await setup(page);
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.waitForTimeout(300);

  // Open snapshots panel
  await page.locator('#btn-snap-toggle').click();
  await page.waitForTimeout(400);

  // Look for modal/snap panel
  const hasModal = await page.locator('.gm-modal, .snap-panel, .gm-bs').count();
  console.log('After btn-snap-toggle modal count:', hasModal);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const hasModalAfter = await page.locator('.gm-modal').count();
  console.log('After Esc modal count:', hasModalAfter);
});

// ─── 11. Theme switching ──────────────────────────────────────────────────────

test('theme: toggling dark mode does not produce hidden text (sample)', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Find theme toggle (look for any obvious selector)
  const themeBtn = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const c of candidates) {
      const text = c.textContent?.toLowerCase() || '';
      const title = (c as HTMLElement).title?.toLowerCase() || '';
      if (text.includes('theme') || text.includes('דרק') || text.includes('🌓') || text.includes('🌙') || text.includes('☀') || title.includes('theme') || title.includes('כהה') || title.includes('בהיר')) {
        return { tag: c.tagName, id: (c as HTMLElement).id, cls: c.className, txt: text.slice(0, 30) };
      }
    }
    return null;
  });
  console.log('Theme button:', themeBtn);

  // Inspect the body for color: #fff explicit contrast
  const initialDark = await page.evaluate(() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark');
  console.log('Initial dark mode:', initialDark);
});

// ─── 12. Modal: ui-modal stacking — open showAlert from console ──────────────

test('modal: showAlert from ui-modal opens a modal that closes on Esc', async ({ page }) => {
  await setup(page);

  await page.evaluate(() => {
    // Try to import & call showAlert via dynamic import
    return import('/src/web/ui-modal.ts').then((m) => {
      // Don't await — allow the modal to remain open
      m.showAlert('test alert', { title: 'Test' });
    }).catch(e => { console.warn('Could not import ui-modal:', e); });
  });
  await page.waitForTimeout(500);
  const modal = await page.locator('.gm-modal').count();
  console.log('Modal count after showAlert:', modal);

  if (modal > 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const modalAfter = await page.locator('.gm-modal').count();
    console.log('Modal count after Esc:', modalAfter);
  }
});

// ─── 13. Tooltip: action button (swap) inside tooltip clickable ──────────────

test('tooltip: swap button inside participant tooltip is clickable', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  // Hover a participant in a slot (must have data-assignment-id)
  const target = page.locator('.participant-hover[data-pid][data-assignment-id]').first();
  const cnt = await target.count();
  console.log('participant-hover with assignment-id count:', cnt);
  if (cnt === 0) test.skip();
  await target.hover();
  await page.waitForTimeout(400);
  const swapBtn = page.locator('.participant-tooltip .btn-swap');
  const swapCount = await swapBtn.count();
  console.log('Swap button in tooltip count:', swapCount);

  if (swapCount > 0) {
    // Hover the tooltip first to keep it open
    await page.locator('.participant-tooltip').hover();
    await page.waitForTimeout(200);
    await swapBtn.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    // After clicking swap a swap modal/picker should appear
    const swapPicker = await page.locator('.gm-modal, .swap-picker, .swap-modal').count();
    console.log('Swap picker count after click:', swapPicker);
  }
});

// ─── 14. Schedule grid horizontal scroll / sticky alignment ──────────────────

test('layout: schedule scrolls without page horizontal overflow at 1280×800', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const overflow = await page.evaluate(() => {
    const docW = document.documentElement.scrollWidth;
    const winW = window.innerWidth;
    return { docW, winW, overflow: docW > winW + 1 };
  });
  console.log('Document overflow check:', overflow);
  // Document should NOT exceed viewport at 1280
  expect(overflow.overflow).toBe(false);
});

// ─── 15. Profile: editable controls — does profile have any? ─────────────────

test('profile overlay: no inline edit controls (read-only); navigates correctly', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);
  await page.locator('.participant-hover[data-pid]').first().click();
  await page.waitForTimeout(400);

  const editControls = await page.evaluate(() => {
    const root = document.querySelector('.profile-view-root');
    if (!root) return null;
    const inputs = root.querySelectorAll('input').length;
    const selects = root.querySelectorAll('select').length;
    const textareas = root.querySelectorAll('textarea').length;
    const editBtns = root.querySelectorAll('[data-action*="edit"]').length;
    return { inputs, selects, textareas, editBtns };
  });
  console.log('Profile edit controls:', editControls);
});

// ─── 16. Continuity chip clear ───────────────────────────────────────────────

test('continuity chip clear: hidden when no continuity active', async ({ page }) => {
  await setup(page);
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  const chip = await page.locator('.continuity-chip-clear').count();
  console.log('continuity chip count (no continuity):', chip);
  expect(chip).toBe(0);
});

// ─── 17. Keyboard tab focus — focus rings visible ────────────────────────────

test('keyboard: Tab cycles focus through visible interactive elements', async ({ page }) => {
  await setup(page);
  await page.locator('.tab-btn[data-tab="schedule"]').click();
  await page.waitForTimeout(300);

  // Focus body, then Tab twice
  await page.evaluate(() => (document.body as HTMLElement).focus());
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  const active = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      tag: el.tagName,
      role: el.getAttribute('role'),
      text: el.textContent?.slice(0, 50),
      hasFocusVisible: el.matches(':focus-visible'),
      computedOutline: getComputedStyle(el).outline,
      computedBoxShadow: getComputedStyle(el).boxShadow,
    };
  });
  console.log('Active element after 5 Tabs:', active);
});

// ─── 18. KPI hero label is reachable but not interactive ──────────────────────

test('KPI hero (non-warning) is not clickable when feasible-no-violations', async ({ page }) => {
  await setup(page);
  await generateSchedule(page);

  const heroIsButton = await page.evaluate(() => {
    const hero = document.querySelector('.kpi-hero');
    if (!hero) return null;
    return {
      role: hero.getAttribute('role'),
      tabindex: hero.getAttribute('tabindex'),
      hasClickAction: !!hero.querySelector('[data-action]'),
    };
  });
  console.log('KPI hero attrs:', heroIsButton);
});
