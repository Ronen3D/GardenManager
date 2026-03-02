/**
 * Unified in-app modal & toast system.
 *
 * Replaces native alert()/prompt()/confirm() with styled modals,
 * and provides a reusable toast notification utility.
 */

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
    const title = opts?.title || 'הודעה';
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

    const close = () => { backdrop.remove(); resolve(); };

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
    const title = opts?.title || 'קלט';
    const placeholder = opts?.placeholder || '';
    const defaultValue = opts?.defaultValue || '';
    const suggestions = opts?.suggestions || [];

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';

    let suggestionsHtml = '';
    if (suggestions.length > 0) {
      suggestionsHtml = `
        <input type="text" class="gm-modal-input gm-modal-search" placeholder="🔍 חפש…" />
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

    const mainInput = backdrop.querySelector('.gm-modal-main-input') as HTMLInputElement;
    const close = (val: string | null) => { backdrop.remove(); resolve(val); };

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

    const close = (val: boolean) => { backdrop.remove(); resolve(val); };

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
        ${cfg.searchable ? '<input type="text" class="gm-select-search" placeholder="🔍 חפש…" />' : ''}
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

  // Clean up any previous outside-click listener stored on this wrapper
  const prevCleanup = (wrapper as any).__gmSelectCleanup as (() => void) | undefined;
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
  (wrapper as any).__gmSelectCleanup = () => {
    document.removeEventListener('click', closeOnOutside);
  };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
