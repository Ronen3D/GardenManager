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

// Home-tab install banner — a *separate* dismiss key from the Settings
// share-target nudge above. They are distinct surfaces with distinct messages
// (broad "install the app" vs. narrow "install to receive shared files") and
// distinct platform reach (the banner also covers iOS), so each owns its own
// dismissal: hiding one must not silently hide the other.
const KEY_HOME_INSTALL_SEEN = 'gardenmanager_home_install_seen';

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
 */
export function initPwaInstallCapture(): void {
  if (_captureInstalled) return;
  _captureInstalled = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar so we can trigger the prompt from our own UI.
    e.preventDefault();
    _deferredPrompt = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    _deferredPrompt = null;
    markInstallNudgeSeen();
    // Same install covers the Home banner — never resurface it post-install,
    // even before the next standalone relaunch.
    markHomeInstallSeen();
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

export function isHomeInstallSeen(): boolean {
  try {
    return localStorage.getItem(KEY_HOME_INSTALL_SEEN) === '1';
  } catch {
    return false;
  }
}

export function markHomeInstallSeen(): void {
  try {
    localStorage.setItem(KEY_HOME_INSTALL_SEEN, '1');
  } catch {
    /* storage full — banner may reappear on next load, acceptable */
  }
}

/**
 * Drives the mobile Home-tab install banner. Independent of the Settings
 * share-target nudge (its own dismiss key, broader copy, both platforms):
 *
 * - `'android'` → a `beforeinstallprompt` was captured: offer the one-tap
 *   native install button (`runInstallPrompt`).
 * - `'ios'`     → iOS Safari, not installed: show the manual Share → Add to
 *   Home Screen hint (no programmatic prompt exists on iOS).
 * - `null`      → already installed/standalone, dismissed, or unsupported
 *   (desktop browsers, alternative iOS browsers, webviews).
 */
export function homeInstallBannerMode(): 'android' | 'ios' | null {
  if (isStandalone()) return null;
  if (isHomeInstallSeen()) return null;
  if (_deferredPrompt) return 'android';
  if (isIosSafari()) return 'ios';
  return null;
}

/**
 * Trigger the captured install prompt and wait for the user's choice. Marks
 * the nudge seen afterwards (whatever the outcome) and drops the one-shot
 * prompt reference so the nudge never reappears.
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
