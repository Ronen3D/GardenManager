/**
 * Range Picker Modal — pick a start (day+hour) and end (day+hour) pair.
 *
 * Used by the Future SOS flow to pick the window during which a
 * participant will be unavailable on the loaded schedule. Rendered as a
 * single modal with side-by-side start and end selectors so the user
 * can eyeball validity at a glance.
 */

import { escAttr, escHtml } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

export interface RangePickerOption {
  value: string;
  label: string;
}

export interface RangePickerOptions {
  title?: string;
  days: RangePickerOption[];
  hours: RangePickerOption[];
  defaultStartDay?: string;
  defaultStartHour?: string;
  defaultEndDay?: string;
  defaultEndHour?: string;
  /**
   * Optional validator. Return a Hebrew error message to show inline, or
   * null to accept. Called on every change and on submit.
   */
  validate?: (values: RangePickerResult) => string | null;
}

export interface RangePickerResult {
  startDay: string;
  startHour: string;
  endDay: string;
  endHour: string;
}

export function showRangePicker(message: string, opts: RangePickerOptions): Promise<RangePickerResult | null> {
  return new Promise((resolve) => {
    const title = opts.title || 'בחר טווח זמן';

    const renderOptions = (items: RangePickerOption[], selected?: string) =>
      items
        .map(
          (o) =>
            `<option value="${escAttr(o.value)}"${o.value === selected ? ' selected' : ''}>${escHtml(o.label)}</option>`,
        )
        .join('');

    const startDayHtml = renderOptions(opts.days, opts.defaultStartDay);
    const startHourHtml = renderOptions(opts.hours, opts.defaultStartHour);
    const endDayHtml = renderOptions(opts.days, opts.defaultEndDay ?? opts.defaultStartDay);
    const endHourHtml = renderOptions(opts.hours, opts.defaultEndHour ?? opts.defaultStartHour);

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-range-picker-dialog" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🆘</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${escHtml(message)}</div>
        <div class="gm-range-picker-row">
          <fieldset class="gm-range-picker-side">
            <legend>התחלה</legend>
            <label class="gm-timepicker-label">יום: <select id="gm-rp-start-day" class="gm-timepicker-select">${startDayHtml}</select></label>
            <label class="gm-timepicker-label">שעה: <select id="gm-rp-start-hour" class="gm-timepicker-select">${startHourHtml}</select></label>
          </fieldset>
          <fieldset class="gm-range-picker-side">
            <legend>סיום</legend>
            <label class="gm-timepicker-label">יום: <select id="gm-rp-end-day" class="gm-timepicker-select">${endDayHtml}</select></label>
            <label class="gm-timepicker-label">שעה: <select id="gm-rp-end-hour" class="gm-timepicker-select">${endHourHtml}</select></label>
          </fieldset>
        </div>
        <div class="gm-range-picker-error" id="gm-rp-error" aria-live="polite"></div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok" disabled>אישור</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();

    const close = (val: RangePickerResult | null) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    const sd = backdrop.querySelector('#gm-rp-start-day') as HTMLSelectElement;
    const sh = backdrop.querySelector('#gm-rp-start-hour') as HTMLSelectElement;
    const ed = backdrop.querySelector('#gm-rp-end-day') as HTMLSelectElement;
    const eh = backdrop.querySelector('#gm-rp-end-hour') as HTMLSelectElement;
    const err = backdrop.querySelector('#gm-rp-error') as HTMLElement;
    const okBtn = backdrop.querySelector('.gm-modal-btn-ok') as HTMLButtonElement;

    const readValues = (): RangePickerResult => ({
      startDay: sd.value,
      startHour: sh.value,
      endDay: ed.value,
      endHour: eh.value,
    });

    const runValidate = (): boolean => {
      const values = readValues();
      const msg = opts.validate ? opts.validate(values) : null;
      if (msg) {
        err.textContent = msg;
        err.style.display = 'block';
        okBtn.disabled = true;
        return false;
      }
      err.textContent = '';
      err.style.display = 'none';
      okBtn.disabled = false;
      return true;
    };

    for (const sel of [sd, sh, ed, eh]) {
      sel.addEventListener('change', runValidate);
    }
    runValidate();

    okBtn.addEventListener('click', () => {
      if (runValidate()) close(readValues());
    });
    backdrop.querySelector('.gm-modal-btn-cancel')?.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(null);
      }
      if (e.key === 'Enter') {
        if (runValidate()) {
          document.removeEventListener('keydown', onKey);
          close(readValues());
        }
      }
    });

    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}
