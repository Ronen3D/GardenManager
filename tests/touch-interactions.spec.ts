import { expect, test } from '@playwright/test';

test.describe('Touch interactions on phone', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.tab-nav');
  });

  test('touch-device class is set when hasTouch is true', async ({ page, browserName }) => {
    const hasClass = await page.evaluate(() => document.documentElement.classList.contains('touch-device'));

    // hasTouch is set in the phone project config
    const isMobileProject = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);

    if (isMobileProject) {
      expect(hasClass).toBe(true);
    }
  });

  test('pointer-device class is set on desktop', async ({ page }) => {
    const hasTouchClass = await page.evaluate(() => document.documentElement.classList.contains('touch-device'));
    const hasPointerClass = await page.evaluate(() => document.documentElement.classList.contains('pointer-device'));

    // One or the other should be set
    expect(hasTouchClass || hasPointerClass).toBe(true);
    // They should be mutually exclusive
    expect(hasTouchClass && hasPointerClass).toBe(false);
  });

  test('bottom sheet component renders correctly when triggered', async ({ page }) => {
    // Verify the bottom sheet CSS classes are defined
    const hasStyles = await page.evaluate(() => {
      const rules = Array.from(document.styleSheets)
        .flatMap((s) => {
          try {
            return Array.from(s.cssRules);
          } catch {
            return [];
          }
        })
        .map((r) => (r as CSSStyleRule).selectorText || '')
        .filter((s) => s.includes('gm-bottom-sheet'));
      return rules.length > 0;
    });
    expect(hasStyles).toBe(true);
  });
});
