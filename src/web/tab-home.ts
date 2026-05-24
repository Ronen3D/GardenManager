/**
 * Home Tab — the app's signature landing screen ("השבצקיסט").
 *
 * Native to the system: built from the app's own design language — the glass
 * panel + accent edge-stripe motif (as on the header / weekly-dashboard), the
 * app's KPI status component (the exact `kpi-hero` surface the schedule screen
 * uses, so Home previews the real status), the brand accent-gradient headline
 * (echoing the app title), `btn-primary`, `score-card` figures, and `alert`
 * for problems. The cube palette appears only as a restrained week accent.
 *
 * Follows the tab-module convention (callback injection, no import back to
 * app.ts). Schedule status is read from the frozen snapshot (`ctx.schedule.*`),
 * never the live store — mirrors app.ts:renderWeeklyDashboard.
 */

import { type PreflightResult, PreflightSeverity, type Schedule, ViolationSeverity } from '../models/types';
import * as store from './config-store';
import { homeInstallBannerMode } from './pwa-install';
import { isSmallScreen } from './responsive';
import { filterVisibleViolations } from './schedule-utils';
import { escHtml, SVG_ICONS } from './ui-helpers';

export type HomeNavTarget = 'participants' | 'task-rules' | 'schedule' | 'algorithm';

export interface HomeTabContext {
  /** The frozen schedule snapshot, or null when none has been generated. */
  schedule: Schedule | null;
  /** True when the store was mutated after the last generation. */
  scheduleDirty: boolean;
  /** Shared runPreflight() result from renderAll(). */
  preflight: PreflightResult;
  /** True only for a genuine first-time user (one-time) → show the welcome. */
  firstRun: boolean;
}

export interface HomeTabCallbacks {
  /** Open the existing schedule (→ schedule tab). */
  onOpenSchedule(): void;
  /** Generate / regenerate a schedule (→ doGenerate). */
  onGenerate(): void;
  /** Navigate to one of the working tabs. */
  onNavigate(tab: HomeNavTarget): void;
  /** Start the curated guided tour (same entry point as the first-launch banner). */
  onHelp(): void;
  /** Start the deep tour — every step of all six topic tracks back-to-back. */
  onDeepTour(): void;
  /** Dismiss the first-run welcome ("אולי אחר כך"). */
  onDismissWelcome(): void;
  /** Trigger the native PWA install prompt (Android/Chromium banner only). */
  onInstall(): void;
}

const QUICK_LINKS: { target: HomeNavTarget; icon: string; label: string }[] = [
  { target: 'participants', icon: SVG_ICONS.participants, label: 'משתתפים' },
  { target: 'task-rules', icon: SVG_ICONS.tasks, label: 'משימות' },
  { target: 'schedule', icon: SVG_ICONS.chart, label: 'שבצ"ק' },
  { target: 'algorithm', icon: SVG_ICONS.settings, label: 'הגדרות' },
];

/** A calm slice of the brand cube-loader palette (index.html) — the app's own
 *  identity colours, minus the alarm-red, used as a restrained week accent. */
const WEEK_ACCENT = ['#4A90D9', '#1ABC9C', '#27AE60', '#F39C12', '#8E44AD', '#3498DB', '#2ECC71'];

interface Status {
  feasible: boolean;
  hard: number;
  warn: number;
  scoreText: string;
  isClean: boolean;
}

function readStatus(schedule: Schedule): Status {
  const frozenDisabled = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const visible = filterVisibleViolations(schedule.violations, frozenDisabled);
  const hard = visible.filter((v) => v.severity === ViolationSeverity.Error).length;
  const warn = visible.filter((v) => v.severity === ViolationSeverity.Warning).length;
  return {
    feasible: schedule.feasible,
    hard,
    warn,
    scoreText: schedule.score.compositeScore.toFixed(1),
    isClean: schedule.feasible && hard === 0 && warn === 0,
  };
}

/** The app's own KPI-hero status surface — identical composition to
 *  app.ts:renderWeeklyDashboard, sans element IDs. */
function renderStatus(s: Status): string {
  const heroIcon = s.feasible ? '✓' : '✗';
  const heroLabel = s.feasible ? 'ישים' : 'לא ישים';

  if (s.isClean) {
    return `<div class="home-status">
      <div class="kpi-hero kpi-ok kpi-hero-combined">
        <div class="kpi-hero-status">
          <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
          <span class="kpi-hero-label">${heroLabel}</span>
        </div>
        <span class="kpi-hero-divider" aria-hidden="true"></span>
        <div class="kpi-hero-score">
          <span class="kpi-value">${s.scoreText}</span>
          <span class="kpi-label">ציון</span>
        </div>
      </div>
    </div>`;
  }

  const vCell =
    s.hard > 0
      ? `<div class="kpi-cell kpi-error"><span class="kpi-value">${s.hard}</span><span class="kpi-label">הפרות</span></div>`
      : '';
  const wCell =
    s.warn > 0
      ? `<div class="kpi-cell kpi-warn"><span class="kpi-value">${s.warn}</span><span class="kpi-label">אזהרות</span></div>`
      : '';
  return `<div class="home-status">
    <div class="kpi-hero ${s.feasible ? 'kpi-ok' : 'kpi-error'}">
      <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
      <span class="kpi-hero-label">${heroLabel}</span>
    </div>
    <div class="kpi-strip" role="group" aria-label="ציונים">
      <div class="kpi-cell"><span class="kpi-value">${s.scoreText}</span><span class="kpi-label">ציון</span></div>
      ${vCell}
      ${wCell}
    </div>
  </div>`;
}

function renderWeek(days: number, live: boolean): string {
  let ticks = '';
  for (let i = 0; i < days; i++) {
    const color = WEEK_ACCENT[i % WEEK_ACCENT.length];
    ticks += `<span class="home-week-d" style="--wd:${color}"><i></i><b>${i + 1}</b></span>`;
  }
  const cap = days === 1 ? 'יום 1' : `יום 1–${days}`;
  return `<div class="home-week ${live ? 'is-live' : 'is-planned'}" role="img" aria-label="שבוע בן ${days} ימים">
    <div class="home-week-row">${ticks}</div>
    <span class="home-week-cap">${cap}</span>
  </div>`;
}

/** Critical-findings panel — the app's own alert language (matches the
 *  schedule tab, app.ts:1443). Escapes messages (user template names). */
function renderGuide(preflight: PreflightResult): string {
  const crits = preflight.findings.filter((f) => f.severity === PreflightSeverity.Critical);
  return `<div class="alert alert-error home-guide">
    <strong>לא ניתן ליצור שיבוץ — ${crits.length} בעיות קריטיות:</strong>
    <ul>${crits.map((f) => `<li>${escHtml(f.message)}</li>`).join('')}</ul>
    <div class="home-guide-actions">
      <button type="button" class="btn-sm btn-outline" data-action="fix-tasks">${SVG_ICONS.tasks} פירוט משימות</button>
      <button type="button" class="btn-sm btn-outline" data-action="fix-participants">${SVG_ICONS.participants} משתתפים</button>
    </div>
  </div>`;
}

/**
 * Mobile-only PWA install panel — persistent: stays visible until the user
 * actually installs (or is already standalone, or is on a platform with no
 * actionable install path). No dismiss control by design. Rendered as the
 * *first* child of Home so it's above the fold on a 375×812 phone.
 *
 * Visual register matches the rest of the app's surfaces — neutral
 * `var(--bg-card)` panel + `var(--border)` outline + brand-accent SVG icon
 * + `btn-primary` action — instead of a tinted notice box, to read as a
 * first-class system surface rather than a marketing nudge.
 */
function renderHomeInstallBanner(): string {
  if (!isSmallScreen) return '';
  const mode = homeInstallBannerMode();
  if (!mode) return '';
  const icon = `<svg class="home-install-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>`;
  if (mode === 'android') {
    return `<div class="home-install-banner" role="status">
      ${icon}
      <span class="home-install-text">התקנת השבצקיסט למסך הבית</span>
      <button type="button" class="btn-sm btn-primary home-install-btn" data-action="install-app">התקנה</button>
    </div>`;
  }
  // iOS — no programmatic prompt; show the manual gesture instead.
  return `<div class="home-install-banner" role="status">
    ${icon}
    <span class="home-install-text">להתקנה: שיתוף ↑ → הוסף למסך הבית</span>
  </div>`;
}

export function renderHomeTab(ctx: HomeTabContext): string {
  const { schedule, scheduleDirty, preflight, firstRun } = ctx;
  const partCount = store.getAllParticipants().length;
  const tplCount = store.getAllTaskTemplates().length;
  // Frozen-snapshot rule: a generated schedule's day count is immutable on the
  // snapshot; pre-generation we show the configured value. Mirrors app.ts:4581.
  const days = schedule ? schedule.periodDays : store.getScheduleDays();
  const status = schedule ? readStatus(schedule) : null;

  let headline: string;
  if (schedule) {
    headline = status?.feasible ? 'השבצ"ק מוכן' : 'השבצ"ק דורש תיקון';
  } else if (preflight.canGenerate) {
    headline = 'מוכנים ליצור שבצ"ק';
  } else {
    headline = 'כמעט מוכן ליצירה';
  }
  const sub =
    !schedule && !preflight.canGenerate
      ? 'יש לתקן בעיות קריטיות לפני יצירת שבצ"ק'
      : `${days} ימים · ${partCount} משתתפים · ${tplCount} משימות`;

  let actions: string;
  if (schedule) {
    actions = `<button type="button" class="btn-primary home-cta" data-action="open">פתח שבצ"ק</button>
      <button type="button" class="btn-sm btn-outline" data-action="generate">צור מחדש</button>`;
  } else if (preflight.canGenerate) {
    actions = `<button type="button" class="btn-primary home-cta" data-action="generate">צור שבצ"ק</button>`;
  } else {
    actions = `<button type="button" class="btn-primary home-cta" data-action="generate" disabled
      title="תקן בעיות קריטיות בכללי המשימות תחילה">צור שבצ"ק</button>`;
  }

  const dirty =
    schedule && scheduleDirty ? `<div class="dirty-notice">⚠ השיבוץ לא מעודכן. מומלץ ליצור אותו מחדש.</div>` : '';

  const links = QUICK_LINKS.map(
    (l) =>
      `<button type="button" class="home-link" data-action="nav-${l.target}">
        <span class="home-link-icon" aria-hidden="true">${l.icon}</span>${l.label}</button>`,
  ).join('');

  // First-run welcome — replaces the generic top-of-page tutorial banner with
  // a home-native, one-time greeting for genuine newcomers only.
  const welcome = firstRun
    ? `<div class="home-welcome" role="note">
        <div class="home-welcome-text">
          <strong>נעים להכיר 👋</strong>
          <span>סיור מודרך קצר יראה לכם איך בונים שבצ"ק בכמה דקות.</span>
        </div>
        <div class="home-welcome-actions">
          <button type="button" class="btn-sm btn-primary" data-action="help">📖 בואו נתחיל</button>
          <button type="button" class="btn-sm btn-outline" data-action="help-deep">🧭 סיור מעמיק</button>
          <button type="button" class="btn-sm btn-outline" data-action="dismiss-welcome">אולי אחר כך</button>
        </div>
      </div>`
    : '';

  return `<div class="home">
    ${renderHomeInstallBanner()}
    ${welcome}
    <section class="home-panel">
      <h2 class="home-headline">${headline}</h2>
      <p class="home-sub">${sub}</p>
      ${status ? renderStatus(status) : ''}
      ${renderWeek(days, !!schedule)}
      <div class="home-cta-row">
        ${actions}
        <button type="button" class="btn-sm btn-outline home-help" data-action="help">📖 סיור מודרך</button>
        <button type="button" class="btn-sm btn-outline home-help-deep" data-action="help-deep">🧭 סיור מעמיק</button>
      </div>
      ${dirty}
    </section>

    ${!schedule && !preflight.canGenerate ? renderGuide(preflight) : ''}

    <div class="home-side">
      <div class="home-figs" role="group" aria-label="נתונים">
        <div class="score-card"><div class="score-value">${partCount}</div><div class="score-label">משתתפים</div></div>
        <div class="score-card"><div class="score-value">${tplCount}</div><div class="score-label">משימות</div></div>
        <div class="score-card"><div class="score-value">${days}</div><div class="score-label">ימים</div></div>
      </div>

      <nav class="home-links" aria-label="ניווט מהיר">${links}</nav>
    </div>
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
      else if (action === 'help-deep') cb.onDeepTour();
      else if (action === 'dismiss-welcome') cb.onDismissWelcome();
      else if (action === 'install-app') cb.onInstall();
      else if (action.startsWith('nav-')) cb.onNavigate(action.slice(4) as HomeNavTarget);
    });
  });
}
