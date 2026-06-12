import { expect, test } from '@playwright/test';

/**
 * Regression: range-picker out-of-range default hour must not desync `state`
 * from the rendered <select>.
 *
 * Editing an all-day unavailability rule passes defaultEndHour:"24" into a picker
 * whose hour options are only 0..23. The browser falls back to the first option
 * (00:00); the modal must reconcile its internal state to that shown value instead
 * of silently keeping "24". Pre-fix symptoms this guards against:
 *   - unchecking "all day" left OK enabled on a degenerate 00:00→00:00 pick
 *     (the equal-hours validator was defeated by state.endHour staying "24");
 *   - the preview line disagreed with the select (showed 00:00–24:00);
 *   - confirming persisted endHour:24 — a value the user never saw.
 *
 * Drives showRangePicker directly (no editor navigation): the module is served by
 * the Vite dev server, so it can be imported inside page.evaluate. Viewport-agnostic.
 */

test('all-day edit: picker state mirrors the rendered select (no endHour:24 desync)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab-nav', { timeout: 45_000 });

  // Open the picker with the exact options openUnavailPicker() produces when
  // editing an existing all-day rule (stored startHour:0, endHour:24). Stash the
  // returned promise on window so locators can drive the modal to resolution.
  await page.evaluate(async () => {
    const mod = await import('/src/web/range-picker-modal.ts');
    const days = Array.from({ length: 7 }, (_, i) => ({ value: String(i + 1), label: `יום ${i + 1}` }));
    const hours = Array.from({ length: 24 }, (_, i) => ({
      value: String(i),
      label: `${String(i).padStart(2, '0')}:00`,
    }));
    // biome-ignore lint/suspicious/noExplicitAny: test stash on window
    (window as any).__rp = mod.showRangePicker({
      title: 'edit',
      iconOverride: '🚫',
      days,
      hours,
      defaultStartDay: '1',
      defaultStartHour: '0',
      defaultEndDay: '1',
      defaultEndHour: '24',
      allowAllDay: true,
      defaultAllDay: true,
      dayStartHour: 5,
      // Mirrors participant-editor's validator: same-day equal hours is rejected.
      validate: (v) => {
        const ds = parseInt(v.startDay, 10);
        const de = parseInt(v.endDay, 10);
        if (de < ds) return 'יום סיום חייב להיות גדול או שווה ליום ההתחלה.';
        if (!v.allDay) {
          const sh = parseInt(v.startHour, 10);
          const eh = parseInt(v.endHour, 10);
          if (ds === de && sh === eh) return 'שעת התחלה ושעת סיום לא יכולות להיות זהות באותו יום.';
        }
        return null;
      },
      onPreview: (v) => {
        if (v.allDay) return 'כל היום';
        const sh = parseInt(v.startHour, 10);
        const eh = parseInt(v.endHour, 10);
        return `${String(sh).padStart(2, '0')}:00-${String(eh).padStart(2, '0')}:00`;
      },
    });
  });

  await page.waitForSelector('#gm-rp-end-hour');

  // 1) Synced on open: the end select shows a real option (00:00) and there is no
  //    out-of-range "24" option to begin with.
  await expect(page.locator('#gm-rp-end-hour')).toHaveValue('0');
  expect(await page.locator('#gm-rp-end-hour option[value="24"]').count()).toBe(0);

  // 2) Validator restored: unchecking "all day" must leave state at the shown 00:00
  //    (not "24"), so the equal-hours guard fires — OK disabled, error shown, and
  //    the preview mirrors the select (00:00-00:00, NOT 00:00-24:00).
  await page.locator('#gm-rp-allday').uncheck();
  await expect(page.locator('.gm-modal-btn-ok')).toBeDisabled();
  await expect(page.locator('#gm-rp-error')).not.toHaveText('');
  await expect(page.locator('#gm-rp-preview')).toHaveText('00:00-00:00');

  // 3) No desync on confirm: pick a real end hour, confirm, and the resolved result
  //    must carry exactly the visible select value.
  await page.locator('#gm-rp-end-hour').selectOption('14');
  await expect(page.locator('.gm-modal-btn-ok')).toBeEnabled();
  await page.locator('.gm-modal-btn-ok').click();

  // biome-ignore lint/suspicious/noExplicitAny: test stash on window
  const result = await page.evaluate(() => (window as any).__rp);
  expect(result).toMatchObject({ endHour: '14', allDay: false });
});
