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

/** True only when an install is actually offerable and not yet handled. */
export function installNudgeShouldShow(): boolean {
  if (!_deferredPrompt) return false; // already installed, or unsupported (incl. iOS)
  if (isInstallNudgeSeen()) return false;
  // Running as an installed PWA already → nothing to nudge.
  if (window.matchMedia?.('(display-mode: standalone)').matches) return false;
  if ((navigator as unknown as { standalone?: boolean }).standalone) return false;
  return true;
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
