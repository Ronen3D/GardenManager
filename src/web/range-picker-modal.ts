/**
 * Range Picker Modal — pick a start (day+hour) and end (day+hour) pair.
 *
 * Used by the Future SOS flow to pick the window during which a
 * participant will be unavailable on the loaded schedule.
 *
 * Layout (v2): quick-preset chip row, start/end day-chip rows, compact
 * hour selects with an explicit separator, optional anchor banner (shown
 * when live mode is off), and a live preview line that updates as the
 * user changes the selection. Renders as a bottom sheet on touch devices
 * and as a centered dialog elsewhere — the sheet styling is in
 * style.css under `.touch-device .gm-modal-dialog`.
 */

import { escAttr, escHtml } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

export interface RangePickerOption {
  value: string;
  label: string;
}

export interface RangePickerPreset {
  id: string;
  label: string;
  /** Returns the new values to apply, or null if this preset is not available (button shown disabled). */
  apply: (current: RangePickerResult) => RangePickerResult | null;
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
  /** Optional quick-preset chips shown above the day/hour controls. */
  presets?: RangePickerPreset[];
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
}

export function showRangePicker(message: string, opts: RangePickerOptions): Promise<RangePickerResult | null> {
  return new Promise((resolve) => {
    const title = opts.title || 'בחר טווח זמן';

    const defaultStart: RangePickerResult = {
      startDay: opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      startHour: opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
      endDay: opts.defaultEndDay ?? opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      endHour: opts.defaultEndHour ?? opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
    };

    const presetsHtml = renderPresets(opts.presets);
    const anchorHtml = renderAnchor(opts.anchor);
    const dayChipsStart = renderDayChips(opts.days, defaultStart.startDay, 'start');
    const dayChipsEnd = renderDayChips(opts.days, defaultStart.endDay, 'end');
    const hoursStart = renderHourOptions(opts.hours, defaultStart.startHour);
    const hoursEnd = renderHourOptions(opts.hours, defaultStart.endHour);

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-range-picker-dialog gm-range-picker-v2" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🆘</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${escHtml(message)}</div>
        ${anchorHtml}
        ${presetsHtml}
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">מתחיל ב־</div>
          <div class="gm-range-picker-day-chips" data-side="start">${dayChipsStart}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="gm-rp-start-hour" class="gm-timepicker-select">${hoursStart}</select>
          </div>
        </div>
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">מסתיים ב־</div>
          <div class="gm-range-picker-day-chips" data-side="end">${dayChipsEnd}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="gm-rp-end-hour" class="gm-timepicker-select">${hoursEnd}</select>
          </div>
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

    backdrop.querySelectorAll<HTMLButtonElement>('.gm-range-picker-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.presetId;
        const preset = (opts.presets ?? []).find((p) => p.id === id);
        if (!preset) return;
        const next = preset.apply({ ...state });
        if (!next) return;
        state.startDay = next.startDay;
        state.startHour = next.startHour;
        state.endDay = next.endDay;
        state.endHour = next.endHour;
        sh.value = state.startHour;
        eh.value = state.endHour;
        refreshChipClasses('start');
        refreshChipClasses('end');
        runValidate();
      });
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

    okBtn.addEventListener('click', () => {
      if (runValidate()) close({ ...state });
    });
    backdrop.querySelector('.gm-modal-btn-cancel')?.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter') {
        if (runValidate()) close({ ...state });
      }
    }
    document.addEventListener('keydown', onKey);

    refreshChipClasses('start');
    refreshChipClasses('end');
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

function renderDayChips(days: RangePickerOption[], selected: string, side: 'start' | 'end'): string {
  void side;
  return days
    .map(
      (d) =>
        `<button type="button" class="gm-range-picker-chip${d.value === selected ? ' gm-range-picker-chip--active' : ''}" data-value="${escAttr(d.value)}" aria-pressed="${d.value === selected ? 'true' : 'false'}">${escHtml(d.label)}</button>`,
    )
    .join('');
}

function renderPresets(presets?: RangePickerPreset[]): string {
  if (!presets || presets.length === 0) return '';
  const chips = presets
    .map(
      (p) =>
        `<button type="button" class="gm-range-picker-preset" data-preset-id="${escAttr(p.id)}">${escHtml(p.label)}</button>`,
    )
    .join('');
  return `<div class="gm-range-picker-presets" role="group" aria-label="קיצורים">${chips}</div>`;
}

function renderAnchor(anchor?: RangePickerAnchor): string {
  if (!anchor) return '';
  return `<div class="gm-range-picker-anchor">
    <span class="gm-range-picker-anchor-label">נקודת הקפאה:</span>
    <span class="gm-range-picker-anchor-value">${escHtml(anchor.currentLabel)}</span>
    <button type="button" class="gm-range-picker-anchor-btn">${escHtml(anchor.changeButtonLabel)}</button>
  </div>`;
}
