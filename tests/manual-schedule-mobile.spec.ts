import { expect, type Page, test } from '@playwright/test';

/**
 * C6.3 — Manual tap-to-assign on the phone viewport.
 *
 * REWRITTEN from an assertion-free console.log/screenshot script into real
 * behavioral tests. Flow:
 *   create an empty manual schedule → tap an empty slot → the participant
 *   bottom sheet opens with eligible candidates → tap an eligible candidate
 *   → the slot becomes assigned to that participant + a success toast → the
 *   manual-build counter increments → day navigation switches grid content.
 *
 * Every step asserts a real DOM/state change. No console.log, no early
 * return that hides failure, no screenshot-as-assertion.
 */

const PHONE_ONLY = (viewport: { width: number; height: number } | null) =>
  !viewport || viewport.width > 500;

async function freshSeed(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.tab-nav');
}

/** Create an empty manual schedule (all slots unfilled) and enter build mode. */
async function createEmptyManualSchedule(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const emptyBtn = page.locator('#btn-create-manual-empty');
  await expect(emptyBtn).toBeVisible();
  await emptyBtn.tap();

  await expect(page.locator('.schedule-grid-container')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.manual-build-strip')).toBeVisible();
  // Empty schedule → at least one empty slot must exist.
  await expect(page.locator('.assignment-card.manual-slot-empty').first()).toBeVisible();
}

/** Assign the first eligible candidate to a given empty-slot card. */
async function assignFirstEligible(
  page: Page,
  slotCard: ReturnType<Page['locator']>,
  excludePid?: string,
): Promise<{ pid: string; name: string; taskId: string; slotId: string }> {
  const taskId = (await slotCard.getAttribute('data-task-id')) || '';
  const slotId = (await slotCard.getAttribute('data-slot-id')) || '';
  expect(taskId.length).toBeGreaterThan(0);
  expect(slotId.length).toBeGreaterThan(0);

  await slotCard.scrollIntoViewIfNeeded();
  await slotCard.tap();

  // Bottom sheet with eligible candidates.
  const sheet = page.locator('.gm-bottom-sheet');
  await expect(sheet).toBeVisible({ timeout: 5000 });
  const eligible = sheet.locator('.warehouse-card.wc-eligible[data-pid]');
  await expect(eligible.first()).toBeVisible();
  const eligibleCount = await eligible.count();
  expect(eligibleCount).toBeGreaterThan(0);

  // Pick the first eligible candidate (optionally skipping a given pid so a
  // second assignment uses a different, unassigned person — avoids the
  // move-confirm dialog path entirely).
  let chosen = eligible.first();
  if (excludePid) {
    for (let i = 0; i < eligibleCount; i++) {
      const c = eligible.nth(i);
      if ((await c.getAttribute('data-pid')) !== excludePid) {
        chosen = c;
        break;
      }
    }
  }
  const pid = (await chosen.getAttribute('data-pid')) || '';
  const name = ((await chosen.locator('.wc-name').textContent()) || '').trim();
  expect(pid.length).toBeGreaterThan(0);
  expect(name.length).toBeGreaterThan(0);

  await chosen.tap();

  // Sheet closes after a successful assignment.
  await expect(page.locator('.gm-bottom-sheet')).toHaveCount(0, { timeout: 5000 });

  return { pid, name, taskId, slotId };
}

test.describe('Manual schedule creation on mobile', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (PHONE_ONLY(viewport)) test.skip();
    await freshSeed(page);
  });

  test('C6.3 tap empty slot → pick eligible candidate → slot assigned + toast', async ({
    page,
  }) => {
    await createEmptyManualSchedule(page);

    const strip = page.locator('.manual-build-status');
    await expect(strip).toContainText('0/');

    const firstSlot = page.locator('.assignment-card.manual-slot-empty').first();
    const { name, taskId, slotId } = await assignFirstEligible(page, firstSlot);

    // Success toast names the assignment.
    const toast = page.locator('.gm-toast.gm-toast-success .gm-toast-msg');
    await expect(toast.first()).toContainText('שובץ');

    // The slot card is now filled with that participant and is no longer empty.
    const assignedCard = page.locator(
      `.assignment-card[data-task-id="${taskId}"][data-slot-id="${slotId}"]`,
    );
    await expect(assignedCard).toHaveCount(1);
    await expect(assignedCard).not.toHaveClass(/manual-slot-empty/);
    await expect(assignedCard.locator('.participant-name')).toContainText(name);

    // The manual-build filled counter incremented (0 → 1).
    await expect(strip).toContainText('1/');
  });

  test('C6.3 a second assignment in another empty slot also assigns', async ({ page }) => {
    await createEmptyManualSchedule(page);

    const first = await assignFirstEligible(
      page,
      page.locator('.assignment-card.manual-slot-empty').first(),
    );
    await expect(
      page.locator(
        `.assignment-card[data-task-id="${first.taskId}"][data-slot-id="${first.slotId}"]`,
      ),
    ).not.toHaveClass(/manual-slot-empty/);
    await expect(page.locator('.manual-build-status')).toContainText('1/');

    // Next remaining empty slot, a different participant.
    const second = await assignFirstEligible(
      page,
      page.locator('.assignment-card.manual-slot-empty').first(),
      first.pid,
    );
    expect(second.pid).not.toBe(first.pid);

    const secondCard = page.locator(
      `.assignment-card[data-task-id="${second.taskId}"][data-slot-id="${second.slotId}"]`,
    );
    await expect(secondCard).not.toHaveClass(/manual-slot-empty/);
    await expect(secondCard.locator('.participant-name')).toContainText(second.name);
    await expect(page.locator('.manual-build-status')).toContainText('2/');
  });

  test('C6.3 day navigation switches the grid content to day 2', async ({ page }) => {
    await createEmptyManualSchedule(page);

    // Phone day navigator (hero) starts on day 1.
    const heroLabel = page.locator('.day-hero-label');
    await expect(heroLabel).toHaveText('יום 1');

    // Capture the set of task ids rendered for day 1.
    const day1TaskIds = await page
      .locator('.schedule-grid-container .assignment-card[data-task-id]')
      .evaluateAll((els) =>
        Array.from(new Set(els.map((e) => e.getAttribute('data-task-id') || ''))).sort(),
      );
    expect(day1TaskIds.length).toBeGreaterThan(0);

    const day2Dot = page.locator('.day-hero-dot[data-day="2"]');
    await expect(day2Dot).toBeVisible();
    await day2Dot.tap();

    // Content (not just the active class) reflects day 2.
    await expect(heroLabel).toHaveText('יום 2');
    await expect(page.locator('.day-hero-dot-active')).toHaveAttribute('data-day', '2');

    const day2TaskIds = await page
      .locator('.schedule-grid-container .assignment-card[data-task-id]')
      .evaluateAll((els) =>
        Array.from(new Set(els.map((e) => e.getAttribute('data-task-id') || ''))).sort(),
      );
    expect(day2TaskIds.length).toBeGreaterThan(0);
    // Per-day tasks have distinct ids — day 2 is a different task set.
    expect(day2TaskIds).not.toEqual(day1TaskIds);

    // Day 2 is also an empty manual schedule (its own unfilled slots).
    await expect(page.locator('.assignment-card.manual-slot-empty').first()).toBeVisible();
  });
});
