/**
 * Inject Emergency Task Modal — UI for adding a BALTAM task to an existing
 * schedule snapshot and auto-staffing it from the current participant pool.
 *
 * Flow:
 *   1. User fills a form (name, day/time/duration, slot levels + certs, flags).
 *   2. User clicks "הוסף ושבץ" → we call `injectAndStaff()`.
 *   3. A preview shows per-slot staffing outcomes.
 *   4. User clicks "אשר" → revalidate + persist; optionally also save as an
 *      OT in the live store (so it survives regeneration).
 *      User clicks "בטל" → rollback via the report helper.
 */

import { type InjectedTaskSpec, injectAndStaff, type StaffingReport } from '../engine/inject';
import { getInjectStartFloor, isDayModifiable } from '../engine/temporal';
import { Level, type Schedule, type SchedulingEngine, type SlotTemplate, type SubTeamTemplate } from '../index';
import * as store from './config-store';
import { escHtml } from './ui-helpers';

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

/** Draft form state while the user is composing. */
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
let _phase: 'form' | 'preview' = 'form';
let _lastReport: StaffingReport | null = null;
let _lastSpec: InjectedTaskSpec | null = null;
let _escHandler: ((e: KeyboardEvent) => void) | null = null;

// ─── Public API ─────────────────────────────────────────────────────────────

export function openInjectTaskModal(): void {
  const schedule = _ctx?.getSchedule();
  if (!schedule) return;
  _draft = makeDefaultDraft(schedule, getAnchor());
  _phase = 'form';
  _lastReport = null;
  _lastSpec = null;
  render();
}

/** Live Mode anchor or null when Live Mode is off. */
function getAnchor(): Date | null {
  const lm = store.getLiveModeState();
  return lm.enabled ? lm.currentTimestamp : null;
}

export function closeInjectTaskModal(): void {
  // If a report exists but was not committed, roll back before closing.
  if (_phase === 'preview' && _lastReport) {
    _lastReport.rollback();
    const engine = _ctx?.getEngine();
    engine?.revalidateFull();
  }
  document.getElementById('inject-modal-backdrop')?.remove();
  _draft = null;
  _phase = 'form';
  _lastReport = null;
  _lastSpec = null;
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

// ─── Draft defaults ─────────────────────────────────────────────────────────

function makeDefaultDraft(schedule: Schedule, anchor: Date | null): DraftState {
  // Pick the first day whose calendar day still has at least one future hour.
  // In non-Live-Mode this is always day 1; in Live Mode it skips past days.
  let dayIndex = 1;
  if (anchor) {
    for (let d = 1; d <= schedule.periodDays; d++) {
      if (isDayModifiable(d, schedule.periodStart, anchor)) {
        dayIndex = d;
        break;
      }
    }
  }

  let startHour = 6;
  let startMinute = 0;
  if (anchor) {
    const floor = getInjectStartFloor(dayIndex, schedule.periodStart, anchor);
    if (floor) {
      // Round (hourMin, minuteMin) up to the next half-hour for a tidy default.
      const totalMin = floor.hourMin * 60 + floor.minuteMin;
      const rounded = Math.ceil(totalMin / 30) * 30;
      startHour = Math.min(23, Math.floor(rounded / 60));
      startMinute = rounded >= 24 * 60 ? 30 : rounded % 60;
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
      { level: Level.L0, enabled: false, lowPriority: false },
      { level: Level.L2, enabled: false, lowPriority: false },
      { level: Level.L3, enabled: false, lowPriority: false },
      { level: Level.L4, enabled: false, lowPriority: false },
    ],
    requiredCertifications: [],
    forbiddenCertifications: [],
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render(): void {
  // Preserve body scroll so in-form re-renders (toggling a level, adding a
  // slot) don't bounce the user back to the top.
  const prev = document.getElementById('inject-modal-backdrop');
  const prevScroll = prev?.querySelector<HTMLElement>('.inject-body')?.scrollTop ?? 0;
  prev?.remove();

  const schedule = _ctx?.getSchedule();
  if (!schedule || !_draft) return;

  const html = _phase === 'form' ? renderForm(schedule) : renderPreview(schedule);
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

  // Live Mode clamps: the engine composes task start as
  // `calendarMidnight(dayIndex) + startHour*h + startMinute*m`, so hour/minute
  // must be gated against calendar midnight (not the operational-day start).
  const floor = anchor ? getInjectStartFloor(d.dayIndex, schedule.periodStart, anchor) : null;
  const dayIsInjectable = anchor ? isDayModifiable(d.dayIndex, schedule.periodStart, anchor) : true;
  let hourMin = 0;
  const hourMax = 23;
  let minuteMin = 0;
  if (anchor && floor && (floor.hourMin > 0 || floor.minuteMin > 0)) {
    hourMin = floor.hourMin;
    if (d.startHour === hourMin) minuteMin = floor.minuteMin;
    if (d.startHour < hourMin) {
      d.startHour = hourMin;
      d.startMinute = floor.minuteMin;
    } else if (d.startHour === hourMin && d.startMinute < floor.minuteMin) {
      d.startMinute = floor.minuteMin;
    }
  }

  const dayOptions = Array.from({ length: schedule.periodDays }, (_, i) => {
    const idx = i + 1;
    const selected = idx === d.dayIndex ? ' selected' : '';
    if (anchor === null) {
      return `<option value="${idx}"${selected}>יום ${idx}</option>`;
    }
    if (!isDayModifiable(idx, schedule.periodStart, anchor)) {
      return `<option value="${idx}" disabled title="יום בעבר — לא ניתן להוסיף משימת חירום">יום ${idx} 🧊</option>`;
    }
    // ⏳ when the anchor is on this calendar day — hour will need clamping.
    const calMidnight = new Date(
      schedule.periodStart.getFullYear(),
      schedule.periodStart.getMonth(),
      schedule.periodStart.getDate() + idx - 1,
    );
    if (anchor.getTime() > calMidnight.getTime()) {
      return `<option value="${idx}"${selected} title="יום נוכחי — שעת ההתחלה תוגבל להווה">יום ${idx} ⏳</option>`;
    }
    return `<option value="${idx}"${selected}>יום ${idx}</option>`;
  }).join('');

  const pastTimeBanner =
    anchor !== null && !dayIsInjectable
      ? `<div class="inject-past-banner" role="alert">היום שנבחר בעבר — בחר יום עתידי.</div>`
      : '';

  // Frozen map stores milliseconds; live store owns the human label. Prefer
  // the live label when it still exists, fall back to the id otherwise.
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
        <h3>🚨 הוספת משימת חירום (BALTAM)</h3>
        <button class="inject-close" id="btn-inject-close" aria-label="סגור">✕</button>
      </div>
      <div class="inject-body">
        <p class="inject-intro">המשימה תתווסף לתמונת המצב הנוכחית והמערכת תנסה לשבץ אליה משתתפים מהצוות הקיים. לאחר "צור שבצ״ק" חדש היא תימחק — אלא אם סימנת את התיבה להוסיף גם למסך המשימות.</p>
        ${pastTimeBanner}
        <section class="inject-section">
          <h4>פרטי משימה</h4>
          <div class="form-row">
            <label>שם: <input class="input-sm" type="text" data-inj="name" value="${escHtml(d.name)}" placeholder="BALTAM" /></label>
            <label>יום: <select class="input-sm" data-inj="dayIndex">${dayOptions}</select></label>
            <label>שעת התחלה: <input class="input-sm" type="number" min="${hourMin}" max="${hourMax}" data-inj="startHour" value="${d.startHour}" /></label>
            <label>דקה: <input class="input-sm" type="number" min="${minuteMin}" max="59" data-inj="startMinute" value="${d.startMinute}" style="width:60px" /></label>
            <label>משך (שעות): <input class="input-sm" type="number" step="0.5" min="0.5" data-inj="durationHours" value="${d.durationHours}" /></label>
          </div>
          <div class="form-row">
            <label class="checkbox-label"><input type="checkbox" data-inj="sameGroupRequired" ${d.sameGroupRequired ? 'checked' : ''} /> נדרשת אותה קבוצה</label>
            <label class="checkbox-label"><input type="checkbox" data-inj="blocksConsecutive" ${d.blocksConsecutive ? 'checked' : ''} /> חוסמת רצף</label>
            <label>כלל מרווח: <select class="input-sm" data-inj="restRuleId">${restRuleOptions}</select></label>
            <label>רמת עומס (0–1): <input class="input-sm" type="number" step="0.05" min="0" max="1" data-inj="baseLoadWeight" value="${d.baseLoadWeight.toFixed(2)}" /></label>
          </div>
          <div class="form-row">
            <label>תיאור: <input class="input-sm" type="text" data-inj="description" value="${escHtml(d.description)}" placeholder="אופציונלי" style="width:300px" /></label>
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
  // Use the schedule's cert label snapshot so we show labels frozen at generation.
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

function renderPreview(schedule: Schedule): string {
  const report = _lastReport!;
  const pMap = new Map(schedule.participants.map((p) => [p.id, p]));
  const ok = report.fullyStaffed;

  let rows = '';
  for (const o of report.outcomes) {
    const pName = o.participantId ? (pMap.get(o.participantId)?.name ?? o.participantId) : '';
    const chainHtml = o.swapChain?.length
      ? `<div class="inject-outcome-chain">↳ ${o.swapChain
          .map((s) => {
            const fromP = pMap.get(s.fromParticipantId)?.name ?? s.fromParticipantId;
            const toP = pMap.get(s.toParticipantId)?.name ?? s.toParticipantId;
            return `${escHtml(toP)} מחליף את ${escHtml(fromP)} ב-<strong>${escHtml(stripDayPrefix(s.taskName))}</strong> (${escHtml(s.slotLabel)})`;
          })
          .join(' · ')}</div>`
      : '';
    if (o.filled) {
      rows += `<div class="inject-outcome inject-outcome--ok">
        <span class="inject-outcome-badge">✓</span>
        <span class="inject-outcome-slot">${escHtml(o.slotLabel)}</span>
        <span class="inject-outcome-arrow">←</span>
        <strong>${escHtml(pName)}</strong>
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

  const summaryClass = ok ? 'inject-summary--ok' : 'inject-summary--warn';
  const summary = ok
    ? `כל ${report.outcomes.length} המשבצות אוישו בהצלחה.`
    : `${report.outcomes.filter((o) => o.filled).length} מתוך ${report.outcomes.length} משבצות אוישו. המשימה תתווסף עם משבצות ריקות — ניתן לסגור אותן ידנית בהמשך.`;

  return `<div id="inject-modal-backdrop" class="inject-backdrop">
    <div class="inject-modal">
      <div class="inject-header">
        <h3>תצוגת שיבוץ</h3>
        <button class="inject-close" id="btn-inject-close" aria-label="סגור">✕</button>
      </div>
      <div class="inject-body">
        <div class="inject-summary ${summaryClass}">${summary}</div>
        <div class="inject-outcomes">${rows}</div>
      </div>
      <div class="inject-footer">
        <button class="btn-primary" id="btn-inject-confirm">אשר והוסף</button>
        <button class="btn-outline" id="btn-inject-back">חזרה לעריכה</button>
      </div>
    </div>
  </div>`;
}

function stripDayPrefix(name: string): string {
  return name.replace(/^יום\s+\d+\s+/, '').replace(/^D\d+\s+/, '');
}

// ─── Event wiring ───────────────────────────────────────────────────────────

function wireEvents(): void {
  const backdrop = document.getElementById('inject-modal-backdrop');
  if (!backdrop) return;

  backdrop.querySelector('#btn-inject-close')?.addEventListener('click', closeInjectTaskModal);
  backdrop.querySelector('#btn-inject-cancel')?.addEventListener('click', closeInjectTaskModal);

  // Click backdrop → close (only when clicking the backdrop itself).
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeInjectTaskModal();
  });

  // Escape key.
  if (_escHandler) document.removeEventListener('keydown', _escHandler);
  _escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeInjectTaskModal();
  };
  document.addEventListener('keydown', _escHandler);

  if (_phase === 'form') {
    wireFormEvents(backdrop);
  } else {
    wirePreviewEvents(backdrop);
  }
}

function wireFormEvents(backdrop: HTMLElement): void {
  // Text/number/select top-level fields.
  backdrop.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-inj]').forEach((el) => {
    const field = el.dataset.inj;
    if (!field) return;
    const commit = () => {
      if (!_draft) return;
      // DraftState is a closed shape; using a typed bag here is intentional —
      // the data-inj attribute is authored by this module and every value is
      // known to match its target field's type.
      const bag = _draft as unknown as Record<string, unknown>;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        bag[field] = el.checked;
      } else if (el instanceof HTMLInputElement && el.type === 'number') {
        const num = Number(el.value);
        bag[field] = Number.isFinite(num) ? num : 0;
      } else if (field === 'dayIndex') {
        bag[field] = parseInt(el.value, 10);
      } else {
        bag[field] = el.value;
      }
    };
    el.addEventListener('change', commit);
    el.addEventListener('input', commit);
    // Day change may change the hour/minute floor — re-render so `min`
    // attributes and coerced values refresh.
    if (el.dataset.inj === 'dayIndex' && el instanceof HTMLSelectElement) {
      el.addEventListener('change', () => render());
    }
  });

  // Slot actions.
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
        // Cycle: off → on → low → off
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

  // Run the staffing.
  backdrop.querySelector('#btn-inject-run')?.addEventListener('click', () => {
    runStaffing();
  });
}

function wirePreviewEvents(backdrop: HTMLElement): void {
  backdrop.querySelector('#btn-inject-back')?.addEventListener('click', () => {
    // Roll back mutations made by the current preview so the user can edit.
    _lastReport?.rollback();
    _ctx?.getEngine()?.revalidateFull();
    _lastReport = null;
    _phase = 'form';
    render();
  });

  backdrop.querySelector('#btn-inject-confirm')?.addEventListener('click', () => {
    const schedule = _ctx?.getSchedule();
    if (!schedule || !_lastReport || !_lastSpec || !_draft || !_ctx) return;
    // Callbacks handle revalidateFull, persistence, store write, and re-render.
    _ctx.onCommit(schedule, _lastReport, _draft.saveToStore, _lastSpec);
    // The modal is closed by the caller after onCommit; but to be safe, also
    // detach the backdrop here without triggering rollback.
    document.getElementById('inject-modal-backdrop')?.remove();
    _draft = null;
    _phase = 'form';
    _lastReport = null;
    _lastSpec = null;
    if (_escHandler) {
      document.removeEventListener('keydown', _escHandler);
      _escHandler = null;
    }
  });
}

// ─── Run staffing ───────────────────────────────────────────────────────────

function runStaffing(): void {
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
  const { report, error } = injectAndStaff(engine, spec, {
    allowLowPriority: true,
    anchor: anchor ?? undefined,
  });
  if (!report) {
    if (error === 'past-time') {
      // Anchor raced ahead of the selected start while the modal was open.
      // Refresh the form so day/hour options reflect the new anchor.
      showInlineError('הזמן שנבחר כבר בעבר — בחר יום/שעה אחרים.');
      render();
      return;
    }
    showInlineError(error === 'invalid-spec' ? 'פרטי המשימה לא תקינים' : 'שגיאה לא צפויה');
    return;
  }

  _lastReport = report;
  _lastSpec = spec;
  _phase = 'preview';
  render();
}

function validateDraft(d: DraftState, schedule: Schedule, anchor: Date | null): string | null {
  if (!d.name.trim()) return 'שם המשימה חסר';
  if (d.startHour < 0 || d.startHour > 23) return 'שעת התחלה לא תקינה';
  if (d.startMinute < 0 || d.startMinute > 59) return 'דקה לא תקינה';
  if (d.durationHours <= 0) return 'משך המשימה חייב להיות חיובי';
  if (!Number.isFinite(d.baseLoadWeight) || d.baseLoadWeight < 0 || d.baseLoadWeight > 1)
    return 'רמת עומס חייבת להיות בטווח 0–1';
  if (d.slots.length === 0) return 'נדרשת לפחות משבצת אחת';
  for (let i = 0; i < d.slots.length; i++) {
    const s = d.slots[i];
    if (!s.levels.some((l) => l.enabled)) return `במשבצת ${i + 1} לא נבחרה אף דרגה`;
  }
  if (anchor !== null) {
    if (!isDayModifiable(d.dayIndex, schedule.periodStart, anchor)) {
      return 'לא ניתן להוסיף משימה ליום שעבר.';
    }
    const start = new Date(
      schedule.periodStart.getFullYear(),
      schedule.periodStart.getMonth(),
      schedule.periodStart.getDate() + (d.dayIndex - 1),
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
    displayCategory: d.name.trim().toLowerCase(),
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
