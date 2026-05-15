/**
 * Home Tab — task-oriented landing screen ("השבצקיסט").
 *
 * The default landing view (not a bottom-nav tab — reached via the header
 * title, see app.ts goToTab/wireHomeTitle). Leads with the user's real job:
 * open the existing schedule or generate one, with live schedule health,
 * compact stats, and quick links into the four working areas.
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
import { escHtml, SVG_ICONS } from './ui-helpers';

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

const QUICK_LINKS: { target: HomeNavTarget; icon: string; label: string }[] = [
  { target: 'participants', icon: SVG_ICONS.participants, label: 'משתתפים' },
  { target: 'task-rules', icon: SVG_ICONS.tasks, label: 'משימות' },
  { target: 'schedule', icon: SVG_ICONS.chart, label: 'שבצ"ק' },
  { target: 'algorithm', icon: SVG_ICONS.settings, label: 'הגדרות' },
];

/**
 * Status strip — only shown when a schedule exists. Mirrors the validity
 * logic of app.ts:renderWeeklyDashboard verbatim, reusing the `.kpi-*`
 * classes, but renders NO element IDs (avoids the shared `_prevKpiValues`
 * count-up cache + duplicate-ID collision with the schedule tab).
 */
function renderStatusStrip(schedule: Schedule): string {
  const score = schedule.score;
  const frozenDisabled = new Set(schedule.algorithmSettings.disabledHardConstraints);
  const visible = filterVisibleViolations(schedule.violations, frozenDisabled);
  const hard = visible.filter((v) => v.severity === ViolationSeverity.Error).length;
  const warn = visible.filter((v) => v.severity === ViolationSeverity.Warning).length;
  const feasibleClass = schedule.feasible ? 'kpi-ok' : 'kpi-error';
  const heroIcon = schedule.feasible ? '✓' : '✗';
  const heroLabel = schedule.feasible ? 'ישים' : 'לא ישים';
  const scoreText = score.compositeScore.toFixed(1);
  const isClean = schedule.feasible && hard === 0 && warn === 0;

  if (isClean) {
    return `<div class="home-status-strip">
      <div class="kpi-hero kpi-ok kpi-hero-combined">
        <div class="kpi-hero-status">
          <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
          <span class="kpi-hero-label">${heroLabel}</span>
        </div>
        <span class="kpi-hero-divider" aria-hidden="true"></span>
        <div class="kpi-hero-score">
          <span class="kpi-value">${scoreText}</span>
          <span class="kpi-label">ציון</span>
        </div>
      </div>
    </div>`;
  }

  const violationsCell =
    hard > 0
      ? `<div class="kpi-cell kpi-error"><span class="kpi-value">${hard}</span><span class="kpi-label">הפרות</span></div>`
      : '';
  const warningsCell =
    warn > 0
      ? `<div class="kpi-cell kpi-warn"><span class="kpi-value">${warn}</span><span class="kpi-label">אזהרות</span></div>`
      : '';

  return `<div class="home-status-strip">
    <div class="kpi-hero ${feasibleClass}">
      <span class="kpi-hero-icon" aria-hidden="true">${heroIcon}</span>
      <span class="kpi-hero-label">${heroLabel}</span>
    </div>
    <div class="kpi-strip" role="group" aria-label="ציונים">
      <div class="kpi-cell"><span class="kpi-value">${scoreText}</span><span class="kpi-label">ציון</span></div>
      ${violationsCell}
      ${warningsCell}
    </div>
  </div>`;
}

/** Disabled-CTA "guide to fix it" block. Reuses the schedule-tab critical
 *  findings markup (app.ts:1443-1447) but escapes messages (they can embed
 *  user-entered template names) and adds one-tap links to the fix screens. */
function renderGuideToFix(preflight: PreflightResult): string {
  const crits = preflight.findings.filter((f) => f.severity === PreflightSeverity.Critical);
  return `<div class="alert alert-error home-guide">
    <strong>לא ניתן ליצור שיבוץ - נמצאו ${crits.length} בעיות קריטיות:</strong>
    <ul>${crits.map((f) => `<li>${escHtml(f.message)}</li>`).join('')}</ul>
    <div class="home-guide-actions">
      <button type="button" class="btn-sm btn-outline" data-action="fix-tasks">${SVG_ICONS.tasks} עבור למסך פירוט משימות</button>
      <button type="button" class="btn-sm btn-outline" data-action="fix-participants">${SVG_ICONS.participants} עבור למסך משתתפים</button>
    </div>
  </div>`;
}

function renderCta(ctx: HomeTabContext): string {
  const { schedule, scheduleDirty, preflight } = ctx;

  if (schedule) {
    const dirty = scheduleDirty ? `<p class="home-dirty">⚠ השיבוץ לא מעודכן. מומלץ ליצור אותו מחדש.</p>` : '';
    return `<div class="home-cta-group">
      <button type="button" class="btn-primary home-cta" data-action="open">📋 פתח שבצ"ק</button>
      <button type="button" class="btn-sm btn-outline home-cta-secondary" data-action="generate">🔄 צור מחדש</button>
    </div>${dirty}`;
  }

  if (preflight.canGenerate) {
    return `<div class="home-cta-group">
      <button type="button" class="btn-primary home-cta" data-action="generate">⚡ צור שבצ"ק</button>
    </div>`;
  }

  return `<div class="home-cta-group">
    <button type="button" class="btn-primary home-cta" data-action="generate" disabled title="תקן בעיות קריטיות בכללי המשימות תחילה">⚡ צור שבצ"ק</button>
  </div>`;
}

export function renderHomeTab(ctx: HomeTabContext): string {
  const { schedule, preflight } = ctx;
  const partCount = store.getAllParticipants().length;
  const tplCount = store.getAllTaskTemplates().length;
  // Frozen-snapshot rule: a generated schedule's day count is immutable on the
  // snapshot; pre-generation we show the configured value. Mirrors app.ts:4581.
  const days = schedule ? schedule.periodDays : store.getScheduleDays();

  let eyebrow: string;
  let headline: string;
  if (schedule) {
    eyebrow = 'ניהול שיבוצים חכם';
    headline = schedule.feasible ? 'השבצ"ק מוכן' : 'השבצ"ק דורש תשומת לב';
  } else if (preflight.canGenerate) {
    eyebrow = 'ניהול שיבוצים חכם';
    headline = 'בוא ניצור שבצ"ק';
  } else {
    eyebrow = 'ניהול שיבוצים חכם';
    headline = 'כמעט מוכן';
  }
  const subline =
    !schedule && !preflight.canGenerate
      ? 'השלם את ההגדרות כדי ליצור שבצ"ק'
      : `${days} ימים · ${partCount} משתתפים · ${tplCount} משימות`;

  const stateTile = schedule
    ? `<div class="score-card ${schedule.feasible ? 'status-ok' : 'status-error'}">
        <div class="score-value">${schedule.feasible ? 'ישים' : 'לא ישים'}</div>
        <div class="score-label">מצב</div>
      </div>`
    : `<div class="score-card">
        <div class="score-value home-stat-muted">—</div>
        <div class="score-label">מצב</div>
      </div>`;

  return `<div class="home-view">
    <section class="home-hero">
      <div class="home-hero-body">
        <p class="home-hero-eyebrow">${eyebrow}</p>
        <h2 class="home-hero-headline">${headline}</h2>
        <p class="home-hero-sub">${subline}</p>
        ${renderCta(ctx)}
        <button type="button" class="home-help" data-action="help">📖 סיור מודרך במערכת</button>
      </div>
    </section>

    ${schedule ? renderStatusStrip(schedule) : ''}
    ${!schedule && !preflight.canGenerate ? renderGuideToFix(preflight) : ''}

    <div class="home-stats" role="group" aria-label="נתונים">
      <div class="score-card">
        <div class="score-value">${partCount}</div>
        <div class="score-label">משתתפים</div>
      </div>
      <div class="score-card">
        <div class="score-value">${tplCount}</div>
        <div class="score-label">משימות</div>
      </div>
      <div class="score-card">
        <div class="score-value">${days}</div>
        <div class="score-label">ימים</div>
      </div>
      ${stateTile}
    </div>

    <nav class="home-quicklinks" aria-label="ניווט מהיר">
      ${QUICK_LINKS.map(
        (l) =>
          `<button type="button" class="home-quicklink" data-action="nav-${l.target}">
            <span class="home-quicklink-icon" aria-hidden="true">${l.icon}</span>
            <span class="home-quicklink-label">${l.label}</span>
          </button>`,
      ).join('')}
    </nav>
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
