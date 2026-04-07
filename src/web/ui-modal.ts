/**
 * Unified in-app modal & toast system.
 *
 * Replaces native alert()/prompt()/confirm() with styled modals,
 * and provides a reusable toast notification utility.
 */

import { escHtml, escAttr } from './ui-helpers';

/** Cleanup callbacks for custom selects, keyed by select ID (stable across re-renders). */
const _selectCleanups = new Map<string, () => void>();

// ─── Modal Dialogs ──────────────────────────────────────────────────────────

export interface AlertOptions {
  title?: string;
  icon?: string;
}

export interface PromptOptions {
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  suggestions?: string[];
}

export interface ConfirmOptions {
  title?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Show an informational modal with a single OK button. */
export function showAlert(message: string, opts?: AlertOptions): Promise<void> {
  return new Promise((resolve) => {
    const title = opts?.title || 'התראה';
    const icon = opts?.icon || 'ℹ️';

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="alertdialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">${icon}</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${escHtml(message)}</div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok">אישור</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = () => { backdrop.remove(); unlockBodyScroll(); resolve(); };

    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
    });

    document.body.appendChild(backdrop);
    (backdrop.querySelector('.gm-modal-btn-ok') as HTMLElement).focus();
  });
}

/** Show a prompt modal with a text input and optional suggestion list. */
export function showPrompt(message: string, opts?: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const title = opts?.title || 'הזן ערך';
    const placeholder = opts?.placeholder || '';
    const defaultValue = opts?.defaultValue || '';
    const suggestions = opts?.suggestions || [];

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';

    let suggestionsHtml = '';
    if (suggestions.length > 0) {
      suggestionsHtml = `
        <input type="text" class="gm-modal-input gm-modal-search" placeholder="🔍 חפש..." />
        <div class="gm-modal-suggestions">
          ${suggestions.map(s => `<button class="gm-modal-suggestion" data-value="${escAttr(s)}">${escHtml(s)}</button>`).join('')}
        </div>`;
    }

    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">
          <p>${escHtml(message)}</p>
          <input type="text" class="gm-modal-input gm-modal-main-input"
                 placeholder="${escAttr(placeholder)}"
                 value="${escAttr(defaultValue)}" />
          ${suggestionsHtml}
        </div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok">אישור</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();
    const mainInput = backdrop.querySelector('.gm-modal-main-input') as HTMLInputElement;
    const close = (val: string | null) => { backdrop.remove(); unlockBodyScroll(); resolve(val); };

    // OK / Cancel
    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', () => {
      const v = mainInput.value.trim();
      close(v || null);
    });
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });

    // Enter in input → OK
    mainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const v = mainInput.value.trim(); close(v || null); }
    });

    // Suggestion click
    backdrop.querySelectorAll('.gm-modal-suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = (btn as HTMLElement).dataset.value || '';
        close(val);
      });
    });

    // Search filter for suggestions
    const searchInput = backdrop.querySelector('.gm-modal-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        backdrop.querySelectorAll('.gm-modal-suggestion').forEach(btn => {
          const text = (btn as HTMLElement).textContent?.toLowerCase() || '';
          (btn as HTMLElement).style.display = !q || text.includes(q) ? '' : 'none';
        });
      });
    }

    // Escape
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); }
    });

    document.body.appendChild(backdrop);
    if (suggestions.length > 0 && searchInput) {
      searchInput.focus();
    } else {
      mainInput.focus();
      mainInput.select();
    }
  });
}

/** Show a confirmation modal. Returns true on confirm, false on cancel. */
export function showConfirm(message: string, opts?: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const title = opts?.title || 'אישור';
    const danger = opts?.danger ?? false;
    const confirmLabel = opts?.confirmLabel || (danger ? 'מחק' : 'אישור');
    const cancelLabel = opts?.cancelLabel || 'ביטול';

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="alertdialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">${danger ? '⚠️' : '❓'}</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${escHtml(message)}</div>
        <div class="gm-modal-actions">
          <button class="${danger ? 'btn-primary gm-modal-btn-danger' : 'btn-primary'} gm-modal-btn-ok">${escHtml(confirmLabel)}</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">${escHtml(cancelLabel)}</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = (val: boolean) => { backdrop.remove(); unlockBodyScroll(); resolve(val); };

    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', () => close(true));
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
    });

    document.body.appendChild(backdrop);
    (backdrop.querySelector('.gm-modal-btn-ok') as HTMLElement).focus();
  });
}

// ─── Save-Confirm (3-button) Modal ────────────────────────────────────────

export type SaveConfirmResult = 'save' | 'continue' | 'discard';

/**
 * Show a 3-button confirmation dialog for unsaved changes.
 * Returns 'save' | 'continue' | 'discard'.
 */
export function showSaveConfirm(): Promise<SaveConfirmResult> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="alertdialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">💾</span>
          <span class="gm-modal-title">האם לשמור את השינויים?</span>
        </div>
        <div class="gm-modal-actions gm-save-confirm-actions">
          <button class="btn-primary gm-modal-btn-save">שמור</button>
          <button class="btn-sm btn-outline gm-modal-btn-continue">המשך עריכה</button>
          <button class="btn-sm btn-danger-outline gm-modal-btn-discard">בטל שינויים</button>
        </div>
      </div>`;

    lockBodyScroll();
    let resolved = false;
    const close = (val: SaveConfirmResult) => {
      if (resolved) return;
      resolved = true;
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    backdrop.querySelector('.gm-modal-btn-save')!.addEventListener('click', () => close('save'));
    backdrop.querySelector('.gm-modal-btn-continue')!.addEventListener('click', () => close('continue'));
    backdrop.querySelector('.gm-modal-btn-discard')!.addEventListener('click', () => close('discard'));
    // Clicking the backdrop itself → treat as "continue editing"
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close('continue'); });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close('continue'); }
    });

    document.body.appendChild(backdrop);
    (backdrop.querySelector('.gm-modal-btn-save') as HTMLElement).focus();
  });
}

// ─── Time Picker Modal ─────────────────────────────────────────────────────

export interface TimePickerOptions {
  title?: string;
  days: Array<{ value: string; label: string }>;
  hours: Array<{ value: string; label: string }>;
  defaultDay?: string;
  defaultHour?: string;
}

/** Show a modal with day + hour selectors. Returns { day, hour } or null on cancel. */
export function showTimePicker(
  message: string,
  opts: TimePickerOptions,
): Promise<{ day: string; hour: string } | null> {
  return new Promise((resolve) => {
    const title = opts.title || 'בחר זמן';

    const dayOptions = opts.days.map(d =>
      `<option value="${escAttr(d.value)}"${d.value === opts.defaultDay ? ' selected' : ''}>${escHtml(d.label)}</option>`
    ).join('');
    const hourOptions = opts.hours.map(h =>
      `<option value="${escAttr(h.value)}"${h.value === opts.defaultHour ? ' selected' : ''}>${escHtml(h.label)}</option>`
    ).join('');

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🔴</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${escHtml(message)}</div>
        <div class="gm-timepicker-row">
          <label class="gm-timepicker-label">יום: <select id="gm-tp-day" class="gm-timepicker-select">${dayOptions}</select></label>
          <label class="gm-timepicker-label">שעה: <select id="gm-tp-hour" class="gm-timepicker-select">${hourOptions}</select></label>
        </div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok">🔴 הפעל מצב חי</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = (val: { day: string; hour: string } | null) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    const daySelect = backdrop.querySelector('#gm-tp-day') as HTMLSelectElement;
    const hourSelect = backdrop.querySelector('#gm-tp-hour') as HTMLSelectElement;

    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', () => {
      close({ day: daySelect.value, hour: hourSelect.value });
    });
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close({ day: daySelect.value, hour: hourSelect.value }); }
    });

    document.body.appendChild(backdrop);
    (backdrop.querySelector('.gm-modal-btn-ok') as HTMLElement).focus();
  });
}

// ─── Toast / Snackbar Notifications ─────────────────────────────────────────

export interface ToastOptions {
  type?: 'success' | 'error' | 'warning' | 'info';
  duration?: number;
  action?: { label: string; callback: () => void };
}

let _toastContainer: HTMLElement | null = null;

function getToastContainer(): HTMLElement {
  if (_toastContainer && document.body.contains(_toastContainer)) return _toastContainer;
  _toastContainer = document.createElement('div');
  _toastContainer.className = 'gm-toast-container';
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

/** Show a toast notification. */
export function showToast(message: string, opts?: ToastOptions): void {
  const type = opts?.type || 'info';
  const duration = opts?.duration ?? 3500;

  const container = getToastContainer();

  const toast = document.createElement('div');
  toast.className = `gm-toast gm-toast-${type}`;

  const icons: Record<string, string> = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

  let actionHtml = '';
  if (opts?.action) {
    actionHtml = `<button class="gm-toast-action">${escHtml(opts.action.label)}</button>`;
  }

  toast.innerHTML = `
    <span class="gm-toast-icon">${icons[type]}</span>
    <span class="gm-toast-msg">${escHtml(message)}</span>
    ${actionHtml}
    <button class="gm-toast-close">✕</button>`;

  const dismiss = () => {
    toast.classList.add('gm-toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  };

  toast.querySelector('.gm-toast-close')!.addEventListener('click', dismiss);

  if (opts?.action) {
    toast.querySelector('.gm-toast-action')!.addEventListener('click', () => {
      opts.action!.callback();
      dismiss();
    });
  }

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// ─── Custom Select Dropdown ─────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  selected?: boolean;
}

export interface CustomSelectConfig {
  id: string;
  options: SelectOption[];
  searchable?: boolean;
  className?: string;
  placeholder?: string;
}

/** Render HTML for a custom select dropdown. */
export function renderCustomSelect(cfg: CustomSelectConfig): string {
  const selected = cfg.options.find(o => o.selected);
  const displayLabel = selected?.label || cfg.placeholder || '';

  return `
    <div class="gm-select ${cfg.className || ''}" id="${cfg.id}" data-value="${escAttr(selected?.value || '')}">
      <button class="gm-select-trigger" type="button">
        <span class="gm-select-label">${escHtml(displayLabel)}</span>
        <span class="gm-select-chevron">▾</span>
      </button>
      <div class="gm-select-dropdown">
        ${cfg.searchable ? '<input type="text" class="gm-select-search" placeholder="🔍 חפש..." />' : ''}
        <div class="gm-select-options">
          ${cfg.options.map(o => `
            <button class="gm-select-option ${o.selected ? 'selected' : ''}"
                    data-value="${escAttr(o.value)}" type="button">
              ${escHtml(o.label)}
            </button>
          `).join('')}
        </div>
      </div>
    </div>`;
}

/** Wire event listeners for a custom select. Cleans up previous document listeners. */
export function wireCustomSelect(
  container: HTMLElement,
  selectId: string,
  onChange: (value: string) => void,
): void {
  const wrapper = container.querySelector(`#${selectId}`) as HTMLElement | null;
  if (!wrapper) return;

  // Clean up any previous outside-click listener stored for this select ID
  const prevCleanup = _selectCleanups.get(selectId);
  if (prevCleanup) prevCleanup();

  const trigger = wrapper.querySelector('.gm-select-trigger') as HTMLElement;
  const dropdown = wrapper.querySelector('.gm-select-dropdown') as HTMLElement;
  const searchInput = wrapper.querySelector('.gm-select-search') as HTMLInputElement | null;

  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = wrapper.classList.contains('open');
    // Close all other open selects first
    document.querySelectorAll('.gm-select.open').forEach(el => el.classList.remove('open'));
    if (!wasOpen) {
      // Measure trigger BEFORE opening (always accurate, no scroll offset issues)
      const triggerRect = trigger.getBoundingClientRect();
      // Reset any inline styles from a previous open cycle
      dropdown.style.position = '';
      dropdown.style.top = '';
      dropdown.style.left = '';
      dropdown.style.right = '';
      dropdown.style.bottom = '';
      dropdown.style.maxHeight = '';
      dropdown.style.insetInlineStart = '';
      dropdown.style.insetInlineEnd = '';
      // Open so we can measure the dropdown's natural rendered size
      wrapper.classList.add('open');
      const dropW = dropdown.offsetWidth;
      const dropH = dropdown.offsetHeight;
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const gap = 4;
      // Vertical: prefer opening downward; flip up if clipped; clamp height as last resort
      const spaceBelow = vpH - triggerRect.bottom - gap;
      const spaceAbove = triggerRect.top - gap;
      let top: number;
      if (dropH <= spaceBelow) {
        top = triggerRect.bottom + gap;
      } else if (dropH <= spaceAbove) {
        top = triggerRect.top - dropH - gap;
      } else {
        // Neither direction fits fully — open downward and cap the height
        top = triggerRect.bottom + gap;
        dropdown.style.maxHeight = `${spaceBelow}px`;
      }
      // Horizontal: align to trigger left edge, then clamp inside viewport
      let left = triggerRect.left;
      if (left + dropW > vpW) left = vpW - dropW - 4;
      if (left < 4) left = 4;
      // fixed positioning so parent overflow/scroll can never clip the dropdown
      dropdown.style.position = 'fixed';
      dropdown.style.top = `${top}px`;
      dropdown.style.left = `${left}px`;
      dropdown.style.insetInlineStart = 'unset';
      dropdown.style.insetInlineEnd = 'unset';
      if (searchInput) { searchInput.value = ''; searchInput.focus(); filterOptions(''); }
    }
  });

  // Filter options on search input
  const filterOptions = (q: string) => {
    const lower = q.toLowerCase();
    wrapper.querySelectorAll('.gm-select-option').forEach(btn => {
      const text = (btn as HTMLElement).textContent?.toLowerCase() || '';
      (btn as HTMLElement).style.display = !lower || text.includes(lower) ? '' : 'none';
    });
  };
  if (searchInput) {
    searchInput.addEventListener('input', () => filterOptions(searchInput.value));
    searchInput.addEventListener('click', (e) => e.stopPropagation());
  }

  // Select an option
  dropdown.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.gm-select-option') as HTMLElement | null;
    if (!btn) return;
    e.stopPropagation();
    const value = btn.dataset.value || '';
    wrapper.dataset.value = value;
    const label = wrapper.querySelector('.gm-select-label') as HTMLElement;
    if (label) label.textContent = btn.textContent?.trim() || '';
    // Update selected class
    wrapper.querySelectorAll('.gm-select-option').forEach(o => o.classList.remove('selected'));
    btn.classList.add('selected');
    wrapper.classList.remove('open');
    onChange(value);
  });

  // Close on outside click (with cleanup support)
  const closeOnOutside = (e: MouseEvent) => {
    if (!wrapper.contains(e.target as Node)) {
      wrapper.classList.remove('open');
    }
  };
  document.addEventListener('click', closeOnOutside);
  _selectCleanups.set(selectId, () => {
    document.removeEventListener('click', closeOnOutside);
  });
}

// ─── Body Scroll Lock ───────────────────────────────────────────────────────

let _scrollLockCount = 0;
let _savedScrollY = 0;

/** Lock body scroll (nestable — only the first lock applies). */
export function lockBodyScroll(): void {
  if (_scrollLockCount === 0) {
    _savedScrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    document.body.style.top = `-${_savedScrollY}px`;
  }
  _scrollLockCount++;
}

/** Unlock body scroll (only the last unlock restores). */
export function unlockBodyScroll(): void {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount === 0) {
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    document.body.style.top = '';
    window.scrollTo(0, _savedScrollY);
  }
}

// ─── Continuity Import Modal ────────────────────────────────────────────────

export interface ContinuityImportOptions {
  /** Pre-populate the textarea (e.g. when editing existing data). */
  defaultValue?: string;
  /** Validator: returns null on success or an error string. On success also returns a human summary. */
  validate: (json: string) => { ok: true; summary: string } | { ok: false; error: string };
}

/**
 * Show a modal for importing continuity JSON.
 * Returns the raw JSON string on apply, or null on cancel.
 */
export function showContinuityImport(opts: ContinuityImportOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const defaultVal = opts.defaultValue || '';

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-modal-continuity" role="dialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">🔗</span>
          <span class="gm-modal-title">ייבוא נתוני המשכיות</span>
        </div>
        <div class="gm-modal-body">
          <p class="text-muted" style="margin: 0 0 10px;">הדבק את הנתונים שיוצאו מלחצן "ייצוא יום" בשבצ"ק הקודם. המערכת תאכוף אילוצים על הגבול בין השבצ"קים.</p>
          <textarea class="continuity-textarea gm-continuity-input" rows="8"
            placeholder="הדבק כאן JSON..." dir="ltr">${escHtml(defaultVal)}</textarea>
          <div class="gm-continuity-status"></div>
        </div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok" disabled>החל</button>
          <button class="btn-sm btn-outline gm-modal-btn-cancel">ביטול</button>
        </div>
      </div>`;

    lockBodyScroll();

    const textarea = backdrop.querySelector('.gm-continuity-input') as HTMLTextAreaElement;
    const statusEl = backdrop.querySelector('.gm-continuity-status') as HTMLElement;
    const okBtn = backdrop.querySelector('.gm-modal-btn-ok') as HTMLButtonElement;

    const close = (val: string | null) => { backdrop.remove(); unlockBodyScroll(); resolve(val); };

    const updateValidation = () => {
      const val = textarea.value.trim();
      if (!val) {
        statusEl.innerHTML = '';
        okBtn.disabled = true;
        return;
      }
      const result = opts.validate(val);
      if (result.ok) {
        statusEl.innerHTML = `<span class="continuity-status continuity-ok">✓ ${escHtml(result.summary)}</span>`;
        okBtn.disabled = false;
      } else {
        statusEl.innerHTML = `<span class="continuity-status continuity-error">✗ ${escHtml(result.error)}</span>`;
        okBtn.disabled = true;
      }
    };

    // Validate initial value
    updateValidation();

    textarea.addEventListener('input', updateValidation);

    okBtn.addEventListener('click', () => close(textarea.value.trim()));
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); }
    });

    document.body.appendChild(backdrop);
    textarea.focus();
  });
}

// ─── Bottom Sheet ───────────────────────────────────────────────────────────

export interface BottomSheetOptions {
  title?: string;
  /** Extra HTML rendered as a fixed action row at the bottom of the sheet. */
  actions?: string;
  onClose?: () => void;
}

/**
 * Show a bottom sheet (mobile-friendly overlay that slides up from the bottom).
 * Returns a handle with a `close()` function for programmatic dismissal.
 */
export function showBottomSheet(
  content: string,
  opts?: BottomSheetOptions,
): { close: () => void; el: HTMLElement } {
  const title = opts?.title || '';

  const backdrop = document.createElement('div');
  backdrop.className = 'gm-bottom-sheet-backdrop';

  const actionsHtml = opts?.actions
    ? `<div class="gm-bs-actions">${opts.actions}</div>`
    : '';

  backdrop.innerHTML = `
    <div class="gm-bottom-sheet" role="dialog" aria-modal="true">
      <div class="gm-bs-drag-handle"><span></span></div>
      ${title ? `<div class="gm-bs-header"><span class="gm-bs-title">${escHtml(title)}</span><button class="gm-bs-close" aria-label="סגור">✕</button></div>` : '<div class="gm-bs-header-minimal"><button class="gm-bs-close" aria-label="סגור">✕</button></div>'}
      <div class="gm-bs-body">${content}</div>
      ${actionsHtml}
    </div>`;

  lockBodyScroll();

  const sheet = backdrop.querySelector('.gm-bottom-sheet') as HTMLElement;

  const close = () => {
    sheet.classList.add('gm-bs-closing');
    sheet.addEventListener('animationend', () => {
      backdrop.remove();
      unlockBodyScroll();
      opts?.onClose?.();
    }, { once: true });
  };

  // Close on backdrop tap
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Close button
  backdrop.querySelector('.gm-bs-close')!.addEventListener('click', close);

  // Escape key
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); }
  };
  document.addEventListener('keydown', onKey);

  // Swipe-down-to-dismiss
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  const dragHandle = backdrop.querySelector('.gm-bs-drag-handle') as HTMLElement;

  dragHandle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    currentY = startY;
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  dragHandle.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    currentY = e.touches[0].clientY;
    const dy = Math.max(0, currentY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });

  dragHandle.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    const dy = currentY - startY;
    if (dy > 80) {
      close();
    } else {
      sheet.style.transform = '';
    }
  });

  document.body.appendChild(backdrop);

  // Focus the close button for accessibility
  (backdrop.querySelector('.gm-bs-close') as HTMLElement).focus();

  return { close, el: sheet };
}

