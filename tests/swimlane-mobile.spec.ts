import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Swimlane interactive editing — PHONE viewport (375×812).
 *
 * The swimlane (`src/web/swimlane-view.ts`) is the PRIMARY mobile schedule
 * surface — the Gantt chart is `!isSmallScreen`-only and is not rendered at
 * 375px. These specs drive the real person-first timeline:
 *
 *   C6.1  tap a swimlane block → block bottom-sheet → swap / rescue / profile
 *   C6.4  day navigation actually changes swimlane content
 *   C6.6  rescue modal from the swimlane: plan list → commit → schedule changed
 *
 * Every test asserts a concrete post-condition (DOM state change, toast,
 * modal open/close, view switch) — no bare screenshots, no `if (count>0)`
 * no-ops that silently pass when the element is absent.
 */

// ─── Phone-only gate ─────────────────────────────────────────────────────────

test.beforeEach(async ({ viewport }) => {
  if (!viewport || viewport.width > 500) test.skip();
});

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Clear storage, load the app, generate a schedule with the seeded roster. */
async function seedAndGenerate(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForSelector('.tab-nav');

  await page.click('.tab-btn[data-tab="schedule"]');
  await expect(page.locator('[data-tab="schedule"].tab-active')).toBeVisible();

  const scenarios = page.locator('#input-scenarios');
  await expect(scenarios).toBeVisible();
  await scenarios.fill('1');

  const generate = page.locator('#btn-generate');
  await expect(generate).toBeEnabled();
  await generate.click();

  // Optimization finished when the button is re-enabled and no longer "מייעל".
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
      return !!btn && !btn.disabled && !btn.textContent?.includes('מייעל');
    },
    { timeout: 90_000 },
  );

  // Swimlane is part of the schedule render — wait for it to exist.
  await expect(page.locator('.swimlane-view')).toBeAttached();
}

/** Expand the "תצוגה כללית" swimlane section (collapsed by default). */
async function expandSwimlane(page: Page): Promise<void> {
  const toggle = page.locator('[data-action="toggle-swimlane"]');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Body is display:none while collapsed; assert it's now laid out.
  await expect(page.locator('.swimlane-section-body')).toBeVisible();
}

/** Enable Live Mode via the schedule toolbar checkbox. */
async function enableLiveMode(page: Page): Promise<void> {
  const chk = page.locator('#chk-live-mode');
  await expect(chk).toBeAttached();
  await chk.scrollIntoViewIfNeeded();
  await chk.check({ force: true });
  await expect(chk).toBeChecked();
}

/** Navigate to a specific schedule day via the phone hero dot. */
async function gotoDay(page: Page, day: number): Promise<void> {
  const dot = page.locator(`.day-hero-dot[data-day="${day}"]`);
  await expect(dot).toBeAttached();
  await dot.click();
  await expect(page.locator('.day-hero-label')).toHaveText(new RegExp(`יום\\s*${day}\\b`));
}

/** Close any open bottom sheet (block sheet / picker) via Escape. */
async function closeBottomSheet(page: Page): Promise<void> {
  if ((await page.locator('.gm-bottom-sheet').count()) === 0) return;
  await page.keyboard.press('Escape');
  await expect(page.locator('.gm-bottom-sheet')).toHaveCount(0);
}

interface BlockPick {
  taskId: string;
  participantId: string;
  participantName: string;
}

/**
 * Find a swimlane block whose task id is UNIQUE within its participant's lane.
 * That uniqueness makes the post-swap assertion unambiguous: after the swap
 * the source lane must lose exactly that `[data-task-id]` block.
 *
 * `skip` lets the caller advance past blocks already tried.
 */
async function pickSwimlaneBlock(page: Page, skip = 0): Promise<BlockPick | null> {
  return page.evaluate((skipN: number) => {
    const lanes = Array.from(document.querySelectorAll('.swimlane-view .swimlane-lane'));
    const found: Array<{ taskId: string; participantId: string; participantName: string }> = [];
    for (const lane of lanes) {
      const pid = (lane as HTMLElement).dataset.participantId;
      if (!pid) continue;
      const blocks = Array.from(lane.querySelectorAll('.swimlane-block[data-task-id]'));
      const counts = new Map<string, number>();
      for (const b of blocks) {
        const tid = (b as HTMLElement).dataset.taskId!;
        counts.set(tid, (counts.get(tid) ?? 0) + 1);
      }
      const name = lane.querySelector('.swimlane-id-name')?.textContent?.trim() ?? '';
      for (const b of blocks) {
        const tid = (b as HTMLElement).dataset.taskId!;
        if (counts.get(tid) === 1) {
          found.push({ taskId: tid, participantId: pid, participantName: name });
        }
      }
    }
    return found[skipN] ?? null;
  }, skip);
}

/** Open the block bottom-sheet for a specific lane+task. */
async function openBlockSheet(page: Page, pick: BlockPick): Promise<void> {
  const block = page
    .locator(
      `.swimlane-lane[data-participant-id="${pick.participantId}"] .swimlane-block[data-task-id="${pick.taskId}"]`,
    )
    .first();
  await block.scrollIntoViewIfNeeded();
  await block.click();
  await expect(page.locator('.gm-bottom-sheet')).toBeVisible();
  await expect(page.locator('.swimlane-bs-task-summary')).toBeVisible();
}

// ═══════════════════════════════════════════════════════════════════════════
// C6.1 — Swimlane tap → action sheet → swap / rescue / goto-profile
// ═══════════════════════════════════════════════════════════════════════════

test.describe('C6.1 swimlane action sheet', () => {
  test('(a) tap block → sheet → swap to completion changes the assignment in the DOM', async ({ page }) => {
    test.setTimeout(150_000);
    await seedAndGenerate(page);
    await expandSwimlane(page);

    // Try several unambiguous blocks until one yields an eligible candidate
    // whose preview is valid — keeps the test deterministic on tight rosters.
    let committed: { pick: BlockPick; incomingName: string } | null = null;

    for (let attempt = 0; attempt < 8 && !committed; attempt++) {
      const pick = await pickSwimlaneBlock(page, attempt);
      if (!pick) break;

      await openBlockSheet(page, pick);
      const swapBtn = page.locator('.gm-bottom-sheet .btn-swap[data-assignment-id]');
      await expect(swapBtn).toBeVisible();
      await swapBtn.click();

      const picker = page.locator('.swap-picker-sheet');
      await expect(picker).toBeVisible();

      const eligible = picker.locator('.swap-picker-list .warehouse-card.wc-eligible[data-pid]');
      const eligibleCount = await eligible.count();
      if (eligibleCount === 0) {
        await picker.locator('.swap-picker-cancel').click();
        await expect(picker).toBeHidden();
        continue;
      }

      // Click eligible candidates until the preview is valid (confirm enabled).
      let chosenName = '';
      for (let i = 0; i < Math.min(eligibleCount, 5); i++) {
        const card = picker.locator('.swap-picker-list .warehouse-card.wc-eligible[data-pid]').nth(i);
        chosenName = (await card.locator('.wc-name').textContent())?.trim() ?? '';
        await card.click();
        const confirm = picker.locator('.swap-picker-confirm');
        try {
          await expect(confirm).toBeEnabled({ timeout: 3000 });
          await confirm.click();
          committed = { pick, incomingName: chosenName };
          break;
        } catch {
          // preview invalid for this candidate — try the next one
        }
      }

      if (!committed) {
        await picker.locator('.swap-picker-cancel').click();
        await expect(picker).toBeHidden();
      }
    }

    expect(committed, 'expected at least one swimlane block with an eligible, valid swap candidate').not.toBeNull();

    const { pick, incomingName } = committed!;

    // Post-condition 1: success toast naming the swap.
    const toast = page.locator('.gm-toast-success').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('החלפה');
    await expect(toast).toContainText(incomingName);

    // Post-condition 2: real DOM state change — the source participant's lane
    // no longer holds that (unique) task block; it moved to someone else.
    await expect(page.locator('.swimlane-view')).toBeVisible();
    const sourceLaneBlock = page.locator(
      `.swimlane-lane[data-participant-id="${pick.participantId}"] .swimlane-block[data-task-id="${pick.taskId}"]`,
    );
    await expect(sourceLaneBlock).toHaveCount(0);
    // And the task is still scheduled somewhere (not silently dropped).
    await expect(page.locator(`.swimlane-view .swimlane-block[data-task-id="${pick.taskId}"]`).first()).toBeVisible();
  });

  test('(b) tap block → sheet → rescue entry point opens the rescue modal', async ({ page }) => {
    test.setTimeout(120_000);
    await seedAndGenerate(page);
    // Rescue is live-mode-only and requires a *future* (non-frozen) task.
    // The default anchor is "now" which falls inside day 1, so navigate to a
    // later day where every task is still ahead of the anchor.
    await enableLiveMode(page);
    await expandSwimlane(page);
    await gotoDay(page, 4);

    let opened = false;
    for (let attempt = 0; attempt < 8 && !opened; attempt++) {
      const pick = await pickSwimlaneBlock(page, attempt);
      if (!pick) break;
      await openBlockSheet(page, pick);

      const rescueBtn = page.locator('.gm-bottom-sheet .btn-rescue[data-assignment-id]');
      if (!(await rescueBtn.isVisible().catch(() => false))) {
        await closeBottomSheet(page);
        continue;
      }
      await rescueBtn.click();

      const modal = page.locator('#rescue-modal-backdrop');
      await expect(modal).toBeVisible();
      await expect(modal.locator('.rescue-modal')).toBeVisible();
      await expect(modal.locator('.rescue-header')).toContainText('תוכניות החלפה');
      // The plans container always renders (with either plans or the
      // "no plans" message) — assert it's present, not merely "maybe".
      await expect(modal.locator('.rescue-plans')).toBeVisible();
      opened = true;
    }

    expect(opened, 'expected the rescue modal to open from a swimlane block').toBe(true);
  });

  test('(c) tap block → sheet → "go to profile" navigates to the profile view', async ({ page }) => {
    test.setTimeout(120_000);
    await seedAndGenerate(page);
    await expandSwimlane(page);

    const pick = await pickSwimlaneBlock(page, 0);
    expect(pick, 'expected at least one swimlane block').not.toBeNull();
    await openBlockSheet(page, pick!);

    const profileBtn = page.locator('.gm-bottom-sheet [data-action="goto-profile"][data-pid]');
    await expect(profileBtn).toBeVisible();
    const pid = await profileBtn.getAttribute('data-pid');
    expect(pid).toBeTruthy();
    await profileBtn.click();

    // Post-condition: the profile overlay replaced the schedule view.
    const profile = page.locator('.profile-view-root');
    await expect(profile).toBeVisible();
    await expect(profile).toContainText(pick!.participantName);
    // Back returns to the schedule (swimlane) view.
    const back = page.locator('.btn-back').first();
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator('.profile-view-root')).toHaveCount(0);
    await expect(page.locator('.swimlane-view')).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C6.4 — Day navigation actually changes swimlane content
// ═══════════════════════════════════════════════════════════════════════════

test.describe('C6.4 day navigation', () => {
  test('switching to day 2 changes the rendered swimlane content (not just an active class)', async ({ page }) => {
    test.setTimeout(120_000);
    await seedAndGenerate(page);
    await expandSwimlane(page);

    // Day 1 baseline.
    await expect(page.locator('.day-hero-label')).toHaveText(/יום\s*1\b/);
    const groups = page.locator('.swimlane-view .swimlane-groups');
    await expect(groups).toBeVisible();
    const day1Sig = (await groups.innerText()).trim();
    expect(day1Sig.length).toBeGreaterThan(0);

    // Navigate to day 2 via the phone hero dot.
    const day2 = page.locator('.day-hero-dot[data-day="2"]');
    await expect(day2).toBeAttached();
    await day2.click();

    // Header reflects day 2 (deterministic).
    await expect(page.locator('.day-hero-label')).toHaveText(/יום\s*2\b/);
    await expect(page.locator('.day-hero-dot[data-day="2"]')).toHaveClass(/day-hero-dot-active/);

    // Content reflects day 2: the rendered per-participant timeline differs
    // from day 1 (fairness/rest rotation across days). This is the real
    // assertion the review demanded — not merely the active CSS class.
    const day2Groups = page.locator('.swimlane-view .swimlane-groups');
    await expect(day2Groups).toBeVisible();
    const day2Sig = (await day2Groups.innerText()).trim();
    expect(day2Sig.length).toBeGreaterThan(0);
    expect(day2Sig).not.toBe(day1Sig);

    // Navigating back to day 1 restores the day-1 signature (content is
    // day-scoped, not stale).
    await page.locator('.day-hero-dot[data-day="1"]').click();
    await expect(page.locator('.day-hero-label')).toHaveText(/יום\s*1\b/);
    await expect((await page.locator('.swimlane-view .swimlane-groups').innerText()).trim()).toBe(day1Sig);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C6.6 — Rescue modal from the swimlane: plan list → commit → schedule changed
// ═══════════════════════════════════════════════════════════════════════════

test.describe('C6.6 rescue modal', () => {
  test('rescue from a swimlane block: pick a plan and commit changes the schedule', async ({ page }) => {
    test.setTimeout(180_000);
    await seedAndGenerate(page);
    await enableLiveMode(page);
    await expandSwimlane(page);
    // A future day so the slot is modifiable (rescue refuses frozen tasks).
    await gotoDay(page, 4);

    // Find a block whose rescue search yields at least one applicable plan.
    let planFound = false;
    let beforeSig = '';
    for (let attempt = 0; attempt < 12 && !planFound; attempt++) {
      const pick = await pickSwimlaneBlock(page, attempt);
      if (!pick) break;
      await openBlockSheet(page, pick);

      const rescueBtn = page.locator('.gm-bottom-sheet .btn-rescue[data-assignment-id]');
      if (!(await rescueBtn.isVisible().catch(() => false))) {
        await closeBottomSheet(page);
        continue;
      }
      await rescueBtn.click();

      const modal = page.locator('#rescue-modal-backdrop');
      await expect(modal).toBeVisible();
      await expect(modal.locator('.rescue-plans')).toBeVisible();

      const plans = modal.locator('.rescue-plan[data-plan-id]');
      const planCount = await plans.count();
      if (planCount === 0) {
        // Genuinely no plan for this slot — assert the explicit empty state,
        // then move on (not a vacuous skip).
        await expect(modal.locator('.rescue-empty')).toBeVisible();
        await modal.locator('#btn-rescue-dismiss').click();
        await expect(modal).toBeHidden();
        continue;
      }

      // Invariant: a depth-4 fallback plan MUST surface its warning banner.
      const fallbackPlans = modal.locator('.rescue-plan--fallback');
      const fallbackCount = await fallbackPlans.count();
      if (fallbackCount > 0) {
        await expect(modal.locator('.rescue-fallback-warning').first()).toBeVisible();
      }

      // Capture the day's swimlane signature behind the modal, then commit
      // the recommended (#1) plan.
      beforeSig = (await page.locator('.swimlane-view .swimlane-groups').innerText()).trim();
      const applyBtn = modal.locator('.rescue-plan[data-plan-id] .btn-apply-plan').first();
      await expect(applyBtn).toBeVisible();
      await applyBtn.click();
      planFound = true;
    }

    expect(planFound, 'expected at least one swimlane slot to yield a rescue plan').toBe(true);

    // Post-condition: modal closed, success toast shown, swimlane content
    // actually changed (the rescue chain reassigned ≥1 participant).
    await expect(page.locator('#rescue-modal-backdrop')).toHaveCount(0);
    const toast = page.locator('.gm-toast-success').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('החלפה');

    await expect(page.locator('.swimlane-view .swimlane-groups')).toBeVisible();
    const afterSig = (await page.locator('.swimlane-view .swimlane-groups').innerText()).trim();
    expect(afterSig).not.toBe(beforeSig);
  });
});
