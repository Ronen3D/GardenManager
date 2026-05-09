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

  test('popover renders as a sheet anchored to a viewport edge on mobile', async ({ page, viewport }) => {
    if (!viewport || viewport.width > 767) test.skip();
    await page.evaluate(() => window.gmStartTutorial?.('participants'));
    const popover = page.locator('.tutorial-popover');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).toBeTruthy();
    // Sheet: anchored to either the top OR the bottom edge of the viewport.
    // The engine flips to a top-sheet when the spotlit target sits in the
    // lower half of the screen so the popover doesn't occlude what it's
    // describing — both anchors are valid, only one applies per step.
    const flushTop = box!.y <= 4;
    const flushBottom = box!.y + box!.height >= viewport!.height - 4;
    expect(flushTop || flushBottom).toBe(true);
    // Full-width on mobile
    expect(box!.width).toBeGreaterThan(viewport!.width - 8);
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
    // Walk to step 11 (manual-build), which embeds a screenshot
    for (let i = 0; i < 10; i++) {
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
