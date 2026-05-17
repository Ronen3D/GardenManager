import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * Mobile config CRUD + emergency-flow coverage (phone 375×812).
 *
 * C7.2  Free-text XSS / overflow escaping + maxlength (participant editor)
 * C7.3  Create a task template end-to-end + edit a slot; generation uses it
 * C7.4  Participant editor sheet edit/save round-trip + survives reload
 * C7.5  Future SOS full flow (range picker → confirm → plans → commit)
 * C7.6  Inject / BALTAM emergency-task flow in Live Mode
 *
 * All tests run on the phone project only — mobile is the dominant platform.
 */

const PARTICIPANT_ROWS = '.table-participants tbody tr[data-participant-id]';

async function freshSeed(page: Page): Promise<void> {
  // Generous timeouts: this spec runs 5 heavy (schedule-generating) tests
  // back-to-back against the Vite dev server, so a cold reload after the
  // previous test can be slow — not a product defect.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-nav', { timeout: 45_000 });
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-nav', { timeout: 45_000 });
}

async function generateSchedule(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const input = page.locator('#input-scenarios');
  if ((await input.count()) > 0) await input.fill('1');
  await page.click('#btn-generate');
  // Generation finishes when the button is re-enabled and no longer shows the
  // optimizing label, and at least one assignment cell has rendered.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('#btn-generate') as HTMLButtonElement | null;
      return !!btn && !btn.disabled && !btn.textContent?.includes('מייעל');
    },
    { timeout: 90_000 },
  );
  await page.waitForSelector('.participant-hover[data-pid], [data-pid]', { state: 'attached', timeout: 90_000 });
  await page.waitForTimeout(400);
}

async function openFirstProfile(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const first = page.locator('.participant-hover[data-pid]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  // On touch/mobile, tapping a participant opens a bottom-sheet quick card
  // first; the profile is reached via its "📋 צפה בפרופיל" button.
  const gotoProfile = page.locator('[data-action="goto-profile"][data-pid]').first();
  if (await gotoProfile.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await gotoProfile.click();
  }
  await page.waitForSelector('.profile-view-root', { timeout: 8_000 });
}

async function enableLiveMode(page: Page): Promise<void> {
  await page.click('.tab-btn[data-tab="schedule"]');
  const chk = page.locator('#chk-live-mode');
  await expect(chk).toHaveCount(1, { timeout: 8_000 });
  if (!(await chk.isChecked())) {
    await chk.click();
    await page.waitForTimeout(300);
  }
  await expect(chk).toBeChecked();
}

test.describe('Mobile config CRUD + emergency flows (phone)', () => {
  test.beforeEach(async ({ page, viewport }) => {
    if (!viewport || viewport.width > 500) test.skip();
    await freshSeed(page);
  });

  // ── C7.2 — Free-text XSS / overflow escaping + maxlength ──────────────────
  test('C7.2 participant name free-text is escaped on render and maxlength enforced', async ({ page }) => {
    // Any script/alert firing from injected markup must fail the test.
    let dialogFired = false;
    page.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });

    await page.click('.tab-btn[data-tab="participants"]');
    await page.click('[data-action="add-participant"]');
    const sheet = page.locator('.gm-edit-sheet-v2');
    await expect(sheet).toBeVisible();

    const nameInput = sheet.locator('[data-pe-field="name"]');
    // maxlength is the product invariant (MAX_PARTICIPANT_NAME_LENGTH = 30).
    await expect(nameInput).toHaveAttribute('maxlength', '30');

    // Overflow: typed input must be clamped to 30 chars by the browser.
    await nameInput.click();
    await nameInput.pressSequentially('x'.repeat(60), { delay: 0 });
    expect((await nameInput.inputValue()).length).toBe(30);

    // XSS payload that fits within 30 chars so it is stored verbatim and the
    // escaping (not the truncation) is what's under test.
    const payload = '<img src=x onerror=alert(1)>'; // 28 chars
    await nameInput.fill('');
    await nameInput.fill(payload);

    // Pick an existing seeded group so the create can be confirmed.
    const groupSelect = sheet.locator('[data-pe-field="group"]');
    const firstGroupValue = await groupSelect
      .locator('option')
      .first()
      .getAttribute('value');
    await groupSelect.selectOption(firstGroupValue ?? { index: 0 });

    await sheet.locator('[data-pe-save]').first().click();
    await expect(sheet).toHaveCount(0);

    // The payload must render as inert text, never as a live element.
    await expect(page.locator('img[onerror]')).toHaveCount(0);
    expect(dialogFired).toBe(false);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__xssPwned)).toBeUndefined();

    // The new row shows the literal, escaped payload string as its name.
    const injectedRow = page.locator(`${PARTICIPANT_ROWS} .col-name`, { hasText: payload });
    await expect(injectedRow.first()).toBeVisible();
    // Stored name length respects the 30-char cap.
    const storedName = (await injectedRow.first().innerText()).trim();
    expect(storedName.length).toBeLessThanOrEqual(30);
  });

  // ── C7.3 — Task template create + slot edit; generation uses it ───────────
  test('C7.3 create a task template + edit its slot, then generation produces its task', async ({ page }) => {
    const TPL = `בדיקתQA${Date.now() % 100000}`;

    await page.click('.tab-btn[data-tab="task-rules"]');
    await page.click('[data-action="toggle-add-template"]');
    const modal = page.locator('#add-template-modal-backdrop');
    await expect(modal).toBeVisible();
    await modal.locator('[data-field="tpl-name"]').fill(TPL);
    await modal.locator('[data-action="confirm"]').click();
    await expect(modal).toHaveCount(0);

    // Card appears for the new template.
    const card = page.locator('.template-card', {
      has: page.locator('.template-title strong', { hasText: TPL }),
    });
    await expect(card).toHaveCount(1);

    // Expand it and add a slot (defaults: all 4 levels acceptable, no certs).
    // The task-rules tab re-renders + recomputes preflight over every template
    // on each action, so allow generous time for the inline form to appear.
    await card.locator('.template-header').click();
    await card.locator('[data-action="add-slot"]').first().click();
    // `.add-slot-form` is also reused by the load-window add form
    // (`.lw-add-form.add-slot-form`); disambiguate by the confirm action.
    const addForm = card.locator('.add-slot-form', {
      has: page.locator('[data-action="confirm-add-slot"]'),
    });
    await expect(addForm).toBeVisible({ timeout: 20_000 });
    // A non-empty label is required by readSlotFormFields, otherwise the slot
    // is silently not added.
    await addForm.locator('[data-field="slot-label"]').fill('QA');
    await addForm.locator('[data-action="confirm-add-slot"]').click();

    // The slot now exists; open it for editing.
    const slotsTable = card.locator('.table-slots');
    await expect(slotsTable.locator('tbody tr')).toHaveCount(1, { timeout: 20_000 });
    await card.locator('[data-action="edit-slot"]').first().click();
    const editForm = page.locator('.edit-slot-form');
    await expect(editForm.first()).toBeVisible({ timeout: 20_000 });
    const form = editForm.first();

    // acceptableLevels / lowPriority: L0 → lowPriority (1 cycle), L2 → off
    // (2 cycles), keep L3 & L4 normal. cycle order: normal→lowPriority→off.
    await form.locator('[data-action="cycle-level"][data-slot-level="0"]').click();
    const l2 = form.locator('[data-action="cycle-level"][data-slot-level="2"]');
    await l2.click();
    await l2.click();
    // Required + forbidden certs (distinct ids — overlap is rejected).
    await form.locator('[data-slot-cert="Hamama"]').check();
    await form.locator('[data-slot-forbidden-cert="Horesh"]').check();
    await form.locator('[data-action="confirm-edit-slot"]').click();

    // Slot row reflects the HC-eligibility-shaping edits. The task-rules tab
    // renders level badges as bare level numbers (0/2/3/4), with a separate
    // .lp-badge ⚠ sup for low-priority.
    const slotRow = card.locator('.table-slots tbody tr').first();
    const levelsCell = slotRow.locator('td').nth(1);
    await expect(levelsCell.locator('.badge')).toHaveText(['0', '3', '4']); // L2 dropped
    await expect(levelsCell.locator('.lp-badge')).toHaveCount(1); // L0 marked low-priority
    await expect(slotRow.locator('td').nth(2)).toContainText('חממה'); // required cert
    await expect(slotRow.locator('td').nth(3)).toContainText('חורש'); // forbidden cert

    // Generation must actually use the new template — its source chip appears.
    await generateSchedule(page);
    await expect(page.locator(`[data-source-name="${TPL}"]`).first()).toBeVisible({ timeout: 10_000 });
  });

  // ── C7.4 — Participant editor round-trip + survives reload ────────────────
  test('C7.4 participant editor edit/save round-trips on the card and survives reload', async ({ page }) => {
    await page.click('.tab-btn[data-tab="participants"]');
    const firstRow = page.locator(PARTICIPANT_ROWS).first();
    await expect(firstRow).toBeVisible();
    const pid = await firstRow.getAttribute('data-participant-id');
    expect(pid).toBeTruthy();
    const rowSel = `${PARTICIPANT_ROWS}[data-participant-id="${pid}"]`;

    const currentLevelText = (await page.locator(`${rowSel} .col-level .badge`).first().innerText()).trim();
    const targetLevel = currentLevelText.includes('4') ? '0' : '4';
    const targetLevelText = `דרגה ${targetLevel}`;

    await page.click(`[data-action="edit-participant"][data-pid="${pid}"]`);
    const sheet = page.locator('.gm-edit-sheet-v2');
    await expect(sheet).toBeVisible();

    // Change level.
    await sheet.locator(`[data-pe-level="${targetLevel}"]`).click();

    // Change group to a *different* existing group.
    const groupSelect = sheet.locator('[data-pe-field="group"]');
    const currentGroup = await groupSelect.inputValue();
    const otherGroup = await groupSelect.evaluate((el, cur) => {
      const opts = Array.from((el as HTMLSelectElement).options)
        .map((o) => o.value)
        .filter((v) => v !== '__new__' && v !== cur);
      return opts[0] ?? null;
    }, currentGroup);
    expect(otherGroup).toBeTruthy();
    await groupSelect.selectOption(otherGroup as string);

    // Force a certification on.
    await sheet.locator('[data-pe-cert="Horesh"]').setChecked(true);

    await sheet.locator('[data-pe-save]').first().click();
    await expect(sheet).toHaveCount(0);

    // Persisted on the card immediately.
    await expect(page.locator(`${rowSel} .col-level`)).toContainText(targetLevelText);
    await expect(page.locator(`${rowSel} .col-group`)).toContainText(otherGroup as string);
    await expect(page.locator(`${rowSel} .col-certs`)).toContainText('חורש');

    // Survives a reload (localStorage round-trip — no clear()).
    await page.reload();
    await page.waitForSelector('.tab-nav');
    await page.click('.tab-btn[data-tab="participants"]');
    await expect(page.locator(`${rowSel} .col-level`)).toContainText(targetLevelText);
    await expect(page.locator(`${rowSel} .col-group`)).toContainText(otherGroup as string);
    await expect(page.locator(`${rowSel} .col-certs`)).toContainText('חורש');
  });

  // ── C7.5 — Future SOS full flow ──────────────────────────────────────────
  test('C7.5 Future SOS: range picker → confirm → plans → commit changes the schedule', async ({ page }) => {
    test.setTimeout(150_000);
    await generateSchedule(page);
    await openFirstProfile(page);

    const fsosBtn = page.locator('.btn-future-sos');
    await expect(fsosBtn).toBeVisible();
    await fsosBtn.click();

    // Range picker with the engine's smart-default window pre-filled.
    const rangePicker = page.locator('.gm-range-picker-v2');
    await expect(rangePicker).toBeVisible({ timeout: 8_000 });
    const okBtn = rangePicker.locator('.gm-modal-btn-ok');
    // Smart defaults should validate; if not, widen to the last day so a
    // non-empty future window definitely exists.
    if (await okBtn.isDisabled()) {
      const endChips = rangePicker.locator('.gm-range-picker-day-chips[data-side="end"] .gm-range-picker-chip');
      await endChips.last().click();
    }
    await expect(okBtn).toBeEnabled({ timeout: 5_000 });
    await okBtn.click();

    // An optional overlap warning (seeded participants can carry date rules)
    // may appear before the FSOS confirm sheet — proceed through it.
    const overlap = page.locator('.gm-modal-dialog[role="alertdialog"]');
    if (await overlap.isVisible().catch(() => false)) {
      await overlap.locator('.gm-modal-btn-ok').click();
    }

    // Confirmation sheet (per-assignment opt-out).
    const confirmSheet = page.locator('.fsos-confirm-v2');
    await expect(confirmSheet).toBeVisible({ timeout: 8_000 });
    await confirmSheet.locator('.fsos-confirm-btn').click();

    // Plans modal (touch carousel). Assert a real plan list, then commit.
    const plansModal = page.locator('.fsos-plans-v2');
    await expect(plansModal).toBeVisible({ timeout: 30_000 });
    const planCards = plansModal.locator('.fsos-plan-card');
    await expect(planCards.first()).toBeVisible();
    const applyBtn = plansModal.locator('.fsos-apply-btn').first();
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();

    // Commit applied → schedule changed (swaps applied + persisted).
    const strip = page.locator('.fsos-applied-strip');
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText('הוחלה תוכנית');
    const stripText = await strip.innerText();
    const m = stripText.match(/עם\s*(\d+)\s*החלפות/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  // ── C7.6 — Inject / BALTAM in Live Mode ──────────────────────────────────
  test('C7.6 Inject emergency task in Live Mode appears in the schedule after commit', async ({ page }) => {
    test.setTimeout(150_000);
    await generateSchedule(page);
    await enableLiveMode(page);

    const injectBtn = page.locator('#btn-inject-task');
    await expect(injectBtn).toBeVisible({ timeout: 8_000 });
    await injectBtn.click();

    const modal = page.locator('#inject-modal-backdrop');
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const OT = `חירוםQA${Date.now() % 100000}`;
    await modal.locator('[data-inj="name"]').fill(OT);
    // Default draft already has one slot accepting all levels with no certs —
    // broadly staffable. Run the plan search.
    await modal.locator('#btn-inject-run').click();

    // Plans phase: a confirm button appears once a fillable plan is found.
    const confirmBtn = modal.locator('#btn-inject-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
    await expect(confirmBtn).toBeEnabled({ timeout: 10_000 });
    await confirmBtn.click();
    await expect(modal).toHaveCount(0);

    // The injected task is now part of the schedule snapshot.
    await page.click('.tab-btn[data-tab="schedule"]');
    await expect(page.locator(`[data-source-name="${OT}"]`).first()).toBeVisible({ timeout: 10_000 });
  });
});
