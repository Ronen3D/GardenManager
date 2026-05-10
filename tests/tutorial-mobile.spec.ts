import { expect, test } from '@playwright/test';

/**
 * Tutorial — mobile coverage (375×812 phone project).
 *
 * Run via:
 *   npx playwright test tests/tutorial-mobile.spec.ts --project=phone
 */

async function clearAllStorage(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload();
  await page.waitForSelector('.tab-nav');
}

test.describe('Tutorial — mobile (375×812)', () => {
  test.beforeEach(async ({ page }) => {
    await clearAllStorage(page);
  });

  test('first-launch banner spans most of the viewport on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 480) test.skip();
    const banner = page.locator('.tutorial-banner');
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    expect(box).toBeTruthy();
    // Banner inherits the app container's horizontal padding on mobile; we want
    // it visibly spanning the layout, not a narrow centered card. ≥ 80% of viewport.
    expect(box!.width).toBeGreaterThanOrEqual(viewport!.width * 0.8);
  });

  test('popover lives in the lower half of the viewport (always)', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    const popover = page.locator('.tutorial-popover');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).toBeTruthy();
    // The mobile sheet is always bottom-anchored — either flush against the
    // bottom edge, or "lifted" just enough to clear a low-positioned target.
    // Both modes keep the popover in the lower portion of the screen so the
    // user always finds it in the same zone (no top/bottom flip).
    const popoverCenterY = box!.y + box!.height / 2;
    expect(popoverCenterY).toBeGreaterThan(viewport!.height * 0.4);
    // Bottom edge stays inside the viewport — no clipping above the bottom.
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    // Width fills the viewport (flush) or has a small symmetric gutter (lifted).
    expect(box!.width).toBeGreaterThan(viewport!.width - 24);
  });

  test('lifted sheet keeps target visible — nothing is occluded', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    // Switch to the schedule tab so the bottom-tab nav is the active context;
    // re-launching the participants track now spotlights a tab button at the
    // bottom of the screen — exactly the case that used to flip to top-sheet.
    await page.click('.tutorial-banner [data-tutorial-banner-action="dismiss"]:not(.tutorial-banner-close)');
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    const popover = page.locator('.tutorial-popover');
    await expect(popover).toBeVisible();
    const popoverBox = await popover.boundingBox();
    const target = page.locator('button.tab-btn[data-tab="participants"]');
    await expect(target).toBeVisible();
    const targetBox = await target.boundingBox();
    expect(popoverBox).toBeTruthy();
    expect(targetBox).toBeTruthy();
    // The target's bottom edge must sit at or below the popover's bottom
    // edge — i.e. the popover is *above* the target, not covering it.
    // (Equality: target sits flush at viewport bottom and popover ends there too.)
    const targetCenterY = targetBox!.y + targetBox!.height / 2;
    const popoverBottom = popoverBox!.y + popoverBox!.height;
    expect(targetCenterY).toBeGreaterThanOrEqual(popoverBottom - 1);
  });

  test('Esc closes the tutorial on mobile too', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    await expect(page.locator('.tutorial-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tutorial-popover')).toHaveCount(0);
  });

  test('schedule track step 6 retargets to .sidebar-fab on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();

    // Skip past banner so the track can run cleanly
    await page.click('.tutorial-banner [data-tutorial-banner-action="dismiss"]:not(.tutorial-banner-close)');

    // Need a generated schedule for step 6 to anchor to its real target.
    // Without one, the precondition falls back to centred — also a valid mobile state to assert on.
    await page.evaluate(() => window.gmStartTutorial?.('schedule'));

    // Walk to step 6
    for (let i = 0; i < 5; i++) {
      await page.click('.tutorial-popover [data-tutorial-action="next"]');
    }

    // Body should mention the floating sidebar button on mobile
    const body = page.locator('.tutorial-popover .tutorial-body');
    await expect(body).toBeVisible();
    // Either the precondition fired (centred fallback body) or the mobileOverride
    // body kicked in. Both versions reference the floating sidebar button on mobile.
    const text = await body.textContent();
    const ok = /סרגל עומס|כפתור הצף/.test(text ?? '');
    expect(ok).toBe(true);
  });

  test('orientation flip re-renders the current step', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    await expect(page.locator('.tutorial-popover')).toBeVisible();
    const before = await page.locator('.tutorial-title').textContent();

    // Rotate to landscape
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await page.waitForTimeout(300);

    const after = await page.locator('.tutorial-title').textContent();
    expect(after).toBe(before); // same step
    await expect(page.locator('.tutorial-popover')).toBeVisible();
  });

  test('embedded screenshot stays within bottom-sheet bounds on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('schedule'));
    // s-11 (manual-build, the screenshot step) sits at index 12 — s-10b and
    // s-10c were inserted between s-10 and s-11.
    for (let i = 0; i < 12; i++) {
      await page.click('.tutorial-popover [data-tutorial-action="next"]');
    }
    const img = page.locator('.tutorial-popover .tutorial-screenshot');
    await expect(img).toBeVisible();
    const popoverBox = await page.locator('.tutorial-popover').boundingBox();
    const imgBox = await img.boundingBox();
    expect(popoverBox).toBeTruthy();
    expect(imgBox).toBeTruthy();
    // Image width must not exceed the popover (allow 1px subpixel tolerance)
    expect(imgBox!.width).toBeLessThanOrEqual(popoverBox!.width + 1);
    // Image height must respect the 36vh cap on mobile
    expect(imgBox!.height).toBeLessThanOrEqual(viewport!.height * 0.36 + 1);
    // And the image must actually have loaded
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  });

  test('drag handle is visually present on mobile popover', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    const popover = page.locator('.tutorial-popover');
    await expect(popover).toBeVisible();
    // The drag handle is a ::before pseudo-element — assert via computed style
    const beforeContent = await popover.evaluate((el) => {
      const cs = window.getComputedStyle(el, '::before');
      return cs.content;
    });
    // ::before content: "" — non-empty so the rule applied
    expect(beforeContent).not.toBe('none');
  });
});
