import { test, expect, Page } from '@playwright/test';

/**
 * Mobile manual schedule creation flow test.
 *
 * Exercises the full flow: seed data → create empty schedule →
 * select slot → pick participant from bottom sheet → verify assignment.
 * Takes screenshots at each step to identify friction points.
 */

test.describe('Manual schedule creation on mobile', () => {
  // Only run on phone project
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width > 500) test.skip();

    // Clear localStorage to get fresh seeded data
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('.tab-nav');
  });

  test('full manual schedule creation flow', async ({ page, viewport }) => {
    // Step 1: Navigate to schedule tab
    await page.click('.tab-btn[data-tab="schedule"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'test-results/mobile-manual-01-schedule-tab-empty.png', fullPage: true });

    // Step 2: Verify the "create manual schedule" button is visible in empty state
    const emptyStateBtn = page.locator('#btn-create-manual-empty');
    const toolbarBtn = page.locator('#btn-create-manual');

    const emptyStateBtnVisible = await emptyStateBtn.isVisible().catch(() => false);
    const toolbarBtnVisible = await toolbarBtn.isVisible().catch(() => false);

    console.log(`Empty state button visible: ${emptyStateBtnVisible}`);
    console.log(`Toolbar button visible: ${toolbarBtnVisible}`);

    await page.screenshot({ path: 'test-results/mobile-manual-02-buttons-visible.png' });

    // Step 3: Check toolbar overflow on mobile — is the toolbar usable?
    const toolbar = page.locator('.schedule-toolbar');
    if (await toolbar.count() > 0) {
      const toolbarBox = await toolbar.boundingBox();
      console.log(`Toolbar bounding box: ${JSON.stringify(toolbarBox)}`);
      if (toolbarBox) {
        console.log(`Toolbar height: ${toolbarBox.height}px, width: ${toolbarBox.width}px`);
        // Flag if toolbar is taller than 200px (too many wrapped rows)
        if (toolbarBox.height > 200) {
          console.log('ISSUE: Toolbar is very tall on mobile — buttons overflow multiple rows');
        }
      }
    }

    // Step 4: Click the manual schedule button
    if (emptyStateBtnVisible) {
      await emptyStateBtn.click();
    } else if (toolbarBtnVisible) {
      await toolbarBtn.click();
    } else {
      // Try generating via button text
      const btn = page.locator('button', { hasText: 'בנייה ידנית' }).first();
      if (await btn.isVisible()) {
        await btn.click();
      } else {
        console.log('CRITICAL ISSUE: No manual schedule button found on mobile');
        await page.screenshot({ path: 'test-results/mobile-manual-02b-no-button.png', fullPage: true });
        return;
      }
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'test-results/mobile-manual-03-after-create.png', fullPage: true });

    // Step 5: Verify schedule grid appeared
    const gridContainer = page.locator('.schedule-grid-container');
    const gridVisible = await gridContainer.isVisible().catch(() => false);
    console.log(`Grid visible after create: ${gridVisible}`);

    if (!gridVisible) {
      console.log('CRITICAL ISSUE: Grid not visible after creating manual schedule');
      return;
    }

    // Step 6: Check grid compactness
    const gridCompact = page.locator('.schedule-grid-compact');
    const isCompact = await gridCompact.count() > 0;
    console.log(`Grid has compact class: ${isCompact}`);

    // Step 7: Check manual build strip
    const buildStrip = page.locator('.manual-build-strip');
    const stripVisible = await buildStrip.isVisible().catch(() => false);
    console.log(`Manual build strip visible: ${stripVisible}`);

    // Step 8: Check empty slots are visible and clickable
    const emptySlots = page.locator('.manual-slot-empty');
    const emptySlotCount = await emptySlots.count();
    console.log(`Empty slots visible: ${emptySlotCount}`);

    await page.screenshot({ path: 'test-results/mobile-manual-04-grid-overview.png' });

    if (emptySlotCount === 0) {
      // Maybe slots have a different class — check for manual-slot-target
      const targetSlots = page.locator('.manual-slot-target');
      const targetCount = await targetSlots.count();
      console.log(`Manual slot targets: ${targetCount}`);

      // Or just look for any clickable slot area
      const assignmentCards = page.locator('.assignment-card');
      const cardCount = await assignmentCards.count();
      console.log(`Assignment cards on page: ${cardCount}`);
    }

    // Step 9: Scroll down to see if more content is off screen
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/mobile-manual-05-scrolled-down.png' });

    // Step 10: Try to click on the first empty slot
    const firstEmptySlot = emptySlotCount > 0
      ? emptySlots.first()
      : page.locator('.assignment-card[data-slot-id]').first();

    if (await firstEmptySlot.count() > 0) {
      // Scroll into view first
      await firstEmptySlot.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: 'test-results/mobile-manual-06-before-slot-click.png' });

      // Check slot dimensions - is it large enough to tap?
      const slotBox = await firstEmptySlot.boundingBox();
      if (slotBox) {
        console.log(`First slot size: ${slotBox.width}x${slotBox.height} at (${slotBox.x}, ${slotBox.y})`);
        if (slotBox.height < 36) {
          console.log('ISSUE: Slot height is too small for comfortable touch target (<36px)');
        }
        if (slotBox.width < 44) {
          console.log('ISSUE: Slot width is too narrow for comfortable touch target (<44px)');
        }
      }

      // Click the slot
      await firstEmptySlot.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'test-results/mobile-manual-07-after-slot-click.png' });

      // Step 11: Check if bottom sheet opened
      const bottomSheet = page.locator('.gm-bottom-sheet');
      const sheetVisible = await bottomSheet.isVisible().catch(() => false);
      console.log(`Bottom sheet visible after slot click: ${sheetVisible}`);

      if (sheetVisible) {
        await page.screenshot({ path: 'test-results/mobile-manual-08-bottom-sheet.png' });

        // Check bottom sheet content
        const warehouseCards = page.locator('.gm-bottom-sheet .warehouse-card');
        const warehouseCount = await warehouseCards.count();
        console.log(`Warehouse cards in bottom sheet: ${warehouseCount}`);

        if (warehouseCount === 0) {
          console.log('ISSUE: Bottom sheet opened but no participant cards inside');
          // Check for any content
          const sheetBody = page.locator('.gm-bs-body');
          const bodyText = await sheetBody.textContent().catch(() => '');
          console.log(`Sheet body text: ${bodyText?.substring(0, 200)}`);
        }

        // Step 12: Check if participants are visible and tappable
        if (warehouseCount > 0) {
          const firstCard = warehouseCards.first();
          const cardBox = await firstCard.boundingBox();
          if (cardBox) {
            console.log(`First warehouse card size: ${cardBox.width}x${cardBox.height}`);
            if (cardBox.height < 44) {
              console.log('ISSUE: Warehouse card too small for comfortable touch (<44px)');
            }
          }

          // Check eligible vs ineligible styling
          const eligibleCards = page.locator('.gm-bottom-sheet .warehouse-card:not(.warehouse-card-ineligible)');
          const eligibleCount = await eligibleCards.count();
          console.log(`Eligible participants: ${eligibleCount} / ${warehouseCount}`);

          if (eligibleCount === 0) {
            console.log('ISSUE: No eligible participants for this slot');
          }

          // Step 13: Click an eligible participant
          if (eligibleCount > 0) {
            await eligibleCards.first().click();
            await page.waitForTimeout(500);
            await page.screenshot({ path: 'test-results/mobile-manual-09-after-assign.png' });

            // Verify assignment was made
            const assignedCards = page.locator('.assignment-card .participant-name');
            const assignedCount = await assignedCards.count();
            console.log(`Assigned cards after click: ${assignedCount}`);

            // Check toast
            const toast = page.locator('.toast');
            if (await toast.count() > 0) {
              const toastText = await toast.textContent();
              console.log(`Toast message: ${toastText}`);
            }
          }
        }
      } else {
        console.log('ISSUE: Bottom sheet did NOT open after tapping a slot on mobile');
        // Check if warehouse appeared inline instead
        const inlineWarehouse = page.locator('.participant-warehouse');
        const inlineVisible = await inlineWarehouse.isVisible().catch(() => false);
        console.log(`Inline warehouse visible: ${inlineVisible}`);
      }
    } else {
      console.log('ISSUE: No clickable slots found on the page');
    }

    // Step 14: Check day navigation
    const dayNav = page.locator('.day-navigator');
    if (await dayNav.count() > 0) {
      const dayNavBox = await dayNav.boundingBox();
      console.log(`Day navigator box: ${JSON.stringify(dayNavBox)}`);
      await page.screenshot({ path: 'test-results/mobile-manual-10-day-nav.png' });

      // Try navigating to day 2
      const day2Btn = page.locator('.day-btn[data-day="2"]');
      if (await day2Btn.count() > 0) {
        await day2Btn.click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: 'test-results/mobile-manual-11-day2.png' });
      }
    }

    // Step 15: Check undo button
    const undoBtn = page.locator('#btn-manual-undo');
    if (await undoBtn.count() > 0) {
      const undoBox = await undoBtn.boundingBox();
      console.log(`Undo button box: ${JSON.stringify(undoBox)}`);
    }

    // Step 16: Final full-page screenshot
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/mobile-manual-12-final-state.png', fullPage: true });

    // Step 17: Measure total scrollable height
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const viewportHeight = viewport!.height;
    console.log(`Total scroll height: ${scrollHeight}px, viewport: ${viewportHeight}px, ratio: ${(scrollHeight / viewportHeight).toFixed(1)}`);
    if (scrollHeight > viewportHeight * 6) {
      console.log('ISSUE: Page is very long — user needs to scroll >6x viewport to see everything');
    }
  });

  test('toolbar layout and button accessibility on mobile', async ({ page }) => {
    await page.click('.tab-btn[data-tab="schedule"]');
    await page.waitForTimeout(300);

    // Check if toolbar buttons are accessible
    const allBtns = page.locator('.schedule-toolbar button');
    const btnCount = await allBtns.count();
    console.log(`Total toolbar buttons: ${btnCount}`);

    for (let i = 0; i < btnCount; i++) {
      const btn = allBtns.nth(i);
      const box = await btn.boundingBox();
      const text = await btn.textContent();
      if (box) {
        console.log(`Button "${text?.trim()}" — ${box.width.toFixed(0)}x${box.height.toFixed(0)} at (${box.x.toFixed(0)}, ${box.y.toFixed(0)})`);
        if (box.height < 36) {
          console.log(`  ISSUE: Button too short for touch target (${box.height.toFixed(0)}px < 36px)`);
        }
        // Check if button is off-screen
        if (box.x + box.width < 0 || box.x > 375) {
          console.log(`  ISSUE: Button is off-screen horizontally`);
        }
      } else {
        console.log(`Button "${text?.trim()}" — not visible (no bounding box)`);
      }
    }

    await page.screenshot({ path: 'test-results/mobile-manual-toolbar-layout.png' });
  });

  test('second assignment flow — verify repeated interaction', async ({ page }) => {
    // Create manual schedule
    await page.click('.tab-btn[data-tab="schedule"]');
    await page.waitForTimeout(300);

    // Click create manual schedule
    const createBtn = page.locator('#btn-create-manual-empty, #btn-create-manual').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
    } else {
      const btn = page.locator('button', { hasText: 'בנייה ידנית' }).first();
      await btn.click();
    }
    await page.waitForTimeout(1000);

    // Find and click first empty slot
    const emptySlots = page.locator('.manual-slot-empty');
    const slotCount = await emptySlots.count();
    console.log(`Empty slots for second test: ${slotCount}`);

    if (slotCount < 2) {
      console.log('Not enough empty slots for multi-assignment test');
      return;
    }

    // First assignment
    await emptySlots.first().scrollIntoViewIfNeeded();
    await emptySlots.first().click();
    await page.waitForTimeout(500);

    let sheet = page.locator('.gm-bottom-sheet');
    if (await sheet.isVisible().catch(() => false)) {
      const eligible = page.locator('.gm-bottom-sheet .warehouse-card:not(.warehouse-card-ineligible)');
      if (await eligible.count() > 0) {
        await eligible.first().click();
        await page.waitForTimeout(500);
      }
    }

    await page.screenshot({ path: 'test-results/mobile-manual-repeat-01-first-assign.png', fullPage: true });

    // Second assignment — different slot
    const emptySlots2 = page.locator('.manual-slot-empty');
    const newCount = await emptySlots2.count();
    console.log(`Empty slots after first assignment: ${newCount} (was ${slotCount})`);

    if (newCount > 0) {
      await emptySlots2.first().scrollIntoViewIfNeeded();
      await emptySlots2.first().click();
      await page.waitForTimeout(500);

      sheet = page.locator('.gm-bottom-sheet');
      const sheetVisible = await sheet.isVisible().catch(() => false);
      console.log(`Bottom sheet appeared for second slot: ${sheetVisible}`);

      if (sheetVisible) {
        await page.screenshot({ path: 'test-results/mobile-manual-repeat-02-second-sheet.png' });

        const eligible = page.locator('.gm-bottom-sheet .warehouse-card:not(.warehouse-card-ineligible)');
        const eligibleCount = await eligible.count();
        console.log(`Eligible for second slot: ${eligibleCount}`);

        if (eligibleCount > 0) {
          await eligible.first().click();
          await page.waitForTimeout(500);
          await page.screenshot({ path: 'test-results/mobile-manual-repeat-03-second-assign.png', fullPage: true });
        }
      }
    }

    // Check page scroll position wasn't lost between assignments
    const scrollY = await page.evaluate(() => window.scrollY);
    console.log(`Scroll position after assignments: ${scrollY}px`);
    if (scrollY === 0 && newCount > 0) {
      console.log('ISSUE: Page scrolled back to top after assignment — user loses context');
    }
  });
});
