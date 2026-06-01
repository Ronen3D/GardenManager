/**
 * Score-breakdown debug panel — undocumented triple-click easter egg
 * on the dashboard score chip.
 *
 * The panel exposes how `schedule.score.compositeScore` is built term-by-term.
 * All numeric components live on `Schedule.score` (frozen at generation) and
 * `Schedule.algorithmSettings.config` (frozen weights), so the breakdown is
 * pure rendering — no engine recomputation.
 *
 * Advanced section (collapsed by default) lazily computes top rest gaps
 * the first time the user expands it.
 */

import type { Participant, Schedule, SchedulerConfig, ScheduleScore, Task } from '../models/types';
import { computeAllRestProfiles, type ParticipantRestProfile } from '../shared/utils/rest-calculator';
import { escHtml } from './ui-helpers';

// ─── Per-attempt history (pushed by app.ts during generation) ────────────────

let _attemptScoreHistory: number[] = [];

export function pushAttemptScore(score: number): void {
  _attemptScoreHistory.push(score);
}

export function clearAttemptScoreHistory(): void {
  _attemptScoreHistory = [];
}

function getAttemptScoreHistory(): readonly number[] {
  return _attemptScoreHistory;
}

// ─── Triple-click detection ─────────────────────────────────────────────────

const TRIPLE_CLICK_WINDOW_MS = 800;

/**
 * Attach a silent triple-click handler to a node. Three clicks within
 * TRIPLE_CLICK_WINDOW_MS open the breakdown modal. Single/double clicks
 * do nothing (no `cursor: pointer`, no tooltip — the easter egg is
 * deliberately undiscoverable from the UI itself).
 */
export function attachTripleClickOpener(node: HTMLElement, scheduleGetter: () => Schedule | null): () => void {
  const stamps: number[] = [];
  const onClick = (): void => {
    const now = Date.now();
    stamps.push(now);
    if (stamps.length > 3) stamps.shift();
    if (stamps.length === 3 && now - stamps[0] <= TRIPLE_CLICK_WINDOW_MS) {
      stamps.length = 0;
      const schedule = scheduleGetter();
      if (schedule) openScoreBreakdownModal(schedule);
    }
  };
  node.addEventListener('click', onClick);
  return () => node.removeEventListener('click', onClick);
}

// ─── Breakdown computation (pure arithmetic on frozen Schedule.score) ────────

type RowGroup = 'reward' | 'cost';

interface BreakdownRow {
  id: string;
  /** Short Hebrew name */
  label: string;
  /** Plain-Hebrew explanation shown beneath the label (always visible) */
  subtitle: string;
  /** Constraint code (SC-3, SC-6 etc) — appended to the label as a small tag */
  code: string;
  /** Group: rewards add to the score, costs subtract */
  group: RowGroup;
  /** Signed weight as it appears in the formula (rewards positive, costs negative) */
  signedWeight: number;
  /** Always-positive raw value displayed in the table */
  raw: number;
  /** Final signed contribution to compositeScore */
  contribution: number;
  /** True when this signal is active (weight ≠ 0 and raw ≠ 0). Dimmed otherwise. */
  active: boolean;
  /** Hint shown beneath the subtitle when not active */
  inactiveHint?: string;
}

function buildBreakdownRows(score: ScheduleScore, config: SchedulerConfig): BreakdownRow[] {
  const dailySum = score.dailyPerParticipantStdDev + score.dailyGlobalStdDev;
  const rows: BreakdownRow[] = [];

  // ── Rewards (always positive contribution when raw > 0) ────────────────────
  rows.push({
    id: 'minRest',
    label: 'מנוחת בסיס',
    subtitle: 'תגמול לפי שעות המנוחה הקצרות ביותר במערכת. מבטיח שאף משתתף לא נדחק לפער קצר במיוחד.',
    code: 'SC-3',
    group: 'reward',
    signedWeight: config.minRestWeight,
    raw: score.minRestHours,
    contribution: config.minRestWeight * score.minRestHours,
    active: config.minRestWeight > 0 && score.minRestHours > 0,
    inactiveHint: config.minRestWeight === 0 ? 'המשקל מוגדר ל-0 — לא משפיע על הציון' : undefined,
  });

  rows.push({
    id: 'restPerGap',
    label: 'פיזור מנוחה',
    subtitle:
      'סכום השורשים של כל פערי המנוחה (Σ√gap). כל פער תורם בנפרד עם תשואה פוחתת — מתגמל גם שיפור פערים שאינם הקצרים ביותר.',
    code: 'SC-3',
    group: 'reward',
    signedWeight: config.restPerGapWeight,
    raw: score.restPerGapBonus,
    contribution: config.restPerGapWeight * score.restPerGapBonus,
    active: config.restPerGapWeight > 0 && score.restPerGapBonus > 0,
    inactiveHint: config.restPerGapWeight === 0 ? 'המשקל מוגדר ל-0 — לא משפיע על הציון' : undefined,
  });

  // ── Costs ──────────────────────────────────────────────────────────────────
  rows.push({
    id: 'l0Fair',
    label: 'אי-שוויון בעומס L0',
    subtitle: 'סטיית תקן של שעות העומס בין משתתפי L0. נמוך יותר = חלוקה הוגנת יותר.',
    code: 'SC-3',
    group: 'cost',
    signedWeight: -config.l0FairnessWeight,
    raw: score.l0StdDev,
    contribution: -config.l0FairnessWeight * score.l0StdDev,
    active: config.l0FairnessWeight > 0 && score.l0StdDev > 0,
    inactiveHint: config.l0FairnessWeight === 0 ? 'המשקל מוגדר ל-0 — לא משפיע על הציון' : undefined,
  });

  rows.push({
    id: 'seniorFair',
    label: 'אי-שוויון בעומס בכירים',
    subtitle: 'סטיית תקן של שעות העומס בין הבכירים (L2-L4). נמוך יותר = חלוקה הוגנת יותר.',
    code: 'SC-3',
    group: 'cost',
    signedWeight: -config.seniorFairnessWeight,
    raw: score.seniorStdDev,
    contribution: -config.seniorFairnessWeight * score.seniorStdDev,
    active: config.seniorFairnessWeight > 0 && score.seniorStdDev > 0,
    inactiveHint: config.seniorFairnessWeight === 0 ? 'המשקל מוגדר ל-0 — לא משפיע על הציון' : undefined,
  });

  rows.push({
    id: 'dailyBalance',
    label: 'חוסר איזון יומי',
    subtitle:
      'סכום של שתי סטיות תקן יומיות מול יעד פרופורציונלי לזמינות: פר-משתתף (כמה החלוקה היומית סוטה מהיעד שלו) + גלובלי (כמה כל יום סוטה מהיעד הקבוצתי).',
    code: 'SC-8',
    group: 'cost',
    signedWeight: -config.dailyBalanceWeight,
    raw: dailySum,
    contribution: -config.dailyBalanceWeight * dailySum,
    active: config.dailyBalanceWeight > 0 && dailySum > 0,
    inactiveHint: config.dailyBalanceWeight === 0 ? 'המשקל מוגדר ל-0 — לא משפיע על הציון' : undefined,
  });

  // ── Penalty buckets (split out from totalPenalty for clarity) ──────────────
  const lp = score.lowPriorityPenalty ?? 0;
  rows.push({
    id: 'lowPri',
    label: 'שיבוץ לרמה לא-רצויה',
    subtitle: 'קנס על כל שיבוץ של משתתף למשבצת שבה רמתו מסומנת lowPriority — שיבוץ אפשרי, אך לא מועדף.',
    code: 'SC-6',
    group: 'cost',
    signedWeight: -1,
    raw: lp,
    contribution: -lp,
    active: lp > 0,
    inactiveHint: lp === 0 ? 'אין הפרות — השבצ"ק לא דחק אף משתתף לרמה לא-רצויה' : undefined,
  });

  const nw = score.notWithPenalty ?? 0;
  rows.push({
    id: 'notWith',
    label: '"לא ביחד"',
    subtitle: 'קנס על כל זוג משתתפים שסומנו "לא ביחד" ושובצו יחד באותה משימה.',
    code: 'SC-9',
    group: 'cost',
    signedWeight: -1,
    raw: nw,
    contribution: -nw,
    active: nw > 0,
    inactiveHint: nw === 0 ? 'אין זוגות "לא-ביחד" שובצו יחד' : undefined,
  });

  // SC-10 task name preference: NET signal — penalty minus bonus.
  // When net ≥ 0 it's a cost; when net < 0 (bonuses dominate) it becomes a
  // reward, which we represent honestly by switching the row's group instead
  // of showing "−1 × negative = positive".
  const tp = score.taskPrefPenalty ?? 0;
  if (tp >= 0) {
    rows.push({
      id: 'taskPref',
      label: 'העדפות משימות (קנס נטו)',
      subtitle: 'נטו של SC-10: קנסות על אי-שיבוץ למשימות מועדפות פחות בונוסים על שיבוץ אליהן. חיובי = הקנסות גברו.',
      code: 'SC-10',
      group: 'cost',
      signedWeight: -1,
      raw: tp,
      contribution: -tp,
      active: tp > 0,
      inactiveHint: tp === 0 ? 'נטו אפס — קנסות ובונוסים מתאזנים' : undefined,
    });
  } else {
    // tp < 0 → bonuses won. Display in rewards group with positive math.
    rows.push({
      id: 'taskPref',
      label: 'העדפות משימות (תגמול נטו)',
      subtitle: 'נטו של SC-10: בונוסים על שיבוץ למשימות מועדפות עלו על הקנסות על אי-שיבוץ אליהן.',
      code: 'SC-10',
      group: 'reward',
      signedWeight: 1,
      raw: -tp,
      contribution: -tp, // = |tp|, positive
      active: true,
    });
  }

  // Shift-split penalty — cost (config.splitPenalty × number of split slots).
  // Included so the term sum reconstructs compositeScore when a schedule has
  // splits; zero/dimmed otherwise.
  const sp = score.splitPenalty ?? 0;
  rows.push({
    id: 'splitPenalty',
    label: 'פיצול משמרות',
    subtitle: 'קנס לכל משבצת שפוצלה לשני חצאים — הסף שעליו צריך פיצול לשיפור איכות לעבור כדי להיחשב משתלם.',
    code: 'SPLIT',
    group: 'cost',
    signedWeight: -1,
    raw: sp,
    contribution: -sp,
    active: sp > 0,
    inactiveHint: sp === 0 ? 'לא פוצלו משמרות' : undefined,
  });

  return rows;
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(digits);
}

function signedFmt(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return n > 0 ? '+∞' : '−∞';
  if (n === 0) return '0';
  const abs = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${abs}` : `−${abs}`;
}

/** Wrap a numeric string in <bdi dir="ltr"> so signs render predictably in RTL context. */
function num(s: string): string {
  return `<bdi dir="ltr">${s}</bdi>`;
}

// ─── Modal markup ────────────────────────────────────────────────────────────

function renderHelpHeader(): string {
  return `<div class="gm-sb-help">
    <div class="gm-sb-help-title">איך מורכב הציון?</div>
    <div class="gm-sb-help-body">
      הציון = <strong>סך התגמולים</strong> (מנוחה ופיזור) − <strong>סך העלויות</strong> (חוסר שוויון, חוסר איזון יומי, וקנסות).
      ציון גבוה יותר משקף שבצ"ק איכותי יותר. כל שורה מציגה את חלקה היחסי בציון — הרכיבים הצבועים בירוק תורמים לציון, האדומים מורידים ממנו.
    </div>
  </div>`;
}

function renderSummary(rows: BreakdownRow[], composite: number): string {
  let rewardSum = 0;
  let costSum = 0;
  for (const r of rows) {
    if (r.contribution >= 0) rewardSum += r.contribution;
    else costSum += -r.contribution;
  }
  const sumCheck = rewardSum - costSum;
  const drift = Math.abs(sumCheck - composite);
  const driftLine =
    drift > 0.01
      ? `<div class="gm-sb-drift" title="פער מהסכום המאוחסן">⚠ פער טכני של ${fmt(drift, 2)} בין הסכום המוצג לציון השמור</div>`
      : '';
  return `<div class="gm-sb-summary">
    <div class="gm-sb-summary-row gm-sb-summary-rewards">
      <span class="gm-sb-summary-label">סך תגמולים (מוסיפים לציון)</span>
      <span class="gm-sb-summary-value">${num(signedFmt(rewardSum))}</span>
    </div>
    <div class="gm-sb-summary-row gm-sb-summary-costs">
      <span class="gm-sb-summary-label">סך עלויות (מורידות מהציון)</span>
      <span class="gm-sb-summary-value">${num(signedFmt(-costSum))}</span>
    </div>
    <div class="gm-sb-summary-divider"></div>
    <div class="gm-sb-summary-row gm-sb-summary-total">
      <span class="gm-sb-summary-label">ציון סופי</span>
      <span class="gm-sb-summary-value">${num(signedFmt(composite))}</span>
    </div>
    ${driftLine}
  </div>`;
}

function renderTableHeader(): string {
  // 5 columns: רכיב | משקל | ערך | תרומה | %
  // Math operators (× and =) live inside the body cells visually, not as their
  // own columns, to avoid empty header cells and keep the layout dense.
  return `<div class="gm-sb-row gm-sb-row-header" role="row">
    <span class="gm-sb-cell gm-sb-name">רכיב</span>
    <span class="gm-sb-cell gm-sb-num" title="המשקל הקבוע ברכיב — מסומן ± לפי האם הרכיב תגמול או עלות">משקל</span>
    <span class="gm-sb-cell gm-sb-num" title="הערך שחישבה המערכת עבור השבצ&quot;ק הזה">ערך מהשבצ"ק</span>
    <span class="gm-sb-cell gm-sb-num" title="המכפלה של משקל × ערך — תרומת הרכיב לציון הסופי">תרומה לציון</span>
    <span class="gm-sb-cell gm-sb-num" title="חלקו היחסי של הרכיב בסך |התרומות|">% מסך השפעה</span>
  </div>`;
}

function renderRow(row: BreakdownRow, sharePct: number): string {
  const dim = row.active ? '' : ' gm-sb-row-dim';
  const sign = row.contribution >= 0 ? 'positive' : 'negative';
  const codeBadge = `<span class="gm-sb-code">${escHtml(row.code)}</span>`;
  // Subtitle and inactive hint span the full width of the row (all 5 columns),
  // so the narrow label column doesn't get squeezed by long explanations.
  const inactiveLine = row.inactiveHint ? `<span class="gm-sb-inactive">${escHtml(row.inactiveHint)}</span>` : '';
  // Weight: signed (sign reflects the formula). Use unsigned digits for whole numbers.
  const weightStr = signedFmt(row.signedWeight, row.signedWeight % 1 === 0 ? 0 : 2);
  // Raw is always shown as a non-negative number (sign lives in the weight).
  const rawStr = fmt(row.raw, 2);
  const contribStr = signedFmt(row.contribution);
  const pctStr = row.active ? `${fmt(sharePct, 1)}%` : '–';
  return `<div class="gm-sb-row gm-sb-row-${sign}${dim}" role="row">
    <span class="gm-sb-cell gm-sb-name">${escHtml(row.label)} ${codeBadge}</span>
    <span class="gm-sb-cell gm-sb-num gm-sb-weight">${num(weightStr)}</span>
    <span class="gm-sb-cell gm-sb-num gm-sb-raw">${num(rawStr)}</span>
    <span class="gm-sb-cell gm-sb-num gm-sb-contrib">${num(contribStr)}</span>
    <span class="gm-sb-cell gm-sb-num gm-sb-share">${num(pctStr)}</span>
    <span class="gm-sb-subtitle">${escHtml(row.subtitle)}</span>
    ${inactiveLine}
  </div>`;
}

function renderGroupHeader(group: RowGroup, count: number): string {
  const text = group === 'reward' ? `תגמולים — מוסיפים לציון (${count})` : `עלויות — מורידות מהציון (${count})`;
  return `<div class="gm-sb-group gm-sb-group-${group}" role="row">
    <span class="gm-sb-group-label" style="grid-column: 1 / -1;">${escHtml(text)}</span>
  </div>`;
}

function renderTotalRow(composite: number): string {
  return `<div class="gm-sb-row gm-sb-row-total" role="row">
    <span class="gm-sb-cell gm-sb-name">= ציון סופי</span>
    <span class="gm-sb-cell gm-sb-num"></span>
    <span class="gm-sb-cell gm-sb-num"></span>
    <span class="gm-sb-cell gm-sb-num gm-sb-contrib">${num(signedFmt(composite))}</span>
    <span class="gm-sb-cell gm-sb-num"></span>
  </div>`;
}

function renderBasicTable(rows: BreakdownRow[], composite: number): string {
  // Per-row global share is |contribution| / sum(|contributions|).
  const totalAbs = rows.reduce((s, r) => s + Math.abs(r.contribution), 0);
  const rewards = rows
    .filter((r) => r.group === 'reward')
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const costs = rows
    .filter((r) => r.group === 'cost')
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const renderGroup = (group: RowGroup, list: BreakdownRow[]): string =>
    `${renderGroupHeader(group, list.length)}
     ${list
       .map((r) => {
         const share = totalAbs > 0 ? (Math.abs(r.contribution) / totalAbs) * 100 : 0;
         return renderRow(r, share);
       })
       .join('')}`;
  return `<div class="gm-sb-table" role="table">
    ${renderTableHeader()}
    ${renderGroup('reward', rewards)}
    ${renderGroup('cost', costs)}
    ${renderTotalRow(composite)}
  </div>`;
}

// ─── Advanced section ────────────────────────────────────────────────────────

function renderTopRestGaps(profiles: Map<string, ParticipantRestProfile>, participants: Participant[]): string {
  const pMap = new Map(participants.map((p) => [p.id, p]));
  type GapEntry = { participantName: string; gap: number };
  const entries: GapEntry[] = [];
  for (const prof of profiles.values()) {
    if (prof.restGaps.length === 0) continue;
    const minGap = Math.min(...prof.restGaps);
    if (!Number.isFinite(minGap)) continue;
    const p = pMap.get(prof.participantId);
    entries.push({ participantName: p?.name ?? prof.participantId, gap: minGap });
  }
  entries.sort((a, b) => a.gap - b.gap);
  const top = entries.slice(0, 5);
  const subtitle = 'חמשת המשתתפים עם פער המנוחה הקצר ביותר בלוח. הם הראשונים שייפגעו אם תיווצר עומס נוסף.';
  if (top.length === 0) {
    return `<div class="gm-sb-sub">
      <div class="gm-sb-sub-title">פערי מנוחה הצרים ביותר</div>
      <div class="gm-sb-sub-desc">${escHtml(subtitle)}</div>
      <div class="gm-sb-sub-row gm-sb-sub-empty">אין פערי מנוחה במערכת (אין מספיק שיבוצים נושאי-עומס)</div>
    </div>`;
  }
  return `<div class="gm-sb-sub">
    <div class="gm-sb-sub-title">פערי מנוחה הצרים ביותר</div>
    <div class="gm-sb-sub-desc">${escHtml(subtitle)}</div>
    ${top
      .map(
        (e) =>
          `<div class="gm-sb-sub-row">
            <span>${escHtml(e.participantName)}</span>
            <span>${num(fmt(e.gap))} שעות</span>
          </div>`,
      )
      .join('')}
  </div>`;
}

function renderSparkline(history: readonly number[]): string {
  const subtitle = 'כל נקודה היא הציון הסופי של ניסיון אופטימיזציה אחד. פיזור גדול = רגישות גבוהה לסדר השיבוץ ההתחלתי.';
  if (history.length < 2) {
    return `<div class="gm-sb-sub">
      <div class="gm-sb-sub-title">היסטוריית ניסיונות</div>
      <div class="gm-sb-sub-desc">${escHtml(subtitle)}</div>
      <div class="gm-sb-sub-row gm-sb-sub-empty">אין מספיק ניסיונות (יש להריץ "צור שבצ&quot;ק" עם מעל ניסיון אחד)</div>
    </div>`;
  }
  const w = 320;
  const h = 60;
  const pad = 4;
  let min = Infinity;
  let max = -Infinity;
  for (const v of history) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const stepX = (w - 2 * pad) / Math.max(1, history.length - 1);
  const points = history
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = history[history.length - 1];
  const best = Math.max(...history);
  return `<div class="gm-sb-sub">
    <div class="gm-sb-sub-title">היסטוריית ניסיונות (${history.length})</div>
    <div class="gm-sb-sub-desc">${escHtml(subtitle)}</div>
    <svg class="gm-sb-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="ציון לכל ניסיון">
      <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
    <div class="gm-sb-sub-row"><span>הטוב ביותר</span><span>${num(signedFmt(best))}</span></div>
    <div class="gm-sb-sub-row"><span>הניסיון האחרון</span><span>${num(signedFmt(last))}</span></div>
    <div class="gm-sb-sub-row"><span>טווח</span><span>${num(`${signedFmt(min)} … ${signedFmt(max)}`)}</span></div>
  </div>`;
}

function renderWhatIf(rows: BreakdownRow[], composite: number): string {
  const subtitle = 'מה היה הציון אם רכיב מסוים היה מבוטל (משקלו 0). שימושי כדי לבדוק כמה כל רכיב משפיע בפועל.';
  const sorted = [...rows].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const items = sorted
    .map((r) => {
      const without = composite - r.contribution;
      const delta = -r.contribution; // change in score relative to current
      return `<div class="gm-sb-sub-row">
        <span>בלי "${escHtml(r.label)}"</span>
        <span>${num(signedFmt(without))} <span class="gm-sb-delta">(${num(signedFmt(delta))})</span></span>
      </div>`;
    })
    .join('');
  return `<div class="gm-sb-sub">
    <div class="gm-sb-sub-title">ניתוח רגישות</div>
    <div class="gm-sb-sub-desc">${escHtml(subtitle)}</div>
    ${items}
  </div>`;
}

function renderAdvanced(schedule: Schedule, rows: BreakdownRow[]): string {
  const composite = schedule.score.compositeScore;
  return `<details class="gm-sb-advanced">
    <summary>פרטים נוספים (אבחון מתקדם)</summary>
    <div class="gm-sb-advanced-content" data-advanced-loaded="0">
      <div class="gm-sb-toprests-slot"></div>
      ${renderSparkline(getAttemptScoreHistory())}
      ${renderWhatIf(rows, composite)}
      <div class="gm-sb-actions">
        <button type="button" class="btn-sm btn-outline gm-sb-copy">העתק JSON אבחון</button>
      </div>
    </div>
  </details>`;
}

function renderBody(schedule: Schedule): string {
  const score = schedule.score;
  const config = schedule.algorithmSettings.config;
  const rows = buildBreakdownRows(score, config);
  return `<div class="gm-score-breakdown" dir="rtl">
    ${renderHelpHeader()}
    ${renderSummary(rows, score.compositeScore)}
    ${renderBasicTable(rows, score.compositeScore)}
    ${renderAdvanced(schedule, rows)}
  </div>`;
}

// ─── Modal lifecycle (custom: we want gm-modal-dialog-wide) ──────────────────

let _bodyScrollLockCount = 0;

function lockBodyScroll(): void {
  _bodyScrollLockCount++;
  if (_bodyScrollLockCount === 1) {
    document.body.style.overflow = 'hidden';
  }
}

function unlockBodyScroll(): void {
  _bodyScrollLockCount = Math.max(0, _bodyScrollLockCount - 1);
  if (_bodyScrollLockCount === 0) {
    document.body.style.overflow = '';
  }
}

/**
 * Open the score-breakdown modal. Public for callers that want to bypass
 * the triple-click handler (none today, but useful for tests).
 */
export function openScoreBreakdownModal(schedule: Schedule): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'gm-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gm-modal-dialog gm-modal-dialog-wide" role="dialog" aria-modal="true">
      <div class="gm-modal-header">
        <span class="gm-modal-icon">📊</span>
        <span class="gm-modal-title">פירוט הציון</span>
      </div>
      <div class="gm-modal-body">${renderBody(schedule)}</div>
      <div class="gm-modal-actions">
        <button class="btn-primary gm-modal-btn-ok">סגור</button>
      </div>
    </div>`;

  lockBodyScroll();
  const close = (): void => {
    backdrop.remove();
    unlockBodyScroll();
    document.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  backdrop.querySelector('.gm-modal-btn-ok')!.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  // Lazy-load top rest gaps on first <details> open. Computing them via
  // computeAllRestProfiles is fast (~1ms on a typical week) but kept off the
  // initial render so the modal opens instantly even if the user only wants
  // the basic view.
  const details = backdrop.querySelector('.gm-sb-advanced') as HTMLDetailsElement | null;
  const advancedContent = backdrop.querySelector('.gm-sb-advanced-content') as HTMLElement | null;
  const topRestsSlot = backdrop.querySelector('.gm-sb-toprests-slot') as HTMLElement | null;
  if (details && advancedContent && topRestsSlot) {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      if (advancedContent.dataset.advancedLoaded === '1') return;
      advancedContent.dataset.advancedLoaded = '1';
      const profiles = computeAllRestProfiles(schedule.participants, schedule.assignments, schedule.tasks as Task[]);
      topRestsSlot.outerHTML = renderTopRestGaps(profiles, schedule.participants);
    });
  }

  // "Copy diagnostic JSON" wiring
  const copyBtn = backdrop.querySelector('.gm-sb-copy') as HTMLButtonElement | null;
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const dump = {
        score: schedule.score,
        config: schedule.algorithmSettings.config,
        attemptHistory: [...getAttemptScoreHistory()],
        generatedAt: schedule.generatedAt,
      };
      const text = JSON.stringify(dump, null, 2);
      void navigator.clipboard?.writeText(text).then(
        () => {
          copyBtn.textContent = 'הועתק ✓';
          setTimeout(() => {
            copyBtn.textContent = 'העתק JSON אבחון';
          }, 1500);
        },
        () => {
          copyBtn.textContent = 'העתקה נכשלה';
        },
      );
    });
  }

  document.body.appendChild(backdrop);
  (backdrop.querySelector('.gm-modal-btn-ok') as HTMLElement).focus();
}
