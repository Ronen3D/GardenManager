import { expect, type Page, test } from '@playwright/test';

/**
 * C6.2 / C6.5 — Swap-picker bottom sheet, end-to-end on the phone viewport.
 *
 * These are BEHAVIORAL tests: every step asserts a real state change. The
 * swap-picker is the primary post-generation editing surface on mobile, so
 * the flow exercised here is: generate → tap a swimlane assignment block →
 * the block sheet → tap the ⇄ swap button → the `.swap-picker-sheet` opens →
 * search / group / level filters actually filter the candidate list → the
 * "החלפה הדדית" (mutual-swap) tab renders → free-mode preview shows
 * status + workload-delta (▲) info → commit → the engine applied the swap
 * (the assigned participant changed in the swimlane DOM) + a success toast.
 *
 * C6.5 separately asserts the bottom-sheet body-scroll lock while open and
 * swipe-down-to-dismiss on the drag handle.
 */

const PHONE_ONLY = (viewport: { width: number; height: number } | null) => !viewport || viewport.width > 500;

async function freshSeed(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.tab-nav');
}

async function generateSchedule(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const scenarios = page.locator('#input-scenarios');
  await scenarios.fill('1');
  await page.click('#btn-generate');
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#btn-generate') as HTMLButtonElement | null;
      return !!b && !b.disabled && !(b.textContent || '').includes('מייעל');
    },
    undefined,
    { timeout: 90000 },
  );
  // The swimlane section only renders once a schedule exists — deterministic
  // completion signal (no arbitrary sleeps).
  await page.waitForSelector('.swimlane-section-toggle', { timeout: 90000 });
}

async function expandSwimlane(page: Page): Promise<void> {
  const section = page.locator('.swimlane-section');
  await expect(section).toHaveCount(1);
  const collapsed = await section.evaluate((el) => el.classList.contains('swimlane-section--collapsed'));
  if (collapsed) await page.locator('.swimlane-section-toggle').tap();
  await expect(page.locator('.swimlane-section--collapsed')).toHaveCount(0);
  await expect(page.locator('.swimlane-view .swimlane-block[data-task-id]').first()).toBeVisible();
}

interface OpenedPicker {
  sourcePid: string;
  taskId: string;
  assignmentId: string;
}

/**
 * Tap swimlane blocks (bounded) until one opens a swap picker that has at
 * least one eligible free-mode candidate. Throws (fails the test) if none of
 * the first N blocks is swappable — this is a search, not a vacuous guard.
 */
async function openSwapPickerForSwappableBlock(page: Page): Promise<OpenedPicker> {
  const blocks = page.locator('.swimlane-view .swimlane-block[data-task-id]');
  const total = await blocks.count();
  expect(total).toBeGreaterThan(0);
  const limit = Math.min(total, 10);

  for (let i = 0; i < limit; i++) {
    const block = blocks.nth(i);
    const meta = await block.evaluate((el) => ({
      taskId: el.getAttribute('data-task-id') || '',
      pid: el.closest('.swimlane-lane')?.getAttribute('data-participant-id') || '',
    }));
    await block.scrollIntoViewIfNeeded();
    await block.tap();

    const swapBtn = page.locator('.gm-bottom-sheet .btn-swap[data-assignment-id]');
    await expect(swapBtn).toBeVisible({ timeout: 5000 });
    const assignmentId = (await swapBtn.getAttribute('data-assignment-id')) || '';
    await swapBtn.tap();

    const sheet = page.locator('.swap-picker-sheet');
    await expect(sheet).toBeVisible({ timeout: 5000 });

    const eligible = sheet.locator('.swap-picker-list .warehouse-card.wc-eligible');
    if ((await eligible.count()) > 0) {
      return { sourcePid: meta.pid, taskId: meta.taskId, assignmentId };
    }

    // No eligible candidate for this assignment — close and try the next.
    await sheet.locator('.swap-picker-cancel').tap();
    await expect(page.locator('.swap-picker-sheet')).toHaveCount(0);
  }
  throw new Error(`no swappable block with an eligible candidate found in first ${limit} blocks`);
}

test.describe('Swap-picker bottom sheet on mobile', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (PHONE_ONLY(viewport)) test.skip();
    await freshSeed(page);
  });

  // ── C6.2 ──────────────────────────────────────────────────────────────────
  test('C6.2 swap-picker end-to-end: filters, mutual-swap tab, preview, commit', async ({ page }) => {
    await generateSchedule(page);
    await expandSwimlane(page);

    const { sourcePid, taskId } = await openSwapPickerForSwappableBlock(page);
    const sheet = page.locator('.swap-picker-sheet');

    // Sheet structure + filter controls present.
    await expect(sheet.locator('.swap-picker')).toBeVisible();
    await expect(sheet.locator('#swap-picker-search')).toBeVisible();
    await expect(sheet.locator('[data-filter-group]').first()).toBeVisible();
    await expect(sheet.locator('[data-filter-level]').first()).toBeVisible();

    const list = sheet.locator('.swap-picker-list');
    const cards = () => sheet.locator('.swap-picker-list .warehouse-card');
    const unfilteredCount = await cards().count();
    expect(unfilteredCount).toBeGreaterThan(0);

    // ── Search filter actually filters ──────────────────────────────────────
    const firstName = ((await cards().first().locator('.wc-name').textContent()) || '').trim();
    expect(firstName.length).toBeGreaterThan(0);

    const search = sheet.locator('#swap-picker-search');
    await search.fill(firstName);
    await expect(cards().first().locator('.wc-name')).toContainText(firstName);
    const searchedCount = await cards().count();
    expect(searchedCount).toBeGreaterThan(0);
    expect(searchedCount).toBeLessThanOrEqual(unfilteredCount);
    // Every visible card matches the typed name (case-insensitive).
    const visibleNames = await cards().locator('.wc-name').allTextContents();
    for (const n of visibleNames) {
      expect(n.trim().toLowerCase()).toContain(firstName.toLowerCase());
    }

    // Gibberish → explicit empty state, zero cards.
    await search.fill('qqzzxx-no-such-name');
    await expect(sheet.locator('.swap-picker-empty')).toBeVisible();
    await expect(cards()).toHaveCount(0);

    // Clearing restores the full list.
    await search.fill('');
    await expect(cards()).toHaveCount(unfilteredCount);

    // ── Group filter actually partitions the candidate list ─────────────────
    // (The picker shows a diagnostic "all members with reasons" fallback when
    //  a filter yields zero ELIGIBLE candidates, so count can grow — assert on
    //  the displayed candidate SET changing per group + an exact round-trip
    //  restore, which is invariant regardless of the diagnostic fallback.)
    const pidSig = async (): Promise<string> =>
      (await cards().evaluateAll((els) => els.map((e) => e.getAttribute('data-pid') || ''))).sort().join(',');

    const unfilteredSig = await pidSig();
    const groupNames = await sheet
      .locator('[data-filter-group]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-filter-group') || ''));
    expect(groupNames.length).toBeGreaterThan(0);

    const groupSigs: string[] = [];
    for (const g of groupNames.slice(0, 6)) {
      await sheet.locator(`[data-filter-group="${g}"]`).tap();
      await expect(sheet.locator(`[data-filter-group="${g}"]`)).toHaveClass(/chip-active/);
      groupSigs.push(await pidSig());
      // Toggle the same chip off → list restored EXACTLY.
      await sheet.locator(`[data-filter-group="${g}"]`).tap();
      await expect.poll(pidSig).toBe(unfilteredSig);
    }
    if (groupNames.length >= 2) {
      // Distinct groups have disjoint membership, so each active group chip
      // must yield a different displayed candidate set — proof the chip
      // actually partitions the list (not a no-op). Combined with the exact
      // round-trip restore asserted above.
      expect(new Set(groupSigs).size).toBe(groupSigs.length);
    }

    // ── Level filter restricts to the chosen level ──────────────────────────
    const firstBadge = ((await cards().first().locator('.wc-badges .badge').first().textContent()) || '').trim();
    const levelMatch = firstBadge.match(/(\d+)/);
    expect(levelMatch).not.toBeNull();
    const lvl = levelMatch![1];

    await sheet.locator(`[data-filter-level="${lvl}"]`).tap();
    await expect(sheet.locator(`[data-filter-level="${lvl}"]`)).toHaveClass(/chip-active/);
    const levelCount = await cards().count();
    expect(levelCount).toBeGreaterThan(0);
    // The first badge of every displayed card must be the chosen level badge.
    const perCardLevel = await cards().evaluateAll((els) =>
      els.map((e) => (e.querySelector('.wc-badges .badge')?.textContent || '').trim()),
    );
    for (const b of perCardLevel) {
      expect(b).toBe(`דרגה ${lvl}`);
    }
    // Toggle off → restored.
    await sheet.locator(`[data-filter-level="${lvl}"]`).tap();
    await expect(cards()).toHaveCount(unfilteredCount);

    // ── Mutual-swap tab ("החלפה הדדית") renders its region ──────────────────
    const tradeTab = sheet.locator('.swap-picker-tab[data-mode="trade"]');
    await tradeTab.tap();
    await expect(sheet.locator('.swap-picker-tab[data-mode="trade"]')).toHaveClass(/swap-picker-tab-active/);
    await expect(sheet.locator('.swap-picker-list[data-mode="trade"]')).toBeVisible();
    // Trade mode shows either tradeable rows or the explicit "no mutual swap"
    // empty state — assert exactly one of those is present (region rendered).
    const tradeRows = sheet.locator('.swap-trade-row');
    const tradeEmpty = sheet.locator('.swap-picker-empty');
    const tradeRowCount = await tradeRows.count();
    if (tradeRowCount > 0) {
      await tradeRows.first().locator('.warehouse-card[data-trade-assignment-id]').tap();
      const tradePreview = sheet.locator('.swap-preview-panel');
      await expect(tradePreview).toBeVisible();
      await expect(tradePreview).not.toHaveClass(/swap-preview-empty/);
      await expect(sheet.locator('.swap-preview-ok, .swap-preview-bad')).toHaveCount(1);
    } else {
      await expect(tradeEmpty).toBeVisible();
    }

    // ── Back to free mode → preview shows status + ▲ delta, then commit ─────
    await sheet.locator('.swap-picker-tab[data-mode="free"]').tap();
    await expect(sheet.locator('.swap-picker-tab[data-mode="free"]')).toHaveClass(/swap-picker-tab-active/);

    const confirm = sheet.locator('.swap-picker-confirm');
    let committedCandidatePid = '';
    let committedCandidateName = '';
    const eligibleCount = await sheet.locator('.swap-picker-list .warehouse-card.wc-eligible').count();
    expect(eligibleCount).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(eligibleCount, 6); i++) {
      const card = sheet.locator('.swap-picker-list .warehouse-card.wc-eligible').nth(i);
      const pid = (await card.getAttribute('data-pid')) || '';
      const name = ((await card.locator('.wc-name').textContent()) || '').trim();
      await card.tap();

      // Preview panel must populate with status + a workload-delta (▲) row.
      const preview = sheet.locator('.swap-preview-panel');
      await expect(preview).toBeVisible();
      await expect(preview).not.toHaveClass(/swap-preview-empty/);
      await expect(sheet.locator('.swap-preview-ok, .swap-preview-bad')).toHaveCount(1);
      await expect(sheet.locator('.swap-preview-delta-row').first()).toBeVisible();

      if (await confirm.isEnabled()) {
        committedCandidatePid = pid;
        committedCandidateName = name;
        break;
      }
      // Preview invalid (confirm disabled) — try the next eligible candidate.
    }
    expect(committedCandidatePid.length).toBeGreaterThan(0);
    expect(committedCandidatePid).not.toBe(sourcePid);

    await confirm.tap();

    // Sheet closes; engine applied the swap; success toast.
    await expect(page.locator('.swap-picker-sheet')).toHaveCount(0);

    const toast = page.locator('.gm-toast.gm-toast-success .gm-toast-msg');
    await expect(toast.first()).toContainText('החלפה');

    // The NEW participant's swimlane lane now holds that task block.
    await expect(
      page.locator(
        `.swimlane-view .swimlane-lane[data-participant-id="${committedCandidatePid}"] .swimlane-block[data-task-id="${taskId}"]`,
      ),
    ).toHaveCount(1);
    expect(committedCandidateName.length).toBeGreaterThan(0);
  });

  // ── C6.5 ──────────────────────────────────────────────────────────────────
  test('C6.5 bottom sheet locks background scroll and swipe-down dismisses it', async ({ page }) => {
    await generateSchedule(page);
    await expandSwimlane(page);

    await openSwapPickerForSwappableBlock(page);
    await expect(page.locator('.swap-picker-sheet')).toBeVisible();

    // Wait until only ONE bottom-sheet backdrop remains (the block sheet that
    // opened the picker has finished its close animation), so the scroll-lock
    // count is in a settled state.
    await expect(page.locator('.gm-bottom-sheet-backdrop')).toHaveCount(1);

    // Background scroll is locked while the sheet is open.
    const lockedStyles = await page.evaluate(() => ({
      position: document.body.style.position,
      overflow: document.body.style.overflow,
    }));
    expect(lockedStyles.position).toBe('fixed');
    expect(lockedStyles.overflow).toBe('hidden');

    // Attempting to scroll the page does nothing (body is position:fixed).
    await page.evaluate(() => window.scrollTo(0, 600));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    // Swipe the drag handle down (> 80px) via synthetic touch events.
    await page.evaluate(() => {
      const handle = document.querySelector('.swap-picker-sheet .gm-bs-drag-handle') as HTMLElement | null;
      if (!handle) throw new Error('drag handle not found');
      const r = handle.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      const fire = (type: string, y: number, withTouches: boolean) => {
        const t = new Touch({
          identifier: 1,
          target: handle,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
        const ev = new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: withTouches ? [t] : [],
          targetTouches: withTouches ? [t] : [],
          changedTouches: [t],
        });
        handle.dispatchEvent(ev);
      };
      fire('touchstart', y0, true);
      fire('touchmove', y0 + 70, true);
      fire('touchmove', y0 + 180, true);
      fire('touchend', y0 + 180, false);
    });

    // Sheet dismissed and scroll restored.
    await expect(page.locator('.swap-picker-sheet')).toHaveCount(0);
    const restored = await page.evaluate(() => ({
      position: document.body.style.position,
      overflow: document.body.style.overflow,
    }));
    expect(restored.position).toBe('');
    expect(restored.overflow).toBe('');
  });
});
