/**
 * Home Tab — the warm, human landing screen ("השבצקיסט").
 *
 * The default landing view (not a bottom-nav tab — reached via the header
 * title, see app.ts goToTab/wireHomeTitle). Identity: calm and a little warm,
 * speaking to the user like a competent teammate. Personality comes from voice,
 * a soft "week" spectrum (יום 1..N), gentle status, and airy figures — not from
 * gradients, cards, or alarms.
 *
 * Follows the tab-module convention (callback injection, no import back to
 * app.ts). app.ts owns currentTab / currentSchedule / doGenerate and injects
 * navigation via HomeTabCallbacks. Schedule status is read from the frozen
 * snapshot (`ctx.schedule.*`), never from the live store — mirrors the
 * validity logic in app.ts:renderWeeklyDashboard.
 */

import { type PreflightResult, PreflightSeverity, type Schedule, ViolationSeverity } from '../models/types';
import * as store from './config-store';
import { filterVisibleViolations } from './schedule-utils';
import { escHtml } from './ui-helpers';

export type HomeNavTarget = 'participants' | 'task-rules' | 'schedule' | 'algorithm';

export interface HomeTabContext {
  /** The frozen schedule snapshot, or null when none has been generated. */
  schedule: Schedule | null;
  /** True when the store was mutated after the last generation. */
  scheduleDirty: boolean;
  /** Shared runPreflight() result from renderAll(). */
  preflight: PreflightResult;
}

export interface HomeTabCallbacks {
  /** Open the existing schedule (→ schedule tab). */
  onOpenSchedule(): void;
  /** Generate / regenerate a schedule (→ doGenerate). */
  onGenerate(): void;
  /** Navigate to one of the working tabs. */
  onNavigate(tab: HomeNavTarget): void;
  /** Start the guided tutorial (same entry point as the first-launch banner). */
  onHelp(): void;
}

const QUICK_LINKS: { target: HomeNavTarget; label: string }[] = [
  { target: 'participants', label: 'משתתפים' },
  { target: 'task-rules', label: 'משימות' },
  { target: 'schedule', label: 'שבצ"ק' },
  { target: 'algorithm', label: 'הגדרות' },
];

/**
 * Soft spectrum across the operational week — gently desaturated tints of the
 * brand cube palette. One signature detail that ties product (the week) to
 * identity (the cube), kept calm. Index 0..6 → יום 1..7 (scheduleDays ≤ 7).
 */
const WEEK_SPECTRUM = ['#8FB8E0', '#84CFC4', '#97D3A0', '#EFD08A', '#ECB089', '#C7A6DC', '#93C6E6'];

type StatusMark = 'good' | 'warn' | 'attention' | 'neutral';

interface HomeState {
  title: string;
  saying: string;
  mark: StatusMark;
}

function heCount(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** Calm, spoken Hebrew that reflects the real state. Status logic mirrors
 *  app.ts:renderWeeklyDashboard (frozen disabled set → visible violations). */
function computeState(ctx: HomeTabContext, partCount: number, tplCount: number): HomeState {
  const { schedule, preflight } = ctx;

  if (!schedule) {
    if (preflight.canGenerate) {
      return {
        title: 'בוא נבנה את השבוע',
        saying: `${partCount} אנשים ו-${tplCount} משימות מוכנים לשיבוץ`,
        mark: 'neutral',
      };
    }
    return { title: 'עוד רגע ומתחילים', saying: 'צריך להשלים כמה הגדרות לפני בניית השבוע', mark: 'attention' };
  }

  const frozenDisabled = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const visible = filterVisibleViolations(schedule.violations, frozenDisabled);
  const hard = visible.filter((v) => v.severity === ViolationSeverity.Error).length;
  const warn = visible.filter((v) => v.severity === ViolationSeverity.Warning).length;

  if (!schedule.feasible || hard > 0) {
    return {
      title: 'השבוע צריך עוד תשומת לב',
      saying: `${heCount(hard, 'הפרה אחת', 'הפרות')} לתיקון`,
      mark: 'attention',
    };
  }
  if (warn > 0) {
    return {
      title: 'השבוע כמעט מושלם',
      saying: `${heCount(warn, 'אזהרה קלה אחת', 'אזהרות קלות')} לבדיקה`,
      mark: 'warn',
    };
  }
  return { title: 'הכול מוכן לשבוע', saying: 'השבוע תקין, ללא הפרות', mark: 'good' };
}

const MARK_GLYPH: Record<StatusMark, string> = { good: '✓', warn: '•', attention: '!', neutral: '•' };

function renderWeek(days: number, live: boolean): string {
  const segs: string[] = [];
  for (let i = 0; i < days; i++) {
    const color = WEEK_SPECTRUM[i % WEEK_SPECTRUM.length];
    segs.push(`<span class="home-week-d" style="--wd:${color}"><i></i><b>${i + 1}</b></span>`);
  }
  const cap = days === 1 ? 'יום 1' : `יום 1–${days}`;
  return `<div class="home-week ${live ? 'is-live' : 'is-planned'}" role="img" aria-label="שבוע בן ${days} ימים">
    <div class="home-week-row">${segs.join('')}</div>
    <span class="home-week-cap">${cap}</span>
  </div>`;
}

function renderActions(ctx: HomeTabContext): string {
  const { schedule, scheduleDirty, preflight } = ctx;

  if (schedule) {
    const dirty = scheduleDirty ? `<p class="home-note">השתנו נתונים מאז — אפשר ליצור שבצ"ק מחדש.</p>` : '';
    return `<div class="home-actions">
      <button type="button" class="home-cta" data-action="open">פתח שבצ"ק</button>
      <button type="button" class="home-cta2" data-action="generate">צור מחדש</button>
    </div>${dirty}`;
  }

  if (preflight.canGenerate) {
    return `<div class="home-actions">
      <button type="button" class="home-cta" data-action="generate">צור שבצ"ק</button>
    </div>`;
  }

  return `<div class="home-actions">
    <button type="button" class="home-cta" data-action="generate" disabled
      title="צריך להשלים כמה הגדרות לפני בניית השבוע">צור שבצ"ק</button>
  </div>`;
}

/** Calm "what's missing" panel (no red alarm). Escapes finding messages —
 *  they can embed user-entered template names. */
function renderGuide(preflight: PreflightResult): string {
  const crits = preflight.findings.filter((f) => f.severity === PreflightSeverity.Critical);
  return `<div class="home-guide" role="alert">
    <p class="home-guide-title">כדי להתחיל, ${heCount(crits.length, 'צריך לסדר דבר אחד', 'צריך לסדר את הדברים האלה')}:</p>
    <ul class="home-guide-list">${crits.map((f) => `<li>${escHtml(f.message)}</li>`).join('')}</ul>
    <div class="home-guide-actions">
      <button type="button" class="home-linkbtn" data-action="fix-tasks">למסך המשימות</button>
      <button type="button" class="home-linkbtn" data-action="fix-participants">למסך המשתתפים</button>
    </div>
  </div>`;
}

export function renderHomeTab(ctx: HomeTabContext): string {
  const { schedule, preflight } = ctx;
  const partCount = store.getAllParticipants().length;
  const tplCount = store.getAllTaskTemplates().length;
  // Frozen-snapshot rule: a generated schedule's day count is immutable on the
  // snapshot; pre-generation we show the configured value. Mirrors app.ts:4581.
  const days = schedule ? schedule.periodDays : store.getScheduleDays();
  const st = computeState(ctx, partCount, tplCount);
  const showGuide = !schedule && !preflight.canGenerate;

  const links = QUICK_LINKS.map(
    (l) => `<button type="button" class="home-link" data-action="nav-${l.target}">${l.label}</button>`,
  ).join('<span class="home-link-sep" aria-hidden="true">·</span>');

  return `<div class="home">
    <section class="home-card">
      <span class="home-aura" aria-hidden="true"></span>

      <div class="home-head">
        <span class="home-mark home-mark--${st.mark}" aria-hidden="true">${MARK_GLYPH[st.mark]}</span>
        <div class="home-head-text">
          <h2 class="home-title">${st.title}</h2>
          <p class="home-saying">${st.saying}</p>
        </div>
      </div>

      ${renderWeek(days, !!schedule)}

      ${renderActions(ctx)}

      ${showGuide ? renderGuide(preflight) : ''}

      <div class="home-figs" role="group" aria-label="נתונים">
        <div class="home-fig"><b>${partCount}</b><span>אנשים</span></div>
        <span class="home-fig-sep" aria-hidden="true"></span>
        <div class="home-fig"><b>${tplCount}</b><span>משימות</span></div>
        <span class="home-fig-sep" aria-hidden="true"></span>
        <div class="home-fig"><b>${days}</b><span>ימים</span></div>
      </div>

      <div class="home-foot">
        <button type="button" class="home-help" data-action="help">סיור מודרך במערכת</button>
        <nav class="home-links" aria-label="ניווט מהיר">${links}</nav>
      </div>
    </section>
  </div>`;
}

export function wireHomeEvents(container: HTMLElement, cb: HomeTabCallbacks): void {
  container.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.disabled) return;
      const action = el.dataset.action || '';
      if (action === 'open') cb.onOpenSchedule();
      else if (action === 'generate') cb.onGenerate();
      else if (action === 'fix-tasks') cb.onNavigate('task-rules');
      else if (action === 'fix-participants') cb.onNavigate('participants');
      else if (action === 'help') cb.onHelp();
      else if (action.startsWith('nav-')) cb.onNavigate(action.slice(4) as HomeNavTarget);
    });
  });
}
