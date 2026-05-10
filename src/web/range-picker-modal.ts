/**
 * Range Picker Modal — pick a start (day+hour) and end (day+hour) pair.
 *
 * Used by:
 *  - Future SOS, to pick the window during which a participant will be
 *    unavailable on the loaded schedule (mode: 'absolute', the default).
 *  - The unified participant editor, to add or edit a recurring
 *    DateUnavailability rule (mode: 'recurring', `allowAllDay` enabled).
 *
 * Layout: optional anchor banner, start/end day-chip rows, compact hour
 * selects, optional "all day" toggle, optional Hebrew boundary note when
 * a chosen hour falls inside the operational-day's post-midnight tail,
 * a live preview line, and validation error. Renders as a bottom sheet
 * on small screens via `.gm-range-picker-v2` mobile CSS.
 */

import { escAttr, escHtml } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

export interface RangePickerOption {
  value: string;
  label: string;
}

export interface RangePickerAnchor {
  /** Current anchor label, e.g. "יום ראשון 05:00". Shown read-only in the banner. */
  currentLabel: string;
  /** Action button text. Opens a secondary time picker (provided by caller). */
  changeButtonLabel: string;
  /** Invoked when the user taps the change button. Should return the new anchor timestamp and label, or null on cancel. */
  onChange: () => Promise<{ label: string } | null>;
}

export interface RangePickerOptions {
  title?: string;
  /** Header icon. Defaults to '🆘'. Set to '🚫' for recurring rules, or '' to omit. */
  iconOverride?: string;
  days: RangePickerOption[];
  hours: RangePickerOption[];
  defaultStartDay?: string;
  defaultStartHour?: string;
  defaultEndDay?: string;
  defaultEndHour?: string;
  defaultReason?: string;
  /** When true, render an "all day" checkbox; checking it disables hour selects. */
  allowAllDay?: boolean;
  /** Initial state of the all-day toggle. Ignored when `allowAllDay` is false. */
  defaultAllDay?: boolean;
  /**
   * The operational-day boundary hour. When set, a Hebrew note appears under
   * any hour input whose numeric value is < `dayStartHour`, since those hours
   * fall on the post-midnight tail of the previous calendar day.
   * Hour values must be parseable integers (the picker reads `parseInt(value)`).
   */
  dayStartHour?: number;
  /**
   * Optional validator. Return a Hebrew error message to show inline, or
   * null to accept. Called on every change and on submit.
   */
  validate?: (values: RangePickerResult) => string | null;
  /** Called on every change. Return a Hebrew string to show as a live preview. */
  onPreview?: (values: RangePickerResult) => string;
  /** Optional anchor banner, shown when live mode needs to be activated inline. */
  anchor?: RangePickerAnchor;
}

export interface RangePickerResult {
  startDay: string;
  startHour: string;
  endDay: string;
  endHour: string;
  /** True when the all-day toggle is checked. Always present; defaults to false. */
  allDay: boolean;
  /** Free-text note. Empty/whitespace is normalized to undefined by the modal. */
  reason?: string;
}

export function showRangePicker(opts: RangePickerOptions): Promise<RangePickerResult | null> {
  return new Promise((resolve) => {
    const title = opts.title || 'בחר טווח זמן';
    const icon = opts.iconOverride ?? '🆘';

    const defaultStart: RangePickerResult = {
      startDay: opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      startHour: opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
      endDay: opts.defaultEndDay ?? opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      endHour: opts.defaultEndHour ?? opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
      allDay: opts.allowAllDay ? (opts.defaultAllDay ?? false) : false,
      reason: opts.defaultReason,
    };

    const anchorHtml = renderAnchor(opts.anchor);
    const dayChipsStart = renderDayChips(opts.days, defaultStart.startDay);
    const dayChipsEnd = renderDayChips(opts.days, defaultStart.endDay);
    const hoursStart = renderHourOptions(opts.hours, defaultStart.startHour);
    const hoursEnd = renderHourOptions(opts.hours, defaultStart.endHour);
    const allDayHtml = opts.allowAllDay
      ? `<label class="gm-range-picker-allday">
          <input type="checkbox" id="gm-rp-allday" ${defaultStart.allDay ? 'checked' : ''} />
          <span>כל היום</span>
        </label>`
      : '';
    const headerHtml = icon
      ? `<div class="gm-modal-header">
          <span class="gm-modal-icon">${escHtml(icon)}</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>`
      : `<div class="gm-modal-header">
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>`;

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-range-picker-dialog gm-range-picker-v2" role="dialog" aria-modal="true">
        ${headerHtml}
        ${anchorHtml}
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">מתחיל ב־</div>
          <div class="gm-range-picker-day-chips" data-side="start">${dayChipsStart}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="gm-rp-start-hour" class="gm-timepicker-select">${hoursStart}</select>
            <span class="gm-range-picker-boundary-note" id="gm-rp-start-note" aria-live="polite"></span>
          </div>
        </div>
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">מסתיים ב־</div>
          <div class="gm-range-picker-day-chips" data-side="end">${dayChipsEnd}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="gm-rp-end-hour" class="gm-timepicker-select">${hoursEnd}</select>
            <span class="gm-range-picker-boundary-note" id="gm-rp-end-note" aria-live="polite"></span>
          </div>
        </div>
        ${allDayHtml ? `<div class="gm-range-picker-v2-section">${allDayHtml}</div>` : ''}
        <div class="gm-range-picker-v2-section">
          <label for="gm-rp-reason" class="gm-range-picker-v2-label">סיבה</label>
          <input id="gm-rp-reason" class="input-sm gm-range-picker-reason-input" type="text"
                 maxlength="80" autocomplete="off"
                 placeholder="למשל: מילואים, חופש, מחלה (אופציונלי)"
                 value="${escAttr(defaultStart.reason ?? '')}" />
        </div>
        <div class="gm-range-picker-preview" id="gm-rp-preview" aria-live="polite"></div>
        <div class="gm-range-picker-error" id="gm-rp-error" aria-live="polite"></div>
        <div class="gm-modal-actions gm-range-picker-actions">
          <button class="btn-primary gm-modal-btn-ok" disabled>אישור</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();

    const close = (val: RangePickerResult | null) => {
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const state: RangePickerResult = { ...defaultStart };

    const sh = backdrop.querySelector('#gm-rp-start-hour') as HTMLSelectElement;
    const eh = backdrop.querySelector('#gm-rp-end-hour') as HTMLSelectElement;
    const allDayCb = backdrop.querySelector('#gm-rp-allday') as HTMLInputElement | null;
    const startNote = backdrop.querySelector('#gm-rp-start-note') as HTMLElement;
    const endNote = backdrop.querySelector('#gm-rp-end-note') as HTMLElement;
    const reasonInput = backdrop.querySelector('#gm-rp-reason') as HTMLInputElement;
    const err = backdrop.querySelector('#gm-rp-error') as HTMLElement;
    const preview = backdrop.querySelector('#gm-rp-preview') as HTMLElement;
    const okBtn = backdrop.querySelector('.gm-modal-btn-ok') as HTMLButtonElement;
    const anchorLabelEl = backdrop.querySelector('.gm-range-picker-anchor-value') as HTMLElement | null;

    const refreshChipClasses = (side: 'start' | 'end') => {
      const selected = side === 'start' ? state.startDay : state.endDay;
      backdrop
        .querySelectorAll<HTMLButtonElement>(`.gm-range-picker-day-chips[data-side="${side}"] .gm-range-picker-chip`)
        .forEach((chip) => {
          const active = chip.dataset.value === selected;
          chip.classList.toggle('gm-range-picker-chip--active', active);
          chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    };

    const refreshAllDayUi = () => {
      // Disable hour selects when "all day" is on. We keep the underlying
      // values in `state` so toggling off restores the user's prior pick.
      sh.disabled = state.allDay;
      eh.disabled = state.allDay;
      const startHourRow = sh.closest('.gm-range-picker-hour-row') as HTMLElement | null;
      const endHourRow = eh.closest('.gm-range-picker-hour-row') as HTMLElement | null;
      startHourRow?.classList.toggle('gm-range-picker-hour-row--disabled', state.allDay);
      endHourRow?.classList.toggle('gm-range-picker-hour-row--disabled', state.allDay);
    };

    const refreshBoundaryNotes = () => {
      const dsh = opts.dayStartHour;
      if (dsh === undefined) return;
      const note = 'ⓘ שעה זו נמצאת אחרי חצות של היום הקודם';
      const showStart = !state.allDay && parseInt(state.startHour, 10) < dsh;
      const showEnd = !state.allDay && parseInt(state.endHour, 10) < dsh;
      startNote.textContent = showStart ? note : '';
      endNote.textContent = showEnd ? note : '';
    };

    const runValidate = (): boolean => {
      const msg = opts.validate ? opts.validate(state) : null;
      if (msg) {
        err.textContent = msg;
        err.style.display = 'block';
        okBtn.disabled = true;
      } else {
        err.textContent = '';
        err.style.display = 'none';
        okBtn.disabled = false;
      }
      if (opts.onPreview) {
        const text = opts.onPreview(state);
        preview.textContent = text;
        preview.style.display = text ? 'block' : 'none';
      }
      refreshBoundaryNotes();
      return !msg;
    };

    backdrop.querySelectorAll<HTMLButtonElement>('.gm-range-picker-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const side = (chip.closest('.gm-range-picker-day-chips') as HTMLElement | null)?.dataset.side;
        if (side !== 'start' && side !== 'end') return;
        const val = chip.dataset.value ?? '';
        if (side === 'start') state.startDay = val;
        else state.endDay = val;
        refreshChipClasses(side);
        runValidate();
      });
    });

    sh.addEventListener('change', () => {
      state.startHour = sh.value;
      runValidate();
    });
    eh.addEventListener('change', () => {
      state.endHour = eh.value;
      runValidate();
    });
    if (allDayCb) {
      allDayCb.addEventListener('change', () => {
        state.allDay = allDayCb.checked;
        refreshAllDayUi();
        runValidate();
      });
    }
    reasonInput.addEventListener('input', () => {
      state.reason = reasonInput.value;
    });

    const anchorBtn = backdrop.querySelector('.gm-range-picker-anchor-btn') as HTMLButtonElement | null;
    if (anchorBtn && opts.anchor) {
      anchorBtn.addEventListener('click', async () => {
        const res = await opts.anchor!.onChange();
        if (res && anchorLabelEl) {
          anchorLabelEl.textContent = res.label;
          runValidate();
        }
      });
    }

    const buildResult = (): RangePickerResult => {
      const trimmed = (state.reason ?? '').trim();
      return { ...state, reason: trimmed === '' ? undefined : trimmed };
    };

    okBtn.addEventListener('click', () => {
      if (runValidate()) close(buildResult());
    });
    backdrop.querySelector('.gm-modal-btn-cancel')?.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter') {
        if (runValidate()) close(buildResult());
      }
    }
    document.addEventListener('keydown', onKey);

    refreshChipClasses('start');
    refreshChipClasses('end');
    refreshAllDayUi();
    runValidate();

    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}

function renderHourOptions(hours: RangePickerOption[], selected: string): string {
  return hours
    .map(
      (o) =>
        `<option value="${escAttr(o.value)}"${o.value === selected ? ' selected' : ''}>${escHtml(o.label)}</option>`,
    )
    .join('');
}

function renderDayChips(days: RangePickerOption[], selected: string): string {
  return days
    .map(
      (d) =>
        `<button type="button" class="gm-range-picker-chip${d.value === selected ? ' gm-range-picker-chip--active' : ''}" data-value="${escAttr(d.value)}" aria-pressed="${d.value === selected ? 'true' : 'false'}">${escHtml(d.label)}</button>`,
    )
    .join('');
}

function renderAnchor(anchor?: RangePickerAnchor): string {
  if (!anchor) return '';
  return `<div class="gm-range-picker-anchor">
    <span class="gm-range-picker-anchor-label">נקודת הקפאה:</span>
    <span class="gm-range-picker-anchor-value">${escHtml(anchor.currentLabel)}</span>
    <button type="button" class="gm-range-picker-anchor-btn">${escHtml(anchor.changeButtonLabel)}</button>
  </div>`;
}
