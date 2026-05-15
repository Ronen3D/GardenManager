/**
 * Unified in-app modal & toast system.
 *
 * Replaces native alert()/prompt()/confirm() with styled modals,
 * and provides a reusable toast notification utility.
 */

import { escAttr, escHtml } from './ui-helpers';

/** Cleanup callbacks for custom selects, keyed by select ID (stable across re-renders). */
const _selectCleanups = new Map<string, () => void>();

/** Currently-open custom select, if any. Used to auto-close when another opens. */
let _openSelect: { close: () => void } | null = null;

// ─── Modal Dialogs ──────────────────────────────────────────────────────────

export interface AlertOptions {
  title?: string;
  icon?: string;
  /** If set, injected as-is into the modal body instead of the escaped `message`. Caller owns escaping of any untrusted text within the fragment. */
  bodyHtml?: string;
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
    const body = opts?.bodyHtml ?? escHtml(message);

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog" role="alertdialog" aria-modal="true">
        <div class="gm-modal-header">
          <span class="gm-modal-icon">${icon}</span>
          <span class="gm-modal-title">${escHtml(title)}</span>
        </div>
        <div class="gm-modal-body">${body}</div>
        <div class="gm-modal-actions">
          <button class="btn-primary gm-modal-btn-ok">אישור</button>
        </div>
      </div>`;

    lockBodyScroll();
    const close = () => {
      backdrop.remove();
      unlockBodyScroll();
      resolve();
    };

    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close();
      }
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
          ${suggestions.map((s) => `<button class="gm-modal-suggestion" data-value="${escAttr(s)}">${escHtml(s)}</button>`).join('')}
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
    const close = (val: string | null) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    // OK / Cancel
    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', () => {
      const v = mainInput.value.trim();
      close(v || null);
    });
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    // Enter in input → OK
    mainInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = mainInput.value.trim();
        close(v || null);
      }
    });

    // Suggestion click
    backdrop.querySelectorAll('.gm-modal-suggestion').forEach((btn) => {
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
        backdrop.querySelectorAll('.gm-modal-suggestion').forEach((btn) => {
          const text = (btn as HTMLElement).textContent?.toLowerCase() || '';
          (btn as HTMLElement).style.display = !q || text.includes(q) ? '' : 'none';
        });
      });
    }

    // Escape
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(null);
      }
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
    const close = (val: boolean) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

    backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', () => close(true));
    backdrop.querySelector('.gm-modal-btn-cancel')!.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(false);
      }
      if (e.key === 'Enter') {
        document.removeEventListener('keydown', onKey);
        close(true);
      }
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
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close('continue');
    });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close('continue');
      }
    });

    document.body.appendChild(backdrop);
    (backdrop.querySelector('.gm-modal-btn-save') as HTMLElement).focus();
  });
}

// ─── Continuation Modal ────────────────────────────────────────────────────

export interface ContinuationModalOptions {
  /** Number of unfilled (`INFEASIBLE_SLOT`) slots in the current schedule. */
  unfilledCount: number;
  /** Cumulative attempts that have been run so far across the original generation and any prior continuations. */
  originalAttempts: number;
  /**
   * If true, the modal adds a soft "diminishing returns" hint to the body
   * copy — used after consecutive no-improvement continuations.
   */
  diminishingReturnsHint?: boolean;
}

// Stroke-based SVG icons (matching the style of `SVG_ICONS` in ui-helpers).
const ICON_LIGHTNING = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
const ICON_SCALE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="4" x2="12" y2="20"/><line x1="5" y1="8" x2="19" y2="8"/><path d="M2 14h6l-3-6-3 6z"/><path d="M16 14h6l-3-6-3 6z"/></svg>`;
const ICON_TARGET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></svg>`;
const ICON_CHEVRON_LEAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;

interface ContinuationTier {
  value: number;
  label: string;
  desc: string;
  icon: string;
  variant: 'quick' | 'balanced' | 'deep';
  recommended?: boolean;
}

const CONTINUATION_TIERS: readonly ContinuationTier[] = [
  { value: 30, label: '+30 ניסיונות', desc: 'חיפוש מהיר', icon: ICON_LIGHTNING, variant: 'quick' },
  { value: 60, label: '+60 ניסיונות', desc: 'חיפוש מאוזן', icon: ICON_SCALE, variant: 'balanced', recommended: true },
  { value: 100, label: '+100 ניסיונות', desc: 'חיפוש עמוק', icon: ICON_TARGET, variant: 'deep' },
];

/**
 * Prompt the user to run additional optimization attempts seeded from the
 * current best result.
 *
 * Returns the additional-attempt count (positive integer) the user picked,
 * or `null` on Cancel / Escape / backdrop click. Pressing a preset button
 * resolves immediately with that preset's value; the custom input accepts
 * Enter or its own confirm button. No upper cap — the user is trusted to
 * decide how many attempts to run.
 *
 * Visually intentional: this prompt reuses the `.optim-overlay` / `.optim-card`
 * shell of the optimization progress overlay so the user perceives it as a
 * continuation of the loading flow, not a separate modal stack.
 */
export function showContinuationModal(opts: ContinuationModalOptions): Promise<number | null> {
  return new Promise((resolve) => {
    const { unfilledCount, originalAttempts, diminishingReturnsHint } = opts;

    const tierCards = CONTINUATION_TIERS.map((tier) => {
      const recommendedClass = tier.recommended ? ' optim-tier--recommended' : '';
      // Only the recommended tier has a trailing element ("מומלץ" badge);
      // others are intentionally trailing-empty. A chevron here would read as
      // "expand/disclose" rather than "commit action," which is misleading.
      const trailing = tier.recommended ? `<span class="optim-tier-badge">מומלץ</span>` : '';
      return `
        <button type="button" class="optim-tier optim-tier--${tier.variant}${recommendedClass}" data-value="${tier.value}">
          <span class="optim-tier-icon">${tier.icon}</span>
          <span class="optim-tier-main">
            <span class="optim-tier-label">${tier.label}</span>
            <span class="optim-tier-desc">${tier.desc}</span>
          </span>
          ${trailing}
        </button>`;
    }).join('');

    const hintHtml = diminishingReturnsHint
      ? `<p class="optim-continuation-hint">בשני המשכים האחרונים לא נמצא שיפור. ייתכן שהמשבצות הנותרות אינן ניתנות לאיוש; שקול לבדוק זמינות בהגדרת המשתתפים.</p>`
      : '';

    const unfilledLabel = unfilledCount === 1 ? 'משבצת לא מאוישת' : 'משבצות לא מאוישות';

    const backdrop = document.createElement('div');
    backdrop.className = 'optim-overlay optim-overlay--prompt';
    backdrop.setAttribute('role', 'alertdialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="optim-card optim-card--prompt">
        <div class="cube-loader-wrapper optim-cube optim-cube--paused">
          <div class="cube-loader">
            <div class="cube-cell" style="--cell-color:#4A90D9"></div>
            <div class="cube-cell" style="--cell-color:#E74C3C"></div>
            <div class="cube-cell" style="--cell-color:#F39C12"></div>
            <div class="cube-cell" style="--cell-color:#27AE60"></div>
            <div class="cube-cell" style="--cell-color:#8E44AD"></div>
            <div class="cube-cell" style="--cell-color:#1ABC9C"></div>
            <div class="cube-cell" style="--cell-color:#3498db"></div>
            <div class="cube-cell" style="--cell-color:#e67e22"></div>
            <div class="cube-cell" style="--cell-color:#2ecc71"></div>
          </div>
        </div>
        <h3>להמשיך לחפש שבצ"ק טוב יותר?</h3>
        <div class="optim-continuation-summary">
          <span class="optim-continuation-hero">${unfilledCount}</span>
          <span class="optim-continuation-sub">${unfilledLabel}</span>
          <span class="optim-continuation-meta">מתוך ${originalAttempts} ניסיונות</span>
        </div>
        ${hintHtml}
        <div class="optim-continuation-tiers">
          ${tierCards}
        </div>
        <div class="optim-continuation-custom">
          <label for="gm-continuation-custom-input">או הזן מספר:</label>
          <input id="gm-continuation-custom-input" type="number" min="1" step="1" inputmode="numeric" placeholder="—" />
          <button class="optim-continuation-custom-ok" disabled aria-label="אשר מספר ניסיונות מותאם">${ICON_CHEVRON_LEAD}</button>
        </div>
        <div class="optim-actions optim-continuation-actions">
          <button class="btn-cancel-optim optim-continuation-dismiss">השאר כפי שהוא</button>
        </div>
      </div>`;

    lockBodyScroll();
    let resolved = false;
    const close = (val: number | null) => {
      if (resolved) return;
      resolved = true;
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);

    // Tier cards resolve immediately with their preset value.
    backdrop.querySelectorAll<HTMLButtonElement>('.optim-tier').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = Number(btn.dataset.value);
        if (Number.isFinite(v) && v > 0) close(v);
      });
    });

    // Custom input: enable the confirm button only on a valid positive integer.
    const customInput = backdrop.querySelector<HTMLInputElement>('#gm-continuation-custom-input')!;
    const customOk = backdrop.querySelector<HTMLButtonElement>('.optim-continuation-custom-ok')!;
    const parseCustom = (): number | null => {
      const raw = customInput.value.trim();
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
      return n;
    };
    const updateCustomOk = () => {
      customOk.disabled = parseCustom() === null;
    };
    customInput.addEventListener('input', updateCustomOk);
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = parseCustom();
        if (v !== null) close(v);
      }
    });
    customOk.addEventListener('click', () => {
      const v = parseCustom();
      if (v !== null) close(v);
    });

    // Dismiss / backdrop tap.
    backdrop.querySelector('.optim-continuation-dismiss')!.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    document.body.appendChild(backdrop);
    // Focus the recommended tier so keyboard users land on the suggested default.
    const focusTarget =
      (backdrop.querySelector('.optim-tier--recommended') as HTMLElement | null) ??
      (backdrop.querySelector('.optim-tier') as HTMLElement | null);
    focusTarget?.focus();
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

    const dayOptions = opts.days
      .map(
        (d) =>
          `<option value="${escAttr(d.value)}"${d.value === opts.defaultDay ? ' selected' : ''}>${escHtml(d.label)}</option>`,
      )
      .join('');
    const hourOptions = opts.hours
      .map(
        (h) =>
          `<option value="${escAttr(h.value)}"${h.value === opts.defaultHour ? ' selected' : ''}>${escHtml(h.label)}</option>`,
      )
      .join('');

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
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(null);
      }
      if (e.key === 'Enter') {
        document.removeEventListener('keydown', onKey);
        close({ day: daySelect.value, hour: hourSelect.value });
      }
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
  // Polite live region — additions are announced to screen readers without
  // interrupting the user. Error toasts override with role="alert" on the
  // toast itself for assertive announcement. aria-atomic="false" so only the
  // newly added toast is announced, not every toast already on screen.
  _toastContainer.setAttribute('role', 'status');
  _toastContainer.setAttribute('aria-live', 'polite');
  _toastContainer.setAttribute('aria-atomic', 'false');
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
  // Errors escalate to assertive (announced immediately, may interrupt other
  // speech). Non-error toasts inherit the container's polite live region.
  if (type === 'error') {
    toast.setAttribute('role', 'alert');
  }

  const icons: Record<string, string> = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

  let actionHtml = '';
  if (opts?.action) {
    actionHtml = `<button class="gm-toast-action">${escHtml(opts.action.label)}</button>`;
  }

  toast.innerHTML = `
    <span class="gm-toast-icon" aria-hidden="true">${icons[type]}</span>
    <span class="gm-toast-msg">${escHtml(message)}</span>
    ${actionHtml}
    <button class="gm-toast-close" aria-label="סגור הודעה">✕</button>`;

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
  const selected = cfg.options.find((o) => o.selected);
  const displayLabel = selected?.label || cfg.placeholder || '';
  const listboxId = `${cfg.id}-listbox`;
  const ariaLabel = cfg.placeholder ? ` aria-label="${escAttr(cfg.placeholder)}"` : '';

  return `
    <div class="gm-select ${cfg.className || ''}" id="${cfg.id}" data-value="${escAttr(selected?.value || '')}">
      <button class="gm-select-trigger" type="button"
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded="false"
              aria-controls="${escAttr(listboxId)}"${ariaLabel}>
        <span class="gm-select-label">${escHtml(displayLabel)}</span>
        <span class="gm-select-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="gm-select-dropdown">
        ${cfg.searchable ? `<input type="text" class="gm-select-search" placeholder="🔍 חפש..." aria-label="חפש" aria-autocomplete="list" aria-controls="${escAttr(listboxId)}" />` : ''}
        <div class="gm-select-options" role="listbox" id="${escAttr(listboxId)}" tabindex="-1">
          ${cfg.options
            .map(
              (o, i) => `
            <div class="gm-select-option ${o.selected ? 'selected' : ''}"
                 id="${escAttr(`${cfg.id}-opt-${i}`)}"
                 role="option"
                 aria-selected="${o.selected ? 'true' : 'false'}"
                 data-value="${escAttr(o.value)}">
              ${escHtml(o.label)}
            </div>
          `,
            )
            .join('')}
        </div>
      </div>
    </div>`;
}

/** Wire event listeners for a custom select. Cleans up previous document listeners. */
export function wireCustomSelect(container: HTMLElement, selectId: string, onChange: (value: string) => void): void {
  const wrapper = container.querySelector(`#${selectId}`) as HTMLElement | null;
  if (!wrapper) return;

  // Clean up any previous outside-click listener stored for this select ID
  const prevCleanup = _selectCleanups.get(selectId);
  if (prevCleanup) prevCleanup();

  const trigger = wrapper.querySelector('.gm-select-trigger') as HTMLElement;
  const dropdown = wrapper.querySelector('.gm-select-dropdown') as HTMLElement;
  const searchInput = wrapper.querySelector('.gm-select-search') as HTMLInputElement | null;
  const allOptions = () => Array.from(dropdown.querySelectorAll<HTMLElement>('.gm-select-option'));
  const visibleOptions = () => allOptions().filter((o) => o.style.display !== 'none');

  let activeIndex = -1;
  let typeBuffer = '';
  let typeBufferTimer: number | null = null;

  const setActive = (idx: number) => {
    const opts = visibleOptions();
    if (opts.length === 0) {
      activeIndex = -1;
      trigger.removeAttribute('aria-activedescendant');
      searchInput?.removeAttribute('aria-activedescendant');
      allOptions().forEach((o) => {
        o.classList.remove('gm-select-option--active');
      });
      return;
    }
    const clamped = ((idx % opts.length) + opts.length) % opts.length;
    activeIndex = clamped;
    const target = opts[clamped];
    allOptions().forEach((o) => {
      o.classList.remove('gm-select-option--active');
    });
    target.classList.add('gm-select-option--active');
    const targetId = target.id;
    if (targetId) {
      trigger.setAttribute('aria-activedescendant', targetId);
      searchInput?.setAttribute('aria-activedescendant', targetId);
    }
    target.scrollIntoView({ block: 'nearest' });
  };

  // Dropdown is portaled to <body> while open so its `position: fixed` is
  // measured against the viewport — any ancestor with `backdrop-filter`,
  // `transform`, `filter`, `contain`, or `will-change` would otherwise form a
  // containing block and throw the positioning off-screen.
  const close = (restoreFocus = false) => {
    const wasOpen = wrapper.classList.contains('open');
    wrapper.classList.remove('open');
    dropdown.classList.remove('gm-select-dropdown--open');
    if (dropdown.parentElement !== wrapper) wrapper.appendChild(dropdown);
    dropdown.style.position = '';
    dropdown.style.top = '';
    dropdown.style.left = '';
    dropdown.style.right = '';
    dropdown.style.bottom = '';
    dropdown.style.maxHeight = '';
    dropdown.style.insetInlineStart = '';
    dropdown.style.insetInlineEnd = '';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    searchInput?.removeAttribute('aria-activedescendant');
    allOptions().forEach((o) => {
      o.classList.remove('gm-select-option--active');
    });
    activeIndex = -1;
    if (_openSelect?.close === close) _openSelect = null;
    // Return focus to the trigger if the focus is currently inside the dropdown
    // or has been lost (body) — but not if the user clicked somewhere else.
    if (wasOpen && restoreFocus) trigger.focus();
  };

  const open = () => {
    if (_openSelect && _openSelect.close !== close) _openSelect.close();
    // Measure trigger BEFORE opening (always accurate, no scroll offset issues)
    const triggerRect = trigger.getBoundingClientRect();
    // Portal and show so we can measure the dropdown's natural rendered size.
    document.body.appendChild(dropdown);
    dropdown.classList.add('gm-select-dropdown--open');
    wrapper.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
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
      dropdown.style.maxHeight = `${Math.max(0, spaceBelow)}px`;
    }
    // Horizontal: align to trigger left edge, then clamp inside viewport
    let left = triggerRect.left;
    if (left + dropW > vpW) left = vpW - dropW - 4;
    if (left < 4) left = 4;
    dropdown.style.position = 'fixed';
    dropdown.style.top = `${top}px`;
    dropdown.style.left = `${left}px`;
    dropdown.style.insetInlineStart = 'unset';
    dropdown.style.insetInlineEnd = 'unset';
    _openSelect = { close };
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
      filterOptions('');
    }
    // Seed active to current selection (or first option)
    const opts = visibleOptions();
    const selectedIdx = opts.findIndex((o) => o.classList.contains('selected'));
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
  };

  // Filter options on search input
  const filterOptions = (q: string) => {
    const lower = q.toLowerCase();
    dropdown.querySelectorAll<HTMLElement>('.gm-select-option').forEach((opt) => {
      const text = opt.textContent?.toLowerCase() || '';
      opt.style.display = !lower || text.includes(lower) ? '' : 'none';
    });
    // Re-seed active to first visible match after filter changes
    const opts = visibleOptions();
    setActive(opts.length > 0 ? 0 : -1);
  };

  const commitOption = (opt: HTMLElement) => {
    const value = opt.dataset.value || '';
    wrapper.dataset.value = value;
    const label = wrapper.querySelector('.gm-select-label') as HTMLElement;
    if (label) label.textContent = opt.textContent?.trim() || '';
    allOptions().forEach((o) => {
      o.classList.remove('selected');
      o.setAttribute('aria-selected', 'false');
    });
    opt.classList.add('selected');
    opt.setAttribute('aria-selected', 'true');
    close(true);
    onChange(value);
  };

  const findByPrefix = (buffer: string): number => {
    if (!buffer) return -1;
    const opts = visibleOptions();
    const lower = buffer.toLowerCase();
    // Start from after current active, wrap around — so repeated same-letter cycles.
    const start = activeIndex >= 0 ? activeIndex + 1 : 0;
    for (let i = 0; i < opts.length; i++) {
      const idx = (start + i) % opts.length;
      if ((opts[idx].textContent?.trim().toLowerCase() || '').startsWith(lower)) return idx;
    }
    return -1;
  };

  const pushTypeBuffer = (ch: string) => {
    typeBuffer += ch;
    if (typeBufferTimer !== null) window.clearTimeout(typeBufferTimer);
    typeBufferTimer = window.setTimeout(() => {
      typeBuffer = '';
      typeBufferTimer = null;
    }, 500);
    const idx = findByPrefix(typeBuffer);
    if (idx >= 0) setActive(idx);
  };

  // Toggle dropdown on click. Keyboard activation (Enter/Space on a <button>)
  // is handled in the keydown listener, which calls preventDefault() to
  // suppress the synthesized click — so this only fires for real pointer
  // clicks and programmatic .click() calls (assistive tech / tests).
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wrapper.classList.contains('open')) close(false);
    else open();
  });

  // Keyboard handler on the trigger — works whether dropdown is closed or open.
  // When `searchable` is true and dropdown is open, the search input has focus
  // and its own keydown handler takes over for typing.
  trigger.addEventListener('keydown', (e) => {
    const isOpen = wrapper.classList.contains('open');
    const key = e.key;
    if (!isOpen) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ' || key === 'Spacebar') {
        e.preventDefault();
        open();
        return;
      }
      if (key === 'Home') {
        e.preventDefault();
        open();
        setActive(0);
        return;
      }
      if (key === 'End') {
        e.preventDefault();
        open();
        const opts = visibleOptions();
        setActive(opts.length - 1);
        return;
      }
      if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        open();
        pushTypeBuffer(key);
        return;
      }
      return;
    }
    // Open + focus on trigger (no search). Search input handles its own keys.
    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (key === 'Tab') {
      // Let Tab move focus naturally from the trigger, but close the dropdown.
      close(false);
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIndex < 0 ? 0 : activeIndex + 1);
      return;
    }
    if (key === 'ArrowUp') {
      e.preventDefault();
      const opts = visibleOptions();
      setActive(activeIndex < 0 ? opts.length - 1 : activeIndex - 1);
      return;
    }
    if (key === 'Home') {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (key === 'End') {
      e.preventDefault();
      const opts = visibleOptions();
      setActive(opts.length - 1);
      return;
    }
    if (key === 'PageDown') {
      e.preventDefault();
      setActive(activeIndex + 10);
      return;
    }
    if (key === 'PageUp') {
      e.preventDefault();
      setActive(activeIndex - 10);
      return;
    }
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      const opts = visibleOptions();
      if (activeIndex >= 0 && opts[activeIndex]) commitOption(opts[activeIndex]);
      return;
    }
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      pushTypeBuffer(key);
    }
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => filterOptions(searchInput.value));
    searchInput.addEventListener('click', (e) => e.stopPropagation());
    searchInput.addEventListener('keydown', (e) => {
      const key = e.key;
      if (key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      if (key === 'Tab') {
        close(false);
        return;
      }
      if (key === 'ArrowDown') {
        e.preventDefault();
        setActive(activeIndex < 0 ? 0 : activeIndex + 1);
        return;
      }
      if (key === 'ArrowUp') {
        e.preventDefault();
        const opts = visibleOptions();
        setActive(activeIndex < 0 ? opts.length - 1 : activeIndex - 1);
        return;
      }
      if (key === 'Home' && e.ctrlKey) {
        e.preventDefault();
        setActive(0);
        return;
      }
      if (key === 'End' && e.ctrlKey) {
        e.preventDefault();
        const opts = visibleOptions();
        setActive(opts.length - 1);
        return;
      }
      if (key === 'Enter') {
        e.preventDefault();
        const opts = visibleOptions();
        if (activeIndex >= 0 && opts[activeIndex]) commitOption(opts[activeIndex]);
      }
    });
  }

  // Select an option (mouse click)
  dropdown.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest('.gm-select-option') as HTMLElement | null;
    if (!opt) return;
    e.stopPropagation();
    commitOption(opt);
  });

  // Mouse hover updates the active highlight so keyboard/mouse stay in sync.
  dropdown.addEventListener('mousemove', (e) => {
    const opt = (e.target as HTMLElement).closest('.gm-select-option') as HTMLElement | null;
    if (!opt) return;
    const opts = visibleOptions();
    const idx = opts.indexOf(opt);
    if (idx >= 0 && idx !== activeIndex) setActive(idx);
  });

  // Close on outside click (with cleanup support). Dropdown may be portaled
  // to <body>, so `wrapper.contains` alone isn't enough.
  const closeOnOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (wrapper.contains(t) || dropdown.contains(t)) return;
    close(false);
  };
  // Global Escape — needed when focus is somewhere other than the trigger/search
  // (e.g. the dropdown was just opened and focus hasn't settled yet).
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (!wrapper.classList.contains('open')) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  document.addEventListener('click', closeOnOutside);
  document.addEventListener('keydown', closeOnEscape);
  _selectCleanups.set(selectId, () => {
    document.removeEventListener('click', closeOnOutside);
    document.removeEventListener('keydown', closeOnEscape);
    if (typeBufferTimer !== null) window.clearTimeout(typeBufferTimer);
    // If the select is torn down (re-render) while open, restore the dropdown
    // into the wrapper so it's cleaned up along with the rest of the subtree.
    if (dropdown.parentElement !== wrapper) wrapper.appendChild(dropdown);
    if (_openSelect?.close === close) _openSelect = null;
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

    const close = (val: string | null) => {
      backdrop.remove();
      unlockBodyScroll();
      resolve(val);
    };

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
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(null);
    });

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        close(null);
      }
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
export function showBottomSheet(content: string, opts?: BottomSheetOptions): { close: () => void; el: HTMLElement } {
  const title = opts?.title || '';

  const backdrop = document.createElement('div');
  backdrop.className = 'gm-bottom-sheet-backdrop';

  const actionsHtml = opts?.actions ? `<div class="gm-bs-actions">${opts.actions}</div>` : '';

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
    sheet.addEventListener(
      'animationend',
      () => {
        backdrop.remove();
        unlockBodyScroll();
        opts?.onClose?.();
      },
      { once: true },
    );
  };

  // Close on backdrop tap
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  // Close button
  backdrop.querySelector('.gm-bs-close')!.addEventListener('click', close);

  // Escape key
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey);
      close();
    }
  };
  document.addEventListener('keydown', onKey);

  // Swipe-down-to-dismiss
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  const dragHandle = backdrop.querySelector('.gm-bs-drag-handle') as HTMLElement;

  dragHandle.addEventListener(
    'touchstart',
    (e) => {
      startY = e.touches[0].clientY;
      currentY = startY;
      dragging = true;
      sheet.style.transition = 'none';
    },
    { passive: true },
  );

  dragHandle.addEventListener(
    'touchmove',
    (e) => {
      if (!dragging) return;
      currentY = e.touches[0].clientY;
      const dy = Math.max(0, currentY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );

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
