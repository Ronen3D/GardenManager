/**
 * Responsive utilities — device detection and breakpoint helpers.
 *
 * Sets `.touch-device` or `.pointer-device` on <html> so CSS can scope
 * hover/active overrides without JS per-component branching.
 */

// ─── Device Detection ───────────────────────────────────────────────────────

const coarseQuery = window.matchMedia('(pointer: coarse)');
const smallQuery = window.matchMedia('(max-width: 767px)');

/** True when the primary input is a coarse pointer (finger, stylus). */
export let isTouchDevice = coarseQuery.matches;

/** True when the viewport is at or below the phone breakpoint. */
export let isSmallScreen = smallQuery.matches;

// ─── Init ───────────────────────────────────────────────────────────────────

/** Call once at app startup (before first render). */
export function initResponsive(): void {
  const root = document.documentElement;

  // Set initial class
  applyClass(root, coarseQuery.matches);

  // React to runtime changes (e.g. tablet detaching keyboard, resize)
  coarseQuery.addEventListener('change', (e) => {
    isTouchDevice = e.matches;
    applyClass(root, e.matches);
  });

  smallQuery.addEventListener('change', (e) => {
    isSmallScreen = e.matches;
  });
}

function applyClass(root: HTMLElement, isTouch: boolean): void {
  root.classList.toggle('touch-device', isTouch);
  root.classList.toggle('pointer-device', !isTouch);
}
