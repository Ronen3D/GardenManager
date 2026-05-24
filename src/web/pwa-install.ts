/**
 * PWA install — self-contained leaf module (no app.ts dependency, so both
 * app.ts and data-transfer-ui.ts can import it without a circular import).
 *
 * Owns the `beforeinstallprompt` capture and the one-time "install the app to
 * receive shared files via the system Share sheet" nudge. The Android Web
 * Share Target (manifest.json `share_target`) only works for an *installed*
 * PWA, so this nudge is the only thing prompting browser-tab users to install.
 *
 * Platform reality: `beforeinstallprompt` + the install prompt are
 * Chromium/Android-only. iOS/Safari never fires the event, so the nudge there
 * naturally never shows (no deferred prompt ⇒ `installNudgeShouldShow()` is
 * false) — which is correct, since iOS has no Web Share Target either.
 */

const KEY_INSTALL_NUDGE_SEEN = 'gardenmanager_install_nudge_seen';

/** Minimal shape of the non-standard `BeforeInstallPromptEvent`. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let _deferredPrompt: BeforeInstallPromptEvent | null = null;
let _captureInstalled = false;

/**
 * Register the `beforeinstallprompt` / `appinstalled` listeners. Call once,
 * as early as possible in app init, so the (one-shot) event is never missed.
 *
 * `onChange` (optional) fires whenever install state shifts — used by the
 * Home-tab install panel to re-render immediately when the deferred prompt
 * arrives late or when the user completes the install, instead of waiting
 * for the next user-triggered render.
 */
export function initPwaInstallCapture(onChange?: () => void): void {
  if (_captureInstalled) return;
  _captureInstalled = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar so we can trigger the prompt from our own UI.
    e.preventDefault();
    _deferredPrompt = e as BeforeInstallPromptEvent;
    onChange?.();
  });
  window.addEventListener('appinstalled', () => {
    _deferredPrompt = null;
    markInstallNudgeSeen();
    onChange?.();
  });
}

export function isInstallNudgeSeen(): boolean {
  try {
    return localStorage.getItem(KEY_INSTALL_NUDGE_SEEN) === '1';
  } catch {
    return false;
  }
}

export function markInstallNudgeSeen(): void {
  try {
    localStorage.setItem(KEY_INSTALL_NUDGE_SEEN, '1');
  } catch {
    /* storage full — nudge may reappear on next load, acceptable */
  }
}

/** True when already running as an installed standalone PWA (either platform). */
function isStandalone(): boolean {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return !!(navigator as unknown as { standalone?: boolean }).standalone;
}

/** True only when an install is actually offerable and not yet handled. */
export function installNudgeShouldShow(): boolean {
  if (!_deferredPrompt) return false; // already installed, or unsupported (incl. iOS)
  if (isInstallNudgeSeen()) return false;
  if (isStandalone()) return false; // running as an installed PWA → nothing to nudge
  return true;
}

/**
 * iOS Safari detection for the manual "Add to Home Screen" hint. iOS never
 * fires `beforeinstallprompt`, and only genuine Safari exposes the
 * Share → Add to Home Screen flow — alternative iOS browsers (Chrome/Firefox/
 * Edge) and in-app webviews either can't install or word it differently, so
 * the instruction copy would be wrong there. Restrict accordingly.
 */
function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const isIosDevice =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as desktop Safari but is touch-capable.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIosDevice) return false;
  // Genuine Safari carries both a "Safari" and a "Version/" token; the
  // alternative iOS browsers and embedded webviews do not.
  return /Safari/i.test(ua) && /Version\//i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/i.test(ua);
}

/**
 * Drives the mobile Home-tab install panel. The panel is intentionally
 * persistent — it has no dismiss control, so visibility is fully derived
 * from platform state:
 *
 * - `'android'` → a `beforeinstallprompt` was captured: offer the one-tap
 *   native install button (`runInstallPrompt`).
 * - `'ios'`     → iOS Safari, not installed: show the manual Share → Add to
 *   Home Screen hint (no programmatic prompt exists on iOS).
 * - `null`      → already installed/standalone, or unsupported (desktop
 *   browsers, alternative iOS browsers, webviews) → nothing actionable.
 */
export function homeInstallBannerMode(): 'android' | 'ios' | null {
  if (isStandalone()) return null;
  if (_deferredPrompt) return 'android';
  if (isIosSafari()) return 'ios';
  return null;
}

/**
 * Trigger the captured install prompt and wait for the user's choice. Marks
 * the Settings share-target nudge seen afterwards (whatever the outcome) and
 * drops the one-shot prompt reference. Browser will refire
 * `beforeinstallprompt` later under its engagement heuristics, restoring the
 * Home panel's Install button on the next eligible event.
 */
export async function runInstallPrompt(): Promise<void> {
  const deferred = _deferredPrompt;
  _deferredPrompt = null;
  markInstallNudgeSeen();
  if (!deferred) return;
  try {
    await deferred.prompt();
    await deferred.userChoice;
  } catch {
    /* prompt unavailable / already used — nudge is already marked seen */
  }
}
