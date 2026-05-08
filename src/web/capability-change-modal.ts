/**
 * Capability Change Modal — picker UI for mid-schedule certification loss.
 *
 * One combined picker that collects (1) which certs the participant has lost,
 * (2) the effective window (day + hour for start and end), and (3) an optional
 * reason. The downstream confirm / batch-plans / infeasible flows are reused
 * verbatim from `future-sos-modal.ts` (with header overrides) — only the
 * input collection is unique to this feature.
 */

import { escAttr, escHtml } from './ui-helpers';
import { lockBodyScroll, unlockBodyScroll } from './ui-modal';

export interface CapabilityChangePickerCertOption {
  /** Cert ID as stored on `participant.certifications`. */
  value: string;
  /** Human-friendly label resolved via `engine.getCertLabelResolver()`. */
  label: string;
}

export interface CapabilityChangePickerDayOption {
  value: string;
  label: string;
}

export interface CapabilityChangePickerHourOption {
  value: string;
  label: string;
}

export interface CapabilityChangePickerOptions {
  participantName: string;
  /** Certs the participant currently holds. Must be non-empty. */
  availableCerts: CapabilityChangePickerCertOption[];
  /** Day chips (operational-day indices). */
  days: CapabilityChangePickerDayOption[];
  /** Hour options (0..23). */
  hours: CapabilityChangePickerHourOption[];
  defaultStartDay?: string;
  defaultStartHour?: string;
  defaultEndDay?: string;
  defaultEndHour?: string;
  defaultReason?: string;
  /**
   * Validate a candidate selection. Return a Hebrew error string to display
   * inline, or null to accept. Called on every change and on submit.
   */
  validate?: (values: CapabilityChangePickerResult) => string | null;
  /**
   * Optional preview line, refreshed live as the user changes the selection.
   */
  onPreview?: (values: CapabilityChangePickerResult) => string;
}

export interface CapabilityChangePickerResult {
  lostCertifications: string[];
  startDay: string;
  startHour: string;
  endDay: string;
  endHour: string;
  reason?: string;
}

/**
 * Show the capability-change picker. Resolves with the selected values, or
 * `null` if the user cancelled.
 */
export function showCapabilityChangePicker(
  opts: CapabilityChangePickerOptions,
): Promise<CapabilityChangePickerResult | null> {
  return new Promise((resolve) => {
    if (opts.availableCerts.length === 0) {
      resolve(null);
      return;
    }

    const state: CapabilityChangePickerResult = {
      lostCertifications: [],
      startDay: opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      startHour: opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
      endDay: opts.defaultEndDay ?? opts.defaultStartDay ?? opts.days[0]?.value ?? '',
      endHour: opts.defaultEndHour ?? opts.defaultStartHour ?? opts.hours[0]?.value ?? '',
      reason: opts.defaultReason,
    };

    const certCheckboxes = opts.availableCerts
      .map(
        (c) => `<label class="capch-cert-check">
          <input type="checkbox" class="capch-cert-checkbox" value="${escAttr(c.value)}">
          <span>${escHtml(c.label)}</span>
        </label>`,
      )
      .join('');

    const dayChipsStart = renderDayChips(opts.days, state.startDay);
    const dayChipsEnd = renderDayChips(opts.days, state.endDay);
    const hoursStart = renderHourOptions(opts.hours, state.startHour);
    const hoursEnd = renderHourOptions(opts.hours, state.endHour);

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-range-picker-dialog gm-range-picker-v2 capch-picker-dialog" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">📜</span>
          <span class="gm-modal-title">שינוי הסמכה · ${escHtml(opts.participantName)}</span>
        </div>
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">הסמכות שאבדו</div>
          <div class="capch-cert-list">${certCheckboxes}</div>
        </div>
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">בתוקף מ־</div>
          <div class="gm-range-picker-day-chips" data-side="start">${dayChipsStart}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="capch-start-hour" class="gm-timepicker-select">${hoursStart}</select>
          </div>
        </div>
        <div class="gm-range-picker-v2-section">
          <div class="gm-range-picker-v2-label">עד</div>
          <div class="gm-range-picker-day-chips" data-side="end">${dayChipsEnd}</div>
          <div class="gm-range-picker-hour-row">
            <span class="gm-range-picker-hour-label">שעה</span>
            <select id="capch-end-hour" class="gm-timepicker-select">${hoursEnd}</select>
          </div>
        </div>
        <div class="gm-range-picker-v2-section">
          <label for="capch-reason" class="gm-range-picker-v2-label">סיבה</label>
          <input id="capch-reason" class="input-sm gm-range-picker-reason-input" type="text"
                 maxlength="80" autocomplete="off"
                 placeholder="למשל: פג תוקף, השעיה (אופציונלי)"
                 value="${escAttr(state.reason ?? '')}" />
        </div>
        <div class="gm-range-picker-preview" id="capch-preview" aria-live="polite"></div>
        <div class="gm-range-picker-error" id="capch-error" aria-live="polite"></div>
        <div class="gm-modal-actions gm-range-picker-actions">
          <button class="btn-primary gm-modal-btn-ok" disabled>המשך</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();

    const close = (val: CapabilityChangePickerResult | null) => {
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const sh = backdrop.querySelector('#capch-start-hour') as HTMLSelectElement;
    const eh = backdrop.querySelector('#capch-end-hour') as HTMLSelectElement;
    const reasonInput = backdrop.querySelector('#capch-reason') as HTMLInputElement;
    const err = backdrop.querySelector('#capch-error') as HTMLElement;
    const preview = backdrop.querySelector('#capch-preview') as HTMLElement;
    const okBtn = backdrop.querySelector('.gm-modal-btn-ok') as HTMLButtonElement;

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
      let msg: string | null = null;
      if (state.lostCertifications.length === 0) {
        msg = 'בחר לפחות הסמכה אחת שאבדה.';
      } else if (opts.validate) {
        msg = opts.validate(state);
      }
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

    backdrop.querySelectorAll<HTMLInputElement>('.capch-cert-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const set = new Set(state.lostCertifications);
        if (cb.checked) set.add(cb.value);
        else set.delete(cb.value);
        state.lostCertifications = [...set];
        runValidate();
      });
    });

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
    reasonInput.addEventListener('input', () => {
      state.reason = reasonInput.value;
    });

    const buildResult = (): CapabilityChangePickerResult => {
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
    runValidate();

    document.body.appendChild(backdrop);
  });
}

function renderHourOptions(hours: CapabilityChangePickerHourOption[], selected: string): string {
  return hours
    .map(
      (o) =>
        `<option value="${escAttr(o.value)}"${o.value === selected ? ' selected' : ''}>${escHtml(o.label)}</option>`,
    )
    .join('');
}

function renderDayChips(days: CapabilityChangePickerDayOption[], selected: string): string {
  return days
    .map(
      (d) =>
        `<button type="button" class="gm-range-picker-chip${d.value === selected ? ' gm-range-picker-chip--active' : ''}" data-value="${escAttr(d.value)}" aria-pressed="${d.value === selected ? 'true' : 'false'}">${escHtml(d.label)}</button>`,
    )
    .join('');
}
