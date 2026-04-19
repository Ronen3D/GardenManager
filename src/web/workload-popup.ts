/**
 * Workload bar popup — structured replacement for the old toast-dump.
 *
 * Opens from a click/tap on a workload sidebar bar. Shows participant
 * identity, headline load number, and a per-day sparkline. Desktop
 * renders an anchored popover; touch devices get a bottom sheet.
 */

import type { Participant, Schedule, Task } from '../index';
import { hebrewDayName } from '../utils/date-utils';
import { isTouchDevice } from './responsive';
import { computePerDayHours } from './schedule-utils';
import { escHtml, groupBadge, levelBadge } from './ui-helpers';
import { showBottomSheet } from './ui-modal';
import { computeWeeklyWorkloads } from './workload-utils';

/**
 * Short Hebrew weekday letters (א-ו + ש for Shabbat), indexed by JS getDay().
 * Using charAt(0) of the full name would collide (ר/ר, ש/ש/ש/ש).
 */
const HEBREW_DAY_SHORT = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'] as const;

// ─── Single desktop popover singleton ───────────────────────────────────────

let _popoverEl: HTMLElement | null = null;
let _popoverCleanup: (() => void) | null = null;

function getPopoverEl(): HTMLElement {
  if (_popoverEl && document.body.contains(_popoverEl)) return _popoverEl;
  const el = document.createElement('div');
  el.className = 'workload-popup';
  el.style.display = 'none';
  document.body.appendChild(el);
  _popoverEl = el;
  return el;
}

function hidePopover(): void {
  if (_popoverCleanup) {
    _popoverCleanup();
    _popoverCleanup = null;
  }
  if (_popoverEl) _popoverEl.style.display = 'none';
}

// ─── Content builder ────────────────────────────────────────────────────────

interface PopupContext {
  participant: Participant;
  effectiveHours: number;
  pctOfPeriod: number;
  loadBearingCount: number;
  perDay: Map<number, number>;
  numDays: number;
  scheduleStart: Date;
  currentDayIdx: number;
  /** Whether the close button should render (desktop yes, bottom sheet has its own). */
  showClose: boolean;
}

function buildPopupHtml(ctx: PopupContext): string {
  const { participant: p } = ctx;

  // Sparkline: find max to scale, and average for "peak" highlight.
  const dayEntries: Array<{ day: number; hours: number }> = [];
  let maxHrs = 0;
  let sumHrs = 0;
  for (let d = 1; d <= ctx.numDays; d++) {
    const hrs = ctx.perDay.get(d) || 0;
    dayEntries.push({ day: d, hours: hrs });
    if (hrs > maxHrs) maxHrs = hrs;
    sumHrs += hrs;
  }
  const avgHrs = ctx.numDays > 0 ? sumHrs / ctx.numDays : 0;
  const peakThreshold = avgHrs * 1.5;

  const sparkHtml = dayEntries
    .map(({ day, hours }) => {
      const ratio = maxHrs > 0 ? hours / maxHrs : 0;
      // Min visible height for non-zero bars so they never disappear behind label.
      const heightPct = hours > 0 ? Math.max(ratio * 100, 12) : 0;
      const date = new Date(
        ctx.scheduleStart.getFullYear(),
        ctx.scheduleStart.getMonth(),
        ctx.scheduleStart.getDate() + day - 1,
      );
      const dayLetter = HEBREW_DAY_SHORT[date.getDay()];
      const classes = ['wp-spark-col'];
      if (day === ctx.currentDayIdx) classes.push('today');
      if (hours > 0 && avgHrs > 0 && hours >= peakThreshold) classes.push('peak');
      if (hours === 0) classes.push('zero');
      const valueHtml = hours > 0 ? `<span class="wp-spark-value">${hours.toFixed(1)}</span>` : '';
      return `<div class="${classes.join(' ')}" title="${escHtml(hebrewDayName(date))}: ${hours.toFixed(1)} שע'">
        ${valueHtml}
        <div class="wp-spark-bar-wrap"><div class="wp-spark-bar" style="height:${heightPct}%"></div></div>
        <span class="wp-spark-day">${escHtml(dayLetter)}</span>
      </div>`;
    })
    .join('');

  const todayHrs = ctx.perDay.get(ctx.currentDayIdx) || 0;
  const todayDate = new Date(
    ctx.scheduleStart.getFullYear(),
    ctx.scheduleStart.getMonth(),
    ctx.scheduleStart.getDate() + ctx.currentDayIdx - 1,
  );
  const todayLine =
    ctx.currentDayIdx >= 1 && ctx.currentDayIdx <= ctx.numDays
      ? `<div class="wp-today-line">
          <span class="wp-today-label">יום ${ctx.currentDayIdx} · ${escHtml(hebrewDayName(todayDate))}</span>
          <span class="wp-today-value">${todayHrs.toFixed(1)} שע'</span>
        </div>`
      : '';

  const closeBtn = ctx.showClose ? `<button class="wp-close" aria-label="סגור" data-wp-close>✕</button>` : '';

  return `
    <div class="wp-header">
      <div class="wp-name-row">
        <span class="wp-name">${escHtml(p.name)}</span>
        ${closeBtn}
      </div>
      <div class="wp-badges">${levelBadge(p.level)} ${groupBadge(p.group)}</div>
    </div>
    <div class="wp-primary">
      <div class="wp-primary-num">
        <span class="wp-big">${ctx.effectiveHours.toFixed(1)}</span>
        <span class="wp-unit">שעות עומס</span>
      </div>
      <div class="wp-primary-sub">${ctx.pctOfPeriod.toFixed(1)}% מסך התקופה · ${ctx.loadBearingCount} משימות נושאות עומס</div>
    </div>
    <div class="wp-section-label">פיזור יומי</div>
    <div class="wp-sparkline">${sparkHtml}</div>
    ${todayLine}
  `;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Open a workload popup for the given participant. On touch devices renders
 * a bottom sheet; on pointer devices renders a popover anchored below
 * `anchor`. Safe to call repeatedly — closes any existing popup first.
 */
export function openWorkloadPopup(
  anchor: HTMLElement,
  participantId: string,
  schedule: Schedule,
  currentDayIdx: number,
): void {
  const participant = schedule.participants.find((p) => p.id === participantId);
  if (!participant) return;

  const workloads = computeWeeklyWorkloads(schedule.participants, schedule.assignments, schedule.tasks);
  const w = workloads.get(participantId) || {
    totalHours: 0,
    effectiveHours: 0,
    hotHours: 0,
    coldHours: 0,
    loadBearingCount: 0,
  };
  const taskMap = new Map<string, Task>(schedule.tasks.map((t) => [t.id, t]));
  const perDay = computePerDayHours(participantId, schedule, taskMap);
  const numDays = schedule.periodDays;
  const totalPeriodHours = numDays * 24;
  const pctOfPeriod = totalPeriodHours > 0 ? (w.effectiveHours / totalPeriodHours) * 100 : 0;

  const ctx: PopupContext = {
    participant,
    effectiveHours: w.effectiveHours,
    pctOfPeriod,
    loadBearingCount: w.loadBearingCount,
    perDay,
    numDays,
    scheduleStart: schedule.periodStart,
    currentDayIdx,
    showClose: true,
  };

  if (isTouchDevice) {
    const content = `<div class="workload-popup workload-popup-sheet">${buildPopupHtml({ ...ctx, showClose: false })}</div>`;
    showBottomSheet(content, { title: participant.name });
    return;
  }

  // Desktop: anchored popover.
  hidePopover();
  const el = getPopoverEl();
  el.innerHTML = buildPopupHtml(ctx);
  el.style.display = 'block';
  el.style.visibility = 'hidden';

  // Measure after render so we know the height for flip-above logic.
  const popRect = el.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();

  const margin = 6;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let top = anchorRect.bottom + margin;
  if (top + popRect.height > viewportH - 4) {
    // Flip above the anchor if it would overflow.
    const above = anchorRect.top - margin - popRect.height;
    if (above >= 4) top = above;
    else top = Math.max(4, viewportH - popRect.height - 4);
  }

  let left = anchorRect.left + anchorRect.width / 2 - popRect.width / 2;
  if (left + popRect.width > viewportW - 4) left = viewportW - popRect.width - 4;
  if (left < 4) left = 4;

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = 'visible';

  const onDocClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (el.contains(t)) {
      if (t.closest('[data-wp-close]')) hidePopover();
      return;
    }
    if (anchor.contains(t)) return;
    hidePopover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hidePopover();
  };
  // Defer listener attach so the opening click itself doesn't close the popover.
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
  document.addEventListener('keydown', onKey);

  _popoverCleanup = () => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKey);
  };
}

/** Close the desktop popover if open (no-op for bottom sheet — it has its own close). */
export function closeWorkloadPopup(): void {
  hidePopover();
}
