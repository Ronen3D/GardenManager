/**
 * Global focus trap for modal dialogs.
 *
 * Auto-detects any element added under <body> that carries (or contains)
 * `[aria-modal="true"]` and pushes it onto an internal modal stack. While a
 * modal is on the stack, Tab / Shift+Tab cycles focus among the modal's
 * focusable descendants; if focus has escaped the modal subtree (e.g. a
 * stray click landed in background UI), the next Tab pulls it back in.
 * Removing the modal element pops the stack and restores the previously
 * focused element when it is still connected.
 *
 * The contract is "set `aria-modal="true"` on your dialog and you are
 * trapped." Modals that intentionally opt out (the tutorial popover,
 * which manages its own keyboard containment via `inert`) set
 * `aria-modal="false"` and are ignored.
 */

interface TrappedModal {
  root: HTMLElement;
  priorFocus: HTMLElement | null;
}

const _stack: TrappedModal[] = [];
let _installed = false;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

function findModalIn(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  if (node.getAttribute('aria-modal') === 'true') return node;
  return node.querySelector<HTMLElement>('[aria-modal="true"]');
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  // offsetParent is null for display:none and detached subtrees; getClientRects
  // covers fixed-positioned elements whose offsetParent is also null.
  if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return false;
  return true;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const top = _stack[_stack.length - 1];
  if (!top) return;
  const items = focusables(top.root);
  if (items.length === 0) {
    // Nothing focusable inside — keep focus where it is and block escape.
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const insideModal = !!active && top.root.contains(active);
  if (!insideModal) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onAdded(node: Node): void {
  const modal = findModalIn(node);
  if (!modal) return;
  if (_stack.some((m) => m.root === modal)) return;
  const prior = document.activeElement as HTMLElement | null;
  _stack.push({
    root: modal,
    priorFocus: prior && prior !== document.body ? prior : null,
  });
}

function onRemoved(node: Node): void {
  if (!(node instanceof HTMLElement)) return;
  for (let i = _stack.length - 1; i >= 0; i--) {
    const m = _stack[i];
    if (m.root === node || node.contains(m.root)) {
      _stack.splice(i, 1);
      const target = m.priorFocus;
      if (target && target.isConnected) {
        // Defer so close-handler DOM mutations settle before the refocus,
        // and so we don't fight focus moves the closing modal performs itself.
        queueMicrotask(() => {
          if (target.isConnected) {
            try {
              target.focus();
            } catch {
              // ignore — element may have become unfocusable
            }
          }
        });
      }
    }
  }
}

/**
 * Install the global focus trap. Idempotent — safe to call from `init()`.
 * All modals (current and future) participate automatically by carrying
 * `aria-modal="true"`.
 */
export function installFocusTrap(): void {
  if (_installed) return;
  _installed = true;
  document.addEventListener('keydown', onKey, true);
  // Modals in this app are all appended as direct children of <body>, so a
  // shallow childList observation is enough and avoids the cost of watching
  // every subtree mutation under #app.
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach(onAdded);
      r.removedNodes.forEach(onRemoved);
    }
  });
  observer.observe(document.body, { childList: true });
}
