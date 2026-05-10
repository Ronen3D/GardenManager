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
import { getTrackById, TRACKS } from './tutorial-content';
import { showToast } from './ui-modal';

// ─── Types (exported for tutorial-content.ts) ────────────────────────────────

export interface TutorialContext {
  getSchedule: () => unknown | null;
  isLiveModeEnabled: () => boolean;
  /** True when the user has at least one participant configured. */
  hasParticipants?: () => boolean;
  /** True when the user has at least one task template configured. */
  hasTaskTemplates?: () => boolean;
  /** Run a small demo schedule generation so subsequent tutorial steps have
   * data to point at. Should resolve only after the optim-overlay clears. */
  generateDemoSchedule?: () => Promise<void>;
  /** Enable live mode anchored at the start of day 1 — used by inject /
   * rescue / Future-SOS demo steps. */
  enableLiveModeForDemo?: () => Promise<void>;
  /** Re-seed default participants (no-op if any participant already exists). */
  seedParticipants?: () => Promise<void>;
  /** Re-seed default task templates (no-op if any template already exists). */
  seedTaskTemplates?: () => Promise<void>;
}

/** Fallback action chip rendered inside the popover body when the step's data
 * isn't there to demonstrate. Picking the chip fires the corresponding helper
 * on the TutorialContext, then re-renders the step so the user sees the
 * populated UI without leaving the tour. */
export type FallbackActionKind = 'generate-schedule' | 'enable-live' | 'seed-participants' | 'seed-templates';
export interface FallbackAction {
  kind: FallbackActionKind;
  /** Optional override for the chip label. Default: kind-appropriate Hebrew. */
  label?: string;
  /** Optional override for the explainer line under the chip. */
  hint?: string;
}

export interface TutorialStep {
  id: string;
  /** CSS selector for anchor element, or null = centred dialog. */
  target: string | null;
  placement: 'top' | 'bottom' | 'inline-start' | 'inline-end' | 'auto' | 'center';
  title: string;
  /** Hebrew copy. May contain limited HTML (<strong>, <em>). */
  body: string;
  /** Used when precondition() returns false. */
  bodyFallback?: string;
  precondition?: (ctx: TutorialContext) => boolean;
  /** Optional embedded screenshot. */
  screenshot?: { src: string; alt: string };
  /** Action chip shown in the popover when its prerequisite isn't met
   * (e.g. "create demo schedule" when no schedule exists). Picking it runs
   * the corresponding context helper, then re-renders the step.
   * When a function, it is re-evaluated against the live ctx on every render
   * — useful for steps that need *two* prerequisites in sequence
   * (e.g. schedule first, then live mode). Return null to suppress the chip. */
  fallbackAction?: FallbackAction | ((ctx: TutorialContext) => FallbackAction | null);
  /** Engine should `.click()` the tab button before showing this step. */
  switchToTab?: 'participants' | 'task-rules' | 'schedule' | 'algorithm';
  /** Engine should ensure these accordion ids are open before showing. */
  openAccordion?: string | string[];
  /** Engine should expand the first `.template-card` if it is collapsed. */
  expandFirstTemplate?: boolean;
  /** Engine should put the first participant row into edit mode (clicks the
   * row's pencil icon). Needed for steps that point at controls only rendered
   * inside an expanded row (e.g. the unavailability editor). */
  expandFirstParticipant?: boolean;
  /** Mobile-specific overrides applied when matchMedia(max-width:767px). */
  mobileOverride?: Partial<Pick<TutorialStep, 'target' | 'placement' | 'body'>>;
}

export interface TutorialTrack {
  id: string;
  label: string;
  icon: string;
  description: string;
  steps: TutorialStep[];
  switchToTab?: 'participants' | 'task-rules' | 'schedule' | 'algorithm';
  /** If true, track refuses to start without a generated schedule. */
  requiresSchedule?: boolean;
  guardMessage?: string;
  /** Programmatically open this overlay view before track starts. */
  enterView?: 'profile' | 'task-panel';
}

// ─── Storage keys ────────────────────────────────────────────────────────────

const KEY_BANNER_DISMISSED = 'gardenmanager_tutorial_banner_dismissed';
const KEY_SEEN_TRACKS = 'gardenmanager_tutorial_seen_tracks';

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
let _root: HTMLElement | null = null;
let _backdrop: HTMLElement | null = null;
let _spotlight: HTMLElement | null = null;
let _popover: HTMLElement | null = null;
let _previouslyFocused: HTMLElement | null = null;
let _ctx: TutorialContext | null = null;
let _userTabSwitchListener: ((e: Event) => void) | null = null;
let _mqListener: ((e: MediaQueryListEvent) => void) | null = null;
let _mql: MediaQueryList | null = null;
let _resizeListener: (() => void) | null = null;
let _scrollListener: (() => void) | null = null;
let _scrollRafQueued = false;
let _domObserver: MutationObserver | null = null;
let _internalClickFlag = false;

export function getCurrentTrack(): string | null {
  return _activeTrackId;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function startTutorial(trackId: string, ctx: TutorialContext): Promise<void> {
  if (_activeTrackId) exitTutorial();
  const track = getTrackById(trackId);
  if (!track) {
    console.warn('[tutorial] unknown track:', trackId);
    return;
  }

  _ctx = ctx;

  // Track-level guard
  if (
    track.requiresSchedule &&
    (!ctx.getSchedule() || (ctx.getSchedule() as { assignments?: unknown[] }).assignments?.length === 0)
  ) {
    showGuardDialog(
      track.guardMessage ?? 'מדריך זה דורש שבצ"ק קיים. צור שבצ"ק תחילה ונסה שוב.',
      // Offer "create one for me" if the host wired up the helper.
      typeof ctx.generateDemoSchedule === 'function'
        ? async () => {
            await ctx.generateDemoSchedule!();
            // After successful generation, retry the start.
            await startTutorial(trackId, ctx);
          }
        : undefined,
    );
    return;
  }

  // Banner dismissal — opening the tutorial counts.
  markBannerDismissed();
  removeBannerIfPresent();

  _activeTrackId = trackId;
  _stepIdx = 0;
  _previouslyFocused = (document.activeElement as HTMLElement) ?? null;

  mountOverlay();
  installListeners();

  // Optional initial tab/view setup
  if (track.switchToTab) await switchToTabProgrammatic(track.switchToTab);
  if (track.enterView === 'profile') await openFirstProfile();
  if (track.enterView === 'task-panel') await openFirstTaskPanel();

  await renderStep(0);
}

export function exitTutorial(): void {
  if (!_activeTrackId) return;
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
  _ctx = null;
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

export function renderTutorialAccordionBody(ctx: TutorialContext): string {
  const seen = new Set(getSeenTracks());
  const hasSchedule =
    ctx.getSchedule() != null && ((ctx.getSchedule() as { assignments?: unknown[] }).assignments?.length ?? 0) > 0;

  const trackButtons = TRACKS.map((t) => {
    const isSeen = seen.has(t.id);
    const needsSchedule = !!t.requiresSchedule;
    const blocked = needsSchedule && !hasSchedule;
    return `
      <button type="button" class="tutorial-track-btn" data-tutorial-track="${t.id}" ${
        needsSchedule ? 'data-requires-schedule="1"' : ''
      } title="${escAttrLite(t.description)}">
        <span class="tutorial-track-btn-row">
          <span class="tutorial-track-icon" aria-hidden="true">${t.icon}</span>
          <span class="tutorial-track-label">${escHtmlLite(t.label)}</span>
          ${isSeen ? '<span class="tutorial-track-seen" aria-label="הושלם">✓</span>' : ''}
          ${blocked ? '<span class="tutorial-track-warn" aria-label="דורש שבצ&quot;ק">⚠</span>' : ''}
        </span>
        <span class="tutorial-track-desc">${escHtmlLite(t.description)}</span>
      </button>
    `;
  }).join('');

  const notice = !hasSchedule
    ? '<span class="tutorial-launcher-notice">⚠ אין שבצ"ק פעיל — מדריכים המסומנים "דורש שבצ"ק" יציגו הנחיה לפני התחלה.</span>'
    : '';

  return `
    <div class="tutorial-launcher-body">
      <p class="tutorial-launcher-intro">בחר מדריך — המערכת תדריך אותך שלב אחר שלב, וניתן לצאת בכל עת. חלק מהמדריכים דורשים שבצ"ק קיים; הסיור הכללי אינו מחייב.</p>
      <div class="tutorial-track-list">${trackButtons}</div>
      ${notice}
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
  _backdrop.className = 'tutorial-backdrop';

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
}

// ─── Internals: render a single step ─────────────────────────────────────────

async function renderStep(idx: number): Promise<void> {
  if (!_activeTrackId || !_popover || !_spotlight || !_ctx) return;

  const track = getTrackById(_activeTrackId);
  if (!track) return exitTutorial();

  if (idx < 0 || idx >= track.steps.length) {
    // Past the end → mark as complete and exit
    markTrackSeen(track.id);
    exitTutorial();
    return;
  }
  _stepIdx = idx;

  const stepRaw = track.steps[idx];
  const isMobile = !!_mql?.matches;
  const step: TutorialStep = isMobile && stepRaw.mobileOverride ? { ...stepRaw, ...stepRaw.mobileOverride } : stepRaw;

  // Pre-show: switch tab if requested
  if (step.switchToTab) await switchToTabProgrammatic(step.switchToTab);

  // Pre-show: open accordions if requested
  if (step.openAccordion) {
    const ids = Array.isArray(step.openAccordion) ? step.openAccordion : [step.openAccordion];
    for (const id of ids) await openAccordionProgrammatic(id);
  }

  // Pre-show: expand first template card if requested (needed for t-5/t-6/t-8
  // which spotlight inputs that only render inside an expanded card).
  if (step.expandFirstTemplate) await expandFirstTemplateCard();

  // Pre-show: put first participant row into edit mode (needed for p-5 etc.)
  if (step.expandFirstParticipant) await expandFirstParticipantRow();

  // Wait one rAF for any rerender / transition to settle
  await rAFAsync();

  // Resolve target
  let targetEl: HTMLElement | null = null;
  if (step.target) {
    targetEl = document.querySelector<HTMLElement>(step.target);
  }

  // Apply precondition
  let body = step.body;
  if (step.precondition && !step.precondition(_ctx)) {
    body = step.bodyFallback ?? step.body;
    targetEl = null;
  }

  // Render popover content
  const stepCounter = `שלב ${idx + 1} מתוך ${track.steps.length}`;
  const isLast = idx === track.steps.length - 1;
  const screenshotHtml = step.screenshot
    ? `<img class="tutorial-screenshot" src="${escAttrLite(step.screenshot.src)}" alt="${escAttrLite(
        step.screenshot.alt,
      )}">`
    : '';

  const progressPct = Math.round(((idx + 1) / track.steps.length) * 100);
  // Render fallback action chip when the step has one and its prerequisite
  // isn't met. Lets the user create demo data on demand without leaving the
  // tour — e.g. "no schedule yet → [צור עבורי שבצ"ק להדגמה]".
  let resolvedAction: FallbackAction | null = null;
  if (step.fallbackAction) {
    resolvedAction = typeof step.fallbackAction === 'function' ? step.fallbackAction(_ctx) : step.fallbackAction;
  }
  const actionChipHtml =
    resolvedAction && isFallbackActionApplicable(resolvedAction, _ctx) ? renderFallbackActionChip(resolvedAction) : '';
  _popover.innerHTML = `
    <div class="tutorial-step-counter">${escHtmlLite(stepCounter)}</div>
    <div class="tutorial-progress" aria-hidden="true"><div class="tutorial-progress-fill" style="width:${progressPct}%"></div></div>
    <h3 class="tutorial-title" id="tutorial-title-${escAttrLite(step.id)}">${escHtmlLite(step.title)}</h3>
    <div class="tutorial-body">${body}</div>
    ${screenshotHtml}
    ${actionChipHtml}
    <div class="tutorial-footer">
      <button type="button" class="tutorial-btn tutorial-btn-primary${
        isLast ? ' tutorial-btn-finish' : ''
      }" data-tutorial-action="next">${isLast ? '✓ סיים' : '← המשך'}</button>
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
    else if (action === 'fallback-run' && resolvedAction) {
      void runFallbackAction(resolvedAction);
    }
  };

  // Position spotlight + popover
  if (targetEl) {
    scrollIntoViewIfNeeded(targetEl);
    await rAFAsync();
    positionForTarget(targetEl, step.placement === 'center' ? 'auto' : step.placement);
  } else {
    positionCentered();
  }

  // Focus the primary button so keyboard nav works
  requestAnimationFrame(() => {
    const next = _popover?.querySelector<HTMLButtonElement>('[data-tutorial-action="next"]');
    next?.focus();
  });
}

// ─── Positioning ─────────────────────────────────────────────────────────────

function scrollIntoViewIfNeeded(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight;
  // On mobile the bottom-sheet popover covers ~half the viewport, so the
  // useful "above the sheet" area is roughly the top 50% — keep targets there.
  const isMobile = !!_mql?.matches;
  // Reserve enough headroom above the target so the user can see *context*
  // (parent label, neighbouring rows, the row above the highlighted control).
  // Previous behaviour used scrollIntoView({block:'start'}) which slammed the
  // target right against the top edge — no context, no spatial reference.
  const upperBound = isMobile ? vh * 0.18 : 100;
  const lowerBound = isMobile ? vh * 0.45 : vh - 100;
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

function positionForTarget(target: HTMLElement, placement: TutorialStep['placement']): void {
  if (!_spotlight || !_popover) return;
  const rect = target.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // Off-viewport target → fall back to centered. Without this guard, the
  // spotlight box-shadow renders invisibly off-screen and the popover lands
  // at negative coordinates (e.g. above the fold).
  if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw || rect.width === 0 || rect.height === 0) {
    positionCentered();
    return;
  }
  const pad = 6;
  // Spotlight rect (cutout) — pad up to a minimum so very thin elements
  // (e.g. range sliders are ~6px tall) still produce a visible halo.
  const minHalo = 24;
  const haloW = Math.max(rect.width + pad * 2, minHalo);
  const haloH = Math.max(rect.height + pad * 2, minHalo);
  _spotlight.classList.remove('tutorial-spotlight-centered');
  _spotlight.style.top = `${rect.top + rect.height / 2 - haloH / 2}px`;
  _spotlight.style.left = `${rect.left + rect.width / 2 - haloW / 2}px`;
  _spotlight.style.width = `${haloW}px`;
  _spotlight.style.height = `${haloH}px`;

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
    positionCentered();
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
  _popover.style.left = `${left}px`;
}

// ─── Fallback action chips ───────────────────────────────────────────────────

function fallbackActionDefaults(action: FallbackAction): { label: string; hint: string } {
  switch (action.kind) {
    case 'generate-schedule':
      return {
        label: action.label ?? '⚡ צור עבורי שבצ"ק להדגמה',
        hint: action.hint ?? 'יום אחד, ייצור בסביבות 5 שניות. אפשר למחוק אחר כך.',
      };
    case 'enable-live':
      return {
        label: action.label ?? '🟢 הפעל מצב חי להדגמה',
        hint: action.hint ?? 'מקבע עוגן בתחילת יום 1. ניתן לכבות מתוך לשונית השבצ"ק.',
      };
    case 'seed-participants':
      return {
        label: action.label ?? '👥 טען משתתפי דמו',
        hint: action.hint ?? 'מחזיר את ברירת המחדל (לא מוחק משתתפים קיימים).',
      };
    case 'seed-templates':
      return {
        label: action.label ?? '📋 טען תבניות משימה דמו',
        hint: action.hint ?? 'מחזיר את ברירת המחדל (לא מוחק תבניות קיימות).',
      };
  }
}

function isFallbackActionApplicable(action: FallbackAction, ctx: TutorialContext | null): boolean {
  if (!ctx) return false;
  switch (action.kind) {
    case 'generate-schedule': {
      const s = ctx.getSchedule() as { assignments?: unknown[] } | null;
      const has = s != null && (s.assignments?.length ?? 0) > 0;
      return !has && typeof ctx.generateDemoSchedule === 'function';
    }
    case 'enable-live':
      return !ctx.isLiveModeEnabled() && typeof ctx.enableLiveModeForDemo === 'function';
    case 'seed-participants':
      return !ctx.hasParticipants?.() && typeof ctx.seedParticipants === 'function';
    case 'seed-templates':
      return !ctx.hasTaskTemplates?.() && typeof ctx.seedTaskTemplates === 'function';
  }
}

function renderFallbackActionChip(action: FallbackAction): string {
  const { label, hint } = fallbackActionDefaults(action);
  return `
    <div class="tutorial-action-chip">
      <button type="button" class="tutorial-btn tutorial-btn-primary tutorial-btn-chip" data-tutorial-action="fallback-run">${escHtmlLite(label)}</button>
      <span class="tutorial-action-chip-hint">${escHtmlLite(hint)}</span>
    </div>`;
}

async function runFallbackAction(action: FallbackAction): Promise<void> {
  if (!_ctx) return;
  // Visible "working..." state on the chip so the user knows the click landed
  // (schedule generation can take a few seconds).
  const chipBtn = _popover?.querySelector<HTMLButtonElement>('.tutorial-btn-chip');
  if (chipBtn) {
    chipBtn.disabled = true;
    chipBtn.textContent = '... מכין';
  }
  try {
    if (action.kind === 'generate-schedule' && _ctx.generateDemoSchedule) {
      await _ctx.generateDemoSchedule();
    } else if (action.kind === 'enable-live' && _ctx.enableLiveModeForDemo) {
      await _ctx.enableLiveModeForDemo();
    } else if (action.kind === 'seed-participants' && _ctx.seedParticipants) {
      await _ctx.seedParticipants();
    } else if (action.kind === 'seed-templates' && _ctx.seedTaskTemplates) {
      await _ctx.seedTaskTemplates();
    }
  } catch (err) {
    console.warn('[tutorial] fallback action failed:', err);
  }
  // Re-render the same step — precondition should now pass and the populated
  // UI is visible behind the popover.
  await renderStep(_stepIdx);
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
  // Skip when the precondition gates the step into a centered fallback.
  if (step.precondition && _ctx && !step.precondition(_ctx)) return;
  const targetEl = document.querySelector<HTMLElement>(step.target);
  if (!targetEl) return;
  positionForTarget(targetEl, step.placement === 'center' ? 'auto' : step.placement);
}

function positionCentered(): void {
  if (!_spotlight || !_popover) return;
  _spotlight.classList.add('tutorial-spotlight-centered');
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
  await waitFor('.gm-edit-sheet-v2', 800);
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

// ─── Listeners (manual tab switch, resize, DOM removal) ──────────────────────

function installListeners(): void {
  // Manual tab switch → exit silently with toast
  _userTabSwitchListener = (e) => {
    if (_internalClickFlag) return;
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('.tab-btn[data-tab]');
    if (!btn) return;
    // The user clicked a tab button. Schedule exit on next tick to allow
    // the existing handler to finish first.
    setTimeout(() => {
      if (!_activeTrackId) return;
      exitTutorial();
      showToast('המדריך הופסק — ניתן להמשיך מהגדרות.', { type: 'info', duration: 3500 });
    }, 0);
  };
  document.addEventListener('click', _userTabSwitchListener, true);

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
}

function uninstallListeners(): void {
  if (_userTabSwitchListener) {
    document.removeEventListener('click', _userTabSwitchListener, true);
    _userTabSwitchListener = null;
  }
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
}

function onKeyDown(e: KeyboardEvent): void {
  if (!_activeTrackId) return;
  if (e.key === 'Escape') {
    e.stopPropagation();
    exitTutorial();
  }
}

// ─── Guard dialog (track-level precondition failure) ─────────────────────────

function showGuardDialog(message: string, onCreateForMe?: () => Promise<void>): void {
  // Build a centred popover-style guard with up to three actions.
  const root = document.createElement('div');
  root.className = 'tutorial-root';
  const backdrop = document.createElement('div');
  backdrop.className = 'tutorial-backdrop';
  const spotlight = document.createElement('div');
  spotlight.className = 'tutorial-spotlight tutorial-spotlight-centered';
  const popover = document.createElement('div');
  popover.className = 'tutorial-popover tutorial-popover-centered';
  popover.setAttribute('role', 'alertdialog');
  popover.setAttribute('aria-modal', 'false');
  const createBtn = onCreateForMe
    ? '<button type="button" class="tutorial-btn tutorial-btn-primary" data-guard-action="create">⚡ צור עבורי שבצ"ק להדגמה</button>'
    : '';
  // When "create for me" is offered, demote "ok" to a ghost — primary should be the action.
  const okBtnClass = onCreateForMe ? 'tutorial-btn tutorial-btn-ghost' : 'tutorial-btn tutorial-btn-primary';
  popover.innerHTML = `
    <h3 class="tutorial-title">דרוש שבצ"ק</h3>
    <div class="tutorial-body">${escHtmlLite(message)}</div>
    <div class="tutorial-footer">
      ${createBtn}
      <button type="button" class="tutorial-btn tutorial-btn-secondary" data-guard-action="schedule">↩ עבור לשבצ"ק</button>
      <button type="button" class="${okBtnClass}" data-guard-action="ok">${onCreateForMe ? 'לא עכשיו' : '✓ הבנתי'}</button>
    </div>
  `;
  root.appendChild(backdrop);
  root.appendChild(spotlight);
  root.appendChild(popover);
  document.body.appendChild(root);

  const close = () => root.remove();
  popover.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-guard-action]')?.dataset.guardAction;
    if (action === 'create' && onCreateForMe) {
      const btn = popover.querySelector<HTMLButtonElement>('[data-guard-action="create"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '... מכין שבצ"ק';
      }
      void (async () => {
        try {
          await onCreateForMe();
        } finally {
          close();
        }
      })();
    } else if (action === 'schedule') {
      close();
      const tabBtn = document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="schedule"]');
      tabBtn?.click();
    } else if (action === 'ok') {
      close();
    }
  });
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function once(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', once);
    }
  });
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
