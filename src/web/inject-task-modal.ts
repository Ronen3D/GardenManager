/**
 * Inject Emergency Task Modal — UI for adding a one-time emergency task to
 * an existing schedule snapshot and auto-staffing it from the current
 * participant pool.
 *
 * Flow:
 *   1. User fills a form (name, day/time/duration, slot levels + certs, flags).
 *   2. User clicks "הוסף ושבץ" → we call `searchInjectionPlans()`.
 *   3. A "plans" view shows the top-ranked plan with alternatives and the
 *      composite-score delta vs the current schedule. The user can switch
 *      between alternatives and apply.
 *   4. User clicks "אשר" → `result.apply(planId)` materialises the swaps and
 *      onCommit handles persistence + revalidation.
 *      User clicks "בטל" → `result.cancel()` removes task + placeholders.
 */

import {
  type InjectedTaskSpec,
  type InjectionPlan,
  type InjectionResult,
  type StaffingReport,
  searchInjectionPlans,
} from '../engine/inject';
import { getInjectStartFloor, isDayModifiable } from '../engine/temporal';
import {
  Level,
  type Participant,
  type Schedule,
  type SchedulingEngine,
  type SlotTemplate,
  type SubTeamTemplate,
  type Task,
} from '../index';
import * as store from './config-store';
import { isTouchDevice } from './responsive';
import { operationalHourOrder } from './schedule-utils';
import { escHtml, stripDayPrefix } from './ui-helpers';

const MINUTE_STEPS = [0, 10, 20, 30, 40, 50] as const;

/** Position of `hour` on the operational ring starting at `dsh` (0..23). */
function opIndex(hour: number, dsh: number): number {
  return (hour - dsh + 24) % 24;
}

// ─── Context injection ──────────────────────────────────────────────────────

export interface InjectTaskContext {
  getSchedule: () => Schedule | null;
  getEngine: () => SchedulingEngine | null;
  /**
   * Called after the user confirms the injection. The caller should:
   *   - engine.revalidateFull()
   *   - persist the schedule
   *   - if saveToStore is true, also call store.addOneTimeTask(...)
   *   - re-render the schedule
   */
  onCommit: (schedule: Schedule, report: StaffingReport, saveToStore: boolean, spec: InjectedTaskSpec) => void;
}

let _ctx: InjectTaskContext | null = null;

export function initInjectTaskModal(ctx: InjectTaskContext): void {
  _ctx = ctx;
}

// ─── Modal state ────────────────────────────────────────────────────────────

interface DraftState {
  name: string;
  dayIndex: number;
  startHour: number;
  startMinute: number;
  durationHours: number;
  sameGroupRequired: boolean;
  blocksConsecutive: boolean;
  restRuleId: string;
  description: string;
  baseLoadWeight: number;
  saveToStore: boolean;
  slots: DraftSlot[];
}

interface DraftSlot {
  id: string;
  label: string;
  levels: { level: Level; enabled: boolean; lowPriority: boolean }[];
  requiredCertifications: string[];
  forbiddenCertifications: string[];
}

let _draft: DraftState | null = null;
let _phase: 'form' | 'plans' = 'form';
let _searchResult: InjectionResult | null = null;
let _selectedPlanId: string | null = null;
let _lastSpec: InjectedTaskSpec | null = null;
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

/** Whether we've already called onCommit (so the close handler doesn't rollback). */
let _committed = false;

// ─── Public API ─────────────────────────────────────────────────────────────

export function openInjectTaskModal(): void {
  const schedule = _ctx?.getSchedule();
  if (!schedule) return;
  _draft = makeDefaultDraft(schedule, getAnchor());
  _phase = 'form';
  _searchResult = null;
  _selectedPlanId = null;
  _lastSpec = null;
  _committed = false;
  render();
}

/** Live Mode anchor or null when Live Mode is off. */
function getAnchor(): Date | null {
  const lm = store.getLiveModeState();
  return lm.enabled ? lm.currentTimestamp : null;
}

export function closeInjectTaskModal(): void {
  // If a search produced a result but we never applied/committed, roll back.
  if (_phase === 'plans' && _searchResult && !_committed) {
    _searchResult.cancel();
    const engine = _ctx?.getEngine();
    engine?.revalidateFull();
  }
  document.getElementById('inject-modal-backdrop')?.remove();
  _draft = null;
  _phase = 'form';
  _searchResult = null;
  _selectedPlanId = null;
  _lastSpec = null;
  _committed = false;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

// ─── Draft defaults ─────────────────────────────────────────────────────────

function makeDefaultDraft(schedule: Schedule, anchor: Date | null): DraftState {
  const dsh = schedule.algorithmSettings.dayStartHour;

  let dayIndex = 1;
  if (anchor) {
    for (let d = 1; d <= schedule.periodDays; d++) {
      if (isDayModifiable(d, schedule.periodStart, anchor, dsh)) {
        dayIndex = d;
        break;
      }
    }
  }

  let startHour = dsh;
  let startMinute = 0;
  if (anchor) {
    const floor = getInjectStartFloor(dayIndex, schedule.periodStart, anchor, dsh);
    if (floor) {
      startHour = floor.hourMin;
      startMinute = Math.ceil(floor.minuteMin / 10) * 10;
      if (startMinute >= 60) {
        startMinute = 0;
        const nextOpIdx = opIndex(startHour, dsh) + 1;
        if (nextOpIdx < 24) startHour = (dsh + nextOpIdx) % 24;
      }
    }
  }

  return {
    name: '',
    dayIndex,
    startHour,
    startMinute,
    durationHours: 4,
    sameGroupRequired: false,
    blocksConsecutive: true,
    restRuleId: '',
    description: '',
    baseLoadWeight: 1,
    saveToStore: false,
    slots: [makeDefaultSlot()],
  };
}

function makeDefaultSlot(): DraftSlot {
  return {
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    label: '',
    levels: [
      { level: Level.L0, enabled: true, lowPriority: false },
      { level: Level.L2, enabled: true, lowPriority: false },
      { level: Level.L3, enabled: true, lowPriority: false },
      { level: Level.L4, enabled: true, lowPriority: false },
    ],
    requiredCertifications: [],
    forbiddenCertifications: [],
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  const prev = document.getElementById('inject-modal-backdrop');
  const prevScroll = prev?.querySelector<HTMLElement>('.inject-body')?.scrollTop ?? 0;
  prev?.remove();

  const schedule = _ctx?.getSchedule();
  if (!schedule || !_draft) return;

  const html = _phase === 'form' ? renderForm(schedule) : renderPlans(schedule);
  document.body.insertAdjacentHTML('beforeend', html);
  wireEvents();

  if (prevScroll > 0) {
    const body = document.querySelector<HTMLElement>('#inject-modal-backdrop .inject-body');
    if (body) body.scrollTop = prevScroll;
  }
}

function renderForm(schedule: Schedule): string {
  const d = _draft!;
  const anchor = getAnchor();
  const dsh = schedule.algorithmSettings.dayStartHour;

  const floor = anchor ? getInjectStartFloor(d.dayIndex, schedule.periodStart, anchor, dsh) : null;
  const dayIsInjectable = anchor ? isDayModifiable(d.dayIndex, schedule.periodStart, anchor, dsh) : true;
  let hourMin = dsh;
  let minuteMin = 0;
  if (anchor && floor) {
    hourMin = floor.hourMin;
    if (d.startHour === hourMin) minuteMin = floor.minuteMin;
    if (opIndex(d.startHour, dsh) < opIndex(hourMin, dsh)) {
      d.startHour = hourMin;
      d.startMinute = floor.minuteMin;
    } else if (d.startHour === hourMin && d.startMinute < floor.minuteMin) {
      d.startMinute = floor.minuteMin;
    }
    if (d.startMinute % 10 !== 0) {
      const snapped = Math.ceil(d.startMinute / 10) * 10;
      if (snapped >= 60) {
        d.startMinute = 0;
        const nextOpIdx = opIndex(d.startHour, dsh) + 1;
        if (nextOpIdx < 24) d.startHour = (dsh + nextOpIdx) % 24;
      } else {
        d.startMinute = snapped;
      }
    }
  } else if (d.startMinute % 10 !== 0) {
    d.startMinute = (Math.ceil(d.startMinute / 10) * 10) % 60;
  }

  const dayOptions = Array.from({ length: schedule.periodDays }, (_, i) => {
    const idx = i + 1;
    const selected = idx === d.dayIndex ? ' selected' : '';
    if (anchor === null) {
      return `<option value="${idx}"${selected}>יום ${idx}</option>`;
    }
    if (!isDayModifiable(idx, schedule.periodStart, anchor, dsh)) {
      return `<option value="${idx}" disabled title="יום בעבר — לא ניתן להוסיף משימת חירום">יום ${idx} 🧊</option>`;
    }
    const opStart = new Date(
      schedule.periodStart.getFullYear(),
      schedule.periodStart.getMonth(),
      schedule.periodStart.getDate() + idx - 1,
      dsh,
      0,
    );
    if (anchor.getTime() > opStart.getTime()) {
      return `<option value="${idx}"${selected} title="יום נוכחי — שעת ההתחלה תוגבל להווה">יום ${idx} ⏳</option>`;
    }
    return `<option value="${idx}"${selected}>יום ${idx}</option>`;
  }).join('');

  const hourMinOp = opIndex(hourMin, dsh);
  const hourOptions = operationalHourOrder(dsh)
    .map((h) => {
      const disabled = anchor !== null && opIndex(h, dsh) < hourMinOp;
      const sel = h === d.startHour ? ' selected' : '';
      return `<option value="${h}"${sel}${disabled ? ' disabled' : ''}>${String(h).padStart(2, '0')}</option>`;
    })
    .join('');

  const minuteOptions = MINUTE_STEPS.map((m) => {
    const disabled = d.startHour === hourMin && m < minuteMin;
    const sel = m === d.startMinute ? ' selected' : '';
    return `<option value="${m}"${sel}${disabled ? ' disabled' : ''}>${String(m).padStart(2, '0')}</option>`;
  }).join('');

  const pastTimeBanner =
    anchor !== null && !dayIsInjectable
      ? `<div class="inject-past-banner" role="alert">היום שנבחר בעבר — בחר יום עתידי.</div>`
      : '';

  const restRuleOptions = [
    `<option value="">ללא</option>`,
    ...Object.entries(schedule.restRuleSnapshot).map(([id, ms]) => {
      const live = store.getRestRuleById(id);
      const label = live?.label ?? id;
      const hours = live?.durationHours ?? ms / 3600000;
      return `<option value="${escHtml(id)}"${id === d.restRuleId ? ' selected' : ''}>${escHtml(label)} (${hours} שע׳)</option>`;
    }),
  ].join('');

  let slotsHtml = '';
  for (let i = 0; i < d.slots.length; i++) {
    slotsHtml += renderSlotRow(d.slots[i], i, schedule);
  }

  return `<div id="inject-modal-backdrop" class="inject-backdrop">
    <div class="inject-modal">
      <div class="inject-header">
        <h3>🚨 הוספת משימת חירום</h3>
        <button class="inject-close" id="btn-inject-close" aria-label="סגור">✕</button>
      </div>
      <div class="inject-body">
        ${pastTimeBanner}
        <section class="inject-section">
          <h4>פרטי משימה</h4>
          <div class="form-row">
            <label>שם: <input class="input-sm" type="text" data-inj="name" value="${escHtml(d.name)}" placeholder="שם המשימה" maxlength="40" /></label>
            <label>יום: <select class="input-sm" data-inj="dayIndex">${dayOptions}</select></label>
            <label>שעת התחלה: <select class="input-sm" data-inj="startHour">${hourOptions}</select></label>
            <label>דקה: <select class="input-sm" data-inj="startMinute" style="width:70px">${minuteOptions}</select></label>
            <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" data-inj="durationHours" value="${d.durationHours}" /></label>
          </div>
          <div class="form-row">
            <label class="checkbox-label"><input type="checkbox" data-inj="sameGroupRequired" ${d.sameGroupRequired ? 'checked' : ''} /> נדרשת אותה קבוצה</label>
            <label class="checkbox-label"><input type="checkbox" data-inj="blocksConsecutive" ${d.blocksConsecutive ? 'checked' : ''} /> חוסמת רצף</label>
            <label>כלל מרווח: <select class="input-sm" data-inj="restRuleId">${restRuleOptions}</select></label>
            <label>רמת עומס (0–1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-inj="baseLoadWeight" value="${d.baseLoadWeight.toFixed(2)}" /></label>
          </div>
          <div class="form-row">
            <label>תיאור: <input class="input-sm" type="text" data-inj="description" value="${escHtml(d.description)}" placeholder="אופציונלי" /></label>
          </div>
        </section>
        <section class="inject-section">
          <div class="inject-slots-header">
            <h4>משבצות (${d.slots.length})</h4>
            <button class="btn-sm btn-outline" data-inj-action="add-slot">+ משבצת</button>
          </div>
          ${slotsHtml}
        </section>
        <section class="inject-section">
          <label class="checkbox-label inject-save-label">
            <input type="checkbox" data-inj="saveToStore" ${d.saveToStore ? 'checked' : ''} />
            <span><strong>שמור את המשימה גם במסך המשימות</strong></span>
          </label>
          <div class="text-muted" style="font-size:0.9em;margin-inline-start:24px">
            כברירת מחדל, המשימה תתווסף רק לתמונת המצב הזו ותיעלם ביצירת שבצ״ק חדש.
            סמן כאן כדי לשמור אותה גם כמשימה חד-פעמית רגילה.
          </div>
        </section>
      </div>
      <div class="inject-footer">
        <button class="btn-primary" id="btn-inject-run">הוסף ושבץ</button>
        <button class="btn-outline" id="btn-inject-cancel">ביטול</button>
      </div>
    </div>
  </div>`;
}

function renderSlotRow(slot: DraftSlot, idx: number, schedule: Schedule): string {
  const certDefs = store.getCertificationDefinitions().filter((c) => !c.deleted);
  const certLabel = (id: string): string => schedule.certLabelSnapshot[id] ?? id;

  const levelButtons = slot.levels
    .map((le) => {
      const state = !le.enabled ? 'off' : le.lowPriority ? 'low' : 'on';
      const lbl = le.level === Level.L0 ? 'L0' : le.level === Level.L2 ? 'L2' : le.level === Level.L3 ? 'L3' : 'L4';
      return `<button type="button" class="inject-level inject-level--${state}" data-inj-slot="${idx}" data-inj-action="toggle-level" data-level="${le.level}">${lbl}</button>`;
    })
    .join('');

  const reqCertHtml = certDefs
    .map(
      (c) =>
        `<label class="inject-cert"><input type="checkbox" data-inj-slot="${idx}" data-inj-action="toggle-req-cert" data-cert="${escHtml(c.id)}" ${slot.requiredCertifications.includes(c.id) ? 'checked' : ''} /><span style="color:${c.color}">${escHtml(certLabel(c.id))}</span></label>`,
    )
    .join('');
  const forbidCertHtml = certDefs
    .map(
      (c) =>
        `<label class="inject-cert"><input type="checkbox" data-inj-slot="${idx}" data-inj-action="toggle-forbid-cert" data-cert="${escHtml(c.id)}" ${slot.forbiddenCertifications.includes(c.id) ? 'checked' : ''} /><span style="color:${c.color}">${escHtml(certLabel(c.id))}</span></label>`,
    )
    .join('');

  return `<div class="inject-slot-row">
    <div class="inject-slot-head">
      <strong>משבצת ${idx + 1}</strong>
      <input class="input-sm" type="text" data-inj-slot="${idx}" data-inj-action="set-label" value="${escHtml(slot.label)}" placeholder="תווית (אופציונלי)" style="width:160px" />
      ${(_draft?.slots.length ?? 0) > 1 ? `<button class="btn-xs btn-outline" data-inj-slot="${idx}" data-inj-action="remove-slot">הסר</button>` : ''}
    </div>
    <div class="inject-slot-levels">
      <span class="inject-label-hint">דרגות:</span>
      ${levelButtons}
      <span class="inject-level-legend">(לחץ שוב לעדיפות נמוכה)</span>
    </div>
    <div class="inject-slot-certs">
      <div><span class="inject-label-hint">הסמכות נדרשות:</span> ${reqCertHtml || '<span class="text-muted">אין</span>'}</div>
      <div><span class="inject-label-hint">הסמכות אסורות:</span> ${forbidCertHtml || '<span class="text-muted">אין</span>'}</div>
    </div>
  </div>`;
}

// ─── Plans phase rendering ──────────────────────────────────────────────────

function renderPlans(schedule: Schedule): string {
  const result = _searchResult!;
  const selected = result.plans.find((p) => p.id === _selectedPlanId) ?? result.plans[0];
  const pMap = new Map(schedule.participants.map((p) => [p.id, p]));

  const summary = renderPlanSummaryBanner(selected, result);
  const outcomesHtml = renderPlanOutcomes(selected, pMap);
  const alternativesHtml = result.plans.length > 1 ? renderAlternatives(result.plans, selected.id, pMap) : '';
  const triageHtml = renderTriagePanel(selected, result, schedule);

  const canApply = selected.filledCount > 0;
  const applyDisabled = !canApply ? 'disabled' : '';
  const applyLabel = selected.isPartial ? 'אשר תוכנית חלקית' : 'אשר והוסף';

  return `<div id="inject-modal-backdrop" class="inject-backdrop">
    <div class="inject-modal">
      <div class="inject-header">
        <h3>תוכניות שיבוץ</h3>
        <button class="inject-close" id="btn-inject-close" aria-label="סגור">✕</button>
      </div>
      <div class="inject-body">
        ${summary}
        ${triageHtml}
        <div class="inject-outcomes">${outcomesHtml}</div>
        ${alternativesHtml}
      </div>
      <div class="inject-footer">
        <button class="btn-primary" id="btn-inject-confirm" ${applyDisabled}>${applyLabel}</button>
        <button class="btn-outline" id="btn-inject-back">חזרה לעריכה</button>
      </div>
    </div>
  </div>`;
}

function renderPlanSummaryBanner(plan: InjectionPlan, result: InjectionResult): string {
  const deltaSign = plan.compositeDelta > 0.05 ? '+' : '';
  const deltaClass =
    plan.compositeDelta > 0.05
      ? 'inject-delta--good'
      : plan.compositeDelta < -0.05
        ? 'inject-delta--bad'
        : 'inject-delta--neutral';
  const deltaText = `${deltaSign}${plan.compositeDelta.toFixed(1)}`;
  const deltaLabel =
    plan.compositeDelta > 0.05
      ? 'שיפור בציון הכולל'
      : plan.compositeDelta < -0.05
        ? 'הרעה בציון הכולל'
        : 'שינוי זניח בציון';

  const fillPct = plan.totalSlotCount > 0 ? Math.round((plan.filledCount / plan.totalSlotCount) * 100) : 0;

  let banners = '';
  if (plan.fallbackDepthUsed) {
    banners += `<div class="inject-banner inject-banner--warn">⚠️ נדרשה שרשרת מעמיקה (עומק ${plan.fallbackDepthUsed}) — אין חלופה קצרה יותר.</div>`;
  }
  if (plan.isPartial) {
    banners += `<div class="inject-banner inject-banner--warn">⚠️ תוכנית חלקית — ${plan.totalSlotCount - plan.filledCount} משבצות נותרו ללא משתתף.</div>`;
  }
  if (plan.violations.length > 0) {
    banners += `<div class="inject-banner inject-banner--err">⛔ התוכנית מפרה ${plan.violations.length} אילוצים קשיחים. שימוש זהיר.</div>`;
  }
  if (result.timedOut) {
    banners += `<div class="inject-banner inject-banner--info">⏱ החיפוש הגיע למגבלת הזמן — ייתכנו תוכניות נוספות שלא נמצאו.</div>`;
  }

  // Group lock indicator (sameGroupRequired only).
  const groupHtml = plan.groupLock ? `<span class="inject-summary-group">${escHtml(plan.groupLock)}</span>` : '';

  return `<div class="inject-summary-banner">
    <div class="inject-summary-row">
      <span class="inject-summary-rank">תוכנית #${plan.rank}</span>
      <span class="inject-summary-fill">${plan.filledCount}/${plan.totalSlotCount} משבצות (${fillPct}%)</span>
      <span class="inject-summary-delta ${deltaClass}" title="${escHtml(deltaLabel)}">ציון: ${deltaText}</span>
      ${groupHtml}
    </div>
    ${banners}
  </div>`;
}

function renderPlanOutcomes(plan: InjectionPlan, pMap: Map<string, { name: string }>): string {
  let rows = '';
  // Render participant names as hover-spans matching the rescue/quick-swap pattern.
  // The data-pid + data-plan-id pair is what wirePlansEvents binds the tooltip to.
  const pHover = (pid: string | undefined): string => {
    if (!pid) return '';
    const name = pMap.get(pid)?.name ?? pid;
    return `<span class="rescue-participant-hover" data-pid="${escHtml(pid)}" data-plan-id="${escHtml(plan.id)}">${escHtml(name)}</span>`;
  };
  for (const o of plan.outcomes) {
    const chainHtml = o.swapChain?.length
      ? `<div class="inject-outcome-chain">↳ ${o.swapChain
          .map(
            (s) =>
              `${pHover(s.toParticipantId)} מחליף את ${pHover(s.fromParticipantId)} ב-<strong>${escHtml(stripDayPrefix(s.taskName))}</strong> (${escHtml(s.slotLabel)})`,
          )
          .join(' · ')}</div>`
      : '';
    if (o.filled) {
      rows += `<div class="inject-outcome inject-outcome--ok">
        <span class="inject-outcome-badge">✓</span>
        <span class="inject-outcome-slot">${escHtml(o.slotLabel)}</span>
        <span class="inject-outcome-arrow">←</span>
        <strong>${pHover(o.participantId)}</strong>
        ${chainHtml}
      </div>`;
    } else {
      rows += `<div class="inject-outcome inject-outcome--unfilled">
        <span class="inject-outcome-badge">⚠</span>
        <span class="inject-outcome-slot">${escHtml(o.slotLabel)}</span>
        <span class="inject-outcome-unfilled-text">לא ניתן לשיבוץ (${escHtml(o.reason ?? 'אין מועמד כשיר')})</span>
      </div>`;
    }
  }
  return rows;
}

function renderAlternatives(plans: InjectionPlan[], selectedId: string, pMap: Map<string, { name: string }>): string {
  if (plans.length <= 1) return '';
  const cards = plans
    .map((p) => {
      const isSelected = p.id === selectedId;
      const deltaSign = p.compositeDelta > 0.05 ? '+' : '';
      const deltaClass =
        p.compositeDelta > 0.05
          ? 'inject-delta--good'
          : p.compositeDelta < -0.05
            ? 'inject-delta--bad'
            : 'inject-delta--neutral';
      const totalSwaps = p.outcomes.reduce((n, o) => n + 1 + (o.swapChain?.length ?? 0), 0);
      const fillNames = p.outcomes
        .filter((o) => o.filled && o.participantId)
        .map((o) => pMap.get(o.participantId!)?.name ?? o.participantId)
        .join(', ');
      const groupHtml = p.groupLock ? `<span class="inject-alt-group">${escHtml(p.groupLock)}</span>` : '';
      const fbHtml = p.fallbackDepthUsed ? `<span class="inject-alt-fb">⚠ עומק ${p.fallbackDepthUsed}</span>` : '';
      const partialHtml = p.isPartial ? `<span class="inject-alt-partial">⚠ חלקית</span>` : '';
      return `<button type="button" class="inject-alt-card ${isSelected ? 'inject-alt-card--selected' : ''}" data-inj-action="select-plan" data-plan-id="${escHtml(p.id)}" ${isSelected ? 'aria-pressed="true"' : ''}>
        <div class="inject-alt-head">
          <span class="inject-alt-rank">#${p.rank}</span>
          <span class="inject-alt-fill">${p.filledCount}/${p.totalSlotCount}</span>
          <span class="inject-alt-delta ${deltaClass}">${deltaSign}${p.compositeDelta.toFixed(1)}</span>
          ${groupHtml}
          ${fbHtml}
          ${partialHtml}
        </div>
        <div class="inject-alt-detail">${totalSwaps} צעדי שיבוץ${fillNames ? ` · ${escHtml(fillNames)}` : ''}</div>
      </button>`;
    })
    .join('');

  return `<details class="inject-alternatives" ${plans.length > 1 ? 'open' : ''}>
    <summary>💡 ${plans.length - 1} תוכניות נוספות</summary>
    <div class="inject-alt-list">${cards}</div>
    <div class="text-muted inject-alt-hint">לחץ על תוכנית כדי לעבור אליה. "אשר והוסף" יחיל את התוכנית הנבחרת.</div>
  </details>`;
}

function renderTriagePanel(plan: InjectionPlan, result: InjectionResult, schedule: Schedule): string {
  // Show triage only when the BEST plan is partial AND there are unsolvable
  // slots (i.e. nothing across all groups + depths can fill them).
  if (!plan.isPartial || result.unsolvableSlotIds.length === 0) return '';
  const task = result.task;
  const unsolvableSlots = task.slots.filter((s) => result.unsolvableSlotIds.includes(s.slotId));
  if (unsolvableSlots.length === 0) return '';

  const slotList = unsolvableSlots
    .map((s) => {
      const lbl = s.label || `משבצת ${task.slots.findIndex((x) => x.slotId === s.slotId) + 1}`;
      return `<li>${escHtml(lbl)}</li>`;
    })
    .join('');

  void schedule;

  return `<div class="inject-triage">
    <div class="inject-triage-title">⚠ ${unsolvableSlots.length} משבצות לא ניתנות לאיוש בכלל</div>
    <div class="inject-triage-body">
      <ul class="inject-triage-list">${slotList}</ul>
      <div class="text-muted">לא קיימות שרשראות שיבוץ אפילו בעומק 5. חזור לעריכה כדי להוריד את דרישת הקבוצה האחידה או להקטין את היקף המשימה. לשינוי אילוצים קשיחים יש לעבור למסך ההגדרות.</div>
    </div>
  </div>`;
}

// ─── Event wiring ───────────────────────────────────────────────────────────

function wireEvents(): void {
  const backdrop = document.getElementById('inject-modal-backdrop');
  if (!backdrop) return;

  backdrop.querySelector('#btn-inject-close')?.addEventListener('click', closeInjectTaskModal);
  backdrop.querySelector('#btn-inject-cancel')?.addEventListener('click', closeInjectTaskModal);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeInjectTaskModal();
  });

  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  _escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeInjectTaskModal();
  };
  document.addEventListener('keydown', _escHandler);

  if (_phase === 'form') {
    wireFormEvents(backdrop);
  } else {
    wirePlansEvents(backdrop);
  }
}

function wireFormEvents(backdrop: HTMLElement): void {
  backdrop.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-inj]').forEach((el) => {
    const field = el.dataset.inj;
    if (!field) return;
    const commit = () => {
      if (!_draft) return;
      const bag = _draft as unknown as Record<string, unknown>;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        bag[field] = el.checked;
      } else if (el instanceof HTMLInputElement && el.type === 'number') {
        const num = Number(el.value);
        bag[field] = Number.isFinite(num) ? num : 0;
      } else if (field === 'dayIndex' || field === 'startHour' || field === 'startMinute') {
        bag[field] = parseInt(el.value, 10);
      } else {
        bag[field] = el.value;
      }
    };
    el.addEventListener('change', commit);
    el.addEventListener('input', commit);
    if ((el.dataset.inj === 'dayIndex' || el.dataset.inj === 'startHour') && el instanceof HTMLSelectElement) {
      el.addEventListener('change', () => render());
    }
  });

  backdrop.querySelectorAll<HTMLElement>('[data-inj-action]').forEach((el) => {
    const action = el.dataset.injAction;
    if (!action) return;
    const slotIdx = el.dataset.injSlot !== undefined ? parseInt(el.dataset.injSlot, 10) : -1;

    if (action === 'add-slot') {
      el.addEventListener('click', () => {
        if (!_draft) return;
        _draft.slots.push(makeDefaultSlot());
        render();
      });
    } else if (action === 'remove-slot') {
      el.addEventListener('click', () => {
        if (!_draft) return;
        _draft.slots.splice(slotIdx, 1);
        render();
      });
    } else if (action === 'toggle-level') {
      el.addEventListener('click', () => {
        if (!_draft) return;
        const levelStr = el.dataset.level;
        if (!levelStr) return;
        const level = parseInt(levelStr, 10) as Level;
        const slot = _draft.slots[slotIdx];
        if (!slot) return;
        const lv = slot.levels.find((x) => x.level === level);
        if (!lv) return;
        if (!lv.enabled) {
          lv.enabled = true;
          lv.lowPriority = false;
        } else if (!lv.lowPriority) {
          lv.lowPriority = true;
        } else {
          lv.enabled = false;
          lv.lowPriority = false;
        }
        render();
      });
    } else if (action === 'toggle-req-cert') {
      el.addEventListener('change', () => {
        if (!_draft) return;
        const cert = el.dataset.cert;
        if (!cert) return;
        const slot = _draft.slots[slotIdx];
        if (!slot) return;
        const on = (el as HTMLInputElement).checked;
        if (on && !slot.requiredCertifications.includes(cert)) slot.requiredCertifications.push(cert);
        else if (!on) slot.requiredCertifications = slot.requiredCertifications.filter((c) => c !== cert);
      });
    } else if (action === 'toggle-forbid-cert') {
      el.addEventListener('change', () => {
        if (!_draft) return;
        const cert = el.dataset.cert;
        if (!cert) return;
        const slot = _draft.slots[slotIdx];
        if (!slot) return;
        const on = (el as HTMLInputElement).checked;
        if (on && !slot.forbiddenCertifications.includes(cert)) slot.forbiddenCertifications.push(cert);
        else if (!on) slot.forbiddenCertifications = slot.forbiddenCertifications.filter((c) => c !== cert);
      });
    } else if (action === 'set-label') {
      el.addEventListener('input', () => {
        if (!_draft) return;
        const slot = _draft.slots[slotIdx];
        if (!slot) return;
        slot.label = (el as HTMLInputElement).value;
      });
    }
  });

  backdrop.querySelector('#btn-inject-run')?.addEventListener('click', () => {
    void runStaffing();
  });
}

function wirePlansEvents(backdrop: HTMLElement): void {
  backdrop.querySelector('#btn-inject-back')?.addEventListener('click', () => {
    // Tear down the search (removes task + placeholders) and return to the form.
    _searchResult?.cancel();
    _ctx?.getEngine()?.revalidateFull();
    _searchResult = null;
    _selectedPlanId = null;
    _phase = 'form';
    render();
  });

  backdrop.querySelectorAll<HTMLElement>('[data-inj-action="select-plan"]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.planId;
      if (!id) return;
      _selectedPlanId = id;
      render();
    });
  });

  backdrop.querySelector('#btn-inject-confirm')?.addEventListener('click', () => {
    confirmAndApply();
  });

  wireParticipantHover(backdrop);
}

// ─── Participant hover/tap (shared with rescue's CSS classes) ───────────────

/**
 * Compute the tasks the participant would hold if the given plan were applied,
 * tagging the injected task as the reference. Returns the 2 nearest tasks
 * before + the reference + 2 after, sorted chronologically.
 *
 * Mirrors `computePostSwapTasks` from rescue-modal.ts but uses the injected
 * task's id as the reference. The plan's swaps already include the
 * placeholder→fill swap, so applying the swap deltas to the participant's
 * current assignment list correctly reflects the injected slot too.
 */
function computePostInjectTasks(
  participantId: string,
  plan: InjectionPlan,
  schedule: Schedule,
  injectedTaskId: string,
): Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);

  const myAssignmentTaskIds = new Map<string, string>();
  for (const a of schedule.assignments) {
    if (a.participantId === participantId) myAssignmentTaskIds.set(a.id, a.taskId);
  }

  // Apply the plan's per-slot fill + donor swaps to the participant's view.
  // The fill is reflected as the participant gaining the injected task; donor
  // swaps move the participant in/out of existing assignments.
  for (const o of plan.outcomes) {
    if (!o.filled || !o.participantId) continue;
    // The "fill" swap is reflected as participant gaining the injected task slot.
    if (o.participantId === participantId) {
      // Synthesise the placeholder assignment id key — we don't have direct
      // access; use the slotId as a stable proxy since the post-state cares
      // only about which tasks the participant holds.
      myAssignmentTaskIds.set(`__fill__-${o.slotId}`, injectedTaskId);
    }
    if (o.swapChain) {
      for (const sw of o.swapChain) {
        if (sw.fromParticipantId === participantId) myAssignmentTaskIds.delete(sw.assignmentId);
        if (sw.toParticipantId === participantId) myAssignmentTaskIds.set(sw.assignmentId, sw.taskId);
      }
    }
  }

  const tasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }> = [];
  for (const [, taskId] of myAssignmentTaskIds) {
    const task = taskMap.get(taskId);
    if (!task) continue;
    tasks.push({
      taskName: task.name,
      start: task.timeBlock.start,
      end: task.timeBlock.end,
      isReference: taskId === injectedTaskId,
    });
  }
  tasks.sort((a, b) => a.start.getTime() - b.start.getTime());

  let refIdx = tasks.findIndex((t) => t.isReference);
  if (refIdx === -1) refIdx = 0;
  const startIdx = Math.max(0, refIdx - 2);
  const endIdx = Math.min(tasks.length, refIdx + 3);
  return tasks.slice(startIdx, endIdx);
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildInjectParticipantTooltip(
  participantName: string,
  nextTasks: Array<{ taskName: string; start: Date; end: Date; isReference: boolean }>,
  periodStart: Date,
  dayStartHour: number,
): string {
  let html = `<div class="rescue-hover-tt-header">${escHtml(participantName)} — משימות סביב ההזרקה אם תוחל</div>`;
  if (nextTasks.length === 0) {
    html += `<div class="rescue-hover-tt-empty">אין משימות קרובות</div>`;
    return html;
  }
  const baseMidnight = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate()).getTime();
  for (let i = 0; i < nextTasks.length; i++) {
    const t = nextTasks[i];
    const shifted = new Date(t.start.getTime());
    if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
    const shiftedMidnight = new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()).getTime();
    const dIdx = Math.floor((shiftedMidnight - baseMidnight) / (24 * 3600 * 1000)) + 1;
    const dayStr = `יום ${dIdx}`;
    const timeStr = `<span dir="ltr">${fmtTime(t.start)} – ${fmtTime(t.end)}</span>`;
    const refClass = t.isReference ? ' rescue-hover-tt-task--ref' : '';
    const refMarker = t.isReference ? ' ◄' : '';
    html += `<div class="rescue-hover-tt-task${refClass}">${i + 1}. ${escHtml(stripDayPrefix(t.taskName))}${refMarker}<span class="rescue-hover-tt-time">${dayStr} ${timeStr}</span></div>`;
  }
  return html;
}

let _injectTooltipEl: HTMLElement | null = null;
let _injectTooltipHideTimer: ReturnType<typeof setTimeout> | null = null;

function getInjectTooltipEl(): HTMLElement {
  if (_injectTooltipEl && document.body.contains(_injectTooltipEl)) return _injectTooltipEl;
  const el = document.createElement('div');
  el.className = 'rescue-hover-tt';
  el.style.display = 'none';
  document.body.appendChild(el);
  el.addEventListener('mouseenter', () => {
    if (_injectTooltipHideTimer) {
      clearTimeout(_injectTooltipHideTimer);
      _injectTooltipHideTimer = null;
    }
  });
  el.addEventListener('mouseleave', () => {
    el.style.display = 'none';
  });
  _injectTooltipEl = el;
  return el;
}

function hideInjectTooltip(): void {
  if (_injectTooltipEl) _injectTooltipEl.style.display = 'none';
}

function wireParticipantHover(backdrop: HTMLElement): void {
  const schedule = _ctx?.getSchedule();
  if (!schedule || !_searchResult) return;
  const result = _searchResult;
  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  if (isTouchDevice) {
    // Touch: tap toggles inline preview under the tapped name.
    let _expandedKey: string | null = null;
    backdrop.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
      if (!target) return;
      const pid = target.dataset.pid;
      const planId = target.dataset.planId;
      if (!pid || !planId) return;

      const existing = backdrop.querySelector('.rescue-inline-preview');
      if (existing) existing.remove();
      const key = `${planId}|${pid}`;
      if (_expandedKey === key) {
        _expandedKey = null;
        return;
      }
      const plan = result.plans.find((p) => p.id === planId);
      const participant = pMap.get(pid);
      if (!plan || !participant) return;
      _expandedKey = key;
      const nextTasks = computePostInjectTasks(pid, plan, schedule, result.task.id);
      const detail = document.createElement('div');
      detail.className = 'rescue-inline-preview task-inline-detail';
      detail.innerHTML = buildInjectParticipantTooltip(
        participant.name,
        nextTasks,
        schedule.periodStart,
        schedule.algorithmSettings.dayStartHour,
      );
      target.insertAdjacentElement('afterend', detail);
    });
    return;
  }

  // Desktop: hover shows fixed tooltip (same CSS as rescue).
  backdrop.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
    if (!target) return;
    const pid = target.dataset.pid;
    const planId = target.dataset.planId;
    if (!pid || !planId) return;
    const plan = result.plans.find((p) => p.id === planId);
    const participant = pMap.get(pid);
    if (!plan || !participant) return;

    if (_injectTooltipHideTimer) {
      clearTimeout(_injectTooltipHideTimer);
      _injectTooltipHideTimer = null;
    }
    const nextTasks = computePostInjectTasks(pid, plan, schedule, result.task.id);
    const tooltip = getInjectTooltipEl();
    tooltip.innerHTML = buildInjectParticipantTooltip(
      participant.name,
      nextTasks,
      schedule.periodStart,
      schedule.algorithmSettings.dayStartHour,
    );
    tooltip.style.display = 'block';

    const rect = target.getBoundingClientRect();
    let left = rect.right + 8;
    let top = rect.top - 4;
    const ttWidth = 260;
    const ttHeight = tooltip.offsetHeight || 140;
    if (left + ttWidth > window.innerWidth) left = rect.left - ttWidth - 8;
    if (top + ttHeight > window.innerHeight) top = window.innerHeight - ttHeight - 8;
    if (top < 4) top = 4;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });

  backdrop.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('.rescue-participant-hover') as HTMLElement | null;
    if (!target) return;
    _injectTooltipHideTimer = setTimeout(hideInjectTooltip, 120);
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

const INJECT_LOADER_ID = 'inject-loading-overlay';

/**
 * Show a loading overlay over the inject form while the (synchronous) plan
 * search runs. Uses inline `z-index: 10000` to layer above the inject
 * backdrop (`z-index: 9999`). Yields a double-RAF so the overlay actually
 * paints before the main thread blocks on plan computation.
 */
async function openInjectLoadingOverlay(): Promise<void> {
  closeInjectLoadingOverlay();
  const overlay = document.createElement('div');
  overlay.id = INJECT_LOADER_ID;
  overlay.className = 'optim-overlay';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="optim-card">
      <div class="cube-loader-wrapper optim-cube">
        <div class="cube-loader">
          <div class="cube-cell" style="--cell-color:#4A90D9"></div>
          <div class="cube-cell" style="--cell-color:#E74C3C"></div>
          <div class="cube-cell" style="--cell-color:#F39C12"></div>
          <div class="cube-cell" style="--cell-color:#27AE60"></div>
          <div class="cube-cell" style="--cell-color:#8E44AD"></div>
          <div class="cube-cell" style="--cell-color:#1ABC9C"></div>
          <div class="cube-cell" style="--cell-color:#3498db"></div>
          <div class="cube-cell" style="--cell-color:#e67e22"></div>
          <div class="cube-cell" style="--cell-color:#2ecc71"></div>
        </div>
      </div>
      <h3>מחפש תוכניות שיבוץ…</h3>
    </div>`;
  document.body.appendChild(overlay);
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function closeInjectLoadingOverlay(): void {
  document.getElementById(INJECT_LOADER_ID)?.remove();
}

async function runStaffing(): Promise<void> {
  const engine = _ctx?.getEngine();
  const schedule = _ctx?.getSchedule();
  if (!engine || !schedule || !_draft) return;

  const anchor = getAnchor();
  const err = validateDraft(_draft, schedule, anchor);
  if (err) {
    showInlineError(err);
    return;
  }

  const spec = draftToSpec(_draft);
  await openInjectLoadingOverlay();
  let searchOutput: ReturnType<typeof searchInjectionPlans>;
  try {
    searchOutput = searchInjectionPlans(engine, spec, {
      allowLowPriority: true,
      anchor: anchor ?? undefined,
    });
  } finally {
    closeInjectLoadingOverlay();
  }
  const { result, error } = searchOutput;
  if (!result) {
    if (error === 'past-time') {
      showInlineError('הזמן שנבחר כבר בעבר — בחר יום/שעה אחרים.');
      render();
      return;
    }
    showInlineError(error === 'invalid-spec' ? 'פרטי המשימה לא תקינים' : 'שגיאה לא צפויה');
    return;
  }

  _searchResult = result;
  _selectedPlanId = result.plans[0]?.id ?? null;
  _lastSpec = spec;
  _phase = 'plans';
  render();
}

function confirmAndApply(): void {
  const result = _searchResult;
  if (!result || !_selectedPlanId || !_draft || !_lastSpec || !_ctx) return;
  const report = result.apply(_selectedPlanId);
  if (!report) {
    showInlineError('שגיאה בהחלת התוכנית. נסה שוב.');
    return;
  }
  const schedule = _ctx.getSchedule();
  if (!schedule) return;
  _committed = true;
  _ctx.onCommit(schedule, report, _draft.saveToStore, _lastSpec);
  // Detach modal without rolling back (committed already).
  document.getElementById('inject-modal-backdrop')?.remove();
  _draft = null;
  _phase = 'form';
  _searchResult = null;
  _selectedPlanId = null;
  _lastSpec = null;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

function validateDraft(d: DraftState, schedule: Schedule, anchor: Date | null): string | null {
  if (!d.name.trim()) return 'שם המשימה חסר';
  if (d.name.trim().length > 40) return 'שם המשימה ארוך מדי (מקסימום 40 תווים)';
  const nameNorm = d.name.trim().toLowerCase();
  const taken = new Set<string>();
  for (const t of schedule.tasks) {
    const src = (t.sourceName ?? stripDayPrefix(t.name)).trim().toLowerCase();
    if (src) taken.add(src);
  }
  for (const tpl of store.getAllTaskTemplates()) taken.add(tpl.name.trim().toLowerCase());
  for (const ot of store.getAllOneTimeTasks()) taken.add(ot.name.trim().toLowerCase());
  if (taken.has(nameNorm)) return `כבר קיימת משימה בשם "${d.name.trim()}". בחר שם אחר.`;
  if (d.startHour < 0 || d.startHour > 23) return 'שעת התחלה לא תקינה';
  if (d.startMinute < 0 || d.startMinute > 59) return 'דקה לא תקינה';
  if (d.durationHours <= 0) return 'משך המשימה חייב להיות חיובי';
  if (!Number.isFinite(d.baseLoadWeight) || d.baseLoadWeight < 0 || d.baseLoadWeight > 1)
    return 'רמת עומס חייבת להיות בטווח 0–1';
  if (d.slots.length === 0) return 'נדרשת לפחות משבצת אחת';
  for (let i = 0; i < d.slots.length; i++) {
    const s = d.slots[i];
    if (!s.levels.some((l) => l.enabled)) return `במשבצת ${i + 1} לא נבחרה אף דרגה`;
    const overlap = s.requiredCertifications.filter((c) => s.forbiddenCertifications.includes(c));
    if (overlap.length > 0) {
      const labels = overlap.map((c) => schedule.certLabelSnapshot[c] ?? c).join(', ');
      return `במשבצת ${i + 1}: הסמכה לא יכולה להיות גם נדרשת וגם אסורה: ${labels}`;
    }
  }
  if (anchor !== null) {
    const dsh = schedule.algorithmSettings.dayStartHour;
    if (!isDayModifiable(d.dayIndex, schedule.periodStart, anchor, dsh)) {
      return 'לא ניתן להוסיף משימה ליום שעבר.';
    }
    const dshNorm = ((Math.trunc(dsh) % 24) + 24) % 24;
    const calOffset = d.dayIndex - 1 + (d.startHour < dshNorm ? 1 : 0);
    const start = new Date(
      schedule.periodStart.getFullYear(),
      schedule.periodStart.getMonth(),
      schedule.periodStart.getDate() + calOffset,
      d.startHour,
      d.startMinute,
    );
    if (start.getTime() < anchor.getTime()) {
      return 'שעת ההתחלה שנבחרה כבר בעבר — בחר שעה עתידית.';
    }
  }
  return null;
}

function draftToSpec(d: DraftState): InjectedTaskSpec {
  const subTeams: SubTeamTemplate[] = [];
  const flatSlots: SlotTemplate[] = d.slots.map((s) => ({
    id: s.id,
    label: s.label,
    acceptableLevels: s.levels
      .filter((l) => l.enabled)
      .map((l) => ({ level: l.level, lowPriority: l.lowPriority || undefined })),
    requiredCertifications: [...s.requiredCertifications],
    forbiddenCertifications: s.forbiddenCertifications.length ? [...s.forbiddenCertifications] : undefined,
  }));

  return {
    name: d.name.trim(),
    dayIndex: d.dayIndex,
    startHour: d.startHour,
    startMinute: d.startMinute,
    durationHours: d.durationHours,
    subTeams,
    slots: flatSlots,
    sameGroupRequired: d.sameGroupRequired,
    blocksConsecutive: d.blocksConsecutive,
    baseLoadWeight: Math.max(0, Math.min(1, d.baseLoadWeight)),
    restRuleId: d.restRuleId || undefined,
    description: d.description || undefined,
  };
}

function showInlineError(msg: string): void {
  const footer = document.querySelector('#inject-modal-backdrop .inject-footer');
  if (!footer) return;
  let err = footer.querySelector('.inject-error');
  if (!err) {
    err = document.createElement('span');
    err.className = 'inject-error';
    footer.insertBefore(err, footer.firstChild);
  }
  err.textContent = msg;
}
