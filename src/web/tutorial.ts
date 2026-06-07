/**
 * Tutorial engine — coach-mark popover with spotlight cutout.
 * Non-blocking: no scroll lock, no focus trap on the page itself.
 * Steps live in `tutorial-content.ts` (pure data).
 *
 * Public surface:
 *   startTutorial(trackId)    — launch a track
 *   exitTutorial()            — close immediately
 *   getCurrentTrack()         — id of running track, or null
 *   showTutorialBanner()      — first-launch banner
 *   renderTutorialAccordionBody() — HTML for the #acc-tutorial body
 *   wireTutorialAccordionEvents(container) — attach click handlers
 *   isBannerDismissed() / markBannerDismissed()
 */

// Note: `tutorial-content` lazily imports types from this file (type-only, no runtime cycle).
// We import TRACKS / getTrackById eagerly so accordion + step rendering can be synchronous.
import { DEEP_TOUR_DESCRIPTOR, DEEP_TOUR_SEQUENCE, getTrackById, TRACKS } from './tutorial-content';
import { enterTutorialDemoMode, exitTutorialDemoMode, TutorialPreflightError } from './tutorial-demo';
import { showToast } from './ui-modal';

// ─── Types (exported for tutorial-content.ts) ────────────────────────────────

/** Reserved for forward compatibility. The tour runs against curated demo
 *  state loaded on entry, so per-step preconditions / context callbacks
 *  are no longer needed. */
export type TutorialContext = Record<string, never>;

export interface TutorialStep {
  id: string;
  /** CSS selector for anchor element, or null = centred dialog. */
  target: string | null;
  placement: 'top' | 'bottom' | 'inline-start' | 'inline-end' | 'auto' | 'center';
  title: string;
  /** Hebrew copy. May contain limited HTML (<strong>, <em>). */
  body: string;
  /** Optional embedded screenshot. */
  screenshot?: { src: string; alt: string };
  /** Engine should `.click()` the tab button before showing this step. */
  switchToTab?: 'participants' | 'task-rules' | 'schedule' | 'algorithm';
  /** Engine should ensure these accordion ids are open before showing. */
  openAccordion?: string | string[];
  /** Engine should expand the first `.template-card` if it is collapsed. */
  expandFirstTemplate?: boolean;
  /** Engine should open the first template card's "מתקדם" disclosure (where
   * sleep-recovery and load-windows now live). Requires the card to be expanded
   * first, so pair with `expandFirstTemplate`. */
  expandAdvanced?: boolean;
  /** Engine should put the first participant row into edit mode (clicks the
   * row's pencil icon). Needed for steps that point at controls only rendered
   * inside an expanded row (e.g. the unavailability editor). */
  expandFirstParticipant?: boolean;
  /** Engine should open the *create* participant sheet. */
  openAddParticipant?: boolean;
  /** Engine should dispatch a synthetic `mouseover` on the target so a hover
   *  tooltip / popover surfaces before the next step spotlights its button. */
  hoverTarget?: boolean;
  /** Mobile-specific overrides applied when matchMedia(max-width:767px). */
  mobileOverride?: Partial<Pick<TutorialStep, 'target' | 'placement' | 'body' | 'title'>>;
}

export interface TutorialTrack {
  id: string;
  label: string;
  icon: string;
  description: string;
  steps: TutorialStep[];
  switchToTab?: 'participants' | 'task-rules' | 'schedule' | 'algorithm';
  /** Programmatically open this overlay view before track starts. */
  enterView?: 'profile' | 'task-panel';
}

// ─── Storage keys ────────────────────────────────────────────────────────────

const KEY_BANNER_DISMISSED = 'gardenmanager_tutorial_banner_dismissed';
const KEY_SEEN_TRACKS = 'gardenmanager_tutorial_seen_tracks';
const KEY_HOME_WELCOME_SEEN = 'gardenmanager_home_welcome_seen';

export function isBannerDismissed(): boolean {
  try {
    return localStorage.getItem(KEY_BANNER_DISMISSED) === '1';
  } catch {
    return false;
  }
}

export function markBannerDismissed(): void {
  try {
    localStorage.setItem(KEY_BANNER_DISMISSED, '1');
  } catch {
    /* storage full — banner will reappear on next load, acceptable */
  }
}

/**
 * One-time gate for the home first-run welcome. Set the first time a genuine
 * newcomer's home screen renders, so the welcome shows exactly once ever — not
 * again on app reopen, header-title navigation, or any later re-render.
 * Cleared by factory reset (same as the banner-dismissed flag).
 */
export function isHomeWelcomeSeen(): boolean {
  try {
    return localStorage.getItem(KEY_HOME_WELCOME_SEEN) === '1';
  } catch {
    return false;
  }
}

export function markHomeWelcomeSeen(): void {
  try {
    localStorage.setItem(KEY_HOME_WELCOME_SEEN, '1');
  } catch {
    /* storage full — welcome may show again next load, acceptable */
  }
}

function getSeenTracks(): string[] {
  try {
    const raw = localStorage.getItem(KEY_SEEN_TRACKS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function markTrackSeen(id: string): void {
  try {
    const seen = getSeenTracks();
    if (!seen.includes(id)) {
      seen.push(id);
      localStorage.setItem(KEY_SEEN_TRACKS, JSON.stringify(seen));
    }
  } catch {
    /* ignore */
  }
}

// ─── Internal state ──────────────────────────────────────────────────────────

let _activeTrackId: string | null = null;
let _stepIdx = 0;
// Deep-tour playlist: remaining track ids to run after the current one. Empty
// for every normal single-track tour. `_deepTour` gates the macro caption so a
// standalone topic track never shows "מסלול N מתוך 6".
let _trackQueue: string[] = [];
let _deepTour = false;
let _root: HTMLElement | null = null;
let _backdrop: HTMLElement | null = null;
let _spotlight: HTMLElement | null = null;
let _popover: HTMLElement | null = null;
let _previouslyFocused: HTMLElement | null = null;
let _mqListener: ((e: MediaQueryListEvent) => void) | null = null;
let _mql: MediaQueryList | null = null;
let _resizeListener: (() => void) | null = null;
let _scrollListener: (() => void) | null = null;
let _scrollRafQueued = false;
let _domObserver: MutationObserver | null = null;
let _beforeUnloadListener: ((e: BeforeUnloadEvent) => void) | null = null;
let _internalClickFlag = false;
// Monotonic counter incremented on every renderStep call. Each in-flight
// `renderStep` captures the current value at entry and checks it after every
// await — if a newer render or `exitTutorial` started in the meantime, the
// stale render bails before touching DOM. Without this, spamming Next throws
// `Cannot set properties of null` when an old promise resumes after exit.
let _renderToken = 0;
// Most recent element a previous step requested a synthetic hover on. The
// next step can re-fire the hover to keep tooltips alive across the
// transition (e.g. s-8 surfaces the participant tooltip, s-8-action targets
// `.btn-swap` inside that tooltip — without re-hover, any mouse motion or
// scroll between the two steps dismisses the tooltip).
let _lastHoverTarget: HTMLElement | null = null;

export function getCurrentTrack(): string | null {
  return _activeTrackId;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function startTutorial(trackId: string, _ctx: TutorialContext): Promise<void> {
  if (_activeTrackId) exitTutorial();

  // 'deep-tour' is a meta id (not a TutorialTrack): expand it into a playlist
  // of the six topic tracks. Intercepted here so every per-step path that does
  // getTrackById(_activeTrackId) only ever sees a real track id.
  const isDeep = trackId === 'deep-tour';
  const sequence: string[] = isDeep ? [...DEEP_TOUR_SEQUENCE] : [];
  const firstTrackId = isDeep ? (sequence.shift() as string) : trackId;

  const track = getTrackById(firstTrackId);
  if (!track) {
    console.warn('[tutorial] unknown track:', firstTrackId);
    return;
  }

  // Pre-tour gate: refuse to enter demo mode if it would discard in-memory
  // unsaved work. Surfaces a toast and returns.
  try {
    enterTutorialDemoMode();
  } catch (err) {
    if (err instanceof TutorialPreflightError) {
      const message =
        err.reason === 'manual-build'
          ? 'סיים את העריכה הידנית לפני התחלת המדריך.'
          : err.reason === 'modal-open'
            ? 'סגור את החלון לפני התחלת המדריך.'
            : 'סגור את גיליון העריכה לפני התחלת המדריך.';
      showToast(message, { type: 'warning', duration: 4500 });
      return;
    }
    console.error('[tutorial] failed to load demo state:', err);
    showToast('טעינת נתוני הדגמה נכשלה — נסה לרענן את הדף.', { type: 'error', duration: 5000 });
    return;
  }

  // Banner dismissal — opening the tutorial counts.
  markBannerDismissed();
  removeBannerIfPresent();

  _activeTrackId = firstTrackId;
  _stepIdx = 0;
  // Seed the playlist only after the demo-mode preflight succeeded above, so an
  // aborted start never leaves a stale queue behind.
  _trackQueue = sequence;
  _deepTour = isDeep;
  _previouslyFocused = (document.activeElement as HTMLElement) ?? null;

  mountOverlay();
  installListeners();

  await applyTrackSetup(track);

  await renderStep(0);
}

export function exitTutorial(): void {
  if (!_activeTrackId) return;
  _renderToken++;
  try {
    uninstallListeners();
    // If the engine programmatically opened the participant editor sheet during
    // the tutorial (expandFirstParticipant), close it on exit so the still-mounted
    // backdrop doesn't swallow the user's next click.
    const sheetCancel = document.querySelector<HTMLElement>('.gm-edit-sheet-v2 [data-pe-cancel]');
    if (sheetCancel) {
      _internalClickFlag = true;
      sheetCancel.click();
      _internalClickFlag = false;
    }
    if (_root) {
      _root.remove();
      _root = null;
      _backdrop = null;
      _spotlight = null;
      _popover = null;
    }
    markBackgroundInert(false);
    // Hide any participant tooltip the tour surfaced via synthetic hover —
    // the user's pointer was never inside it, so its host's mouseleave timer
    // won't fire and the tooltip would otherwise stay until the next render.
    document.querySelectorAll<HTMLElement>('.participant-tooltip').forEach((tt) => {
      tt.style.display = 'none';
    });
    if (_previouslyFocused?.focus) {
      try {
        _previouslyFocused.focus();
      } catch {
        /* ignore */
      }
    }
    _previouslyFocused = null;
    _activeTrackId = null;
    _stepIdx = 0;
    _lastHoverTarget = null;
    // Clear the deep-tour playlist so an interrupt (Esc, exit button, overlay
    // teardown, or starting another tour) cannot resume it.
    _trackQueue = [];
    _deepTour = false;
  } finally {
    // Always restore the user's snapshot — even if the cleanup above threw.
    exitTutorialDemoMode();
  }
}

// ─── First-launch banner ─────────────────────────────────────────────────────

let _bannerEl: HTMLElement | null = null;

export function showTutorialBanner(ctx: TutorialContext): void {
  if (_bannerEl || isBannerDismissed()) return;

  const banner = document.createElement('div');
  banner.className = 'tutorial-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span class="tutorial-banner-icon" aria-hidden="true">📖</span>
    <span class="tutorial-banner-text"><strong>חדש כאן?</strong> סיור מודרך קצר מציג את כל חלקי המערכת.</span>
    <span class="tutorial-banner-actions">
      <button type="button" class="btn-sm btn-primary" data-tutorial-banner-action="start">📖 פתח מדריך</button>
      <button type="button" class="btn-sm btn-outline" data-tutorial-banner-action="dismiss">לא עכשיו</button>
    </span>
    <button type="button" class="tutorial-banner-close" aria-label="סגור" data-tutorial-banner-action="dismiss">×</button>
  `;

  // Insert before the tab nav so it sits between header and tabs
  const nav = document.querySelector('nav.tab-nav');
  if (nav?.parentElement) {
    nav.parentElement.insertBefore(banner, nav);
  } else {
    document.body.prepend(banner);
  }

  banner.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement)?.closest<HTMLElement>('[data-tutorial-banner-action]')?.dataset
      .tutorialBannerAction;
    if (!action) return;
    if (action === 'start') {
      // markBannerDismissed is called inside startTutorial too, but do it
      // explicitly so a guard-failure path also clears the banner.
      markBannerDismissed();
      removeBannerIfPresent();
      void startTutorial('full-tour', ctx);
    } else if (action === 'dismiss') {
      markBannerDismissed();
      removeBannerIfPresent();
    }
  });

  _bannerEl = banner;
}

function removeBannerIfPresent(): void {
  if (_bannerEl) {
    _bannerEl.remove();
    _bannerEl = null;
  }
  // Defensive: also remove any stale banner from the DOM
  for (const el of document.querySelectorAll('.tutorial-banner')) el.remove();
}

// ─── Tutorial-launcher accordion ─────────────────────────────────────────────

export function renderTutorialAccordionBody(_ctx: TutorialContext): string {
  const seen = new Set(getSeenTracks());

  const card = (
    entry: { id: string; icon: string; label: string; description: string },
    isSeen: boolean,
    isOverview: boolean,
  ): string => `
      <button type="button" class="tutorial-track-btn${
        isOverview ? ' tutorial-track-btn--overview' : ''
      }" data-tutorial-track="${entry.id}" title="${escAttrLite(entry.description)}">
        <span class="tutorial-track-btn-row">
          <span class="tutorial-track-icon" aria-hidden="true">${entry.icon}</span>
          <span class="tutorial-track-label">${escHtmlLite(entry.label)}</span>
          ${isSeen ? '<span class="tutorial-track-seen" aria-label="הושלם">✓</span>' : ''}
        </span>
        <span class="tutorial-track-desc">${escHtmlLite(entry.description)}</span>
      </button>
    `;

  // Flat list: the two overview tours first (full-tour, then the deep tour),
  // both flagged --overview for the accent rail, then the six topic tracks in
  // their original order. The deep tour is a meta entry (not in TRACKS); its
  // ✓ derives from having completed all six topic tracks.
  const fullTour = TRACKS.find((t) => t.id === 'full-tour');
  const topicTracks = TRACKS.filter((t) => t.id !== 'full-tour');
  const deepSeen = DEEP_TOUR_SEQUENCE.every((id) => seen.has(id));

  const trackButtons = [
    fullTour ? card(fullTour, seen.has(fullTour.id), true) : '',
    card(DEEP_TOUR_DESCRIPTOR, deepSeen, true),
    ...topicTracks.map((t) => card(t, seen.has(t.id), false)),
  ].join('');

  return `
    <div class="tutorial-launcher-body">
      <p class="tutorial-launcher-intro">בחר מדריך — המערכת תדריך אותך שלב אחר שלב, וניתן לצאת בכל עת. הסיור משתמש בנתוני הדגמה זמניים; הנתונים שלך יוחזרו אוטומטית ביציאה.</p>
      <div class="tutorial-track-list">${trackButtons}</div>
    </div>
  `;
}

export function wireTutorialAccordionEvents(container: HTMLElement, ctx: TutorialContext): void {
  container.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.tutorial-track-btn');
    if (!btn) return;
    const trackId = btn.dataset.tutorialTrack;
    if (!trackId) return;
    void startTutorial(trackId, ctx);
  });
}

// ─── Internals: overlay mount / unmount ──────────────────────────────────────

function mountOverlay(): void {
  _root = document.createElement('div');
  _root.className = 'tutorial-root';

  _backdrop = document.createElement('div');
  _backdrop.className = 'tutorial-backdrop tutorial-backdrop-centered';
  // Clicks on the dim area outside the spotlight hole and outside the popover
  // hit the backdrop. Pulse the spotlight + toast once per few seconds so the
  // user understands the tour is gating their input.
  _backdrop.addEventListener('click', onBackdropClick);

  _spotlight = document.createElement('div');
  _spotlight.className = 'tutorial-spotlight tutorial-spotlight-centered';

  _popover = document.createElement('div');
  _popover.className = 'tutorial-popover';
  _popover.setAttribute('role', 'dialog');
  _popover.setAttribute('aria-modal', 'false');
  _popover.setAttribute('aria-live', 'polite');

  _root.appendChild(_backdrop);
  _root.appendChild(_spotlight);
  _root.appendChild(_popover);
  document.body.appendChild(_root);

  // Mark every other top-level element as `inert` so Tab focus can't escape
  // the popover into background UI (Undo, Delete, tab buttons, etc.) and
  // keyboard Enter on a leaked focus can't fire real actions. Without this,
  // the dim backdrop blocks mouse clicks but does nothing for keyboard.
  markBackgroundInert(true);
}

const _inertedNodes: HTMLElement[] = [];
function markBackgroundInert(on: boolean): void {
  if (on) {
    _inertedNodes.length = 0;
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child === _root) continue;
      // Don't inert the toast container — toasts (including the "tour active"
      // backdrop-click toast) need to surface above the overlay.
      if (child.classList.contains('gm-toast-container')) continue;
      if (child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      _inertedNodes.push(child);
    }
  } else {
    for (const node of _inertedNodes) {
      node.removeAttribute('inert');
    }
    _inertedNodes.length = 0;
  }
}

let _lastBackdropToastAt = 0;
function onBackdropClick(): void {
  // Pulse the spotlight to draw the eye back to the active target.
  if (_spotlight) {
    _spotlight.classList.remove('tutorial-spotlight-pulse');
    // Force reflow so the animation restarts.
    void _spotlight.offsetWidth;
    _spotlight.classList.add('tutorial-spotlight-pulse');
  }
  // Rate-limit the toast — repeated clicks shouldn't flood notifications.
  const now = Date.now();
  if (now - _lastBackdropToastAt < 2500) return;
  _lastBackdropToastAt = now;
  showToast('המדריך פעיל — השתמש בכפתורי "המשך" / "יציאה" כדי להתקדם.', {
    type: 'info',
    duration: 2500,
  });
}

// ─── Internals: render a single step ─────────────────────────────────────────

async function renderStep(idx: number): Promise<void> {
  if (!_activeTrackId || !_popover || !_spotlight) return;

  const track = getTrackById(_activeTrackId);
  if (!track) return exitTutorial();

  if (idx < 0 || idx >= track.steps.length) {
    // Past the end → mark as complete. In a deep tour, advance to the next
    // queued track WITHOUT exiting (demo state must persist across all six,
    // restored exactly once at the very end). This branch precedes the
    // _renderToken capture below, so the recursive renderStep(0) captures its
    // own fresh token. idx<0 (Back before step 0) keeps the original behaviour
    // and never advances the queue — Back is disabled at step 0 anyway.
    const completedForward = idx >= track.steps.length;
    markTrackSeen(track.id);
    if (completedForward && _trackQueue.length > 0) {
      const nextId = _trackQueue.shift() as string;
      const nextTrack = getTrackById(nextId);
      if (nextTrack) {
        _activeTrackId = nextId;
        _stepIdx = 0;
        await applyTrackSetup(nextTrack);
        await renderStep(0);
        return;
      }
      // Unknown queued id (should never happen) → fall through to clean exit.
    }
    exitTutorial();
    return;
  }
  _stepIdx = idx;

  // Capture a token at the start of this render. Every await below resumes
  // asynchronously, so by the time we touch `_popover.innerHTML` the tour may
  // already have exited (or a newer renderStep may have started). Bail on any
  // mismatch instead of throwing `Cannot set properties of null`.
  const token = ++_renderToken;
  const stillCurrent = (): boolean => token === _renderToken && !!_popover && !!_spotlight && _activeTrackId !== null;

  const stepRaw = track.steps[idx];
  const isMobile = !!_mql?.matches;
  const step: TutorialStep = isMobile && stepRaw.mobileOverride ? { ...stepRaw, ...stepRaw.mobileOverride } : stepRaw;

  // Pre-show: switch tab if requested
  if (step.switchToTab) await switchToTabProgrammatic(step.switchToTab);
  if (!stillCurrent()) return;

  // Pre-show: close the participant editor sheet if a previous step opened it
  // and the new step doesn't need it.
  if (!stepNeedsParticipantSheet(step)) await closeParticipantSheetIfOpen();
  if (!stillCurrent()) return;

  // Pre-show: close the mobile workload sidebar drawer if not the current target.
  if (!stepNeedsMobileSidebar(step)) closeMobileSidebarIfOpen();
  if (!stillCurrent()) return;

  // Pre-show: open accordions if requested
  if (step.openAccordion) {
    const ids = Array.isArray(step.openAccordion) ? step.openAccordion : [step.openAccordion];
    for (const id of ids) {
      await openAccordionProgrammatic(id);
      if (!stillCurrent()) return;
    }
  }

  if (step.expandFirstTemplate) await expandFirstTemplateCard();
  if (!stillCurrent()) return;
  if (step.expandAdvanced) await expandFirstTemplateAdvanced();
  if (!stillCurrent()) return;
  if (step.expandFirstParticipant) await expandFirstParticipantRow();
  if (!stillCurrent()) return;
  if (step.openAddParticipant) await openAddParticipantSheet();
  if (!stillCurrent()) return;

  // Wait one rAF for any rerender / transition to settle
  await rAFAsync();
  if (!stillCurrent()) return;

  // If this tour entered a dedicated view (profile or task-panel) and the
  // view's root has been torn down (e.g. background JS closed it), the
  // remaining steps would walk an empty overlay over the schedule grid.
  // Exit cleanly with a toast instead.
  if (track.enterView === 'profile' && !document.querySelector('.profile-view-root')) {
    showToast('המסך נסגר; המדריך נסגר.', { type: 'info', duration: 2500 });
    exitTutorial();
    return;
  }
  if (track.enterView === 'task-panel' && !document.querySelector('.task-panel-view-root')) {
    showToast('המסך נסגר; המדריך נסגר.', { type: 'info', duration: 2500 });
    exitTutorial();
    return;
  }

  // If this step's target sits inside a hover-anchored popup (currently only
  // `.participant-tooltip` after `hoverTarget: true`), re-fire the synthetic
  // hover on the previous anchor so the popup is back in the DOM and its
  // children resolve. Without this, any mouse motion or resize between the
  // two steps dismisses the tooltip and we'd query a zero-rect target.
  const stepTargetsTooltip = !!step.target && /\.participant-tooltip\b/.test(step.target);
  if (stepTargetsTooltip && _lastHoverTarget?.isConnected) {
    dispatchSyntheticHover(_lastHoverTarget);
    await rAFAsync();
    if (!stillCurrent()) return;
  } else if (_lastHoverTarget && !step.hoverTarget && !stepTargetsTooltip) {
    // Leaving the hover-anchored sequence — dismiss the tooltip so it doesn't
    // linger over the next step's content (e.g. Back from s-8 to s-7 leaves
    // the participant tooltip floating over the violations panel).
    dispatchSyntheticLeave(_lastHoverTarget);
    _lastHoverTarget = null;
  }

  // Resolve target
  let targetEl: HTMLElement | null = null;
  if (step.target) {
    targetEl = document.querySelector<HTMLElement>(step.target);
  }

  // Render popover content
  const stepCounter = `שלב ${idx + 1} מתוך ${track.steps.length}`;
  const isLast = idx === track.steps.length - 1;
  // Macro progress for the deep tour: which of the six topic tracks we're in.
  const deepOrdinal = _deepTour ? (DEEP_TOUR_SEQUENCE as readonly string[]).indexOf(track.id) + 1 : 0;
  // The deep tour only truly ends when the current track is last AND no more
  // tracks are queued — otherwise "✓ סיים" would lie mid-playlist.
  const isFinalStep = isLast && _trackQueue.length === 0;
  const screenshotHtml = step.screenshot
    ? `<img class="tutorial-screenshot" src="${escAttrLite(step.screenshot.src)}" alt="${escAttrLite(
        step.screenshot.alt,
      )}">`
    : '';
  const progressPct = Math.round(((idx + 1) / track.steps.length) * 100);
  _popover.innerHTML = `
    ${
      _deepTour
        ? `<div class="tutorial-tour-track">סיור מעמיק · מסלול ${deepOrdinal} מתוך ${DEEP_TOUR_SEQUENCE.length} · ${escHtmlLite(
            track.label,
          )}</div>`
        : ''
    }
    <div class="tutorial-step-counter">${escHtmlLite(stepCounter)}</div>
    <div class="tutorial-progress" aria-hidden="true"><div class="tutorial-progress-fill" style="width:${progressPct}%"></div></div>
    <h3 class="tutorial-title" id="tutorial-title-${escAttrLite(step.id)}">${escHtmlLite(step.title)}</h3>
    <div class="tutorial-body">${step.body}</div>
    ${screenshotHtml}
    <div class="tutorial-footer">
      <button type="button" class="tutorial-btn tutorial-btn-primary${
        isFinalStep ? ' tutorial-btn-finish' : ''
      }" data-tutorial-action="next">${isFinalStep ? '✓ סיים' : '← המשך'}</button>
      <button type="button" class="tutorial-btn tutorial-btn-secondary" data-tutorial-action="back" ${
        idx === 0 ? 'disabled' : ''
      }>חזרה →</button>
      <button type="button" class="tutorial-btn tutorial-btn-ghost" data-tutorial-action="exit">יציאה מהמדריך</button>
    </div>
  `;
  _popover.setAttribute('aria-labelledby', `tutorial-title-${step.id}`);

  // Wire footer button clicks (delegated)
  _popover.onclick = (e) => {
    const action = (e.target as HTMLElement)?.closest<HTMLElement>('[data-tutorial-action]')?.dataset.tutorialAction;
    if (action === 'next') void renderStep(_stepIdx + 1);
    else if (action === 'back') void renderStep(_stepIdx - 1);
    else if (action === 'exit') exitTutorial();
  };

  // Position spotlight + popover
  if (targetEl) {
    scrollIntoViewIfNeeded(targetEl);
    await rAFAsync();
    if (!stillCurrent()) return;
    positionForTarget(targetEl, step.placement === 'center' ? 'auto' : step.placement);
    // Optional synthetic hover — surfaces the workload-popup tooltip that
    // step `s-8` (manual swap) describes so the next step's `⇄` button has
    // something to spotlight.
    if (step.hoverTarget) {
      dispatchSyntheticHover(targetEl);
      _lastHoverTarget = targetEl;
      // Wait one frame for the tooltip to mount, then re-aim the spotlight to
      // include both the trigger and the surfaced tooltip. Without this, the
      // halo sits on the tiny trigger cell while the body describes the
      // tooltip — especially confusing on mobile where the trigger is ~50px
      // wide and the tooltip is ~280px wide and floats elsewhere.
      await rAFAsync();
      if (!stillCurrent()) return;
      const tooltip = document.querySelector<HTMLElement>('.participant-tooltip');
      if (tooltip && tooltip.style.display !== 'none' && tooltip.offsetWidth > 0) {
        positionForUnion(targetEl, tooltip, step.placement === 'center' ? 'auto' : step.placement);
      }
    }
  } else {
    positionCentered();
  }

  // Focus the primary button so keyboard nav works
  requestAnimationFrame(() => {
    const next = _popover?.querySelector<HTMLButtonElement>('[data-tutorial-action="next"]');
    next?.focus();
  });
}

function dispatchSyntheticHover(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts: MouseEventInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
  el.dispatchEvent(new MouseEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
}

function dispatchSyntheticLeave(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left - 50,
    clientY: rect.top - 50,
    view: window,
  };
  el.dispatchEvent(new MouseEvent('mouseout', opts));
  el.dispatchEvent(new MouseEvent('mouseleave', opts));
  el.dispatchEvent(new MouseEvent('pointerout', opts));
  el.dispatchEvent(new MouseEvent('pointerleave', opts));
  // Hard-dismiss the tooltip directly — the host listens for mouseleave with a
  // hide-delay timer, so a synthetic leave alone leaves the tooltip visible
  // for a moment. The tour can't rely on the user moving their physical mouse.
  document.querySelectorAll<HTMLElement>('.participant-tooltip').forEach((tt) => {
    tt.style.display = 'none';
  });
}

// ─── Positioning ─────────────────────────────────────────────────────────────

function scrollIntoViewIfNeeded(el: HTMLElement): void {
  // First, walk up the scrolling-ancestor chain so any inner scroll container
  // (e.g. the participant editor sheet's `.pe-body`) brings the target into
  // its own visible window. The native `scrollIntoView` does this for free —
  // we only handle the outer window scroll manually below to control the gap.
  // Without this, targets like `[data-pe-unavail-add]` (rendered far down in
  // the sheet body) report off-viewport rects and the spotlight falls back to
  // centered — which then leaves a stale halo behind from the previous step.
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });

  const vh = window.innerHeight;
  // On mobile the bottom-sheet popover covers ~half the viewport, so the
  // useful "above the sheet" area is roughly the top 50% — keep targets there.
  const isMobile = !!_mql?.matches;
  const upperBound = isMobile ? vh * 0.18 : 100;
  const lowerBound = isMobile ? vh * 0.45 : vh - 100;

  // If the target is inside the participant editor sheet, the bottom-sheet
  // popover on mobile can cover the lower portion of the sheet body. Scroll
  // the sheet's own inner scroll container so the target lands in the visible
  // band above where the popover sits. Window-level scrollTo below has no
  // effect on the sheet's inner scroll container.
  if (isMobile) {
    const sheet = el.closest('.gm-edit-sheet-v2');
    if (sheet) {
      const sheetScrollEl = (sheet.querySelector('.pe-body') as HTMLElement | null) ?? (sheet as HTMLElement);
      const r = el.getBoundingClientRect();
      const desiredFromTop = vh * 0.22;
      const overshoot = r.top - desiredFromTop;
      if (Math.abs(overshoot) > 4) {
        sheetScrollEl.scrollTop += overshoot;
      }
    }
  }

  const rect = el.getBoundingClientRect();
  if (rect.top < upperBound || rect.bottom > lowerBound) {
    // Compute the absolute scroll position that places the target's top edge
    // at our preferred offset from the viewport top. Manual scroll instead of
    // scrollIntoView so we control the gap precisely. `instant` bypasses the
    // page's scroll-behavior:smooth — getBoundingClientRect reads the new
    // position synchronously on return.
    const desiredFromTop = isMobile ? vh * 0.22 : vh * 0.28;
    const newScrollY = window.scrollY + rect.top - desiredFromTop;
    window.scrollTo({ top: Math.max(0, newScrollY), behavior: 'instant' as ScrollBehavior });
  }
}

/** Position the spotlight to cover the union of two elements' bounding rects.
 * Used after `hoverTarget` surfaces a tooltip — the user needs to see both the
 * trigger that "anchors" the tooltip and the tooltip itself. */
function positionForUnion(a: HTMLElement, b: HTMLElement, placement: TutorialStep['placement']): void {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  // Synthesize a wrapper element whose rect is the union — positionForTarget
  // reads from `getBoundingClientRect`, so the easiest reuse is to call it
  // with an object that mimics the same API on the spotlight side. Instead
  // we inline the relevant slice of positionForTarget for clarity.
  if (!_spotlight || !_popover) return;
  const top = Math.min(ra.top, rb.top);
  const left = Math.min(ra.left, rb.left);
  const right = Math.max(ra.right, rb.right);
  const bottom = Math.max(ra.bottom, rb.bottom);
  const unionRect = {
    top,
    left,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
  // Shim: temporarily override the union element's rect via a wrapper.
  const wrapper = document.createElement('div');
  Object.defineProperty(wrapper, 'getBoundingClientRect', { value: () => unionRect });
  positionForTarget(wrapper as HTMLElement, placement);
}

/** RTL pages with a left-side vertical scrollbar create a coord-system gap:
 * `getBoundingClientRect.left` is measured from the content-area's left edge
 * (where `x=0` is the right edge of the scrollbar), but `position: fixed`'s
 * `left` CSS property is measured from the **initial containing block**, which
 * starts `scrollbar-width` px earlier — at the visual viewport's left edge.
 * So writing `style.left = rect.left` lands the element `scrollbar-width` px
 * to the left of where the user reads it visually (the spotlight ends up
 * shifted left of its target — clearly visible at 375×815 with the DevTools
 * scrollbar on). Add this offset to every `style.left` write for fixed-position
 * tour elements to bridge the two systems. Returns 0 in LTR, or when the
 * scrollbar sits on the right / is hidden. */
function getFixedLeftCorrection(): number {
  const sbw = window.innerWidth - document.documentElement.clientWidth;
  if (sbw <= 0) return 0;
  return getComputedStyle(document.documentElement).direction === 'rtl' ? sbw : 0;
}

function positionForTarget(target: HTMLElement, placement: TutorialStep['placement']): void {
  if (!_spotlight || !_popover) return;
  const rect = target.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const leftFix = getFixedLeftCorrection();
  // Off-viewport target → fall back to centered. Without this guard, the
  // spotlight box-shadow renders invisibly off-screen and the popover lands
  // at negative coordinates (e.g. above the fold).
  if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw || rect.width === 0 || rect.height === 0) {
    positionCentered();
    return;
  }
  // Halo padding around the target. Start at 6px, then shrink if a horizontal
  // sibling sits inside that band — otherwise the halo's edge crowds the
  // neighbor (e.g. `+ משבצת` next to `+ תת-צוות` in `.template-actions`, where
  // the flex gap is only 8px, leaving ~2px between halo and neighbor — reads
  // as the spotlight "leaning into" the wrong button).
  let pad = 6;
  {
    const parent = target.parentElement;
    if (parent) {
      let minGap = Infinity;
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement) || child === target) continue;
        const cRect = child.getBoundingClientRect();
        const vOverlap = Math.min(cRect.bottom, rect.bottom) - Math.max(cRect.top, rect.top);
        if (vOverlap <= 0) continue;
        if (cRect.right <= rect.left) minGap = Math.min(minGap, rect.left - cRect.right);
        else if (cRect.left >= rect.right) minGap = Math.min(minGap, cRect.left - rect.right);
      }
      if (Number.isFinite(minGap)) {
        // Split the gap evenly between halo and neighbor, floored — so a tight
        // 8px gap yields pad=4 (4px between halo edge and neighbor edge).
        pad = Math.max(0, Math.min(pad, Math.floor(minGap / 2)));
      }
    }
  }
  // Spotlight rect (cutout) — pad up to a minimum so very thin elements
  // (e.g. range sliders are ~6px tall) still produce a visible halo.
  const minHalo = 24;
  const haloW = Math.max(rect.width + pad * 2, minHalo);
  const haloH = Math.max(rect.height + pad * 2, minHalo);
  const haloTop = rect.top + rect.height / 2 - haloH / 2;
  const haloLeftPx = rect.left + rect.width / 2 - haloW / 2;
  // Only clip the halo to the viewport when it's *larger* than the viewport
  // (over-tall / over-wide targets — expanded accordions, full-width grids —
  // where an unclipped halo would push the inverse box-shadow entirely past
  // the viewport and the dim would disappear). For normal-sized halos that
  // happen to sit flush with an edge (e.g. the participants tab in RTL bottom
  // nav, whose `right` is 375.2 in a 375px viewport), per-side clipping would
  // produce an asymmetric cutout — 6px padding on one side, 0px on the other,
  // read as a "leftward tilt". Skipping the clip lets the offscreen portion of
  // the halo simply be invisible, while the visible portion stays centered on
  // the target's visible portion.
  const horizOversize = haloW > vw;
  const vertOversize = haloH > vh;
  const spotlightLeft = horizOversize ? Math.max(haloLeftPx, 0) : haloLeftPx;
  const spotlightWidth = horizOversize ? Math.max(0, Math.min(haloLeftPx + haloW, vw) - spotlightLeft) : haloW;
  const spotlightTop = vertOversize ? Math.max(haloTop, 0) : haloTop;
  const spotlightHeight = vertOversize ? Math.max(0, Math.min(haloTop + haloH, vh) - spotlightTop) : haloH;
  _spotlight.classList.remove('tutorial-spotlight-centered');
  _backdrop?.classList.remove('tutorial-backdrop-centered');
  _spotlight.style.top = `${spotlightTop}px`;
  _spotlight.style.left = `${spotlightLeft + leftFix}px`;
  _spotlight.style.width = `${spotlightWidth}px`;
  _spotlight.style.height = `${spotlightHeight}px`;

  // Popover dimensions (must measure after content render)
  _popover.classList.remove('tutorial-popover-centered');
  _popover.style.top = '';
  _popover.style.left = '';
  _popover.style.right = '';
  _popover.style.bottom = '';
  // Force reflow to get accurate dimensions
  const pw = _popover.offsetWidth;
  const ph = _popover.offsetHeight;

  // On mobile (<=767px) the popover is a sheet via CSS, always anchored to
  // the bottom of the viewport. When the spotlit target sits in the lower
  // half of the screen the sheet "lifts" just enough to clear the target
  // (with its halo + a small gap) so it stays visible below the sheet. This
  // replaces the older top-sheet flip, which broke spatial continuity —
  // every step the user had to re-find the popover at the opposite edge.
  if (_mql?.matches) {
    _popover.classList.remove('tutorial-popover-top-sheet');
    // For tall targets (taller than the usable viewport), lifting can't help —
    // the spotlight covers the full height anyway. Default bottom sheet keeps
    // the upper portion of the target visible above the sheet.
    const MIN_SHEET_VISIBLE = 200;
    if (haloH > vh - MIN_SHEET_VISIBLE) {
      _popover.classList.remove('tutorial-popover-lifted');
      _popover.style.removeProperty('--tutorial-popover-lift');
      _popover.style.removeProperty('--tutorial-popover-max-h');
      return;
    }
    const targetCenterY = rect.top + rect.height / 2;
    const inLowerHalf = targetCenterY > vh * 0.5;
    if (inLowerHalf) {
      const gap = 12;
      // haloTop = top of the spotlight cutout. Lift = distance from viewport
      // bottom to the sheet's bottom edge. We want the sheet's bottom edge to
      // sit above haloTop with a small gap so the halo is fully visible.
      const haloTop = rect.top + rect.height / 2 - haloH / 2;
      const rawLift = Math.max(0, vh - haloTop + gap);
      // CRITICAL: cap the lift so the sheet's bottom edge stays inside the
      // viewport (lift > vh would push the entire popover above the screen).
      // Reserve at least MIN_SHEET_VISIBLE px from the bottom so the sheet is
      // always reachable.
      const maxLift = Math.max(0, vh - MIN_SHEET_VISIBLE);
      const lift = Math.min(rawLift, maxLift);
      // Cap max-height so the sheet never extends past the viewport top.
      // 16px breathing room; minimum 160px so the sheet stays readable.
      const maxH = Math.max(160, vh - lift - 16);
      _popover.classList.add('tutorial-popover-lifted');
      _popover.style.setProperty('--tutorial-popover-lift', `${lift}px`);
      _popover.style.setProperty('--tutorial-popover-max-h', `${maxH}px`);
    } else {
      _popover.classList.remove('tutorial-popover-lifted');
      _popover.style.removeProperty('--tutorial-popover-lift');
      _popover.style.removeProperty('--tutorial-popover-max-h');
    }
    return;
  }
  // Desktop: clear any leftover mobile classes from a prior orientation.
  _popover.classList.remove('tutorial-popover-top-sheet');
  _popover.classList.remove('tutorial-popover-lifted');

  // Use the inflated halo bounds (not the raw rect) so the popover clears the
  // halo, not the bare element. Without this, short targets (tab buttons,
  // single-line buttons) end up with the popover top-edge clipping the halo.
  const haloLeft = rect.left + rect.width / 2 - haloW / 2;
  const haloRight = haloLeft + haloW;
  const haloTopRect = rect.top + rect.height / 2 - haloH / 2;
  const haloBottomRect = haloTopRect + haloH;

  // Clip to viewport when the target is taller/wider than the screen
  // (schedule grid, expanded accordion). Otherwise fits.* would always be
  // false and we'd centred-fallback with no spatial cue.
  const visTop = Math.max(haloTopRect, 0);
  const visBottom = Math.min(haloBottomRect, vh);
  const visLeft = Math.max(haloLeft, 0);
  const visRight = Math.min(haloRight, vw);

  // Resolve placement with auto-flip
  const fits = {
    bottom: visBottom + 12 + ph <= vh,
    top: visTop - 12 - ph >= 0,
    'inline-start': visLeft - 12 - pw >= 0,
    'inline-end': visRight + 12 + pw <= vw,
  } as const;
  const order: Array<keyof typeof fits> =
    placement === 'auto'
      ? ['bottom', 'top', 'inline-end', 'inline-start']
      : [placement as keyof typeof fits, 'bottom', 'top', 'inline-end', 'inline-start'];
  const chosen = order.find((p) => fits[p]);

  if (!chosen) {
    // No placement leaves room for the popover next to the (clipped) halo —
    // happens when the target spans the full viewport (expanded accordion,
    // wide grid). Keep the clipped spotlight visible and pin the popover to
    // the bottom of the viewport (mobile-sheet-like) so the user still has a
    // spatial cue rather than a 0×0 centered halo.
    _popover.classList.remove('tutorial-popover-centered');
    _popover.style.left = `${clamp((vw - pw) / 2, 8, vw - pw - 8) + leftFix}px`;
    _popover.style.top = `${vh - ph - 12}px`;
    return;
  }

  const gap = 12;
  let top = 0;
  let left = 0;
  // Anchor on the visible-clipped halo edges so over-tall targets still get
  // a spatially-meaningful popover position (next to the visible portion).
  const anchorTop = Math.max(visTop, 8);
  const anchorBottom = Math.min(visBottom, vh - 8);
  const anchorLeft = Math.max(visLeft, 8);
  const anchorRight = Math.min(visRight, vw - 8);
  const anchorCenterX = (anchorLeft + anchorRight) / 2;
  const anchorCenterY = (anchorTop + anchorBottom) / 2;
  if (chosen === 'bottom') {
    top = anchorBottom + gap;
    left = clamp(anchorCenterX - pw / 2, 8, vw - pw - 8);
  } else if (chosen === 'top') {
    top = anchorTop - gap - ph;
    left = clamp(anchorCenterX - pw / 2, 8, vw - pw - 8);
  } else if (chosen === 'inline-end') {
    top = clamp(anchorCenterY - ph / 2, 8, vh - ph - 8);
    left = anchorRight + gap;
  } else {
    /* inline-start */
    top = clamp(anchorCenterY - ph / 2, 8, vh - ph - 8);
    left = anchorLeft - gap - pw;
  }
  _popover.style.top = `${top}px`;
  _popover.style.left = `${left + leftFix}px`;
}

/** Re-evaluate the current step's target rect and re-run positioning, without
 * triggering a scroll. Called from the scroll listener so the spotlight halo
 * (and on desktop, the popover) follows the target as the user scrolls around
 * to read context. */
function repositionCurrentStep(): void {
  if (!_activeTrackId || !_popover || !_spotlight) return;
  const track = getTrackById(_activeTrackId);
  if (!track) return;
  const stepRaw = track.steps[_stepIdx];
  if (!stepRaw) return;
  const isMobile = !!_mql?.matches;
  const step: TutorialStep = isMobile && stepRaw.mobileOverride ? { ...stepRaw, ...stepRaw.mobileOverride } : stepRaw;
  if (!step.target) return; // centered step — nothing to track
  const targetEl = document.querySelector<HTMLElement>(step.target);
  if (!targetEl) return;
  positionForTarget(targetEl, step.placement === 'center' ? 'auto' : step.placement);
}

function positionCentered(): void {
  if (!_spotlight || !_popover) return;
  _spotlight.classList.add('tutorial-spotlight-centered');
  _backdrop?.classList.add('tutorial-backdrop-centered');
  // Clear inline styles from any prior positionForTarget call. The centered
  // class sets top/left/width/height via CSS, but inline styles win — without
  // this reset, transitioning from a positioned step (step 4 = group pill) to
  // a centered fallback (step 5 = off-viewport target) leaves the halo stuck
  // at the previous step's coordinates.
  _spotlight.style.top = '';
  _spotlight.style.left = '';
  _spotlight.style.width = '';
  _spotlight.style.height = '';
  _popover.classList.add('tutorial-popover-centered');
  _popover.classList.remove('tutorial-popover-top-sheet');
  _popover.style.top = '';
  _popover.style.left = '';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ─── Programmatic UI control ─────────────────────────────────────────────────

async function switchToTabProgrammatic(tab: string): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) return;
  if (btn.classList.contains('tab-active')) return;
  // Defensive: if the participant editor sheet is open from a prior
  // expandFirstParticipant step, dismiss it so its modal backdrop doesn't
  // intercept the next tab click. The sheet is a `.gm-modal-backdrop` that
  // spans the viewport and would swallow the tab click otherwise.
  const sheetCancel = document.querySelector<HTMLElement>('.gm-edit-sheet-v2 [data-pe-cancel]');
  if (sheetCancel) {
    _internalClickFlag = true;
    sheetCancel.click();
    _internalClickFlag = false;
    await rAFAsync();
  }
  _internalClickFlag = true;
  btn.click();
  _internalClickFlag = false;
  // renderAll() is synchronous, but the click handler is async (canLeaveParticipantsTab)
  // Wait for two microtask flushes + one rAF to be safe.
  await new Promise((r) => setTimeout(r, 0));
  await rAFAsync();
}

async function expandFirstTemplateCard(): Promise<void> {
  // tab-task-rules.ts mixes regular templates, one-time tasks, and the
  // rest-rules global-settings card under the same `.template-card` class.
  // The first card in DOM order is always the first regular template (those
  // render first in `renderTaskRulesTab`), but scope the selector explicitly
  // so future reordering can't silently retarget us.
  const card = document.querySelector<HTMLElement>('.template-card[data-template-id]');
  if (!card) return;
  // Expansion state is tracked in tab-task-rules.ts via `expandedTemplateId`,
  // which controls whether the `.template-body` child is rendered — the card
  // div itself never receives an `expanded` CSS class. Checking `classList`
  // here would therefore always be false, so every expandFirstTemplate step
  // would blindly click the header and TOGGLE the card. On consecutive steps
  // (t-5 → t-7b in the full tour, or t-5 → t-6 → t-7b → t-8 → t-8b in the
  // task-rules track) this collapses a previously-expanded card, the
  // precondition then fails because the target lives in `.template-body`,
  // and the user sees a centered fallback popover with the sleep-recovery /
  // load-windows section gone from the page.
  if (card.querySelector('.template-body')) return;
  const header = card.querySelector<HTMLElement>('.template-header[data-action="toggle-template"]');
  if (!header) return;
  _internalClickFlag = true;
  header.click();
  _internalClickFlag = false;
  // Card-expand transition isn't animated; one rAF lets the slot rows render.
  await rAFAsync();
}

async function expandFirstTemplateAdvanced(): Promise<void> {
  // Sleep-recovery and load-windows live inside the collapsed "מתקדם" disclosure
  // (see renderAdvancedSection in tab-task-rules.ts). Steps t-7b / t-8b target
  // controls in there, so open it after the card itself is expanded.
  const card = document.querySelector<HTMLElement>('.template-card[data-template-id]');
  if (!card || !card.querySelector('.template-body')) return; // card must be expanded first
  if (card.querySelector('.adv-body')) return; // already open — `.adv-body` renders only when expanded
  const toggle = card.querySelector<HTMLElement>('[data-action="toggle-advanced"]');
  if (!toggle) return;
  _internalClickFlag = true;
  toggle.click();
  _internalClickFlag = false;
  await rAFAsync();
}

async function expandFirstParticipantRow(): Promise<void> {
  // No-op if the editor sheet is already open
  if (document.querySelector('.gm-edit-sheet-v2')) return;
  const editBtn = document.querySelector<HTMLElement>('[data-action="edit-participant"][data-pid]');
  if (!editBtn) return;
  _internalClickFlag = true;
  editBtn.click();
  _internalClickFlag = false;
  // Sheet renders synchronously into the body; wait briefly for the modal
  // backdrop + dialog to mount and the focus animation to settle.
  const sheet = await waitFor('.gm-edit-sheet-v2', 800);
  if (sheet) await waitForAnimations(sheet);
}

function stepNeedsMobileSidebar(step: TutorialStep): boolean {
  const t = step.target ?? '';
  return t.includes('.sidebar-fab') || t.includes('.participant-sidebar');
}

function closeMobileSidebarIfOpen(): void {
  const sidebar = document.querySelector<HTMLElement>('.participant-sidebar.sidebar-mobile-open');
  if (sidebar) sidebar.classList.remove('sidebar-mobile-open');
}

function stepNeedsParticipantSheet(step: TutorialStep): boolean {
  if (step.expandFirstParticipant || step.openAddParticipant) return true;
  // Targets that live *inside* the editor sheet — `[data-pe-...]` is the
  // sheet's namespacing convention (see participant-editor-sheet.ts).
  const t = step.target ?? '';
  return t.includes('.gm-edit-sheet-v2') || t.includes('[data-pe-');
}

async function closeParticipantSheetIfOpen(): Promise<void> {
  const sheet = document.querySelector<HTMLElement>('.gm-edit-sheet-v2');
  if (!sheet) return;
  const cancel = sheet.querySelector<HTMLElement>('[data-pe-cancel]');
  if (!cancel) return;
  _internalClickFlag = true;
  cancel.click();
  _internalClickFlag = false;
  // Wait for the slide-down dismissal animation so the modal backdrop is gone
  // by the time the next step measures its target's getBoundingClientRect().
  await waitForAnimations(sheet);
  // Defensive: in case the dismiss is async / awaits a save-confirm prompt and
  // the sheet is still mounted, give the DOM a tick to settle.
  await rAFAsync();
}

async function openAddParticipantSheet(): Promise<void> {
  // No-op if any editor sheet is already open — covers the case where the
  // user followed step 2's instruction and clicked the highlighted button
  // themselves before pressing המשך.
  if (document.querySelector('.gm-edit-sheet-v2')) return;
  const addBtn = document.querySelector<HTMLElement>('[data-action="add-participant"]');
  if (!addBtn) return;
  _internalClickFlag = true;
  addBtn.click();
  _internalClickFlag = false;
  const sheet = await waitFor('.gm-edit-sheet-v2', 800);
  if (sheet) await waitForAnimations(sheet);
}

async function openAccordionProgrammatic(id: string): Promise<void> {
  const header = document.querySelector<HTMLButtonElement>(
    `#${cssEscape(id)} > [data-action="settings-accordion-toggle"]`,
  );
  if (!header) return;
  if (header.getAttribute('aria-expanded') === 'true') return;
  _internalClickFlag = true;
  header.click();
  _internalClickFlag = false;
  // accordion open transition is ~150ms; 220ms gives margin
  await new Promise((r) => setTimeout(r, 220));
}

// Applies a track's optional tab/view orientation. Run once at tour start and
// again at every deep-tour track→track seam. openFirstProfile/openFirstTaskPanel
// call returnToScheduleGrid() first, so this self-heals every seam shape
// (tab→tab, tab→overlay, overlay→overlay).
async function applyTrackSetup(track: TutorialTrack): Promise<void> {
  if (track.switchToTab) await switchToTabProgrammatic(track.switchToTab);
  if (track.enterView === 'profile') await openFirstProfile();
  if (track.enterView === 'task-panel') await openFirstTaskPanel();
}

async function returnToScheduleGrid(): Promise<void> {
  // If a profile/task-panel overlay is open, close it before searching the grid.
  const back = document.querySelector<HTMLElement>('[data-action="back-to-schedule"]');
  if (back) {
    _internalClickFlag = true;
    back.click();
    _internalClickFlag = false;
    await waitFor('.schedule-grid-container', 1000);
  }
  await switchToTabProgrammatic('schedule');
}

async function openFirstProfile(): Promise<void> {
  await returnToScheduleGrid();
  // Profile navigation is wired via clicks on `.participant-hover[data-pid]`
  // (app.ts onNavigateToProfile callback). The plain grid-cell `[data-pid]`
  // anchors a tooltip / workload-popup, NOT the profile view — clicking one
  // of those on touch devices opens the popup instead of navigating away.
  // Prefer the sidebar's profile-link `.participant-hover`. On mobile the
  // sidebar starts hidden behind the FAB drawer; open it first.
  const isMobile = !!_mql?.matches;
  if (isMobile) {
    const fab = document.querySelector<HTMLElement>('.sidebar-fab');
    if (fab) {
      _internalClickFlag = true;
      fab.click();
      _internalClickFlag = false;
      await waitFor('.participant-sidebar.sidebar-mobile-open', 800);
    }
  }
  const pid =
    document.querySelector<HTMLElement>('.participant-sidebar .participant-hover[data-pid]') ??
    document.querySelector<HTMLElement>('.participant-sidebar [data-pid]') ??
    document.querySelector<HTMLElement>('.participant-hover[data-pid]');
  if (!pid) return;
  _internalClickFlag = true;
  pid.click();
  _internalClickFlag = false;
  await waitFor('.profile-view-root', 1000);
}

async function openFirstTaskPanel(): Promise<void> {
  await returnToScheduleGrid();
  const tag = document.querySelector<HTMLElement>('.task-panel-hover[data-source-name]');
  if (!tag) return;
  _internalClickFlag = true;
  tag.click();
  _internalClickFlag = false;
  await waitFor('.task-panel-view-root', 1000);
}

async function waitFor(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

// Wait for any in-flight CSS animations on the element (and its descendants)
// to finish, so subsequent getBoundingClientRect() calls measure the final
// resting position. The participant editor sheet uses gmMobileModalSlideUp
// (0.3s); without this, the spotlight is positioned against the off-screen
// starting frame and ends up halo-ing thin air below the viewport.
async function waitForAnimations(el: HTMLElement): Promise<void> {
  const anims = el.getAnimations({ subtree: true });
  if (anims.length === 0) return;
  await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
}

// ─── Listeners (manual tab switch, resize, DOM removal) ──────────────────────

function installListeners(): void {
  // Esc → exit
  document.addEventListener('keydown', onKeyDown);

  // Resize / orientation
  _resizeListener = () => {
    if (!_activeTrackId) return;
    void renderStep(_stepIdx);
  };
  window.addEventListener('resize', _resizeListener);
  window.addEventListener('orientationchange', _resizeListener);

  // Scroll → reposition spotlight + popover so the halo tracks the target
  // as the user scrolls around to read context. Without this the spotlight
  // is fixed-positioned at its initial coords and points at empty space the
  // moment the user scrolls. Throttled to rAF; capture-phase + passive so
  // scrollable ancestors fire it too.
  _scrollListener = () => {
    if (!_activeTrackId || _scrollRafQueued) return;
    _scrollRafQueued = true;
    requestAnimationFrame(() => {
      _scrollRafQueued = false;
      repositionCurrentStep();
    });
  };
  window.addEventListener('scroll', _scrollListener, { passive: true, capture: true });

  // Mobile breakpoint
  _mql = window.matchMedia('(max-width: 767px)');
  _mqListener = () => {
    if (!_activeTrackId) return;
    void renderStep(_stepIdx);
  };
  if (_mql.addEventListener) _mql.addEventListener('change', _mqListener);

  // DOM removal observer (target may disappear due to re-render)
  _domObserver = new MutationObserver(() => {
    if (!_activeTrackId) return;
    // If the popover itself was wiped, abort
    if (_popover && !document.body.contains(_popover)) {
      exitTutorial();
    }
  });
  _domObserver.observe(document.body, { childList: true, subtree: true });

  // Page-unload safety net: the durable backup written by enterTutorialDemoMode
  // is already in localStorage, so a refresh mid-tour is harmless — init() in
  // app.ts calls restoreTutorialBackupIfPresent() before reading any state.
  // This listener exists to ensure any pending store save is flushed; the
  // restore path then sees the user's most recent data, not a stale copy.
  _beforeUnloadListener = () => {
    // No-op body — the backup is already durable. Presence of the listener
    // signals to readers that tour state is "in flight" but the actual
    // restore happens on the next load.
  };
  window.addEventListener('beforeunload', _beforeUnloadListener);
}

function uninstallListeners(): void {
  document.removeEventListener('keydown', onKeyDown);
  if (_resizeListener) {
    window.removeEventListener('resize', _resizeListener);
    window.removeEventListener('orientationchange', _resizeListener);
    _resizeListener = null;
  }
  if (_scrollListener) {
    window.removeEventListener('scroll', _scrollListener, { capture: true });
    _scrollListener = null;
  }
  _scrollRafQueued = false;
  if (_mql && _mqListener && _mql.removeEventListener) {
    _mql.removeEventListener('change', _mqListener);
  }
  _mql = null;
  _mqListener = null;
  if (_domObserver) {
    _domObserver.disconnect();
    _domObserver = null;
  }
  if (_beforeUnloadListener) {
    window.removeEventListener('beforeunload', _beforeUnloadListener);
    _beforeUnloadListener = null;
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (!_activeTrackId) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    exitTutorial();
  }
}

// ─── Tiny helpers (avoid pulling ui-helpers; we don't trust caller input here) ─

function escHtmlLite(s: string): string {
  // Note: tutorial body strings may legitimately contain <strong>/<em>/<br>;
  // those go through verbatim. titles and aria-labels use this stricter escape.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttrLite(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cssEscape(s: string): string {
  // Fall back to manual escape if CSS.escape isn't available (very old browsers).
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function rAFAsync(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// ─── Dev / test hook ─────────────────────────────────────────────────────────

declare global {
  interface Window {
    gmStartTutorial?: (id: string) => void;
  }
}

export function exposeWindowApi(ctx: TutorialContext): void {
  window.gmStartTutorial = (id: string) => void startTutorial(id, ctx);
}
